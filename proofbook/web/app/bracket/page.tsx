"use client";

/**
 * The knockout bracket. Each tie shows the proven scoreline and marks the side
 * that actually went through — every one of those results came from a proof, not
 * from an editor. Ties we cannot prove are drawn, but left blank.
 *
 * Storyboard:
 *   0ms    masthead
 *   140ms+ rounds reveal left-to-right, 90ms apart; ties stagger inside each round
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { api, type MarketView } from "@/lib/api";
import { bracketOf, headlineMarkets, toFixture, winnerOf, type Fixture } from "@/lib/tournament";
import { StaggerItem } from "@/components/motion";
import { QuarterLoader, EmptyState, ErrorState } from "@/components/primitives";
import { PageArt } from "@/components/PageArt";
import { Flag } from "@/components/Flag";

type LoadState = "loading" | "ready" | "error";

const ROUND_NAME: Record<string, string> = {
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-finals",
  SF: "Semi-finals",
  "3rd": "Third place",
  Final: "Final",
};

function Side({
  f, side,
}: {
  f: Fixture;
  side: "home" | "away";
}) {
  const team = side === "home" ? f.home : f.away;
  const goals = side === "home" ? f.score?.p1 : f.score?.p2;
  const won = winnerOf(f)?.code === team.code;

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Flag team={team} size={16} />
        <span
          className={`truncate text-[12px] ${won ? "text-ink-100" : "text-ink-400"}`}
        >
          {team.code}
        </span>
        {won && (
          <span aria-label="advanced" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brass-500" />
        )}
      </div>
      <span className={`mono text-[13px] ${won ? "text-brass-500" : "text-ink-500"}`}>
        {goals ?? "–"}
      </span>
    </div>
  );
}

function Tie({ f }: { f: Fixture }) {
  const body = (
    <div
      className={`panel divide-y divide-hairline ${
        f.proven ? "hover:border-brass-500/50" : "border-dashed opacity-70"
      } transition-colors`}
    >
      <Side f={f} side="home" />
      <Side f={f} side="away" />
    </div>
  );

  if (!f.proven) {
    return (
      <div title={f.gap ? "Outside TxLINE's proof retention window" : "Not played yet"}>
        {body}
        <p className="mt-1 px-1 text-[10px] uppercase tracking-wider text-ink-600">
          {f.gap ? "Unprovable" : "Upcoming"}
        </p>
      </div>
    );
  }
  return (
    <Link
      href={`/receipts/${f.market.marketPda}`}
      className="block focus-visible:ring-2 focus-visible:ring-brass-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
    >
      {body}
    </Link>
  );
}

export default function Bracket() {
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = () =>
    api.allMarkets()
      .then((m) => { setMarkets(m); setState("ready"); })
      .catch(() => setState("error"));

  useEffect(() => { void load(); }, []);

  const rounds = useMemo(() => bracketOf(headlineMarkets(markets).map(toFixture)), [markets]);

  return (
    <main className="mx-auto w-full max-w-[1400px] px-6 pt-12 lg:px-10">
      <PageArt src="/art-bracket.jpg" opacity={0.28} />

      <header className="mb-10">
        <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">Bracket</h1>
        <p className="mt-2 max-w-xl text-[13px] text-ink-400">
          The road to the final. Every scoreline below was proven on-chain — tap a tie
          to see the proof that settled it.
        </p>
      </header>

      {state === "loading" && (
        <div className="flex flex-col items-center gap-4 py-24">
          <QuarterLoader size={36} label="Loading bracket" />
          <p className="label">Loading bracket</p>
        </div>
      )}
      {state === "error" && (
        <div className="panel">
          <ErrorState title="Keeper API unreachable" retry={() => { setState("loading"); void load(); }} />
        </div>
      )}
      {state === "ready" && rounds.length === 0 && (
        <div className="panel">
          <EmptyState title="No knockout ties yet" hint="The bracket fills in once the group stage is done." />
        </div>
      )}

      {state === "ready" && rounds.length > 0 && (
        <div className="overflow-x-auto pb-8">
          <div className="flex min-w-max gap-5">
            {rounds.map(([stage, ties], r) => (
              <section key={stage} className="w-[210px] shrink-0">
                <div className="mb-3 flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 bg-brass-500"
                    style={{ borderRadius: "0 0 0 5px" }}
                  />
                  <h2 className="label !text-[11px]">{ROUND_NAME[stage] ?? stage}</h2>
                </div>
                <ul className="flex flex-col gap-2.5">
                  {ties.map((f, i) => (
                    <StaggerItem key={f.market.marketPda} i={i} base={0.14 + r * 0.09}>
                      <li>
                        <Tie f={f} />
                      </li>
                    </StaggerItem>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
