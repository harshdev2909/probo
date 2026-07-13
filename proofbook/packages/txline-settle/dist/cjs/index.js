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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.epochDayOf = exports.MAX_STAT_KEYS = exports.MS_PER_DAY = exports.DAILY_SCORES_SEED = exports.VALIDATE_STAT_V2_DISCRIMINATOR = exports.VALIDATE_STAT_V3_DISCRIMINATOR = exports.TXLINE_API_MAINNET = exports.TXLINE_API_DEVNET = exports.TXORACLE_MAINNET = exports.TXORACLE_DEVNET = void 0;
/**
 * @proofbook/txline-settle
 *
 * Settle a Solana market against a real TxLINE Merkle proof.
 *
 * Everything ProofBook learned about TxLINE's on-chain interface, extracted so
 * the next program does not have to learn it again — including the three
 * constraints that are not written down anywhere and that will otherwise cost you
 * a day each:
 *
 *   1. at most FIVE stat keys per proof
 *   2. every proven stat must be evaluated EXACTLY ONCE
 *   3. therefore a compound predicate's legs must read DISJOINT stats —
 *      "home win AND over 2.5 goals" is impossible, "home win AND over 9.5
 *      corners" is fine
 *
 * The library refuses to build a predicate that violates any of them, at the
 * point you build it, rather than letting you find out from a failed CPI.
 */
__exportStar(require("./network"), exports);
__exportStar(require("./session"), exports);
__exportStar(require("./feed"), exports);
__exportStar(require("./proof"), exports);
__exportStar(require("./predicate"), exports);
__exportStar(require("./settle"), exports);
__exportStar(require("./verify"), exports);
__exportStar(require("./receipt"), exports);
/** TxLINE's txoracle program. */
exports.TXORACLE_DEVNET = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
exports.TXORACLE_MAINNET = "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA";
exports.TXLINE_API_DEVNET = "https://txline-dev.txodds.com";
exports.TXLINE_API_MAINNET = "https://txline.txodds.com";
/** `validate_stat_v3` — sha256("global:validate_stat_v3")[..8]. */
exports.VALIDATE_STAT_V3_DISCRIMINATOR = [
    150, 37, 155, 89, 141, 190, 77, 203,
];
/** `validate_stat_v2` — the legacy path, kept for compatibility. */
exports.VALIDATE_STAT_V2_DISCRIMINATOR = [
    208, 215, 194, 214, 241, 71, 246, 178,
];
/** The daily-roots PDA seed. `["daily_scores_roots", u16_le(epochDay)]`. */
exports.DAILY_SCORES_SEED = "daily_scores_roots";
exports.MS_PER_DAY = 86400000;
/** TxLINE's proof API accepts between 1 and 5 stat keys. Not negotiable. */
exports.MAX_STAT_KEYS = 5;
const epochDayOf = (tsMs) => Math.floor(tsMs / exports.MS_PER_DAY);
exports.epochDayOf = epochDayOf;
