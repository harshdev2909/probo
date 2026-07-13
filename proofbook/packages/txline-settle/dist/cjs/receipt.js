"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyReceipt = verifyReceipt;
exports.reconstructReceipt = reconstructReceipt;
/**
 * Receipt reconstruction — rebuild a settlement from chain, and check it against
 * TxLINE without believing whoever showed it to you.
 *
 * The five facts a receipt rests on, and where each must come from:
 *
 *   settlement   the settling program's own account       (Solana)
 *   predicate    the same account — fixed at creation      (Solana)
 *   merkle root  TxLINE's OWN daily-roots PDA             (Solana)
 *   proof        TxLINE's API                             (TxLINE)
 *   verdict      TxLINE's OWN program                     (Solana simulation)
 *
 * Note what is absent: the settling protocol's API and database. A receipt that
 * can only be checked by asking the protocol whether it is telling the truth is
 * not a receipt.
 */
const web3_js_1 = require("@solana/web3.js");
const proof_1 = require("./proof");
const settle_1 = require("./settle");
/**
 * Verify a settlement end-to-end. `strategy` and `statKeys` must come from the
 * settling program's on-chain spec — if you pass what the protocol's API told
 * you, you have verified nothing.
 */
async function verifyReceipt(opts) {
    const { connection, session, txoracle, BN, fixtureId, statKeys, strategy } = opts;
    const seq = opts.seq ?? (await (0, proof_1.findFinalisedSeq)(session, fixtureId));
    const val = await (0, proof_1.fetchProofV3)(session, fixtureId, seq, statKeys);
    const epochDay = (0, proof_1.proofEpochDay)(val);
    const rootsPda = (await Promise.resolve().then(() => __importStar(require("./settle")))).dailyRootsPda(epochDay, txoracle.programId);
    if (!(await (0, settle_1.rootIsPublished)(connection, epochDay, txoracle.programId))) {
        return {
            verified: false,
            fixtureId,
            provenValues: [],
            epochDay,
            rootsPda: rootsPda.toBase58(),
            reason: "TxLINE has not published a root for that day yet. Roots land on batch " +
                "boundaries — retry, do not treat this as a failed proof.",
        };
    }
    const payload = (0, proof_1.toPayloadV3)(val, BN);
    const verified = await (0, settle_1.verifyWithOracle)({
        txoracle,
        payload,
        strategy,
        epochDay,
    });
    return {
        verified,
        fixtureId,
        provenValues: val.statsToProve.map((l) => l.stat.value),
        epochDay,
        rootsPda: rootsPda.toBase58(),
        reason: verified ? undefined : "TxLINE's program did not verify this claim.",
    };
}
/**
 * Rebuild the receipt a settled market carries, reading only Solana accounts.
 * `settlerIdl` is the settling program's IDL (used purely as an account decoder).
 */
async function reconstructReceipt(opts) {
    const { anchor, connection } = opts;
    const market = new web3_js_1.PublicKey(opts.marketPda);
    const provider = new anchor.AnchorProvider(connection, {
        publicKey: market,
        signTransaction: async (t) => t,
        signAllTransactions: async (t) => t,
    }, { commitment: "confirmed" });
    const prog = new anchor.Program(opts.settlerIdl, provider);
    const m = await prog.account.market.fetch(market);
    const out = {
        marketPda: opts.marketPda,
        fixtureId: Number(m.fixtureId),
        marketType: Number(m.marketType),
        status: Object.keys(m.status)[0],
        winningOutcome: m.winningOutcome === 255 ? null : Number(m.winningOutcome),
        proofRef: Buffer.from(m.settleProofRef).toString("hex"),
        proofTs: Number(m.settleProofTs),
        epochDay: Number(m.settleEpochDay),
        dailyRootsPda: m.settleDailyRoots.toBase58(),
        resolver: m.settleResolver.toBase58(),
        settledAt: Number(m.settledAt),
        totalPool: m.totalPool.toString(),
        totalWinningPool: m.totalWinningPool?.toString() ?? "0",
        feeAmount: m.feeAmount?.toString() ?? "0",
    };
    if (out.marketType >= 16) {
        const [comboPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("combo"), market.toBuffer()], prog.programId);
        try {
            const combo = await prog.account.comboSpec.fetch(comboPda);
            out.legs = combo.legs.map((l) => ({ key: l.key, period: l.period }));
        }
        catch {
            /* no sidecar — leave legs absent */
        }
    }
    return out;
}
