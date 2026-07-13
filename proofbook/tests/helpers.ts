import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "js-sha3";

// ── Constants shared with the on-chain programs ───────────────────────────────
export const MS_PER_DAY = 86_400_000;
export const MARKET_SEED = Buffer.from("market");
export const VAULT_SEED = Buffer.from("vault");
export const POSITION_SEED = Buffer.from("position");
export const DAILY_SCORES_SEED = Buffer.from("daily_scores_roots");

// ── keccak Merkle primitives — byte-identical to `mock_oracle` ───────────────
// Rust: leaf = keccak256("leaf:" ‖ bytes); parent = keccak256("node:" ‖ L ‖ R),
// where `is_right_sibling` marks the sibling as the right child.

export function keccak(...parts: Buffer[]): Buffer {
  return Buffer.from(keccak_256.arrayBuffer(Buffer.concat(parts)));
}

export function leafHash(bytes: Buffer): Buffer {
  return keccak(Buffer.from("leaf:"), bytes);
}

/** Combine a node with a sibling. `sibIsRight` => sibling is the right child. */
export function combine(
  node: Buffer,
  sib: Buffer,
  sibIsRight: boolean
): Buffer {
  return sibIsRight
    ? keccak(Buffer.from("node:"), node, sib)
    : keccak(Buffer.from("node:"), sib, node);
}

// ── Borsh encoders (match the Rust struct field order/types exactly) ─────────

function i32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}

/** borsh(ScoreStat { key: u32, value: i32, period: i32 }) */
export function encScoreStat(
  key: number,
  value: number,
  period: number
): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(key >>> 0, 0);
  b.writeInt32LE(value, 4);
  b.writeInt32LE(period, 8);
  return b;
}

/** borsh(ScoresBatchSummary { fixture_id, {update_count,min_ts,max_ts}, sub_root }) */
export function encFixtureSummary(
  fixtureId: BN,
  updateCount: number,
  minTs: BN,
  maxTs: BN,
  subRoot: Buffer
): Buffer {
  return Buffer.concat([
    fixtureId.toArrayLike(Buffer, "le", 8),
    i32le(updateCount),
    minTs.toArrayLike(Buffer, "le", 8),
    maxTs.toArrayLike(Buffer, "le", 8),
    subRoot,
  ]);
}

export function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

export function epochDayOf(tsMs: BN): number {
  // NB: BN.divn only accepts divisors < 2^26; MS_PER_DAY exceeds that, so use div(BN).
  return tsMs.div(new BN(MS_PER_DAY)).toNumber();
}

// ── PDA derivations ──────────────────────────────────────────────────────────

export function marketPda(
  programId: PublicKey,
  authority: PublicKey,
  fixtureId: BN,
  marketType: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      MARKET_SEED,
      authority.toBuffer(),
      fixtureId.toArrayLike(Buffer, "le", 8),
      Buffer.from([marketType]),
    ],
    programId
  )[0];
}

export function vaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.toBuffer()],
    programId
  )[0];
}

export function positionPda(
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}

export function dailyRootsPda(
  mockProgramId: PublicKey,
  epochDay: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DAILY_SCORES_SEED, u16le(epochDay)],
    mockProgramId
  )[0];
}

// ── Outcome specs (1X2 on full-game goals: stat_a = P1 goals, stat_b = P2) ────
// Home: P1-P2 > 0 ; Draw: P1-P2 == 0 ; Away: P1-P2 < 0
export const OUTCOME_HOME = {
  statAKey: 1,
  statAPeriod: 0,
  hasStatB: true,
  statBKey: 2,
  statBPeriod: 0,
  op: { subtract: {} },
  comparison: { greaterThan: {} },
  threshold: 0,
};
export const OUTCOME_DRAW = {
  ...OUTCOME_HOME,
  comparison: { equalTo: {} },
};
export const OUTCOME_AWAY = {
  ...OUTCOME_HOME,
  comparison: { lessThan: {} },
};
export const OUTCOMES_1X2 = [OUTCOME_HOME, OUTCOME_DRAW, OUTCOME_AWAY];

export const OUTCOME_HOME_IDX = 0;
export const OUTCOME_DRAW_IDX = 1;
export const OUTCOME_AWAY_IDX = 2;

// ── SettlementProof builder ──────────────────────────────────────────────────
// Builds a proof that P1 scored `goalsA`, P2 scored `goalsB`, provable under a
// freshly-computed daily root. `fixtureProof`/`mainTreeProof` are empty, so the
// published daily root == keccak256("leaf:" ‖ borsh(fixtureSummary)).

export interface BuiltProof {
  proof: any; // SettlementProof (camelCase for the anchor client)
  dailyRoot: number[];
  epochDay: number;
}

export function buildProof(
  goalsA: number,
  goalsB: number,
  fixtureId: BN,
  tsMs: BN
): BuiltProof {
  const leafA = leafHash(encScoreStat(1, goalsA, 0));
  const leafB = leafHash(encScoreStat(2, goalsB, 0));
  // Two-leaf events subtree: A left, B right.
  const subRoot = combine(leafA, leafB, /* sibIsRight (B) */ true);
  const updateCount = 1;

  const fixtureSummary = {
    fixtureId,
    updateStats: { updateCount, minTimestamp: tsMs, maxTimestamp: tsMs },
    eventsSubTreeRoot: Array.from(subRoot),
  };

  const fixtureBytes = encFixtureSummary(
    fixtureId,
    updateCount,
    tsMs,
    tsMs,
    subRoot
  );
  const dailyRoot = leafHash(fixtureBytes);

  // v2: one shared `eventStatRoot` for the whole batch (== events subtree root).
  const proof = {
    ts: tsMs,
    fixtureSummary,
    fixtureProof: [],
    mainTreeProof: [],
    eventStatRoot: Array.from(subRoot),
    statAValue: goalsA,
    statAProof: [{ hash: Array.from(leafB), isRightSibling: true }],
    hasStatB: true,
    statBValue: goalsB,
    statBProof: [{ hash: Array.from(leafA), isRightSibling: false }],
  };

  return {
    proof,
    dailyRoot: Array.from(dailyRoot),
    epochDay: epochDayOf(tsMs),
  };
}

// ── Misc ─────────────────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current on-chain unix time (seconds), polled from the cluster. */
export async function onchainNow(
  connection: anchor.web3.Connection
): Promise<number> {
  const slot = await connection.getSlot();
  let t = await connection.getBlockTime(slot);
  while (t === null) {
    await sleep(200);
    t = await connection.getBlockTime(await connection.getSlot());
  }
  return t;
}

/** Wait until the cluster's on-chain unix time reaches `targetTs` (seconds). */
export async function waitUntilOnchain(
  connection: anchor.web3.Connection,
  targetTs: number
): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = await onchainNow(connection);
    if (now >= targetTs) return;
    await sleep(500);
  }
}

// ── COMBO (multi-leg) markets + v3 multiproof ────────────────────────────────

export const COMBO_SEED = Buffer.from("combo");
/** Market types >= this resolve through a ComboSpec sidecar (see constants.rs). */
export const COMBO_MARKET_TYPE_MIN = 16;

export function comboSpecPda(
  programId: PublicKey,
  market: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [COMBO_SEED, market.toBuffer()],
    programId
  )[0];
}

/** A stat this market proves: TxLINE (key, period). */
export interface Leg {
  key: number;
  period: number;
}

export const single = (
  index: number,
  comparison: any,
  threshold: number
) => ({ single: { index, comparison, threshold } });

export const binary = (
  indexA: number,
  indexB: number,
  op: any,
  comparison: any,
  threshold: number
) => ({ binary: { indexA, indexB, op, comparison, threshold } });

export const GT = { greaterThan: {} };
export const LT = { lessThan: {} };
export const EQ = { equalTo: {} };
export const ADD = { add: {} };
export const SUB = { subtract: {} };

/**
 * Build a v3 multiproof over N stat leaves, matching `mock_oracle`'s scheme.
 *
 * The tree is a perfect binary tree over `2^ceil(log2(N))` leaves (padded with
 * empty-byte leaves), so the leaf indices are simply 0..N-1. The multiproof is
 * every sibling hash the verifier cannot derive from the leaves it was given —
 * collected by walking up level by level, exactly as the on-chain verifier does.
 *
 * This is the size win, made concrete: leaves that share an ancestor pay for it
 * ONCE here, whereas a v2 proof would carry that node in every leaf's path.
 */
export function buildProofV3(
  legs: { key: number; value: number; period: number }[],
  fixtureId: BN,
  tsMs: BN
): { proof: any; dailyRoot: number[]; epochDay: number; nodesUsed: number } {
  const n = legs.length;
  if (n < 1) throw new Error("need at least one leg");

  // Pad to a power of two so every leaf has a sibling.
  let width = 1;
  while (width < n) width *= 2;

  const leaves: Buffer[] = [];
  for (let i = 0; i < width; i++) {
    leaves.push(
      i < n
        ? leafHash(encScoreStat(legs[i].key, legs[i].value, legs[i].period))
        : leafHash(Buffer.alloc(0))
    );
  }

  // Full tree, level 0 = leaves.
  const levels: Buffer[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(keccak(Buffer.from("node:"), prev[i], prev[i + 1]));
    }
    levels.push(next);
  }
  const subRoot = levels[levels.length - 1][0];

  // Collect the siblings the verifier cannot derive: walk up, and at each level
  // a known node whose sibling is NOT known contributes that sibling.
  const multiproof: { hash: number[]; isRightSibling: boolean }[] = [];
  let known = new Set<number>(legs.map((_, i) => i));
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const idxs = [...known].sort((a, b) => a - b);
    const nextKnown = new Set<number>();
    let i = 0;
    while (i < idxs.length) {
      const idx = idxs[i];
      const sib = idx ^ 1;
      if (i + 1 < idxs.length && idxs[i + 1] === sib) {
        i += 2; // both known — costs nothing
      } else {
        multiproof.push({
          hash: Array.from(levels[lvl][sib]),
          isRightSibling: sib % 2 === 1,
        });
        i += 1;
      }
      nextKnown.add(idx >> 1);
    }
    known = nextKnown;
  }

  const updateCount = 1;
  const fixtureSummary = {
    fixtureId,
    updateStats: { updateCount, minTimestamp: tsMs, maxTimestamp: tsMs },
    eventsSubTreeRoot: Array.from(subRoot),
  };
  const dailyRoot = leafHash(
    encFixtureSummary(fixtureId, updateCount, tsMs, tsMs, subRoot)
  );

  const proof = {
    ts: tsMs,
    fixtureSummary,
    fixtureProof: [],
    mainTreeProof: [],
    eventStatRoot: Array.from(subRoot),
    // Values only — the KEYS and PERIODS come from the on-chain ComboSpec.
    leafValues: legs.map((l) => l.value),
    multiproofHashes: multiproof,
    leafIndices: legs.map((_, i) => i),
  };

  return {
    proof,
    dailyRoot: Array.from(dailyRoot),
    epochDay: epochDayOf(tsMs),
    nodesUsed: multiproof.length,
  };
}
