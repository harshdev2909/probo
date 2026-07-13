import type { Keypair } from "@solana/web3.js";
/** Fetch a guest JWT — no credentials, no wallet. Enough for /auth, not for proofs. */
export declare function guestAuth(origin: string): Promise<string>;
export interface SessionOpts {
    origin: string;
    /** Signs the activation message. Also the subscribing wallet. */
    wallet?: Keypair;
    /** Performs the on-chain `subscribe`; see the CLI's `auth` for a reference. */
    subscribe?: () => Promise<string>;
    /** Reuse existing credentials instead of subscribing (e.g. from a cache). */
    jwt?: string;
    apiToken?: string;
    leagues?: string[];
}
export declare class TxLineSession {
    private opts;
    jwt?: string;
    apiToken?: string;
    constructor(opts: SessionOpts);
    headers(): Record<string, string>;
    /** Obtain both credentials if missing. Idempotent. */
    ensure(): Promise<void>;
    renewJwt(): Promise<string>;
    /**
     * Subscribe on-chain, then exchange the transaction signature for an API token.
     * The activation message is `{txSig}:{leagues.join(",")}:{jwt}`, signed with the
     * subscribing wallet (NaCl detached, base64).
     */
    activate(): Promise<string>;
    /** GET with automatic 401-renew / 403-resubscribe. */
    get<T = any>(path: string): Promise<T>;
}
