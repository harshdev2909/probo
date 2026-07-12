/**
 * SSE fan-out, via Postgres LISTEN/NOTIFY.
 *
 * The keeper is the only writer and the API is stateless, so they cannot share an
 * in-process EventEmitter — an API instance would only ever see events from a
 * keeper running inside it. Instead the keeper INSERTs a feed_event and NOTIFYs;
 * every API instance LISTENs and fans out to its own SSE clients. Add ten API
 * instances behind a load balancer and every one of them still sees every event.
 *
 * The Postgres NOTIFY payload is capped at 8000 bytes, so we notify with the
 * event id only and read the row back. Small events could be inlined, but then
 * one oversized payload silently stops the stream — not a failure mode worth
 * inviting on Final night.
 */
import { Client } from "pg";
import type { FastifyBaseLogger } from "fastify";

import { prisma } from "../../db/src/client";

export const CHANNEL = "proofbook_events";

export interface StreamEvent {
  id: string;
  type: string;
  fixtureId: number | null;
  marketPda: string | null;
  payload: unknown;
  at: number;
}

type Client_ = {
  id: number;
  write: (chunk: string) => void;
  types: Set<string> | null;
};

export class EventStream {
  private clients = new Map<number, Client_>();
  private nextId = 1;
  private pg?: Client;
  private stopped = false;

  constructor(private databaseUrl: string, private log: FastifyBaseLogger) {}

  async start() {
    await this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    try {
      this.pg = new Client({ connectionString: this.databaseUrl });
      this.pg.on("error", (e) => {
        this.log.error({ err: e }, "LISTEN connection error — reconnecting");
        this.reconnectSoon();
      });
      this.pg.on("end", () => this.reconnectSoon());

      await this.pg.connect();
      await this.pg.query(`LISTEN ${CHANNEL}`);
      this.log.info("listening for keeper events on Postgres");

      this.pg.on("notification", (msg) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        void this.dispatch(msg.payload);
      });
    } catch (e) {
      this.log.error({ err: e }, "failed to LISTEN — retrying");
      this.reconnectSoon();
    }
  }

  private reconnectTimer?: NodeJS.Timeout;
  private reconnectSoon() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, 2000);
  }

  private async dispatch(idStr: string) {
    const id = BigInt(idStr);
    const row = await prisma.feedEvent
      .findUnique({ where: { id } })
      .catch(() => null);
    if (!row) return;
    this.broadcast({
      id: row.id.toString(),
      type: row.type,
      fixtureId: row.fixtureId,
      marketPda: row.marketPda,
      payload: row.payload,
      at: Math.floor(row.createdAt.getTime() / 1000),
    });
  }

  broadcast(ev: StreamEvent) {
    const frame = `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(
      ev
    )}\n\n`;
    for (const c of this.clients.values()) {
      if (c.types && !c.types.has(ev.type)) continue;
      try {
        c.write(frame);
      } catch {
        this.clients.delete(c.id);
      }
    }
  }

  /** `types` filters the multiplexed stream (e.g. ?types=score,receipt). */
  addClient(write: (chunk: string) => void, types?: string[]): () => void {
    const id = this.nextId++;
    this.clients.set(id, {
      id,
      write,
      types: types && types.length ? new Set(types) : null,
    });
    return () => this.clients.delete(id);
  }

  get clientCount() {
    return this.clients.size;
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const c of this.clients.values()) {
      try {
        c.write("event: bye\ndata: {}\n\n");
      } catch {
        /* client already gone */
      }
    }
    this.clients.clear();
    await this.pg?.end().catch(() => {});
  }
}
