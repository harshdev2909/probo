/**
 * Keeper E2E: full autonomous lifecycle in replay mode against a local
 * validator with the mock-adapter build. Asserts a market goes
 * created → locked → settled → claimable with NO manual intervention —
 * the keeper does everything; the test only acts as bettors.
 *
 * Run via: yarn keeper:e2e  (keeper/scripts/e2e.sh boots the validator)
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import axios from "axios";

import { Keeper } from "../src/core/keeper";
import { loadConfig, ROOT } from "../src/config";
import { positionPda, vaultPda } from "../src/chain/pdas";

const FIXTURE_ID = 18193785; // the real, devnet-proven fixture (final 1-4 => Away)
const API = "http://127.0.0.1:8791";
const USDC = (n: number) => new BN(n).mul(new BN(1_000_000));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs: number
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`timeout waiting for: ${what}`);
    await sleep(1000);
  }
}

describe("keeper E2E — autonomous lifecycle (replay, mock oracle)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let keeper: Keeper;
  let usdcMint: PublicKey;
  let marketPdaStr: string;
  const alice = Keypair.generate(); // will back Away (the recorded winner)
  const bob = Keypair.generate(); // will back Home (loses)
  const atas = new Map<string, PublicKey>();

  before(async function () {
    this.timeout(120_000);
    usdcMint = await createMint(connection, payer, payer.publicKey, null, 6);
    for (const w of [alice, bob]) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: w.publicKey,
          lamports: 2 * LAMPORTS_PER_SOL,
        })
      );
      await provider.sendAndConfirm(tx, []);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        w.publicKey
      );
      atas.set(w.publicKey.toBase58(), ata.address);
      await mintTo(
        connection,
        payer,
        usdcMint,
        ata.address,
        payer,
        BigInt(USDC(10_000).toString())
      );
    }

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-e2e-"));
    keeper = new Keeper(
      loadConfig("replay", {
        replayFile: path.join(ROOT, "keeper", "fixtures", `${FIXTURE_ID}.json`),
        dataDir,
        apiPort: 8791,
        oracleMode: "mock",
        usdcMint: usdcMint.toBase58(),
        replayLockDelaySec: 15,
        replaySpeed: 600,
        replayMaxGapMs: 400,
        settleBaseDelayMs: 1_000,
        settleMaxDelayMs: 4_000,
      })
    );
    void keeper.start();
  });

  after(async () => {
    await keeper?.stop();
  });

  it("keeper auto-creates the market (no human)", async function () {
    this.timeout(60_000);
    const market = await until(
      "market creation",
      async () => {
        const { data } = await axios.get(`${API}/markets`);
        return data.find((m: any) => m.fixtureId === FIXTURE_ID) || null;
      },
      45_000
    );
    marketPdaStr = market.marketPda;
    assert.equal(market.status, "open");
    assert.equal(market.outcomes.length, 3);
  });

  it("accepts bets during the window, then keeper auto-locks at lock_time", async function () {
    this.timeout(90_000);
    const market = new PublicKey(marketPdaStr);
    const program = keeper.chain.program;
    const bet = (w: Keypair, outcome: number, amt: BN) =>
      program.methods
        .placeBet(outcome, amt)
        .accounts({
          bettor: w.publicKey,
          market,
          position: positionPda(program.programId, market, w.publicKey),
          bettorToken: atas.get(w.publicKey.toBase58())!,
          vault: vaultPda(program.programId, market),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([w])
        .rpc();

    await bet(alice, 2 /* Away — the recorded final is 1-4 */, USDC(600));
    await bet(bob, 0 /* Home */, USDC(400));

    const locked = await until(
      "auto-lock",
      async () => {
        const { data } = await axios.get(`${API}/markets/${marketPdaStr}`);
        return data.status === "locked" ? data : null;
      },
      60_000
    );
    assert.equal(locked.totalPool, USDC(1000).toString());
  });

  it("keeper detects game_finalised and settles TRUSTLESSLY via oracle CPI", async function () {
    this.timeout(180_000);
    const settled = await until(
      "autonomous settlement",
      async () => {
        const { data } = await axios.get(`${API}/markets/${marketPdaStr}`);
        return data.status === "settled" ? data : null;
      },
      150_000
    );
    assert.equal(
      settled.winningOutcome,
      2,
      "Away must win (recorded final 1-4)"
    );

    const { data: receipt } = await axios.get(
      `${API}/receipts/${marketPdaStr}`
    );
    assert.equal(receipt.matchId, FIXTURE_ID);
    assert.equal(receipt.outcomeLabel, "Away");
    assert.equal(
      receipt.oracleProgram,
      keeper.chain.oracleProgramId.toBase58()
    );
    assert.isString(receipt.settleTx);
    assert.isAbove(receipt.settleTx.length, 40);
    assert.equal(receipt.resolver, payer.publicKey.toBase58()); // the keeper wallet

    // A LIVE settlement must carry the proven scoreline, not just the outcome.
    // These are the values the merkle proof attests — never the feed's sampled
    // Score. Without this the settler wrote a receipt with a blank scoreline and
    // only backfilled markets ever showed one, so every receipt on the wall had
    // to come from the backfiller.
    assert.isOk(
      receipt.provenScore,
      "a live receipt must carry the proven scoreline"
    );
    assert.equal(receipt.provenScore.p1, 1, "proven P1 goals (recorded 1-4)");
    assert.equal(receipt.provenScore.p2, 4, "proven P2 goals (recorded 1-4)");
    assert.isNumber(receipt.statPeriod, "the period the proof commits to");
  });

  it("winner claims; loser cannot — funds flow correctly", async function () {
    this.timeout(60_000);
    const market = new PublicKey(marketPdaStr);
    const program = keeper.chain.program;
    const aliceAta = atas.get(alice.publicKey.toBase58())!;
    const before = (await getAccount(connection, aliceAta)).amount;

    await program.methods
      .claimWinnings()
      .accounts({
        winner: alice.publicKey,
        market,
        position: positionPda(program.programId, market, alice.publicKey),
        vault: vaultPda(program.programId, market),
        winnerToken: aliceAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const won = (await getAccount(connection, aliceAta)).amount - before;
    // Sole winner: distributable = 1000 - 5% fee = 950 USDC.
    assert.equal(won.toString(), USDC(950).toString());

    let bobFailed = false;
    try {
      await program.methods
        .claimWinnings()
        .accounts({
          winner: bob.publicKey,
          market,
          position: positionPda(program.programId, market, bob.publicKey),
          vault: vaultPda(program.programId, market),
          winnerToken: atas.get(bob.publicKey.toBase58())!,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bob])
        .rpc();
    } catch (e: any) {
      bobFailed = /NotAWinningPosition/.test(e.toString());
    }
    assert.isTrue(
      bobFailed,
      "loser claim must revert with NotAWinningPosition"
    );

    // Positions visible via the read API.
    const { data: positions } = await axios.get(
      `${API}/positions/${alice.publicKey.toBase58()}`
    );
    assert.equal(positions.length, 1);
    assert.isTrue(positions[0].claimed);
  });
});
