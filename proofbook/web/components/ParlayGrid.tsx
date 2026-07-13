"use client";

/**
 * The 2×2 parlay grid — the market type that only exists because of
 * validate_stat_v3, rendered so its logic is legible at a glance.
 *
 * A parlay's outcome set has to be EXHAUSTIVE: an outcome is an AND of
 * predicates, there is no OR and no negation, so the complement of "A and B"
 * cannot be written as one outcome. The grid is the fix — four pure-AND cells
 * that tile every possible result. Outcome 0 is "the parlay"; the other three
 * are the ways it misses. All four are provable, all four are bettable, and one
 * of them MUST win, which is what makes the market settleable at all.
 */
import type { MarketView } from "@/lib/api";
import { usdc, pct } from "@/lib/format";

/** Split "Home win & Over 9.5 corners" into its two legs. */
const legsOf = (label: string): [string, string] => {
  const i = label.indexOf(" & ");
  return i < 0 ? [label, ""] : [label.slice(0, i), label.slice(i + 3)];
};

export function ParlayGrid({
  market,
  userOutcome,
  onPick,
}: {
  market: MarketView;
  /** The outcome the connected wallet has staked, if any. */
  userOutcome?: number | null;
  onPick?: (outcomeIndex: number) => void;
}) {
  const settled = market.status === "settled";
  const winner = market.winningOutcome;
  const total = Number(market.totalPool);

  // Outcome order is (A∧B), (A∧¬B), (¬A∧B), (¬A∧¬B) — fixed by the on-chain
  // ComboSpec. Cell 0 is the parlay; the grid axes are condition A (rows) and
  // condition B (columns).
  const [aYes] = legsOf(market.outcomes[0]);
  const [aNo] = legsOf(market.outcomes[2]);
  const [, bYes] = legsOf(market.outcomes[0]);
  const [, bNo] = legsOf(market.outcomes[1]);

  const cell = (i: number) => {
    const won = settled && winner === i;
    const lost = settled && winner !== i;
    const mine = userOutcome === i;
    const implied = market.crowdImplied[i];

    return (
      <button
        key={i}
        onClick={onPick ? () => onPick(i) : undefined}
        disabled={!onPick || market.status !== "open"}
        className="relative flex min-h-[92px] flex-col justify-between border p-3 text-left transition-colors duration-150 ease-snap disabled:cursor-default"
        style={{
          borderColor: won
            ? "var(--brass-500)"
            : i === 0
              ? "var(--brass-600)"
              : "var(--color-hairline)",
          background: won
            ? "var(--brass-950)"
            : lost
              ? "transparent"
              : "var(--color-ink-900)",
          opacity: lost ? 0.55 : 1,
          borderRadius: i === 2 ? "0 0 0 16px" : undefined,
        }}
      >
        {i === 0 && (
          <span
            className="absolute -top-px right-3 border-x border-b border-brass-600 bg-brass-950 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brass-400"
            style={{ borderRadius: "0 0 4px 4px" }}
          >
            The parlay
          </span>
        )}
        <span
          className="pr-14 text-[13px] leading-snug"
          style={{ color: won ? "var(--brass-400)" : "var(--color-ink-200)" }}
        >
          {market.outcomes[i]}
        </span>
        <span className="mt-2 flex items-baseline justify-between font-mono text-[11px]">
          <span className="text-ink-500">
            {usdc(market.pools[i], { compact: true })}
            {total > 0 && implied !== null && (
              <span className="ml-1.5 text-ink-600">{pct(implied)}</span>
            )}
          </span>
          <span className="flex items-center gap-2">
            {mine && (
              <span className="border border-pitch-400/50 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-pitch-400">
                your stake
              </span>
            )}
            {won && <span className="text-brass-400">✓ settled</span>}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div>
      {/* axis labels make the grid read as a truth table, not four buttons */}
      <div className="mb-1 grid grid-cols-[68px_1fr_1fr] gap-1">
        <span />
        <span className="truncate text-center font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500">
          {bYes}
        </span>
        <span className="truncate text-center font-mono text-[10px] uppercase tracking-[0.1em] text-ink-600">
          {bNo}
        </span>
      </div>
      <div className="grid grid-cols-[68px_1fr_1fr] gap-1">
        <span className="self-center pr-2 text-right font-mono text-[10px] uppercase leading-tight tracking-[0.1em] text-ink-500">
          {aYes}
        </span>
        {cell(0)}
        {cell(1)}
        <span className="self-center pr-2 text-right font-mono text-[10px] uppercase leading-tight tracking-[0.1em] text-ink-600">
          {aNo}
        </span>
        {cell(2)}
        {cell(3)}
      </div>

      {/* the finding, as product copy */}
      <details className="mt-4 border border-dashed border-hairline p-3">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.1em] text-ink-500">
          Why these two legs, and why not &ldquo;win &amp; over 2.5 goals&rdquo;?
        </summary>
        <div className="mt-3 space-y-2 text-[12px] leading-relaxed text-ink-400">
          <p>
            Both legs of this parlay are proven together in{" "}
            <strong className="text-ink-200">one merkle multiproof</strong>, and
            TxLINE&rsquo;s oracle evaluates each proven stat{" "}
            <strong className="text-ink-200">exactly once</strong>. So a
            parlay&rsquo;s legs must read{" "}
            <strong className="text-ink-200">disjoint stat families</strong>:
          </p>
          <p className="font-mono text-[11px] text-ink-500">
            goals&nbsp;&#123;1,2&#125; · corners&nbsp;&#123;7,8&#125; ·
            cards&nbsp;&#123;3,4&#125;
          </p>
          <p>
            &ldquo;Home win <em>and</em> over 2.5 goals&rdquo; is not expressible:
            both legs read the goals stats, and the oracle rejects the double
            read (error 6070). &ldquo;Home win <em>and</em> over 9.5
            corners&rdquo; works, because goals and corners are different leaves
            of the tree. This is a property of the proof system, not a product
            choice, and the market you are looking at is shaped by it.
          </p>
        </div>
      </details>
    </div>
  );
}
