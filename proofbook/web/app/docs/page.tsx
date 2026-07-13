"use client";

/**
 * /docs — how ProofBook settles, and how to verify it without trusting us.
 *
 * The one-liner at the top is the whole point: a judge with npx can re-derive
 * any receipt on this site against the live oracle from their own terminal.
 */
import { useState } from "react";
import Link from "next/link";
import { Reveal } from "@/components/motion";
import { PageArt } from "@/components/PageArt";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      className="shrink-0 border border-hairline-strong px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-300 transition-colors hover:border-brass-600 hover:text-brass-400"
      aria-label="Copy to clipboard"
    >
      {done ? "copied ✓" : "copy"}
    </button>
  );
}

function Cmd({ children, copy }: { children: string; copy?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border border-hairline bg-ink-950 px-3.5 py-2.5">
      <code className="min-w-0 overflow-x-auto whitespace-pre font-mono text-[12.5px] text-ink-200">
        {children}
      </code>
      <Copy text={copy ?? children} />
    </div>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 mt-14 flex items-center gap-3">
      <span aria-hidden className="h-2.5 w-2.5 bg-brass-500" style={{ borderRadius: "0 0 0 6px" }} />
      <h2 className="label !text-[12px]">{children}</h2>
      <span className="rule flex-1" />
    </div>
  );
}

const FLOW = [
  ["1", "Market created", "The predicate is fixed on-chain at creation: which stats, which comparison, which threshold. Nobody can change the question later."],
  ["2", "Bets escrowed", "USDC sits in a PDA vault. Parimutuel pools, no counterparty."],
  ["3", "Match finalises", "TxLINE publishes a merkle root of every match stat to their own Solana program, daily."],
  ["4", "Keeper submits the proof", "Anyone may. The proof carries values + merkle paths; the market supplies the question. settle_market CPIs TxLINE's validate_stat_v3."],
  ["5", "The oracle adjudicates", "TxLINE's program, not ours, checks the multiproof against the root TxLINE published, evaluates the predicate, and returns true or the transaction fails."],
  ["6", "Receipt", "The settlement writes the proof ref, root PDA, resolver and timestamp into the account. That record is what this site renders, and what you can re-verify below."],
] as const;

export default function Docs() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 pb-24 pt-12 lg:px-10">
      <PageArt src="/art-keeper.jpg" opacity={0.22} />

      <header className="mb-8">
        <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">Docs</h1>
        <p className="mt-2 max-w-xl text-[13px] text-ink-400">
          ProofBook is a prediction market where settlement is a cryptographic
          proof, not a decision. Everything below exists so you can check that
          claim yourself.
        </p>
      </header>

      {/* the hero: verify from your terminal */}
      <Reveal>
        <section className="panel border border-brass-600/50 p-6">
          <p className="label text-brass-500">Verify it yourself in one command</p>
          <p className="mb-4 mt-2 text-[13px] leading-relaxed text-ink-300">
            Pick any receipt on this site, copy its market address, and run:
          </p>
          <Cmd>{`npx @h4rsharma/txline-settle verify <marketPda>`}</Cmd>
          <p className="mt-4 text-[12px] leading-relaxed text-ink-500">
            Five steps, none of which trust ProofBook: the settlement and its
            predicate are read from the <b className="text-ink-300">Solana account</b>,
            the merkle root from <b className="text-ink-300">TxLINE&rsquo;s own on-chain PDA</b>,
            the proof from <b className="text-ink-300">TxLINE&rsquo;s API</b>, and the
            verdict from <b className="text-ink-300">TxLINE&rsquo;s own program</b> by
            simulation. Add <code className="font-mono text-ink-300">--tamper</code> to
            corrupt one byte and watch the oracle refuse it. There is also an
            in-browser version at <Link href="/verify" className="text-brass-500 underline underline-offset-2">/verify</Link>.
          </p>
        </section>
      </Reveal>

      {/* the flow */}
      <H2>How a market settles itself</H2>
      <ol className="space-y-px">
        {FLOW.map(([n, title, body]) => (
          <li key={n} className="flex gap-4 border border-hairline bg-ink-950/50 p-4">
            <span className="font-mono text-[13px] text-brass-500">{n}</span>
            <div>
              <p className="text-[13.5px] text-ink-100">{title}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 font-mono text-[11px] text-ink-600">
        market&nbsp;(question, fixed) + proof&nbsp;(values, merkle paths) →
        validate_stat_v3 → true | fail. there is no admin path.
      </p>

      {/* SDK quickstart */}
      <H2>SDK · @h4rsharma/txline-settle</H2>
      <p className="mb-3 text-[13px] leading-relaxed text-ink-400">
        The settlement core of this site, published as a library. Unofficial,
        community-built; not affiliated with TxODDS/TxLINE. It is the same code
        the keeper runs. The app imports the package.
      </p>
      <Cmd>npm i @h4rsharma/txline-settle</Cmd>
      <pre className="mt-3 overflow-x-auto border border-hairline bg-ink-950 p-4 font-mono text-[12px] leading-relaxed text-ink-300">
{`import { parlay, homeWin, overCorners, strategyFor,
         TxLineSession, findFinalisedSeq, fetchProofV3,
         toPayloadV3, dailyRootsPda } from "@h4rsharma/txline-settle";

// "Home win AND over 9.5 corners" as an exhaustive 2×2 grid.
// Overlapping stat families throw at build time (TxLINE 6070).
const market   = parlay(homeWin, overCorners(9.5));   // legs [1,2,7,8]
const seq      = await findFinalisedSeq(session, fixtureId);
const val      = await fetchProofV3(session, fixtureId, seq,
                                    market.legs.map(l => l.key));
const payload  = toPayloadV3(val, BN);                // ONE shared multiproof
const strategy = strategyFor(market, 0);              // outcome 0 = the parlay

await myProgram.methods.settle(0, payload).accounts({
  market: myMarket,
  oracleProgram: TXORACLE_DEVNET,
  oracleRoots: dailyRootsPda(proofEpochDay(val)),     // TxLINE's own PDA
}).rpc();`}
      </pre>
      <div className="mt-3 grid gap-2 text-[12.5px] leading-relaxed text-ink-400 sm:grid-cols-2">
        <div className="border border-hairline p-3.5">
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-500">modules</p>
          <p className="mt-1.5">
            <b className="text-ink-200">session</b> guest JWT · free-tier subscribe · 403 re-subscribe ·{" "}
            <b className="text-ink-200">feed</b> fixtures, scores ·{" "}
            <b className="text-ink-200">proof</b> v3 multiproof fetch + payload ·{" "}
            <b className="text-ink-200">predicate</b> conditions, 2×2 parlays, coverage checks ·{" "}
            <b className="text-ink-200">verify</b> trust-nothing settlement verification ·{" "}
            <b className="text-ink-200">cpi</b> roots PDA + a copy-paste Rust module ·{" "}
            <b className="text-ink-200">receipts</b> chain-only reconstruction
          </p>
        </div>
        <div className="border border-hairline p-3.5">
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-500">for Rust programs</p>
          <p className="mt-1.5">
            The package ships <code className="font-mono text-ink-300">rust/txline_cpi.rs</code>:
            wire types byte-identical to txoracle v1.5.6 plus{" "}
            <code className="font-mono text-ink-300">invoke_validate_stat_v3</code>, so any Anchor
            program can settle from a TxLINE proof. One rule: take the VALUES from
            the caller, take the PREDICATE from your own account.
          </p>
        </div>
      </div>

      {/* CLI reference */}
      <H2>CLI reference</H2>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-400">
        Every command works via <code className="font-mono text-ink-300">npx @h4rsharma/txline-settle</code>{" "}
        with nothing installed (short alias once installed:{" "}
        <code className="font-mono text-ink-300">txsettle</code>). Each example below
        is copyable and real.
      </p>

      <div className="space-y-5">
        {[
          {
            cmd: "auth",
            desc: "Authenticate with TxLINE: guest JWT → FREE on-chain World-Cup subscription (Token-2022, price 0) → activate. Caches the session at ~/.txline-settle/ (read credentials, not funds). Needs a funded devnet keypair to sign the subscribe transaction.",
            ex: "npx @h4rsharma/txline-settle auth --keypair ~/.config/solana/id.json",
          },
          {
            cmd: "fixtures",
            desc: "List fixtures with kickoff times and ids. --league selects the competition (World Cup = 72, the default).",
            ex: "npx @h4rsharma/txline-settle fixtures --league 72",
          },
          {
            cmd: "scores <fixtureId>",
            desc: "The retained score records for a fixture, with the best terminal record highlighted (statusId 100 = game_finalised). --watch streams every live update over SSE instead.",
            ex: "npx @h4rsharma/txline-settle scores 18237038 --watch",
          },
          {
            cmd: "proof <fixtureId> --stats 1,2",
            desc: "Fetch a real stat-validation-v3 merkle multiproof. --stats is the leg list in key order (max 5; the API rejects a 6th); --seq pins a record, otherwise the finalised one is used.",
            ex: "npx @h4rsharma/txline-settle proof 18218149 --stats 1,2,7,8",
          },
          {
            cmd: "predicate",
            desc: "Build the exhaustive 2×2 parlay grid from two conditions, or check leg-set compatibility with --check. Overlapping stat families are refused with the DuplicateStatCoverage (6070) explanation, because the oracle would refuse them too.",
            ex: "npx @h4rsharma/txline-settle predicate --a homeWin --b overCorners:9.5",
            ex2: 'npx @h4rsharma/txline-settle predicate --check "1,2+7,8"',
          },
          {
            cmd: "verify <marketPda|txSig>",
            desc: "★ The hero. Independently re-verify a settlement: settlement + predicate from the Solana account, merkle root from TxLINE's own PDA, proof from TxLINE, verdict from TxLINE's own program by simulation. --tamper corrupts one byte to prove a forgery cannot pass. Accepts a settle transaction signature too.",
            ex: "npx @h4rsharma/txline-settle verify 8m3iQDertFPaamME5zWgMyPU5KrSfBCFq1MSAjBj7Txx",
            ex2: "npx @h4rsharma/txline-settle verify 8m3iQDertFPaamME5zWgMyPU5KrSfBCFq1MSAjBj7Txx --tamper",
          },
          {
            cmd: "market create",
            desc: "Create a 1X2 market on a fixture (the reference market shape). --period matters. Pin the period the fixture's proof actually carries: 100 only survives ~10 days, older fixtures prove at 5.",
            ex: "npx @h4rsharma/txline-settle market create --fixture 18237038 --mint <usdcMint> --lock 1784055600 --period 100",
          },
          {
            cmd: "market bet / lock / settle / claim",
            desc: "The rest of the lifecycle. settle fetches the real proof, derives the outcome the proven values satisfy, and submits the oracle CPI, the same trustless path the keeper takes. claim pays a winning position.",
            ex: "npx @h4rsharma/txline-settle market bet --market <pda> --outcome 0 --amount 25",
            ex2: "npx @h4rsharma/txline-settle market settle --market <pda>",
          },
          {
            cmd: "market receipt",
            desc: "Reconstruct a settlement receipt purely from chain accounts: proof ref, epoch day, roots PDA, resolver, pools. No API, no database.",
            ex: "npx @h4rsharma/txline-settle market receipt --market <pda> --json",
          },
        ].map((c) => (
          <div key={c.cmd} className="border border-hairline p-4">
            <p className="font-mono text-[13px] text-brass-400">{c.cmd}</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-400">{c.desc}</p>
            <div className="mt-2.5 space-y-1.5">
              <Cmd>{c.ex}</Cmd>
              {c.ex2 && <Cmd>{c.ex2}</Cmd>}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 font-mono text-[11px] leading-relaxed text-ink-600">
        global flags on every command: --json (machine output) · --devnet (default) |
        --mainnet · --rpc &lt;url&gt; · --api &lt;origin&gt; · --keypair &lt;path&gt;
      </p>

      {/* the gotchas */}
      <H2>The findings that shape everything here</H2>
      <div className="space-y-2 text-[13px] leading-relaxed text-ink-400">
        <div className="border border-hairline p-4">
          <p className="text-ink-100">Parlay legs must read disjoint stat families</p>
          <p className="mt-1.5">
            The oracle evaluates each proven stat <b className="text-ink-200">exactly once</b>{" "}
            (errors 6070/6071, confirmed live). &ldquo;Home win AND over 2.5
            goals&rdquo; is therefore <b className="text-ink-200">not expressible</b>, because both
            legs read goals. Families: goals&nbsp;1|2 · yellows&nbsp;3|4 ·
            reds&nbsp;5|6 · corners&nbsp;7|8. The SDK and the on-chain program
            both refuse an overlapping combo before it can become a market.
          </p>
        </div>
        <div className="border border-hairline p-4">
          <p className="text-ink-100">period 100 vs period 5: the retention trap</p>
          <p className="mt-1.5">
            TxLINE keeps the <code className="font-mono">game_finalised</code> (period&nbsp;100)
            record only ~10 days; older fixtures prove at period&nbsp;5 (full
            time). The proof leaf commits to the period, and a market spec pinned
            to the wrong one can <b className="text-ink-200">never settle</b>{" "}
            (InvalidStatProof 6023). Read the proof&rsquo;s period first, then
            create the market.
          </p>
        </div>
        <div className="border border-hairline p-4">
          <p className="text-ink-100">The zero-stake cancel</p>
          <p className="mt-1.5">
            If the proven outcome has an empty pool, settlement routes to
            Cancelled (refunds, no fee). Correct, but the market never earns a
            receipt. It once silently voided 74 markets. Stake every outcome
            before lock, atomically.
          </p>
        </div>
        <div className="border border-hairline p-4">
          <p className="text-ink-100">Cancellation is not provable, by design of the tree</p>
          <p className="mt-1.5">
            The fixture leaf TxLINE commits to has no status field, and a merkle
            inclusion proof cannot prove <i>absence</i>. The time-based
            permissionless cancel is not a fallback; it is the only sound
            liveness primitive this interface admits.
          </p>
        </div>
      </div>

      <p className="mt-14 border-t border-hairline pt-6 font-mono text-[11px] leading-relaxed text-ink-600">
        package: @h4rsharma/txline-settle · MIT · unofficial, not affiliated with
        TxODDS/TxLINE · the on-chain interface reference lives in
        docs/TXLINE_INTERFACE.md and docs/ONCHAIN_INTERFACE.md in the repo.
      </p>
    </main>
  );
}
