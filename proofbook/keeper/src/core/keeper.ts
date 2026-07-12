import { KeeperConfig } from "../config";
import { Logger } from "../logger";
import { Store } from "../state";
import { Chain } from "../chain/proofbook";
import { TxLineSession } from "../txline/session";
import { TxLineClient, ScoreUpdate } from "../txline/client";
import { ScoresStream } from "../txline/sse";
import { ReplayFeed, ReplayFixture, loadReplayFixture } from "../txline/replay";
import { MarketManager } from "./marketManager";
import { Settler } from "./settler";
import { ApiServer } from "../api/server";

/**
 * The keeper orchestrator — the autonomous off-chain brain.
 * live  : auth → fixture sync → market creation → SSE ingest → lock → settle.
 * replay: recorded feed (time-compressed) → same pipeline, mock oracle local.
 * In both modes NOTHING requires human action: creation, locking, settlement,
 * and the cancel backstop are all automatic and idempotent.
 */
export class Keeper {
  log = new Logger("keeper");
  store: Store;
  chain: Chain;
  markets: MarketManager;
  settler: Settler;
  api: ApiServer;
  session?: TxLineSession;
  client?: TxLineClient;
  private feed?: ScoresStream | ReplayFeed;
  private replayFixture?: ReplayFixture;
  private timers: NodeJS.Timeout[] = [];

  constructor(public cfg: KeeperConfig) {
    this.store = new Store(cfg.dataDir);
    this.chain = new Chain(cfg, this.store);
    this.markets = new MarketManager(cfg, this.store, this.chain);
    this.api = new ApiServer(cfg, this.store, this.chain);

    if (cfg.mode === "live") {
      this.session = new TxLineSession(cfg, this.store, this.chain);
      this.client = new TxLineClient(this.session);
    } else {
      if (!cfg.replayFile) throw new Error("replay mode requires REPLAY_FILE / --file");
      this.replayFixture = loadReplayFixture(cfg.replayFile);
    }
    this.settler = new Settler(cfg, this.store, this.chain, this.client, this.replayFixture);

    // Fan settlement + market updates out to API stream subscribers, and keep
    // the indexer cache hot on every state change.
    const onMarketEvent = (type: string) => (m: unknown) => {
      this.api.broadcast(type, m);
      void this.api.refreshMarkets().catch(() => {});
    };
    this.settler.on("receipt", onMarketEvent("receipt"));
    this.settler.on("market", onMarketEvent("market"));
    this.markets.on("market", onMarketEvent("market"));
  }

  async start() {
    this.log.info("keeper starting", { mode: this.cfg.mode, oracle: this.cfg.oracleMode });
    await this.markets.init();
    this.api.start();

    // Sweeper: lock + cancel backstop.
    this.timers.push(setInterval(() => void this.markets.sweep(), 5_000));
    // Indexer: refresh the on-chain market cache for the read API.
    this.timers.push(setInterval(() => void this.api.refreshMarkets().catch(() => {}), 10_000));

    if (this.cfg.mode === "live") await this.startLive();
    else await this.startReplay();
  }

  private async startLive() {
    await this.session!.ensure();

    const syncFixtures = async () => {
      try {
        const fixtures = await this.client!.fixturesSnapshot(this.cfg.competitionId);
        for (const f of fixtures) {
          await this.markets.ensureMarket(f).catch((e) =>
            this.log.warn("ensureMarket failed", { fixture: f.fixtureId, error: e?.message })
          );
        }
      } catch (e: any) {
        this.log.warn("fixture sync failed (will retry)", { error: e?.message });
      }
    };
    await syncFixtures();
    this.timers.push(setInterval(syncFixtures, 10 * 60_000));

    const stream = new ScoresStream(this.cfg, this.session!);
    stream.on("update", (u: ScoreUpdate) => this.ingest(u));
    stream.start();
    this.feed = stream;
    this.log.info("live pipeline running — markets will lock and settle themselves");
  }

  private async startReplay() {
    const fx = this.replayFixture!;
    this.log.info("replay pipeline", {
      fixture: fx.fixtureId, name: fx.name,
      final: `${fx.finalScore.p1}-${fx.finalScore.p2}`,
      provenance: fx.provenance?.note,
    });

    // Create the market with a near-future lock (the on-camera betting window).
    const lockTime = Math.floor(Date.now() / 1000) + this.cfg.replayLockDelaySec;
    const rec = await this.markets.ensureMarket(
      { fixtureId: fx.fixtureId, name: fx.name, raw: {} },
      lockTime
    );
    if (!rec) throw new Error("replay market creation failed");
    this.log.info(`betting window open for ${this.cfg.replayLockDelaySec}s — place your bets`, {
      market: rec.marketPda,
    });

    // Kick off the feed only once the market locks (mirrors a real kickoff).
    const waitForLock = setInterval(() => {
      const m = this.store.data.markets[rec.marketPda];
      if (m && (m.phase === "locked" || m.phase === "settling")) {
        clearInterval(waitForLock);
        const feed = new ReplayFeed(fx, this.cfg.replaySpeed, this.cfg.replayMaxGapMs);
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
    if (fx.lastSeq !== undefined && u.seq <= fx.lastSeq && u.statusId !== 100) return; // stale/dup
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
    this.api.broadcast("score", {
      fixtureId: u.fixtureId, seq: u.seq, statusId: u.statusId, score: u.score, ts: u.ts,
    });

    if (u.statusId === 100 && fx.finalisedSeq === undefined) {
      fx.finalisedSeq = u.seq;
      this.store.saveSoon();
      this.log.info("game_finalised (statusId=100) — the method-agnostic final", {
        fixture: u.fixtureId, seq: u.seq, score: fx.score ? `${fx.score.p1}-${fx.score.p2}` : "?",
      });
      this.settler.onFinalised(u.fixtureId, u.seq);
    }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    (this.feed as any)?.stop?.();
    this.api.stop();
    this.store.flush();
    this.log.info("keeper stopped");
  }
}
