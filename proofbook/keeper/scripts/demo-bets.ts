/**
 * Demo bettors: waits for the keeper's open market, funds two wallets with the
 * demo USDC mint, and places bets (Alice on Away — the recorded winner — Bob on
 * Home) so the autonomous settlement ends in a SETTLED market with a receipt.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const API = process.env.KEEPER_API || "http://localhost:8787";
const RPC = process.env.RPC_URL || "http://127.0.0.1:8899";
const ROOT = path.resolve(__dirname, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const secret = JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target", "idl", "proofbook.json"), "utf8"));
  const program = new anchor.Program(idl, provider) as any;

  // wait for an open market
  let market: any = null;
  for (let i = 0; i < 60 && !market; i++) {
    try {
      const res = await fetch(`${API}/markets`);
      const ms = (await res.json()) as any[];
      market = ms.find((m: any) => m.status === "open");
    } catch { /* keeper booting */ }
    if (!market) await sleep(2000);
  }
  if (!market) throw new Error("no open market appeared");
  console.log("[demo-bets] market:", market.marketPda);

  const mint = new PublicKey(market.usdcMint);
  const marketPk = new PublicKey(market.marketPda);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), marketPk.toBuffer()], program.programId);

  const bet = async (name: string, outcome: number, amount: number) => {
    const w = Keypair.generate();
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(t, []);
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, w.publicKey);
    await mintTo(connection, payer, mint, ata.address, payer, BigInt(amount * 1e6));
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPk.toBuffer(), w.publicKey.toBuffer()], program.programId);
    await program.methods
      .placeBet(outcome, new BN(amount * 1e6))
      .accounts({
        bettor: w.publicKey, market: marketPk, position, bettorToken: ata.address,
        vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([w])
      .rpc();
    console.log(`[demo-bets] ${name} staked ${amount} USDC on outcome ${outcome}`);
  };

  await bet("Alice", 2, 600); // Away — the recorded final is 1-4
  await bet("Bob", 0, 400); // Home — provides the losing pool
  console.log("[demo-bets] done — the keeper takes it from here.");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
