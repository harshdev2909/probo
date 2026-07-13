"use client";

/**
 * Every market provable on one fixture, grouped the way a bettor thinks:
 * Result / Goals / Corners / Cards / Parlays.
 *
 * This is the surface that makes the catalogue visible. Each row is a market
 * with its pool and state; settled rows link straight to their receipt, because
 * the receipt is the product.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type MarketView } from "@/lib/api";
import { usdc } from "@/lib/format";

const GROUPS = ["Result", "Goals", "Corners", "Cards", "Parlays"] as const;

/** Match-page group per market type — mirrors shared/markets.ts TYPE_META. */
const GROUP_OF: Record<number, (typeof GROUPS)[number]> = {
  3: "Result", 4: "Result", 28: "Result", 34: "Result",
  29: "Goals", 32: "Goals", 33: "Goals", 35: "Goals",
  30: "Corners",
  31: "Cards",
  36: "Parlays", 37: "Parlays", 38: "Parlays", 39: "Parlays",
};

export function FixtureMarkets({
  fixtureId,
  currentPda,
}: {
  fixtureId: number;
  currentPda: string;
}) {
  const [markets, setMarkets] = useState<MarketView[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .allMarkets({ fixtureId } as any)
      .then((m) => alive && setMarkets(m))
      .catch(() => alive && setMarkets([]));
    return () => {
      alive = false;
    };
  }, [fixtureId]);

  if (!markets || markets.length <= 1) return null;

  const grouped = GROUPS.map(
    (g) =>
      [
        g,
        markets
          .filter((m) => GROUP_OF[m.marketType] === g)
          .sort((a, b) => a.marketType - b.marketType),
      ] as const
  ).filter(([, list]) => list.length > 0);

  return (
    <section aria-label="All markets on this fixture" className="panel border border-hairline p-5">
      <div className="flex items-baseline justify-between">
        <p className="label text-brass-500">All markets on this fixture</p>
        <p className="font-mono text-[10px] text-ink-600">
          {markets.length} markets · every one settles by proof
        </p>
      </div>

      <div className="mt-4 space-y-4">
        {grouped.map(([group, list]) => (
          <div key={group}>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-600">
              {group}
            </p>
            <div className="space-y-px">
              {list.map((m) => {
                const here = m.marketPda === currentPda;
                const settled = m.status === "settled";
                return (
                  <Link
                    key={m.marketPda}
                    href={`/m/${m.marketPda}`}
                    aria-current={here ? "page" : undefined}
                    className="flex items-center justify-between gap-3 border border-transparent px-2.5 py-2 transition-colors duration-150 ease-snap hover:border-hairline-strong hover:bg-ink-800"
                    style={{
                      background: here ? "var(--color-ink-800)" : undefined,
                      borderColor: here ? "var(--color-hairline-strong)" : undefined,
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {m.isParlay && (
                        <span className="text-brass-500" aria-hidden>
                          ⚡
                        </span>
                      )}
                      <span
                        className="truncate text-[13px]"
                        style={{
                          color: here ? "var(--color-ink-100)" : "var(--color-ink-300)",
                        }}
                      >
                        {m.marketName}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3 font-mono text-[11px]">
                      <span className="tnum text-ink-500">
                        {usdc(m.totalPool, { compact: true })}
                      </span>
                      {settled ? (
                        <span className="text-brass-400">receipt ✓</span>
                      ) : (
                        <span className="text-ink-600">{m.status}</span>
                      )}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
