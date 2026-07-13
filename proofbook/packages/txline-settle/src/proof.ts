/**
 * Fetch a v3 multiproof and shape it for the CPI.
 *
 * v3 replaces v2's per-stat sibling paths with ONE shared Merkle multiproof. On a
 * real 4-leg proof that is 22 nodes -> 6, and the size barely grows as legs are
 * added, because the leaves share almost all of their internal nodes.
 */
import { MAX_STAT_KEYS, epochDayOf } from "./index";
import type { TxLineSession } from "./session";

export interface ProofNode {
  hash: number[];
  isRightSibling: boolean;
}

export interface StatValidationInputV3 {
  ts: any; // BN
  fixtureSummary: any;
  fixtureProof: ProofNode[];
  mainTreeProof: ProofNode[];
  eventStatRoot: number[];
  leaves: { stat: { key: number; value: number; period: number }; statProof: ProofNode[] }[];
  multiproofHashes: ProofNode[];
  leafIndices: number[];
}

const b32 = (v: any): number[] => Array.from(Buffer.from(v));
const node = (n: any): ProofNode => ({
  hash: Array.from(Buffer.from(n.hash ?? n)),
  isRightSibling: !!n.isRightSibling,
});

/** The finalised sequence number for a fixture (statusId 100 = game_finalised). */
export async function findFinalisedSeq(
  session: TxLineSession,
  fixtureId: number
): Promise<number> {
  const rows = await session.get<any[]>(`/scores/snapshot/${fixtureId}`);
  if (!rows.length) {
    throw new Error(
      `TxLINE retains no records for fixture ${fixtureId}. Scores age out after ` +
        `roughly 23 days — the result is NOT provable, and you must not pretend it is.`
    );
  }
  const finalised = rows.filter((r) => r.StatusId === 100);
  return (finalised.length ? finalised : rows).reduce(
    (mx, r) => Math.max(mx, r.Seq ?? 0),
    0
  );
}

/**
 * Fetch the raw v3 proof. `statKeys` order defines the leaf index space that your
 * predicates reference — keep it identical to your legs.
 */
export async function fetchProofV3(
  session: TxLineSession,
  fixtureId: number,
  seq: number,
  statKeys: number[]
): Promise<any> {
  if (statKeys.length < 1 || statKeys.length > MAX_STAT_KEYS) {
    throw new Error(
      `${statKeys.length} stat keys requested; TxLINE accepts 1..${MAX_STAT_KEYS}.`
    );
  }
  return session.get(
    `/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(",")}`
  );
}

/** Shape a raw v3 response into the `validate_stat_v3` payload. */
export function toPayloadV3(val: any, BN: any): StatValidationInputV3 {
  return {
    ts: new BN(val.summary.updateStats.minTimestamp),
    fixtureSummary: {
      fixtureId: new BN(val.summary.fixtureId),
      updateStats: {
        updateCount: val.summary.updateStats.updateCount,
        minTimestamp: new BN(val.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: b32(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: (val.subTreeProof ?? []).map(node),
    mainTreeProof: (val.mainTreeProof ?? []).map(node),
    eventStatRoot: b32(val.eventStatRoot),
    leaves: val.statsToProve.map((l: any) => ({
      stat: l.stat,
      statProof: (l.statProof ?? []).map(node), // empty in v3 — the multiproof replaces them
    })),
    multiproofHashes: (val.multiproof.hashes ?? []).map(node),
    leafIndices: val.multiproof.indices,
  };
}

/** The proven values, in leg order. */
export const provenValues = (val: any): number[] =>
  val.statsToProve.map((l: any) => l.stat.value);

/** The epoch day whose root this proof authenticates against. */
export const proofEpochDay = (val: any): number =>
  epochDayOf(val.summary.updateStats.minTimestamp);
