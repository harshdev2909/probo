"use client";

/**
 * The bet slip. Honest tx states. idle → signing → confirming → confirmed —
 * with no fake progress. Gates: wallet-not-connected, market-not-open,
 * insufficient USDC. Payout math shown before signing.
 */
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import type { MarketView } from "@/lib/api";
import { teamsForFixture } from "@/lib/teams";
import { placeBet, usdcBalance } from "@/lib/anchor";
import { projectPayout, usdc } from "@/lib/format";

type TxState =
  | { s: "idle" }
  | { s: "signing" }
  | { s: "confirming" }
  | { s: "confirmed"; sig: string }
  | { s: "error"; msg: string };

const QUICK = [10, 50, 100, 500];

export function BetSlip({ market, onPlaced }: { market: MarketView; onPlaced?: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const reduced = useReducedMotion();

  const [outcome, setOutcome] = useState<number | null>(null);
  const [stake, setStake] = useState("");
  const [tx, setTx] = useState<TxState>({ s: "idle" });
  const [balance, setBalance] = useState<number | null>(null);

  const [home, away] = teamsForFixture(market.fixtureId, market.fixtureName);
  const labels = [`${home.code} win`, "Draw", `${away.code} win`];
  const stakeNum = parseFloat(stake) || 0;
  const open = market.status === "open" && market.lockTime * 1000 > Date.now();

  useEffect(() => {
    if (!wallet.publicKey) return setBalance(null);
    usdcBalance(connection, wallet.publicKey, new PublicKey(market.usdcMint)).then(setBalance);
  }, [wallet.publicKey, connection, market.usdcMint, tx.s]);

  const payout = useMemo(
    () =>
      outcome === null || stakeNum <= 0
        ? 0
        : projectPayout(stakeNum, market.totalPool, market.pools[outcome], market.feeBps),
    [outcome, stakeNum, market]
  );

  const insufficient = balance !== null && stakeNum > balance;

  async function submit() {
    if (outcome === null || stakeNum <= 0 || !open) return;
    try {
      setTx({ s: "signing" });
      const sigPromise = placeBet(connection, wallet, market, outcome, stakeNum);
      setTx({ s: "confirming" });
      const sig = await sigPromise;
      setTx({ s: "confirmed", sig });
      setStake("");
      onPlaced?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setTx({ s: "error", msg: msg.includes("User rejected") ? "Signature declined." : msg.slice(0, 120) });
    }
  }

  return (
    <aside className="panel-raised p-5" aria-label="Bet slip">
      <p className="label mb-4">Bet slip</p>

      {/* outcome selector */}
      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Pick an outcome">
        {labels.map((l, i) => (
          <button
            key={l}
            role="radio"
            aria-checked={outcome === i}
            onClick={() => setOutcome(outcome === i ? null : i)}
            disabled={!open}
            className={`border px-2 py-3 text-center transition-all duration-150 ease-snap disabled:cursor-not-allowed disabled:opacity-40 ${
              outcome === i
                ? "border-ink-300 bg-ink-100 text-ink-950"
                : "border-hairline-strong text-ink-200 hover:border-ink-500"
            }`}
            style={{ borderRadius: i === 0 ? "0 0 0 12px" : 0 }}
          >
            <span className="display-condensed block text-[14px]">{l}</span>
            <span className="tnum mt-0.5 block font-mono text-[10px] opacity-70">
              {usdc(market.pools[i], { compact: true })} staked
            </span>
          </button>
        ))}
      </div>

      {/* stake */}
      <div className="mt-4">
        <label htmlFor="stake" className="label">
          Stake (USDC)
        </label>
        <input
          id="stake"
          type="number"
          inputMode="decimal"
          min="0"
          step="1"
          placeholder="0.00"
          autoComplete="off"
          value={stake}
          onChange={(e) => setStake(e.target.value)}
          disabled={!open}
          className="tnum mt-1.5 w-full border border-hairline-strong bg-ink-950 px-3 py-3 font-mono text-[18px] text-ink-100 placeholder:text-ink-500 focus:border-ink-300 focus:outline-none disabled:opacity-40"
          style={{ borderRadius: "0 0 0 12px" }}
        />
        <div className="mt-2 flex items-center gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q}
              onClick={() => setStake(String(q))}
              disabled={!open}
              className="tnum border border-hairline px-2.5 py-1.5 font-mono text-[11px] text-ink-300 transition-colors duration-150 hover:border-ink-500 hover:text-ink-100 disabled:opacity-40"
            >
              {q}
            </button>
          ))}
          {balance !== null && (
            <span className="tnum ml-auto font-mono text-[10px] text-ink-500">
              bal {balance.toLocaleString("en-US", { maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
      </div>

      {/* return preview */}
      <div className="rule mt-4 pt-3">
        <div className="flex justify-between text-[12px]">
          <span className="text-ink-400">If it wins (current pools)</span>
          <span className="tnum font-mono text-ink-100">
            {payout > 0 ? `≈ ${payout.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC` : "—"}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-ink-500">
          Winners split the whole pool, minus the {market.feeBps / 100}% fee. Final odds are set when betting closes.
        </p>
      </div>

      {/* action + states */}
      <div className="mt-4">
        {!wallet.connected ? (
          <button
            onClick={() => setVisible(true)}
            className="display-condensed w-full border border-hairline-strong py-3.5 text-[15px] text-ink-100 transition-colors duration-150 ease-snap hover:border-ink-300"
            style={{ borderRadius: "0 0 0 12px" }}
          >
            Connect wallet
          </button>
        ) : !open ? (
          <p className="border border-hairline py-3 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">
            {market.status === "open" ? "Betting closed" : `Market ${market.status}`}
          </p>
        ) : (
          <button
            onClick={submit}
            disabled={outcome === null || stakeNum <= 0 || insufficient || tx.s === "signing" || tx.s === "confirming"}
            className="display-condensed w-full bg-ink-100 py-3.5 text-[15px] text-ink-950 transition-all duration-150 ease-snap hover:bg-ink-200 disabled:cursor-not-allowed disabled:opacity-30"
            style={{ borderRadius: "0 0 0 12px" }}
          >
            {tx.s === "signing" ? "Sign in wallet…" : tx.s === "confirming" ? "Confirming…" : insufficient ? "Insufficient USDC" : "Place bet"}
          </button>
        )}

        <AnimatePresence>
          {(tx.s === "confirmed" || tx.s === "error") && (
            <motion.p
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`mt-3 break-all font-mono text-[11px] leading-relaxed ${tx.s === "confirmed" ? "text-pitch-400" : "text-oxide-400"}`}
              role="status"
            >
              {tx.s === "confirmed" ? (
                <>✓ Bet placed · {tx.sig.slice(0, 20)}… <button className="underline decoration-hairline-strong underline-offset-2 hover:text-ink-100" onClick={() => setTx({ s: "idle" })}>dismiss</button></>
              ) : (
                <>{tx.msg} · <button className="underline decoration-hairline-strong underline-offset-2 hover:text-ink-100" onClick={() => setTx({ s: "idle" })}>retry</button></>
              )}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
}
