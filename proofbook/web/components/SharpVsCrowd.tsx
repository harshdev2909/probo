"use client";

/**
 * SHARP vs CROWD.
 *
 * Two opinions about the same match, side by side:
 *
 *   SHARP  TxLINE's demargined consensus. "Demargined" is the load-bearing word:
 *          the bookmaker's overround has been stripped, so the implied
 *          probabilities sum to ~1.000 and the number is a real probability
 *          rather than a padded price. A SECOND TxLINE feed, entirely separate
 *          from the scores feed that settles markets.
 *
 *   CROWD  ProofBook's own parimutuel pools — what the people betting here
 *          actually think.
 *
 * The gap between them is the edge signal.
 *
 * Display only. No price ever touches a proof, a predicate, or a receipt. And
 * where TxLINE publishes no line — which is most of the time, since odds appear
 * only around kickoff and are purged afterwards — this shows the crowd alone and
 * says why, rather than drawing a flat line at some invented number.
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

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function SharpVsCrowd({
  marketPda,
  outcomes,
}: {
  marketPda: string;
  outcomes: string[];
}) {
  const [s, setS] = useState<OddsSeries | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API_URL}/markets/${marketPda}/odds`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && setS(d))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [marketPda]);

  if (!s) return null;

  const labels = outcomes.length ? outcomes : s.outcomes;
  const { crowd, sharp, divergence, bookmaker } = s.latest;

  return (
    <section className="panel border border-hairline p-5">
      <div className="flex items-baseline justify-between">
        <p className="label text-brass-500">Sharp vs crowd</p>
        {bookmaker && (
          <p className="font-mono text-[10px] text-ink-600">{bookmaker}</p>
        )}
      </div>

      {/* No consensus is a real state, and it says so. */}
      {!sharp ? (
        <>
          <div className="mt-4 space-y-2">
            {labels.map((l, i) => (
              <Row key={l} label={l} crowd={crowd[i]} sharp={null} div={null} />
            ))}
          </div>
          <p className="mt-4 border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-600">
            {s.note ??
              "TxLINE publishes no consensus line for this market, so we show none."}
          </p>
        </>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1">
            <span />
            <span className="label text-right text-ink-600">Sharp</span>
            <span className="label text-right text-ink-600">Crowd</span>
            <span className="label text-right text-ink-600">Edge</span>
            {labels.map((l, i) => (
              <Row
                key={l}
                label={l}
                crowd={crowd[i]}
                sharp={sharp[i]}
                div={divergence?.[i] ?? null}
              />
            ))}
          </div>

          <Sparkline points={s.points} n={labels.length} />

          <p className="mt-4 border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-600">
            <span className="text-ink-400">Sharp</span> is TxLINE&rsquo;s
            demargined consensus — the overround is stripped out, so it is a real
            probability, not a price.{" "}
            <span className="text-ink-400">Crowd</span> is this market&rsquo;s own
            pools. <span className="text-ink-400">Edge</span> is the gap. Display
            only: no price touches a proof or a payout.
          </p>
        </>
      )}
    </section>
  );
}

function Row({
  label,
  crowd,
  sharp,
  div,
}: {
  label: string;
  crowd: number;
  sharp: number | null;
  div: number | null;
}) {
  const edge = div === null ? null : div * 100;
  const color =
    edge === null
      ? "var(--color-ink-600)"
      : edge > 2
      ? "var(--color-pitch-400)"
      : edge < -2
      ? "var(--color-oxide-400)"
      : "var(--color-ink-500)";

  if (sharp === null) {
    return (
      <div className="flex items-center justify-between border-b border-hairline py-2 last:border-0">
        <span className="text-sm text-ink-300">{label}</span>
        <span className="tnum font-mono text-sm text-ink-200">{pct(crowd)}</span>
      </div>
    );
  }

  return (
    <>
      <span className="self-center text-sm text-ink-300">{label}</span>
      <span className="tnum self-center text-right font-mono text-sm text-ink-200">
        {pct(sharp)}
      </span>
      <span className="tnum self-center text-right font-mono text-sm text-ink-200">
        {pct(crowd)}
      </span>
      <span
        className="tnum self-center text-right font-mono text-sm"
        style={{ color }}
      >
        {edge !== null ? `${edge >= 0 ? "+" : ""}${edge.toFixed(1)}pp` : "—"}
      </span>
    </>
  );
}

/** Line movement over time — the consensus drifting against the crowd. */
function Sparkline({ points, n }: { points: OddsPoint[]; n: number }) {
  const withSharp = points.filter((p) => p.sharp?.length === n);
  if (withSharp.length < 2) return null;

  const W = 320;
  const H = 48;
  const t0 = withSharp[0].at;
  const t1 = withSharp[withSharp.length - 1].at;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * W;
  const y = (v: number) => H - v * H;

  const path = (pick: (p: OddsPoint) => number) =>
    withSharp
      .map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(pick(p)).toFixed(1)}`)
      .join(" ");

  // Outcome 0 only — three overlaid pairs is noise, not a signal.
  return (
    <div className="mt-5">
      <p className="label text-ink-600">Line movement · outcome 1</p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 w-full"
        preserveAspectRatio="none"
        style={{ height: 48 }}
      >
        <path
          d={path((p) => p.sharp[0])}
          fill="none"
          stroke="var(--brass-500)"
          strokeWidth="1.5"
        />
        <path
          d={path((p) => p.crowd[0])}
          fill="none"
          stroke="var(--color-ink-500)"
          strokeWidth="1.5"
          strokeDasharray="3 3"
        />
      </svg>
      <div className="mt-1 flex gap-4 font-mono text-[10px] text-ink-600">
        <span className="text-brass-500">— sharp</span>
        <span>--- crowd</span>
      </div>
    </div>
  );
}
