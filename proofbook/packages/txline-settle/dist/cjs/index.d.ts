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
export * from "./network";
export * from "./session";
export * from "./feed";
export * from "./proof";
export * from "./predicate";
export * from "./settle";
export * from "./verify";
export * from "./receipt";
/** TxLINE's txoracle program. */
export declare const TXORACLE_DEVNET = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
export declare const TXORACLE_MAINNET = "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA";
export declare const TXLINE_API_DEVNET = "https://txline-dev.txodds.com";
export declare const TXLINE_API_MAINNET = "https://txline.txodds.com";
/** `validate_stat_v3` — sha256("global:validate_stat_v3")[..8]. */
export declare const VALIDATE_STAT_V3_DISCRIMINATOR: number[];
/** `validate_stat_v2` — the legacy path, kept for compatibility. */
export declare const VALIDATE_STAT_V2_DISCRIMINATOR: number[];
/** The daily-roots PDA seed. `["daily_scores_roots", u16_le(epochDay)]`. */
export declare const DAILY_SCORES_SEED = "daily_scores_roots";
export declare const MS_PER_DAY = 86400000;
/** TxLINE's proof API accepts between 1 and 5 stat keys. Not negotiable. */
export declare const MAX_STAT_KEYS = 5;
export declare const epochDayOf: (tsMs: number) => number;
