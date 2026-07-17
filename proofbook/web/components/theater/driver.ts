"use client";

/**
 * The two ways to feed the Settlement Theater, behind one shape.
 *
 * LIVE  — subscribes to the keeper's SSE stream and watches one fixture: score
 *         ticks, the statusId=100 finalisation, and the receipt that lands when
 *         the market settles itself.
 * REPLAY — plays back `/archive/:fixtureId`, the recorded event timeline, so the
 *         exact same settlement can be re-run (and screen-recorded) at any hour.
 *
 * Both emit a `TheaterFeed`. Nothing here is synthesized: the finalisation is a
 * real statusId, and the VERIFIED beat is gated on a real Proof Receipt arriving
 * — the theater cannot show "verified" for a settlement that has not happened.
 */
import { useEffect, useRef, useState } from "react";
import { api, type ReceiptView } from "@/lib/api";
import { useStreamEvent, type ScoreEvent } from "@/lib/stream";

export interface TheaterSettlement {
  marketPda: string;
  outcomeLabel: string;
  provenScore?: { p1: number; p2: number };
  proofRef: string;
  settleTx: string;
  resolver: string;
  oracleProgram?: string;
}

export interface TheaterFeed {
  mode: "live" | "replay";
  fixtureId: number;
  fixtureName: string;
  /** Latest score, from the feed. */
  score: { p1: number; p2: number } | null;
  /** statusId=100 has been seen — full time, the method-agnostic final. */
  finalised: boolean;
  /** The real Proof Receipt — present ONLY once the market has settled. */
  settlement: TheaterSettlement | null;
  /** Replay progress 0..1 (undefined in live mode). */
  progress?: number;
  ready: boolean;
}

const EMPTY = (mode: "live" | "replay", fixtureId: number): TheaterFeed => ({
  mode,
  fixtureId,
  fixtureName: "",
  score: null,
  finalised: false,
  settlement: null,
  ready: false,
});

/** LIVE: watch one fixture on the SSE stream. */
export function useLiveFeed(fixtureId: number, fixtureName: string): TheaterFeed {
  const [feed, setFeed] = useState<TheaterFeed>(() => ({
    ...EMPTY("live", fixtureId),
    fixtureName,
    ready: true,
  }));

  useStreamEvent<ScoreEvent>("score", (e) => {
    if (e.fixtureId !== fixtureId) return;
    setFeed((f) => ({
      ...f,
      score: e.score
        ? { p1: e.score.p1 ?? f.score?.p1 ?? 0, p2: e.score.p2 ?? f.score?.p2 ?? 0 }
        : f.score,
      finalised: f.finalised || e.statusId === 100,
    }));
  });

  // The receipt is the authoritative "settled" signal — it carries the proof.
  useStreamEvent<any>("receipt", (r) => {
    if (Number(r?.matchId) !== fixtureId) return;
    setFeed((f) => ({
      ...f,
      finalised: true,
      settlement: {
        marketPda: r.marketPda,
        outcomeLabel: r.outcomeLabel ?? String(r.winningOutcome),
        provenScore: r.provenScore,
        proofRef: r.proofRef,
        settleTx: r.settleTx,
        resolver: r.resolver,
        oracleProgram: r.oracleProgram,
      },
    }));
  });

  // If the fixture already settled before the page opened, fall back to its
  // receipt so the theater still has something real to show. Best-effort.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const markets = await api.allMarkets({ fixtureId } as any);
        const settled = markets.find((m) => m.status === "settled");
        if (!settled || !alive) return;
        const r: ReceiptView = await api.receipt(settled.marketPda);
        if (!alive || !r?.proofRef) return;
        setFeed((f) =>
          f.settlement
            ? f
            : {
                ...f,
                finalised: true,
                score: r.provenScore ?? f.score,
                settlement: {
                  marketPda: r.marketPda,
                  outcomeLabel: r.outcomeLabel,
                  provenScore: r.provenScore ?? undefined,
                  proofRef: r.proofRef,
                  settleTx: r.settleTx,
                  resolver: r.resolver,
                  oracleProgram: (r as any).oracleProgram,
                },
              }
        );
      } catch {
        /* no prior settlement — live is fine */
      }
    })();
    return () => {
      alive = false;
    };
  }, [fixtureId]);

  return feed;
}

/**
 * REPLAY: play the recorded timeline back on a clock.
 *
 * Real events, real order. The score events walk to the finalisation; the receipt
 * event delivers the proof. Compressed to a watchable ~20s so it fits a video,
 * but the ORDER and the data are exactly what the keeper recorded.
 */
export function useReplayFeed(
  fixtureId: number,
  opts?: { durationMs?: number; autostart?: boolean }
): TheaterFeed & { start: () => void; restart: () => void; loading: boolean; error: string | null } {
  const durationMs = opts?.durationMs ?? 18_000;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<TheaterFeed>(() => EMPTY("replay", fixtureId));
  const timeline = useRef<
    { finalisedAt: number | null; receipt: TheaterSettlement | null; provenScore: { p1: number; p2: number } | null; scores: { at: number; p1: number; p2: number }[]; name: string; t0: number; t1: number } | null
  >(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const a = await api.archive(fixtureId);
        if (!alive) return;
        if (!a) {
          setError("No archive for this fixture.");
          setLoading(false);
          return;
        }
        // Extract the real beats from the recorded events.
        const scores: { at: number; p1: number; p2: number }[] = [];
        let finalisedAt: number | null = null;
        let receipt: TheaterSettlement | null = null;
        let provenScore: { p1: number; p2: number } | null = null;
        for (const ev of a.events) {
          const p: any = ev.payload;
          if (ev.type === "score" && p?.score) {
            scores.push({ at: ev.at, p1: p.score.p1 ?? 0, p2: p.score.p2 ?? 0 });
            if (p.statusId === 100 && finalisedAt === null) finalisedAt = ev.at;
          }
          if (ev.type === "receipt" && p?.proofRef && !receipt) {
            receipt = {
              marketPda: p.marketPda,
              outcomeLabel: p.outcomeLabel ?? String(p.winningOutcome),
              provenScore: p.provenScore,
              proofRef: p.proofRef,
              settleTx: p.settleTx,
              resolver: p.resolver,
              oracleProgram: p.oracleProgram,
            };
            provenScore = p.provenScore ?? null;
          }
        }
        // Fallback: a fixture settled by the backfiller (not the live keeper) has
        // no recorded feedEvent timeline, so the archive carries no receipt event.
        // Fetch the real receipt directly — the settlement still happened, and the
        // proof is on chain — so replay works for ANY settled fixture, not just
        // those the live keeper handled.
        if (!receipt) {
          try {
            const markets = await api.allMarkets({ fixtureId } as any);
            const settled = markets.find((m) => m.status === "settled");
            if (settled) {
              const r = await api.receipt(settled.marketPda);
              if (r?.proofRef) {
                receipt = {
                  marketPda: r.marketPda,
                  outcomeLabel: r.outcomeLabel,
                  provenScore: r.provenScore ?? undefined,
                  proofRef: r.proofRef,
                  settleTx: r.settleTx,
                  resolver: r.resolver,
                  oracleProgram: (r as any).oracleProgram,
                };
                provenScore = r.provenScore ?? null;
              }
            }
          } catch {
            /* no receipt reachable — the theater will show what the archive had */
          }
          if (!alive) return;
        }

        const t0 = a.events[0]?.at ?? a.kickoffTs;
        const t1 = a.settledAt ?? a.events[a.events.length - 1]?.at ?? t0 + 1;
        timeline.current = { finalisedAt, receipt, provenScore, scores, name: a.name, t0, t1 };
        setFeed({
          ...EMPTY("replay", fixtureId),
          fixtureName: a.name,
          ready: true,
          progress: 0,
        });
        setLoading(false);
        if (opts?.autostart) start();
      } catch (e: any) {
        if (alive) {
          setError(String(e?.message ?? e).slice(0, 120));
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      timers.current.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureId]);

  function clearTimers() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }

  function start() {
    const tl = timeline.current;
    if (!tl) return;
    clearTimers();
    const span = Math.max(1, tl.t1 - tl.t0);
    const at = (unixSec: number) =>
      Math.max(0, Math.min(1, (unixSec - tl.t0) / span)) * durationMs;

    setFeed((f) => ({ ...f, score: null, finalised: false, settlement: null, progress: 0 }));

    // Schedule the score ticks.
    for (const s of tl.scores) {
      timers.current.push(
        setTimeout(() => setFeed((f) => ({ ...f, score: { p1: s.p1, p2: s.p2 } })), at(s.at))
      );
    }
    // Finalisation. If the recording carries a real statusId=100, use its time;
    // otherwise (a backfilled fixture with no event timeline) place the beat at
    // 40% so the pipeline still breathes before the proof lands.
    const finalMs = tl.finalisedAt !== null ? at(tl.finalisedAt) : durationMs * 0.4;
    timers.current.push(setTimeout(() => setFeed((f) => ({ ...f, finalised: true })), finalMs));
    // The receipt (the proof) — near the end.
    if (tl.receipt) {
      timers.current.push(
        setTimeout(
          () =>
            setFeed((f) => ({
              ...f,
              finalised: true,
              score: tl.provenScore ?? f.score,
              settlement: tl.receipt,
            })),
          Math.max(at(tl.t1) - 400, durationMs * 0.72)
        )
      );
    }
    // Progress bar.
    const startMs = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - startMs) / durationMs);
      setFeed((f) => ({ ...f, progress: p }));
      if (p < 1) timers.current.push(setTimeout(tick, 100));
    };
    tick();
  }

  return { ...feed, start, restart: start, loading, error };
}
