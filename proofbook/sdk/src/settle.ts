/**
 * The CPI helper: derive the roots PDA, and verify a proof against the REAL
 * txoracle program without sending anything.
 */
import { PublicKey, Connection } from "@solana/web3.js";
import { DAILY_SCORES_SEED, TXORACLE_DEVNET } from "./index";
import type { NDimensionalStrategy } from "./predicate";

/**
 * TxLINE's daily-roots PDA: `["daily_scores_roots", u16_le(epochDay)]`.
 *
 * The u16 is the whole seed — note the truncation. It is derived from the PROOF's
 * timestamp, not from the wall clock, and passing the wrong day is the single
 * most common way to get an opaque failure.
 */
export function dailyRootsPda(
  epochDay: number,
  oracleProgram: PublicKey | string = TXORACLE_DEVNET
): PublicKey {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(epochDay & 0xffff, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DAILY_SCORES_SEED), b],
    typeof oracleProgram === "string" ? new PublicKey(oracleProgram) : oracleProgram
  )[0];
}

/**
 * Ask TxLINE's program whether a proof holds — by SIMULATION, no transaction.
 *
 * This is the whole trust story in one call: you can run it from a browser, a
 * script, or a CI job, and the answer comes from TxLINE's deployed program
 * checking the multiproof against the root TxLINE itself published on Solana.
 * Nobody's API is in the loop.
 */
export async function verifyWithOracle(opts: {
  txoracle: any; // anchor.Program for the txoracle IDL
  payload: any;
  strategy: NDimensionalStrategy;
  epochDay: number;
  computeUnits?: number;
}): Promise<boolean> {
  const { txoracle, payload, strategy, epochDay } = opts;
  const ComputeBudgetProgram = require("@solana/web3.js").ComputeBudgetProgram;
  return txoracle.methods
    .validateStatV3(payload, strategy)
    .accounts({
      dailyScoresMerkleRoots: dailyRootsPda(epochDay, txoracle.programId),
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({
        units: opts.computeUnits ?? 1_400_000,
      }),
    ])
    .view();
}

/**
 * Does the TxLINE root account for this day actually exist, and is it TxLINE's?
 *
 * Roots land on batch boundaries, so a freshly-finalised match can be provable by
 * the API minutes before its root is on-chain. Settling then fails with
 * RootNotAvailable — retry, do not treat it as fatal.
 */
export async function rootIsPublished(
  connection: Connection,
  epochDay: number,
  oracleProgram: PublicKey | string = TXORACLE_DEVNET
): Promise<boolean> {
  const pda = dailyRootsPda(epochDay, oracleProgram);
  const info = await connection.getAccountInfo(pda);
  if (!info) return false;
  const owner =
    typeof oracleProgram === "string" ? new PublicKey(oracleProgram) : oracleProgram;
  return info.owner.equals(owner);
}
