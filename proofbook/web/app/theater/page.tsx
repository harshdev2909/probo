"use client";

/**
 * /theater — the Settlement Theater launcher.
 *
 * Runs LIVE for the next knockout still to be decided (the Final, the 3rd-place
 * playoff), and offers a one-click REPLAY of any settlement already recorded, so
 * the money shot can be screen-recorded at any hour.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type MarketView } from "@/lib/api";
import { headlineMarkets } from "@/lib/tournament";
import { teamsForFixture, isLivePhase } from "@/lib/teams";
import { useLiveFeed } from "@/components/theater/driver";
import { SettlementTheater } from "@/components/theater/SettlementTheater";
import { PageArt } from "@/components/PageArt";
import { QuarterLoader } from "@/components/primitives";

const KNOCKOUT = ["SF", "3rd", "Final"];

function LiveStage({ fixtureId, name }: { fixtureId: number; name: string }) {
  const feed = useLiveFeed(fixtureId, name);
  return <SettlementTheater feed={feed} />;
}

export default function TheaterPage() {
  const [markets, setMarkets] = useState<MarketView[] | null>(null);

  useEffect(() => {
    api
      .allMarkets()
      .then(setMarkets)
      .catch(() => setMarkets([]));
  }, []);

  const { featured, replays } = useMemo(() => {
    const knockout = headlineMarkets(markets ?? [])
      .filter((m) => KNOCKOUT.includes(m.stage))
      .sort((a, b) => a.kickoffTs - b.kickoffTs);
    // Featured live: something in play, else the next one still open.
    const live = knockout.find((m) => isLivePhase(m.live?.statusId ?? undefined));
    const nextOpen = knockout.find((m) => m.status === "open");
    const featured = live ?? nextOpen ?? null;
    const replays = knockout.filter((m) => m.status === "settled");
    return { featured, replays };
  }, [markets]);

  if (markets === null) {
    return (
      <main className="flex min-h-[70vh] flex-col items-center justify-center gap-3">
        <QuarterLoader size={36} label="Loading" />
        <p className="label">Loading the stage</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-24 lg:px-8">
      <PageArt src="/art-keeper.jpg" opacity={0.16} />

      {featured ? (
        <LiveStage
          key={featured.fixtureId}
          fixtureId={featured.fixtureId}
          name={fixtureName(featured)}
        />
      ) : (
        <section className="flex min-h-[60vh] flex-col justify-center px-2 py-10">
          <p className="label text-brass-500">Settlement Theater</p>
          <h1 className="display mt-2 text-[clamp(28px,4.4vw,52px)] leading-none text-ink-100">
            Nothing is settling right now.
          </h1>
          <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-ink-400">
            When a knockout match kicks off, this becomes a live stage: score → full
            time → proof → <span className="text-brass-400">VERIFIED</span> → paid,
            with no human clicking resolve. Until then, replay a settlement that
            already happened.
          </p>
        </section>
      )}

      {/* replays */}
      {replays.length > 0 && (
        <section className="mt-10">
          <div className="mb-4 flex items-center gap-3">
            <span aria-hidden className="h-2.5 w-2.5 bg-brass-500" style={{ borderRadius: "0 0 0 6px" }} />
            <h2 className="label !text-[12px]">Replay a recorded settlement</h2>
            <span className="rule flex-1" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {replays.map((m) => {
              const [h, a] = teamsForFixture(m.fixtureId, m.fixtureName, m.home, m.away);
              return (
                <Link
                  key={m.fixtureId}
                  href={`/theater/${m.fixtureId}`}
                  className="flex items-center justify-between gap-3 border border-hairline px-4 py-3 transition-colors hover:border-brass-600/60"
                >
                  <span className="flex items-center gap-2">
                    <span className="label !text-[9px] text-ink-600">{m.stage}</span>
                    <span className="text-[13px] text-ink-200">
                      {h.code} v {a.code}
                    </span>
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-brass-500">
                    replay ▸
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

function fixtureName(m: MarketView): string {
  const [h, a] = teamsForFixture(m.fixtureId, m.fixtureName, m.home, m.away);
  return `${h.name} v ${a.name}`;
}
