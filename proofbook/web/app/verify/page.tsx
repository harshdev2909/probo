"use client";

/**
 * /verify — the thesis, made literal.
 *
 * Paste any ProofBook market address and this page re-derives its Proof Receipt
 * from scratch, in your browser, without believing a single thing ProofBook says.
 * The settlement and the predicate come from the Solana account. The Merkle root
 * comes from TxLINE's own on-chain PDA. The verdict comes from TxLINE's own
 * program. ProofBook's API and database are never consulted.
 *
 * And because "trust us, the proof is real" would be its own kind of trust, there
 * is a Tamper control: it corrupts one byte and shows the oracle refuse it.
 */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";

import {
  verifyReceipt,
  initialSteps,
  TXORACLE_ID,
  type Step,
} from "@/lib/verify";
import { Reveal } from "@/components/motion";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

type Cred = { origin: string; jwt: string; apiToken: string };

function VerifyInner() {
  const params = useSearchParams();
  const { connection } = useConnection();

  const [pda, setPda] = useState(params.get("market") ?? "");
  const [steps, setSteps] = useState<Step[]>(initialSteps());
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<null | boolean>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [cred, setCred] = useState<Cred | null>(null);
  const [tampered, setTampered] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/txline/credential`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setCred)
      .catch(() => setCred(null));
  }, []);

  const run = useCallback(
    async (tamper: boolean) => {
      if (!pda || !cred || running) return;
      setRunning(true);
      setDone(null);
      setFatal(null);
      setTampered(tamper);
      setSteps(initialSteps());
      const res = await verifyReceipt({
        marketPda: pda.trim(),
        connection,
        credential: cred,
        tamper,
        onStep: setSteps,
      });
      setDone(res.verified);
      setFatal(res.fatal ?? null);
      setRunning(false);
    },
    [pda, cred, connection, running]
  );

  // Deep-link straight from a receipt: ?market=<pda> runs on load.
  useEffect(() => {
    const m = params.get("market");
    if (m && cred && !running && done === null) void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cred]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Reveal>
        <p className="label text-brass-500">Public verifier</p>
        <h1 className="display mt-2 text-4xl text-ink-100 sm:text-5xl">
          Don&rsquo;t trust us.
        </h1>
        <p className="mt-4 max-w-xl text-ink-400">
          This page rebuilds a Proof Receipt from scratch, in your browser. It
          reads the settlement and the predicate from the{" "}
          <strong className="text-ink-200">Solana account</strong>, the Merkle
          root from{" "}
          <strong className="text-ink-200">TxLINE&rsquo;s own on-chain PDA</strong>
          , and asks{" "}
          <strong className="text-ink-200">TxLINE&rsquo;s own program</strong> for
          the verdict. ProofBook&rsquo;s API and database are never consulted.
        </p>
      </Reveal>

      {/* input */}
      <Reveal>
        <div className="panel mt-10 border border-[--color-hairline] p-5">
          <label className="label text-ink-500">Market address</label>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <input
              value={pda}
              onChange={(e) => setPda(e.target.value)}
              spellCheck={false}
              placeholder="Paste any ProofBook market address…"
              className="min-w-0 flex-1 border border-[--color-hairline] bg-ink-950 px-3 py-2 font-mono text-sm text-ink-200 outline-none focus:border-brass-600"
            />
            <button
              onClick={() => run(false)}
              disabled={!pda || !cred || running}
              className="bg-brass-500 px-5 py-2 font-mono text-sm font-semibold text-ink-950 transition-opacity disabled:opacity-40"
              style={{ borderRadius: "0 0 0 8px" }}
            >
              {running && !tampered ? "Verifying…" : "Verify"}
            </button>
          </div>

          {!cred && (
            <p className="mt-3 text-xs text-amber-400">
              Waiting for a TxLINE read credential…
            </p>
          )}
        </div>
      </Reveal>

      {/* steps */}
      <ol className="mt-10 space-y-px">
        {steps.map((s, i) => (
          <StepRow key={s.key} step={s} n={i + 1} />
        ))}
      </ol>

      {/* verdict */}
      {done !== null && (
        <Reveal>
          <div
            className="panel mt-8 border p-6"
            style={{
              borderColor: done
                ? "var(--brass-600)"
                : "var(--color-oxide-500)",
              background: done ? "var(--brass-950)" : "var(--color-oxide-950)",
            }}
          >
            <p
              className="display text-3xl"
              style={{
                color: done ? "var(--brass-400)" : "var(--color-oxide-400)",
              }}
            >
              {done ? "VERIFIED" : tampered ? "REJECTED" : "NOT VERIFIED"}
            </p>
            <p className="mt-2 text-sm text-ink-300">
              {done ? (
                <>
                  TxLINE&rsquo;s program verified this settlement against the root
                  it published on Solana. Nothing ProofBook said was taken on
                  faith.
                </>
              ) : tampered ? (
                <>
                  One byte was changed and the oracle refused it. That is the
                  whole point: it does not matter who hands you the proof, because
                  a false one cannot pass.
                </>
              ) : (
                fatal ?? "This settlement did not verify. We are not going to pretend otherwise."
              )}
            </p>
          </div>
        </Reveal>
      )}

      {/* the honesty control */}
      {done === true && !tampered && (
        <Reveal>
          <div className="mt-6 border border-dashed border-[--color-hairline-strong] p-5">
            <p className="label text-ink-500">Still not convinced?</p>
            <p className="mt-2 text-sm text-ink-400">
              ProofBook handed your browser a TxLINE read token — a key, not an
              answer. If we could use that to lie, this page would be theatre. So
              corrupt the proof and watch what happens.
            </p>
            <button
              onClick={() => run(true)}
              disabled={running}
              className="mt-4 border border-[--color-oxide-500] px-4 py-2 font-mono text-xs text-oxide-400 transition-colors hover:bg-[--color-oxide-950] disabled:opacity-40"
            >
              {running ? "Tampering…" : "Tamper with the proof →"}
            </button>
          </div>
        </Reveal>
      )}

      {tampered && done === false && (
        <Reveal>
          <button
            onClick={() => run(false)}
            className="mt-6 font-mono text-xs text-brass-500 underline underline-offset-4"
          >
            ← Verify the honest proof again
          </button>
        </Reveal>
      )}

      <p className="mt-14 border-t border-[--color-hairline] pt-6 font-mono text-xs leading-relaxed text-ink-600">
        txoracle program{" "}
        <span className="text-ink-500">{TXORACLE_ID.toBase58()}</span>
        <br />
        Every fact above is read from Solana or from TxLINE. If ProofBook
        disappeared tonight, this page would still work.
      </p>
    </main>
  );
}

function StepRow({ step, n }: { step: Step; n: number }) {
  const color =
    step.status === "ok"
      ? "var(--brass-400)"
      : step.status === "fail"
      ? "var(--color-oxide-400)"
      : step.status === "running"
      ? "var(--amber-400)"
      : "var(--color-ink-700)";

  return (
    <li className="border border-[--color-hairline] bg-ink-950/40 p-5">
      <div className="flex items-start gap-4">
        <span
          className="mt-0.5 font-mono text-xs tabular-nums"
          style={{ color }}
        >
          {step.status === "ok"
            ? "✓"
            : step.status === "fail"
            ? "✗"
            : step.status === "running"
            ? "◍"
            : String(n).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="font-mono text-sm"
            style={{
              color:
                step.status === "pending" ? "var(--color-ink-600)" : "var(--color-ink-200)",
            }}
          >
            {step.title}
          </p>
          <p className="mt-1 text-xs text-ink-600">{step.source}</p>

          {step.detail && (
            <p
              className="mt-3 text-sm"
              style={{
                color:
                  step.status === "fail"
                    ? "var(--color-oxide-400)"
                    : "var(--color-ink-400)",
              }}
            >
              {step.detail}
            </p>
          )}

          {step.evidence && (
            <dl className="mt-3 space-y-1 border-l border-[--color-hairline] pl-3">
              {Object.entries(step.evidence).map(([k, v]) => (
                <div key={k} className="flex flex-wrap gap-x-2 font-mono text-xs">
                  <dt className="text-ink-600">{k}</dt>
                  <dd className="min-w-0 break-all text-ink-400">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </li>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-3xl px-6 py-16">
          <p className="label text-ink-600">Loading verifier…</p>
        </main>
      }
    >
      <VerifyInner />
    </Suspense>
  );
}
