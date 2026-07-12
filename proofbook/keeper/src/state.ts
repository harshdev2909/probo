import * as fs from "fs";
import * as path from "path";
import { Logger } from "./logger";

/**
 * Persisted keeper state: a simple, atomic JSON store. Deliberately boring —
 * reliability over sophistication. Safe across restarts (idempotency anchors).
 */

export interface FixtureLive {
  fixtureId: number;
  competitionId?: number;
  name?: string;
  /** Real TxLINE participant names (source of truth; never guessed). */
  homeName?: string;
  awayName?: string;
  stage?: string;
  /**
   * Whether this fixture's result can be PROVEN from TxLINE.
   *   proven   — a real merkle proof exists; the market settles and earns a receipt
   *   no_proof — outside TxLINE's retention window. We show the fixture, we do NOT
   *              show a scoreline, and we never fabricate a receipt.
   *   upcoming — not played yet
   */
  proofStatus?: "proven" | "no_proof" | "upcoming";
  gapReason?: string;
  kickoffTs?: number; // unix seconds
  lastSeq?: number;
  lastTs?: number; // unix ms of last score update
  statusId?: number; // in-play phase; 100 = game_finalised
  score?: { p1: number; p2: number };
  finalisedSeq?: number;
  lastUpdateAt?: string;
}

export type MarketPhase =
  | "created"
  | "locked"
  | "settling"
  | "settled"
  | "cancelled"
  | "error";

export interface MarketRecord {
  marketPda: string;
  fixtureId: number;
  marketType: number;
  phase: MarketPhase;
  lockTime: number; // unix seconds
  resolutionTimeout: number; // seconds
  usdcMint: string;
  createdTx?: string;
  lockTx?: string;
  settleTx?: string;
  cancelTx?: string;
  winningOutcome?: number;
  settleAttempts?: number;
  lastError?: string;
}

export interface ProofReceipt {
  marketPda: string;
  matchId: number;
  winningOutcome: number;
  /**
   * The goal values the merkle proof actually attests — NOT the feed's `Score`
   * field, which is sampled and has been observed to disagree with the proof.
   * If it isn't proven, it isn't here.
   */
  provenScore?: { p1: number; p2: number };
  statPeriod?: number;
  outcomeLabel: string;
  oracleProgram: string;
  epochDay: number;
  dailyRootsPda: string;
  proofRef: string; // hex events-subtree root
  resolver: string;
  settleTx: string;
  settledAt: number;
  totalPool: string;
  totalWinningPool: string;
  feeAmount: string;
}

/**
 * What the keeper needs from a store. The JSON `Store` (replay/local) and the
 * Postgres `PgStore` (live) both satisfy it, so the keeper core never knows or
 * cares which one it is holding.
 */
export interface StoreLike {
  data: StoreData;
  fixture(id: number): FixtureLive;
  marketByFixture(
    fixtureId: number,
    marketType: number
  ): MarketRecord | undefined;
  saveSoon(): void;
  flush(): void;
}

export interface StoreData {
  fixtures: Record<string, FixtureLive>;
  markets: Record<string, MarketRecord>; // key = marketPda
  receipts: Record<string, ProofReceipt>; // key = marketPda
  session: { jwt?: string; apiToken?: string };
  mints: { usdcMint?: string };
}

const EMPTY: StoreData = {
  fixtures: {},
  markets: {},
  receipts: {},
  session: {},
  mints: {},
};

export class Store {
  data: StoreData;
  private file: string;
  private log = new Logger("store");
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "state.json");
    try {
      this.data = {
        ...EMPTY,
        ...JSON.parse(fs.readFileSync(this.file, "utf8")),
      };
      this.log.info("state loaded", {
        fixtures: Object.keys(this.data.fixtures).length,
        markets: Object.keys(this.data.markets).length,
      });
    } catch {
      this.data = JSON.parse(JSON.stringify(EMPTY));
    }
  }

  /** Debounced, atomic (tmp + rename) persistence. */
  saveSoon() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    }, 250);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  fixture(id: number): FixtureLive {
    const k = String(id);
    if (!this.data.fixtures[k]) this.data.fixtures[k] = { fixtureId: id };
    return this.data.fixtures[k];
  }

  marketByFixture(
    fixtureId: number,
    marketType: number
  ): MarketRecord | undefined {
    return Object.values(this.data.markets).find(
      (m) => m.fixtureId === fixtureId && m.marketType === marketType
    );
  }
}
