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
import { Connection } from "@solana/web3.js";
import type { TxLineSession } from "./session";
import type { NDimensionalStrategy } from "./predicate";
export interface VerifiedReceipt {
    verified: boolean;
    fixtureId: number;
    /** The values the merkle proof attests — never a feed's sampled score. */
    provenValues: number[];
    epochDay: number;
    rootsPda: string;
    reason?: string;
}
/**
 * Verify a settlement end-to-end. `strategy` and `statKeys` must come from the
 * settling program's on-chain spec — if you pass what the protocol's API told
 * you, you have verified nothing.
 */
export declare function verifyReceipt(opts: {
    connection: Connection;
    session: TxLineSession;
    txoracle: any;
    BN: any;
    fixtureId: number;
    statKeys: number[];
    strategy: NDimensionalStrategy;
    seq?: number;
}): Promise<VerifiedReceipt>;
/** A settlement receipt, reconstructed FROM CHAIN — no database involved. */
export interface ChainReceipt {
    marketPda: string;
    fixtureId: number;
    marketType: number;
    status: string;
    winningOutcome: number | null;
    /** Hex events-subtree root the settlement proved against. */
    proofRef: string;
    proofTs: number;
    epochDay: number;
    dailyRootsPda: string;
    resolver: string;
    settledAt: number;
    totalPool: string;
    totalWinningPool: string;
    feeAmount: string;
    /** Present for compound markets (market_type >= 16). */
    legs?: {
        key: number;
        period: number;
    }[];
}
/**
 * Rebuild the receipt a settled market carries, reading only Solana accounts.
 * `settlerIdl` is the settling program's IDL (used purely as an account decoder).
 */
export declare function reconstructReceipt(opts: {
    anchor: any;
    connection: Connection;
    settlerIdl: any;
    marketPda: string;
}): Promise<ChainReceipt>;
