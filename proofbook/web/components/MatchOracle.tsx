"use client";

/**
 * Match Oracle — a sharp, one-glance read of the market, computed from data we
 * already hold.
 *
 * It is an analytical model, not a language model: every sentence is derived from
 * real numbers — TxLINE's demargined consensus probability, ProofBook's own
 * pool-implied probability, the gap between them, and how the consensus line has
 * moved. Nothing is invented. Where TxLINE has published no line (odds appear only
 * around kickoff), it says so and reads the crowd alone rather than making a
 * number up.
 *
 * "Demargined" is the load-bearing word on the sharp side: the bookmaker overround
 * is stripped, so the consensus figure is a real probability, not a padded price —
 * which is what makes the divergence meaningful.
 */
import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

interface OddsPoint {
  at: number;
  crowd: number[];
  sharp: number[];
}
interface OddsSeries {
  outcomes: string[];
  points: OddsPoint[];
  latest: {
    crowd: number[];
    sharp: number[] | null;
    divergence: number[] | null;
    bookmaker: string | null;
  };
  note: string | null;
}

interface Read {
  hasSharp: boolean;
  headline: string;
  lines: string[];
  bookmaker?: string | null;
  /** The outcome where crowd and consensus diverge most (for the callout). */
  edge?: { outcome: string; pp: number; crowdOver: boolean } | null;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const argmax = (a: number[]) => a.reduce((bi, _, i) => (a[i] > a[bi] ? i : bi), 0);

/** The whole model. Pure — same numbers in, same read out. */
export function readMarket(s: OddsSeries, labels: string[]): Read | null {
  const outcomes = labels.length ? labels : s.outcomes;
  const crowd = s.latest.crowd;
  if (!crowd?.length) return null;
  const crowdFav = argmax(crowd);

  // No consensus line — read the crowd alone, and say why.
  if (!s.latest.sharp) {
    const conf = crowd[crowdFav];
    const strength = conf > 0.6 ? "a firm" : conf > 0.45 ? "a clear" : "a narrow";
    return {
      hasSharp: false,
      headline: `The crowd makes ${outcomes[crowdFav]} ${strength} favourite at ${pct(conf)}.`,
      lines: [
        s.note ??
          "TxLINE publishes a demargined consensus only from around a day before kickoff, so there is no sharp price to measure against yet — this is ProofBook's own book.",
      ],
    };
  }

  const sharp = s.latest.sharp;
  const sharpFav = argmax(sharp);
  const div = crowd.map((c, i) => c - (sharp[i] ?? 0)); // fraction; + = crowd higher
  const maxIdx = div.reduce((bi, _, i) => (Math.abs(div[i]) > Math.abs(div[bi]) ? i : bi), 0);
  const dpp = Math.abs(div[maxIdx] * 100);
  const crowdOver = div[maxIdx] > 0;
  const agree = crowdFav === sharpFav;

  const lines: string[] = [];

  if (dpp < 1) {
    lines.push(
      `Crowd and consensus sit within a point on every outcome — an efficient market with no clear edge.`
    );
  } else {
    lines.push(
      `The crowd ${crowdOver ? "over" : "under"}rates ${outcomes[maxIdx]} by ${dpp.toFixed(
        1
      )}pp — ${pct(crowd[maxIdx])} here against the demargined consensus of ${pct(
        sharp[maxIdx]
      )}. If the sharp line is right, the value is on the ${crowdOver ? "other side" : outcomes[maxIdx]}.`
    );
  }

  // Line movement on the divergent outcome: earliest recorded consensus vs latest.
  const withSharp = s.points.filter((p) => p.sharp && p.sharp.length === outcomes.length);
  if (withSharp.length >= 2) {
    const drift = (sharp[maxIdx] - withSharp[0].sharp[maxIdx]) * 100;
    if (Math.abs(drift) < 0.5) {
      lines.push(`The consensus on ${outcomes[maxIdx]} has held steady since the line opened.`);
    } else {
      lines.push(
        `Since it opened, the consensus on ${outcomes[maxIdx]} has ${
          drift > 0 ? "firmed" : "eased"
        } ${Math.abs(drift).toFixed(1)}pp — ${
          drift > 0 ? "sharp money leaning in" : "sharp money stepping off"
        }.`
      );
    }
  }

  return {
    hasSharp: true,
    headline: agree
      ? `Sharp and crowd agree: ${outcomes[sharpFav]} is the favourite (consensus ${pct(
          sharp[sharpFav]
        )}, crowd ${pct(crowd[crowdFav])}).`
      : `Split read — the crowd backs ${outcomes[crowdFav]}, but TxLINE's line makes ${outcomes[sharpFav]} the favourite.`,
    lines,
    bookmaker: s.latest.bookmaker,
    edge: dpp >= 1 ? { outcome: outcomes[maxIdx], pp: dpp, crowdOver } : null,
  };
}

export function MatchOracle({
  marketPda,
  outcomes,
}: {
  marketPda: string;
  outcomes: string[];
}) {
  const [read, setRead] = useState<Read | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API_URL}/markets/${marketPda}/odds`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s: OddsSeries | null) => {
          if (alive) setRead(s ? readMarket(s, outcomes) : null);
        })
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [marketPda, outcomes]);

  if (!read) return null;

  return (
    <section className="panel border border-hairline p-5">
      <div className="flex items-baseline justify-between">
        <p className="label text-brass-500">Match Oracle</p>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-600">
          {read.hasSharp ? "sharp vs crowd" : "crowd read"}
        </span>
      </div>

      <p className="mt-3 text-[15px] leading-snug text-ink-100">{read.headline}</p>

      <ul className="mt-3 space-y-2">
        {read.lines.map((l, i) => (
          <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-400">
            <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 bg-brass-600" />
            <span>{l}</span>
          </li>
        ))}
      </ul>

      {read.edge && (
        <div className="mt-4 flex items-center justify-between border-t border-hairline pt-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-500">
            biggest gap
          </span>
          <span
            className="font-mono text-[12px]"
            style={{ color: read.edge.crowdOver ? "var(--color-oxide-400)" : "var(--color-pitch-400)" }}
          >
            {read.edge.outcome} · {read.edge.crowdOver ? "+" : "−"}
            {read.edge.pp.toFixed(1)}pp {read.edge.crowdOver ? "crowd-high" : "crowd-low"}
          </span>
        </div>
      )}

      <p className="mt-4 border-t border-hairline pt-3 text-[10px] leading-relaxed text-ink-600">
        A deterministic read of the numbers — TxLINE&rsquo;s demargined consensus against
        ProofBook&rsquo;s pool, and how the line has moved. Display only: no price ever
        touches a proof or a payout.
        {read.bookmaker ? ` Consensus: ${read.bookmaker}.` : ""}
      </p>
    </section>
  );
}
