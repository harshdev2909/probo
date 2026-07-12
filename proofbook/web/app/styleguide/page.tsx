"use client";

import { useReducer } from "react";
import { Mark, Wordmark } from "@/components/Mark";
import { Seal } from "@/components/Seal";
import { Receipt } from "@/components/Receipt";
import { TeamChip, QuarterLoader, EmptyState, ErrorState, Hash } from "@/components/primitives";

/* The real, devnet-proven settlement. the styleguide mock uses live data. */
const REAL_RECEIPT = {
  matchId: 18193785,
  homeCode: "MEX",
  awayCode: "USA",
  finalScore: { home: 1, away: 4 },
  outcomeLabel: "Away win",
  statKeys: "1, 2",
  period: 100,
  epochDay: 20641,
  dailyRootsPda: "GRJBcG6G9CnvvNZPQagxietR7caFtAG8sFRZ2mg5n8QZ",
  proofRef: "4730ab15daff7602980c6fcf464e5619f4dcf325cb5ce9c9973ab0e5be1cacfe",
  resolver: "8Hfn9BsxYgaxJoDk3sDBBEZ65H79oTMYo7mkLSjhFzH1",
  settleTx: "3GptFFBGbZpkSezLx3aTbNHome6gSjKEywiqoKfRsgujwFbTHnJuBVD4NdmLzGsR6DfqvkBiWoEW6XRsNNDNXAoP",
  oracleProgram: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  settledAtIso: "2026-07-07T11:04:12Z · Solana devnet",
  specimen: true,
};

const INKS = [
  ["ink-950", "#0f0d0a", "page"],
  ["ink-900", "#16130f", "panel"],
  ["ink-800", "#211d17", "raised / hover"],
  ["ink-700", "#332c23", "strong border"],
  ["ink-500", "#6f6455", "muted (large)"],
  ["ink-400", "#968878", "secondary text"],
  ["ink-300", "#b6a996", "labels"],
  ["ink-200", "#d8cfc0", "body"],
  ["ink-100", "#f2ede3", "bone / primary"],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="rule py-12 first:border-t-0">
      <div className="mb-8 flex items-baseline gap-4">
        <span aria-hidden className="h-3 w-3 bg-brass-500" style={{ borderRadius: "0 0 0 8px" }} />
        <h2 className="display text-[24px] text-ink-100">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export default function Styleguide() {
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pb-32 pt-10 lg:px-10">
      {/* masthead */}
      <header className="flex flex-wrap items-end justify-between gap-6 pb-10">
        <div>
          <Wordmark />
          <h1 className="display mt-6 max-w-xl text-[clamp(34px,6vw,61px)] text-ink-100">
            Design<br />foundation
          </h1>
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-ink-400">
            Squares and quarter-circles. Ink and bone. One metal, earned. Every token,
            component and state in the system. nothing on a page that isn&apos;t on this one.
          </p>
        </div>
        <p className="label">v1 · stadium-at-night</p>
      </header>

      {/* ── THE MARK ── */}
      <Section id="mark" title="The mark">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="panel flex flex-col items-center gap-4 p-10">
            <Mark size={64} />
            <p className="label">The ball leaves the ledger</p>
          </div>
          <div className="panel flex flex-col items-center justify-center gap-4 p-10">
            <Wordmark />
            <p className="label">Wordmark</p>
          </div>
          <div className="panel flex flex-col items-center gap-4 p-10">
            <Seal size={96} state="verified" />
            <p className="label">The seal · brass&apos;s hero moment</p>
          </div>
        </div>
      </Section>

      {/* ── PALETTE ── */}
      <Section id="palette" title="Palette">
        <p className="label mb-4">Ink ramp · 9 steps, warm, never pure black or white</p>
        <div className="grid grid-cols-3 gap-px overflow-hidden border border-hairline sm:grid-cols-9" style={{ borderRadius: "0 0 0 24px" }}>
          {INKS.map(([name, hex, role]) => (
            <div key={name} className="flex h-28 flex-col justify-end p-2.5" style={{ background: hex }}>
              <p className={`font-mono text-[10px] ${["ink-950","ink-900","ink-800","ink-700"].includes(name) ? "text-ink-400" : "text-ink-950"}`}>
                {name}<br />{hex}<br /><span className="opacity-70">{role}</span>
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <div>
            <p className="label mb-4">Brass. verified proofs, winnings, the mark. Nowhere else.</p>
            <div className="flex gap-px overflow-hidden border border-hairline" style={{ borderRadius: "0 0 0 16px" }}>
              {[["brass-400", "#dcbc7a"], ["brass-500", "#c2a05a"], ["brass-600", "#96762f"], ["brass-950", "#241c0d"]].map(([n, h]) => (
                <div key={n} className="flex h-20 flex-1 flex-col justify-end p-2.5" style={{ background: h }}>
                  <p className={`font-mono text-[10px] ${n === "brass-950" ? "text-brass-400" : "text-ink-950"}`}>{n}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="label mb-4">Semantics. live, loss, pending. Host nations as chips only.</p>
            <div className="flex flex-wrap items-center gap-5">
              <span className="inline-flex items-center gap-2 text-[13px] text-pitch-400">
                <span className="live-dot" /> LIVE 74′
              </span>
              <span className="text-[13px] text-oxide-400 tnum">−240.00</span>
              <span className="text-[13px] text-amber-400">Awaiting root…</span>
              <TeamChip code="CAN" name="Canada" />
              <TeamChip code="MEX" name="Mexico" />
              <TeamChip code="USA" name="United States" />
            </div>
          </div>
        </div>
      </Section>

      {/* ── TYPE ── */}
      <Section id="type" title="Type">
        <div className="space-y-7">
          <div>
            <p className="label mb-2">Display · Archivo wdth 125 / 800. headlines, scores</p>
            <p className="display text-[clamp(40px,7vw,76px)] text-ink-100">Proven, not trusted</p>
          </div>
          <div>
            <p className="label mb-2">Display condensed · wdth 78 / 700. fixtures, tickers</p>
            <p className="display-condensed text-[31px] text-ink-200">Quarter-final · Estadio Azteca · Group F leaders</p>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <p className="label mb-2">UI sans · Archivo 400–600. body, controls</p>
              <p className="max-w-sm text-[14px] leading-relaxed text-ink-200">
                Settlement is a cross-program invocation, not a committee. When the oracle
                publishes the daily Merkle root, anyone can prove the final score. so the
                program lets no one <em className="not-italic text-ink-100">assert</em> it.
              </p>
            </div>
            <div>
              <p className="label mb-2">Mono · IBM Plex. every hash, sig, key, numeral</p>
              <p className="font-mono text-[13px] leading-relaxed text-ink-300">
                statKeys=1,2 @ period=100<br />
                epochDay=20641<br />
                <Hash value={REAL_RECEIPT.settleTx} head={16} tail={12} />
              </p>
              <p className="tnum mt-3 font-mono text-[25px] text-ink-100">
                2<span className="text-ink-500">–</span>1&nbsp;&nbsp;
                <span className="text-pitch-400">×2.38</span>&nbsp;&nbsp;
                <span className="text-ink-300">$1,284.50</span>
              </p>
            </div>
          </div>
          <p className="font-mono text-[11px] text-ink-500">
            Scale 12 / 13 / 14 / 16 / 20 / 25 / 31 / 39 / 61 / 76. tabular-nums on all numerals.
          </p>
        </div>
      </Section>

      {/* ── GRID & SURFACE ── */}
      <Section id="grid" title="Grid & surface">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="panel p-6">
            <p className="label mb-3">Panel</p>
            <p className="text-[13px] text-ink-400">Flat ink-900, hairline border, one quarter-circle corner. The signature surface.</p>
          </div>
          <div className="panel-raised p-6">
            <p className="label mb-3">Raised</p>
            <p className="text-[13px] text-ink-400">One step up the ramp. elevation is background, never shadow.</p>
          </div>
          <div className="flex flex-col gap-3 p-6">
            <p className="label">Radius family</p>
            <div className="flex items-end gap-3">
              {[["2", "chip"], ["8", "control"], ["24", "quarter"], ["48", "hero"]].map(([r, n]) => (
                <div key={n} className="flex flex-col items-center gap-2">
                  <span className="block h-12 w-12 border border-hairline-strong bg-ink-800" style={{ borderRadius: `0 0 0 ${r}px` }} />
                  <span className="font-mono text-[10px] text-ink-500">{r}</span>
                </div>
              ))}
            </div>
            <p className="text-[13px] text-ink-400">All radii live in the bottom-left. the arc always lands the same way.</p>
          </div>
        </div>
      </Section>

      {/* ── MOTION ── */}
      <Section id="motion" title="Motion">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="panel p-6">
            <p className="label mb-4">settle · 240ms. data ticks</p>
            <button
              onClick={bump}
              className="display tnum w-full py-4 text-left text-[39px] text-ink-100 transition-colors hover:text-brass-400"
              aria-label="Replay score tick"
            >
              <span key={tick} className="tick-up inline-block">{2 + (tick % 2)}</span>
              <span className="text-ink-500">–</span>1
              <span className="mt-1 block text-[11px] font-normal normal-case tracking-[0.14em] text-ink-500">click to replay</span>
            </button>
          </div>
          <div className="panel p-6">
            <p className="label mb-4">carry · loader & live pulse</p>
            <div className="flex items-center gap-8 py-4">
              <QuarterLoader size={32} />
              <span className="inline-flex items-center gap-2 text-[13px] text-pitch-400"><span className="live-dot" /> live</span>
            </div>
            <p className="mt-2 text-[12px] text-ink-500">cubic-bezier(.65,0,.35,1)</p>
          </div>
          <div className="panel p-6">
            <p className="label mb-4">Rules</p>
            <ul className="space-y-2 text-[13px] leading-snug text-ink-400">
              <li>· Motion = weight & momentum. No bounce, no glow.</li>
              <li>· Entrances 420ms, exits faster.</li>
              <li>· One hero move per view (the seal).</li>
              <li>· prefers-reduced-motion: everything lands instantly.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── STATES ── */}
      <Section id="states" title="States">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="panel"><EmptyState title="No markets yet" hint="The keeper opens markets when fixtures are announced. Nothing to do. that's the point." /></div>
          <div className="panel"><ErrorState title="Feed unreachable" retry={() => {}} /></div>
          <div className="panel flex flex-col items-center justify-center gap-4 py-16">
            <QuarterLoader size={36} label="Loading markets" />
            <p className="label">Loading markets</p>
          </div>
        </div>
      </Section>

      {/* ── THE RECEIPT ── */}
      <Section id="receipt" title="Proof receipt. the artifact">
        <p className="mb-8 max-w-lg text-[14px] leading-relaxed text-ink-400">
          Real data: this is the actual devnet settlement of fixture 18193785, settled by CPI
          into TxLINE&apos;s validate_stat_v2. Press <span className="text-ink-200">Verify</span> to
          re-check the proof and watch the seal take.
        </p>
        <Receipt data={REAL_RECEIPT} />
      </Section>
    </main>
  );
}
