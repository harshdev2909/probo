/**
 * Independent verification — the module that trusts nothing.
 *
 * `verifyProof` re-adjudicates a claim against TxLINE's ON-CHAIN merkle root and
 * TxLINE's OWN program, by simulation. `verifySettlement` goes further: it reads
 * a settled market account, extracts the predicate the market committed to at
 * creation, re-fetches the proof from TxLINE, and asks the oracle whether the
 * recorded winning outcome actually holds. Neither function consults anyone's
 * API or database for the verdict.
 *
 * The five facts and their only acceptable sources:
 *
 *   settlement    the settling program's account          (Solana)
 *   predicate     the same account — fixed at creation    (Solana)
 *   merkle root   TxLINE's OWN daily-roots PDA            (Solana)
 *   proof         TxLINE's API                            (TxLINE)
 *   verdict       TxLINE's OWN program, simulated         (Solana)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { type Network } from "./network";
import type { TxLineSession } from "./session";
import type { NDimensionalStrategy } from "./predicate";
export type StepKey = "settlement" | "predicate" | "root" | "proof" | "oracle";
export interface VerifyStep {
    key: StepKey;
    ok: boolean;
    detail: string;
    evidence?: Record<string, string>;
}
export interface VerifyOutcome {
    verified: boolean;
    steps: VerifyStep[];
    /** The values the merkle proof attests, in leg order. */
    provenValues?: number[];
}
/** Build a read-only Anchor Program whose simulated payer EXISTS.
 *
 * `.view()` simulates a transaction, and a payer that does not exist fails with
 * an EMPTY error before the program runs — the least debuggable failure in this
 * whole stack. Always pass an account you know exists (a settlement's resolver
 * is ideal: it demonstrably paid a fee once).
 */
export declare function readOnlyProgram(anchor: any, connection: Connection, idl: any, payer: PublicKey): any;
export interface VerifyProofOpts {
    anchor: any;
    connection: Connection;
    session: TxLineSession;
    txoracleIdl: any;
    fixtureId: number;
    statKeys: number[];
    strategy: NDimensionalStrategy;
    /** A payer that exists. Defaults to the txoracle program id itself (executable accounts exist). */
    payer?: PublicKey;
    network?: Network;
    seq?: number;
    /** Corrupt one proven value first — to demonstrate a forgery is rejected. */
    tamper?: boolean;
}
/**
 * Verify a claim ("these stats satisfy this strategy for this fixture") against
 * the live oracle. Returns the oracle's verdict; throws only on infrastructure
 * failure, never on a negative verdict.
 */
export declare function verifyProof(opts: VerifyProofOpts): Promise<{
    verified: boolean;
    provenValues: number[];
    epochDay: number;
    rootsPda: string;
}>;
export interface VerifySettlementOpts {
    anchor: any;
    connection: Connection;
    session: TxLineSession;
    txoracleIdl: any;
    /** The settling program's IDL (e.g. ProofBook's) — used ONLY to read accounts. */
    settlerIdl: any;
    marketPda: string;
    network?: Network;
    tamper?: boolean;
    onStep?: (s: VerifyStep) => void;
}
/**
 * Re-derive a settlement end to end. The market account supplies the predicate
 * (never the caller, never an API), TxLINE supplies the proof, the oracle
 * supplies the verdict.
 *
 * Convention understood: `market_type >= 16` means the predicate lives in a
 * `ComboSpec` PDA at ["combo", market]; below that it is the market's own
 * per-outcome spec (1–2 stats). This matches the reference Rust module.
 */
export declare function verifySettlement(opts: VerifySettlementOpts): Promise<VerifyOutcome>;
