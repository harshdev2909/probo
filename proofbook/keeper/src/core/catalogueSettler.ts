/**
 * Autonomous settlement for the COMPOUND catalogue (types >= 16), via v3.
 *
 * The original `Settler` settles exactly one market — the 1X2 — through
 * `settle_market` (v2). It computes the outcome straight from the score
 * (`p1 > p2 ? home : ...`), which is meaningless for a corners or cards or parlay
 * market. So a fixture that finalised got its Match Winner settled and its dozen
 * other markets left locked forever.
 *
 * This settles the rest. On the SAME game_finalised trigger, it walks every
 * catalogue type the fixture carries, and for each:
 *
 *   1. fetches ONE v3 multiproof for that market's stat keys,
 *   2. reads the winning outcome by evaluating the ComboSpec's predicates against
 *      the proven values (locally, with zero authority — the chain re-proves it),
 *   3. locks the market if its betting window has closed,
 *   4. submits `settle_market_v3` — a CPI into TxLINE's oracle, exactly like the
 *      1X2 path, just with a shared multiproof instead of per-stat sibling paths.
 *
 * It shares nothing mutable with `Settler`: a bug here cannot regress the 1X2
 * path or the 713 existing receipts. The DB projection of the new receipts is
 * handled by the keeper's existing sync loop, which reads settled markets from
 * chain — this only needs to make the settlement happen and announce it.
 */
import { EventEmitter } from "events";
import { PublicKey } from "@solana/web3.js";

import { KeeperConfig } from "../config";
import { Logger } from "../logger";
import { StoreLike, ProofReceipt } from "../state";
import { Chain, statusName } from "../chain/proofbook";
import { TxLineClient } from "../txline/client";
import {
  CATALOGUE,
  MarketTypeDef,
  statKeysOf,
} from "../markets/catalogue";
import { buildV3Proof, claimedOutcomeFor } from "../markets/v3proof";

const COMBO_MARKET_TYPE_MIN = 16;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CatalogueSettler extends EventEmitter {
  private log = new Logger("catalogue-settler");
  private inFlight = new Set<string>();
  /** Only the compound catalogue. The 1X2 (type 3) stays with `Settler`. */
  private defs: MarketTypeDef[] = CATALOGUE.filter(
    (d) => d.type >= COMBO_MARKET_TYPE_MIN
  );

  constructor(
    private cfg: KeeperConfig,
    private store: StoreLike,
    private chain: Chain,
    private client?: TxLineClient
  ) {
    super();
  }

  /** Fired on statusId=100, alongside the 1X2 settler. */
  onFinalised(fixtureId: number, seq: number) {
    // v3 settlement needs the real TxLINE proof; mock/replay mode never creates
    // these markets, so there is nothing for it to do there.
    if (!this.client) return;
    void this.settleFixture(fixtureId, seq);
  }

  /**
   * Walk EVERY catalogue type on the fixture and settle each that is due.
   * Public so it can be driven and awaited directly (a re-settle, a test).
   */
  async settleFixture(fixtureId: number, seq: number) {
    // One proof per distinct stat-key set, reused across the markets that share
    // it (e.g. every corners market asks for keys 7,8).
    const proofCache = new Map<string, any>();
    let settled = 0;
    let considered = 0;
    // Per-type disposition, so the log proves the loop covered every type.
    const walked: Record<string, number[]> = {
      settled: [],
      cancelled: [],
      absent: [],
      due: [],
    };

    for (const def of this.defs) {
      const market = this.chain.marketPdaFor(fixtureId, def.type);
      const key = market.toBase58();
      if (this.inFlight.has(key)) continue;

      let onchain: any;
      try {
        onchain = await this.chain.fetchMarket(market);
      } catch (e: any) {
        this.log.warn("could not read market — will get it on the next finalise", {
          fixtureId,
          slug: def.slug,
          error: String(e?.message).slice(0, 100),
        });
        continue;
      }
      if (!onchain) {
        walked.absent.push(def.type); // this fixture does not carry this type
        continue;
      }
      const st = statusName(onchain.status);
      if (st === "settled") {
        walked.settled.push(def.type);
        continue;
      }
      if (st === "cancelled") {
        walked.cancelled.push(def.type);
        continue;
      }

      walked.due.push(def.type);
      considered++;
      this.inFlight.add(key);
      try {
        const ok = await this.attempt(fixtureId, seq, def, market, proofCache);
        if (ok) settled++;
      } catch (e: any) {
        this.log.warn("catalogue settle failed after retries — market stays locked", {
          fixtureId,
          slug: def.slug,
          error: String(e?.message ?? e).slice(0, 180),
        });
      } finally {
        this.inFlight.delete(key);
      }
    }

    // Always log the full disposition — this is the proof the loop iterates
    // every market type, not just the one the 1X2 settler handles.
    this.log.info("catalogue settlement pass — every type walked", {
      fixtureId,
      types: this.defs.map((d) => d.type),
      due: walked.due,
      settled,
      alreadySettled: walked.settled,
      notOnFixture: walked.absent,
    });
    return { considered, settled, walked };
  }

  /** Settle one catalogue market, with bounded retry for the batch-root delay. */
  private async attempt(
    fixtureId: number,
    seq: number,
    def: MarketTypeDef,
    market: PublicKey,
    proofCache: Map<string, any>
  ): Promise<boolean> {
    const attempts = this.cfg.settleMaxAttempts ?? 6;
    for (let n = 1; n <= attempts; n++) {
      try {
        // Idempotency: a re-run, a race with the backfiller, or the cancel
        // backstop may have resolved it already.
        const onchain = await this.chain.fetchMarket(market);
        if (!onchain) return false;
        const st0 = statusName(onchain.status);
        if (st0 === "settled" || st0 === "cancelled") return false;

        const keys = statKeysOf(def);
        const ck = keys.join(",");
        if (!proofCache.has(ck)) {
          proofCache.set(ck, await this.client!.statValidationV3(fixtureId, seq, keys));
        }
        const val = proofCache.get(ck);

        // Period comes from the catalogue def (100 = game_finalised), which is
        // what an upcoming fixture finalises at and what its ComboSpec pins. A
        // mismatch is surfaced by buildV3Proof and cannot settle.
        const built = buildV3Proof(val, def, fixtureId);
        const claimed = claimedOutcomeFor(def, built.values);
        if (claimed < 0) {
          // An exhaustive catalogue must always match. If it does not, the data
          // is not what we believe — never settle on a guess.
          throw new Error(
            `no outcome matches proven values [${built.values}] for ${def.slug}`
          );
        }

        if (st0 === "open") {
          if (Number(onchain.lockTime) * 1000 > Date.now()) {
            this.log.info("still inside its betting window — not settling yet", {
              fixtureId,
              slug: def.slug,
            });
            return false;
          }
          const zero = onchain.outcomes?.some((o: any) => Number(o.pool) === 0);
          if (zero) {
            // Would route to Cancelled and earn no receipt. Refuse.
            throw new Error(`${def.slug}: an outcome has zero stake — would cancel`);
          }
          await this.chain.lockMarket(market);
        }

        const sig = await this.chain.settleMarketV3(
          market,
          claimed,
          built.proof,
          built.epochDay
        );
        const after = await this.chain.fetchMarket(market);
        this.log.info("SETTLED (catalogue) — via validate_stat_v3, no human clicked resolve", {
          fixtureId,
          type: def.type,
          slug: def.slug,
          outcome: def.outcomes[claimed]?.label,
          tx: sig,
        });
        this.announce(after, def, claimed, built, sig);
        return true;
      } catch (e: any) {
        const code = e?.error?.errorCode?.code;
        if (code === "AlreadyResolved") return false; // raced — fine
        const retriable =
          code === undefined || // network/RPC
          code === "InvalidStatProof" || // roots not published for this batch yet
          /fetch failed|timed out|blockhash|not found|429|503/i.test(String(e?.message ?? ""));
        if (!retriable || n >= attempts) throw e;
        const delay = Math.min(
          (this.cfg.settleBaseDelayMs ?? 4000) * 2 ** (n - 1),
          this.cfg.settleMaxDelayMs ?? 60000
        );
        this.log.info(`catalogue settle retry in ${Math.round(delay / 1000)}s`, {
          fixtureId,
          slug: def.slug,
          attempt: n,
          reason: String(e?.message ?? e).slice(0, 120),
        });
        await sleep(delay);
      }
    }
    return false;
  }

  /** Announce the receipt so the live stream and the DB projection pick it up. */
  private announce(
    onchain: any,
    def: MarketTypeDef,
    claimed: number,
    built: { values: number[]; period: number },
    settleTx: string
  ) {
    const receipt: ProofReceipt = {
      marketPda: this.chain.marketPdaFor(Number(onchain.fixtureId), def.type).toBase58(),
      matchId: Number(onchain.fixtureId),
      winningOutcome: claimed,
      statPeriod: built.period,
      outcomeLabel: def.outcomes[claimed]?.label ?? String(claimed),
      oracleProgram: onchain.oracleProgram.toBase58(),
      epochDay: onchain.settleEpochDay,
      dailyRootsPda: onchain.settleDailyRoots.toBase58(),
      proofRef: Buffer.from(onchain.settleProofRef).toString("hex"),
      resolver: onchain.settleResolver.toBase58(),
      settleTx,
      settledAt: Number(onchain.settledAt),
      totalPool: onchain.totalPool.toString(),
      totalWinningPool: onchain.totalWinningPool.toString(),
      feeAmount: onchain.feeAmount.toString(),
    };
    this.emit("receipt", receipt);
  }
}
