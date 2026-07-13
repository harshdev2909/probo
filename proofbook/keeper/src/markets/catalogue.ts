/**
 * The provable market catalogue.
 *
 * Every market type here is expressible in TxLINE's ONLY provable stat keys:
 *
 *     1/2 = goals (P1/P2)   3/4 = yellow cards   5/6 = red cards   7/8 = corners
 *     period-scoped as (period*1000)+key;  period 100 = game_finalised
 *
 * There is no event timing on-chain and no player-level stat, so "next goal",
 * "goal before minute X" and player props are NOT provable and are not here.
 *
 * ── The three hard constraints, all confirmed LIVE against the devnet oracle ──
 * (see keeper/scripts/txline-conformance.ts, which reproduces each one)
 *
 *  1. AT MOST 5 STAT KEYS per proof. TxLINE's API rejects a 6th outright:
 *     "Parameter statKeys must contain between 1 and 5 valid keys".
 *
 *  2. EVERY PROVEN STAT MUST BE EVALUATED EXACTLY ONCE by the strategy.
 *     Evaluating one twice errors DuplicateStatCoverage (6070); leaving one
 *     unevaluated errors IncompleteStatCoverage (6071).
 *
 *  3. Therefore PARLAY LEGS MUST READ DISJOINT STATS. This is the big one, and
 *     it is counter-intuitive: "Home win AND over 2.5 goals" is NOT expressible,
 *     because both legs read goals P1/P2 and the second read is a duplicate.
 *     "Over 9.5 corners AND under 3.5 cards" IS expressible — corners {7,8} and
 *     yellows {3,4} are disjoint families. Legality is a property of which stat
 *     FAMILIES a combo touches, which is what `STAT_FAMILY` below encodes.
 *
 * ── Why every outcome set is EXHAUSTIVE ──
 *
 * An outcome is an AND of predicates. There is no OR and no negation, so the
 * complement of "A AND B" — which is "(not A) OR (not B)" — cannot be written as
 * a single outcome. A two-way Hit/Miss parlay is therefore NOT exhaustive: if it
 * misses in the wrong way, no outcome is provable, the market can never settle,
 * and it rides the cancel backstop to a refund.
 *
 * So a parlay is a 2x2 GRID over its two conditions:
 *
 *     A ∧ B      <- "the parlay"
 *     A ∧ ¬B
 *     ¬A ∧ B
 *     ¬A ∧ ¬B
 *
 * Every cell is a pure AND, every cell is provable, and together they cover every
 * possible world. Each condition's negation must itself be expressible, which is
 * why the conditions below are always built from a comparison and its exact
 * complement (`> t` negates to `< t+1` on integers).
 */

export type Comparison = { greaterThan: {} } | { lessThan: {} } | { equalTo: {} };
export type BinaryExpression = { add: {} } | { subtract: {} };

export const GT: Comparison = { greaterThan: {} };
export const LT: Comparison = { lessThan: {} };
export const EQ: Comparison = { equalTo: {} };
export const ADD: BinaryExpression = { add: {} };
export const SUB: BinaryExpression = { subtract: {} };

/** A stat this market proves: TxLINE (key, period). */
export interface Leg {
  key: number;
  period: number;
}

export type LegPredicate =
  | { single: { index: number; comparison: Comparison; threshold: number } }
  | {
      binary: {
        indexA: number;
        indexB: number;
        op: BinaryExpression;
        comparison: Comparison;
        threshold: number;
      };
    };

export const single = (
  index: number,
  comparison: Comparison,
  threshold: number
): LegPredicate => ({ single: { index, comparison, threshold } });

export const binary = (
  indexA: number,
  indexB: number,
  op: BinaryExpression,
  comparison: Comparison,
  threshold: number
): LegPredicate => ({ binary: { indexA, indexB, op, comparison, threshold } });

export interface ComboOutcome {
  label: string;
  predicates: LegPredicate[];
}

export interface MarketTypeDef {
  /** The on-chain `market_type` byte. >= 16 => resolves via ComboSpec + v3. */
  type: number;
  slug: string;
  name: string;
  /** Short line shown under the market title. */
  blurb: string;
  legs: Leg[];
  outcomes: ComboOutcome[];
  /** True for the 2x2 parlay grids — the UI renders these as a grid. */
  parlay?: boolean;
}

// ── Stat families ────────────────────────────────────────────────────────────
// Two legs may only be combined if they touch DIFFERENT families. This is the
// build-time enforcement of TxLINE's DuplicateStatCoverage rule.

export const STAT_FAMILY: Record<number, string> = {
  1: "goals",
  2: "goals",
  3: "yellows",
  4: "yellows",
  5: "reds",
  6: "reds",
  7: "corners",
  8: "corners",
  1001: "ht_goals",
  1002: "ht_goals",
  1007: "ht_corners",
  1008: "ht_corners",
};

export function familyOf(key: number): string {
  const f = STAT_FAMILY[key];
  if (!f) throw new Error(`stat key ${key} is not provable (not in keys 1-8 / period-scoped)`);
  return f;
}

// Full-game legs (period 100 = game_finalised, by ANY method).
const P = 100;
export const P1_GOALS: Leg = { key: 1, period: P };
export const P2_GOALS: Leg = { key: 2, period: P };
export const P1_YELLOW: Leg = { key: 3, period: P };
export const P2_YELLOW: Leg = { key: 4, period: P };
export const P1_CORNERS: Leg = { key: 7, period: P };
export const P2_CORNERS: Leg = { key: 8, period: P };
// Half-time goals are period-scoped in the KEY (1000 + base); the `period` field
// still carries 100, because that is what the finalised leaf commits to.
export const HT_P1_GOALS: Leg = { key: 1001, period: P };
export const HT_P2_GOALS: Leg = { key: 1002, period: P };

// ── A "condition": a predicate over some legs, plus its exact complement ──────
//
// A parlay grid needs BOTH a condition and its negation to be provable, so a
// condition always carries the complementary predicate alongside it. On integers,
// `> t` negates to `< t+1`, which is why the over/under lines are half-integers:
// "over 2.5 goals" is `> 2`, and its exact complement is `< 3`.

export interface Condition {
  label: string;
  negLabel: string;
  legs: Leg[];
  /** Built against leg indices OFFSET into the combined leg array. */
  pred: (o: number) => LegPredicate;
  neg: (o: number) => LegPredicate;
}

export const homeWin: Condition = {
  label: "Home win",
  negLabel: "No home win",
  legs: [P1_GOALS, P2_GOALS],
  pred: (o) => binary(o, o + 1, SUB, GT, 0), // P1 - P2 > 0
  neg: (o) => binary(o, o + 1, SUB, LT, 1), // P1 - P2 <= 0
};

export const overGoals = (line: number): Condition => {
  const t = Math.floor(line); // 2.5 -> over is > 2, under is < 3
  return {
    label: `Over ${line} goals`,
    negLabel: `Under ${line} goals`,
    legs: [P1_GOALS, P2_GOALS],
    pred: (o) => binary(o, o + 1, ADD, GT, t),
    neg: (o) => binary(o, o + 1, ADD, LT, t + 1),
  };
};

export const overCorners = (line: number): Condition => {
  const t = Math.floor(line);
  return {
    label: `Over ${line} corners`,
    negLabel: `Under ${line} corners`,
    legs: [P1_CORNERS, P2_CORNERS],
    pred: (o) => binary(o, o + 1, ADD, GT, t),
    neg: (o) => binary(o, o + 1, ADD, LT, t + 1),
  };
};

export const overYellows = (line: number): Condition => {
  const t = Math.floor(line);
  return {
    label: `Over ${line} cards`,
    negLabel: `Under ${line} cards`,
    legs: [P1_YELLOW, P2_YELLOW],
    pred: (o) => binary(o, o + 1, ADD, GT, t),
    neg: (o) => binary(o, o + 1, ADD, LT, t + 1),
  };
};

/**
 * Build the 2x2 exhaustive grid for two conditions.
 *
 * THROWS if the two conditions share a stat family. That is not a style rule —
 * the oracle would reject the proof with DuplicateStatCoverage (6070), so an
 * overlapping parlay is unsettleable and must never become a market. This is the
 * "reject unprovable leg combos at build time" gate.
 */
export function parlayGrid(
  type: number,
  slug: string,
  a: Condition,
  b: Condition
): MarketTypeDef {
  const famA = new Set(a.legs.map((l) => familyOf(l.key)));
  const famB = new Set(b.legs.map((l) => familyOf(l.key)));
  const overlap = [...famA].filter((f) => famB.has(f));
  if (overlap.length) {
    throw new Error(
      `illegal parlay "${a.label} AND ${b.label}": both legs read the ` +
        `${overlap.join("/")} stat family. TxLINE evaluates each proven stat ` +
        `exactly once (DuplicateStatCoverage 6070), so overlapping legs can ` +
        `never be proven together. Combine DISJOINT families instead.`
    );
  }

  const legs = [...a.legs, ...b.legs];
  if (legs.length > 5) {
    throw new Error(
      `illegal parlay "${a.label} AND ${b.label}": ${legs.length} stat keys, ` +
        `but TxLINE's proof API accepts at most 5.`
    );
  }

  const oA = 0;
  const oB = a.legs.length;

  return {
    type,
    slug,
    name: `${a.label} & ${b.label}`,
    blurb: `Both must land. Settled by proving all ${legs.length} stats in ONE validate_stat_v3 multiproof.`,
    legs,
    parlay: true,
    outcomes: [
      // Outcome 0 IS the parlay. The other three are the ways it misses — and
      // each is provable, which is what makes the market exhaustive.
      {
        label: `${a.label} & ${b.label}`,
        predicates: [a.pred(oA), b.pred(oB)],
      },
      {
        label: `${a.label} & ${b.negLabel}`,
        predicates: [a.pred(oA), b.neg(oB)],
      },
      {
        label: `${a.negLabel} & ${b.label}`,
        predicates: [a.neg(oA), b.pred(oB)],
      },
      {
        label: `${a.negLabel} & ${b.negLabel}`,
        predicates: [a.neg(oA), b.neg(oB)],
      },
    ],
  };
}

// ── The catalogue ────────────────────────────────────────────────────────────
// Market types >= 16 are compound (ComboSpec + validate_stat_v3). Types 0-4 are
// the legacy 1X2 generations and are NOT touched — the 76 receipts live there.

export const CATALOGUE: MarketTypeDef[] = [
  {
    type: 28,
    slug: "match_result",
    name: "Match Result",
    blurb: "Home, Draw or Away on the finalised score.",
    legs: [P1_GOALS, P2_GOALS],
    outcomes: [
      { label: "Home", predicates: [binary(0, 1, SUB, GT, 0)] },
      { label: "Draw", predicates: [binary(0, 1, SUB, EQ, 0)] },
      { label: "Away", predicates: [binary(0, 1, SUB, LT, 0)] },
    ],
  },
  {
    type: 29,
    slug: "goals_ou_25",
    name: "Total Goals O/U 2.5",
    blurb: "Both teams' goals added. Over 2.5 means 3 or more.",
    legs: [P1_GOALS, P2_GOALS],
    outcomes: [
      { label: "Over 2.5", predicates: [binary(0, 1, ADD, GT, 2)] },
      { label: "Under 2.5", predicates: [binary(0, 1, ADD, LT, 3)] },
    ],
  },
  {
    type: 30,
    slug: "corners_ou_95",
    name: "Total Corners O/U 9.5",
    blurb: "Corners are stat keys 7 and 8 — as provable as goals.",
    legs: [P1_CORNERS, P2_CORNERS],
    outcomes: [
      { label: "Over 9.5", predicates: [binary(0, 1, ADD, GT, 9)] },
      { label: "Under 9.5", predicates: [binary(0, 1, ADD, LT, 10)] },
    ],
  },
  {
    type: 31,
    slug: "cards_ou_35",
    name: "Total Cards O/U 3.5",
    blurb:
      "Yellow cards only (keys 3/4). A Binary op combines exactly two stats, so yellows+reds cannot be summed.",
    legs: [P1_YELLOW, P2_YELLOW],
    outcomes: [
      { label: "Over 3.5", predicates: [binary(0, 1, ADD, GT, 3)] },
      { label: "Under 3.5", predicates: [binary(0, 1, ADD, LT, 4)] },
    ],
  },
  {
    // Both Teams To Score, as an EXHAUSTIVE 4-way scoring split.
    // "BTTS No" alone is (P1==0 OR P2==0) — an OR, which is not expressible. The
    // 2x2 split over (did P1 score?, did P2 score?) says the same thing and every
    // cell is a pure AND.
    type: 32,
    slug: "btts",
    name: "Both Teams To Score",
    blurb:
      "Split four ways: 'BTTS No' is an OR, which cannot be proven — this grid says the same thing with pure ANDs.",
    legs: [P1_GOALS, P2_GOALS],
    outcomes: [
      {
        label: "Both scored",
        predicates: [single(0, GT, 0), single(1, GT, 0)],
      },
      {
        label: "Home only",
        predicates: [single(0, GT, 0), single(1, EQ, 0)],
      },
      {
        label: "Away only",
        predicates: [single(0, EQ, 0), single(1, GT, 0)],
      },
      {
        label: "Neither scored",
        predicates: [single(0, EQ, 0), single(1, EQ, 0)],
      },
    ],
  },
  {
    // Clean sheet, exhaustive over which side (if any) conceded nothing.
    type: 33,
    slug: "clean_sheet",
    name: "Clean Sheet",
    blurb: "Which side kept one — or both, or neither.",
    legs: [P1_GOALS, P2_GOALS],
    outcomes: [
      {
        label: "Home clean sheet",
        predicates: [single(0, GT, 0), single(1, EQ, 0)],
      },
      {
        label: "Away clean sheet",
        predicates: [single(0, EQ, 0), single(1, GT, 0)],
      },
      {
        label: "Both (0-0)",
        predicates: [single(0, EQ, 0), single(1, EQ, 0)],
      },
      {
        label: "Neither",
        predicates: [single(0, GT, 0), single(1, GT, 0)],
      },
    ],
  },
  {
    type: 34,
    slug: "ht_result",
    name: "Half-Time Result",
    blurb: "Period-scoped keys 1001/1002 — the half-time score, proven.",
    legs: [HT_P1_GOALS, HT_P2_GOALS],
    outcomes: [
      { label: "Home", predicates: [binary(0, 1, SUB, GT, 0)] },
      { label: "Draw", predicates: [binary(0, 1, SUB, EQ, 0)] },
      { label: "Away", predicates: [binary(0, 1, SUB, LT, 0)] },
    ],
  },
  {
    // Winning margin — the honest, exhaustive alternative to Correct Score.
    // Correct Score cannot be exhaustive: an "Any other score" bucket is a
    // negation of a disjunction, which is not expressible, so a real score
    // outside the listed set would leave NO provable outcome and the market
    // could never settle. Margin buckets tile the whole integer line.
    type: 35,
    slug: "winning_margin",
    name: "Winning Margin",
    blurb:
      "Correct Score cannot be exhaustive (an 'any other score' bucket is not provable). Margin buckets tile every possible result.",
    legs: [P1_GOALS, P2_GOALS],
    outcomes: [
      { label: "Home by 2+", predicates: [binary(0, 1, SUB, GT, 1)] },
      { label: "Home by 1", predicates: [binary(0, 1, SUB, EQ, 1)] },
      { label: "Draw", predicates: [binary(0, 1, SUB, EQ, 0)] },
      { label: "Away by 1", predicates: [binary(0, 1, SUB, EQ, -1)] },
      { label: "Away by 2+", predicates: [binary(0, 1, SUB, LT, -1)] },
    ],
  },

  // ── 2x2 parlay grids — DISJOINT stat families only ──────────────────────────
  parlayGrid(36, "parlay_win_corners", homeWin, overCorners(9.5)),
  parlayGrid(37, "parlay_corners_cards", overCorners(9.5), overYellows(3.5)),
  parlayGrid(38, "parlay_goals_cards", overGoals(2.5), overYellows(3.5)),
  parlayGrid(39, "parlay_win_cards", homeWin, overYellows(3.5)),
];

export const byType = (t: number) => CATALOGUE.find((m) => m.type === t);
export const bySlug = (s: string) => CATALOGUE.find((m) => m.slug === s);

/** The statKeys string for a type's proof request, in leg order. */
export const statKeysOf = (m: MarketTypeDef) => m.legs.map((l) => l.key);

/**
 * Structural self-check, run at import. Everything here must hold or the market
 * is unsettleable — better to fail the process than to mint a market that can
 * never earn a receipt.
 */
function assertCatalogue() {
  // The API and the web read their labels from `shared/markets.ts`; the
  // predicates live here. If those two ever disagree, the site tells a user they
  // backed one thing while the chain proves another — so pin them together.
  //
  // Deliberately a runtime assert at import, not a type: the registry is
  // import-free by design (the web app builds from `web/` and cannot resolve
  // anything this file imports).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MARKET_TYPES } = require("../../../shared/markets");
  for (const m of CATALOGUE) {
    const info = MARKET_TYPES[m.type];
    if (!info)
      throw new Error(
        `market type ${m.type} (${m.slug}) is not in shared/markets.ts — the API ` +
          `would render it with no outcome labels`
      );
    if (info.slug !== m.slug)
      throw new Error(`type ${m.type}: slug "${info.slug}" != "${m.slug}"`);
    if (info.outcomes.length !== m.outcomes.length)
      throw new Error(
        `type ${m.type} (${m.slug}): registry has ${info.outcomes.length} labels, ` +
          `the catalogue has ${m.outcomes.length} outcomes`
      );
    m.outcomes.forEach((o, i) => {
      if (info.outcomes[i] !== o.label)
        throw new Error(
          `type ${m.type} (${m.slug}) outcome ${i}: registry says ` +
            `"${info.outcomes[i]}", the predicate proves "${o.label}"`
        );
    });
  }

  const seen = new Set<number>();
  for (const m of CATALOGUE) {
    if (m.type < 16) throw new Error(`${m.slug}: compound types must be >= 16`);
    if (seen.has(m.type)) throw new Error(`duplicate market_type ${m.type}`);
    seen.add(m.type);

    if (m.legs.length < 1 || m.legs.length > 5)
      throw new Error(`${m.slug}: ${m.legs.length} legs, max is 5`);
    m.legs.forEach((l) => familyOf(l.key)); // throws if not provable
    if (m.outcomes.length < 2 || m.outcomes.length > 12)
      throw new Error(`${m.slug}: ${m.outcomes.length} outcomes, must be 2..12`);

    // Every outcome must cover every leg EXACTLY once — the same invariant the
    // program enforces on-chain, checked here so a bad def never reaches a tx.
    for (const o of m.outcomes) {
      const cover = new Array(m.legs.length).fill(0);
      for (const p of o.predicates) {
        const idxs =
          "single" in p
            ? [p.single.index]
            : [p.binary.indexA, p.binary.indexB];
        for (const i of idxs) {
          if (i >= m.legs.length)
            throw new Error(`${m.slug}/${o.label}: leg index ${i} out of range`);
          cover[i]++;
        }
      }
      cover.forEach((c, i) => {
        if (c === 0)
          throw new Error(
            `${m.slug}/${o.label}: leg ${i} (key ${m.legs[i].key}) is never evaluated — TxLINE 6071`
          );
        if (c > 1)
          throw new Error(
            `${m.slug}/${o.label}: leg ${i} (key ${m.legs[i].key}) evaluated ${c}x — TxLINE 6070`
          );
      });
    }
  }
}
assertCatalogue();


/**
 * Rebind a market type's legs to the period a given fixture's proof ACTUALLY
 * carries.
 *
 * This is not a detail — it is the difference between a market that settles and
 * one that cannot.
 *
 * The `period` field on a ScoreStat says HOW the game ended: 100 = game_finalised,
 * 13 = after penalties, 10 = after extra time, 5 = full time. TxLINE keeps the
 * game_finalised record for only about ten days, so an older fixture's best
 * terminal record is a plain FT one and its stats carry period 5.
 *
 * The program rebuilds each merkle leaf from the ComboSpec's (key, period) plus
 * the proven value. If the spec says 100 and the leaf says 5, the reconstructed
 * leaf hashes differently and the oracle rejects the proof — InvalidStatProof
 * (6023). The spec is immutable, so a market created with the wrong period can
 * NEVER settle. It has to be right at creation.
 *
 * 58 of the 76 provable fixtures carry period 5. Hardcoding 100 made every one of
 * them unsettleable.
 */
export function withPeriod(def: MarketTypeDef, period: number): MarketTypeDef {
  if (!Number.isFinite(period)) {
    throw new Error(
      `refusing to build ${def.slug} with period=${period}: a market whose spec ` +
        `does not match its proof can never settle`
    );
  }
  return {
    ...def,
    legs: def.legs.map((l) => ({ ...l, period })),
  };
}
