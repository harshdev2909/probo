"use client";

/**
 * "Try this in 60 seconds" — the first thing a judge sees.
 *
 * It is a live checklist, not instructions: each step ticks itself off from real
 * state (wallet connected? funds arrived? position open? receipt seen?), so a judge
 * always knows exactly where they are and what to press next. A wall of text would
 * be read by nobody; a strip that completes itself gets followed.
 *
 * Dismissible, and it stays dismissed. It also hides itself once all four steps are
 * done — at that point it has nothing left to say.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import { api } from "@/lib/api";
import { useCluster } from "@/lib/cluster";

const KEY = "probo.onboarding.dismissed";

type StepState = "done" | "active" | "todo";

export function Onboarding() {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const cluster = useCluster();
  const reduced = useReducedMotion();

  const [dismissed, setDismissed] = useState(true); // assume dismissed until we've read storage
  const [funded, setFunded] = useState(false);
  const [hasPosition, setHasPosition] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(localStorage.getItem(KEY) === "1");
  }, []);

  const owner = wallet.publicKey?.toBase58();

  // Steps 2 and 3 tick themselves off from the API, not from a local flag — a
  // judge who already has funds or a bet should not be told to get them again.
  const refresh = useCallback(async () => {
    if (!owner) {
      setFunded(false);
      setHasPosition(false);
      return;
    }
    try {
      const positions = await api.positions(owner);
      setHasPosition(positions.length > 0);
      if (positions.length > 0) setFunded(true);
    } catch {
      /* the banner is not worth an error state */
    }
  }, [owner]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fund = async () => {
    if (!owner) return;
    setFunding(true);
    setError(null);
    try {
      await api.faucet(owner);
      setFunded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFunding(false);
    }
  };

  const dismiss = () => {
    localStorage.setItem(KEY, "1");
    setDismissed(true);
  };

  const steps: {
    n: number;
    title: string;
    body: string;
    state: StepState;
    action?: React.ReactNode;
  }[] = [
    {
      n: 1,
      title: "Connect a wallet",
      body: "Phantom or Solflare. Devnet — no real money anywhere near this.",
      state: wallet.connected ? "done" : "active",
      action: wallet.connected ? undefined : (
        <button onClick={() => setVisible(true)} className="ob-btn">
          Connect
        </button>
      ),
    },
    {
      n: 2,
      title: "Get test funds",
      body: "10,000 demo USDC and a little SOL for the network fee. Free, instant.",
      state: funded ? "done" : wallet.connected ? "active" : "todo",
      action:
        wallet.connected && !funded ? (
          <button onClick={fund} disabled={funding} className="ob-btn">
            {funding ? "Sending…" : "Get funds"}
          </button>
        ) : undefined,
    },
    {
      n: 3,
      title: "Back a team",
      body: "Two semi-finals are open. Pick a side and place a bet.",
      state: hasPosition ? "done" : funded ? "active" : "todo",
      action:
        funded && !hasPosition ? (
          <Link href="/matches?status=open" className="ob-btn">
            Open matches
          </Link>
        ) : undefined,
    },
    {
      n: 4,
      title: "Check the proof",
      body: "76 matches already paid out on a cryptographic proof. Open one and verify it yourself.",
      state: "todo",
      action: (
        <Link href="/receipts" className="ob-btn">
          See receipts
        </Link>
      ),
    },
  ];

  const allDone = wallet.connected && funded && hasPosition;
  if (dismissed || allDone) return null;

  return (
    <AnimatePresence>
      <motion.section
        initial={reduced ? false : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className="border-b border-hairline bg-ink-900/60 backdrop-blur-[2px]"
        aria-label="How to try ProofBook"
      >
        <div className="mx-auto w-full max-w-6xl px-6 py-4 lg:px-10">
          <div className="mb-3 flex items-center gap-3">
            <span
              aria-hidden
              className="h-2.5 w-2.5 bg-brass-500"
              style={{ borderRadius: "0 0 0 6px" }}
            />
            <h2 className="label !text-[11px]">Try it in 60 seconds</h2>
            {cluster.ok === false && (
              <span className="label !text-[10px] !text-oxide-400">
                {cluster.cluster === "unknown"
                  ? "· can't reach the network"
                  : `· wrong network (${cluster.cluster})`}
              </span>
            )}
            <span className="rule flex-1" />
            <button
              onClick={dismiss}
              className="label !text-[10px] transition-colors hover:text-ink-100"
            >
              Dismiss
            </button>
          </div>

          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((s) => (
              <li
                key={s.n}
                className={`flex flex-col gap-1.5 border p-3 transition-colors ${
                  s.state === "active"
                    ? "border-brass-500/60 bg-ink-800/60"
                    : s.state === "done"
                      ? "border-hairline opacity-55"
                      : "border-hairline opacity-80"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`mono flex h-5 w-5 shrink-0 items-center justify-center text-[10px] ${
                      s.state === "done"
                        ? "bg-brass-500 text-ink-950"
                        : "border border-hairline-strong text-ink-400"
                    }`}
                    style={{ borderRadius: "0 0 0 5px" }}
                    aria-hidden
                  >
                    {s.state === "done" ? "✓" : s.n}
                  </span>
                  <span className="text-[13px] text-ink-100">{s.title}</span>
                </div>
                <p className="text-[11px] leading-snug text-ink-400">{s.body}</p>
                {s.action && <div className="mt-1">{s.action}</div>}
              </li>
            ))}
          </ol>

          {error && (
            <p className="mt-2 text-[11px] text-oxide-400" role="alert">
              {error}
            </p>
          )}

          <p className="mt-3 text-[10px] leading-snug text-ink-600">
            Devnet. Your wallet needs Testnet Mode enabled to preview these
            transactions. The tokens are a demo mint and are worth nothing.
          </p>
        </div>

        <style jsx>{`
          :global(.ob-btn) {
            display: inline-block;
            border: 1px solid var(--hairline-strong);
            padding: 5px 10px;
            font-family: var(--font-mono);
            font-size: 10px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--ink-100);
            border-radius: 0 0 0 8px;
            transition: border-color 150ms;
          }
          :global(.ob-btn:hover) {
            border-color: var(--brass-500);
          }
          :global(.ob-btn:disabled) {
            opacity: 0.5;
          }
        `}</style>
      </motion.section>
    </AnimatePresence>
  );
}
