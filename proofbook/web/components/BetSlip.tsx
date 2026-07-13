"use client";

/**
 * The bet slip. Honest tx states. idle → signing → confirming → confirmed —
 * with no fake progress. Gates: wallet-not-connected, market-not-open,
 * insufficient USDC. Payout math shown before signing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { api, type MarketView } from "@/lib/api";
import { teamsForFixture } from "@/lib/teams";
import {
  prepareBet,
  signSendConfirm,
  usdcBalance,
  isFresh,
  type PreparedTx,
} from "@/lib/anchor";
import { projectPayout, usdc } from "@/lib/format";

type TxState =
  | { s: "idle" }
  | { s: "signing" }
  | { s: "confirming"; sig: string }
  | { s: "confirmed"; sig: string }
  | { s: "error"; msg: string };

const QUICK = [10, 50, 100, 500];

/** Turn a wallet/program failure into something a person can act on. */
function betError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|user denied/i.test(raw)) return "Signature declined.";
  if (/BettingClosed/.test(raw)) return "Betting has closed on this match.";
  if (/OutcomeMismatch|InvalidOutcome/.test(raw)) return "That outcome is not valid for this market.";
  if (/insufficient funds|InsufficientFunds|0x1$/.test(raw))
    return "Not enough test USDC. Top up above.";
  if (/AccountNotInitialized|could not find account/i.test(raw))
    return "No token account yet. Tap “Get test USDC” above.";
  if (/already in use|AccountAlreadyInitialized/i.test(raw))
    return "You already have a position on this market. One bet per wallet per market.";
  if (/Blockhash expired/i.test(raw)) return "Took too long to sign. Try again.";
  if (/Timed out/i.test(raw)) return raw;
  if (/failed to fetch|fetch failed/i.test(raw))
    return "Can't reach the network. Check the RPC endpoint.";
  return raw.slice(0, 140);
}

export function BetSlip({ market, onPlaced }: { market: MarketView; onPlaced?: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const reduced = useReducedMotion();

  const [outcome, setOutcome] = useState<number | null>(null);
  const [stake, setStake] = useState("");
  const [tx, setTx] = useState<TxState>({ s: "idle" });
  const [balance, setBalance] = useState<number | null>(null);
  const [funding, setFunding] = useState(false);
  const [fundErr, setFundErr] = useState<string | null>(null);
  // Built + simulated while the user is still choosing, so the click handler can
  // hit the wallet immediately and keep its user activation (see PreparedTx).
  const [prepared, setPrepared] = useState<PreparedTx | null>(null);
  const [waking, setWaking] = useState(false);

  const [home, away] = teamsForFixture(market.fixtureId, market.fixtureName, market.home, market.away);
  // The label a bettor SEES must be the outcome the chain will prove. Hardcoding
  // 1X2 here meant a user staking "Draw" on an Over/Under market was actually
  // backing "Under 2.5".
  const labels = market.outcomes.map((l) =>
    l === "Home" ? `${home.code} win` : l === "Away" ? `${away.code} win` : l
  );
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
  // A connected wallet with no demo token (no ATA => null, or an empty one) cannot
  // bet. Offer the funds rather than letting the transaction fail on submit.
  const needsFunds = wallet.connected && (balance === null || balance === 0);

  async function fund() {
    if (!wallet.publicKey) return;
    setFunding(true);
    setFundErr(null);
    try {
      const r = await api.faucet(wallet.publicKey.toBase58());
      setBalance(
        await usdcBalance(
          connection,
          wallet.publicKey,
          new PublicKey(market.usdcMint)
        )
      );
      void r;
    } catch (e: unknown) {
      setFundErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFunding(false);
    }
  }

  // `useWallet()` returns a fresh object on every adapter state change, so it must
  // not be an effect dependency — it would re-simulate in a loop and hammer the RPC.
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const owner = wallet.publicKey?.toBase58();

  // Prepare (blockhash + simulate) in the background as the bet takes shape.
  useEffect(() => {
    if (!owner || outcome === null || stakeNum <= 0 || !open) {
      setPrepared(null);
      return;
    }
    let cancelled = false;
    const build = () =>
      prepareBet(connection, walletRef.current, market, outcome, stakeNum)
        .then((p) => !cancelled && setPrepared(p))
        .catch(() => !cancelled && setPrepared(null)); // surfaced on submit instead

    const t = setTimeout(build, 250); // debounce typing
    const refresh = setInterval(build, 20_000); // keep the blockhash fresh
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(refresh);
    };
  }, [connection, owner, market, outcome, stakeNum, open]);

  async function submit() {
    if (outcome === null || stakeNum <= 0 || !open) return;
    try {
      // "signing" holds until the wallet actually hands back a signature —
      // flipping to "confirming" before that made a stuck wallet prompt look
      // like a stuck confirmation.
      setTx({ s: "signing" });

      // If a fresh transaction is ready, go STRAIGHT to the wallet: awaiting RPC
      // here would burn the click's user activation and the approval window would
      // never open. Only fall back to building inline if nothing is ready.
      const ready = isFresh(prepared)
        ? prepared
        : await prepareBet(connection, wallet, market, outcome, stakeNum);

      // If the wallet takes a moment, tell them where to look rather than spin.
      const nudge = setTimeout(() => setWaking(true), 4000);
      try {
        const sig = await signSendConfirm(connection, wallet, ready, (signature) =>
          setTx({ s: "confirming", sig: signature })
        );
        setTx({ s: "confirmed", sig });
        setStake("");
        setPrepared(null);
        onPlaced?.();
      } finally {
        clearTimeout(nudge);
        setWaking(false);
      }
    } catch (e: unknown) {
      setTx({ s: "error", msg: betError(e) });
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

      {/* devnet funding: a bet needs the demo token AND SOL for its Position rent */}
      {needsFunds && open && (
        <div className="mt-4 border border-dashed border-hairline-strong p-3">
          <p className="text-[12px] text-ink-300">
            You have no test funds yet.
          </p>
          <p className="mt-1 text-[11px] leading-snug text-ink-500">
            This is devnet. The tokens are a demo mint with no value, and you get a
            little SOL to cover the network fee.
          </p>
          <button
            onClick={fund}
            disabled={funding}
            className="mt-3 w-full border border-hairline-strong py-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-100 transition-colors duration-150 ease-snap hover:border-brass-500 disabled:opacity-50"
            style={{ borderRadius: "0 0 0 10px" }}
          >
            {funding ? "Sending…" : "Get 10,000 test USDC"}
          </button>
          {fundErr && (
            <p className="mt-2 text-[11px] text-red-400" role="alert">
              {fundErr}
            </p>
          )}
        </div>
      )}

      {/* Phantom needs Testnet Mode on, or it signs against the wrong cluster and
          the bet never appears. Cheaper to say it than to let people hit it. */}
      {wallet.connected && open && (
        <p className="mt-3 text-[10px] leading-snug text-ink-600">
          Devnet. Your wallet must have Testnet&nbsp;Mode enabled.
        </p>
      )}

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

        {/* A wallet request can be queued behind the extension icon without ever
            raising a window. Say where to look instead of spinning silently. */}
        {waking && tx.s === "signing" && (
          <p className="mt-3 text-[11px] leading-snug text-ink-400" role="status">
            Waiting on your wallet. If no prompt appeared, open the wallet extension
            from the toolbar — the request is probably waiting there.
          </p>
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
