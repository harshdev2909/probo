import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert, expect } from "chai";

import proofbookIdl from "../target/idl/proofbook.json";
import mockOracleIdl from "../target/idl/mock_oracle.json";
import {
  OUTCOMES_1X2,
  OUTCOME_HOME_IDX,
  OUTCOME_DRAW_IDX,
  OUTCOME_AWAY_IDX,
  marketPda,
  vaultPda,
  positionPda,
  dailyRootsPda,
  buildProof,
  onchainNow,
  waitUntilOnchain,
} from "./helpers";

const USDC = (whole: number) => new BN(whole).mul(new BN(1_000_000)); // 6 decimals
const FEE_BPS = 500; // 5%
const LOCK_DELAY = 10; // seconds from init to lock
const RESOLUTION_TIMEOUT = new BN(120); // seconds after lock before cancel is legal
const CANCEL_TIMEOUT = new BN(5); // short timeout for the liveness market

describe("proofbook — trustless World Cup prediction market", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Cast to `any`: the IDL is loaded at runtime, so method/account access is dynamic.
  const program = new anchor.Program(proofbookIdl as anchor.Idl, provider) as any;
  const mock = new anchor.Program(mockOracleIdl as anchor.Idl, provider) as any;

  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  const dave = Keypair.generate();
  const bettors = [alice, bob, carol, dave];
  const treasury = Keypair.generate();

  let usdcMint: PublicKey;
  let treasuryAta: PublicKey;
  const ata = new Map<string, PublicKey>();

  // ── validator-agnostic funding: transfer SOL from the (pre-funded) payer ────
  async function fund(pk: PublicKey, sol: number) {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pk, lamports: sol * LAMPORTS_PER_SOL })
    );
    await provider.sendAndConfirm(tx, []);
  }
  async function balance(pk: PublicKey): Promise<bigint> {
    return (await getAccount(connection, pk)).amount;
  }

  // ── instruction helpers ─────────────────────────────────────────────────────
  async function initMarket(
    market: PublicKey,
    fixtureId: BN,
    lockTime: BN,
    resolutionTimeout: BN,
    mint: PublicKey = usdcMint
  ) {
    await program.methods
      .initializeMarket(fixtureId, 0, OUTCOMES_1X2, FEE_BPS, lockTime, resolutionTimeout, treasury.publicKey)
      .accounts({
        authority: payer.publicKey,
        market,
        usdcMint: mint,
        vault: vaultPda(program.programId, market),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }
  async function placeBetWith(
    market: PublicKey,
    bettor: Keypair,
    tokenAcc: PublicKey,
    outcome: number,
    amount: BN
  ) {
    await program.methods
      .placeBet(outcome, amount)
      .accounts({
        bettor: bettor.publicKey,
        market,
        position: positionPda(program.programId, market, bettor.publicKey),
        bettorToken: tokenAcc,
        vault: vaultPda(program.programId, market),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bettor])
      .rpc();
  }
  const placeBet = (market: PublicKey, bettor: Keypair, outcome: number, amount: BN) =>
    placeBetWith(market, bettor, ata.get(bettor.publicKey.toBase58())!, outcome, amount);

  async function lockMarket(market: PublicKey) {
    await program.methods
      .lockMarket()
      .accounts({ market, cranker: payer.publicKey })
      .rpc();
  }
  async function publishRoot(root: number[], epochDay: number) {
    await mock.methods
      .publishDailyRoot(epochDay, root)
      .accounts({
        dailyScoresMerkleRoots: dailyRootsPda(mock.programId, epochDay),
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
  async function settle(market: PublicKey, outcome: number, proof: any, epochDay: number) {
    await program.methods
      .settleMarket(outcome, proof)
      .accounts({
        cranker: payer.publicKey,
        market,
        oracleProgram: mock.programId,
        oracleRoots: dailyRootsPda(mock.programId, epochDay),
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
  }
  async function claimWinnings(market: PublicKey, winner: Keypair) {
    await program.methods
      .claimWinnings()
      .accounts({
        winner: winner.publicKey,
        market,
        position: positionPda(program.programId, market, winner.publicKey),
        vault: vaultPda(program.programId, market),
        winnerToken: ata.get(winner.publicKey.toBase58())!,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([winner])
      .rpc();
  }
  async function claimRefund(market: PublicKey, user: Keypair) {
    await program.methods
      .claimRefund()
      .accounts({
        user: user.publicKey,
        market,
        position: positionPda(program.programId, market, user.publicKey),
        vault: vaultPda(program.programId, market),
        userToken: ata.get(user.publicKey.toBase58())!,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
  }
  async function cancelMarket(market: PublicKey, canceller: Keypair) {
    await program.methods
      .cancelMarket()
      .accounts({ market, canceller: canceller.publicKey })
      .signers([canceller])
      .rpc();
  }
  async function withdrawFees(market: PublicKey) {
    await program.methods
      .withdrawFees()
      .accounts({
        caller: payer.publicKey,
        market,
        vault: vaultPda(program.programId, market),
        feeTreasury: treasury.publicKey,
        feeTreasuryToken: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  before(async () => {
    for (const b of bettors) await fund(b.publicKey, 3);
    usdcMint = await createMint(connection, payer, payer.publicKey, null, 6);
    for (const b of bettors) {
      const acc = await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, b.publicKey);
      ata.set(b.publicKey.toBase58(), acc.address);
      await mintTo(connection, payer, usdcMint, acc.address, payer, BigInt(USDC(10_000).toString()));
    }
    treasuryAta = await createAssociatedTokenAccount(connection, payer, usdcMint, treasury.publicKey);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Market A — happy path, mint validation, fee withdrawal
  // ══════════════════════════════════════════════════════════════════════════
  describe("A: happy path + fees", () => {
    const FIXTURE = new BN(1001);
    const TS = new BN(1_700_000_000_000);
    const market = marketPda(program.programId, payer.publicKey, FIXTURE, 0);

    it("initializes a market with a USDC vault, treasury & timeout", async () => {
      const lockTime = new BN((await onchainNow(connection)) + LOCK_DELAY);
      await initMarket(market, FIXTURE, lockTime, RESOLUTION_TIMEOUT);
      const m = await program.account.market.fetch(market);
      assert.equal(m.numOutcomes, 3);
      assert.equal(m.feeBps, FEE_BPS);
      assert.isDefined(m.status.open);
      assert.equal(m.winningOutcome, 255);
      assert.equal(m.oracleProgram.toBase58(), mock.programId.toBase58());
      assert.equal(m.feeTreasury.toBase58(), treasury.publicKey.toBase58());
      assert.equal(m.resolutionTimeout.toString(), RESOLUTION_TIMEOUT.toString());
    });

    it("accepts bets on different outcomes and enforces the USDC mint", async () => {
      await placeBet(market, alice, OUTCOME_HOME_IDX, USDC(600));
      await placeBet(market, bob, OUTCOME_HOME_IDX, USDC(200));
      await placeBet(market, carol, OUTCOME_DRAW_IDX, USDC(100));
      await placeBet(market, dave, OUTCOME_AWAY_IDX, USDC(100));

      const m = await program.account.market.fetch(market);
      assert.equal(m.totalPool.toString(), USDC(1000).toString());
      assert.equal(m.outcomes[OUTCOME_HOME_IDX].pool.toString(), USDC(800).toString());
      assert.equal((await balance(vaultPda(program.programId, market))).toString(), USDC(1000).toString());

      // Mint validation: a token account of a DIFFERENT mint is rejected.
      const fakeMint = await createMint(connection, payer, payer.publicKey, null, 6);
      const fakeAcc = await getOrCreateAssociatedTokenAccount(connection, payer, fakeMint, alice.publicKey);
      await mintTo(connection, payer, fakeMint, fakeAcc.address, payer, BigInt(USDC(100).toString()));
      try {
        await placeBetWith(market, alice, fakeAcc.address, OUTCOME_HOME_IDX, USDC(10));
        assert.fail("expected WrongMint");
      } catch (e: any) {
        expect(e.toString()).to.match(/WrongMint|ConstraintTokenMint|AnchorError/);
      }

      // Can't switch outcomes; zero amount rejected.
      try {
        await placeBet(market, alice, OUTCOME_AWAY_IDX, USDC(1));
        assert.fail("expected CannotSwitchOutcome");
      } catch (e: any) {
        expect(e.toString()).to.match(/CannotSwitchOutcome/);
      }
      try {
        await placeBet(market, alice, OUTCOME_HOME_IDX, new BN(0));
        assert.fail("expected ZeroAmount");
      } catch (e: any) {
        expect(e.toString()).to.match(/ZeroAmount/);
      }
    });

    it("cannot be settled before it is locked", async () => {
      const { proof, epochDay } = buildProof(2, 1, FIXTURE, TS);
      try {
        await settle(market, OUTCOME_HOME_IDX, proof, epochDay);
        assert.fail("expected NotLocked");
      } catch (e: any) {
        expect(e.toString()).to.match(/NotLocked/);
      }
    });

    it("locks after lock_time and refuses later bets", async () => {
      const m = await program.account.market.fetch(market);
      await waitUntilOnchain(connection, m.lockTime.toNumber());
      await lockMarket(market);
      assert.isDefined((await program.account.market.fetch(market)).status.locked);
      try {
        await placeBet(market, alice, OUTCOME_HOME_IDX, USDC(1));
        assert.fail("expected MarketNotOpen");
      } catch (e: any) {
        expect(e.toString()).to.match(/MarketNotOpen/);
      }
    });

    it("settles trustlessly via a valid oracle proof (Home win)", async () => {
      const { proof, dailyRoot, epochDay } = buildProof(2, 1, FIXTURE, TS);
      await publishRoot(dailyRoot, epochDay);
      await settle(market, OUTCOME_HOME_IDX, proof, epochDay);
      const m = await program.account.market.fetch(market);
      assert.isDefined(m.status.settled);
      assert.equal(m.winningOutcome, OUTCOME_HOME_IDX);
      assert.equal(m.totalWinningPool.toString(), USDC(800).toString());
      assert.equal(m.feeAmount.toString(), USDC(50).toString());
      // Proof Receipt recorded on-chain.
      assert.equal(m.settleEpochDay, epochDay);
      assert.equal(m.settleResolver.toBase58(), payer.publicKey.toBase58());
      assert.equal(m.settleDailyRoots.toBase58(), dailyRootsPda(mock.programId, epochDay).toBase58());
    });

    it("cannot be settled twice", async () => {
      const { proof, epochDay } = buildProof(2, 1, FIXTURE, TS);
      try {
        await settle(market, OUTCOME_HOME_IDX, proof, epochDay);
        assert.fail("expected AlreadyResolved");
      } catch (e: any) {
        expect(e.toString()).to.match(/AlreadyResolved/);
      }
    });

    it("pays winners pro-rata, rejects losers and double-claims", async () => {
      const aliceAta = ata.get(alice.publicKey.toBase58())!;
      const bobAta = ata.get(bob.publicKey.toBase58())!;
      const aliceBefore = await balance(aliceAta);
      const bobBefore = await balance(bobAta);

      await claimWinnings(market, alice);
      await claimWinnings(market, bob);
      assert.equal((await balance(aliceAta)) - aliceBefore, BigInt("712500000")); // 600/800*950
      assert.equal((await balance(bobAta)) - bobBefore, BigInt("237500000")); //   200/800*950

      // Vault now holds exactly the fee (winners were paid exactly the distributable).
      assert.equal((await balance(vaultPda(program.programId, market))).toString(), USDC(50).toString());

      for (const loser of [carol, dave]) {
        try {
          await claimWinnings(market, loser);
          assert.fail("expected NotAWinningPosition");
        } catch (e: any) {
          expect(e.toString()).to.match(/NotAWinningPosition/);
        }
      }
      try {
        await claimWinnings(market, alice);
        assert.fail("expected AlreadyClaimed");
      } catch (e: any) {
        expect(e.toString()).to.match(/AlreadyClaimed/);
      }
      // Refund path is closed on a Settled market.
      try {
        await claimRefund(market, alice);
        assert.fail("expected NotCancelled");
      } catch (e: any) {
        expect(e.toString()).to.match(/NotCancelled/);
      }
    });

    it("withdraws the fee to the treasury exactly once, leaving the vault empty", async () => {
      const before = await balance(treasuryAta);
      await withdrawFees(market);
      assert.equal((await balance(treasuryAta)) - before, BigInt(USDC(50).toString()));
      // Vault is now exactly zero: winners + fee == total_pool.
      assert.equal((await balance(vaultPda(program.programId, market))).toString(), "0");
      assert.isTrue((await program.account.market.fetch(market)).feeWithdrawn);
      // No second withdrawal.
      try {
        await withdrawFees(market);
        assert.fail("expected FeesAlreadyWithdrawn");
      } catch (e: any) {
        expect(e.toString()).to.match(/FeesAlreadyWithdrawn/);
      }
    });

    it("rejects cancelling a settled market", async () => {
      try {
        await cancelMarket(market, dave);
        assert.fail("expected AlreadyResolved");
      } catch (e: any) {
        expect(e.toString()).to.match(/AlreadyResolved/);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Market B — settlement rejection
  // ══════════════════════════════════════════════════════════════════════════
  describe("B: settlement rejection", () => {
    const FIXTURE = new BN(1002);
    const TS = new BN(1_700_100_000_000);
    const market = marketPda(program.programId, payer.publicKey, FIXTURE, 0);

    before(async () => {
      const lockTime = new BN((await onchainNow(connection)) + LOCK_DELAY);
      await initMarket(market, FIXTURE, lockTime, RESOLUTION_TIMEOUT);
      await placeBet(market, alice, OUTCOME_HOME_IDX, USDC(100));
      await placeBet(market, carol, OUTCOME_AWAY_IDX, USDC(100));
      await waitUntilOnchain(connection, lockTime.toNumber());
      await lockMarket(market);
      const { dailyRoot, epochDay } = buildProof(3, 0, FIXTURE, TS);
      await publishRoot(dailyRoot, epochDay);
    });

    it("rejects a tampered Merkle proof", async () => {
      const { proof, epochDay } = buildProof(3, 0, FIXTURE, TS);
      proof.statAProof[0].hash[0] ^= 0xff;
      try {
        await settle(market, OUTCOME_HOME_IDX, proof, epochDay);
        assert.fail("expected verification failure");
      } catch (e: any) {
        expect(e.toString()).to.match(/StatProofMismatch|custom program error|0x/);
      }
      assert.isDefined((await program.account.market.fetch(market)).status.locked);
    });

    it("rejects a valid proof that does not satisfy the claimed outcome", async () => {
      const { proof, epochDay } = buildProof(3, 0, FIXTURE, TS);
      try {
        await settle(market, OUTCOME_AWAY_IDX, proof, epochDay);
        assert.fail("expected OutcomeNotVerified");
      } catch (e: any) {
        expect(e.toString()).to.match(/OutcomeNotVerified/);
      }
      assert.isDefined((await program.account.market.fetch(market)).status.locked);
    });

    it("settles when the correct outcome is proven", async () => {
      const { proof, epochDay } = buildProof(3, 0, FIXTURE, TS);
      await settle(market, OUTCOME_HOME_IDX, proof, epochDay);
      assert.isDefined((await program.account.market.fetch(market)).status.settled);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Market C — liveness escape hatch (cancel + refund)
  // ══════════════════════════════════════════════════════════════════════════
  describe("C: liveness — cancel & refund", () => {
    const FIXTURE = new BN(1003);
    const market = marketPda(program.programId, payer.publicKey, FIXTURE, 0);
    let deadline = 0;

    before(async () => {
      const lockTime = new BN((await onchainNow(connection)) + LOCK_DELAY);
      deadline = lockTime.toNumber() + CANCEL_TIMEOUT.toNumber();
      await initMarket(market, FIXTURE, lockTime, CANCEL_TIMEOUT);
      await placeBet(market, alice, OUTCOME_HOME_IDX, USDC(100));
      await placeBet(market, bob, OUTCOME_DRAW_IDX, USDC(50));
      await placeBet(market, carol, OUTCOME_AWAY_IDX, USDC(50));
      await waitUntilOnchain(connection, lockTime.toNumber());
      await lockMarket(market);
    });

    it("refuses to cancel before lock_time + resolution_timeout", async () => {
      try {
        await cancelMarket(market, dave);
        assert.fail("expected TooEarlyToCancel");
      } catch (e: any) {
        expect(e.toString()).to.match(/TooEarlyToCancel/);
      }
    });

    it("can be cancelled by any signer after the timeout (no winner set)", async () => {
      await waitUntilOnchain(connection, deadline + 1);
      await cancelMarket(market, dave); // permissionless, dave is not the creator
      const m = await program.account.market.fetch(market);
      assert.isDefined(m.status.cancelled);
      assert.equal(m.winningOutcome, 255); // never set
    });

    it("refuses to settle or re-cancel a cancelled market", async () => {
      const { proof, epochDay } = buildProof(1, 0, FIXTURE, new BN(1_700_600_000_000));
      try {
        await settle(market, OUTCOME_HOME_IDX, proof, epochDay);
        assert.fail("expected AlreadyResolved (settle)");
      } catch (e: any) {
        expect(e.toString()).to.match(/AlreadyResolved/);
      }
      try {
        await cancelMarket(market, dave);
        assert.fail("expected AlreadyResolved (cancel)");
      } catch (e: any) {
        expect(e.toString()).to.match(/AlreadyResolved/);
      }
    });

    it("refunds every bettor their EXACT stake, no fee", async () => {
      const check = async (u: Keypair, staked: BN) => {
        const acc = ata.get(u.publicKey.toBase58())!;
        const before = await balance(acc);
        await claimRefund(market, u);
        assert.equal((await balance(acc)) - before, BigInt(staked.toString()));
      };
      await check(alice, USDC(100));
      await check(bob, USDC(50));
      await check(carol, USDC(50));
      // Vault emptied exactly (no fee ever taken on a cancelled market).
      assert.equal((await balance(vaultPda(program.programId, market))).toString(), "0");
      // Double-refund rejected.
      try {
        await claimRefund(market, alice);
        assert.fail("expected AlreadyClaimed");
      } catch (e: any) {
        expect(e.toString()).to.match(/AlreadyClaimed/);
      }
      // Winnings path is closed on a cancelled market.
      try {
        await claimWinnings(market, alice);
        assert.fail("expected NotSettled");
      } catch (e: any) {
        expect(e.toString()).to.match(/NotSettled/);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Market D — zero-winning-pool policy (verified outcome, nobody staked it)
  // ══════════════════════════════════════════════════════════════════════════
  describe("D: zero-winning-pool becomes refundable", () => {
    const FIXTURE = new BN(1004);
    const TS = new BN(1_700_400_000_000);
    const market = marketPda(program.programId, payer.publicKey, FIXTURE, 0);

    before(async () => {
      const lockTime = new BN((await onchainNow(connection)) + LOCK_DELAY);
      await initMarket(market, FIXTURE, lockTime, RESOLUTION_TIMEOUT);
      // Nobody bets Home; the real result is a Home win.
      await placeBet(market, alice, OUTCOME_DRAW_IDX, USDC(100));
      await placeBet(market, bob, OUTCOME_AWAY_IDX, USDC(100));
      await waitUntilOnchain(connection, lockTime.toNumber());
      await lockMarket(market);
      const { dailyRoot, epochDay } = buildProof(1, 0, FIXTURE, TS);
      await publishRoot(dailyRoot, epochDay);
    });

    it("settles a verified-but-unstaked outcome into the refundable state", async () => {
      const { proof, epochDay } = buildProof(1, 0, FIXTURE, TS);
      await settle(market, OUTCOME_HOME_IDX, proof, epochDay);
      const m = await program.account.market.fetch(market);
      assert.isDefined(m.status.cancelled); // refundable
      assert.equal(m.winningOutcome, OUTCOME_HOME_IDX); // outcome still recorded
      assert.equal(m.feeAmount.toString(), "0"); // no fee on refunds
    });

    it("refunds all bettors and blocks winnings/fee withdrawal", async () => {
      for (const [u, amt] of [
        [alice, USDC(100)],
        [bob, USDC(100)],
      ] as [Keypair, BN][]) {
        const acc = ata.get(u.publicKey.toBase58())!;
        const before = await balance(acc);
        await claimRefund(market, u);
        assert.equal((await balance(acc)) - before, BigInt(amt.toString()));
      }
      assert.equal((await balance(vaultPda(program.programId, market))).toString(), "0");
      try {
        await withdrawFees(market);
        assert.fail("expected NotSettled (cancelled market has no fee)");
      } catch (e: any) {
        expect(e.toString()).to.match(/NotSettled/);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Market E — everyone bets the winning outcome; dust + exact solvency
  // ══════════════════════════════════════════════════════════════════════════
  describe("E: all-winners + rounding dust", () => {
    const FIXTURE = new BN(1005);
    const TS = new BN(1_700_500_000_000);
    const market = marketPda(program.programId, payer.publicKey, FIXTURE, 0);
    // Awkward stakes that produce rounding dust; all on Home.
    const sA = new BN("333333333");
    const sB = new BN("333333333");
    const sC = new BN("333333334"); // sums to 1_000_000_000 (1000 USDC)

    before(async () => {
      const lockTime = new BN((await onchainNow(connection)) + LOCK_DELAY);
      await initMarket(market, FIXTURE, lockTime, RESOLUTION_TIMEOUT);
      await placeBet(market, alice, OUTCOME_HOME_IDX, sA);
      await placeBet(market, bob, OUTCOME_HOME_IDX, sB);
      await placeBet(market, carol, OUTCOME_HOME_IDX, sC);
      await waitUntilOnchain(connection, lockTime.toNumber());
      await lockMarket(market);
      const { dailyRoot, epochDay } = buildProof(2, 0, FIXTURE, TS);
      await publishRoot(dailyRoot, epochDay);
      await settle(market, OUTCOME_HOME_IDX, proofOf(2, 0, FIXTURE, TS), epochDay);
    });

    function proofOf(a: number, b: number, f: BN, ts: BN) {
      return buildProof(a, b, f, ts).proof;
    }

    it("pays out exactly the distributable pool with dust absorbed, vault -> 0", async () => {
      const vault = vaultPda(program.programId, market);
      let paid = 0n;
      for (const u of [alice, bob, carol]) {
        const acc = ata.get(u.publicKey.toBase58())!;
        const before = await balance(acc);
        await claimWinnings(market, u);
        paid += (await balance(acc)) - before;
      }
      // Distributable = 1000 - 5% = 950 USDC; winners collectively receive it EXACTLY.
      assert.equal(paid, BigInt(USDC(950).toString()));
      // Vault holds exactly the fee; withdrawing it zeroes the vault.
      assert.equal((await balance(vault)).toString(), USDC(50).toString());
      await withdrawFees(market);
      assert.equal((await balance(vault)).toString(), "0");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Market F — near-u64 stakes handled without truncation
  //
  // NB: a *triggered* pool overflow is unreachable on-chain — the SPL supply is
  // itself u64-bounded, so the vault (<= total minted supply) can never exceed
  // u64::MAX. `place_bet`'s `checked_add` is therefore a defensive net, covered by
  // the Rust unit tests (`math::no_overflow_on_extreme_values`). What we CAN and do
  // verify on-chain is that a near-u64 stake is stored with no truncation.
  // ══════════════════════════════════════════════════════════════════════════
  describe("F: near-u64 stakes, no truncation", () => {
    const FIXTURE = new BN(1006);
    const market = marketPda(program.programId, payer.publicKey, FIXTURE, 0);
    const whale = Keypair.generate();
    const HUGE = new BN("18446744073709551615").sub(new BN(100)); // u64::MAX - 100

    before(async () => {
      await fund(whale.publicKey, 2);
      const fMint = await createMint(connection, payer, payer.publicKey, null, 6);
      const wAcc = await getOrCreateAssociatedTokenAccount(connection, payer, fMint, whale.publicKey);
      ata.set(whale.publicKey.toBase58(), wAcc.address);
      await mintTo(connection, payer, fMint, wAcc.address, payer, BigInt(HUGE.toString()));
      const lockTime = new BN((await onchainNow(connection)) + 3600); // far off; stays Open
      await initMarket(market, FIXTURE, lockTime, RESOLUTION_TIMEOUT, fMint);
    });

    it("stores a near-u64::MAX stake exactly (no truncation)", async () => {
      await placeBet(market, whale, OUTCOME_HOME_IDX, HUGE);
      const m = await program.account.market.fetch(market);
      assert.equal(m.totalPool.toString(), HUGE.toString());
      assert.equal(m.outcomes[OUTCOME_HOME_IDX].pool.toString(), HUGE.toString());
      assert.equal((await balance(vaultPda(program.programId, market))).toString(), HUGE.toString());
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // State-machine: remaining illegal transitions
  // ══════════════════════════════════════════════════════════════════════════
  describe("G: illegal transitions", () => {
    const FIXTURE = new BN(1007);
    const market = marketPda(program.programId, payer.publicKey, FIXTURE, 0);

    before(async () => {
      const lockTime = new BN((await onchainNow(connection)) + 3600); // stays Open
      await initMarket(market, FIXTURE, lockTime, RESOLUTION_TIMEOUT);
      await placeBet(market, alice, OUTCOME_HOME_IDX, USDC(10));
    });

    it("cannot cancel an Open market", async () => {
      try {
        await cancelMarket(market, dave);
        assert.fail("expected NotLocked");
      } catch (e: any) {
        expect(e.toString()).to.match(/NotLocked/);
      }
    });

    it("cannot refund an Open (non-cancelled) market", async () => {
      try {
        await claimRefund(market, alice);
        assert.fail("expected NotCancelled");
      } catch (e: any) {
        expect(e.toString()).to.match(/NotCancelled/);
      }
    });

    it("cannot claim winnings before settlement", async () => {
      try {
        await claimWinnings(market, alice);
        assert.fail("expected NotSettled");
      } catch (e: any) {
        expect(e.toString()).to.match(/NotSettled/);
      }
    });
  });
});
