"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dailyRootsPda = dailyRootsPda;
exports.verifyWithOracle = verifyWithOracle;
exports.rootIsPublished = rootIsPublished;
/**
 * The CPI helper: derive the roots PDA, and verify a proof against the REAL
 * txoracle program without sending anything.
 */
const web3_js_1 = require("@solana/web3.js");
const index_1 = require("./index");
/**
 * TxLINE's daily-roots PDA: `["daily_scores_roots", u16_le(epochDay)]`.
 *
 * The u16 is the whole seed — note the truncation. It is derived from the PROOF's
 * timestamp, not from the wall clock, and passing the wrong day is the single
 * most common way to get an opaque failure.
 */
function dailyRootsPda(epochDay, oracleProgram = index_1.TXORACLE_DEVNET) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(epochDay & 0xffff, 0);
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from(index_1.DAILY_SCORES_SEED), b], typeof oracleProgram === "string" ? new web3_js_1.PublicKey(oracleProgram) : oracleProgram)[0];
}
/**
 * Ask TxLINE's program whether a proof holds — by SIMULATION, no transaction.
 *
 * This is the whole trust story in one call: you can run it from a browser, a
 * script, or a CI job, and the answer comes from TxLINE's deployed program
 * checking the multiproof against the root TxLINE itself published on Solana.
 * Nobody's API is in the loop.
 */
async function verifyWithOracle(opts) {
    const { txoracle, payload, strategy, epochDay } = opts;
    const ComputeBudgetProgram = require("@solana/web3.js").ComputeBudgetProgram;
    return txoracle.methods
        .validateStatV3(payload, strategy)
        .accounts({
        dailyScoresMerkleRoots: dailyRootsPda(epochDay, txoracle.programId),
    })
        .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({
            units: opts.computeUnits ?? 1400000,
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
async function rootIsPublished(connection, epochDay, oracleProgram = index_1.TXORACLE_DEVNET) {
    const pda = dailyRootsPda(epochDay, oracleProgram);
    const info = await connection.getAccountInfo(pda);
    if (!info)
        return false;
    const owner = typeof oracleProgram === "string" ? new web3_js_1.PublicKey(oracleProgram) : oracleProgram;
    return info.owner.equals(owner);
}
