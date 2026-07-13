"use client";

/**
 * One FIXTURE on the board — not one market.
 *
 * A fixture used to have exactly one market (1X2), so a card and a market were
 * the same thing. It now carries a dozen — goals, corners, cards, half-time,
 * margin, four parlays — and rendering one card per market showed the same match
 * twelve times over, every card labelled Home/Draw/Away regardless of what it
 * actually proved.
 *
 * So: the card is the fixture. The headline market drives the scoreline and the
 * crowd bar; the rest are chips underneath, each linking to its own market.
 */
import Link from "next/link";
import { useState } from "react";
import type { MarketView } from "@/lib/api";
import { teamsForFixture, phaseLabel, isLivePhase } from "@/lib/teams";
import { usdc, kickoffLabel, pct } from "@/lib/format";
import { useStreamEvent, type ScoreEvent } from "@/lib/stream";
import { TeamRow } from "./Flag";
import { LiveBadge } from "./Score";

const SHADES = ["bg-ink-300", "bg-ink-500", "bg-ink-700", "bg-ink-800"];

/** Keep the bar legible: team codes for 1X2, trimmed cells for a long parlay. */
function shorten(label: string, homeCode: string, awayCode: string): string {
  if (label === "Home") return homeCode;
  if (label === "Away") return awayCode;
  if (label === "Draw") return "draw";
  return label.length > 16 ? label.slice(0, 15) + "…" : label;
}

export function FixtureCard({
  market,
  others = [],
}: {
  market: MarketView;
  /** The other markets on the same fixture. */
  others?: MarketView[];
}) {
  const [home, away] = teamsForFixture(
    market.fixtureId,
    market.fixtureName,
    market.home,
    market.away
  );
  const [live, setLive] = useState(market.live);

  useStreamEvent<ScoreEvent>("score", (e) => {
    if (e.fixtureId !== market.fixtureId) return;
    setLive((prev) => ({
      statusId: e.statusId ?? prev?.statusId,
      lastSeq: e.seq,
      score: e.score
        ? {
            p1: e.score.p1 ?? prev?.score?.p1 ?? 0,
            p2: e.score.p2 ?? prev?.score?.p2 ?? 0,
          }
        : prev?.score,
    }));
  });

  const score = live?.score;
  const playing = isLivePhase(live?.statusId);
  const done =
    market.status === "settled" ||
    market.status === "cancelled" ||
    live?.statusId === 100;
  const winner = market.winningOutcome;
  // Played, but TxLINE can no longer prove it. We show the fixture and say so —
  // we never invent a scoreline or a receipt to fill the hole.
  const gap = market.proofStatus === "no_proof";

  // A winner caret only means home/away on a 1X2 market. On an Over/Under it
  // would highlight a team that has nothing to do with the winning outcome.
  const is1x2 = market.outcomes[0] === "Home" && market.outcomes.length === 3;

  return (
    <div className="panel group p-5 transition-colors duration-150 ease-snap hover:border-hairline-strong">
      <Link
        href={`/m/${market.marketPda}`}
        className="grid grid-cols-[1fr_auto] gap-x-5 focus-visible:outline-2"
        aria-label={`${home.name} versus ${away.name}, ${market.marketName}`}
      >
        <div className="min-w-0 space-y-2.5">
          <TeamRow
            team={home}
            score={score?.p1}
            winner={done && is1x2 && winner === 0}
            dim={done && is1x2 && winner === 2}
          />
          <TeamRow
            team={away}
            score={score?.p2}
            winner={done && is1x2 && winner === 2}
            dim={done && is1x2 && winner === 0}
          />
        </div>

        <div className="flex w-[86px] flex-col items-end justify-center gap-1.5 border-l border-hairline pl-5 text-right">
          {playing ? (
            <LiveBadge label={phaseLabel(live?.statusId)} />
          ) : (
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">
              {gap
                ? "PLAYED"
                : done
                  ? market.status === "cancelled"
                    ? "VOID"
                    : "FT"
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
      </Link>

      {gap && (
        <p className="mt-3.5 border-t border-dashed border-hairline pt-3 text-[11px] text-ink-500">
          This match was played, but it falls outside the window where its result
          can still be proven. No receipt, and we won&apos;t fake one.
        </p>
      )}

      {/* the headline market: say WHICH market this bar is about */}
      {!gap && Number(market.totalPool) > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-600">
            {market.marketName}
          </p>
          <div className="flex h-[3px] w-full gap-px overflow-hidden" aria-hidden>
            {market.crowdImplied.map((p, i) => (
              <span
                key={i}
                className={SHADES[i % SHADES.length]}
                style={{
                  width: `${(p ?? 0) * 100}%`,
                  transition: "width 240ms var(--ease-settle)",
                }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 font-mono text-[10px] text-ink-500">
            {market.outcomes.map((label, i) => (
              <span key={i} className="truncate">
                {shorten(label, home.code, away.code)} {pct(market.crowdImplied[i])}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* every other market provable on this fixture */}
      {others.length > 0 && (
        <div className="mt-4 border-t border-hairline pt-3">
          <div className="flex flex-wrap gap-1.5">
            {others.map((o) => (
              <Link
                key={o.marketPda}
                href={`/m/${o.marketPda}`}
                className="border border-hairline px-2 py-1 font-mono text-[10px] text-ink-400 transition-colors hover:border-brass-600 hover:text-brass-500"
                title={o.marketName}
              >
                {o.isParlay ? "⚡ " : ""}
                {shortName(o)}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The chip label. Parlays get their legs; everything else its short title. */
function shortName(m: MarketView): string {
  if (m.isParlay) return m.marketName;
  return m.marketName
    .replace("Total ", "")
    .replace(" O/U", "")
    .replace("Match Result", "1X2");
}
