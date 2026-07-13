import { EventEmitter } from "events";
import { EventSource } from "eventsource";

import { KeeperConfig } from "../config";
import { Logger } from "../logger";
import { TxLineSession } from "./session";

/**
 * TxLINE's ODDS stream (SSE) — the "sharp" half of Sharp vs Crowd.
 *
 * This is a SECOND TxLINE feed, entirely separate from the scores feed that
 * settles markets. Nothing it carries ever touches a proof, a predicate or a
 * receipt: it is display-only intelligence.
 *
 * It has to be a STREAM, not a poll. `/odds/snapshot/{id}` exposes only a live
 * buffer: it returned two ticks for the semi-final one minute and nothing the
 * next, because the ticks had aged out. Polling it would sample a moving line at
 * random and silently miss most of the movement. The stream delivers every tick
 * as it is published — which on devnet is zero-delay (service level 1 reports
 * samplingIntervalSec = 0 in the on-chain pricing matrix).
 *
 * Mirrors ScoresStream: exponential-backoff reconnect, resume from Last-Event-ID,
 * renew the JWT on 401, and RE-SUBSCRIBE on 403 (renewing a JWT cannot fix a
 * rejected apiToken).
 */
export class OddsStream extends EventEmitter {
  private log = new Logger("txline:odds");
  private es?: EventSource;
  private lastEventId?: string;
  private backoffMs = 1000;
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(private cfg: KeeperConfig, private session: TxLineSession) {
    super();
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.es?.close();
  }

  private connect() {
    if (this.stopped) return;
    const url = `${this.cfg.txlineApi}/api/odds/stream`;
    this.log.info("connecting", { url, resumeFrom: this.lastEventId });

    this.es = new EventSource(url, {
      fetch: async (input: any, init: any) => {
        const attempt = (jwt: string) => {
          const headers: Record<string, string> = {
            ...(init?.headers || {}),
            "Accept-Encoding": "deflate",
            Authorization: `Bearer ${jwt}`,
            "X-Api-Token": this.session.headers()["X-Api-Token"],
          };
          if (this.lastEventId && !("Last-Event-ID" in headers)) {
            headers["Last-Event-ID"] = this.lastEventId;
          }
          return fetch(input, { ...init, headers });
        };
        let res = await attempt(
          this.session.headers().Authorization.replace("Bearer ", "")
        );
        if (res.status === 401) {
          this.log.warn("odds stream 401 — renewing guest JWT");
          res = await attempt(await this.session.renewJwt());
        } else if (res.status === 403) {
          this.log.warn("odds stream 403 — re-subscribing");
          await this.session.subscribeAndActivate();
          res = await attempt(
            this.session.headers().Authorization.replace("Bearer ", "")
          );
        }
        return res;
      },
    });

    this.es.onopen = () => {
      this.log.info("odds stream open");
      this.backoffMs = 1000;
      this.emit("open");
    };

    this.es.onmessage = (event: MessageEvent) => {
      if ((event as any).lastEventId)
        this.lastEventId = (event as any).lastEventId;
      let parsed: any;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // heartbeat
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const r of rows) {
        if (!r?.FixtureId || !Array.isArray(r?.Prices)) continue;
        this.emit("odds", r);
      }
    };

    this.es.onerror = (err: any) => {
      this.log.warn("odds stream drop", {
        message: err?.message || String(err?.code || err),
      });
      this.emit("closed");
      this.es?.close();
      if (this.stopped) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
}
