/**
 * Parametric prop vault — pays out on a verified compound predicate.
 *
 * The track's own suggestion, answered literally: "Team A corners + Team B
 * corners > 10", escrowed in USDC, settled by ONE validate_stat_v3 proof.
 *
 * The property under test is not "does it pay" — it is "can anyone make it pay
 * the wrong way". The proof decides where the money goes; the caller does not.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

import {
  ADD,
  GT,
  buildProofV3,
  dailyRootsPda,
  onchainNow,
  waitUntilOnchain,
  binary,
} from "./helpers";

const USDC = (n: number) => new BN(n).mul(new BN(1_000_000));

const P1_CORNERS = { key: 7, period: 100 };
const P2_CORNERS = { key: 8, period: 100 };

describe("parametric prop vault — payout on a proven predicate", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.proofbook as Program<any>;
  const mock = anchor.workspace.mockOracle as Program<any>;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const connection = provider.connection;

  let usdcMint: PublicKey;
  let depositor: Keypair;
  let beneficiary: Keypair;
  let depositorAta: PublicKey;
  let beneficiaryAta: PublicKey;
  let nextId = 1;

  before(async () => {
    usdcMint = await createMint(connection, authority, authority.publicKey, null, 6);
    depositor = Keypair.generate();
    beneficiary = Keypair.generate();
    for (const kp of [depositor, beneficiary]) {
      await connection.confirmTransaction(
        await connection.requestAirdrop(kp.publicKey, 2e9)
      );
    }
    depositorAta = await createAssociatedTokenAccount(
      connection, depositor, usdcMint, depositor.publicKey
    );
    beneficiaryAta = await createAssociatedTokenAccount(
      connection, beneficiary, usdcMint, beneficiary.publicKey
    );
    await mintTo(
      connection, authority, usdcMint, depositorAta, authority,
      BigInt(USDC(100_000).toString())
    );
  });

  function vaultPdas(vaultId: number, dep: PublicKey) {
    const idLe = new BN(vaultId).toArrayLike(Buffer, "le", 8);
    const [pv] = PublicKey.findProgramAddressSync(
      [Buffer.from("prop_vault"), dep.toBuffer(), idLe],
      program.programId
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), pv.toBuffer()],
      program.programId
    );
    return { pv, vault };
  }

  /** "corners P1 + corners P2 > 10" — the track's own example. */
  async function makeVault(amount: BN, lockInSec = 5) {
    const vaultId = nextId++;
    const { pv, vault } = vaultPdas(vaultId, depositor.publicKey);
    const lockTime = (await onchainNow(connection)) + lockInSec;

    await program.methods
      .initializePropVault(
        new BN(vaultId),
        [P1_CORNERS, P2_CORNERS],
        [binary(0, 1, ADD, GT, 10)], // corners > 10
        new BN(950_001),
        amount,
        beneficiary.publicKey,
        new BN(lockTime),
        new BN(3600)
      )
      .accounts({
        depositor: depositor.publicKey,
        propVault: pv,
        usdcMint,
        vault,
        depositorToken: depositorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([depositor])
      .rpc();

    return { vaultId, pv, vault, lockTime };
  }

  async function settle(
    pv: PublicKey,
    vault: PublicKey,
    corners: [number, number],
    cranker = authority
  ) {
    const tsMs = new BN(Date.now());
    const built = buildProofV3(
      [
        { ...P1_CORNERS, value: corners[0] },
        { ...P2_CORNERS, value: corners[1] },
      ],
      new BN(950_001),
      tsMs
    );
    const roots = dailyRootsPda(mock.programId, built.epochDay);
    await mock.methods
      .publishDailyRoot(built.epochDay, built.dailyRoot)
      .accounts({
        dailyScoresMerkleRoots: roots,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return program.methods
      .settlePropVault(built.proof)
      .accounts({
        cranker: cranker.publicKey,
        propVault: pv,
        vault,
        beneficiaryToken: beneficiaryAta,
        depositorToken: depositorAta,
        oracleProgram: mock.programId,
        oracleRoots: roots,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(cranker === authority ? [] : [cranker])
      .preInstructions([
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ])
      .rpc();
  }

  it("pays the beneficiary when the predicate HOLDS (12 corners > 10)", async () => {
    const amount = USDC(5_000);
    const { pv, vault, lockTime } = await makeVault(amount);
    await waitUntilOnchain(connection, lockTime);

    const before = await getAccount(connection, beneficiaryAta);
    await settle(pv, vault, [7, 5]); // 12 > 10 -> HOLDS
    const after = await getAccount(connection, beneficiaryAta);

    assert.equal(
      Number(after.amount) - Number(before.amount),
      Number(amount),
      "the beneficiary receives the whole escrow"
    );
    const v = await program.account.propVault.fetch(pv);
    assert.equal(Object.keys(v.status)[0], "paidOut");
    assert.notEqual(
      Buffer.from(v.settleProofRef).toString("hex"),
      "0".repeat(64),
      "the vault carries a proof receipt"
    );
    const escrow = await getAccount(connection, vault);
    assert.equal(Number(escrow.amount), 0, "escrow is drained");
  });

  it("refunds the depositor when the predicate FAILS (6 corners, not > 10)", async () => {
    const amount = USDC(3_000);
    const { pv, vault, lockTime } = await makeVault(amount);
    await waitUntilOnchain(connection, lockTime);

    const before = await getAccount(connection, depositorAta);
    await settle(pv, vault, [4, 2]); // 6 -> FAILS
    const after = await getAccount(connection, depositorAta);

    assert.equal(
      Number(after.amount) - Number(before.amount),
      Number(amount),
      "the depositor gets their money back"
    );
    const v = await program.account.propVault.fetch(pv);
    assert.equal(Object.keys(v.status)[0], "refunded");
  });

  it("is PERMISSIONLESS — a stranger can settle, and gains nothing by it", async () => {
    const amount = USDC(1_000);
    const { pv, vault, lockTime } = await makeVault(amount);
    await waitUntilOnchain(connection, lockTime);

    // A wallet with no relationship to the vault at all.
    const stranger = Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(stranger.publicKey, 1e9)
    );

    const before = await getAccount(connection, beneficiaryAta);
    await settle(pv, vault, [8, 8], stranger); // 16 > 10 -> HOLDS
    const after = await getAccount(connection, beneficiaryAta);

    // The stranger moved the money — to the BENEFICIARY. Not to themselves.
    assert.equal(Number(after.amount) - Number(before.amount), Number(amount));
    const v = await program.account.propVault.fetch(pv);
    assert.equal(v.settleResolver.toBase58(), stranger.publicKey.toBase58());
    assert.equal(Object.keys(v.status)[0], "paidOut");
  });

  it("cannot be tricked into paying by forging the proven values", async () => {
    const amount = USDC(2_000);
    const { pv, vault, lockTime } = await makeVault(amount);
    await waitUntilOnchain(connection, lockTime);

    // Build an honest proof for 6 corners (predicate FAILS), then lie about the
    // values to force a payout. The multiproof was computed over the true leaves.
    const tsMs = new BN(Date.now());
    const honest = buildProofV3(
      [
        { ...P1_CORNERS, value: 4 },
        { ...P2_CORNERS, value: 2 },
      ],
      new BN(950_001),
      tsMs
    );
    const roots = dailyRootsPda(mock.programId, honest.epochDay);
    await mock.methods
      .publishDailyRoot(honest.epochDay, honest.dailyRoot)
      .accounts({
        dailyScoresMerkleRoots: roots,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const forged = { ...honest.proof, leafValues: [9, 9] }; // 18 > 10

    try {
      await program.methods
        .settlePropVault(forged)
        .accounts({
          cranker: authority.publicKey,
          propVault: pv,
          vault,
          beneficiaryToken: beneficiaryAta,
          depositorToken: depositorAta,
          oracleProgram: mock.programId,
          oracleRoots: roots,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ])
        .rpc();
      assert.fail("a forged value must not release the escrow");
    } catch (e: any) {
      assert.include(JSON.stringify(e), "StatProofMismatch");
    }

    const escrow = await getAccount(connection, vault);
    assert.equal(Number(escrow.amount), Number(amount), "the money did not move");
    const v = await program.account.propVault.fetch(pv);
    assert.equal(Object.keys(v.status)[0], "funded");
  });

  it("rejects a vault whose predicate leaves a leg unevaluated (TxLINE 6071)", async () => {
    const vaultId = nextId++;
    const { pv, vault } = vaultPdas(vaultId, depositor.publicKey);
    const lockTime = (await onchainNow(connection)) + 60;
    try {
      await program.methods
        .initializePropVault(
          new BN(vaultId),
          [P1_CORNERS, P2_CORNERS],
          [binary(0, 0, ADD, GT, 10)], // leg 1 proven but never evaluated
          new BN(950_001),
          USDC(100),
          beneficiary.publicKey,
          new BN(lockTime),
          new BN(3600)
        )
        .accounts({
          depositor: depositor.publicKey,
          propVault: pv,
          usdcMint,
          vault,
          depositorToken: depositorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([depositor])
        .rpc();
      assert.fail("must not fund a vault that could never settle");
    } catch (e: any) {
      const s = JSON.stringify(e);
      assert.isTrue(
        /DuplicateLegCoverage|IncompleteLegCoverage/.test(s),
        `expected a coverage error, got ${s.slice(0, 120)}`
      );
    }
  });
});
