#!/usr/bin/env node
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
/**
 * txline-settle — everything in this SDK, from a terminal.
 *
 *   auth        guest JWT → free-tier on-chain subscribe → activate; caches session
 *   fixtures    list fixtures + status
 *   scores      score records for a fixture; --watch streams live (SSE)
 *   proof       fetch a real stat-validation-v3 merkle proof
 *   predicate   build/check a compound predicate; rejects overlapping stat families
 *   verify      ⭐ independently verify a settlement against the LIVE oracle
 *   market      create | bet | lock | settle | claim  (ProofBook reference market)
 *
 * Global flags: --json  --devnet(default) --mainnet  --rpc <url>  --api <origin>
 *               --keypair <path> (default ~/.config/solana/id.json)
 *
 * The session cache lives at ~/.txline-settle/<origin-host>.json. It holds a
 * guest JWT and the free-tier api token — read credentials, not funds.
 */
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const anchor = __importStar(require("@coral-xyz/anchor"));
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const network_1 = require("./network");
const session_1 = require("./session");
const feed_1 = require("./feed");
const proof_1 = require("./proof");
const predicate_1 = require("./predicate");
const verify_1 = require("./verify");
const receipt_1 = require("./receipt");
// Account decoders for the reference integration (ProofBook) + the oracle.
// Bundled so `npx @h4rsharma/txline-settle verify <pda>` needs zero setup.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const txoracleIdl = require("../../idl/txoracle.json");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proofbookIdl = require("../../idl/proofbook.json");
function parseArgs(argv) {
    const cmd = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                flags[key] = next;
                i++;
            }
            else
                flags[key] = true;
        }
        else
            cmd.push(a);
    }
    return { cmd, flags };
}
// ── output helpers ───────────────────────────────────────────────────────────
const TTY = process.stdout.isTTY;
const c = {
    brass: (s) => (TTY ? `\x1b[33m${s}\x1b[0m` : s),
    green: (s) => (TTY ? `\x1b[32m${s}\x1b[0m` : s),
    red: (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s),
    dim: (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
    bold: (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s),
};
let JSON_MODE = false;
const out = (human, json) => {
    if (JSON_MODE)
        console.log(JSON.stringify(json, null, 2));
    else
        human();
};
const die = (msg, code = 1) => {
    if (JSON_MODE)
        console.error(JSON.stringify({ error: msg }));
    else
        console.error(c.red(`error: ${msg}`));
    process.exit(code);
};
// ── session cache + wiring ───────────────────────────────────────────────────
const cacheDir = path.join(os.homedir(), ".txline-settle");
const cacheFile = (net) => path.join(cacheDir, new URL(net.apiOrigin).host + ".json");
function loadKeypair(flags) {
    const p = flags.keypair ??
        path.join(os.homedir(), ".config/solana/id.json");
    if (!fs.existsSync(p))
        die(`no keypair at ${p} — pass --keypair <path> (needed to sign)`);
    return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function netOf(flags) {
    const base = flags.mainnet ? network_1.MAINNET : network_1.DEVNET;
    return flags.api ? { ...base, apiOrigin: String(flags.api) } : base;
}
function rpcOf(flags, net) {
    const url = flags.rpc ??
        process.env.RPC_URL ??
        (net.cluster === "devnet"
            ? "https://api.devnet.solana.com"
            : "https://api.mainnet-beta.solana.com");
    return new web3_js_1.Connection(url, "confirmed");
}
/** Session from cache; `auth` refreshes it. Non-auth commands never subscribe. */
function sessionOf(net) {
    let jwt;
    let apiToken;
    try {
        const j = JSON.parse(fs.readFileSync(cacheFile(net), "utf8"));
        jwt = j.jwt;
        apiToken = j.apiToken;
    }
    catch {
        /* no cache yet */
    }
    if (!apiToken)
        die(`no TxLINE session for ${net.apiOrigin} — run \`txline-settle auth\` first ` +
            `(a guest JWT alone cannot fetch proofs)`);
    return new session_1.TxLineSession({ origin: net.apiOrigin, jwt, apiToken });
}
// ── commands ─────────────────────────────────────────────────────────────────
async function cmdAuth(flags) {
    const net = netOf(flags);
    const wallet = loadKeypair(flags);
    const conn = rpcOf(flags, net);
    // On-chain free-tier subscribe (Token-2022), then activate. This is the whole
    // reason auth needs a wallet: the api token is minted against a subscription.
    const subscribe = async () => {
        const { TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
         } = require("@solana/spl-token");
        const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), {
            commitment: "confirmed",
        });
        const oracle = new anchor.Program({ ...txoracleIdl, address: net.oracleProgram }, provider);
        const mint = new web3_js_1.PublicKey(net.txlMint);
        const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const pre = [];
        if (!(await conn.getAccountInfo(ata))) {
            pre.push(createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint, TOKEN_2022_PROGRAM_ID));
        }
        const [pricing] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], oracle.programId);
        const [treasuryPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], oracle.programId);
        const vault = getAssociatedTokenAddressSync(mint, treasuryPda, true, TOKEN_2022_PROGRAM_ID);
        return oracle.methods
            .subscribe(Number(flags["service-level"] ?? 1), Number(flags.weeks ?? 4))
            .accounts({
            user: wallet.publicKey,
            pricingMatrix: pricing,
            tokenMint: mint,
            userTokenAccount: ata,
            tokenTreasuryVault: vault,
            tokenTreasuryPda: treasuryPda,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: web3_js_1.SystemProgram.programId,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
            .preInstructions(pre)
            .rpc();
    };
    const session = new session_1.TxLineSession({ origin: net.apiOrigin, wallet, subscribe });
    await session.ensure();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile(net), JSON.stringify({ jwt: session.jwt, apiToken: session.apiToken }, null, 2));
    out(() => {
        console.log(c.green("✓ authenticated with TxLINE"));
        console.log(c.dim(`  origin   ${net.apiOrigin}`));
        console.log(c.dim(`  session  ${cacheFile(net)}`));
    }, { ok: true, origin: net.apiOrigin, cache: cacheFile(net) });
}
async function cmdFixtures(flags) {
    const net = netOf(flags);
    const rows = await (0, feed_1.fixtures)(sessionOf(net), {
        competitionId: Number(flags.league ?? 72),
    });
    out(() => {
        for (const f of rows.sort((a, b) => a.startTime - b.startTime)) {
            const when = new Date(f.startTime).toISOString().slice(0, 16) + "Z";
            console.log(`  ${c.dim(when)}  ${String(f.fixtureId).padEnd(9)} ${f.participant1} v ${f.participant2}`);
        }
        console.log(c.dim(`\n  ${rows.length} fixture(s)`));
    }, rows);
}
async function cmdScores(a) {
    const fixtureId = Number(a.cmd[1]);
    if (!fixtureId)
        die("usage: txline-settle scores <fixtureId> [--watch]");
    const net = netOf(a.flags);
    const session = sessionOf(net);
    if (a.flags.watch) {
        // SSE via fetch — Node has no EventSource, and we do not need one.
        console.error(c.dim(`streaming ${net.apiOrigin}/api/scores/stream … ^C to stop`));
        const res = await fetch(`${net.apiOrigin}/api/scores/stream`, {
            headers: { ...session.headers(), Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body)
            die(`stream ${res.status}`);
        const reader = res.body.getReader();
        let buf = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += Buffer.from(value).toString();
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
                const frame = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const data = frame
                    .split("\n")
                    .filter((l) => l.startsWith("data:"))
                    .map((l) => l.slice(5).trim())
                    .join("");
                if (!data)
                    continue;
                try {
                    const rows = JSON.parse(data);
                    for (const r of Array.isArray(rows) ? rows : [rows]) {
                        if (r.FixtureId !== fixtureId)
                            continue;
                        if (JSON_MODE)
                            console.log(JSON.stringify(r));
                        else
                            console.log(`  seq ${r.Seq}  status ${r.StatusId}  ${JSON.stringify(r.Score ?? {}).slice(0, 60)}`);
                    }
                }
                catch {
                    /* heartbeat */
                }
            }
        }
        return;
    }
    const rows = await (0, feed_1.scoresSnapshot)(session, fixtureId);
    if (!rows.length)
        die(`TxLINE retains no score records for ${fixtureId} (scores age out after ~23 days). ` +
            `The result is NOT provable — do not pretend otherwise.`);
    out(() => {
        for (const r of rows.slice(-12)) {
            console.log(`  seq ${String(r.Seq).padEnd(6)} status ${String(r.StatusId).padEnd(4)} ${c.dim(new Date(r.Ts).toISOString())}`);
        }
        const fin = rows.filter((x) => x.StatusId === 100);
        const best = (fin.length ? fin : rows).reduce((m, x) => (x.Seq ?? 0) > (m.Seq ?? 0) ? x : m);
        console.log(c.brass(`\n  best terminal record: seq ${best.Seq} (statusId ${best.StatusId})`));
    }, rows);
}
async function cmdProof(a) {
    const fixtureId = Number(a.cmd[1]);
    const keys = String(a.flags.stats ?? "1,2")
        .split(",")
        .map(Number);
    if (!fixtureId)
        die("usage: txline-settle proof <fixtureId> --seq <n> --stats 1,2");
    const net = netOf(a.flags);
    const session = sessionOf(net);
    const seq = a.flags.seq ? Number(a.flags.seq) : await (0, proof_1.findFinalisedSeq)(session, fixtureId);
    const val = await (0, proof_1.fetchProofV3)(session, fixtureId, seq, keys);
    out(() => {
        console.log(c.bold(`  merkle proof — fixture ${fixtureId}, seq ${seq}`));
        for (const l of val.statsToProve)
            console.log(`    stat ${l.stat.key} = ${c.brass(String(l.stat.value))}  (period ${l.stat.period})`);
        console.log(c.dim(`    multiproof: ${val.multiproof.hashes.length} shared hashes, indices [${val.multiproof.indices.join(",")}]`));
        console.log(c.dim(`    event stat root: ${Buffer.from(val.eventStatRoot).toString("hex").slice(0, 32)}…`));
    }, val);
}
function conditionOf(spec) {
    const [name, arg] = spec.split(":");
    const line = arg ? Number(arg) : undefined;
    switch (name) {
        case "homeWin": return predicate_1.homeWin;
        case "overGoals": return (0, predicate_1.overGoals)(line ?? 2.5);
        case "overCorners": return (0, predicate_1.overCorners)(line ?? 9.5);
        case "overCards": return (0, predicate_1.overCards)(line ?? 3.5);
        default:
            return die(`unknown condition "${name}" — use homeWin | overGoals[:2.5] | overCorners[:9.5] | overCards[:3.5]`);
    }
}
async function cmdPredicate(a) {
    if (a.flags.check) {
        // --check "1,2+1,2" → are these two leg sets combinable?
        const [x, y] = String(a.flags.check).split("+");
        const fam = (s) => s.split(",").map((k) => (0, predicate_1.familyOf)(Number(k)));
        const fa = new Set(fam(x));
        const clash = fam(y).filter((f) => fa.has(f));
        if (clash.length)
            die(`NOT combinable: both sides read the ${clash.join("/")} stat family. TxLINE evaluates ` +
                `each proven stat exactly once (DuplicateStatCoverage, 6070) — there is no encoding for this.`);
        out(() => console.log(c.green("✓ combinable — the leg sets are disjoint")), { ok: true });
        return;
    }
    const aSpec = a.flags.a ? conditionOf(String(a.flags.a)) : predicate_1.homeWin;
    const bSpec = a.flags.b ? conditionOf(String(a.flags.b)) : (0, predicate_1.overCorners)(9.5);
    const market = (0, predicate_1.parlay)(aSpec, bSpec); // throws with the 6070 explanation on overlap
    out(() => {
        console.log(c.bold(`  ${aSpec.label} & ${bSpec.label}`));
        console.log(c.dim(`  legs (statKeys): [${market.legs.map((l) => l.key).join(",")}]`));
        console.log(`\n  the exhaustive 2×2 grid:`);
        market.outcomes.forEach((o, i) => console.log(`    ${i}: ${o.label}${i === 0 ? c.brass("   ← the parlay") : ""}`));
    }, market);
}
async function cmdVerify(a) {
    let target = a.cmd[1];
    if (!target)
        die("usage: txline-settle verify <marketPda|settleTxSig> [--tamper]");
    const net = netOf(a.flags);
    const conn = rpcOf(a.flags, net);
    const session = sessionOf(net);
    const settlerId = new web3_js_1.PublicKey(String(a.flags.program ?? proofbookIdl.address));
    // A signature (~88 chars) → resolve the market account from the transaction.
    if (target.length > 50) {
        const tx = await conn.getTransaction(target, { maxSupportedTransactionVersion: 0 });
        if (!tx)
            die("transaction not found");
        const keys = tx.transaction.message.staticAccountKeys ?? [];
        let found;
        for (const k of keys) {
            const info = await conn.getAccountInfo(k);
            if (info?.owner.equals(settlerId) && info.data.length > 300) {
                found = k.toBase58();
                break;
            }
        }
        if (!found)
            die("no market account found in that transaction");
        target = found;
        if (!JSON_MODE)
            console.log(c.dim(`  resolved market ${target} from the transaction\n`));
    }
    const TITLES = {
        settlement: "Read the settlement from Solana",
        predicate: "Read the predicate the market committed to",
        root: "Read TxLINE's published merkle root (their PDA, their program)",
        proof: "Fetch the proof from TxLINE",
        oracle: "Ask TxLINE's own program for the verdict",
    };
    const res = await (0, verify_1.verifySettlement)({
        anchor,
        connection: conn,
        session,
        txoracleIdl: { ...txoracleIdl, address: net.oracleProgram },
        settlerIdl: proofbookIdl,
        marketPda: target,
        network: net,
        tamper: !!a.flags.tamper,
        onStep: (s) => {
            if (JSON_MODE)
                return;
            const mark = s.ok ? c.green("✓") : c.red("✗");
            console.log(`  ${mark} ${TITLES[s.key] ?? s.key}`);
            console.log(c.dim(`      ${s.detail}`));
            for (const [k, v] of Object.entries(s.evidence ?? {}))
                console.log(c.dim(`      ${k}: ${v}`));
        },
    });
    if (JSON_MODE) {
        console.log(JSON.stringify(res, null, 2));
    }
    else if (res.verified) {
        console.log(c.green(c.bold(`\n  VERIFIED`)));
        console.log(c.dim("  TxLINE's on-chain program re-adjudicated this settlement against the root\n" +
            "  TxLINE published on Solana. Nothing the settling app says was taken on faith."));
    }
    else if (a.flags.tamper) {
        console.log(c.red(c.bold(`\n  TAMPERED — REJECTED`)));
        console.log(c.dim("  One byte was corrupted and the oracle refused the proof. That is the point:\n" +
            "  it does not matter who hands you a proof, because a false one cannot pass."));
    }
    else {
        console.log(c.red(c.bold(`\n  NOT VERIFIED`)));
    }
    process.exit(res.verified || a.flags.tamper ? 0 : 1);
}
async function cmdMarket(a) {
    const sub = a.cmd[1];
    const net = netOf(a.flags);
    const conn = rpcOf(a.flags, net);
    const wallet = loadKeypair(a.flags);
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), {
        commitment: "confirmed",
    });
    const prog = new anchor.Program(proofbookIdl, provider);
    const pdaOf = (fixtureId, marketType, authority) => web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("market"),
        authority.toBuffer(),
        new anchor_1.BN(fixtureId).toArrayLike(Buffer, "le", 8),
        Buffer.from([marketType]),
    ], prog.programId)[0];
    const vaultOf = (market) => web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], prog.programId)[0];
    const positionOf = (market, owner) => web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), owner.toBuffer()], prog.programId)[0];
    const marketArg = () => new web3_js_1.PublicKey(String(a.flags.market ?? die("--market <pda> required")));
    switch (sub) {
        case "create": {
            const fixtureId = Number(a.flags.fixture ?? die("--fixture <id> required"));
            const marketType = Number(a.flags.type ?? 0);
            const mint = new web3_js_1.PublicKey(String(a.flags.mint ?? die("--mint <usdcMint> required")));
            const lockTime = Number(a.flags.lock ?? Math.floor(Date.now() / 1000) + 3600);
            const period = Number(a.flags.period ?? 100);
            // 1X2 on goal difference — the reference market shape.
            const base = {
                statAKey: 1, statAPeriod: period, hasStatB: true,
                statBKey: 2, statBPeriod: period, op: { subtract: {} },
            };
            const specs = [
                { ...base, comparison: { greaterThan: {} }, threshold: 0 },
                { ...base, comparison: { equalTo: {} }, threshold: 0 },
                { ...base, comparison: { lessThan: {} }, threshold: 0 },
            ];
            const market = pdaOf(fixtureId, marketType, wallet.publicKey);
            const sig = await prog.methods
                .initializeMarket(new anchor_1.BN(fixtureId), marketType, specs, 500, new anchor_1.BN(lockTime), new anchor_1.BN(21600), wallet.publicKey)
                .accounts({
                authority: wallet.publicKey, market, usdcMint: mint,
                vault: vaultOf(market),
                tokenProgram: new web3_js_1.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
                systemProgram: web3_js_1.SystemProgram.programId,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
                .rpc();
            out(() => console.log(c.green(`✓ market ${market.toBase58()}\n  tx ${sig}`)), { market: market.toBase58(), sig });
            break;
        }
        case "bet": {
            const market = marketArg();
            const outcome = Number(a.flags.outcome ?? die("--outcome <i> required"));
            const amount = new anchor_1.BN(Math.round(Number(a.flags.amount ?? die("--amount <usdc> required")) * 1e6));
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
            const m = await prog.account.market.fetch(market);
            const sig = await prog.methods
                .placeBet(outcome, amount)
                .accounts({
                bettor: wallet.publicKey, market,
                position: positionOf(market, wallet.publicKey),
                bettorToken: getAssociatedTokenAddressSync(m.usdcMint, wallet.publicKey),
                vault: m.vault,
                tokenProgram: new web3_js_1.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .rpc();
            out(() => console.log(c.green(`✓ bet placed\n  tx ${sig}`)), { sig });
            break;
        }
        case "lock": {
            const market = marketArg();
            const sig = await prog.methods.lockMarket().accounts({ market, cranker: wallet.publicKey }).rpc();
            out(() => console.log(c.green(`✓ locked\n  tx ${sig}`)), { sig });
            break;
        }
        case "settle": {
            // Fetch the proof, compute the outcome the values satisfy, settle. Real
            // proof, real CPI — the same trustless path the keeper takes.
            const market = marketArg();
            const session = sessionOf(net);
            const m = await prog.account.market.fetch(market);
            const fixtureId = Number(m.fixtureId);
            if (Number(m.marketType) >= 16)
                die("compound markets need settle_market_v3 with a ComboSpec — use the app's keeper");
            const spec = m.outcomes[0].spec;
            const keys = [spec.statAKey, ...(spec.hasStatB ? [spec.statBKey] : [])];
            const seq = await (0, proof_1.findFinalisedSeq)(session, fixtureId);
            const val = await (0, proof_1.fetchProofV3)(session, fixtureId, seq, keys);
            const p1 = val.statsToProve[0].stat.value;
            const p2 = val.statsToProve[1]?.stat.value ?? 0;
            const claimed = p1 > p2 ? 0 : p1 < p2 ? 2 : 1;
            const node = (n) => ({ hash: Array.from(Buffer.from(n.hash ?? n)), isRightSibling: !!n.isRightSibling });
            const b32 = (v) => Array.from(Buffer.from(v));
            const tsMs = val.summary.updateStats.minTimestamp;
            const proof = {
                ts: new anchor_1.BN(tsMs),
                fixtureSummary: {
                    fixtureId: new anchor_1.BN(val.summary.fixtureId),
                    updateStats: {
                        updateCount: val.summary.updateStats.updateCount,
                        minTimestamp: new anchor_1.BN(tsMs),
                        maxTimestamp: new anchor_1.BN(val.summary.updateStats.maxTimestamp),
                    },
                    eventsSubTreeRoot: b32(val.summary.eventStatsSubTreeRoot),
                },
                fixtureProof: (val.subTreeProof ?? []).map(node),
                mainTreeProof: (val.mainTreeProof ?? []).map(node),
                eventStatRoot: b32(val.eventStatRoot),
                statAValue: p1,
                statAProof: (val.statsToProve[0].statProof ?? []).map(node),
                hasStatB: !!spec.hasStatB,
                statBValue: p2,
                statBProof: (val.statsToProve[1]?.statProof ?? []).map(node),
            };
            const { dailyRootsPda } = await Promise.resolve().then(() => __importStar(require("./settle")));
            const epochDay = Math.floor(tsMs / 86400000);
            const sig = await prog.methods
                .settleMarket(claimed, proof)
                .accounts({
                cranker: wallet.publicKey, market,
                oracleProgram: new web3_js_1.PublicKey(net.oracleProgram),
                oracleRoots: dailyRootsPda(epochDay, new web3_js_1.PublicKey(net.oracleProgram)),
            })
                .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 })])
                .rpc();
            out(() => console.log(c.green(`✓ settled trustlessly — outcome ${claimed} (${p1}-${p2})\n  tx ${sig}`)), { sig, claimed, proven: [p1, p2] });
            break;
        }
        case "claim": {
            const market = marketArg();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
            const m = await prog.account.market.fetch(market);
            const sig = await prog.methods
                .claimWinnings()
                .accounts({
                winner: wallet.publicKey, market,
                position: positionOf(market, wallet.publicKey),
                vault: m.vault,
                winnerToken: getAssociatedTokenAddressSync(m.usdcMint, wallet.publicKey),
                tokenProgram: new web3_js_1.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            })
                .rpc();
            out(() => console.log(c.green(`✓ claimed\n  tx ${sig}`)), { sig });
            break;
        }
        case "receipt": {
            const market = marketArg();
            const r = await (0, receipt_1.reconstructReceipt)({
                anchor, connection: conn, settlerIdl: proofbookIdl, marketPda: market.toBase58(),
            });
            out(() => console.log(JSON.stringify(r, null, 2)), r);
            break;
        }
        default:
            die("usage: txline-settle market <create|bet|lock|settle|claim|receipt> …");
    }
}
// ── help + main ──────────────────────────────────────────────────────────────
const HELP = `
${"txline-settle"} — unofficial CLI for TxLINE's on-chain sports oracle
(not affiliated with TxODDS/TxLINE)

USAGE
  txline-settle <command> [options]

COMMANDS
  auth                             guest JWT → free-tier subscribe → activate (caches session)
  fixtures [--league 72]           list fixtures
  scores <fixtureId> [--watch]     score records; --watch streams live
  proof <fixtureId> [--seq n] --stats 1,2
                                   fetch a real stat-validation-v3 merkle proof
  predicate [--a homeWin] [--b overCorners:9.5] | [--check "1,2+7,8"]
                                   build the exhaustive 2×2 parlay; overlapping
                                   stat families are rejected (TxLINE 6070)
  verify <marketPda|txSig> [--tamper]
                                   ⭐ independently verify a settlement against
                                   the LIVE oracle — trusts nothing
  market create|bet|lock|settle|claim|receipt
                                   full market lifecycle (reference integration)

GLOBAL OPTIONS
  --json          machine output          --devnet (default) | --mainnet
  --rpc <url>     Solana RPC              --api <origin>  TxLINE origin override
  --keypair <p>   signer (default ~/.config/solana/id.json)

THE TWO GOTCHAS (they will bite you)
  · stat keys: 1/2 goals · 3/4 yellows · 5/6 reds · 7/8 corners. A compound
    predicate's legs must read DISJOINT families — "home win AND over 2.5 goals"
    is not expressible; the oracle evaluates each proven stat exactly once.
  · periods: TxLINE keeps the game_finalised (period 100) record ~10 days; older
    fixtures prove at period 5 (full time). A spec pinned to the wrong period can
    NEVER settle (InvalidStatProof 6023) — read the proof's period, then commit.
`;
async function main() {
    const a = parseArgs(process.argv.slice(2));
    JSON_MODE = !!a.flags.json;
    const cmd = a.cmd[0];
    try {
        if (!cmd || a.flags.help || cmd === "help")
            console.log(HELP);
        else if (cmd === "auth")
            await cmdAuth(a.flags);
        else if (cmd === "fixtures")
            await cmdFixtures(a.flags);
        else if (cmd === "scores")
            await cmdScores(a);
        else if (cmd === "proof")
            await cmdProof(a);
        else if (cmd === "predicate")
            await cmdPredicate(a);
        else if (cmd === "verify")
            await cmdVerify(a);
        else if (cmd === "market")
            await cmdMarket(a);
        else
            die(`unknown command "${cmd}" — try --help`);
    }
    catch (e) {
        die(String(e?.message ?? e).slice(0, 400));
    }
}
void main();
