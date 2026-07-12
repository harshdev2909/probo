import { EventEmitter } from "events";
import { PublicKey } from "@solana/web3.js";

import { KeeperConfig } from "../config";
import { Logger } from "../logger";
import { Store, MarketRecord, type StoreLike } from "../state";
import { Chain, statusName } from "../chain/proofbook";
import { FixtureInfo } from "../txline/client";

/**
 * Fixture sync → auto market creation, and the lock/cancel sweeper.
 * Idempotent everywhere: the market PDA is derived deterministically from
 * (authority, fixtureId, marketType) and checked on-chain before creating, so
 * restarts never double-create.
 */
export class MarketManager extends EventEmitter {
  private log = new Logger("markets");
  private usdcMint!: PublicKey;
  private sweeping = false;

  constructor(
    private cfg: KeeperConfig,
    private store: StoreLike,
    private chain: Chain
  ) {
    super();
  }

  async init() {
    this.usdcMint = await this.chain.ensureUsdcMint();
    this.log.info("escrow mint", { mint: this.usdcMint.toBase58() });
  }

  /** Idempotently ensure a market exists for a fixture. */
  async ensureMarket(
    fixture: FixtureInfo,
    lockTimeOverride?: number
  ): Promise<MarketRecord | null> {
    const { fixtureId } = fixture;
    const marketType = this.cfg.marketType;
    const pda = this.chain.marketPdaFor(fixtureId, marketType);
    const key = pda.toBase58();

    const existing = this.store.data.markets[key];
    if (existing) return existing;

    // On-chain check (state may have been wiped / another instance created it).
    const onchain = await this.chain.fetchMarket(pda);
    if (onchain) {
      this.log.info("market already exists on-chain — adopting", {
        market: key,
        fixtureId,
      });
      const rec: MarketRecord = {
        marketPda: key,
        fixtureId,
        marketType,
        phase:
          statusName(onchain.status) === "open"
            ? "created"
            : (statusName(onchain.status) as any),
        lockTime: Number(onchain.lockTime),
        resolutionTimeout: Number(onchain.resolutionTimeout),
        usdcMint: onchain.usdcMint.toBase58(),
        winningOutcome: onchain.winningOutcome,
      };
      this.store.data.markets[key] = rec;
      this.store.saveSoon();
      return rec;
    }

    const now = Math.floor(Date.now() / 1000);
    const lockTime = lockTimeOverride ?? fixture.kickoffTs ?? 0;
    if (!lockTime || lockTime <= now + 5) {
      this.log.warn(
        "skipping market creation — kickoff/lock time not in the future",
        {
          fixtureId,
          kickoffTs: fixture.kickoffTs,
        }
      );
      return null;
    }

    this.log.info("creating market", {
      fixtureId,
      name: fixture.name,
      market: key,
      lockTime: new Date(lockTime * 1000).toISOString(),
      resolutionTimeoutSec: this.cfg.resolutionTimeoutSec,
    });
    const { sig } = await this.chain.initializeMarket(
      fixtureId,
      marketType,
      this.usdcMint,
      lockTime,
      this.cfg.resolutionTimeoutSec
    );
    const rec: MarketRecord = {
      marketPda: key,
      fixtureId,
      marketType,
      phase: "created",
      lockTime,
      resolutionTimeout: this.cfg.resolutionTimeoutSec,
      usdcMint: this.usdcMint.toBase58(),
      createdTx: sig,
    };
    this.store.data.markets[key] = rec;
    const fs = this.store.fixture(fixtureId);
    fs.name = fixture.name ?? fs.name;
    // Persist the participant names, not just the display string: the API
    // resolves teams (codes, flags) from these. Without them an autonomously
    // created market renders with no teams at all.
    fs.homeName = fixture.p1Name ?? fs.homeName;
    fs.awayName = fixture.p2Name ?? fs.awayName;
    fs.kickoffTs = lockTime;
    fs.proofStatus = fs.proofStatus ?? "upcoming";
    fs.competitionId = fixture.competitionId ?? fs.competitionId;
    this.store.saveSoon();
    this.log.info("market created", { market: key, tx: sig });
    this.emit("market", rec);
    return rec;
  }

  /**
   * Periodic sweep: lock markets whose lock_time has passed, and fire the
   * permissionless time-based cancel backstop on markets stuck past
   * lock_time + resolution_timeout. Both idempotent (re-check on-chain).
   */
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const rec of Object.values(this.store.data.markets)) {
        // "error" markets stay in the sweep: the cancel backstop must still fire.
        if (rec.phase === "settled" || rec.phase === "cancelled") continue;
        const pda = new PublicKey(rec.marketPda);

        if (rec.phase === "created" && now >= rec.lockTime) {
          const onchain = await this.chain.fetchMarket(pda);
          const st = onchain ? statusName(onchain.status) : null;
          if (st === "open") {
            try {
              const sig = await this.chain.lockMarket(pda);
              rec.phase = "locked";
              rec.lockTx = sig;
              this.log.info("market locked (betting closed)", {
                market: rec.marketPda,
                tx: sig,
              });
              this.emit("market", rec);
            } catch (e: any) {
              this.log.warn("lock failed (will retry on next sweep)", {
                market: rec.marketPda,
                error: e?.error?.errorCode?.code || e?.message,
              });
            }
          } else if (st === "locked") {
            rec.phase = "locked";
            this.emit("market", rec);
          }
          this.store.saveSoon();
        }

        // Liveness backstop: LOUD, permissionless, time-triggered.
        if (
          (rec.phase === "locked" ||
            rec.phase === "settling" ||
            rec.phase === "error") &&
          now > rec.lockTime + rec.resolutionTimeout
        ) {
          const onchain = await this.chain.fetchMarket(pda);
          const st = onchain ? statusName(onchain.status) : null;
          if (st === "locked") {
            this.log.error(
              "CANCEL BACKSTOP FIRING — market unresolved past lock_time + resolution_timeout; cancelling so users can refund",
              {
                market: rec.marketPda,
                fixtureId: rec.fixtureId,
              }
            );
            try {
              const sig = await this.chain.cancelMarket(pda);
              rec.phase = "cancelled";
              rec.cancelTx = sig;
              this.log.error("market CANCELLED — refunds open", {
                market: rec.marketPda,
                tx: sig,
              });
              this.emit("market", rec);
            } catch (e: any) {
              this.log.warn("cancel backstop failed (will retry)", {
                market: rec.marketPda,
                error: e?.error?.errorCode?.code || e?.message,
              });
            }
            this.store.saveSoon();
          } else if (st === "settled" || st === "cancelled") {
            rec.phase = st;
            this.store.saveSoon();
          }
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
