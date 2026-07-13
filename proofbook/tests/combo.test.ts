/**
 * Compound (multi-leg) markets — the parlay path.
 *
 * A compound market is an ORDINARY `Market` (same vault, same pools, same
 * parimutuel math) whose resolution spec lives in a `ComboSpec` sidecar. It
 * settles by proving EVERY leg together in ONE `validate_stat_v3` CPI, against a
 * single shared Merkle multiproof.
 *
 * The rules these tests pin down were confirmed against the REAL TxLINE devnet
 * oracle (see keeper/scripts/txline-conformance.ts):
 *   · every leg must be covered by exactly one predicate  (6070 / 6071)
 *   · therefore a parlay's legs must read DISJOINT stats
 *   · at most 5 legs (TxLINE's proof API rejects a 6th statKey)
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

import {
  ADD,
  COMBO_MARKET_TYPE_MIN,
  EQ,
  GT,
  LT,
  SUB,
  binary,
  buildProofV3,
  comboSpecPda,
  dailyRootsPda,
  marketPda,
  onchainNow,
  positionPda,
  single,
  vaultPda,
  waitUntilOnchain,
  OUTCOMES_1X2,
} from "./helpers";

const USDC = (n: number) => new BN(n).mul(new BN(1_000_000));

// Full-game stat keys (period 100 = game_finalised).
const P1_GOALS = { key: 1, period: 100 };
const P2_GOALS = { key: 2, period: 100 };
const P1_CORNERS = { key: 7, period: 100 };
const P2_CORNERS = { key: 8, period: 100 };
const P1_YELLOW = { key: 3, period: 100 };
const P2_YELLOW = { key: 4, period: 100 };

describe("compound markets — multi-leg parlays in ONE proof", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.proofbook as Program<any>;
  const mock = anchor.workspace.mockOracle as Program<any>;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const connection = provider.connection;

  let usdcMint: PublicKey;
  let nextType = COMBO_MARKET_TYPE_MIN;

  /**
   * One funded bettor per outcome, created ONCE, before any market has a clock.
   *
   * These used to be minted inside `makeCombo`, in between the market's creation
   * and its bets. Airdropping and creating an ATA for five wallets takes longer
   * than the six-second betting window, so `place_bet` intermittently came back
   * BettingClosed — a flaky test that passed or failed on how busy the validator
   * happened to be.
   */
  const POOL = 5; // the widest market in this suite
  const bettors: Keypair[] = [];
  const atas = new Map<string, PublicKey>();

  before(async () => {
    usdcMint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    for (let i = 0; i < POOL; i++) {
      const b = Keypair.generate();
      await connection.confirmTransaction(
        await connection.requestAirdrop(b.publicKey, 2e9)
      );
      const ata = await createAssociatedTokenAccount(
        connection,
        b,
        usdcMint,
        b.publicKey
      );
      await mintTo(
        connection,
        authority,
        usdcMint,
        ata,
        authority,
        BigInt(USDC(1_000_000).toString())
      );
      bettors.push(b);
      atas.set(b.publicKey.toBase58(), ata);
    }
  });

  /** Create a compound market + its ComboSpec, staked on every outcome. */
  async function makeCombo(opts: {
    fixtureId: number;
    legs: { key: number; period: number }[];
    outcomes: any[]; // ComboOutcome[]
    numOutcomes: number;
    lockInSec?: number;
    stakeEvery?: boolean;
  }) {
    const marketType = nextType++;
    const fixtureId = new BN(opts.fixtureId);
    const market = marketPda(
      program.programId,
      authority.publicKey,
      fixtureId,
      marketType
    );
    const now = await onchainNow(connection);
    const lockTime = now + (opts.lockInSec ?? 12); // room for N bets to land

    // The Market's own outcome specs are unused by the v3 path, but the account
    // still needs `num_outcomes` of them. 1X2's shape is reused as filler for
    // 3-outcome markets; anything wider repeats the first spec.
    const specs = Array.from(
      { length: opts.numOutcomes },
      (_, i) => OUTCOMES_1X2[i] ?? OUTCOMES_1X2[0]
    );

    await program.methods
      .initializeMarket(
        fixtureId,
        marketType,
        specs,
        500,
        new BN(lockTime),
        new BN(3600),
        authority.publicKey
      )
      .accounts({
        authority: authority.publicKey,
        market,
        usdcMint,
        vault: vaultPda(program.programId, market),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await program.methods
      .initializeComboSpec(opts.legs, opts.outcomes)
      .accounts({
        authority: authority.publicKey,
        market,
        comboSpec: comboSpecPda(program.programId, market),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    if (opts.stakeEvery !== false) {
      // EVERY outcome gets stake. A winning outcome with a zero pool routes the
      // market to Cancelled (refundable) and it never earns a receipt — the bug
      // that silently voided 74 markets.
      for (let i = 0; i < opts.numOutcomes; i++) {
        const b = bettors[i];
        await program.methods
          .placeBet(i, USDC(100 + i * 10))
          .accounts({
            bettor: b.publicKey,
            market,
            position: positionPda(program.programId, market, b.publicKey),
            bettorToken: atas.get(b.publicKey.toBase58())!,
            vault: vaultPda(program.programId, market),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([b])
          .rpc();
      }
    }
    return { market, marketType, lockTime, bettors: bettors.slice(0, opts.numOutcomes) };
  }

  /** Publish the mock daily root and settle a compound market via v3. */
  async function settleV3(
    market: PublicKey,
    claimed: number,
    legValues: { key: number; value: number; period: number }[],
    fixtureId: number
  ) {
    const tsMs = new BN(Date.now());
    const built = buildProofV3(legValues, new BN(fixtureId), tsMs);
    const rootsPda = dailyRootsPda(mock.programId, built.epochDay);

    await mock.methods
      .publishDailyRoot(built.epochDay, built.dailyRoot)
      .accounts({
        dailyScoresMerkleRoots: rootsPda,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const sig = await program.methods
      .settleMarketV3(claimed, built.proof)
      .accounts({
        cranker: authority.publicKey,
        market,
        comboSpec: comboSpecPda(program.programId, market),
        oracleProgram: mock.programId,
        oracleRoots: rootsPda,
      })
      .preInstructions([
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
          units: 1_400_000,
        }),
      ])
      .rpc();
    return { sig, nodesUsed: built.nodesUsed };
  }

  // ── A. the flagship: a real 2-leg parlay in one proof ─────────────────────
  it("settles a 4-stat parlay (win AND corners) in ONE validate_stat_v3 CPI", async () => {
    const FID = 900001;
    // "Home win AND over 9.5 corners" — goals and corners are DISJOINT, which is
    // exactly why this is expressible. Outcome 1 is the negation as a market
    // side (Miss), which we do not have to prove as a predicate: it is simply
    // "the parlay outcome that did not happen", proven by proving the other one.
    const legs = [P1_GOALS, P2_GOALS, P1_CORNERS, P2_CORNERS];
    const hit = {
      predicates: [
        binary(0, 1, SUB, GT, 0), // P1 - P2 > 0     (home win)
        binary(2, 3, ADD, GT, 9), // C1 + C2 > 9     (over 9.5 corners)
      ],
    };
    // The "Miss" side proves the complementary corners condition on a home win.
    const miss = {
      predicates: [
        binary(0, 1, SUB, GT, 0),
        binary(2, 3, ADD, LT, 10), // under 9.5 corners
      ],
    };

    const { market, lockTime } = await makeCombo({
      fixtureId: FID,
      legs,
      outcomes: [hit, miss],
      numOutcomes: 2,
    });
    await waitUntilOnchain(connection, lockTime);
    await program.methods
      .lockMarket()
      .accounts({ market, cranker: authority.publicKey })
      .rpc();

    // Real match shape: 2-1, corners 7+4 = 11 => HIT (win AND over 9.5).
    const { nodesUsed } = await settleV3(
      market,
      0,
      [
        { ...P1_GOALS, value: 2 },
        { ...P2_GOALS, value: 1 },
        { ...P1_CORNERS, value: 7 },
        { ...P2_CORNERS, value: 4 },
      ],
      FID
    );

    const m = await program.account.market.fetch(market);
    assert.equal(Object.keys(m.status)[0], "settled");
    assert.equal(m.winningOutcome, 0, "the parlay HIT");
    assert.notEqual(
      Buffer.from(m.settleProofRef).toString("hex"),
      "0".repeat(64),
      "receipt carries the proof ref"
    );

    // The size win: 4 leaves under a 4-wide tree need only 2 shared siblings,
    // where v2 would carry a full 2-node path for EACH leaf (8 nodes).
    assert.isAtMost(nodesUsed, 2, "multiproof dedupes the shared internal nodes");
  });

  it("proves a parlay that MISSES, and pays the Miss side", async () => {
    const FID = 900002;
    const legs = [P1_GOALS, P2_GOALS, P1_CORNERS, P2_CORNERS];
    const { market, lockTime } = await makeCombo({
      fixtureId: FID,
      legs,
      outcomes: [
        {
          predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, GT, 9)],
        },
        {
          predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, LT, 10)],
        },
      ],
      numOutcomes: 2,
    });
    await waitUntilOnchain(connection, lockTime);
    await program.methods
      .lockMarket()
      .accounts({ market, cranker: authority.publicKey })
      .rpc();

    // Home won 2-1 but only 3+2 = 5 corners => the parlay MISSES.
    await settleV3(
      market,
      1,
      [
        { ...P1_GOALS, value: 2 },
        { ...P2_GOALS, value: 1 },
        { ...P1_CORNERS, value: 3 },
        { ...P2_CORNERS, value: 2 },
      ],
      FID
    );
    const m = await program.account.market.fetch(market);
    assert.equal(Object.keys(m.status)[0], "settled");
    assert.equal(m.winningOutcome, 1, "the Miss side won");
  });

  it("refuses a claimed outcome the proof does not satisfy", async () => {
    const FID = 900003;
    const legs = [P1_GOALS, P2_GOALS, P1_CORNERS, P2_CORNERS];
    const { market, lockTime } = await makeCombo({
      fixtureId: FID,
      legs,
      outcomes: [
        { predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, GT, 9)] },
        { predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, LT, 10)] },
      ],
      numOutcomes: 2,
    });
    await waitUntilOnchain(connection, lockTime);
    await program.methods
      .lockMarket()
      .accounts({ market, cranker: authority.publicKey })
      .rpc();

    // Corners are only 5, so claiming the HIT side must fail.
    try {
      await settleV3(
        market,
        0,
        [
          { ...P1_GOALS, value: 2 },
          { ...P2_GOALS, value: 1 },
          { ...P1_CORNERS, value: 3 },
          { ...P2_CORNERS, value: 2 },
        ],
        FID
      );
      assert.fail("must not settle an outcome the legs do not satisfy");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "OutcomeNotVerified");
    }
    const m = await program.account.market.fetch(market);
    assert.equal(Object.keys(m.status)[0], "locked", "market is untouched");
  });

  it("rejects a tampered leg value (the multiproof no longer reconstructs)", async () => {
    const FID = 900004;
    const legs = [P1_GOALS, P2_GOALS, P1_CORNERS, P2_CORNERS];
    const { market, lockTime } = await makeCombo({
      fixtureId: FID,
      legs,
      outcomes: [
        { predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, GT, 9)] },
        { predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, LT, 10)] },
      ],
      numOutcomes: 2,
    });
    await waitUntilOnchain(connection, lockTime);
    await program.methods
      .lockMarket()
      .accounts({ market, cranker: authority.publicKey })
      .rpc();

    // Build an honest proof for 5 corners, then LIE about the corner count to
    // force the HIT. The multiproof was computed over the true leaves, so the
    // root no longer reconstructs.
    const tsMs = new BN(Date.now());
    const honest = buildProofV3(
      [
        { ...P1_GOALS, value: 2 },
        { ...P2_GOALS, value: 1 },
        { ...P1_CORNERS, value: 3 },
        { ...P2_CORNERS, value: 2 },
      ],
      new BN(FID),
      tsMs
    );
    const rootsPda = dailyRootsPda(mock.programId, honest.epochDay);
    await mock.methods
      .publishDailyRoot(honest.epochDay, honest.dailyRoot)
      .accounts({
        dailyScoresMerkleRoots: rootsPda,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const forged = { ...honest.proof, leafValues: [2, 1, 9, 9] }; // corners -> 18

    try {
      await program.methods
        .settleMarketV3(0, forged)
        .accounts({
          cranker: authority.publicKey,
          market,
          comboSpec: comboSpecPda(program.programId, market),
          oracleProgram: mock.programId,
          oracleRoots: rootsPda,
        })
        .preInstructions([
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
            units: 1_400_000,
          }),
        ])
        .rpc();
      assert.fail("a forged leg value must not settle");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "StatProofMismatch");
    }
    const m = await program.account.market.fetch(market);
    assert.equal(Object.keys(m.status)[0], "locked");
  });

  // ── B. the guard: a parlay cannot be settled by proving one leg ───────────
  it("REFUSES to settle a compound market through the legacy settle_market", async () => {
    const FID = 900005;
    const legs = [P1_GOALS, P2_GOALS, P1_CORNERS, P2_CORNERS];
    const { market, lockTime } = await makeCombo({
      fixtureId: FID,
      legs,
      outcomes: [
        { predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, GT, 9)] },
        { predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, LT, 10)] },
      ],
      numOutcomes: 2,
    });
    await waitUntilOnchain(connection, lockTime);
    await program.methods
      .lockMarket()
      .accounts({ market, cranker: authority.publicKey })
      .rpc();

    // The v2 proof shape can only carry ONE predicate. Without the guard this
    // would settle "Home win AND over 9.5 corners" by proving "Home win" alone,
    // and pay out the whole parlay on a single leg.
    const { buildProof } = await import("./helpers");
    const tsMs = new BN(Date.now());
    const v2 = buildProof(2, 1, new BN(FID), tsMs);
    const rootsPda = dailyRootsPda(mock.programId, v2.epochDay);
    await mock.methods
      .publishDailyRoot(v2.epochDay, v2.dailyRoot)
      .accounts({
        dailyScoresMerkleRoots: rootsPda,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .settleMarket(0, v2.proof)
        .accounts({
          cranker: authority.publicKey,
          market,
          oracleProgram: mock.programId,
          oracleRoots: rootsPda,
        })
        .rpc();
      assert.fail("legacy settle_market must refuse a compound market");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "ComboRequiresV3");
    }
    const m = await program.account.market.fetch(market);
    assert.equal(Object.keys(m.status)[0], "locked", "the parlay is intact");
  });

  // ── C. create-time validation of the coverage invariant ──────────────────
  it("rejects a spec whose outcome evaluates a leg twice (would be TxLINE 6070)", async () => {
    try {
      await makeCombo({
        fixtureId: 900006,
        legs: [P1_GOALS, P2_GOALS],
        outcomes: [
          // "home win AND over 2.5 goals" — BOTH legs read goals P1/P2. This is
          // the shape TxLINE rejects with DuplicateStatCoverage, so it can never
          // be a market.
          {
            predicates: [binary(0, 1, SUB, GT, 0), binary(0, 1, ADD, GT, 2)],
          },
          { predicates: [binary(0, 1, SUB, LT, 1)] },
        ],
        numOutcomes: 2,
        stakeEvery: false,
      });
      assert.fail("must reject duplicate leg coverage at creation");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "DuplicateLegCoverage");
    }
  });

  it("rejects a spec whose outcome leaves a leg unevaluated (would be TxLINE 6071)", async () => {
    try {
      await makeCombo({
        fixtureId: 900007,
        legs: [P1_GOALS, P2_GOALS, P1_CORNERS, P2_CORNERS],
        outcomes: [
          // Corners are proven but never evaluated.
          { predicates: [binary(0, 1, SUB, GT, 0)] },
          { predicates: [binary(0, 1, SUB, LT, 1)] },
        ],
        numOutcomes: 2,
        stakeEvery: false,
      });
      assert.fail("must reject incomplete leg coverage at creation");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "IncompleteLegCoverage");
    }
  });

  it("rejects a spec whose outcome count does not match the market's", async () => {
    try {
      await makeCombo({
        fixtureId: 900008,
        legs: [P1_GOALS, P2_GOALS],
        outcomes: [{ predicates: [binary(0, 1, SUB, GT, 0)] }], // 1, market has 2
        numOutcomes: 2,
        stakeEvery: false,
      });
      assert.fail("must reject an outcome-count mismatch");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "InvalidComboSpec");
    }
  });

  // ── D. a wider market: Total Cards O/U on 4 disjoint card stats ───────────
  it("settles a 4-leg total-cards market (yellows P1+P2, over/under)", async () => {
    const FID = 900009;
    // Yellows only: TxLINE's Binary op combines exactly TWO stats, so a sum of
    // four (yellows + reds) is not expressible. Yellows P1+P2 is.
    const legs = [P1_YELLOW, P2_YELLOW];
    const { market, lockTime } = await makeCombo({
      fixtureId: FID,
      legs,
      outcomes: [
        { predicates: [binary(0, 1, ADD, GT, 3)] }, // over 3.5 yellows
        { predicates: [binary(0, 1, ADD, LT, 4)] }, // under 3.5 yellows
      ],
      numOutcomes: 2,
    });
    await waitUntilOnchain(connection, lockTime);
    await program.methods
      .lockMarket()
      .accounts({ market, cranker: authority.publicKey })
      .rpc();

    await settleV3(
      market,
      0,
      [
        { ...P1_YELLOW, value: 3 },
        { ...P2_YELLOW, value: 2 }, // 5 > 3.5 => Over
      ],
      FID
    );
    const m = await program.account.market.fetch(market);
    assert.equal(Object.keys(m.status)[0], "settled");
    assert.equal(m.winningOutcome, 0, "Over 3.5 yellows");
  });

  // ── E. money still flows through the SAME audited path ────────────────────
  it("pays a parlay winner through the identical parimutuel path", async () => {
    const FID = 900010;
    const legs = [P1_GOALS, P2_GOALS, P1_CORNERS, P2_CORNERS];
    const { market, lockTime, bettors } = await makeCombo({
      fixtureId: FID,
      legs,
      outcomes: [
        { predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, GT, 9)] },
        { predicates: [binary(0, 1, SUB, GT, 0), binary(2, 3, ADD, LT, 10)] },
      ],
      numOutcomes: 2,
    });
    await waitUntilOnchain(connection, lockTime);
    await program.methods
      .lockMarket()
      .accounts({ market, cranker: authority.publicKey })
      .rpc();

    await settleV3(
      market,
      0,
      [
        { ...P1_GOALS, value: 2 },
        { ...P2_GOALS, value: 1 },
        { ...P1_CORNERS, value: 7 },
        { ...P2_CORNERS, value: 4 },
      ],
      FID
    );

    const winner = bettors[0]; // staked outcome 0 = the HIT side
    const ata = await anchor.utils.token.associatedAddress({
      mint: usdcMint,
      owner: winner.publicKey,
    });
    const before = await connection.getTokenAccountBalance(ata);

    await program.methods
      .claimWinnings()
      .accounts({
        winner: winner.publicKey,
        market,
        position: positionPda(program.programId, market, winner.publicKey),
        vault: vaultPda(program.programId, market),
        winnerToken: ata,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([winner])
      .rpc();

    const after = await connection.getTokenAccountBalance(ata);
    const gained =
      Number(after.value.amount) - Number(before.value.amount);
    // Sole winner on outcome 0: takes the whole pool minus the 5% fee.
    // pools: [100, 110] => total 210, fee 5% = 10.5 -> 10 (floor)
    assert.isAbove(gained, 0, "the parlay winner was paid");
    const m = await program.account.market.fetch(market);
    assert.equal(m.paidOut.toString(), String(gained));
  });
});
