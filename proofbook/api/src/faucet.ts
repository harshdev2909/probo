/**
 * Devnet demo faucet.
 *
 * PRIVILEGE SEPARATION — the point of this file.
 * The keeper owns the escrow mint's authority and the market authority. Those keys
 * can create markets and settle them, and they NEVER leave the keeper's process.
 * The API instead holds a plain, pre-funded wallet that can only do two things:
 * transfer a valueless devnet token, and send a little SOL. If the API is
 * compromised, an attacker drains a faucet — not the tournament.
 *
 * A bet needs BOTH of the things this hands out:
 *   · the demo token being staked
 *   · a little SOL — place_bet opens a Position account and the BETTOR pays its
 *     rent, so a wallet with zero SOL cannot bet however many tokens it holds
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { prisma } from "../../db/src/client";
import type { FaucetResult } from "./contracts";

const USDC_GRANT = Number(process.env.FAUCET_USDC ?? 10_000);
const SOL_GRANT = Number(process.env.FAUCET_SOL ?? 0.02);
/** Don't top up a wallet that already has plenty — one grant is enough to play. */
const USDC_CEILING = Number(process.env.FAUCET_USDC_CEILING ?? 5_000);
const SOL_FLOOR = Number(process.env.FAUCET_SOL_FLOOR ?? 0.01);
const MAX_GRANTS = Number(process.env.FAUCET_MAX_GRANTS ?? 5);
const COOLDOWN_SEC = Number(process.env.FAUCET_COOLDOWN_SEC ?? 30);

export class Faucet {
  readonly enabled: boolean;
  private conn: Connection;
  private payer?: Keypair;
  private mint?: PublicKey;

  constructor(rpcUrl: string, secret?: string, mint?: string) {
    this.conn = new Connection(rpcUrl, "confirmed");
    if (secret && mint) {
      this.payer = loadKeypair(secret);
      this.mint = new PublicKey(mint);
      this.enabled = true;
    } else {
      this.enabled = false;
    }
  }

  get address(): string | null {
    return this.payer?.publicKey.toBase58() ?? null;
  }

  /** Faucet wallet balances — the status page shows these so it can't run dry unnoticed. */
  async reserves(): Promise<{ sol: number; usdc: number } | null> {
    if (!this.payer || !this.mint) return null;
    const sol =
      (await this.conn.getBalance(this.payer.publicKey)) / LAMPORTS_PER_SOL;
    let usdc = 0;
    try {
      const ata = getAssociatedTokenAddressSync(
        this.mint,
        this.payer.publicKey
      );
      usdc = Number((await getAccount(this.conn, ata)).amount) / 1e6;
    } catch {
      usdc = 0;
    }
    return { sol, usdc };
  }

  async fund(walletStr: string): Promise<FaucetResult> {
    if (!this.payer || !this.mint) {
      throw Object.assign(new Error("faucet is not configured"), {
        statusCode: 503,
      });
    }
    const owner = new PublicKey(walletStr); // throws on a bad address -> 400

    // ── rate limit ──────────────────────────────────────────────────────────
    const grant = await prisma.faucetGrant.findUnique({
      where: { wallet: walletStr },
    });
    if (grant) {
      const sinceSec = (Date.now() - grant.lastGrantAt.getTime()) / 1000;
      if (sinceSec < COOLDOWN_SEC) {
        throw Object.assign(
          new Error(
            `Slow down — try again in ${Math.ceil(COOLDOWN_SEC - sinceSec)}s.`
          ),
          { statusCode: 429 }
        );
      }
      if (grant.grants >= MAX_GRANTS) {
        throw Object.assign(
          new Error(
            "This wallet has had its share of test funds. Use a different wallet."
          ),
          { statusCode: 429 }
        );
      }
    }

    const ata = getAssociatedTokenAddressSync(this.mint, owner);
    const ixs = [];

    // ── SOL: without it, the bet cannot pay rent for its own Position account ──
    let solSent = 0;
    const lamports = await this.conn.getBalance(owner);
    if (lamports < SOL_FLOOR * LAMPORTS_PER_SOL) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: this.payer.publicKey,
          toPubkey: owner,
          lamports: Math.floor(SOL_GRANT * LAMPORTS_PER_SOL),
        })
      );
      solSent = SOL_GRANT;
    }

    // ── the demo token ──────────────────────────────────────────────────────
    let held = 0;
    let ataExists = true;
    try {
      held = Number((await getAccount(this.conn, ata)).amount) / 1e6;
    } catch {
      ataExists = false;
    }
    if (!ataExists) {
      // The faucet pays the rent for the token account, so the judge doesn't have to.
      ixs.push(
        createAssociatedTokenAccountInstruction(
          this.payer.publicKey,
          ata,
          owner,
          this.mint
        )
      );
    }

    let usdcSent = 0;
    if (held < USDC_CEILING) {
      const from = getAssociatedTokenAddressSync(
        this.mint,
        this.payer.publicKey
      );
      ixs.push(
        createTransferInstruction(
          from,
          ata,
          this.payer.publicKey,
          BigInt(Math.round(USDC_GRANT * 1e6)),
          [],
          TOKEN_PROGRAM_ID
        )
      );
      usdcSent = USDC_GRANT;
    }

    if (ixs.length === 0) {
      return {
        ok: true,
        usdc: 0,
        sol: 0,
        mint: this.mint.toBase58(),
        sig: null,
        note: "Already funded — you have enough to bet.",
      };
    }

    const tx = new Transaction().add(...ixs);
    const sig = await sendAndConfirm(this.conn, tx, this.payer);

    await prisma.faucetGrant.upsert({
      where: { wallet: walletStr },
      create: {
        wallet: walletStr,
        grants: 1,
        totalUsdc: BigInt(Math.round(usdcSent * 1e6)),
        lastGrantAt: new Date(),
      },
      update: {
        grants: { increment: 1 },
        totalUsdc: { increment: BigInt(Math.round(usdcSent * 1e6)) },
        lastGrantAt: new Date(),
      },
    });

    return {
      ok: true,
      usdc: usdcSent,
      sol: solSent,
      mint: this.mint.toBase58(),
      sig,
      note: null,
    };
  }
}

/** Confirm by POLLING, not a websocket subscription — see web/lib/anchor.ts. */
async function sendAndConfirm(
  conn: Connection,
  tx: Transaction,
  payer: Keypair
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
    "confirmed"
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(payer);

  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err)
      throw new Error(`faucet transaction failed: ${JSON.stringify(st.err)}`);
    if (
      st?.confirmationStatus === "confirmed" ||
      st?.confirmationStatus === "finalized"
    )
      return sig;
    if (Date.now() > deadline) throw new Error("faucet transaction timed out");
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight)
      throw new Error("faucet blockhash expired");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Accepts a JSON byte array (solana-keygen) or a base58 secret key. */
function loadKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  // base58 — decoded via bs58 which ships with @solana/web3.js
  const bs58 = require("bs58");
  const decoded = bs58.default?.decode
    ? bs58.default.decode(trimmed)
    : bs58.decode(trimmed);
  return Keypair.fromSecretKey(Uint8Array.from(decoded));
}
