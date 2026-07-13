"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TxLineSession = void 0;
exports.guestAuth = guestAuth;
/**
 * TxLINE auth: guest JWT + the on-chain subscription that yields an API token.
 *
 * A guest JWT alone is NOT enough — the proof endpoint answers
 * `403 Missing API token`. The API token comes from an on-chain subscription
 * (free for the World Cup tier), which is why this needs a wallet.
 *
 * Both credentials self-heal: 401 renews the JWT, 403 re-subscribes. Renewing a
 * JWT cannot fix a rejected API token, and conflating the two leaves you retrying
 * forever against a subscription that has lapsed.
 */
const tweetnacl_1 = __importDefault(require("tweetnacl"));
/** Fetch a guest JWT — no credentials, no wallet. Enough for /auth, not for proofs. */
async function guestAuth(origin) {
    const r = await fetch(`${origin}/auth/guest/start`, { method: "POST" });
    if (!r.ok)
        throw new Error(`guest/start ${r.status}`);
    const { token } = (await r.json());
    return token;
}
class TxLineSession {
    constructor(opts) {
        this.opts = opts;
        this.jwt = opts.jwt;
        this.apiToken = opts.apiToken;
    }
    headers() {
        const h = {};
        if (this.jwt)
            h["Authorization"] = `Bearer ${this.jwt}`;
        if (this.apiToken)
            h["X-Api-Token"] = this.apiToken;
        return h;
    }
    /** Obtain both credentials if missing. Idempotent. */
    async ensure() {
        if (!this.jwt)
            await this.renewJwt();
        if (!this.apiToken) {
            if (!this.opts.subscribe || !this.opts.wallet) {
                throw new Error("no apiToken and no way to mint one: pass {jwt, apiToken} from a cache, " +
                    "or {wallet, subscribe} to perform the on-chain free-tier subscription " +
                    "(a guest JWT alone cannot fetch proofs — the API answers 403 Missing API token)");
            }
            await this.activate();
        }
    }
    async renewJwt() {
        const r = await fetch(`${this.opts.origin}/auth/guest/start`, {
            method: "POST",
        });
        if (!r.ok)
            throw new Error(`guest/start ${r.status}`);
        const { token } = (await r.json());
        this.jwt = token;
        return token;
    }
    /**
     * Subscribe on-chain, then exchange the transaction signature for an API token.
     * The activation message is `{txSig}:{leagues.join(",")}:{jwt}`, signed with the
     * subscribing wallet (NaCl detached, base64).
     */
    async activate() {
        if (!this.jwt)
            await this.renewJwt();
        if (!this.opts.subscribe || !this.opts.wallet)
            throw new Error("activate() needs {wallet, subscribe} — see SessionOpts");
        const txSig = await this.opts.subscribe();
        const leagues = this.opts.leagues ?? [];
        const msg = `${txSig}:${leagues.join(",")}:${this.jwt}`;
        const sig = tweetnacl_1.default.sign.detached(new TextEncoder().encode(msg), this.opts.wallet.secretKey);
        const r = await fetch(`${this.opts.origin}/api/token/activate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.jwt}`,
            },
            body: JSON.stringify({
                txSig,
                walletSignature: Buffer.from(sig).toString("base64"),
                leagues,
            }),
        });
        if (!r.ok)
            throw new Error(`token/activate ${r.status}`);
        const { token } = (await r.json());
        this.apiToken = token;
        return token;
    }
    /** GET with automatic 401-renew / 403-resubscribe. */
    async get(path) {
        await this.ensure();
        let r = await fetch(`${this.opts.origin}/api${path}`, {
            headers: this.headers(),
        });
        if (r.status === 401) {
            await this.renewJwt();
            r = await fetch(`${this.opts.origin}/api${path}`, { headers: this.headers() });
        }
        else if (r.status === 403 && this.opts.subscribe) {
            // A rejected API token. Renewing the JWT cannot fix this.
            await this.activate();
            r = await fetch(`${this.opts.origin}/api${path}`, { headers: this.headers() });
        }
        if (!r.ok)
            throw new Error(`GET ${path} -> ${r.status}`);
        return (await r.json());
    }
}
exports.TxLineSession = TxLineSession;
