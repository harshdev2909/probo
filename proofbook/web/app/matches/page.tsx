"use client";

/**
 * The match board. Storyboard:
 *   0ms    "Matches" masthead
 *   80ms   section labels
 *   200ms+ fixture cards stagger in, 55ms apart, grouped Live → Open → Settled
 */
import { useEffect, useState } from "react";
import { api, type MarketView } from "@/lib/api";
import { isLivePhase } from "@/lib/teams";
import { useStreamEvent } from "@/lib/stream";
import { FixtureCard } from "@/components/FixtureCard";
import { StaggerItem } from "@/components/motion";
import { QuarterLoader, EmptyState, ErrorState } from "@/components/primitives";
import { PageArt } from "@/components/PageArt";

type LoadState = "loading" | "ready" | "error";

export default function Matches() {
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = () =>
    api
      .markets()
      .then((m) => {
        setMarkets(m);
        setState("ready");
      })
      .catch(() => setState("error"));

  useEffect(() => {
    void load();
  }, []);
  useStreamEvent("market", () => void load()); // markets change rarely; refetch on event

  const live = markets.filter((m) => m.status === "locked" && isLivePhase(m.live?.statusId ?? undefined));
  const open = markets.filter((m) => m.status === "open");
  const done = markets.filter((m) => !live.includes(m) && !open.includes(m));

  const groups: [string, MarketView[]][] = [
    ["Live now", live],
    ["Open for bets", open],
    ["Finished & settled", done],
  ];

  let idx = 0;
  return (
    <main className="mx-auto w-full max-w-6xl px-6 pt-12 lg:px-10">
      <PageArt src="/art-stadium.jpg" opacity={0.32} />
      <header className="mb-10 flex items-end justify-between">
        <div>
          <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">Matches</h1>
          <p className="mt-2 text-[13px] text-ink-400">
            Markets open and settle themselves. You just pick a side.
          </p>
        </div>
        <p className="label hidden sm:block">World Cup 2026</p>
      </header>

      {state === "loading" && (
        <div className="flex flex-col items-center gap-4 py-24">
          <QuarterLoader size={36} label="Loading markets" />
          <p className="label">Loading markets</p>
        </div>
      )}
      {state === "error" && (
        <div className="panel">
          <ErrorState title="Keeper API unreachable" retry={() => { setState("loading"); void load(); }} />
        </div>
      )}
      {state === "ready" && markets.length === 0 && (
        <div className="panel">
          <EmptyState
            title="No markets yet"
            hint="Markets open by themselves when fixtures are announced. Check back soon."
          />
        </div>
      )}

      {state === "ready" &&
        groups.map(
          ([title, list]) =>
            list.length > 0 && (
              <section key={title} className="mb-12">
                <div className="mb-4 flex items-center gap-3">
                  <span aria-hidden className="h-2.5 w-2.5 bg-brass-500" style={{ borderRadius: "0 0 0 6px" }} />
                  <h2 className="label !text-[12px]">{title}</h2>
                  <span className="rule flex-1" />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {list.map((m) => (
                    <StaggerItem key={m.marketPda} i={idx++}>
                      <FixtureCard market={m} />
                    </StaggerItem>
                  ))}
                </div>
              </section>
            )
        )}
    </main>
  );
}
