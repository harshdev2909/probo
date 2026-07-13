"use client";

/**
 * The autonomy feed: keeper log events streamed live, styled like a broadcast
 * wire rather than a raw dump. The settle line lands in brass.
 *
 * The wire is a TAIL, not a log. It renders events as they arrive over SSE and it
 * keeps no history, which is correct for the keeper page and quietly wrong on a
 * market page: a match that settled last week emits nothing today, so the panel sat
 * there saying "match day is quiet" under a market whose whole story was already
 * over. The keeper had done the work. We simply were not showing it.
 *
 * So when a market is passed in, the wire opens with that market's RECORDED history
 * before it starts tailing. Every recorded line is backed by a real transaction
 * signature that the program wrote (created, locked, settled, cancelled). Nothing
 * here is reconstructed or guessed: if we hold no transaction for a step, we print
 * no line for it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketView } from "@/lib/api";
import { useStreamEvent, useStreamStatus, type LogEvent } from "@/lib/stream";

const MAX = 120;

function lineColor(e: LogEvent): string {
  if (e.msg.startsWith("SETTLED")) return "text-brass-400";
  if (e.msg.includes("PROOF RECEIPT")) return "text-brass-400";
  if (e.level === "error") return "text-oxide-400";
  if (e.level === "warn") return "text-amber-400";
  if (e.component.includes("replay") || e.component.includes("sse")) return "text-ink-400";
  return "text-ink-300";
}

/** A recorded line, and the transaction that proves it happened. */
interface PastLine {
  label: string;
  tx: string | null;
  brass?: boolean;
  detail?: string;
}

/**
 * The market's story so far, told only from what the chain recorded.
 *
 * Deliberately not timestamped. The API gives us the signatures, not the block
 * times, and a plausible looking clock we invented would be exactly the kind of
 * decoration this product exists to refuse.
 */
function recordedHistory(m: MarketView): PastLine[] {
  const out: PastLine[] = [];

  out.push({
    label: `market opened · ${m.marketName}`,
    tx: m.txs.created,
  });

  if (m.txs.locked) {
    out.push({ label: "locked at kickoff · no more bets", tx: m.txs.locked });
  }

  if (m.status === "settled" && m.txs.settled) {
    const won =
      m.winningOutcome !== null ? m.outcomes[m.winningOutcome] ?? `outcome ${m.winningOutcome}` : null;
    const score = m.live?.score ? `${m.live.score.p1}–${m.live.score.p2}` : null;
    out.push({
      label: `SETTLED by TxLINE merkle proof${won ? ` · ${won}` : ""}`,
      detail: score ? `proven scoreline ${score}` : undefined,
      tx: m.txs.settled,
      brass: true,
    });
    out.push({
      label: "PROOF RECEIPT written on chain · payouts open",
      tx: null,
      brass: true,
    });
  }

  if (m.status === "cancelled" && m.txs.cancelled) {
    out.push({
      label: "cancelled · no winner claimed, refunds open",
      tx: m.txs.cancelled,
    });
  }

  return out;
}

/** What the wire is waiting for, said precisely instead of vaguely. */
function waitingFor(m?: MarketView): string {
  if (!m) {
    return "Match day is quiet right now. The moment a game kicks off, every score, lock and payout shows up here, live.";
  }
  if (m.status === "open") {
    return "Nothing has happened to this market yet. It locks itself at kickoff, and from then on every score, lock and payout lands here live.";
  }
  if (m.status === "locked") {
    return "Locked and waiting on TxLINE. The moment the match finalises, the keeper fetches the proof and settles it here, unattended.";
  }
  return "This market is already resolved. Its history is above; the wire below stays live for anything still to come.";
}

export function Ticker({
  tall = false,
  market,
}: {
  tall?: boolean;
  /** When given, the wire opens with this market's recorded history. */
  market?: MarketView;
}) {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const status = useStreamStatus();
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const past = useMemo(() => (market ? recordedHistory(market) : []), [market]);

  useStreamEvent<LogEvent>("log", (e) => {
    // consumer wire: only the match story, not internal plumbing
    const interesting =
      /SETTLED|PROOF RECEIPT|market|lock|bet|goal|finalised|kick|score|cancel|refund|settle/i.test(
        e.msg + e.component
      ) && !/store|chain ready|api|sweep|typecheck/i.test(e.component);
    if (!interesting) return;
    // On a market page, only this market's story belongs on the wire.
    if (market && e.fields?.market && e.fields.market !== market.marketPda) return;
    setLines((prev) => [...prev.slice(-MAX + 1), e]);
  });

  useEffect(() => {
    if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  const empty = past.length === 0 && lines.length === 0;

  return (
    <section
      className="overflow-hidden border border-hairline bg-ink-900"
      style={{ borderRadius: "0 0 0 var(--r-quarter)" }}
      aria-label="Keeper live activity"
    >
      <header className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <span className="label">Keeper wire · runs itself</span>
        <span
          className={`font-mono text-[10px] uppercase ${
            status === "live" ? "text-pitch-400" : "text-oxide-400"
          }`}
        >
          {status === "live" ? "● receiving" : "○ waiting for keeper"}
        </span>
      </header>

      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={`overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-[1.75] ${
          tall ? "h-[480px]" : "h-56"
        }`}
        role="log"
        aria-live="polite"
      >
        {/* what the chain recorded, before the tail begins */}
        {past.length > 0 && (
          <>
            <p className="mb-1 text-[10px] uppercase tracking-[0.1em] text-ink-600">
              recorded on chain
            </p>
            {past.map((p, i) => (
              <p key={i} className={`${p.brass ? "text-brass-400" : "text-ink-300"} break-words`}>
                <span className="text-ink-600">·</span> {p.label}
                {p.detail ? <span className="text-ink-500"> · {p.detail}</span> : null}
                {p.tx ? <span className="text-ink-600"> {p.tx.slice(0, 20)}…</span> : null}
              </p>
            ))}
            <p className="mb-1 mt-3 text-[10px] uppercase tracking-[0.1em] text-ink-600">
              live
            </p>
          </>
        )}

        {empty ? (
          <p className="text-ink-500">{waitingFor(market)}</p>
        ) : lines.length === 0 ? (
          <p className="text-ink-500">{waitingFor(market)}</p>
        ) : (
          lines.map((e, i) => (
            <p key={i} className={`${lineColor(e)} break-words`}>
              <span className="text-ink-500">{e.ts.slice(11, 19)}</span>{" "}
              <span className="text-ink-400">[{e.component}]</span> {e.msg}
              {e.fields?.tx ? (
                <span className="text-ink-500"> {String(e.fields.tx).slice(0, 20)}…</span>
              ) : null}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
