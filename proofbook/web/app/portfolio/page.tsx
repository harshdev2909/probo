"use client";

/** Positions for the connected wallet: active, claimable, refundable, settled. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { api, type MarketView, type PositionView } from "@/lib/api";
import { teamsForFixture } from "@/lib/teams";
import { usdc } from "@/lib/format";
import { claim } from "@/lib/anchor";
import { PageArt } from "@/components/PageArt";
import { StaggerItem } from "@/components/motion";
import { QuarterLoader, EmptyState } from "@/components/primitives";

interface Row {
  pos: PositionView;
  market: MarketView | null;
}

export default function Portfolio() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wallet.publicKey) return;
    const positions = await api.positions(wallet.publicKey.toBase58()).catch(() => []);
    const withMarkets = await Promise.all(
      positions.map(async (pos) => ({
        pos,
        market: await api.market(pos.market).catch(() => null),
      }))
    );
    setRows(withMarkets);
  }, [wallet.publicKey]);

  useEffect(() => {
    if (wallet.publicKey) void load();
  }, [wallet.publicKey, load]);

  async function doClaim(row: Row, kind: "winnings" | "refund") {
    if (!row.market) return;
    setClaiming(row.pos.position);
    setNote(null);
    try {
      const sig = await claim(connection, wallet, row.market, kind);
      setNote(`✓ ${kind === "winnings" ? "Winnings claimed" : "Stake refunded"} · ${sig.slice(0, 16)}…`);
      await load();
    } catch (e: unknown) {
      setNote((e instanceof Error ? e.message : String(e)).slice(0, 120));
    } finally {
      setClaiming(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 pt-12 lg:px-10">
      <PageArt src="/art-portfolio.jpg" opacity={0.24} />

      <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">Portfolio</h1>
      <p className="mt-2 mb-10 text-[13px] text-ink-400">
        Your bets, all in one place. Winnings are claimable the moment the result is verified.
      </p>

      {!wallet.connected ? (
        <div className="panel flex flex-col items-center gap-5 py-20">
          <p className="display-condensed text-[18px] text-ink-300">Connect a wallet to see your positions</p>
          <button
            onClick={() => setVisible(true)}
            className="display-condensed border border-hairline-strong px-6 py-3 text-[15px] text-ink-100 transition-colors duration-150 ease-snap hover:border-ink-300"
            style={{ borderRadius: "0 0 0 12px" }}
          >
            Connect wallet
          </button>
        </div>
      ) : rows === null ? (
        <div className="flex justify-center py-24">
          <QuarterLoader size={36} label="Loading positions" />
        </div>
      ) : rows.length === 0 ? (
        <div className="panel">
          <EmptyState title="No positions yet" hint="Pick a match and back an outcome. Your ticket shows up here." />
        </div>
      ) : (
        <div className="space-y-3">
          {note && <p className="font-mono text-[12px] text-pitch-400" role="status">{note}</p>}
          {rows.map((row, i) => {
            const m = row.market;
            const [homeT, awayT] = m ? teamsForFixture(m.fixtureId, m.fixtureName) : [null, null];
            const outcomeLabel =
              row.pos.outcomeIndex === 0 ? `${homeT?.code} win` : row.pos.outcomeIndex === 2 ? `${awayT?.code} win` : "Draw";
            const won = m?.status === "settled" && m.winningOutcome === row.pos.outcomeIndex;
            const refundable = m?.status === "cancelled";
            const lost = m?.status === "settled" && !won;
            return (
              <StaggerItem key={row.pos.position} i={i}>
                <div className="panel flex flex-wrap items-center gap-4 p-5">
                  <div className="min-w-0 flex-1">
                    <Link href={m ? `/m/${m.marketPda}` : "#"} className="display-condensed text-[17px] text-ink-100 hover:text-brass-400">
                      {homeT && awayT ? `${homeT.name} v ${awayT.name}` : row.pos.market.slice(0, 12)}
                    </Link>
                    <p className="mt-1 font-mono text-[11px] text-ink-400">
                      {outcomeLabel} · staked <span className="tnum text-ink-200">{usdc(row.pos.amount)} USDC</span>
                      {m && <> · {m.status}</>}
                    </p>
                  </div>
                  {row.pos.claimed ? (
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-500">claimed ✓</span>
                  ) : won ? (
                    <button
                      onClick={() => void doClaim(row, "winnings")}
                      disabled={claiming === row.pos.position}
                      className="display-condensed border border-brass-600 bg-brass-950 px-5 py-2.5 text-[14px] text-brass-400 transition-colors duration-150 ease-snap hover:bg-ink-950 disabled:opacity-50"
                      style={{ borderRadius: "0 0 0 12px" }}
                    >
                      {claiming === row.pos.position ? "Claiming…" : "Claim winnings"}
                    </button>
                  ) : refundable ? (
                    <button
                      onClick={() => void doClaim(row, "refund")}
                      disabled={claiming === row.pos.position}
                      className="display-condensed border border-hairline-strong px-5 py-2.5 text-[14px] text-ink-100 transition-colors duration-150 ease-snap hover:border-ink-500 disabled:opacity-50"
                      style={{ borderRadius: "0 0 0 12px" }}
                    >
                      {claiming === row.pos.position ? "Refunding…" : "Claim refund"}
                    </button>
                  ) : lost ? (
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-oxide-400">lost</span>
                  ) : (
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-amber-400">in play</span>
                  )}
                  {m?.status === "settled" && (
                    <Link href={`/receipts/${m.marketPda}`} className="label !text-[10px] text-brass-400 underline decoration-brass-600 underline-offset-4 hover:text-brass-500">
                      receipt
                    </Link>
                  )}
                </div>
              </StaggerItem>
            );
          })}
        </div>
      )}
    </main>
  );
}
