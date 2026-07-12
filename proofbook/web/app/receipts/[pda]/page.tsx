"use client";

/**
 * The Proof Receipt page. the artifact. VERIFY is real: it reads the market
 * account straight from Solana RPC (bypassing the keeper) and compares the
 * settlement fields against the indexed receipt before the seal takes.
 */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { api, type ProofReceipt, type MarketView } from "@/lib/api";
import { teamsForFixture } from "@/lib/teams";
import idl from "@/lib/idl/proofbook.json";
import { Receipt, type ReceiptData } from "@/components/Receipt";
import { Reveal } from "@/components/motion";
import { QuarterLoader, ErrorState } from "@/components/primitives";

export default function ReceiptPage({ params }: { params: Promise<{ pda: string }> }) {
  const { pda } = use(params);
  const { connection } = useConnection();
  const [receipt, setReceipt] = useState<ProofReceipt | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [err, setErr] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Promise.all([api.receipt(pda), api.market(pda)])
      .then(([r, m]) => {
        setReceipt(r);
        setMarket(m);
      })
      .catch(() => setErr(true));
  }, [pda]);

  /** Independent re-check: read the settled market from chain, compare fields. */
  async function verify(): Promise<boolean> {
    if (!receipt) return false;
    try {
      const program = new anchor.Program(idl as anchor.Idl, { connection } as never) as any;
      const m = await program.account.market.fetch(new PublicKey(pda));
      return (
        m.winningOutcome === receipt.winningOutcome &&
        Buffer.from(m.settleProofRef).toString("hex") === receipt.proofRef &&
        m.settleDailyRoots.toBase58() === receipt.dailyRootsPda &&
        m.settleResolver.toBase58() === receipt.resolver
      );
    } catch {
      return false;
    }
  }

  if (err)
    return (
      <main className="mx-auto max-w-3xl px-6 pt-16">
        <div className="panel">
          <ErrorState title="No receipt. market not settled yet" />
        </div>
      </main>
    );
  if (!receipt || !market)
    return (
      <main className="flex justify-center pt-32">
        <QuarterLoader size={36} label="Loading receipt" />
      </main>
    );

  const [home, away] = teamsForFixture(receipt.matchId, market.fixtureName);
  const score = market.live?.score;
  const data: ReceiptData = {
    matchId: receipt.matchId,
    homeCode: home.code,
    awayCode: away.code,
    finalScore: { home: score?.p1 ?? 0, away: score?.p2 ?? 0 },
    outcomeLabel:
      receipt.winningOutcome === 0 ? `${home.code} win` : receipt.winningOutcome === 2 ? `${away.code} win` : "Draw",
    statKeys: "1, 2",
    period: 100,
    epochDay: receipt.epochDay,
    dailyRootsPda: receipt.dailyRootsPda,
    proofRef: receipt.proofRef,
    resolver: receipt.resolver,
    settleTx: receipt.settleTx,
    oracleProgram: receipt.oracleProgram,
    settledAtIso: new Date(receipt.settledAt * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC",
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pt-12 lg:px-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-[clamp(30px,4.5vw,48px)] text-ink-100">Proof receipt</h1>
          <p className="mt-2 max-w-md text-[13px] leading-relaxed text-ink-400">
            {home.name} v {away.name} was settled by a Merkle proof verified on-chain. not by
            anyone&apos;s say-so. This page is the evidence.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(window.location.href);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="label border border-hairline-strong px-4 py-2.5 text-ink-200 transition-colors duration-150 ease-snap hover:border-ink-500"
            style={{ borderRadius: "0 0 0 12px" }}
          >
            {copied ? "Copied ✓" : "Share"}
          </button>
          <Link
            href={`/m/${pda}`}
            className="label border border-hairline px-4 py-2.5 text-ink-400 transition-colors duration-150 ease-snap hover:border-ink-500 hover:text-ink-200"
          >
            Market →
          </Link>
        </div>
      </header>

      <Reveal>
        <Receipt data={data} onVerify={verify} />
      </Reveal>

      <p className="mx-auto mt-8 max-w-[520px] text-center font-mono text-[11px] leading-relaxed text-ink-500">
        VERIFY reads the market account directly from Solana RPC. not from our indexer. and
        compares the winning outcome, proof reference, daily root PDA and resolver.
      </p>
    </main>
  );
}
