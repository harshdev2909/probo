/**
 * Leader election, via a Postgres session-level advisory lock.
 *
 * WHY THIS MATTERS: settle_market is idempotent on-chain (the second call fails
 * with the market already settled) but the keeper does read-then-write around it
 * — check status, fetch proof, lock, settle. Two keepers racing that sequence
 * would burn fees, double-cancel markets, and corrupt the store's write-through
 * mirror. A restart during a deploy, or a platform that briefly runs the old and
 * new instance side by side, is enough to trigger it. So exactly one keeper acts.
 *
 * `pg_try_advisory_lock` is held for the LIFETIME OF THE CONNECTION and released
 * automatically if the process dies — no stale lock to clean up, no TTL to tune,
 * no fencing token needed. A follower keeps trying, so it takes over within
 * seconds of the leader dying.
 *
 * A follower does NOT write. It idles and waits. That is deliberate: a
 * "read-only keeper" that still ingested the feed would double-write the store.
 *
 * ⚠️ IT MUST NOT GO THROUGH A CONNECTION POOLER.
 *
 * A session-level advisory lock is tied to a backend SESSION. PgBouncer (which
 * Neon puts in front of Postgres on its `-pooler` host) multiplexes many clients
 * onto few backends, so the "session" a client thinks it holds is not its own:
 * two keepers can BOTH be told they acquired the lock, and the one guarantee this
 * whole mechanism exists to provide silently evaporates. Observed exactly that —
 * `pg_locks` showed the advisory lock held by `application_name = pgbouncer`
 * while two keepers each believed they were the leader.
 *
 * So the lock takes a DIRECT connection. `DIRECT_DATABASE_URL` if set; otherwise
 * `DATABASE_URL` with Neon's `-pooler` suffix stripped, which is exactly the
 * direct endpoint. Prisma keeps using the pooled URL for everything else — the
 * pooler is right for ordinary queries and wrong only for this.
 */
import { Client } from "pg";
import { Logger } from "./logger";

/** Any stable 64-bit key; this one is just "proofbook" hashed by hand. */
const LOCK_KEY = 0x50524f4f_46424f4bn % 9223372036854775807n;

/**
 * A connection that is genuinely OURS — not one borrowed from a pooler.
 * Neon's pooled host is `<endpoint>-pooler.<region>...`; the direct host is the
 * same name with `-pooler` removed.
 */
export function directUrl(url: string): string {
  if (process.env.DIRECT_DATABASE_URL) return process.env.DIRECT_DATABASE_URL;
  return url.replace("-pooler.", ".");
}

export class Leader {
  private client?: Client;
  private log = new Logger("leader");
  private acquired = false;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private resolveAcquired?: () => void;

  constructor(
    databaseUrl: string,
    private onAcquire: () => Promise<void> | void
  ) {
    this.databaseUrl = directUrl(databaseUrl);
  }

  private databaseUrl: string;

  get isLeader() {
    return this.acquired;
  }

  /**
   * Resolves ONLY once this instance holds the lock. A follower awaits here
   * forever — it must never fall through and start writing.
   *
   * (An earlier version awaited a single attempt, which resolved even when the
   * lock was NOT acquired. Both keepers then synced. That is precisely the bug
   * this class exists to prevent, so the contract is now: this promise settles on
   * acquisition, and on nothing else.)
   */
  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveAcquired = resolve;
      void this.attempt();
    });
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.client) {
        this.client = new Client({ connectionString: this.databaseUrl });
        this.client.on("error", (e) => {
          this.log.error("leader connection lost — standing down", {
            error: String(e),
          });
          this.standDown();
        });
        this.client.on("end", () => this.standDown());
        await this.client.connect();
      }

      const res = await this.client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [LOCK_KEY.toString()]
      );

      if (res.rows[0]?.locked) {
        this.acquired = true;
        this.log.info("acquired the keeper lock — this instance is the leader");
        this.startVerifyLoop();
        await this.onAcquire();
        this.resolveAcquired?.();
        this.resolveAcquired = undefined;
        return;
      }

      this.log.warn("another keeper holds the lock; standing by as follower");
      await this.client.end().catch(() => {});
      this.client = undefined;
      this.retrySoon();
    } catch (e) {
      this.log.error("leader election failed — retrying", { error: String(e) });
      this.client = undefined;
      this.retrySoon();
    }
  }

  private retrySoon() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.attempt();
    }, 5000);
  }

  /**
   * PROVE we still hold the lock, every few seconds — the fix for a failure that
   * actually happened on the eve of the semi-finals.
   *
   * A session-level advisory lock lives exactly as long as its SESSION, and the
   * client only learns the session died if the socket says so. It did not:
   * Neon idle-reaped the connection half-open, no 'error' or 'end' ever fired,
   * the lock silently evaporated server-side — and `pg_locks` showed NO holder
   * while two keepers both heartbeated isLeader=true. Trust-once leadership is
   * not leadership on this infrastructure.
   *
   * So the leader re-asserts the lock on ITS OWN session every tick.
   * `pg_try_advisory_lock` on a session that already holds the lock stacks and
   * returns true, so in the healthy case this is a no-op that doubles as the
   * keepalive that stops Neon reaping the session in the first place. If the
   * connection is dead the query THROWS, and we stand down within one tick
   * instead of never.
   */
  private startVerifyLoop() {
    const tick = async () => {
      if (!this.acquired || this.stopped) return;
      try {
        const res = await this.client!.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [LOCK_KEY.toString()]
        );
        if (!res.rows[0]?.locked) {
          this.log.error("lock verify returned false — session no longer owns it");
          this.standDown();
          return;
        }
      } catch (e) {
        this.log.error("lock verify failed — the session is gone", {
          error: String(e).slice(0, 160),
        });
        this.standDown();
        return;
      }
      setTimeout(() => void tick(), 15_000);
    };
    setTimeout(() => void tick(), 15_000);
  }

  /**
   * If we lose the connection we have also lost the lock (Postgres releases it),
   * so we must stop acting immediately. Exiting is the safest thing a keeper that
   * is no longer certain it is the leader can do — the platform restarts it and
   * it re-elects cleanly. (Locally, `scripts/keeper-supervisor.sh` is that
   * platform: it relaunches the process so it re-elects.)
   */
  private standDown() {
    if (!this.acquired || this.stopped) return;
    this.acquired = false;
    this.log.error(
      "LOST the keeper lock — exiting so a clean leader can take over"
    );
    process.exit(1);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.client?.end().catch(() => {});
  }
}
