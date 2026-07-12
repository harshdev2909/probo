/** Number formatting: USDC (6dp), implied odds, payouts. Tabular everywhere. */

export function usdc(raw: string | number | bigint, opts: { compact?: boolean } = {}): string {
  const n = Number(raw) / 1e6;
  if (opts.compact && n >= 10_000) {
    return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${(n / 1_000).toFixed(1)}K`;
  }
  return n.toLocaleString("en-US", {
    minimumFractionDigits: n < 1 && n > 0 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/** Crowd-implied probability (0..1) → percent string. */
export function pct(p: number | null): string {
  if (p === null || !isFinite(p)) return "—";
  return `${Math.round(p * 100)}%`;
}

/** Parimutuel multiple if this outcome wins: (total − fee) / outcomePool. */
export function impliedMultiple(totalPool: string, pool: string, feeBps: number): string {
  const total = Number(totalPool), out = Number(pool);
  if (out <= 0) return "—";
  const x = (total * (1 - feeBps / 10_000)) / out;
  return `×${x.toFixed(2)}`;
}

/** Projected payout for a stake added to a pool. */
export function projectPayout(stake: number, totalPool: string, pool: string, feeBps: number): number {
  const t = Number(totalPool) / 1e6 + stake;
  const p = Number(pool) / 1e6 + stake;
  if (p <= 0 || stake <= 0) return 0;
  return (stake / p) * t * (1 - feeBps / 10_000);
}

export function shortAddr(a: string, n = 4): string {
  return a.length > n * 2 + 2 ? `${a.slice(0, n)}…${a.slice(-n)}` : a;
}

export function kickoffLabel(lockTime: number): string {
  const d = new Date(lockTime * 1000);
  const now = Date.now();
  const diff = lockTime * 1000 - now;
  if (diff > 0 && diff < 90 * 60_000) return `Locks in ${Math.max(1, Math.round(diff / 60_000))}m`;
  return d.toLocaleString("en-US", {
    weekday: "short", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit",
  });
}
