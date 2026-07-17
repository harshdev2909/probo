"use client";

/**
 * Mint a Proof-of-Outcome NFT from a receipt — client-side, via Metaplex Core.
 *
 * The Probo program is NOT touched: this uses Metaplex's audited Core program.
 * The user's wallet signs and pays; the asset's metadata URI points at
 * /api/nft/:pda, which embeds the proof ref, the settle tx, and a verify link.
 *
 * Limited on purpose — only the knockout finals (semis, 3rd place, Final), and
 * only the fixture's headline result, so there are a handful in existence, not
 * one per market.
 *
 * Honest failure: before signing, it re-fetches the receipt and refuses unless
 * the market is genuinely settled with a real proof. It will not mint a
 * collectible for a settlement that did not happen.
 */
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { walletAdapterIdentity } from "@metaplex-foundation/umi-signer-wallet-adapters";
import { mplCore, create } from "@metaplex-foundation/mpl-core";
import { generateSigner } from "@metaplex-foundation/umi";

import { api, type ReceiptView } from "@/lib/api";
import { rpcEndpoint } from "@/lib/wallet";
import { teamsForFixture } from "@/lib/teams";

const KNOCKOUT = new Set(["SF", "3rd", "Final"]);
const RESULT_TYPES = new Set([3, 4, 28]);

/** Only a knockout fixture's headline 1X2 receipt is mintable. */
export function isMintable(r: ReceiptView): boolean {
  return KNOCKOUT.has(r.stage) && RESULT_TYPES.has(r.marketType) && !!r.proofRef;
}

function siteOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

export function MintProofNFT({ receipt }: { receipt: ReceiptView }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);

  if (!isMintable(receipt)) return null;

  const [home, away] = teamsForFixture(
    receipt.matchId,
    `${receipt.home?.name} v ${receipt.away?.name}`,
    receipt.home,
    receipt.away
  );

  async function mint() {
    setError(null);
    if (!wallet.publicKey) {
      setError("Connect a wallet first.");
      return;
    }
    try {
      // Honest gate: re-verify the receipt is genuinely settled before we mint.
      setBusy("Checking the receipt is real…");
      const fresh = await api.receipt(receipt.marketPda);
      if (!fresh?.proofRef || !fresh?.settleTx) {
        throw new Error(
          "This market is not settled with a real proof — refusing to mint."
        );
      }

      setBusy("Preparing the collectible…");
      const umi = createUmi(rpcEndpoint())
        .use(mplCore())
        .use(walletAdapterIdentity(wallet));

      const asset = generateSigner(umi);
      const uri = `${siteOrigin()}/api/nft/${receipt.marketPda}`;
      const name = `ProofBook · ${home.code} v ${away.code} · ${receipt.stage}`;

      setBusy("Waiting for your signature…");
      await create(umi, {
        asset,
        name: name.slice(0, 32), // Core on-chain name cap
        uri,
      }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

      setMinted(asset.publicKey.toString());
    } catch (e: any) {
      setError(String(e?.message ?? e).slice(0, 220));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel border border-brass-600/40 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="label text-brass-500">Proof-of-Outcome · collectible</p>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-600">
          knockout finals only
        </span>
      </div>

      {minted ? (
        <div className="mt-3">
          <p className="text-[13px] text-pitch-400">
            Minted. It carries the proof and a verify link in its metadata.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <a
              href={`https://explorer.solana.com/address/${minted}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="label border border-brass-600 px-4 py-2 text-brass-400 transition-colors hover:bg-brass-500 hover:text-ink-950"
            >
              View on explorer →
            </a>
            <a
              href={`${siteOrigin()}/api/nft/${receipt.marketPda}`}
              target="_blank"
              rel="noopener noreferrer"
              className="label border border-hairline-strong px-4 py-2 text-ink-300 transition-colors hover:border-ink-400"
            >
              Metadata
            </a>
          </div>
          <p className="mt-3 truncate font-mono text-[10px] text-ink-600">{minted}</p>
        </div>
      ) : (
        <>
          <p className="mt-2 max-w-lg text-[12px] leading-relaxed text-ink-400">
            Mint this settlement as an on-chain collectible (Metaplex Core — the Probo
            program is untouched). Its metadata embeds the proof reference, the settle
            transaction, and a link to re-verify it against TxLINE&rsquo;s oracle. Your
            wallet signs and pays the rent.
          </p>
          <button
            onClick={() => void mint()}
            disabled={!!busy || !wallet.publicKey}
            className="label mt-4 bg-brass-500 px-6 py-2.5 text-ink-950 transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ borderRadius: "0 0 0 12px" }}
          >
            {busy ? "Working…" : wallet.publicKey ? "Mint Proof-of-Outcome" : "Connect a wallet"}
          </button>
          {busy && <p className="mt-3 text-[12px] text-amber-400">{busy}</p>}
          {error && <p className="mt-3 break-words text-[12px] text-oxide-400">{error}</p>}
        </>
      )}
    </section>
  );
}
