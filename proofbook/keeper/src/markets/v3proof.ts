/**
 * Assemble a `SettlementProofV3` from TxLINE's v3 multiproof response.
 *
 * ONE implementation, shared by the backfiller and the live settler. The v2 code
 * had this assembly duplicated verbatim in `core/settler.ts` and
 * `scripts/backfill-settle.ts`, which is how the two drifted (only the backfill
 * path ever recorded the proven scoreline).
 *
 * The trustless binding lives in what this does NOT send: the caller supplies
 * proven VALUES and Merkle material, but never the stat keys or the predicate.
 * Those come from the market's on-chain ComboSpec, so a caller cannot substitute
 * a stat, or a predicate, that suits it.
 */
import { BN } from "@coral-xyz/anchor";

import { Logger } from "../logger";
import { epochDayOf } from "../chain/pdas";
import type { MarketTypeDef } from "./catalogue";

const log = new Logger("v3proof");

export const toBytes32 = (v: any): number[] => {
  const b = Array.isArray(v)
    ? Uint8Array.from(v)
    : v instanceof Uint8Array
    ? v
    : typeof v === "string"
    ? v.startsWith("0x")
      ? Buffer.from(v.slice(2), "hex")
      : Buffer.from(v, v.length === 64 ? "hex" : "base64")
    : Uint8Array.from(v);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return Array.from(b);
};

export const mapProof = (nodes: any[]) =>
  (nodes || []).map((n) => ({
    hash: toBytes32(n.hash ?? n),
    isRightSibling: !!n.isRightSibling,
  }));

export interface BuiltV3 {
  /** The anchor-shaped SettlementProofV3. */
  proof: any;
  epochDay: number;
  /** Proven value per leg, in the market's leg order. */
  values: number[];
  /** The ScoreStat period the proof commits to (100 = game_finalised). */
  period: number;
}

/**
 * Build the v3 settlement proof for a compound market.
 *
 * `def.legs` order IS the statKeys request order IS the leaf order IS the index
 * space the ComboSpec's predicates reference. If those ever disagreed, the market
 * would settle on the wrong stats, so this asserts the API returned exactly the
 * keys we asked for, in order, before anything is signed.
 */
export function buildV3Proof(
  val: any,
  def: MarketTypeDef,
  fixtureId: number
): BuiltV3 {
  const leaves: any[] = val.statsToProve;
  if (!Array.isArray(leaves) || leaves.length !== def.legs.length) {
    throw new Error(
      `proof has ${leaves?.length} leaves, market ${def.slug} has ${def.legs.length} legs`
    );
  }

  // The leaf order defines the predicate index space. Verify it, do not assume it.
  leaves.forEach((l, i) => {
    const want = def.legs[i];
    if (l.stat.key !== want.key) {
      throw new Error(
        `leg ${i}: proof carries stat key ${l.stat.key}, ComboSpec pins ${want.key}. ` +
          `Settling would evaluate the predicate against the wrong stat.`
      );
    }
  });

  const period = leaves[0].stat.period;
  // The ComboSpec pins the period too; a mismatch cannot settle (the leaf the
  // program builds would not be the leaf the multiproof authenticates).
  const specPeriod = def.legs[0].period;
  if (period !== specPeriod) {
    log.warn(
      "period mismatch — the proof does not carry the period this market pins",
      { fixtureId, slug: def.slug, proofPeriod: period, specPeriod }
    );
  }

  const tsMs = val.summary.updateStats.minTimestamp;

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
    // Values only. Keys and periods come from the on-chain ComboSpec.
    leafValues: leaves.map((l) => l.stat.value),
    multiproofHashes: mapProof(val.multiproof.hashes),
    leafIndices: val.multiproof.indices,
  };

  return {
    proof,
    epochDay: epochDayOf(tsMs),
    values: leaves.map((l) => l.stat.value),
    period,
  };
}

/**
 * Which outcome of a compound market do the proven values satisfy?
 *
 * Evaluated locally, with the SAME semantics the oracle uses (AND of predicates
 * over the leg values), purely to decide which outcome to CLAIM. It has no
 * authority: the chain re-derives the predicate from the ComboSpec and re-proves
 * it against the merkle root, so a wrong guess here settles nothing — it just
 * fails with OutcomeNotVerified.
 *
 * Returns -1 if no outcome matches, which for an exhaustive catalogue means the
 * data is not what we think it is — never settle in that case.
 */
export function claimedOutcomeFor(def: MarketTypeDef, values: number[]): number {
  const cmp = (v: number, c: any, t: number) =>
    "greaterThan" in c ? v > t : "lessThan" in c ? v < t : v === t;

  for (let i = 0; i < def.outcomes.length; i++) {
    const ok = def.outcomes[i].predicates.every((p: any) => {
      if ("single" in p) {
        return cmp(values[p.single.index], p.single.comparison, p.single.threshold);
      }
      const { indexA, indexB, op, comparison, threshold } = p.binary;
      const combined =
        "add" in op ? values[indexA] + values[indexB] : values[indexA] - values[indexB];
      return cmp(combined, comparison, threshold);
    });
    if (ok) return i;
  }
  return -1;
}
