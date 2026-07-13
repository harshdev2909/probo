"use client";

/**
 * The Receipt Gallery — the product's hero surface.
 *
 * Every tile is a market that settled itself: a real merkle proof from TxLINE,
 * verified on-chain, with a transaction anyone can open on Solscan. Nobody
 * clicked resolve on any of them.
 *
 * The wall is RECEIPT-shaped, not fixture-shaped: a fixture carries a dozen
 * markets now (goals, corners, cards, parlays), and each one that settles earns
 * its own receipt. The by-type strip is the headline stat, and each chip is a
 * filter.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "framer-motion";

import { api, type MarketView, type ReceiptView, type ReceiptSummary } from "@/lib/api";
import { teamsForFixture } from "@/lib/teams";
import { StaggerItem, Reveal } from "@/components/motion";
import { QuarterLoader, EmptyState, ErrorState } from "@/components/primitives";
import { PageArt } from "@/components/PageArt";
import { Flag } from "@/components/Flag";
import { Seal } from "@/components/Seal";

type LoadState = "loading" | "ready" | "error";

/** Counts up to `to` on mount; static for reduced-motion users. */
function Counter({ to }: { to: number }) {
  const reduced = useReducedMotion();
  const [n, setN] = useState(reduced ? to : 0);

  useEffect(() => {
    if (reduced) { setN(to); return; }
    let raf = 0;
    const t0 = performance.now();
    const dur = 900;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3)))); // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, reduced]);

  return <>{n}</>;
}

/**
 * One FIXTURE, with every receipt it earned inside.
 *
 * The wall used to render one full-size card per receipt, and since a fixture
 * settles a dozen markets within seconds of each other, a viewer saw twelve
 * near-identical "CZE 1–1 RSA" cards in a row — technically distinct, visually
 * duplicates. The match is stated once; the receipts are the rows.
 */
function FixturePanel({ receipts }: { receipts: ReceiptView[] }) {
  const first = receipts[0];
  const [home, away] = teamsForFixture(
    first.matchId,
    first.fixtureName,
    first.home,
    first.away
  );
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-3 border-b border-hairline pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Flag team={home} size={20} />
          <span className="truncate text-[14px] text-ink-100">{home.code}</span>
        </div>
        <div className="text-center">
          <span className="mono text-[17px] text-ink-100">
            {first.provenScore
              ? `${first.provenScore.p1}–${first.provenScore.p2}`
              : "—"}
          </span>
          <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-600">
            {first.stage} · proven
          </p>
        </div>
        <div className="flex min-w-0 flex-row-reverse items-center gap-2">
          <Flag team={away} size={20} />
          <span className="truncate text-[14px] text-ink-100">{away.code}</span>
        </div>
      </div>

      <ul className="mt-2 space-y-px">
        {receipts.map((r) => (
          <li key={r.marketPda}>
            <Link
              href={`/receipts/${r.marketPda}`}
              className="group flex items-center justify-between gap-3 px-1.5 py-1.5 transition-colors hover:bg-ink-800"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-300">
                {r.isParlay && (
                  <span aria-hidden className="text-brass-500">
                    ⚡
                  </span>
                )}
                <span className="truncate">{r.marketName}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="max-w-[150px] truncate text-right font-mono text-[11px] text-ink-500 group-hover:text-brass-500">
                  {r.outcomeLabel}
                </span>
                <Seal size={13} state="verified" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Receipts() {
  const [receipts, setReceipts] = useState<ReceiptView[]>([]);
  const [summary, setSummary] = useState<ReceiptSummary | null>(null);
  const [gapMarkets, setGapMarkets] = useState<MarketView[]>([]);
  const [typeFilter, setTypeFilter] = useState<number | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  const load = () =>
    Promise.all([
      // Paged to the full wall — the API caps a page at 200.
      (async () => {
        const all: ReceiptView[] = [];
        for (let offset = 0; ; offset += 200) {
          const page = await api.receipts({ limit: 200, offset });
          all.push(...page.items);
          if (!page.hasMore || page.items.length === 0) break;
          if (all.length > 5000) break;
        }
        return all;
      })(),
      api.receiptSummary(),
      api.allMarkets({ proofStatus: "no_proof" }),
    ])
      .then(([r, s, g]) => {
        setReceipts(r);
        setSummary(s);
        setGapMarkets(g);
        setState("ready");
      })
      .catch(() => setState("error"));

  useEffect(() => { void load(); }, []);

  const shown = useMemo(
    () =>
      typeFilter === null
        ? receipts
        : receipts.filter((r) => r.marketType === typeFilter),
    [receipts, typeFilter]
  );

  // Group by fixture, newest first; receipts within a fixture in type order.
  const byFixture = useMemo(() => {
    const g = new Map<number, ReceiptView[]>();
    for (const r of shown) {
      const arr = g.get(r.matchId) ?? [];
      arr.push(r);
      g.set(r.matchId, arr);
    }
    for (const arr of g.values()) arr.sort((a, b) => a.marketType - b.marketType);
    return [...g.entries()];
  }, [shown]);

  // One row per unprovable FIXTURE, not per unprovable market.
  const gaps = useMemo(() => {
    const seen = new Map<number, MarketView>();
    for (const m of gapMarkets) if (!seen.has(m.fixtureId)) seen.set(m.fixtureId, m);
    return [...seen.values()];
  }, [gapMarkets]);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pt-12 lg:px-10">
      <PageArt src="/art-receipts.jpg" opacity={0.3} />

      <header className="mb-10">
        <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">Receipts</h1>
        <p className="mt-2 max-w-xl text-[13px] text-ink-400">
          Every market here paid out on its own. The result came from a cryptographic
          proof, not from us. Open any one and check it yourself.
        </p>
      </header>

      {state === "loading" && (
        <div className="flex flex-col items-center gap-4 py-24">
          <QuarterLoader size={36} label="Loading receipts" />
          <p className="label">Loading receipts</p>
        </div>
      )}

      {state === "error" && (
        <div className="panel">
          <ErrorState
            title="Keeper API unreachable"
            retry={() => { setState("loading"); void load(); }}
          />
        </div>
      )}

      {state === "ready" && receipts.length === 0 && (
        <div className="panel">
          <EmptyState
            title="No receipts yet"
            hint="Receipts appear the moment a match ends and its proof lands on-chain."
          />
        </div>
      )}

      {state === "ready" && receipts.length > 0 && summary && (
        <>
          <Reveal delay={0.09}>
            <div className="panel mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 p-6">
              <span className="display text-[clamp(40px,6vw,64px)] leading-none text-brass-500">
                <Counter to={summary.total} />
              </span>
              <span className="text-[14px] text-ink-100">
                receipts across {summary.byType.length} market types ·{" "}
                {summary.fixturesCovered} matches
              </span>
              <span className="ml-auto text-[12px] text-ink-400">
                Every one settled by a real TxLINE merkle proof. Zero fabricated.
              </span>
            </div>
          </Reveal>

          {/* the headline stat, and the filter */}
          <Reveal delay={0.14}>
            <div className="mb-10 flex flex-wrap gap-1.5">
              <button
                onClick={() => setTypeFilter(null)}
                className="border px-2.5 py-1.5 font-mono text-[11px] transition-colors"
                style={{
                  borderColor: typeFilter === null ? "var(--brass-600)" : "var(--color-hairline)",
                  color: typeFilter === null ? "var(--brass-400)" : "var(--color-ink-400)",
                }}
              >
                All · {summary.total}
              </button>
              {summary.byType.map((t) => (
                <button
                  key={t.marketType}
                  onClick={() =>
                    setTypeFilter(typeFilter === t.marketType ? null : t.marketType)
                  }
                  className="border px-2.5 py-1.5 font-mono text-[11px] transition-colors"
                  style={{
                    borderColor:
                      typeFilter === t.marketType
                        ? "var(--brass-600)"
                        : "var(--color-hairline)",
                    color:
                      typeFilter === t.marketType
                        ? "var(--brass-400)"
                        : "var(--color-ink-400)",
                  }}
                  title={t.name}
                >
                  {t.parlay && <span className="mr-1 text-brass-500">⚡</span>}
                  {t.name} · {t.count}
                </button>
              ))}
            </div>
          </Reveal>

          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {byFixture.map(([fid, list], i) => (
              <StaggerItem key={fid} i={Math.min(i, 24)} base={0.22}>
                <FixturePanel receipts={list} />
              </StaggerItem>
            ))}
          </div>

          {gaps.length > 0 && (
            <section className="mt-16">
              <div className="mb-4 flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 bg-ink-600"
                  style={{ borderRadius: "0 0 0 6px" }}
                />
                <h2 className="label !text-[12px]">No receipt · and we won&apos;t pretend otherwise</h2>
                <span className="rule flex-1" />
              </div>
              <p className="mb-5 max-w-2xl text-[13px] text-ink-400">
                These {gaps.length} matches were played, but they fall outside the window
                where TxLINE still keeps the data needed to prove them. We could show you
                a scoreline. We could even mint a receipt. Both would be made up, so we
                do neither.
              </p>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {gaps.map((m) => {
                  const [home, away] = teamsForFixture(m.fixtureId, m.fixtureName, m.home, m.away);
                  return (
                    <li
                      key={m.fixtureId}
                      className="flex items-center justify-between gap-3 border border-dashed border-ink-700/70 px-4 py-3"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Flag team={home} size={16} />
                        <span className="text-[12px] text-ink-300">{home.code}</span>
                        <span className="text-[11px] text-ink-600">v</span>
                        <Flag team={away} size={16} />
                        <span className="text-[12px] text-ink-300">{away.code}</span>
                      </div>
                      <span className="label !text-[10px] shrink-0">Unprovable</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
