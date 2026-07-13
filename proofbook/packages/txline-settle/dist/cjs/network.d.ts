/**
 * Network configuration — the SDK works against devnet and mainnet; everything
 * that differs between them lives here and nowhere else.
 */
export interface Network {
    /** TxLINE's on-chain oracle (the `txoracle` program). */
    oracleProgram: string;
    /** TxLINE's REST/SSE origin. */
    apiOrigin: string;
    /** TxL subscription mint (Token-2022) for the on-chain subscribe. */
    txlMint: string;
    cluster: "devnet" | "mainnet-beta";
}
export declare const DEVNET: Network;
export declare const MAINNET: Network;
