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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM =
  process.env.SOLANA_RPC_URL ?? // server-only. never NEXT_PUBLIC_.
  "https://api.devnet.solana.com";

/**
 * Everything the wallet flow legitimately needs, and nothing else. Notably absent:
 * getProgramAccounts — it is expensive, and the browser has no business scanning
 * the program when the API already serves every list from Postgres.
 */
const ALLOWED = new Set([
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
