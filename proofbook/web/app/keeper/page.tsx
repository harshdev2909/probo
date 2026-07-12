"use client";

/** The autonomy page: watch the keeper create, lock, and settle by itself. */
import { Ticker } from "@/components/Ticker";
import { Reveal } from "@/components/motion";
import { Seal } from "@/components/Seal";
import { PageArt } from "@/components/PageArt";

const STEPS = [
  ["Finds the matches", "Every World Cup fixture gets its own market, opened automatically the moment the schedule drops."],
  ["Watches every game", "Live scores stream straight in. Betting closes at kickoff, on the dot, every time."],
  ["Knows the real final", "Regulation, extra time, penalties, even an abandoned match. The official final result is recorded the moment it exists."],
  ["Pays with proof", "The result is checked cryptographically and winners get paid. Every payout leaves a receipt you can verify yourself."],
] as const;

export default function KeeperPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 pt-12 lg:px-10">
      <PageArt src="/art-keeper.jpg" position="right center" opacity={0.25} />
      <header className="mb-10 grid items-end gap-6 md:grid-cols-[1fr_auto]">
        <div>
          <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">
            Nobody clicks<br />resolve
          </h1>
          <p className="mt-3 max-w-lg text-[14px] leading-relaxed text-ink-400">
            This is Probo running itself. Markets open, lock at kickoff and pay out with no one at the controls. Watch it happen live.
          </p>
        </div>
        <Seal size={110} state="verified" className="hidden md:block" />
      </header>

      <Reveal>
        <Ticker tall />
      </Reveal>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(([title, body], i) => (
          <Reveal key={title} delay={i * 0.07}>
            <div className="panel h-full p-5">
              <p className="tnum mb-3 font-mono text-[11px] text-brass-400">0{i + 1}</p>
              <p className="display-condensed text-[16px] text-ink-100">{title}</p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-400">{body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </main>
  );
}
