"use client";

/**
 * The Receipt Gallery — the product's hero surface.
 *
 * Every tile is a match that settled itself: a real merkle proof from TxLINE,
 * verified on-chain, with a transaction anyone can open on Solscan. Nobody
 * clicked resolve on any of them.
 *
 * Storyboard:
 *   0ms    masthead
 *   90ms   the proof counter counts up
 *   220ms+ receipt tiles stagger in, 40ms apart
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "framer-motion";

import { api, type MarketView } from "@/lib/api";
import { toFixture, type Fixture } from "@/lib/tournament";
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

function ReceiptTile({ f }: { f: Fixture }) {
  const { market: m, home, away, score } = f;
  return (
    <Link
      href={`/receipts/${m.marketPda}`}
      className="panel group relative block p-4 transition-colors hover:border-brass-500/60 focus-visible:ring-2 focus-visible:ring-brass-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="label !text-[10px]">{f.stage}</span>
        <Seal size={18} state="verified" />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Flag team={home} size={18} />
          <span className="truncate text-[13px] text-ink-100">{home.code}</span>
        </div>
        <span className="mono shrink-0 text-[15px] text-ink-100">
          {score ? `${score.p1}–${score.p2}` : "—"}
        </span>
        <div className="flex min-w-0 flex-row-reverse items-center gap-2">
          <Flag team={away} size={18} />
          <span className="truncate text-[13px] text-ink-100">{away.code}</span>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-ink-400 transition-colors group-hover:text-brass-500">
        Proof verified · view receipt
      </p>
    </Link>
  );
}

export default function Receipts() {
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = () =>
    api.allMarkets()
      .then((m) => { setMarkets(m); setState("ready"); })
      .catch(() => setState("error"));

  useEffect(() => { void load(); }, []);

  const { settled, gaps } = useMemo(() => {
    const fx = markets.map(toFixture);
    return {
      settled: fx
        .filter((f) => f.proven)
        .sort((a, b) => (b.market.kickoffTs ?? 0) - (a.market.kickoffTs ?? 0)),
      gaps: fx.filter((f) => f.gap),
    };
  }, [markets]);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pt-12 lg:px-10">
      <PageArt src="/art-receipts.jpg" opacity={0.3} />

      <header className="mb-10">
        <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">Receipts</h1>
        <p className="mt-2 max-w-xl text-[13px] text-ink-400">
          Every match here paid out on its own. The result came from a cryptographic
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

      {state === "ready" && settled.length === 0 && (
        <div className="panel">
          <EmptyState
            title="No receipts yet"
            hint="Receipts appear the moment a match ends and its proof lands on-chain."
          />
        </div>
      )}

      {state === "ready" && settled.length > 0 && (
        <>
          <Reveal delay={0.09}>
            <div className="panel mb-10 flex flex-wrap items-baseline gap-x-4 gap-y-1 p-6">
              <span className="display text-[clamp(40px,6vw,64px)] leading-none text-brass-500">
                <Counter to={settled.length} />
              </span>
              <span className="text-[14px] text-ink-100">
                matches settled by proof
              </span>
              <span className="ml-auto text-[12px] text-ink-400">
                Nobody clicked resolve on any of them.
              </span>
            </div>
          </Reveal>

          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {settled.map((f, i) => (
              <StaggerItem key={f.market.marketPda} i={i} base={0.22}>
                <li>
                  <ReceiptTile f={f} />
                </li>
              </StaggerItem>
            ))}
          </ul>

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
                {gaps.map((f) => (
                  <li
                    key={f.market.marketPda}
                    className="flex items-center justify-between gap-3 border border-dashed border-ink-700/70 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Flag team={f.home} size={16} />
                      <span className="text-[12px] text-ink-300">{f.home.code}</span>
                      <span className="text-[11px] text-ink-600">v</span>
                      <Flag team={f.away} size={16} />
                      <span className="text-[12px] text-ink-300">{f.away.code}</span>
                    </div>
                    <span className="label !text-[10px] shrink-0">Unprovable</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
