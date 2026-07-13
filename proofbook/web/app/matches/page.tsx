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
import { SettlesItself } from "@/components/SettlesItself";

type LoadState = "loading" | "ready" | "error";

/** A fixture and every market provable on it. */
interface Fixture {
  head: MarketView;
  others: MarketView[];
}

export default function Matches() {
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = () =>
    api
      .allMarkets()
      .then((m) => {
        setMarkets(m);
        setState("ready");
      })
      .catch(() => setState("error"));

  useEffect(() => {
    void load();
  }, []);
  useStreamEvent("market", () => void load()); // markets change rarely; refetch on event

  // ── one card per FIXTURE, not per market ──────────────────────────────────
  //
  // A fixture used to have exactly one market. It now has a dozen (goals,
  // corners, cards, half-time, margin, four parlays), and listing markets
  // directly showed the same match twelve times in a row.
  //
  // Group by fixture, pick a headline market to drive the card, and hang the
  // rest off it as chips. The headline is the 1X2 where there is one — it is the
  // market whose outcome bar reads as a scoreline — otherwise the deepest pool.
  const byFixture = new Map<number, MarketView[]>();
  for (const m of markets) {
    const arr = byFixture.get(m.fixtureId) ?? [];
    arr.push(m);
    byFixture.set(m.fixtureId, arr);
  }

  // Explicit result types — the Half-Time Result market has the same 3-outcome
  // shape, and its winner is not the match winner.
  const RESULT_TYPES = new Set([3, 4, 28]);
  const is1x2 = (m: MarketView) => RESULT_TYPES.has(m.marketType);

  const fixtures: Fixture[] = [...byFixture.values()].map((ms) => {
    const sorted = [...ms].sort((a, b) => {
      // Prefer a settled market (it carries the receipt), then 1X2, then pool size.
      const s = Number(b.status === "settled") - Number(a.status === "settled");
      if (s) return s;
      const x = Number(is1x2(b)) - Number(is1x2(a));
      if (x) return x;
      return Number(b.totalPool) - Number(a.totalPool);
    });
    return { head: sorted[0], others: sorted.slice(1) };
  });

  fixtures.sort((a, b) => a.head.kickoffTs - b.head.kickoffTs);

  const live = fixtures.filter(
    (f) =>
      f.head.status === "locked" &&
      isLivePhase(f.head.live?.statusId ?? undefined)
  );
  const open = fixtures.filter((f) => f.head.status === "open");
  const done = fixtures.filter((f) => !live.includes(f) && !open.includes(f));

  const groups: [string, Fixture[]][] = [
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

      {state === "ready" && <SettlesItself markets={markets} />}

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
                  {list.map((f) => (
                    <StaggerItem key={f.head.fixtureId} i={idx++}>
                      <FixtureCard market={f.head} others={f.others} />
                    </StaggerItem>
                  ))}
                </div>
              </section>
            )
        )}
    </main>
  );
}
