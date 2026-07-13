/**
 * SHARP vs CROWD — ingest TxLINE's consensus odds alongside our own pools.
 *
 * This is a SECOND TxLINE feed, entirely separate from the scores feed that
 * settles markets. It never touches settlement: no proof, no predicate, no
 * receipt is influenced by a price. It exists purely to answer "what does the
 * market think, and how does that differ from what the crowd here thinks?".
 *
 * ── What the feed actually gives us (measured, not assumed) ─────────────────
 *
 *   GET /api/odds/snapshot/{fixtureId}  ->
 *     [{ FixtureId, Bookmaker: "TXLineStablePriceDemargined", BookmakerId: 10021,
 *        SuperOddsType: "1X2_PARTICIPANT_RESULT", MarketPeriod: "half=1",
 *        PriceNames: ["part1","draw","part2"],
 *        Prices: [3189, 2262, 4091],          // decimal odds x1000
 *        Pct:    ["31.358","44.209","24.444"] // implied %, ALREADY DEMARGINED
 *        GameState, InRunning, Ts, ... }]
 *
 * DEMARGINED is the important word. The implied probabilities sum to ~1.0001,
 * i.e. the bookmaker's overround has been stripped out — so these are true
 * consensus probabilities, not padded prices. That is what makes a divergence
 * against the crowd meaningful rather than an artefact of the vig.
 *
 * ── The honest caveats ─────────────────────────────────────────────────────
 *
 * TxLINE publishes odds only from roughly a day before kickoff and purges them
 * afterwards. A finished fixture returns []. So the consensus series exists for
 * upcoming matches and NOT for the backfilled wall — and where it does not
 * exist, we store nothing and show nothing. We never invent a consensus line.
 */
import { Logger } from "../logger";
import type { TxLineClient } from "../txline/client";

const log = new Logger("odds");

/** The demargined consensus book. Anything else is a raw, marginned price. */
export const CONSENSUS_BOOKMAKER = /Demargined/i;

export interface Consensus {
  /** Implied probability per outcome, aligned to the MARKET's outcome order. */
  pct: number[];
  bookmaker: string;
  /** TxLINE's timestamp for the tick (ms). */
  ts: number;
}

interface OddsRow {
  FixtureId: number;
  Bookmaker: string;
  SuperOddsType: string;
  MarketPeriod?: string | null;
  MarketParameters?: string | null;
  PriceNames: string[];
  Prices: number[];
  Pct?: string[] | null;
  Ts: number;
  InRunning?: boolean;
}

/**
 * Map TxLINE's 1X2 consensus onto a ProofBook market's outcome order.
 *
 * Only the 1X2 market has a clean, unambiguous mapping today:
 *   part1 -> Home, draw -> Draw, part2 -> Away
 *
 * Other SuperOddsTypes (Asian handicap, etc.) do not line up with our outcome
 * sets, and guessing an alignment would produce a divergence number that looks
 * authoritative and means nothing. So we map what maps, and return null for the
 * rest — a market with no consensus simply shows the crowd, and says so.
 */
export function consensusFor1x2(rows: OddsRow[]): Consensus | null {
  const row = rows
    .filter(
      (r) =>
        r.SuperOddsType === "1X2_PARTICIPANT_RESULT" &&
        CONSENSUS_BOOKMAKER.test(r.Bookmaker) &&
        Array.isArray(r.Prices) &&
        r.Prices.length === 3
    )
    // Latest tick wins.
    .sort((a, b) => b.Ts - a.Ts)[0];
  if (!row) return null;

  const idx = (n: string) => row.PriceNames.indexOf(n);
  const [h, d, a] = [idx("part1"), idx("draw"), idx("part2")];
  if (h < 0 || d < 0 || a < 0) return null;

  // Prefer TxLINE's own Pct (already demargined). Fall back to 1/decimal, then
  // normalise — if the sum is far from 1 the book was NOT demargined and the
  // number would be a price, not a probability, so refuse it.
  let pct: number[];
  if (row.Pct && row.Pct.length === 3) {
    pct = [h, d, a].map((i) => Number(row.Pct![i]) / 100);
  } else {
    const dec = [h, d, a].map((i) => row.Prices[i] / 1000);
    pct = dec.map((x) => 1 / x);
  }

  const sum = pct.reduce((x, y) => x + y, 0);
  if (!Number.isFinite(sum) || sum < 0.9 || sum > 1.15) {
    log.warn("consensus rejected — implied probabilities do not sum to ~1", {
      sum,
      bookmaker: row.Bookmaker,
    });
    return null;
  }
  // Tiny residual rounding only.
  pct = pct.map((p) => p / sum);

  return { pct, bookmaker: row.Bookmaker, ts: row.Ts };
}

/** Fetch the consensus for a fixture, or null if TxLINE publishes none. */
export async function fetchConsensus(
  client: TxLineClient,
  fixtureId: number
): Promise<Consensus | null> {
  try {
    const rows = await client.oddsSnapshot(fixtureId);
    if (!rows.length) return null; // no odds yet, or already purged
    return consensusFor1x2(rows);
  } catch (e: any) {
    log.warn("odds fetch failed", { fixtureId, error: e?.message });
    return null;
  }
}

/** The crowd's opinion: our own parimutuel pools, as probabilities. */
export function crowdImplied(pools: bigint[] | number[]): number[] {
  const p = pools.map(Number);
  const total = p.reduce((a, b) => a + b, 0);
  if (total <= 0) return p.map(() => 0);
  return p.map((x) => x / total);
}

/**
 * The edge signal: how far the crowd is from the consensus, per outcome.
 * Positive means the crowd rates this outcome HIGHER than the sharps do.
 */
export function divergence(crowd: number[], sharp: number[]): number[] {
  return crowd.map((c, i) => c - (sharp[i] ?? 0));
}
