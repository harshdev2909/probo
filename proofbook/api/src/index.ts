/**
 * ProofBook read API — stateless, Postgres-backed, horizontally scalable.
 *
 * It NEVER reads the chain on a request path and it NEVER writes. The keeper is
 * the only writer; this process could be killed and restarted mid-request and
 * nothing would be lost. The one exception is the faucet, which signs with a
 * low-privilege wallet that can only move a valueless devnet token (see faucet.ts).
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import etag from "@fastify/etag";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

import { prisma } from "../../db/src/client";
import { API_VERSION, MarketQuery, ReceiptQuery } from "./contracts";
import * as q from "./queries";
import { EventStream } from "./stream";
import { Faucet } from "./faucet";

/**
 * A stateless read server must not die because a pooled connection blinked.
 *
 * Node kills the process on any unhandled rejection, and Neon's pooler drops
 * idle connections routinely — the pool emits the error outside any request
 * handler, nothing catches it, and the API is dead until someone notices. Every
 * request here is independent and Prisma reconnects lazily, so the correct
 * response is to log it and serve the next request.
 */
process.on("unhandledRejection", (e: any) => {
  console.error("[api] unhandled rejection (continuing):", String(e?.message ?? e).slice(0, 200));
});
process.on("uncaughtException", (e: any) => {
  console.error("[api] uncaught exception (continuing):", String(e?.message ?? e).slice(0, 200));
});

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL!;
/**
 * CORS, done so that it actually works.
 *
 * Three things bit us:
 *   1. A trailing slash. `CORS_ORIGINS=https://x.vercel.app/` never matches,
 *      because a browser sends `Origin: https://x.vercel.app` with NO slash. The
 *      config looks right and the request is still blocked.
 *   2. Vercel mints a NEW url for every deployment
 *      (`probo-<hash>-<team>.vercel.app`), so pinning one exact origin breaks on
 *      the next deploy. Wildcards (`https://*.vercel.app`) fix that.
 *   3. The SSE route echoed ORIGINS[0] instead of the origin that actually asked,
 *      so with more than one allowed origin the live feed silently failed.
 */
const ORIGIN_PATTERNS = (process.env.CORS_ORIGINS ?? "*")
  .split(",")
  .map((s) => normaliseOrigin(s))
  .filter(Boolean);

/** Lowercase, trimmed, no trailing slash — the form a browser actually sends. */
function normaliseOrigin(o: string): string {
  return o.trim().toLowerCase().replace(/\/+$/, "");
}

/** Supports exact origins and `*` wildcards, e.g. `https://*.vercel.app`. */
function originAllowed(origin: string): boolean {
  const o = normaliseOrigin(origin);
  return ORIGIN_PATTERNS.some((p) => {
    if (p === "*") return true;
    if (!p.includes("*")) return p === o;
    const rx = new RegExp(
      "^" + p.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^.]*") + "$"
    );
    return rx.test(o);
  });
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: { colorize: true, singleLine: true },
          },
  },
  trustProxy: true, // behind Railway/Fly/Render — rate limiting must see the real IP
  disableRequestLogging: false,
});

const stream = new EventStream(DATABASE_URL, app.log);
const faucet = new Faucet(
  process.env.RPC_URL ?? "https://api.devnet.solana.com",
  process.env.FAUCET_SECRET_KEY,
  process.env.USDC_MINT
);

async function main() {
  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header at all: curl, server-to-server, health checks. Not a
      // browser, so there is nothing to protect against here.
      if (!origin) return cb(null, true);
      if (originAllowed(origin)) return cb(null, true);
      // Say WHY, with the exact string, so a trailing slash is obvious in the logs
      // instead of being an invisible mismatch.
      app.log.warn(
        { origin, allowed: ORIGIN_PATTERNS },
        "CORS: origin rejected — it does not match CORS_ORIGINS"
      );
      return cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  });
  await app.register(compress, { global: true, threshold: 1024 });
  await app.register(etag); // conditional GETs — the market board is polled a lot
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: "1 minute",
    // SSE is one long-lived connection; counting it would evict live viewers.
    allowList: (req) => req.url.startsWith("/stream"),
  });

  // ── health ────────────────────────────────────────────────────────────────
  app.get("/health", async (_req, reply) => {
    let db = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = false;
    }
    const [keeper, counts] = await Promise.all([
      q.getKeeperStatus(),
      q.getCounts(),
    ]);
    const ok = db; // the API is healthy even if the keeper is down — say so separately
    reply.code(ok ? 200 : 503);
    return {
      ok,
      version: API_VERSION,
      db,
      keeper: { alive: keeper.alive, heartbeatAgeSec: keeper.heartbeatAgeSec },
      counts,
    };
  });

  // ── markets ───────────────────────────────────────────────────────────────
  app.get("/markets", async (req, reply) => {
    const parsed = MarketQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    reply.header("cache-control", "public, max-age=5");
    return q.listMarkets(parsed.data);
  });

  app.get("/markets/:pda", async (req, reply) => {
    const { pda } = z
      .object({ pda: z.string().min(32).max(64) })
      .parse(req.params);
    const m = await q.getMarket(pda);
    if (!m) return notFound(reply, "market");
    reply.header("cache-control", "public, max-age=5");
    return m;
  });

  // ── fixtures ──────────────────────────────────────────────────────────────
  app.get("/fixtures/:id/live", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const f = await q.getFixtureLive(id);
    if (!f) return notFound(reply, "fixture");
    return f;
  });

  // ── receipts ──────────────────────────────────────────────────────────────
  // The headline stat: receipts by market type. One aggregate query, cached.
  app.get("/receipts/summary", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=15");
    return q.getReceiptSummary();
  });

  app.get("/receipts", async (req, reply) => {
    const parsed = ReceiptQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    // Receipts are immutable once written — cache them hard.
    reply.header("cache-control", "public, max-age=30");
    return q.listReceipts(parsed.data);
  });

  app.get("/receipts/:pda", async (req, reply) => {
    const { pda } = z
      .object({ pda: z.string().min(32).max(64) })
      .parse(req.params);
    const r = await q.getReceipt(pda);
    if (!r) return notFound(reply, "receipt — this market has not settled");
    reply.header("cache-control", "public, max-age=300");
    return r;
  });

  // ── settlement archive ────────────────────────────────────────────────────
  // A live settlement happens once, at whatever hour the match ends. This
  // replays it from the same rows the live stream served.
  app.get("/archive/:fixtureId", async (req, reply) => {
    const { fixtureId } = z
      .object({ fixtureId: z.coerce.number().int() })
      .parse(req.params);
    const a = await q.getArchive(fixtureId);
    if (!a) return notFound(reply, "fixture");
    // Immutable once the fixture has settled; still moving until then.
    reply.header(
      "cache-control",
      a.settledAt ? "public, max-age=300" : "public, max-age=5"
    );
    return a;
  });

  // ── sharp vs crowd ────────────────────────────────────────────────────────
  // TxLINE's demargined consensus next to ProofBook's own pools, over time.
  // Display only — no price ever touches a proof, a predicate or a receipt.
  app.get("/markets/:pda/odds", async (req, reply) => {
    const { pda } = z
      .object({ pda: z.string().min(32).max(64) })
      .parse(req.params);
    const s = await q.getOddsSeries(pda);
    if (!s) return notFound(reply, "market");
    reply.header("cache-control", "public, max-age=15");
    return s;
  });

  // ── positions ─────────────────────────────────────────────────────────────
  app.get("/positions/:wallet", async (req, reply) => {
    const { wallet } = z
      .object({ wallet: z.string().min(32).max(64) })
      .parse(req.params);
    reply.header("cache-control", "no-store"); // a judge's own money — never stale
    return q.listPositions(wallet);
  });

  // ── the verifier's TxLINE read credential ─────────────────────────────────
  //
  // /verify runs entirely in the browser and deliberately reads NOTHING from
  // this API: the receipt and the predicate come from the Solana account, the
  // Merkle root comes from TxLINE's own on-chain PDA, and the verdict comes from
  // TxLINE's own program. The one thing the browser cannot mint for itself is a
  // TxLINE read token — that requires an on-chain subscription, which the keeper
  // holds. So we hand out the token, and ONLY the token.
  //
  // This does not weaken the verification, and that is the point worth being
  // precise about: the proof this credential fetches is authenticated against a
  // root read independently from Solana, and adjudicated by the real txoracle
  // program. If ProofBook served a forged proof, verification would FAIL — which
  // is exactly what the "tamper" control on /verify demonstrates.
  //
  // The token is a free-tier, read-only, devnet World-Cup scores credential.
  app.get("/txline/credential", async (_req, reply) => {
    const cred = await q.getTxlineCredential();
    if (!cred) return notFound(reply, "TxLINE credential (keeper has not run)");
    // Short cache: the JWT rotates, and a stale one 401s the browser.
    reply.header("cache-control", "public, max-age=60");
    return cred;
  });

  // ── tournament surfaces ───────────────────────────────────────────────────
  app.get("/standings", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=30");
    return q.getStandings();
  });

  app.get("/bracket", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=30");
    return q.getBracket();
  });

  app.get("/keeper/status", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    const [status, reserves] = await Promise.all([
      q.getKeeperStatus(),
      faucet.reserves(),
    ]);
    return {
      ...status,
      faucet: { enabled: faucet.enabled, address: faucet.address, reserves },
    };
  });

  // ── faucet ────────────────────────────────────────────────────────────────
  app.post(
    "/faucet/:wallet",
    {
      config: {
        rateLimit: {
          max: Number(process.env.FAUCET_RATE_MAX ?? 10),
          timeWindow: "1 minute",
        },
      },
    },
    async (req, reply) => {
      const { wallet } = z
        .object({ wallet: z.string().min(32).max(64) })
        .parse(req.params);
      try {
        return await faucet.fund(wallet);
      } catch (e: any) {
        const code = e?.statusCode ?? 400;
        reply.code(code);
        req.log.warn({ wallet, err: e?.message }, "faucet refused");
        return { ok: false, error: e?.message ?? "faucet failed" };
      }
    }
  );

  // ── SSE ───────────────────────────────────────────────────────────────────
  app.get("/stream", (req, reply) => {
    const types = String((req.query as any)?.types ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx/proxies must not buffer an event stream
      // Echo the origin that actually asked. Returning ORIGINS[0] meant that with
      // more than one allowed origin, every other one silently failed.
      "Access-Control-Allow-Origin": corsHeaderFor(req.headers.origin),
      Vary: "Origin",
    });
    reply.raw.write(`retry: 3000\n: connected\n\n`);

    const remove = stream.addClient((chunk) => reply.raw.write(chunk), types);
    // Proxies drop idle connections; a comment every 25s keeps them open.
    const ping = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        /* closed */
      }
    }, 25_000);

    req.raw.on("close", () => {
      clearInterval(ping);
      remove();
    });
  });

  await stream.start();
  await app.listen({ port: PORT, host: HOST });
  app.log.info(
    {
      port: PORT,
      faucet: faucet.enabled ? faucet.address : "disabled",
      corsOrigins: ORIGIN_PATTERNS,
    },
    "ProofBook API up"
  );
  if (ORIGIN_PATTERNS.includes("*")) {
    app.log.warn(
      "CORS_ORIGINS is '*' — ANY site can call this API, including the faucet. " +
        "Set it to your web URL in production."
    );
  }
}

/** The value to echo back on a manually-written response (SSE). */
function corsHeaderFor(origin: string | undefined): string {
  if (ORIGIN_PATTERNS.includes("*")) return "*";
  if (origin && originAllowed(origin)) return origin;
  return ORIGIN_PATTERNS[0] ?? "*";
}

function badRequest(reply: any, err: z.ZodError) {
  reply.code(400);
  return {
    error: "invalid query",
    issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
function notFound(reply: any, what: string) {
  reply.code(404);
  return { error: `not found: ${what}` };
}

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await stream.stop();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((e) => {
  app.log.error(e, "API failed to start");
  process.exit(1);
});
