import { EventEmitter } from "events";
import * as fs from "fs";

import { Logger } from "../logger";
import { normalizeUpdate, ScoreUpdate } from "./client";

/**
 * A recorded TxLINE fixture, captured with `keeper capture <fixtureId>`.
 * `events` are the raw score updates in feed order; `realProof` is the actual
 * /scores/stat-validation response for the finalised record — the same bytes
 * that settled the market on devnet.
 */
export interface ReplayFixture {
  fixtureId: number;
  name?: string;
  capturedAt?: string;
  finalisedSeq: number;
  finalScore: { p1: number; p2: number };
  finalisedTsMs: number;
  events: any[];
  realProof?: { request: { seq: number; statKeys: string }; response: any };
  provenance?: any;
}

export function loadReplayFixture(file: string): ReplayFixture {
  const fx = JSON.parse(fs.readFileSync(file, "utf8")) as ReplayFixture;
  if (!fx.fixtureId || !Array.isArray(fx.events) || !fx.events.length) {
    throw new Error(`invalid replay fixture: ${file}`);
  }
  return fx;
}

/**
 * Replays a recorded feed through the same pipeline as the live SSE stream,
 * with time compression: gap_i = min((ts_i − ts_{i−1}) / speed, maxGapMs).
 * A full match replays in ~60–90 seconds at the defaults.
 */
export class ReplayFeed extends EventEmitter {
  private log = new Logger("replay");
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private fixture: ReplayFixture,
    private speed: number,
    private maxGapMs: number
  ) {
    super();
  }

  start() {
    const events = [...this.fixture.events].sort(
      (a, b) => (a.Ts ?? a.ts ?? 0) - (b.Ts ?? b.ts ?? 0) || (a.Seq ?? a.seq ?? 0) - (b.Seq ?? b.seq ?? 0)
    );
    this.log.info("replay starting", {
      fixture: this.fixture.fixtureId,
      events: events.length,
      speed: `${this.speed}x`,
      maxGapMs: this.maxGapMs,
    });

    let i = 0;
    const step = () => {
      if (this.stopped) return;
      if (i >= events.length) {
        this.log.info("replay complete");
        this.emit("end");
        return;
      }
      const raw = events[i];
      const u = normalizeUpdate(raw);
      if (u) {
        this.log.info("event", {
          fixture: u.fixtureId, seq: u.seq, status: u.statusId,
          score: u.score ? `${u.score.p1 ?? "?"}-${u.score.p2 ?? "?"}` : undefined,
        });
        this.emit("update", u satisfies ScoreUpdate);
      }
      const prevTs = raw.Ts ?? raw.ts ?? 0;
      i += 1;
      const nextTs = i < events.length ? events[i].Ts ?? events[i].ts ?? prevTs : prevTs;
      const gap = Math.max(0, Math.min((nextTs - prevTs) / this.speed, this.maxGapMs));
      this.timer = setTimeout(step, gap);
    };
    step();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
