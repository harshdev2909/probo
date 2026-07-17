"use client";

/**
 * The showpiece strip for what happens next: the semi-finals and the Final
 * settle THEMSELVES. No admin, no announcement — a keeper watches the TxLINE
 * stream, and the moment a match finalises it submits the merkle proof and the
 * market pays out. This strip is where a viewer watches that happen live:
 * open → locked at kickoff → LIVE → settled with a receipt, unattended.
 */
import Link from "next/link";
import type { MarketView } from "@/lib/api";
import { teamsForFixture, isLivePhase, phaseLabel } from "@/lib/teams";
import { kickoffLabel } from "@/lib/format";
import { headlineMarkets } from "@/lib/tournament";
import { Flag } from "./Flag";
import { LiveBadge } from "./Score";

export function SettlesItself({ markets }: { markets: MarketView[] }) {
  // ONE card per fixture, not per market. A fixture now carries a dozen markets
  // (goals, corners, cards, parlays…), so mapping over raw markets rendered the
  // Final and the 3rd-place playoff a dozen times each. `headlineMarkets` collapses
  // each fixture to its single 1X2, and its page links through to all the rest.
  const upcoming = headlineMarkets(markets)
    .filter((m) => ["SF", "3rd", "Final"].includes(m.stage))
    .sort((a, b) => a.kickoffTs - b.kickoffTs);
  if (!upcoming.length) return null;

  return (
    <section className="panel mb-10 border border-brass-600/40 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="label text-brass-500">These matches settle themselves</p>
        <p className="font-mono text-[10px] text-ink-600">
          lock at kickoff → live → proven → paid. nobody clicks resolve.
        </p>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {upcoming.map((m) => {
          const [home, away] = teamsForFixture(
            m.fixtureId,
            m.fixtureName,
            m.home,
            m.away
          );
          const live = isLivePhase(m.live?.statusId ?? undefined);
          const settled = m.status === "settled";
          return (
            <Link
              key={m.marketPda}
              href={settled ? `/receipts/${m.marketPda}` : `/m/${m.marketPda}`}
              className="flex items-center justify-between gap-3 border border-hairline px-3.5 py-3 transition-colors hover:border-brass-600/60"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="label !text-[9px] text-ink-600">{m.stage}</span>
                <Flag team={home} size={16} />
                <span className="truncate text-[13px] text-ink-200">
                  {home.code} v {away.code}
                </span>
                <Flag team={away} size={16} />
              </span>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em]">
                {live ? (
                  <LiveBadge label={phaseLabel(m.live?.statusId ?? undefined)} />
                ) : settled ? (
                  <span className="text-brass-400">settled ✓ receipt</span>
                ) : (
                  <span className="text-ink-400">{kickoffLabel(m.lockTime)}</span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
