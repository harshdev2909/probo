"use client";

/** Bet/claim transactions — the only place the frontend touches Solana RPC. */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import idl from "./idl/proofbook.json";
import type { MarketView } from "./api";

const MARKET_SEED = Buffer.from("market");
const VAULT_SEED = Buffer.from("vault");
const POSITION_SEED = Buffer.from("position");

function program(connection: Connection, wallet: WalletContextState) {
  const provider = new anchor.AnchorProvider(connection, wallet as never, {
    commitment: "confirmed",
  });
  return new anchor.Program(idl as anchor.Idl, provider) as any;
}

export function positionPda(market: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), owner.toBuffer()],
    new PublicKey((idl as any).address)
  )[0];
}

export async function usdcBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<number | null> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const acc = await getAccount(connection, ata);
    return Number(acc.amount) / 1e6;
  } catch {
    return null; // no ATA = no USDC
  }
}

export async function placeBet(
  connection: Connection,
  wallet: WalletContextState,
  market: MarketView,
  outcomeIndex: number,
  amountUsdc: number
): Promise<string> {
  if (!wallet.publicKey) throw new Error("wallet not connected");
  const p = program(connection, wallet);
  const marketPk = new PublicKey(market.marketPda);
  const mint = new PublicKey(market.usdcMint);
  return p.methods
    .placeBet(outcomeIndex, new BN(Math.round(amountUsdc * 1e6)))
    .accounts({
      bettor: wallet.publicKey,
      market: marketPk,
      position: positionPda(marketPk, wallet.publicKey),
      bettorToken: getAssociatedTokenAddressSync(mint, wallet.publicKey),
      vault: new PublicKey(market.vault),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function claim(
  connection: Connection,
  wallet: WalletContextState,
  market: MarketView,
  kind: "winnings" | "refund"
): Promise<string> {
  if (!wallet.publicKey) throw new Error("wallet not connected");
  const p = program(connection, wallet);
  const marketPk = new PublicKey(market.marketPda);
  const mint = new PublicKey(market.usdcMint);
  const common = {
    market: marketPk,
    position: positionPda(marketPk, wallet.publicKey),
    vault: new PublicKey(market.vault),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  if (kind === "winnings") {
    return p.methods
      .claimWinnings()
      .accounts({
        winner: wallet.publicKey,
        winnerToken: getAssociatedTokenAddressSync(mint, wallet.publicKey),
        ...common,
      })
      .rpc();
  }
  return p.methods
    .claimRefund()
    .accounts({
      user: wallet.publicKey,
      userToken: getAssociatedTokenAddressSync(mint, wallet.publicKey),
      ...common,
    })
    .rpc();
}
