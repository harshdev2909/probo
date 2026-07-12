"use client";

/**
 * Market detail. Storyboard:
 *   0ms    fixture header (flags + rolling score + phase)
 *   120ms  outcome rows stagger
 *   240ms  bet slip + provenance panels rise
 * Live score/phase from the SSE stream; numerals roll on change.
 */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, type MarketView } from "@/lib/api";
import { teamsForFixture, phaseLabel, isLivePhase } from "@/lib/teams";
import { usdc, pct, impliedMultiple, shortAddr, kickoffLabel } from "@/lib/format";
import { useStreamEvent, type ScoreEvent } from "@/lib/stream";
import { Flag } from "@/components/Flag";
import { RollingNumber, LiveBadge } from "@/components/Score";
import { BetSlip } from "@/components/BetSlip";
import { Ticker } from "@/components/Ticker";
import { StaggerItem, Reveal } from "@/components/motion";
import { QuarterLoader, ErrorState, Hash } from "@/components/primitives";
import { PageArt } from "@/components/PageArt";

export default function MarketDetail({ params }: { params: Promise<{ pda: string }> }) {
  const { pda } = use(params);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [err, setErr] = useState(false);
  const [live, setLive] = useState<MarketView["live"] | null>(null);

  const load = () =>
    api
      .market(pda)
      .then((m) => {
        setMarket(m);
        setLive((prev) => prev ?? m.live);
      })
      .catch(() => setErr(true));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pda]);
  useStreamEvent("market", () => void load());
  useStreamEvent<ScoreEvent>("score", (e) => {
    if (!market || e.fixtureId !== market.fixtureId) return;
    setLive((prev) => ({
      statusId: e.statusId ?? prev?.statusId ?? null,
      lastSeq: e.seq,
      // Feed events often carry only the scoring side, so merge rather than replace.
      score: e.score
        ? { p1: e.score.p1 ?? prev?.score?.p1 ?? 0, p2: e.score.p2 ?? prev?.score?.p2 ?? 0 }
        : (prev?.score ?? null),
    }));
  });

  if (err)
    return (
      <main className="mx-auto max-w-3xl px-6 pt-16">
        <div className="panel"><ErrorState title="Market not found" /></div>
      </main>
    );
  if (!market)
    return (
      <main className="flex justify-center pt-32">
        <QuarterLoader size={36} label="Loading market" />
      </main>
    );

  const [home, away] = teamsForFixture(market.fixtureId, market.fixtureName);
  const playing = isLivePhase(live?.statusId);
  const settled = market.status === "settled";
  const labels = [`${home.code} win`, "Draw", `${away.code} win`];

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pt-12 lg:px-10">
      <PageArt src="/art-stadium.jpg" opacity={0.22} />

      {/* fixture header */}
      <header className="panel relative overflow-hidden p-7 md:p-10">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
          <div className="flex flex-col items-start gap-3">
            <Flag team={home} size={40} />
            <p className="display-condensed text-[clamp(18px,3vw,31px)] text-ink-100">{home.name}</p>
          </div>
          <div className="text-center">
            <p className="display tnum text-[clamp(48px,9vw,96px)] leading-none text-ink-100">
              <RollingNumber value={live?.score?.p1 ?? 0} />
              <span className="mx-3 text-ink-500">–</span>
              <RollingNumber value={live?.score?.p2 ?? 0} />
            </p>
            <div className="mt-3">
              {playing ? (
                <LiveBadge label={`LIVE · ${phaseLabel(live?.statusId)}`} />
              ) : (
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-400">
                  {live?.statusId === 100 || settled ? "FULL TIME · FINALISED" : market.status === "open" ? kickoffLabel(market.lockTime) : market.status}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-3">
            <Flag team={away} size={40} />
            <p className="display-condensed text-right text-[clamp(18px,3vw,31px)] text-ink-100">{away.name}</p>
          </div>
        </div>
        {settled && (
          <Link
            href={`/receipts/${market.marketPda}`}
            className="absolute right-0 top-0 border-b border-l border-brass-600 bg-brass-950 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-brass-400 transition-colors duration-150 hover:bg-ink-950"
            style={{ borderRadius: "0 0 0 16px" }}
          >
            Proof receipt →
          </Link>
        )}
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* outcomes */}
        <section aria-label="Outcomes">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="label !text-[12px]">Match winner</h2>
            <span className="tnum font-mono text-[11px] text-ink-400">
              pool {usdc(market.totalPool)} USDC
            </span>
          </div>
          <div className="space-y-2">
            {labels.map((l, i) => {
              const isWin = settled && market.winningOutcome === i;
              const p = market.crowdImplied[i];
              return (
                <StaggerItem key={l} i={i} base={0.12}>
                  <div
                    className={`relative overflow-hidden border p-4 ${
                      isWin ? "border-brass-600 bg-brass-950" : "border-hairline bg-ink-900"
                    }`}
                    style={{ borderRadius: i === 2 ? "0 0 0 var(--r-quarter)" : 0 }}
                  >
                    {/* crowd bar behind content */}
                    <span
                      aria-hidden
                      className={`absolute inset-y-0 left-0 ${isWin ? "bg-brass-500/10" : "bg-ink-800"}`}
                      style={{ width: `${(p ?? 0) * 100}%`, transition: "width 420ms var(--ease-settle)" }}
                    />
                    <div className="relative flex items-center justify-between gap-4">
                      <span className={`display-condensed text-[18px] ${isWin ? "text-brass-400" : "text-ink-100"}`}>
                        {l} {isWin && "· proven"}
                      </span>
                      <span className="tnum flex items-baseline gap-4 font-mono text-[13px]">
                        <span className="text-ink-400">{usdc(market.pools[i], { compact: true })}</span>
                        <span className="text-ink-300">{pct(p)}</span>
                        <span className={isWin ? "text-brass-400" : "text-ink-100"}>
                          {impliedMultiple(market.totalPool, market.pools[i], market.feeBps)}
                        </span>
                      </span>
                    </div>
                  </div>
                </StaggerItem>
              );
            })}
          </div>

          {/* provenance */}
          <Reveal className="mt-6" delay={0.1}>
            <div className="panel p-5">
              <p className="label mb-3">Verified match data</p>
              <p className="text-[13px] text-ink-300">
                Live scores and the final result for this match come from TxLINE, match {market.fixtureId}.
              </p>
              <p className="mt-3 text-[12px] leading-relaxed text-ink-500">
                This market settles only against verified TxLINE match data. Not a vote. Not an admin. A proof.
              </p>
            </div>
          </Reveal>
        </section>

        {/* bet slip */}
        <StaggerItem i={2} base={0.12}>
          <BetSlip market={market} onPlaced={() => void load()} />
        </StaggerItem>
      </div>

      <Reveal className="mt-10" delay={0.05}>
        <Ticker />
      </Reveal>
    </main>
  );
}
