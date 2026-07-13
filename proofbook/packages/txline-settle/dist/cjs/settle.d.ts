/**
 * The CPI helper: derive the roots PDA, and verify a proof against the REAL
 * txoracle program without sending anything.
 */
import { PublicKey, Connection } from "@solana/web3.js";
import type { NDimensionalStrategy } from "./predicate";
/**
 * TxLINE's daily-roots PDA: `["daily_scores_roots", u16_le(epochDay)]`.
 *
 * The u16 is the whole seed — note the truncation. It is derived from the PROOF's
 * timestamp, not from the wall clock, and passing the wrong day is the single
 * most common way to get an opaque failure.
 */
export declare function dailyRootsPda(epochDay: number, oracleProgram?: PublicKey | string): PublicKey;
/**
 * Ask TxLINE's program whether a proof holds — by SIMULATION, no transaction.
 *
 * This is the whole trust story in one call: you can run it from a browser, a
 * script, or a CI job, and the answer comes from TxLINE's deployed program
 * checking the multiproof against the root TxLINE itself published on Solana.
 * Nobody's API is in the loop.
 */
export declare function verifyWithOracle(opts: {
    txoracle: any;
    payload: any;
    strategy: NDimensionalStrategy;
    epochDay: number;
    computeUnits?: number;
}): Promise<boolean>;
/**
 * Does the TxLINE root account for this day actually exist, and is it TxLINE's?
 *
 * Roots land on batch boundaries, so a freshly-finalised match can be provable by
 * the API minutes before its root is on-chain. Settling then fails with
 * RootNotAvailable — retry, do not treat it as fatal.
 */
export declare function rootIsPublished(connection: Connection, epochDay: number, oracleProgram?: PublicKey | string): Promise<boolean>;
