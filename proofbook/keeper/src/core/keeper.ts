import { KeeperConfig } from "../config";
import { Logger } from "../logger";
import { Store, type StoreLike } from "../state";
import { Chain } from "../chain/proofbook";
import { TxLineSession } from "../txline/session";
import { TxLineClient, ScoreUpdate } from "../txline/client";
import { ScoresStream } from "../txline/sse";
import { OddsStream } from "../txline/oddsStream";
import { ReplayFeed, ReplayFixture, loadReplayFixture } from "../txline/replay";
import { MarketManager } from "./marketManager";
import { Settler } from "./settler";
import { ApiServer } from "../api/server";
import { PgStore, emitEvent } from "../pgstore";
import { Leader } from "../leader";
import { DbSync } from "../db/sync";

/**
 * The keeper orchestrator — the autonomous off-chain brain.
 * live  : auth → fixture sync → market creation → SSE ingest → lock → settle.
 * replay: recorded feed (time-compressed) → same pipeline, mock oracle local.
 * In both modes NOTHING requires human action: creation, locking, settlement,
 * and the cancel backstop are all automatic and idempotent.
 */
export class Keeper {
  log = new Logger("keeper");
  store: StoreLike;
  chain: Chain;
  markets: MarketManager;
  settler: Settler;
  api: ApiServer;
  session?: TxLineSession;
  client?: TxLineClient;
  private feed?: ScoresStream | ReplayFeed;
  private oddsFeed?: OddsStream;
  private replayFixture?: ReplayFixture;
  private timers: NodeJS.Timeout[] = [];

  private leader?: Leader;
  private sync?: DbSync;

  /**
   * Postgres-backed keepers must load their store asynchronously, so construction
   * goes through here. `new Keeper(cfg)` still works for replay/local (JSON store).
   */
  static async create(cfg: KeeperConfig): Promise<Keeper> {
    const store = cfg.databaseUrl ? await PgStore.open() : undefined;
    return new Keeper(cfg, store);
  }

  constructor(public cfg: KeeperConfig, store?: StoreLike) {
    this.store = store ?? new Store(cfg.dataDir);
    this.chain = new Chain(cfg, this.store);
    this.markets = new MarketManager(cfg, this.store, this.chain);
    this.api = new ApiServer(cfg, this.store, this.chain);

    if (cfg.mode === "live") {
      this.session = new TxLineSession(cfg, this.store, this.chain);
      this.client = new TxLineClient(this.session);
    } else {
      if (!cfg.replayFile)
        throw new Error("replay mode requires REPLAY_FILE / --file");
      this.replayFixture = loadReplayFixture(cfg.replayFile);
    }
    this.settler = new Settler(
      cfg,
      this.store,
      this.chain,
      this.client,
      this.replayFixture
    );

    // Fan settlement + market updates out to API stream subscribers, and keep
    // the indexer cache hot on every state change.
    const onMarketEvent = (type: string) => (m: any) => {
      // The in-process broadcast only reaches the keeper's own API (replay/local).
      this.api.broadcast(type, m);
      void this.api.refreshMarkets().catch(() => {});

      // Postgres is how a SEPARATE, stateless API instance learns anything
      // happened — without this the deployed site's live feed is silent.
      if (this.cfg.databaseUrl) {
        void emitEvent(type, m, {
          fixtureId: m?.fixtureId ?? m?.matchId,
          marketPda: m?.marketPda,
        });
        if (type === "receipt") {
          void this.sync
            ?.heartbeat({ lastSettlementAt: new Date() })
            .catch(() => {});
          void this.sync?.fullSync().catch(() => {});
        }
      }
    };
    this.settler.on("receipt", onMarketEvent("receipt"));
    this.settler.on("market", onMarketEvent("market"));
    this.markets.on("market", onMarketEvent("market"));
  }

  async start() {
    this.log.info("keeper starting", {
      mode: this.cfg.mode,
      oracle: this.cfg.oracleMode,
      store: this.cfg.databaseUrl ? "postgres" : "json",
    });

    if (this.cfg.databaseUrl) {
      // ONE keeper acts. A second instance (a rolling deploy, a stray local run)
      // blocks here as a follower and never writes. settle_market is idempotent
      // on-chain, but the read-then-write around it is not — two keepers racing it
      // would burn fees and corrupt the store's mirror.
      this.leader = new Leader(this.cfg.databaseUrl, async () => {});
      await this.leader.run();

      this.sync = new DbSync(
        this.cfg,
        this.chain,
        this.cfg.instanceId,
        this.client
      );
      await this.sync.heartbeat({ streamConnected: false });
      await this.sync.fullSync();
      this.timers.push(setInterval(() => void this.sync!.fullSync(), 10_000));
      this.timers.push(
        setInterval(() => void this.sync!.heartbeat().catch(() => {}), 15_000)
      );
      // SHARP vs CROWD. Its own timer: the consensus line drifts independently
      // of our pools, so sampling it only when someone bets would produce a
      // sparkline of our own activity rather than of the market's opinion.
      this.timers.push(
        setInterval(
          () =>
            void this.sync!.syncOdds().catch((e) =>
              this.log.warn("odds sync failed", { error: e?.message })
            ),
          60_000
        )
      );
    } else {
      // No database: this is the self-contained local/replay demo, so the keeper
      // serves its own read API.
      this.api.start();
      this.timers.push(
        setInterval(
          () => void this.api.refreshMarkets().catch(() => {}),
          10_000
        )
      );
    }

    await this.markets.init();

    // Sweeper: lock + cancel backstop.
    this.timers.push(setInterval(() => void this.markets.sweep(), 5_000));

    if (this.cfg.mode === "live") await this.startLive();
    else await this.startReplay();
  }

  private async startLive() {
    await this.session!.ensure();

    const syncFixtures = async () => {
      try {
        const fixtures = await this.client!.fixturesSnapshot(
          this.cfg.competitionId
        );
        for (const f of fixtures) {
          await this.markets.ensureMarket(f).catch((e) =>
            this.log.warn("ensureMarket failed", {
              fixture: f.fixtureId,
              error: e?.message,
            })
          );
        }
      } catch (e: any) {
        this.log.warn("fixture sync failed (will retry)", {
          error: e?.message,
        });
      }
    };
    await syncFixtures();
    this.timers.push(setInterval(syncFixtures, 10 * 60_000));

    const stream = new ScoresStream(this.cfg, this.session!);
    stream.on("update", (u: ScoreUpdate) => this.ingest(u));
    stream.on("open", () => {
      void this.sync?.heartbeat({ streamConnected: true }).catch(() => {});
    });
    stream.on("closed", () => {
      void this.sync?.heartbeat({ streamConnected: false }).catch(() => {});
    });
    stream.start();
    this.feed = stream;

    // SHARP vs CROWD. A second, entirely separate TxLINE feed. It never touches
    // settlement — no proof, no predicate, no receipt is influenced by a price.
    const odds = new OddsStream(this.cfg, this.session!);
    odds.on("odds", (row: any) => {
      if (!this.cfg.databaseUrl) return;
      void this.sync?.recordOddsTick(row).catch(() => {});
    });
    odds.start();
    this.oddsFeed = odds;

    this.log.info(
      "live pipeline running — markets will lock and settle themselves"
    );
  }

  private async startReplay() {
    const fx = this.replayFixture!;
    this.log.info("replay pipeline", {
      fixture: fx.fixtureId,
      name: fx.name,
      final: `${fx.finalScore.p1}-${fx.finalScore.p2}`,
      provenance: fx.provenance?.note,
    });

    // Create the market with a near-future lock (the on-camera betting window).
    const lockTime =
      Math.floor(Date.now() / 1000) + this.cfg.replayLockDelaySec;
    const rec = await this.markets.ensureMarket(
      { fixtureId: fx.fixtureId, name: fx.name, raw: {} },
      lockTime
    );
    if (!rec) throw new Error("replay market creation failed");
    this.log.info(
      `betting window open for ${this.cfg.replayLockDelaySec}s — place your bets`,
      {
        market: rec.marketPda,
      }
    );

    // Kick off the feed only once the market locks (mirrors a real kickoff).
    const waitForLock = setInterval(() => {
      const m = this.store.data.markets[rec.marketPda];
      if (m && (m.phase === "locked" || m.phase === "settling")) {
        clearInterval(waitForLock);
        const feed = new ReplayFeed(
          fx,
          this.cfg.replaySpeed,
          this.cfg.replayMaxGapMs
        );
        feed.on("update", (u: ScoreUpdate) => this.ingest(u));
        feed.on("end", () => this.log.info("replay feed ended"));
        feed.start();
        this.feed = feed;
      }
    }, 1_000);
    this.timers.push(waitForLock);
  }

  /** Single ingest path for live SSE and replay events. */
  ingest(u: ScoreUpdate) {
    const fx = this.store.fixture(u.fixtureId);
    if (fx.lastSeq !== undefined && u.seq <= fx.lastSeq && u.statusId !== 100)
      return; // stale/dup
    fx.lastSeq = u.seq;
    fx.lastTs = u.ts;
    if (u.statusId !== undefined) fx.statusId = u.statusId;
    if (u.score) {
      // Merge partial scores (feed events often carry only the scoring side).
      fx.score = {
        p1: u.score.p1 ?? fx.score?.p1 ?? 0,
        p2: u.score.p2 ?? fx.score?.p2 ?? 0,
      };
    }
    fx.lastUpdateAt = new Date().toISOString();
    this.store.saveSoon();
    const scoreEvent = {
      fixtureId: u.fixtureId,
      seq: u.seq,
      statusId: u.statusId,
      score: u.score,
      ts: u.ts,
    };
    this.api.broadcast("score", scoreEvent);
    if (this.cfg.databaseUrl) {
      void emitEvent("score", scoreEvent, {
        fixtureId: u.fixtureId,
        seq: u.seq,
      });
      void this.sync
        ?.heartbeat({ streamConnected: true, lastEventAt: new Date() })
        .catch(() => {});
    }

    if (u.statusId === 100 && fx.finalisedSeq === undefined) {
      fx.finalisedSeq = u.seq;
      this.store.saveSoon();
      this.log.info(
        "game_finalised (statusId=100) — the method-agnostic final",
        {
          fixture: u.fixtureId,
          seq: u.seq,
          score: fx.score ? `${fx.score.p1}-${fx.score.p2}` : "?",
        }
      );
      this.settler.onFinalised(u.fixtureId, u.seq);
    }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    (this.feed as any)?.stop?.();
    this.oddsFeed?.stop();
    this.api.stop();
    this.store.flush();
    this.log.info("keeper stopped");
  }
}
