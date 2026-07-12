"use client";

/**
 * One fixture on the board. broadcast-widget anatomy: flags + names left,
 * scores right, status column, winner caret, live pulse. Live scores update
 * from the SSE stream and roll on change.
 */
import Link from "next/link";
import { useState } from "react";
import type { MarketView } from "@/lib/api";
import { teamsForFixture, phaseLabel, isLivePhase } from "@/lib/teams";
import { usdc, kickoffLabel, pct } from "@/lib/format";
import { useStreamEvent, type ScoreEvent } from "@/lib/stream";
import { TeamRow } from "./Flag";
import { LiveBadge } from "./Score";

export function FixtureCard({ market }: { market: MarketView }) {
  const [home, away] = teamsForFixture(market.fixtureId, market.fixtureName, market.home, market.away);
  const [live, setLive] = useState(market.live);

  useStreamEvent<ScoreEvent>("score", (e) => {
    if (e.fixtureId !== market.fixtureId) return;
    setLive((prev) => ({
      statusId: e.statusId ?? prev?.statusId,
      lastSeq: e.seq,
      score: e.score
        ? { p1: e.score.p1 ?? prev?.score?.p1 ?? 0, p2: e.score.p2 ?? prev?.score?.p2 ?? 0 }
        : prev?.score,
    }));
  });

  const score = live?.score;
  const playing = isLivePhase(live?.statusId);
  const done = market.status === "settled" || market.status === "cancelled" || live?.statusId === 100;
  const winner = market.winningOutcome;
  // Played, but TxLINE can no longer prove it. We show the fixture and say so —
  // we never invent a scoreline or a receipt to fill the hole.
  const gap = market.proofStatus === "no_proof";

  return (
    <Link
      href={`/m/${market.marketPda}`}
      className="panel group grid grid-cols-[1fr_auto] gap-x-5 p-5 transition-colors duration-150 ease-snap hover:border-hairline-strong hover:bg-ink-800 focus-visible:outline-2"
      aria-label={`${home.name} versus ${away.name} — ${market.status}`}
    >
      <div className="min-w-0 space-y-2.5">
        <TeamRow team={home} score={score?.p1} winner={done && winner === 0} dim={done && winner === 2} />
        <TeamRow team={away} score={score?.p2} winner={done && winner === 2} dim={done && winner === 0} />
      </div>

      <div className="flex w-[86px] flex-col items-end justify-center gap-1.5 border-l border-hairline pl-5 text-right">
        {playing ? (
          <LiveBadge label={phaseLabel(live?.statusId)} />
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">
            {gap
              ? "PLAYED"
              : done
                ? market.status === "cancelled" ? "VOID" : "FT"
                : kickoffLabel(market.lockTime)}
          </span>
        )}
        <span className="font-mono text-[10px] text-ink-500">
          {gap
            ? "no proof"
            : market.status === "open"
              ? `pool ${usdc(market.totalPool, { compact: true })}`
              : market.status}
        </span>
      </div>

      {/* implied bar. the crowd's live opinion */}
      {gap && (
        <p className="col-span-2 mt-3.5 border-t border-dashed border-hairline pt-3 text-[11px] text-ink-500">
          This match was played, but it falls outside the window where its result can
          still be proven. No receipt, and we won&apos;t fake one.
        </p>
      )}

      {!gap && market.status === "open" && Number(market.totalPool) > 0 && (
        <div className="col-span-2 mt-4">
          <div className="flex h-[3px] w-full gap-px overflow-hidden" aria-hidden>
            {market.crowdImplied.map((p, i) => (
              <span
                key={i}
                className={i === 0 ? "bg-ink-300" : i === 1 ? "bg-ink-500" : "bg-ink-700"}
                style={{ width: `${(p ?? 0) * 100}%`, transition: "width 240ms var(--ease-settle)" }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-ink-500">
            <span>{home.code} {pct(market.crowdImplied[0])}</span>
            <span>draw {pct(market.crowdImplied[1])}</span>
            <span>{away.code} {pct(market.crowdImplied[2])}</span>
          </div>
        </div>
      )}
    </Link>
  );
}
