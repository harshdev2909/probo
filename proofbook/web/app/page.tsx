"use client";

/**
 * Landing. Storyboard (times from mount):
 *     0ms  kicker label fades in
 *    80ms  headline rises, line by line (3 lines × 90ms)
 *   350ms  subcopy + CTAs
 *   500ms  the receipt tilts up into place (hero spring)
 *   scroll editorial sections reveal once in view
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { api, type MarketView } from "@/lib/api";
import { Receipt } from "@/components/Receipt";
import { FixtureCard } from "@/components/FixtureCard";
import { Reveal, SPRING } from "@/components/motion";
import { Mark } from "@/components/Mark";

const T = { kicker: 0, line: 0.08, lineStep: 0.09, sub: 0.35, receipt: 0.5 };

/**
 * A genuine devnet settlement — the proof ref, resolver and settle tx below are
 * all real and checkable on Solscan. The teams are the ones TxLINE itself names
 * for this fixture (United States v Belgium); an earlier hardcoded fixture map
 * had this labelled MEX v USA, which was simply wrong.
 */
const REAL_RECEIPT = {
  matchId: 18193785,
  homeCode: "USA",
  awayCode: "BEL",
  finalScore: { home: 1, away: 4 },
  outcomeLabel: "BEL win",
  statKeys: "1, 2",
  period: 100,
  epochDay: 20641,
  dailyRootsPda: "GRJBcG6G9CnvvNZPQagxietR7caFtAG8sFRZ2mg5n8QZ",
  proofRef: "4730ab15daff7602980c6fcf464e5619f4dcf325cb5ce9c9973ab0e5be1cacfe",
  resolver: "8Hfn9BsxYgaxJoDk3sDBBEZ65H79oTMYo7mkLSjhFzH1",
  settleTx: "3GptFFBGbZpkSezLx3aTbNHome6gSjKEywiqoKfRsgujwFbTHnJuBVD4NdmLzGsR6DfqvkBiWoEW6XRsNNDNXAoP",
  oracleProgram: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  settledAtIso: "2026-07-07 11:04 UTC · Solana devnet",
  specimen: true,
};

const HEADLINE = ["Every payout", "proven,", "not trusted."];

export default function Landing() {
  const reduced = useReducedMotion();
  const [teasers, setTeasers] = useState<MarketView[]>([]);
  useEffect(() => {
    api
      .allMarkets()
      .then((ms) => setTeasers(ms.filter((m) => m.status !== "cancelled").slice(0, 2)))
      .catch(() => {});
  }, []);

  return (
    <main>
      {/* ── HERO ── */}
      <section className="relative mx-auto grid w-full max-w-6xl gap-14 px-6 pb-24 pt-16 lg:grid-cols-[1.1fr_0.9fr] lg:px-10 lg:pt-24">
        {/* original generated art, full bleed (no real player likeness) */}
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/art-hero.jpg" alt="" className="h-full w-full object-cover object-right opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-r from-ink-950 via-ink-950/60 to-ink-950/20" />
          <div className="absolute inset-0 bg-gradient-to-b from-ink-950/60 via-transparent to-ink-950" />
        </div>

        <div>
          <motion.p
            className="label"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: T.kicker, duration: 0.4 }}
          >
            World Cup 2026 · bet with proof
          </motion.p>
          <h1 className="mt-6" aria-label="Every payout proven, not trusted.">
            {HEADLINE.map((line, i) => (
              <span key={line} className="block overflow-hidden">
                <motion.span
                  className={`display block text-[clamp(44px,8vw,96px)] ${i === 1 ? "text-brass-400" : "text-ink-100"}`}
                  initial={reduced ? false : { y: "105%" }}
                  animate={{ y: 0 }}
                  transition={{ ...SPRING.hero, delay: T.line + i * T.lineStep }}
                >
                  {line}
                </motion.span>
              </span>
            ))}
          </h1>
          <motion.div
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...SPRING.settle, delay: T.sub }}
          >
            <p className="mt-7 max-w-md text-[15px] leading-relaxed text-ink-300">
              Back your team. When the final whistle blows, the result is checked
              cryptographically and winners get paid on the spot. No referees behind the
              scenes. No waiting on support. If a match can&apos;t be verified, everyone gets
              their money back automatically.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/matches"
                className="display-condensed bg-ink-100 px-7 py-3.5 text-[16px] text-ink-950 transition-colors duration-150 ease-snap hover:bg-ink-200"
                style={{ borderRadius: "0 0 0 14px" }}
              >
                See the matches
              </Link>
              <a
                href="#how"
                className="display-condensed border border-hairline-strong px-7 py-3.5 text-[16px] text-ink-100 transition-colors duration-150 ease-snap hover:border-ink-500"
              >
                How it settles
              </a>
            </div>
          </motion.div>
        </div>

        {/* the differentiator, immediately: a real settled receipt */}
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 34, rotate: 1.5 }}
          animate={{ opacity: 1, y: 0, rotate: 0 }}
          transition={{ ...SPRING.hero, delay: T.receipt }}
          className="lg:mt-2"
        >
          <Receipt data={REAL_RECEIPT} />
          <p className="mt-4 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-500">
            a real settled bet. press verify
          </p>
        </motion.div>
      </section>

      {/* ── STATUS QUO vs PROOF ── */}
      <section className="rule">
        <div className="mx-auto grid w-full max-w-6xl gap-4 px-6 py-20 md:grid-cols-2 lg:px-10">
          <Reveal className="border border-hairline bg-ink-900 p-8">
            <p className="label mb-4 !text-oxide-400">The status quo</p>
            <p className="display-condensed text-[22px] leading-tight text-ink-300">
              &ldquo;Your payout is under review. Please allow 48 to 72 hours.&rdquo;
            </p>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-400">
              Other betting apps decide your payout behind closed doors. You wait, you hope, and sometimes they get it wrong.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="border border-brass-600/40 bg-ink-900 p-8">
            <p className="label mb-4 !text-brass-400">Probo</p>
            <p className="display-condensed text-[22px] leading-tight text-ink-100">
              The result is verified automatically. Right pays instantly. Wrong is impossible.
            </p>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-400">
              Every payout comes with a receipt you can check yourself. Screenshot it, share it, verify it. Powered by TxLINE match data.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── HOW IT SETTLES ── */}
      <section id="how" className="rule">
        <div className="mx-auto w-full max-w-6xl px-6 py-20 lg:px-10">
          <Reveal>
            <h2 className="display text-[clamp(28px,4vw,44px)] text-ink-100">
              From kickoff to cash out
            </h2>
          </Reveal>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              {
                title: "Pick your side",
                body: "Pick Home, Draw or Away and stake USDC. Your money sits in a secure vault until the match ends.",
                glyph: <rect x="8" y="8" width="32" height="32" fill="var(--ink-100)" />,
              },
              {
                title: "Watch it live",
                body: "Scores stream in play by play, and the final result is recorded the moment the game ends.",
                glyph: <path d="M8 40 v-32 a32 32 0 0 1 32 32 z" fill="var(--ink-100)" opacity="0.5" />,
              },
              {
                title: "Get paid, with proof",
                body: "The result is verified and winners are paid in seconds. You get a receipt that proves your payout was correct.",
                glyph: <rect x="8" y="8" width="32" height="32" fill="var(--brass-500)" />,
              },
            ].map((step, i) => (
              <Reveal key={step.title} delay={i * 0.09}>
                <div className="panel h-full p-7">
                  <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden className="mb-5">
                    {step.glyph}
                  </svg>
                  <p className="display-condensed text-[19px] text-ink-100">{step.title}</p>
                  <p className="mt-2.5 text-[13px] leading-relaxed text-ink-400">{step.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── LIVE BOARD TEASER ── */}
      {teasers.length > 0 && (
        <section className="rule">
          <div className="mx-auto w-full max-w-6xl px-6 py-20 lg:px-10">
            <Reveal className="mb-6 flex items-end justify-between">
              <h2 className="display text-[clamp(28px,4vw,44px)] text-ink-100">On the board</h2>
              <Link href="/matches" className="label text-brass-400 hover:text-brass-500">
                All matches →
              </Link>
            </Reveal>
            <div className="grid gap-4 md:grid-cols-2">
              {teasers.map((m, i) => (
                <Reveal key={m.marketPda} delay={i * 0.08}>
                  <FixtureCard market={m} />
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── CLOSER ── */}
      <section className="rule">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-6 py-24 lg:px-10">
          <Mark size={40} />
          <Reveal>
            <p className="display max-w-3xl text-[clamp(30px,5vw,56px)] text-ink-100">
              The final whistle is a fact.
              <br />
              <span className="text-brass-400">Now it settles like one.</span>
            </p>
          </Reveal>
          <Link
            href="/matches"
            className="display-condensed mt-2 bg-ink-100 px-7 py-3.5 text-[16px] text-ink-950 transition-colors duration-150 ease-snap hover:bg-ink-200"
            style={{ borderRadius: "0 0 0 14px" }}
          >
            Open the board
          </Link>
        </div>
      </section>
    </main>
  );
}
