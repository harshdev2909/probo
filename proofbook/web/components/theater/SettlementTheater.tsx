"use client";

/**
 * Settlement Theater — a market settling ITSELF, staged like a broadcast.
 *
 * The pipeline, one beat at a time:
 *   watching → game finalised → proof fetched → validate_stat_v3 CPI →
 *   VERIFIED (gold, the hero beat) → payout unlocked → Proof Receipt.
 *
 * The beats that matter are gated on reality, not a timer: FINALISED needs a real
 * statusId=100, and VERIFIED needs a real Proof Receipt to have landed. The two
 * in-between beats (fetch, CPI) animate in the window between them — that window
 * is exactly when the keeper is doing that work. If the receipt has not arrived,
 * the theater HOLDS at the CPI beat rather than claiming a verification that has
 * not happened.
 *
 * Big, legible, screen-recordable. No human clicks resolve — and it says so.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import type { TheaterFeed } from "./driver";

const STAGES = [
  { key: "watch", title: "Watching the feed", sub: "TxLINE scores streaming over SSE" },
  { key: "final", title: "Game finalised", sub: "statusId 100 — full time, any method" },
  { key: "fetch", title: "Proof fetched", sub: "merkle multiproof for the market's stat keys" },
  { key: "cpi", title: "validate_stat_v3", sub: "CPI into TxLINE's own on-chain oracle" },
  { key: "verified", title: "VERIFIED", sub: "the oracle re-derived the root and returned true" },
  { key: "payout", title: "Payout unlocked", sub: "parimutuel pool opened for claims" },
  { key: "receipt", title: "Proof Receipt", sub: "written on-chain — the settlement is the record" },
] as const;

const V = STAGES.findIndex((s) => s.key === "verified");

/** Beat dwell (ms) once the sequence is armed. VERIFIED lingers. */
const DWELL = [0, 1500, 1600, 1800, 2600, 1500, 0];

export function SettlementTheater({
  feed,
  onReplayEnd,
}: {
  feed: TheaterFeed;
  onReplayEnd?: () => void;
}) {
  // The furthest beat reality allows: FINALISED gates beats >= 1; a settled
  // receipt gates VERIFIED and beyond.
  const cap = feed.settlement
    ? STAGES.length - 1
    : feed.finalised
      ? V - 1 // may fetch + reach the CPI, then HOLD until the receipt lands
      : 0;

  const [stage, setStage] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    if (stage >= cap) {
      if (feed.settlement && stage === STAGES.length - 1) onReplayEnd?.();
      return;
    }
    timer.current = setTimeout(() => setStage((s) => Math.min(s + 1, cap)), DWELL[stage + 1] ?? 1500);
    return () => clearTimeout(timer.current);
  }, [stage, cap, feed.settlement, onReplayEnd]);

  // If a fresh feed rewinds (replay restart), rewind the stage too.
  useEffect(() => {
    if (!feed.finalised && !feed.settlement) setStage(0);
  }, [feed.finalised, feed.settlement]);

  const s = feed.settlement;
  const reached = (i: number) => stage >= i;
  const verified = reached(V);

  return (
    <div className="relative mx-auto flex min-h-[80vh] w-full max-w-5xl flex-col justify-center px-6 py-10">
      {/* header: which match, and the standing truth */}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label text-brass-500">
            {feed.mode === "replay" ? "Replay · recorded settlement" : "Live · settles itself"}
          </p>
          <h1 className="display mt-1 text-[clamp(28px,4.4vw,52px)] leading-none text-ink-100">
            {feed.fixtureName || "…"}
          </h1>
        </div>
        <div className="text-right">
          {feed.score && (
            <div className="tnum font-mono text-[clamp(30px,5vw,60px)] leading-none text-ink-100">
              {feed.score.p1}<span className="text-ink-600"> – </span>{feed.score.p2}
            </div>
          )}
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-oxide-400">
            no human clicked resolve
          </p>
        </div>
      </div>

      {/* the pipeline */}
      <ol className="relative space-y-1.5">
        {STAGES.map((st, i) => {
          const isVerified = st.key === "verified";
          const done = reached(i);
          const active = stage === i && done;
          return (
            <li key={st.key}>
              <motion.div
                initial={false}
                animate={{
                  opacity: done ? 1 : 0.3,
                  scale: active ? 1 : 1,
                }}
                transition={{ duration: 0.35 }}
                className={`relative flex items-center gap-4 border px-5 py-4 transition-colors duration-500 ${
                  isVerified && verified
                    ? "border-brass-500 bg-brass-500/10"
                    : done
                      ? "border-hairline-strong"
                      : "border-hairline"
                }`}
                style={
                  isVerified && verified
                    ? { boxShadow: "0 0 0 1px var(--brass-500), 0 0 40px -8px var(--brass-500)" }
                    : undefined
                }
              >
                {/* node */}
                <span
                  className="relative flex h-8 w-8 shrink-0 items-center justify-center font-mono text-[12px]"
                  aria-hidden
                >
                  <span
                    className={`absolute inset-0 transition-colors duration-500 ${
                      isVerified && verified
                        ? "bg-brass-500"
                        : done
                          ? "bg-ink-300"
                          : "border border-hairline-strong"
                    }`}
                    style={{ borderRadius: "0 0 0 8px" }}
                  />
                  <span
                    className={`relative ${
                      isVerified && verified ? "text-ink-950" : done ? "text-ink-950" : "text-ink-600"
                    }`}
                  >
                    {done ? (isVerified ? "✓" : i + 1) : i + 1}
                  </span>
                  {active && !verified && (
                    <motion.span
                      className="absolute inset-0 border border-brass-500"
                      style={{ borderRadius: "0 0 0 8px" }}
                      animate={{ opacity: [0.8, 0], scale: [1, 1.6] }}
                      transition={{ duration: 1.1, repeat: Infinity }}
                    />
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <p
                    className={`font-mono uppercase tracking-[0.1em] transition-colors duration-500 ${
                      isVerified
                        ? `text-[clamp(15px,2vw,22px)] font-bold ${verified ? "text-brass-400" : "text-ink-500"}`
                        : `text-[13px] ${done ? "text-ink-100" : "text-ink-600"}`
                    }`}
                  >
                    {st.title}
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-500">{st.sub}</p>
                </div>

                {/* the CPI hold state, made explicit */}
                {st.key === "cpi" && stage === i && !feed.settlement && (
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-400">
                    awaiting oracle…
                  </span>
                )}
                {isVerified && verified && (
                  <motion.span
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="shrink-0 font-mono text-[11px] uppercase tracking-[0.16em] text-brass-400"
                  >
                    trustless ✓
                  </motion.span>
                )}
              </motion.div>
            </li>
          );
        })}
      </ol>

      {/* the receipt payload, revealed with the final beats */}
      <AnimatePresence>
        {s && reached(STAGES.length - 1) && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="panel mt-8 border border-brass-600/40 p-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="label text-brass-500">Proof Receipt</p>
              <span className="font-mono text-[11px] text-ink-200">{s.outcomeLabel}</span>
            </div>
            <dl className="mt-3 grid gap-x-8 gap-y-2 font-mono text-[11px] sm:grid-cols-2">
              <Row k="proven score" v={s.provenScore ? `${s.provenScore.p1}–${s.provenScore.p2}` : "—"} />
              <Row k="proof ref" v={`${s.proofRef.slice(0, 20)}…`} />
              <Row k="settle tx" v={`${s.settleTx.slice(0, 20)}…`} />
              <Row k="resolver" v={`${s.resolver.slice(0, 8)}… (not an admin)`} />
            </dl>
            <div className="mt-4 flex flex-wrap gap-3 border-t border-hairline pt-4">
              <Link
                href={`/verify?market=${s.marketPda}`}
                className="label border border-brass-600 px-4 py-2 text-brass-400 transition-colors hover:bg-brass-500 hover:text-ink-950"
              >
                Verify it yourself →
              </Link>
              <Link
                href={`/receipts/${s.marketPda}`}
                className="label border border-hairline-strong px-4 py-2 text-ink-300 transition-colors hover:border-ink-400"
              >
                Open receipt
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* replay progress */}
      {feed.mode === "replay" && feed.progress !== undefined && (
        <div className="mt-8 h-[3px] w-full overflow-hidden bg-ink-900" aria-hidden>
          <div
            className="h-full bg-brass-500"
            style={{ width: `${(feed.progress * 100).toFixed(1)}%`, transition: "width 120ms linear" }}
          />
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-1 last:border-0">
      <dt className="text-ink-600">{k}</dt>
      <dd className="truncate text-ink-200">{v}</dd>
    </div>
  );
}
