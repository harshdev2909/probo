import { EventEmitter } from "events";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { KeeperConfig } from "../config";
import { Logger } from "../logger";
import { Store, ProofReceipt } from "../state";
import { Chain, statusName, OUTCOME_LABELS } from "../chain/proofbook";
import { TxLineClient } from "../txline/client";
import { dailyRootsPda, epochDayOf } from "../chain/pdas";
import { ReplayFixture } from "../txline/replay";

/**
 * The flagship: fully autonomous settlement. On a game_finalised record it
 * fetches the REAL proof and submits settle_market (CPI into validate_stat_v2).
 * Bounded retry with exponential backoff (roots publish on batch boundaries);
 * idempotent (re-checks on-chain status first); never spins forever — after the
 * retry budget it flags a loud ERROR state. No human input, no admin key.
 */
export class Settler extends EventEmitter {
  private log = new Logger("settler");
  private inFlight = new Set<string>();

  constructor(
    private cfg: KeeperConfig,
    private store: Store,
    private chain: Chain,
    private client?: TxLineClient, // live mode
    private replayFixture?: ReplayFixture // replay mode
  ) {
    super();
  }

  /** Called when a fixture reaches statusId=100 (game_finalised). */
  onFinalised(fixtureId: number, seq: number) {
    const rec = this.store.marketByFixture(fixtureId, this.cfg.marketType);
    if (!rec) {
      this.log.warn("finalised fixture has no tracked market", { fixtureId });
      return;
    }
    if (this.inFlight.has(rec.marketPda)) return;
    if (rec.phase === "settled" || rec.phase === "cancelled") return;
    this.inFlight.add(rec.marketPda);
    rec.phase = "settling";
    rec.settleAttempts = 0;
    this.store.saveSoon();
    this.log.info("finalisation detected — starting autonomous settlement", {
      fixtureId, seq, market: rec.marketPda,
    });
    void this.attempt(rec.marketPda, fixtureId, seq);
  }

  private async attempt(marketPdaStr: string, fixtureId: number, seq: number) {
    const rec = this.store.data.markets[marketPdaStr];
    const market = new PublicKey(marketPdaStr);
    rec.settleAttempts = (rec.settleAttempts || 0) + 1;
    const n = rec.settleAttempts;

    try {
      // Idempotency: never double-settle; pick up out-of-band resolutions.
      const onchain = await this.chain.fetchMarket(market);
      if (!onchain) throw new Error("market account missing on-chain");
      const st = statusName(onchain.status);
      if (st === "settled" || st === "cancelled") {
        this.log.info(`market already ${st} on-chain — recording and stopping`, { market: marketPdaStr });
        await this.recordResolution(marketPdaStr, onchain, rec.settleTx || "");
        this.inFlight.delete(marketPdaStr);
        return;
      }
      if (st === "open") throw retryable("market not locked yet");

      // Build the proof: real REST proof (live) or mock-built from the recording.
      const { proof, epochDay, p1, p2 } = await this.buildProof(fixtureId, seq);
      const claimed = p1 > p2 ? 0 : p1 < p2 ? 2 : 1;
      this.log.info("submitting settle_market", {
        market: marketPdaStr, attempt: n, epochDay,
        final: `${p1}-${p2}`, claimedOutcome: OUTCOME_LABELS[claimed],
        oracle: this.chain.oracleProgramId.toBase58(),
      });

      const sig = await this.chain.settleMarket(market, claimed, proof, epochDay);
      this.log.info("SETTLED — trustlessly, via oracle proof. no human clicked resolve.", {
        market: marketPdaStr, tx: sig,
      });
      const settled = await this.chain.fetchMarket(market);
      await this.recordResolution(marketPdaStr, settled, sig);
      this.inFlight.delete(marketPdaStr);
    } catch (e: any) {
      // A cancel (backstop) may have raced us — that's a resolution, not an error.
      if (e?.error?.errorCode?.code === "AlreadyResolved") {
        const onchain = await this.chain.fetchMarket(market).catch(() => null);
        if (onchain) {
          this.log.info("market was resolved out-of-band (cancel backstop?) — recording", { market: marketPdaStr });
          await this.recordResolution(marketPdaStr, onchain, rec.settleTx || "");
        }
        this.inFlight.delete(marketPdaStr);
        return;
      }
      const msg = errText(e);
      const retriable = isRetryable(e);
      this.log.warn(`settle attempt ${n} failed`, { market: marketPdaStr, retriable, error: msg.slice(0, 300) });

      if (!retriable || n >= this.cfg.settleMaxAttempts) {
        rec.phase = "error";
        rec.lastError = msg.slice(0, 500);
        this.store.saveSoon();
        this.log.error("SETTLEMENT ERROR — retry budget exhausted or fatal error. The time-based cancel backstop will unlock refunds after the resolution timeout.", {
          market: marketPdaStr, attempts: n,
        });
        this.emit("error-state", rec);
        this.inFlight.delete(marketPdaStr);
        return;
      }
      const delay = Math.min(this.cfg.settleBaseDelayMs * 2 ** (n - 1), this.cfg.settleMaxDelayMs);
      this.log.info(`retrying settlement in ${Math.round(delay / 1000)}s`, { market: marketPdaStr, nextAttempt: n + 1 });
      this.store.saveSoon();
      setTimeout(() => void this.attempt(marketPdaStr, fixtureId, seq), delay);
    }
  }

  private async buildProof(fixtureId: number, seq: number) {
    if (this.cfg.oracleMode === "mock") {
      const fx = this.replayFixture;
      if (!fx || fx.fixtureId !== fixtureId) throw new Error("no replay recording for fixture");
      // Prefer the recorded REAL proof's stats as ground truth for the final.
      const stats = fx.realProof?.response?.statsToProve;
      const p1 = stats?.[0]?.value ?? fx.finalScore.p1;
      const p2 = stats?.[1]?.value ?? fx.finalScore.p2;
      const tsMs = fx.realProof?.response?.summary?.updateStats?.minTimestamp ?? fx.finalisedTsMs;
      const { proof, epochDay } = await this.chain.buildAndPublishMockProof(fixtureId, tsMs, p1, p2);
      return { proof, epochDay, p1, p2 };
    }

    // Live: fetch the real proof from TxLINE.
    if (!this.client) throw new Error("live mode requires a TxLine client");
    const val = await this.client.statValidation(fixtureId, seq, this.cfg.statKeys as any);
    const p1 = val.statsToProve[0].value;
    const p2 = val.statsToProve[1].value;
    const tsMs = val.summary.updateStats.minTimestamp;
    const epochDay = epochDayOf(tsMs);
    const proof = {
      ts: new BN(tsMs),
      fixtureSummary: {
        fixtureId: new BN(val.summary.fixtureId),
        updateStats: {
          updateCount: val.summary.updateStats.updateCount,
          minTimestamp: new BN(val.summary.updateStats.minTimestamp),
          maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
        },
        eventsSubTreeRoot: toBytes32(val.summary.eventStatsSubTreeRoot),
      },
      fixtureProof: mapProof(val.subTreeProof),
      mainTreeProof: mapProof(val.mainTreeProof),
      eventStatRoot: toBytes32(val.eventStatRoot),
      statAValue: p1,
      statAProof: mapProof(val.statProofs[0]),
      hasStatB: true,
      statBValue: p2,
      statBProof: mapProof(val.statProofs[1]),
    };
    return { proof, epochDay, p1, p2 };
  }

  /** Persist the Proof Receipt — the structured record the frontend renders. */
  private async recordResolution(marketPdaStr: string, onchain: any, settleTx: string) {
    const rec = this.store.data.markets[marketPdaStr];
    const st = statusName(onchain.status);
    rec.phase = st === "settled" ? "settled" : "cancelled";
    rec.winningOutcome = onchain.winningOutcome;
    if (settleTx) rec.settleTx = settleTx;

    if (st === "settled") {
      const receipt: ProofReceipt = {
        marketPda: marketPdaStr,
        matchId: Number(onchain.fixtureId),
        winningOutcome: onchain.winningOutcome,
        outcomeLabel: OUTCOME_LABELS[onchain.winningOutcome] ?? String(onchain.winningOutcome),
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
      this.store.data.receipts[marketPdaStr] = receipt;
      this.log.info("PROOF RECEIPT", receipt as any);
      this.emit("receipt", receipt);
    }
    this.store.saveSoon();
    this.emit("market", rec);
  }
}

const toBytes32 = (v: any): number[] => {
  const b = Array.isArray(v) ? Uint8Array.from(v)
    : v instanceof Uint8Array ? v
    : typeof v === "string" ? (v.startsWith("0x") ? Buffer.from(v.slice(2), "hex") : Buffer.from(v, "base64"))
    : Uint8Array.from(v);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return Array.from(b);
};
const mapProof = (nodes: any[]) =>
  nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

function retryable(msg: string): Error {
  const e = new Error(msg);
  (e as any)._retryable = true;
  return e;
}

function errText(e: any): string {
  if (e?.error?.errorMessage) return String(e.error.errorMessage);
  if (e?.response?.data) return JSON.stringify(e.response.data);
  return e?.message || String(e);
}

/**
 * Retry classification. Retryable: proof/root not published yet
 * (RootNotAvailable 6007, TimeSlotMismatch 6005), REST 4xx/5xx & network
 * errors, blockhash/timeout RPC hiccups, market not locked yet. Fatal:
 * AlreadyResolved is terminal-OK (handled upstream); verification failures
 * (bad proof / OutcomeNotVerified) are NOT silently retried forever — they
 * consume the same bounded budget.
 */
function isRetryable(e: any): boolean {
  if ((e as any)?._retryable) return true;
  const code = e?.error?.errorCode?.code || "";
  if (["RootNotAvailable", "TimeSlotMismatch"].includes(code)) return true;
  if (["AlreadyResolved", "NotLocked", "WrongOracleProgram", "OracleAdapterMismatch"].includes(code)) return false;
  if (e?.response) return true; // REST error (proof not ready, 5xx, auth blip)
  const m = (e?.message || "").toLowerCase();
  if (m.includes("blockhash") || m.includes("timeout") || m.includes("timed out")) return true;
  if (m.includes("fetch") || m.includes("network") || m.includes("econn")) return true;
  // Unknown on-chain errors: retry within budget (roots may lag), then ERROR.
  return true;
}
