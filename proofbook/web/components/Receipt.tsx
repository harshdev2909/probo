"use client";

import { useState } from "react";
import { Mark } from "./Mark";
import { Seal } from "./Seal";
import { Flag } from "./Flag";
import { TEAMS } from "@/lib/teams";

export interface ReceiptData {
  matchId: number;
  homeCode: string;
  awayCode: string;
  finalScore: { home: number; away: number };
  outcomeLabel: string;
  statKeys: string;
  period: number;
  epochDay: number;
  dailyRootsPda: string;
  proofRef: string;
  resolver: string;
  settleTx: string;
  oracleProgram: string;
  settledAtIso: string;
  specimen?: boolean;
}

/** A mono key/value row on the certificate. */
function Field({
  k,
  v,
  expandable = false,
}: {
  k: string;
  v: string;
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const truncated = v.length > 24 && !open;
  const shown = truncated ? `${v.slice(0, 12)}…${v.slice(-8)}` : v;
  return (
    <div className="grid grid-cols-[112px_1fr] items-baseline gap-3 py-[7px]">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a7f6e]">
        {k}
      </span>
      {expandable ? (
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="break-all text-left font-mono text-[12px] leading-relaxed text-[#2b261d] transition-colors duration-150 hover:text-[#96762f]"
          title={open ? "Collapse" : "Expand full value"}
        >
          {shown}
          <span className="ml-1.5 text-[10px] text-[#96762f]">{open ? "−" : "+"}</span>
        </button>
      ) : (
        <span className="break-all font-mono text-[12px] leading-relaxed text-[#2b261d]" title={v}>
          {shown}
        </span>
      )}
    </div>
  );
}

/**
 * THE artifact. Rendered like a physical certificate: bone paper, ticket
 * punch-notches, a perforated fold, and the notary seal. The VERIFY action
 * re-checks the proof and engraves the seal. brass's only hero moment.
 * (Certificate colors are deliberate print-constants, not theme tokens: this
 * surface is "paper", identical in dark and light mode.)
 */
export function Receipt({ data, onVerify }: { data: ReceiptData; onVerify?: () => Promise<boolean> }) {
  const [state, setState] = useState<"idle" | "verifying" | "verified">("idle");

  async function verify() {
    if (state !== "idle") return;
    setState("verifying");
    const ok = onVerify ? await onVerify() : await new Promise<boolean>((r) => setTimeout(() => r(true), 1600));
    setState(ok ? "verified" : "idle");
  }

  return (
    <div className="relative mx-auto w-full max-w-[520px]" style={{ containerType: "inline-size" }}>
      {/* ticket punch-notches (page-colored, biting into the paper) */}
      <span aria-hidden className="absolute -left-3 top-[168px] z-10 h-6 w-6 rounded-full bg-ink-950" />
      <span aria-hidden className="absolute -right-3 top-[168px] z-10 h-6 w-6 rounded-full bg-ink-950" />

      <article
        className="relative overflow-hidden bg-[#f2ede3] text-[#1c1812]"
        style={{ borderRadius: "0 0 0 var(--r-quarter-lg)" }}
        aria-label={`Proof receipt for match ${data.matchId}`}
      >
        {data.specimen && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-[-44px] top-[26px] rotate-45 bg-[#1c1812]/8 px-14 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-[#1c1812]/40"
          >
            Specimen
          </span>
        )}

        {/* header */}
        <header className="flex items-center justify-between px-7 pb-5 pt-6">
          <div className="flex items-center gap-3">
            <Mark size={24} />
            <div>
              <p className="display text-[15px] text-[#1c1812]">Proof Receipt</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8a7f6e]">
                Settled on-chain · no human resolved this
              </p>
            </div>
          </div>
          <p className="font-mono text-[11px] text-[#8a7f6e]">Nº {String(data.matchId).slice(-6)}</p>
        </header>

        <div className="mx-7 border-t border-[#1c1812]/15" />

        {/* fixture + final */}
        <section className="grid grid-cols-[1fr_auto_1fr] items-center px-7 py-6">
          <div className="flex flex-col items-start gap-1.5 justify-self-start">
            <Flag team={TEAMS[data.homeCode] ?? { code: data.homeCode, name: data.homeCode, iso: "" }} size={34} />
            <span className="display-condensed text-[15px] text-[#1c1812]">{data.homeCode}</span>
          </div>
          <div className="text-center">
            <p
              className="display tnum text-[56px] leading-none text-[#1c1812]"
              aria-label={`Final score ${data.finalScore.home} to ${data.finalScore.away}`}
            >
              {data.finalScore.home}
              <span className="mx-2 text-[#8a7f6e]">–</span>
              {data.finalScore.away}
            </p>
            <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#8a7f6e]">
              Full time · finalised
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5 justify-self-end">
            <Flag team={TEAMS[data.awayCode] ?? { code: data.awayCode, name: data.awayCode, iso: "" }} size={34} />
            <span className="display-condensed text-[15px] text-[#1c1812]">{data.awayCode}</span>
          </div>
        </section>

        {/* outcome band */}
        <div className="mx-7 flex items-center justify-between border-y border-[#1c1812]/15 py-3.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8a7f6e]">
            Proven outcome
          </span>
          <span className="display-condensed text-[20px] text-[#96762f]">{data.outcomeLabel}</span>
        </div>

        {/* the cryptographic body */}
        <section className="px-7 py-5">
          <Field k="Stat keys" v={`${data.statKeys} @ period ${data.period} (game_finalised)`} />
          <Field k="Epoch day" v={String(data.epochDay)} />
          <Field k="Daily roots" v={data.dailyRootsPda} expandable />
          <Field k="Proof ref" v={data.proofRef} expandable />
          <Field k="Resolver" v={data.resolver} expandable />
          <Field k="Settle tx" v={data.settleTx} expandable />
          <Field k="Oracle" v={data.oracleProgram} expandable />
        </section>

        {/* perforation */}
        <div className="mx-4 border-t-2 border-dashed border-[#1c1812]/20" />

        {/* stub: seal + verify */}
        <footer className="flex items-center justify-between gap-4 px-7 py-6">
          <div className="max-w-[240px]">
            <p className="text-[12px] leading-snug text-[#57503f]">
              {state === "verified"
                ? "Checked again, straight from the chain. This outcome is mathematics, not testimony."
                : "Anyone can re-check this settlement against the on-chain root. Try it."}
            </p>
            <p className="mt-2 font-mono text-[10px] text-[#8a7f6e]">{data.settledAtIso}</p>
            {state !== "verified" ? (
              <button
                onClick={verify}
                disabled={state === "verifying"}
                className="mt-3 border border-[#1c1812]/30 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1c1812] transition-all duration-150 ease-snap hover:border-[#96762f] hover:text-[#96762f] disabled:opacity-60"
                style={{ borderRadius: "0 0 0 12px" }}
              >
                {state === "verifying" ? "Checking proof…" : "Verify"}
              </button>
            ) : (
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#96762f]">
                ✓ Proof verified
              </p>
            )}
          </div>
          <Seal size={116} state={state} />
        </footer>
      </article>
    </div>
  );
}
