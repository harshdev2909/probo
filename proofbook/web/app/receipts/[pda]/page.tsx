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
import { api, type ReceiptView, type MarketView } from "@/lib/api";
import { teamsForFixture } from "@/lib/teams";
import idl from "@/lib/idl/proofbook.json";
import { Receipt, type ReceiptData } from "@/components/Receipt";
import { Reveal } from "@/components/motion";
import { QuarterLoader, ErrorState } from "@/components/primitives";

export default function ReceiptPage({ params }: { params: Promise<{ pda: string }> }) {
  const { pda } = use(params);
  const { connection } = useConnection();
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
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

  const [home, away] = teamsForFixture(receipt.matchId, market.fixtureName, market.home, market.away);
  // The proven values win over anything the live feed reported: the feed's Score
  // field is sampled and has been seen to disagree with what the proof attests.
  const score = receipt.provenScore ?? market.live?.score;
  const data: ReceiptData = {
    matchId: receipt.matchId,
    homeCode: home.code,
    awayCode: away.code,
    finalScore: { home: score?.p1 ?? 0, away: score?.p2 ?? 0 },
    // The label comes from the MARKET TYPE via the API — hardcoding 1X2 here
    // made a corners Over/Under receipt read as a match-winner receipt.
    outcomeLabel:
      receipt.outcomeLabel === "Home"
        ? `${home.code} win`
        : receipt.outcomeLabel === "Away"
          ? `${away.code} win`
          : receipt.outcomeLabel,
    statKeys: receipt.statKeys.join(", "),
    period: receipt.statPeriod ?? 100,
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
            <span className="text-brass-500">{receipt.marketName}</span>
            {receipt.isParlay && ", a 2×2 parlay,"} on {home.name} v {away.name},
            settled by a Merkle proof verified on-chain. not by anyone&apos;s
            say-so. This page is the evidence.
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

      {receipt.isParlay && (
        <p className="mx-auto mt-6 max-w-[560px] border border-dashed border-hairline p-4 text-center font-mono text-[11px] leading-relaxed text-ink-500">
          Both legs of this parlay, {receipt.statKeys.length} stats in all, were
          proven together in ONE validate_stat_v3 merkle multiproof. Proven separately
          under v2, the same claim needs ~{receipt.statKeys.length * 5 + 2} proof
          nodes; the multiproof carried it in ~6, because the leaves share their
          internal nodes. That saving is what makes multi-leg markets fit in a
          Solana transaction at all.
        </p>
      )}

      {/*
        The button above re-reads the market account from Solana and compares
        fields — good, but it still takes OUR word for what the proof was. The
        full verifier re-fetches the proof from TxLINE and asks TxLINE's own
        program to adjudicate it. That is the one that owes nothing to us.
      */}
      <div className="mx-auto mt-10 max-w-[560px] border border-hairline p-5 text-center">
        <p className="text-[13px] leading-relaxed text-ink-400">
          The check above compares this receipt against the Solana account. The
          full verifier goes further: it fetches TxLINE&rsquo;s Merkle root from
          chain, re-fetches the proof from TxLINE, and asks{" "}
          <strong className="text-ink-200">TxLINE&rsquo;s own program</strong>{" "}
          whether it holds. It trusts nothing we say.
        </p>
        <Link
          href={`/verify?market=${pda}`}
          className="label mt-4 inline-block bg-brass-500 px-5 py-2.5 text-ink-950 transition-opacity hover:opacity-90"
          style={{ borderRadius: "0 0 0 12px" }}
        >
          Verify this yourself →
        </Link>
        <p className="mt-4 font-mono text-[11px] text-ink-500">
          or from your terminal, trusting nothing of ours:
        </p>
        <button
          onClick={() =>
            void navigator.clipboard.writeText(
              `npx @h4rsharma/txline-settle verify ${pda}`
            )
          }
          className="mt-1.5 max-w-full overflow-x-auto whitespace-nowrap border border-hairline px-3 py-2 font-mono text-[11px] text-ink-300 transition-colors hover:border-brass-600"
          title="Click to copy"
        >
          npx @h4rsharma/txline-settle verify {pda.slice(0, 20)}… <span className="text-ink-600">(copy)</span>
        </button>
      </div>
    </main>
  );
}
