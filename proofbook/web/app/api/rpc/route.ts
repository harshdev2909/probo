/**
 * Server-side Solana RPC proxy.
 *
 * The browser must never hold the RPC key. `NEXT_PUBLIC_*` is inlined into the
 * JavaScript bundle, so shipping the Helius URL that way publishes the key to
 * anyone who opens devtools — they can then spend the quota until it's gone, and
 * on Final night that means the site cannot broadcast a bet.
 *
 * So the browser talks to this same-origin route, and only this route knows the
 * upstream URL. It is also a chokepoint: a method allowlist, a body-size cap and
 * a per-IP rate limit, none of which are possible when the browser calls Helius
 * directly.
 */
import { NextRequest, NextResponse } from "next/server";

import idl from "@/lib/idl/proofbook.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Taken from the IDL, so it cannot drift from the program the app actually talks to. */
const PROGRAM_ID: string = (idl as { address: string }).address;

const UPSTREAM =
  process.env.SOLANA_RPC_URL ?? // server-only. never NEXT_PUBLIC_.
  "https://api.devnet.solana.com";

/**
 * Everything the wallet flow legitimately needs, and nothing else.
 *
 * getProgramAccounts is the one that needs justifying. It used to be barred
 * outright, on the grounds that it is expensive and that the API already serves
 * every list from Postgres. That is still true of markets — and it is NOT true of
 * prop vaults, which live only on chain and are deliberately read from there, so
 * that /vault does not ask you to trust our database.
 *
 * So it is allowed, but narrowly: see `programAccountsAllowed` below. Only our own
 * program, and only with a filter, which keeps it a bounded indexed scan instead of
 * an open invitation to walk somebody else's program through our RPC key.
 */
const ALLOWED = new Set([
  "getProgramAccounts",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSlot",
  "getVersion",
  "getHealth",
  "getEpochInfo",
  "getGenesisHash", // used to VERIFY we are on devnet, not to trust a config string
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getTransaction",
]);

/**
 * A getProgramAccounts call is allowed only when it is one WE make:
 *
 *   · against the ProofBook program, and nothing else
 *   · with at least one filter, so the RPC does the narrowing and returns a handful
 *     of accounts rather than every account the program owns
 *
 * Anchor's `.all()` always sends a memcmp filter on the account discriminator, so the
 * legitimate caller passes; a bare "scan this program" does not.
 */
function programAccountsAllowed(params: unknown): boolean {
  if (!Array.isArray(params) || params.length === 0) return false;
  if (params[0] !== PROGRAM_ID) return false;
  const filters = (params[1] as any)?.filters;
  return Array.isArray(filters) && filters.length > 0;
}

const MAX_BODY = 200_000; // a signed tx is ~1-2 KB; 200 KB is generous
const WINDOW_MS = 60_000;
const MAX_REQ = Number(process.env.RPC_PROXY_RATE_MAX ?? 240);

/**
 * Per-IP limiter. In-memory, so it is per-instance — enough to stop a single
 * browser hammering the quota, not a substitute for a real WAF. If the app is
 * ever scaled out, move this to the API's shared rate limiter.
 */
const hits = new Map<string, { n: number; resetAt: number }>();

function limited(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now > cur.resetAt) {
    hits.set(ip, { n: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  cur.n++;
  return cur.n > MAX_REQ;
}

// The map would otherwise grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of hits) if (now > v.resetAt) hits.delete(ip);
}, WINDOW_MS).unref?.();

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  if (limited(ip)) {
    return NextResponse.json(
      { error: "rate limited — slow down" },
      { status: 429, headers: { "retry-after": "60" } }
    );
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // web3.js batches, so a body may be a single call or an array of them.
  const calls = Array.isArray(body) ? body : [body];
  for (const c of calls) {
    const method = (c as any)?.method;
    if (typeof method !== "string" || !ALLOWED.has(method)) {
      return NextResponse.json(
        { error: `method not allowed: ${method ?? "(none)"}` },
        { status: 403 }
      );
    }
    if (method === "getProgramAccounts" && !programAccountsAllowed((c as any)?.params)) {
      return NextResponse.json(
        {
          error:
            "getProgramAccounts is permitted only for the ProofBook program, and only with a filter",
        },
        { status: 403 }
      );
    }
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      // A hung RPC must not hold the request open forever.
      signal: AbortSignal.timeout(20_000),
    });

    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Never echo the upstream URL — it carries the key.
    return NextResponse.json({ error: `RPC upstream failed: ${msg}` }, { status: 502 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, proxy: "solana-rpc", methods: ALLOWED.size });
}
