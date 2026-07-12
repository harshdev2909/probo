import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { KeeperConfig, ROOT } from "../config";
import { Logger } from "../logger";
import { Store, type StoreLike } from "../state";
import { marketPda, vaultPda, positionPda, dailyRootsPda } from "./pdas";
import { buildMockProof } from "./mockProof";

export const TXLINE_DEVNET = new PublicKey(
  "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
);

export type MarketStatusName = "open" | "locked" | "settled" | "cancelled";

export function statusName(status: any): MarketStatusName {
  return Object.keys(status)[0] as MarketStatusName;
}

/** 1X2 (Home/Draw/Away) outcome specs on P1−P2 goal difference at `period`. */
export function matchWinnerSpecs(statKeys: [number, number], period: number) {
  const base = {
    statAKey: statKeys[0],
    statAPeriod: period,
    hasStatB: true,
    statBKey: statKeys[1],
    statBPeriod: period,
    op: { subtract: {} },
  };
  return [
    { ...base, comparison: { greaterThan: {} }, threshold: 0 }, // 0 Home
    { ...base, comparison: { equalTo: {} }, threshold: 0 }, // 1 Draw
    { ...base, comparison: { lessThan: {} }, threshold: 0 }, // 2 Away
  ];
}

/**
 * Where to find an IDL.
 *
 * `target/` is gitignored (it is Anchor build output), so on a deploy host it does
 * not exist and reading the IDL from there crashes the process at boot. The IDL is
 * therefore committed to `idl/`, and that is checked FIRST; `target/` is only a
 * fallback for a local tree that has just been rebuilt.
 *
 * Re-sync after changing the program: `npm run idl:sync`.
 */
function idlPath(name: string): string {
  const committed = path.join(ROOT, "idl", `${name}.json`);
  if (fs.existsSync(committed)) return committed;
  const built = path.join(ROOT, "target", "idl", `${name}.json`);
  if (fs.existsSync(built)) return built;
  throw new Error(
    `IDL not found for "${name}". Run \`anchor build\` then \`npm run idl:sync\`.`
  );
}

export const OUTCOME_LABELS = ["Home", "Draw", "Away"];

export class Chain {
  provider: anchor.AnchorProvider;
  connection: Connection;
  wallet: Keypair;
  program: any; // proofbook
  mockOracle?: any;
  oracleProgramId: PublicKey;
  private log = new Logger("chain");

  constructor(private cfg: KeeperConfig, private store: StoreLike) {
    const secret = JSON.parse(fs.readFileSync(cfg.walletPath, "utf8"));
    this.wallet = Keypair.fromSecretKey(Uint8Array.from(secret));
    this.connection = new Connection(cfg.rpcUrl, "confirmed");
    this.provider = new anchor.AnchorProvider(
      this.connection,
      new anchor.Wallet(this.wallet),
      { commitment: "confirmed" }
    );
    anchor.setProvider(this.provider);

    const proofbookIdl = JSON.parse(
      fs.readFileSync(idlPath("proofbook"), "utf8")
    );
    this.program = new anchor.Program(proofbookIdl, this.provider) as any;

    if (cfg.oracleMode === "mock") {
      const mockIdl = JSON.parse(
        fs.readFileSync(idlPath("mock_oracle"), "utf8")
      );
      this.mockOracle = new anchor.Program(mockIdl, this.provider) as any;
      this.oracleProgramId = this.mockOracle.programId;
    } else {
      this.oracleProgramId = TXLINE_DEVNET;
    }
    this.log.info("chain ready", {
      wallet: this.wallet.publicKey.toBase58(),
      program: this.program.programId.toBase58(),
      oracle: this.oracleProgramId.toBase58(),
      oracleMode: cfg.oracleMode,
    });
  }

  /** Escrow mint: env-provided, persisted from a prior run, or auto-created. */
  async ensureUsdcMint(): Promise<PublicKey> {
    if (this.cfg.usdcMint) return new PublicKey(this.cfg.usdcMint);
    if (this.store.data.mints.usdcMint) {
      const pk = new PublicKey(this.store.data.mints.usdcMint);
      if (await this.connection.getAccountInfo(pk)) return pk;
      this.log.warn(
        "persisted usdcMint not found on-chain; creating a new one"
      );
    }
    const mint = await createMint(
      this.connection,
      this.wallet,
      this.wallet.publicKey,
      null,
      6
    );
    this.store.data.mints.usdcMint = mint.toBase58();
    this.store.saveSoon();
    this.log.warn("auto-created escrow mint (set USDC_MINT to pin one)", {
      mint: mint.toBase58(),
    });
    return mint;
  }

  /** The keeper wallet (payer for mints/funding in the seeding scripts). */
  get payer(): Keypair {
    return this.wallet;
  }

  /**
   * Place a bet as an arbitrary signer. Used by the liquidity seeder: Position
   * is a PDA of (market, owner), so each wallet can hold exactly one outcome —
   * three wallets give every outcome a non-zero pool.
   */
  async placeBetAs(
    bettor: Keypair,
    market: PublicKey,
    outcomeIndex: number,
    amount: BN
  ): Promise<string> {
    const m = await this.program.account.market.fetch(market);
    const bettorAta = getAssociatedTokenAddressSync(
      m.usdcMint,
      bettor.publicKey
    );
    return this.program.methods
      .placeBet(outcomeIndex, amount)
      .accounts({
        bettor: bettor.publicKey,
        market,
        bettorToken: bettorAta,
        vault: m.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([bettor])
      .rpc();
  }

  /**
   * Stake all three outcomes in ONE transaction. Atomicity matters: a market
   * that gets only some of its bets in would leave an outcome with zero stake,
   * and if that outcome then wins, settle_market routes the market to
   * `Cancelled (refundable)` and it never earns a Proof Receipt. All-or-nothing
   * removes that failure mode entirely.
   */
  async placeBetsAtomic(
    bettors: Keypair[],
    market: PublicKey,
    amounts: BN[]
  ): Promise<string> {
    const m = await this.program.account.market.fetch(market);
    const tx = new Transaction();
    for (let i = 0; i < bettors.length; i++) {
      tx.add(
        await this.program.methods
          .placeBet(i, amounts[i])
          .accounts({
            bettor: bettors[i].publicKey,
            market,
            bettorToken: getAssociatedTokenAddressSync(
              m.usdcMint,
              bettors[i].publicKey
            ),
            vault: m.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction()
      );
    }
    return this.provider.sendAndConfirm!(tx, bettors);
  }

  /**
   * Devnet demo faucet. The keeper minted the escrow token, so it holds the mint
   * authority and can top a connected wallet up so it can actually place a bet.
   *
   * It hands out two things, because a bet needs both:
   *   · the demo USDC being staked
   *   · a little SOL — place_bet opens a Position account and the BETTOR pays its
   *     rent, so a wallet with zero SOL cannot bet no matter how much USDC it holds
   *
   * The token is a valueless devnet mint we created; it is not USDC and is worth
   * nothing. Tops up to a cap rather than minting on every call.
   */
  async faucet(
    owner: PublicKey,
    { usdcCap = 10_000, solFloor = 0.02 } = {}
  ): Promise<{ usdc: number; sol: number; mint: string; sig?: string }> {
    const mint = await this.ensureUsdcMint();

    // SOL first: without it the bet cannot pay for its own Position account.
    let solTopUp = 0;
    const lamports = await this.connection.getBalance(owner);
    if (lamports < solFloor * LAMPORTS_PER_SOL) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey: owner,
          lamports: Math.floor(solFloor * LAMPORTS_PER_SOL),
        })
      );
      await this.provider.sendAndConfirm!(tx, []);
      solTopUp = solFloor;
    }

    // The ATA is created here (keeper pays its rent), so place_bet finds it.
    const ata = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.wallet,
      mint,
      owner
    );
    const have = Number(ata.amount) / 1e6;
    let sig: string | undefined;
    let minted = 0;
    if (have < usdcCap) {
      minted = usdcCap - have;
      sig = await mintTo(
        this.connection,
        this.wallet,
        mint,
        ata.address,
        this.wallet,
        BigInt(Math.round(minted * 1e6))
      );
    }
    this.log.info("faucet", {
      owner: owner.toBase58(),
      usdc: minted,
      sol: solTopUp,
    });
    return { usdc: minted, sol: solTopUp, mint: mint.toBase58(), sig };
  }

  marketPdaFor(fixtureId: number, marketType: number): PublicKey {
    return marketPda(
      this.program.programId,
      this.wallet.publicKey,
      new BN(fixtureId),
      marketType
    );
  }

  async fetchMarket(pda: PublicKey): Promise<any | null> {
    return this.program.account.market.fetchNullable(pda);
  }

  async allMarkets(): Promise<Array<{ publicKey: PublicKey; account: any }>> {
    return this.program.account.market.all();
  }

  async positionsByOwner(owner: PublicKey) {
    // Position layout: 8 disc + 32 market + 32 owner ...
    return this.program.account.position.all([
      { memcmp: { offset: 8 + 32, bytes: owner.toBase58() } },
    ]);
  }

  async initializeMarket(
    fixtureId: number,
    marketType: number,
    usdcMint: PublicKey,
    lockTime: number,
    resolutionTimeoutSec: number,
    /** The ScoreStat period this fixture's proof carries (5/10/13/100). */
    statPeriod: number = this.cfg.statPeriod
  ): Promise<{ market: PublicKey; sig: string }> {
    const market = this.marketPdaFor(fixtureId, marketType);
    const specs = matchWinnerSpecs(this.cfg.statKeys, statPeriod);
    const feeTreasury = this.cfg.feeTreasury
      ? new PublicKey(this.cfg.feeTreasury)
      : this.wallet.publicKey;
    const sig = await this.program.methods
      .initializeMarket(
        new BN(fixtureId),
        marketType,
        specs,
        this.cfg.feeBps,
        new BN(lockTime),
        new BN(resolutionTimeoutSec),
        feeTreasury
      )
      .accounts({
        authority: this.wallet.publicKey,
        market,
        usdcMint,
        vault: vaultPda(this.program.programId, market),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    return { market, sig };
  }

  async lockMarket(market: PublicKey): Promise<string> {
    return this.program.methods
      .lockMarket()
      .accounts({ market, cranker: this.wallet.publicKey })
      .rpc();
  }

  async cancelMarket(market: PublicKey): Promise<string> {
    return this.program.methods
      .cancelMarket()
      .accounts({ market, canceller: this.wallet.publicKey })
      .rpc();
  }

  async settleMarket(
    market: PublicKey,
    claimedOutcome: number,
    proof: any,
    epochDay: number
  ): Promise<string> {
    return this.program.methods
      .settleMarket(claimedOutcome, proof)
      .accounts({
        cranker: this.wallet.publicKey,
        market,
        oracleProgram: this.oracleProgramId,
        oracleRoots: dailyRootsPda(this.oracleProgramId, epochDay),
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ])
      .rpc();
  }

  /** Replay/mock only: act as the oracle's batch publisher for the daily root. */
  async publishMockRoot(epochDay: number, root: number[]): Promise<string> {
    if (!this.mockOracle)
      throw new Error("publishMockRoot requires oracleMode=mock");
    return this.mockOracle.methods
      .publishDailyRoot(epochDay, root)
      .accounts({
        dailyScoresMerkleRoots: dailyRootsPda(this.oracleProgramId, epochDay),
        payer: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Build a mock-verifiable proof and publish its daily root (replay path). */
  async buildAndPublishMockProof(
    fixtureId: number,
    tsMs: number,
    goalsA: number,
    goalsB: number
  ): Promise<{ proof: any; epochDay: number }> {
    const built = buildMockProof(
      goalsA,
      goalsB,
      new BN(fixtureId),
      new BN(tsMs),
      this.cfg.statPeriod,
      this.cfg.statKeys
    );
    await this.publishMockRoot(built.epochDay, built.dailyRoot);
    return { proof: built.proof, epochDay: built.epochDay };
  }

  positionPdaFor(market: PublicKey, owner: PublicKey): PublicKey {
    return positionPda(this.program.programId, market, owner);
  }
}
