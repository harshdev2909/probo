"use client";

/** Bet/claim transactions — the only place the frontend touches Solana RPC. */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import idl from "./idl/proofbook.json";
import type { MarketView } from "./api";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Confirm by POLLING getSignatureStatuses over HTTP.
 *
 * Anchor's `.rpc()` (and web3's confirmTransaction) confirm via a WebSocket
 * `signatureSubscribe`. When that socket never opens — which happens with RPC
 * providers that key off a query string — the promise never settles and the UI
 * hangs on "confirming" forever, even though the transaction actually landed.
 * Polling has no such failure mode, and it can also tell us the blockhash
 * expired instead of waiting indefinitely.
 */
async function confirmByPolling(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];

    if (status?.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }

    // Once the blockhash is too old the transaction can never land — say so
    // rather than spinning until the timeout.
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      throw new Error("Blockhash expired before the transaction confirmed. Try again.");
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for confirmation. It may still land — check your portfolio.");
    }
    await sleep(1200);
  }
}

/** Reject rather than hang forever. A spinner with no end is the worst outcome. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

/**
 * A transaction built, funded and simulated AHEAD of the click.
 *
 * This exists for one reason: browser user activation. An extension may only
 * raise its approval window while the gesture that triggered it is still alive,
 * and every `await` on the way there burns it. Fetching a blockhash and running a
 * simulation between the click and `signTransaction` is enough to lose it, and the
 * wallet prompt is then silently suppressed — which reads as "the popup is
 * blocked" or, worse, as a button that does nothing.
 *
 * So all the slow work happens while the user is still picking an outcome and
 * typing a stake. The click handler's FIRST await is the wallet itself.
 */
export interface PreparedTx {
  tx: Transaction;
  lastValidBlockHeight: number;
  preparedAt: number;
}

/** A blockhash is good for ~60-90s; re-prepare well inside that. */
export const PREPARED_TTL_MS = 25_000;

export const isFresh = (p: PreparedTx | null): p is PreparedTx =>
  !!p && Date.now() - p.preparedAt < PREPARED_TTL_MS;

async function prepare(
  connection: Connection,
  wallet: WalletContextState,
  ixs: TransactionInstruction[]
): Promise<PreparedTx> {
  if (!wallet.publicKey) throw new Error("wallet not connected");

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;

  // Simulate now, not after the wallet prompt. A program error (betting closed,
  // no funds, duplicate position) surfaces as itself instead of as a popup the
  // user approves and a transaction that quietly fails.
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).join("\n");
    const anchorErr = /Error Code: (\w+)/.exec(logs)?.[1];
    throw new Error(
      anchorErr ?? `Transaction would fail: ${JSON.stringify(sim.value.err)}`
    );
  }
  return { tx, lastValidBlockHeight, preparedAt: Date.now() };
}

/**
 * Sign the prepared transaction, broadcast it OURSELVES, confirm by polling.
 * Call this straight out of the click handler — it must not await anything before
 * touching the wallet.
 *
 * `onSigned` fires the moment the wallet returns a signature, so the UI can move
 * from "signing" to "confirming" at the point that actually happens.
 */
export async function signSendConfirm(
  connection: Connection,
  wallet: WalletContextState,
  prepared: PreparedTx,
  onSigned?: (sig: string) => void
): Promise<string> {
  const { tx, lastValidBlockHeight } = prepared;

  // Sign with the wallet, but SEND it ourselves.
  //
  // Phantom's adapter implements sendTransaction via its own signAndSendTransaction,
  // which broadcasts on whatever network PHANTOM is set to — not the devnet endpoint
  // this app is configured with. Signing only, then broadcasting over our own
  // connection, guarantees the bet lands on the cluster the market actually lives on.
  let signature: string;
  if (wallet.signTransaction) {
    const signed = await withTimeout(
      wallet.signTransaction(tx),
      90_000,
      "The wallet never answered. Open the wallet extension — the request may be waiting there — and make sure Devnet (Testnet Mode) is on."
    );
    signature = await connection.sendRawTransaction(signed.serialize(), {
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
  } else if (wallet.sendTransaction) {
    signature = await withTimeout(
      wallet.sendTransaction(tx, connection, { maxRetries: 3 }),
      90_000,
      "The wallet never answered. Open the wallet extension and make sure Devnet is on."
    );
  } else {
    throw new Error("This wallet cannot sign transactions.");
  }
  onSigned?.(signature);

  await confirmByPolling(connection, signature, lastValidBlockHeight);
  return signature;
}

/** Build + simulate a bet ahead of the click. See `PreparedTx`. */
export async function prepareBet(
  connection: Connection,
  wallet: WalletContextState,
  market: MarketView,
  outcomeIndex: number,
  amountUsdc: number
): Promise<PreparedTx> {
  if (!wallet.publicKey) throw new Error("wallet not connected");
  const p = program(connection, wallet);
  const marketPk = new PublicKey(market.marketPda);
  const mint = new PublicKey(market.usdcMint);

  const ix = await p.methods
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
    .instruction();

  return prepare(connection, wallet, [ix]);
}

/** Claims are one-click (no amount to type), so they prepare and sign together. */
export async function claim(
  connection: Connection,
  wallet: WalletContextState,
  market: MarketView,
  kind: "winnings" | "refund",
  onSigned?: (sig: string) => void
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

  const ix =
    kind === "winnings"
      ? await p.methods
          .claimWinnings()
          .accounts({
            winner: wallet.publicKey,
            winnerToken: getAssociatedTokenAddressSync(mint, wallet.publicKey),
            ...common,
          })
          .instruction()
      : await p.methods
          .claimRefund()
          .accounts({
            user: wallet.publicKey,
            userToken: getAssociatedTokenAddressSync(mint, wallet.publicKey),
            ...common,
          })
          .instruction();

  const prepared = await prepare(connection, wallet, [ix]);
  return signSendConfirm(connection, wallet, prepared, onSigned);
}
