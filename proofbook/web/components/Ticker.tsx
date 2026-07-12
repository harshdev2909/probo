"use client";

/**
 * The autonomy feed. keeper log events streamed live, styled like a
 * broadcast wire, not a raw dump. The settle line lands in brass.
 */
import { useEffect, useRef, useState } from "react";
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

export function Ticker({ tall = false }: { tall?: boolean }) {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const status = useStreamStatus();
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useStreamEvent<LogEvent>("log", (e) => {
    // consumer wire: only the match story, not internal plumbing
    const interesting =
      /SETTLED|PROOF RECEIPT|market|lock|bet|goal|finalised|kick|score|cancel|refund|settle/i.test(
        e.msg + e.component
      ) && !/store|chain ready|api|sweep|typecheck/i.test(e.component);
    if (!interesting) return;
    setLines((prev) => [...prev.slice(-MAX + 1), e]);
  });

  useEffect(() => {
    if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <section
      className="overflow-hidden border border-hairline bg-ink-900"
      style={{ borderRadius: "0 0 0 var(--r-quarter)" }}
      aria-label="Keeper live activity"
    >
      <header className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <span className="label">Keeper wire · runs itself</span>
        <span className={`font-mono text-[10px] uppercase ${status === "live" ? "text-pitch-400" : "text-oxide-400"}`}>
          {status === "live" ? "● receiving" : "○ waiting for keeper"}
        </span>
      </header>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={`overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-[1.75] ${tall ? "h-[480px]" : "h-56"}`}
        role="log"
        aria-live="polite"
      >
        {lines.length === 0 ? (
          <p className="text-ink-500">
            Match day is quiet right now. The moment a game kicks off, every score, lock and payout shows up here, live. </p>
        ) : (
          lines.map((e, i) => (
            <p key={i} className={`${lineColor(e)} break-words`}>
              <span className="text-ink-500">{e.ts.slice(11, 19)}</span>{" "}
              <span className="text-ink-400">[{e.component}]</span> {e.msg}
              {e.fields?.tx ? <span className="text-ink-500"> {String(e.fields.tx).slice(0, 20)}…</span> : null}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
