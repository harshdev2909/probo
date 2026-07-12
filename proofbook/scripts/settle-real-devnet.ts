/**
 * settle-real-devnet.ts — a REAL, end-to-end ProofBook settlement on Solana devnet
 * driven by TxLINE's LIVE `validate_stat_v2` cryptographic proof. No mock.
 *
 * Flow (all against devnet):
 *   1. Guest auth        POST https://txline-dev.txodds.com/auth/guest/start -> jwt
 *   2. Free World-Cup    subscribe(serviceLevelId, weeks) into the devnet txoracle
 *      subscribe          (Token-2022) + POST /api/token/activate -> apiToken
 *   3. Fetch proof       GET /api/scores/stat-validation?fixtureId&seq&statKeys
 *   4. ProofBook         initialize_market (specs matched to the proof's stats) ->
 *                        place_bet (2 wallets) -> lock_market
 *   5. settle_market     CPIs the LIVE devnet validate_stat_v2 with the real proof
 *   6. claim_winnings    then print the full Proof Receipt (+ all tx signatures)
 *
 * This must be run when a covered World-Cup fixture has a FINAL result whose daily
 * scores Merkle root has been published on devnet (free tier is live for World Cup
 * & International Friendlies). See README "Real devnet settlement".
 *
 * Required env:
 *   ANCHOR_PROVIDER_URL   devnet RPC (e.g. https://api.devnet.solana.com)
 *   ANCHOR_WALLET         resolver keypair json (pays; also creates the market)
 *   FIXTURE_ID            TxLINE fixtureId of a finalised covered fixture
 *   SEQ                   sequence of the score update to prove
 * Optional env:
 *   STAT_KEYS             default "1,2" (P1 & P2 full-game goals). Use e.g.
 *                         "100001,100002" for the finalised (period 100) result.
 *   API_TOKEN             skip the on-chain subscribe if you already have one
 *   TXL_MINT              default devnet TxL mint 4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, getAccount,
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import axios from "axios";
import nacl from "tweetnacl";

import proofbookIdl from "../target/idl/proofbook.json";
import txoracleIdl from "./vendor/txoracle.json";
import {
  marketPda, vaultPda, positionPda, OUTCOME_HOME_IDX, OUTCOME_DRAW_IDX, OUTCOME_AWAY_IDX,
} from "../tests/helpers";

const API = "https://txline-dev.txodds.com";
const TXLINE_DEVNET = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_MINT = new PublicKey(process.env.TXL_MINT || "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const DAILY_SCORES_SEED = Buffer.from("daily_scores_roots");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: any[]) => console.log("[settle-real]", ...a);

function envOrThrow(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env ${k}`);
  return v;
}

async function guestJwt(): Promise<string> {
  const { data } = await axios.post(`${API}/auth/guest/start`);
  return data.token;
}

/** Free-tier on-chain subscribe (Token-2022) + activation -> apiToken. */
async function subscribeAndActivate(
  txoracle: any, connection: anchor.web3.Connection, wallet: Keypair, jwt: string,
  serviceLevelId: number, weeks: number,
): Promise<string> {
  const ata = getAssociatedTokenAddressSync(TXL_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  if (!(await connection.getAccountInfo(ata))) {
    log("creating Token-2022 TxL ATA...");
    const tx = new Transaction().add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, ata, wallet.publicKey, TXL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
    await sleep(2000);
  }
  const [pricingMatrix] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], txoracle.programId);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], txoracle.programId);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(TXL_MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);

  log(`subscribe(serviceLevelId=${serviceLevelId}, weeks=${weeks}) ...`);
  const sig = await txoracle.methods.subscribe(serviceLevelId, weeks).accounts({
    user: wallet.publicKey, pricingMatrix, tokenMint: TXL_MINT, userTokenAccount: ata,
    tokenTreasuryVault, tokenTreasuryPda, tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).signers([wallet]).rpc();
  log("subscribe tx:", sig);

  const message = new TextEncoder().encode(`${sig}:${[].join(",")}:${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(message, wallet.secretKey)).toString("base64");
  const { data } = await axios.post(`${API}/api/token/activate`,
    { txSig: sig, walletSignature, leagues: [] }, { headers: { Authorization: `Bearer ${jwt}` } });
  return data.token || data;
}

const toBytes32 = (v: any): number[] => {
  const b = Array.isArray(v) ? Uint8Array.from(v)
    : v instanceof Uint8Array ? v
    : typeof v === "string" ? (v.startsWith("0x") ? Buffer.from(v.slice(2), "hex") : Buffer.from(v, "base64"))
    : Uint8Array.from(v);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return Array.from(b);
};
const mapProof = (nodes: any[]) => nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const resolver = (provider.wallet as anchor.Wallet).payer;

  const program = new anchor.Program(proofbookIdl as anchor.Idl, provider) as any;
  const txoracle = new anchor.Program(txoracleIdl as anchor.Idl, provider) as any;

  const fixtureId = new BN(envOrThrow("FIXTURE_ID"));
  const seq = envOrThrow("SEQ");
  const statKeys = process.env.STAT_KEYS || "1,2";
  log("resolver:", resolver.publicKey.toBase58(), "fixture:", fixtureId.toString(), "seq:", seq, "statKeys:", statKeys);

  // ── 1) auth + 2) free-tier subscribe/activate ─────────────────────────────
  const jwt = await guestJwt();
  log("guest jwt acquired");
  let apiToken = process.env.API_TOKEN;
  if (!apiToken) {
    apiToken = await subscribeAndActivate(txoracle, connection, resolver, jwt, 1, 4);
  }
  log("apiToken acquired:", apiToken.slice(0, 12) + "...");
  const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

  // ── 3) fetch the REAL stat-validation proof ───────────────────────────────
  const url = `${API}/api/scores/stat-validation?fixtureId=${fixtureId.toString()}&seq=${seq}&statKeys=${statKeys}`;
  log("GET", url);
  const { data: val } = await axios.get(url, { headers });
  log("proof received. stats:", JSON.stringify(val.statsToProve));

  const targetTs: number = val.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(targetTs / 86_400_000);
  const [dailyRootsPda] = PublicKey.findProgramAddressSync(
    [DAILY_SCORES_SEED, new BN(epochDay).toArrayLike(Buffer, "le", 2)], TXLINE_DEVNET);
  log("epochDay:", epochDay, "dailyRoots PDA:", dailyRootsPda.toBase58());

  // Determine the winning 1X2 outcome from the proven P1/P2 goals.
  const p1 = val.statsToProve[0], p2 = val.statsToProve[1];
  const winningOutcome = p1.value > p2.value ? OUTCOME_HOME_IDX : p1.value < p2.value ? OUTCOME_AWAY_IDX : OUTCOME_DRAW_IDX;
  log(`final: P1 ${p1.value} - ${p2.value} P2 => outcome ${winningOutcome}`);

  // ProofBook SettlementProof built from the REAL API response (v2 shape).
  const proof = {
    ts: new BN(targetTs),
    fixtureSummary: {
      fixtureId: new BN(val.summary.fixtureId),
      updateStats: {
        updateCount: val.summary.updateStats.updateCount,
        minTimestamp: new BN(val.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: toBytes32(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(val.subTreeProof),
    mainTreeProof: mapProof(val.mainTreeProof),
    eventStatRoot: toBytes32(val.eventStatRoot),
    statAValue: p1.value,
    statAProof: mapProof(val.statProofs[0]),
    hasStatB: true,
    statBValue: p2.value,
    statBProof: mapProof(val.statProofs[1]),
  };

  // Outcome specs MUST match the proof's ScoreStat {key, period} so the leaf hash
  // reconstructs on-chain. 1X2 goal-difference (P1 - P2) predicates.
  const base = { statAKey: p1.key, statAPeriod: p1.period, hasStatB: true, statBKey: p2.key, statBPeriod: p2.period, op: { subtract: {} } };
  const outcomes = [
    { ...base, comparison: { greaterThan: {} }, threshold: 0 }, // Home
    { ...base, comparison: { equalTo: {} }, threshold: 0 },     // Draw
    { ...base, comparison: { lessThan: {} }, threshold: 0 },    // Away
  ];

  // ── 4) ProofBook market: init -> bets -> lock ─────────────────────────────
  const marketType = Number(process.env.MARKET_TYPE || 0);
  const market = marketPda(program.programId, resolver.publicKey, fixtureId, marketType);
  const treasury = Keypair.generate();

  // Stand-in USDC mint for the market escrow (devnet).
  const usdcMint = await createMint(connection, resolver, resolver.publicKey, null, 6);
  const treasuryAta = (await getOrCreateAssociatedTokenAccount(connection, resolver, usdcMint, treasury.publicKey)).address;
  const alice = Keypair.generate(), bob = Keypair.generate();
  for (const w of [alice, bob]) {
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: resolver.publicKey, toPubkey: w.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(t, []);
  }
  const aliceAta = (await getOrCreateAssociatedTokenAccount(connection, resolver, usdcMint, alice.publicKey)).address;
  const bobAta = (await getOrCreateAssociatedTokenAccount(connection, resolver, usdcMint, bob.publicKey)).address;
  await mintTo(connection, resolver, usdcMint, aliceAta, resolver, BigInt(1_000_000_000));
  await mintTo(connection, resolver, usdcMint, bobAta, resolver, BigInt(1_000_000_000));

  const nowTs = Math.floor(Date.now() / 1000);
  const lockTime = new BN(nowTs + 10);
  log("initialize_market", market.toBase58());
  await program.methods.initializeMarket(fixtureId, marketType, outcomes, 500, lockTime, new BN(120), treasury.publicKey)
    .accounts({ authority: resolver.publicKey, market, usdcMint, vault: vaultPda(program.programId, market),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY }).rpc();

  const bet = async (w: Keypair, ata: PublicKey, outcome: number, amt: number) =>
    program.methods.placeBet(outcome, new BN(amt)).accounts({
      bettor: w.publicKey, market, position: positionPda(program.programId, market, w.publicKey),
      bettorToken: ata, vault: vaultPda(program.programId, market),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).signers([w]).rpc();
  // Alice backs the (soon-proven) winner; Bob backs a losing side.
  await bet(alice, aliceAta, winningOutcome, 600_000_000);
  await bet(bob, bobAta, (winningOutcome + 1) % 3, 400_000_000);
  log("bets placed");

  while (Math.floor(Date.now() / 1000) < lockTime.toNumber() + 1) await sleep(1000);
  await program.methods.lockMarket().accounts({ market, cranker: resolver.publicKey }).rpc();
  log("market locked");

  // ── 5) settle via the LIVE devnet validate_stat_v2 (no mock) ──────────────
  const settleSig = await program.methods.settleMarket(winningOutcome, proof).accounts({
    cranker: resolver.publicKey, market, oracleProgram: TXLINE_DEVNET, oracleRoots: dailyRootsPda,
  }).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
  log("SETTLED via real TxLINE proof. tx:", settleSig);

  // ── 6) claim + Proof Receipt ──────────────────────────────────────────────
  const claimSig = await program.methods.claimWinnings().accounts({
    winner: alice.publicKey, market, position: positionPda(program.programId, market, alice.publicKey),
    vault: vaultPda(program.programId, market), winnerToken: aliceAta, tokenProgram: TOKEN_PROGRAM_ID,
  }).signers([alice]).rpc();
  log("winner claimed. tx:", claimSig);

  const m = await program.account.market.fetch(market);
  console.log("\n========= PROOF RECEIPT =========");
  console.log("match_id (fixture):", m.fixtureId.toString());
  console.log("winning_outcome:   ", m.winningOutcome, ["Home", "Draw", "Away"][m.winningOutcome] ?? "");
  console.log("oracle_program:    ", m.oracleProgram.toBase58());
  console.log("epoch_day:         ", m.settleEpochDay);
  console.log("daily_roots PDA:   ", m.settleDailyRoots.toBase58());
  console.log("proof_ref (root):  ", Buffer.from(m.settleProofRef).toString("hex"));
  console.log("resolver:          ", m.settleResolver.toBase58());
  console.log("settle tx:         ", settleSig);
  console.log("claim  tx:         ", claimSig);
  console.log("balance (Alice):   ", (await getAccount(connection, aliceAta)).amount.toString());
  console.log("=================================\n");
}

main().then(() => process.exit(0), (e) => { console.error(e?.response?.data || e); process.exit(1); });
