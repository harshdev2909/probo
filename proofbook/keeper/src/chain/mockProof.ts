import { BN } from "@coral-xyz/anchor";
import { keccak_256 } from "js-sha3";
import { epochDayOf } from "./pdas";

/**
 * Builds a SettlementProof verifiable by the bundled `mock_oracle` program
 * (replay/local mode only). Byte-identical to the mock's keccak scheme:
 * leaf = keccak256("leaf:" ‖ borsh(payload)); parent = keccak256("node:" ‖ L ‖ R).
 * The stat period is parameterised so replays use the finalised period (100)
 * exactly like the real proven flow.
 */

const keccak = (...parts: Buffer[]): Buffer =>
  Buffer.from(keccak_256.arrayBuffer(Buffer.concat(parts)));
const leafHash = (b: Buffer) => keccak(Buffer.from("leaf:"), b);
const combine = (node: Buffer, sib: Buffer, sibIsRight: boolean) =>
  sibIsRight
    ? keccak(Buffer.from("node:"), node, sib)
    : keccak(Buffer.from("node:"), sib, node);

function encScoreStat(key: number, value: number, period: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(key >>> 0, 0);
  b.writeInt32LE(value, 4);
  b.writeInt32LE(period, 8);
  return b;
}

function encFixtureSummary(
  fixtureId: BN,
  updateCount: number,
  minTs: BN,
  maxTs: BN,
  subRoot: Buffer
): Buffer {
  const cnt = Buffer.alloc(4);
  cnt.writeInt32LE(updateCount, 0);
  return Buffer.concat([
    fixtureId.toArrayLike(Buffer, "le", 8),
    cnt,
    minTs.toArrayLike(Buffer, "le", 8),
    maxTs.toArrayLike(Buffer, "le", 8),
    subRoot,
  ]);
}

export interface BuiltMockProof {
  proof: any; // proofbook SettlementProof (camelCase)
  dailyRoot: number[];
  epochDay: number;
}

export function buildMockProof(
  goalsA: number,
  goalsB: number,
  fixtureId: BN,
  tsMs: BN,
  period: number,
  statKeys: [number, number] = [1, 2]
): BuiltMockProof {
  const leafA = leafHash(encScoreStat(statKeys[0], goalsA, period));
  const leafB = leafHash(encScoreStat(statKeys[1], goalsB, period));
  const subRoot = combine(leafA, leafB, true); // A left, B right

  const fixtureSummary = {
    fixtureId,
    updateStats: { updateCount: 1, minTimestamp: tsMs, maxTimestamp: tsMs },
    eventsSubTreeRoot: Array.from(subRoot),
  };
  const dailyRoot = leafHash(
    encFixtureSummary(fixtureId, 1, tsMs, tsMs, subRoot)
  );

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
    epochDay: epochDayOf(tsMs.toNumber()),
  };
}
