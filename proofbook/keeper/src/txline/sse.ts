import { EventEmitter } from "events";
import { EventSource } from "eventsource";

import { KeeperConfig } from "../config";
import { Logger } from "../logger";
import { TxLineSession } from "./session";
import { normalizeUpdate, ScoreUpdate } from "./client";

/**
 * Live scores SSE ingestion. Emits normalized "update" events.
 * Rock-solid by design: exponential-backoff reconnect (1s → 60s), resumes from
 * the last event id, renews the JWT inline on 401/403, and logs every event.
 */
export class ScoresStream extends EventEmitter {
  private log = new Logger("txline:sse");
  private es?: EventSource;
  private lastEventId?: string;
  private backoffMs = 1000;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private cfg: KeeperConfig, private session: TxLineSession) {
    super();
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.es?.close();
  }

  private connect() {
    if (this.stopped) return;
    const url = `${this.cfg.txlineApi}/api/scores/stream`;
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
        if (res.status === 401 || res.status === 403) {
          this.log.warn(`SSE rejected (${res.status}); renewing JWT`);
          const jwt = await this.session.renewJwt();
          res = await attempt(jwt);
        }
        return res;
      },
    });

    this.es.onopen = () => {
      this.log.info("stream open");
      this.backoffMs = 1000;
    };

    this.es.onmessage = (event: MessageEvent) => {
      if ((event as any).lastEventId)
        this.lastEventId = (event as any).lastEventId;
      let parsed: any;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        this.log.debug("non-JSON SSE payload (heartbeat?)", {
          data: String(event.data).slice(0, 120),
        });
        return;
      }
      const records = Array.isArray(parsed) ? parsed : [parsed];
      for (const raw of records) {
        const u = normalizeUpdate(raw);
        if (u) {
          this.log.info("event", {
            fixture: u.fixtureId,
            seq: u.seq,
            status: u.statusId,
            score: u.score
              ? `${u.score.p1 ?? "?"}-${u.score.p2 ?? "?"}`
              : undefined,
          });
          this.emit("update", u satisfies ScoreUpdate);
        } else {
          this.log.debug("unrecognized record", {
            raw: JSON.stringify(raw).slice(0, 200),
          });
        }
      }
    };

    this.es.onerror = (err: any) => {
      this.log.warn("stream error/drop", {
        message: err?.message || String(err?.code || err),
      });
      this.es?.close();
      if (this.stopped) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      this.log.info(`reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }
}
