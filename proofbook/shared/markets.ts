/**
 * The market-type registry — what a `market_type` byte actually MEANS.
 *
 * On-chain, `market_type` is an opaque tag: a PDA seed and nothing more. Off
 * chain, every surface needs to know what it names — its outcome labels, its
 * title, whether it is a parlay. The API was hardcoding `["Home","Draw","Away"]`
 * for every market, so a two-way Over/Under rendered with a phantom "Draw" and a
 * missing third pool, and the match board showed the same fixture a dozen times
 * with no way to tell the markets apart.
 *
 * ZERO IMPORTS, deliberately: the web app builds with Root Directory = `web/`,
 * so anything this file imported would have to be resolvable from there too (see
 * the note atop `shared/contracts.ts`).
 *
 * The keeper's `markets/catalogue.ts` holds the PREDICATES; this holds the
 * PRESENTATION. `catalogue.ts` asserts the two agree at import, so a label here
 * can never drift away from the outcome it names.
 */

export interface MarketTypeInfo {
  type: number;
  slug: string;
  /** Full title, e.g. "Total Goals O/U 2.5". */
  name: string;
  /** Compact title for a chip, e.g. "Goals O/U". */
  short: string;
  /** Outcome labels, in on-chain outcome order. */
  outcomes: string[];
  /** True for the 2x2 parlay grids. */
  parlay?: boolean;
  /** One line explaining what is being proven. */
  blurb?: string;
  /**
   * The TxLINE stat keys this type proves (1/2 goals · 3/4 yellows · 7/8
   * corners · 1001/1002 HT goals). Fixed per type — the receipt page shows them
   * so a reader can see exactly which merkle leaves settled the market.
   */
  statKeys?: number[];
  /** Presentation group on the match page. */
  group?: "Result" | "Goals" | "Corners" | "Cards" | "Parlays";
}

/** Types 0..15 are GENERATIONS of the original 1X2 market — the first 76 receipts. */
const LEGACY_1X2 = ["Home", "Draw", "Away"];

export const MARKET_TYPES: Record<number, MarketTypeInfo> = {
  // ── legacy 1X2 generations (0-4). Do not renumber: the 76 receipts live here.
  0: t(0, "match_result_g0", "Match Result", "1X2", LEGACY_1X2),
  1: t(1, "match_result_g1", "Match Result", "1X2", LEGACY_1X2),
  2: t(2, "match_result_g2", "Match Result", "1X2", LEGACY_1X2),
  3: t(3, "match_result_g3", "Match Result", "1X2", LEGACY_1X2),
  4: t(4, "match_result_g4", "Match Result", "1X2", LEGACY_1X2),

  // ── the provable catalogue. Compound: ComboSpec + validate_stat_v3.
  //
  // GENERATION 2 (types 28-39). Generation 1 (16-27) is ABANDONED and must never
  // surface: its ComboSpecs hardcoded period=100, but 58 of the 76 provable
  // fixtures carry period=5 (TxLINE keeps the game_finalised record for only
  // ~10 days, so an older fixture's terminal record is a plain FT one). The
  // program rebuilds each merkle leaf from the spec's (key, period), so a spec
  // that says 100 against a leaf that says 5 hashes differently and the oracle
  // rejects it — InvalidStatProof (6023). The spec is immutable; those markets
  // can never settle. Devnet markets cannot be deleted, so the allowlist is the
  // only thing keeping a dead generation off the site.
  28: t(28, "match_result", "Match Result", "1X2", LEGACY_1X2,
    "Home, Draw or Away on the finalised score."),
  29: t(29, "goals_ou_25", "Total Goals O/U 2.5", "Goals O/U",
    ["Over 2.5", "Under 2.5"],
    "Both teams' goals added. Over 2.5 means 3 or more."),
  30: t(30, "corners_ou_95", "Total Corners O/U 9.5", "Corners O/U",
    ["Over 9.5", "Under 9.5"],
    "Corners are stat keys 7 and 8 — as provable as goals."),
  31: t(31, "cards_ou_35", "Total Cards O/U 3.5", "Cards O/U",
    ["Over 3.5", "Under 3.5"],
    "Yellow cards only: a Binary op combines exactly two stats, so yellows and reds cannot be summed."),
  32: t(32, "btts", "Both Teams To Score", "BTTS",
    ["Both scored", "Home only", "Away only", "Neither scored"],
    "Split four ways: 'BTTS No' is an OR, which cannot be proven — this grid says the same thing with pure ANDs."),
  33: t(33, "clean_sheet", "Clean Sheet", "Clean sheet",
    ["Home clean sheet", "Away clean sheet", "Both (0-0)", "Neither"],
    "Which side kept one — or both, or neither."),
  34: t(34, "ht_result", "Half-Time Result", "HT 1X2", LEGACY_1X2,
    "Period-scoped keys 1001/1002 — the half-time score, proven."),
  35: t(35, "winning_margin", "Winning Margin", "Margin",
    ["Home by 2+", "Home by 1", "Draw", "Away by 1", "Away by 2+"],
    "Correct Score cannot be exhaustive (an 'any other score' bucket is not provable). Margin buckets tile every possible result."),

  // ── 2x2 parlay grids. Outcome 0 IS the parlay; the rest are how it misses.
  36: parlayType(36, "parlay_win_corners", "Home win", "No home win",
    "Over 9.5 corners", "Under 9.5 corners"),
  37: parlayType(37, "parlay_corners_cards", "Over 9.5 corners", "Under 9.5 corners",
    "Over 3.5 cards", "Under 3.5 cards"),
  38: parlayType(38, "parlay_goals_cards", "Over 2.5 goals", "Under 2.5 goals",
    "Over 3.5 cards", "Under 3.5 cards"),
  39: parlayType(39, "parlay_win_cards", "Home win", "No home win",
    "Over 3.5 cards", "Under 3.5 cards"),
};

function t(
  type: number,
  slug: string,
  name: string,
  short: string,
  outcomes: string[],
  blurb?: string,
  statKeys?: number[],
  group?: MarketTypeInfo["group"]
): MarketTypeInfo {
  return { type, slug, name, short, outcomes, blurb, statKeys, group };
}

/** statKeys + match-page group per catalogue type. */
const TYPE_META: Record<number, { statKeys: number[]; group: MarketTypeInfo["group"] }> = {
  3: { statKeys: [1, 2], group: "Result" },
  4: { statKeys: [1, 2], group: "Result" },
  28: { statKeys: [1, 2], group: "Result" },
  29: { statKeys: [1, 2], group: "Goals" },
  30: { statKeys: [7, 8], group: "Corners" },
  31: { statKeys: [3, 4], group: "Cards" },
  32: { statKeys: [1, 2], group: "Goals" },
  33: { statKeys: [1, 2], group: "Goals" },
  34: { statKeys: [1001, 1002], group: "Result" },
  35: { statKeys: [1, 2], group: "Goals" },
  36: { statKeys: [1, 2, 7, 8], group: "Parlays" },
  37: { statKeys: [7, 8, 3, 4], group: "Parlays" },
  38: { statKeys: [1, 2, 3, 4], group: "Parlays" },
  39: { statKeys: [1, 2, 3, 4], group: "Parlays" },
};
for (const [t, meta] of Object.entries(TYPE_META)) {
  const info = MARKET_TYPES[Number(t)];
  if (info) {
    info.statKeys = meta.statKeys;
    info.group = meta.group;
  }
}

/**
 * A 2x2 parlay grid. The outcome ORDER must match `parlayGrid()` in the keeper's
 * catalogue: (A∧B), (A∧¬B), (¬A∧B), (¬A∧¬B).
 */
function parlayType(
  type: number,
  slug: string,
  a: string,
  notA: string,
  b: string,
  notB: string
): MarketTypeInfo {
  return {
    type,
    slug,
    name: `${a} & ${b}`,
    short: "Parlay",
    parlay: true,
    outcomes: [`${a} & ${b}`, `${a} & ${notB}`, `${notA} & ${b}`, `${notA} & ${notB}`],
    blurb:
      "Both legs proven in ONE validate_stat_v3 multiproof. The four cells are exhaustive — outcome 1 is the parlay, the rest are how it misses.",
  };
}

/** Compound markets resolve through a ComboSpec and settle via validate_stat_v3. */
export const COMBO_MARKET_TYPE_MIN = 16;
/** The LIVE catalogue generation. Generation 1 (16-27) is abandoned — see above. */
export const CATALOGUE_TYPES = [28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39];
export const isCompound = (type: number) => type >= COMBO_MARKET_TYPE_MIN;

export function marketInfo(type: number): MarketTypeInfo {
  return (
    MARKET_TYPES[type] ?? {
      type,
      slug: `type_${type}`,
      name: `Market #${type}`,
      short: `#${type}`,
      outcomes: [],
    }
  );
}

/**
 * Outcome labels for a market, sized to the pools it actually has.
 *
 * A market's pool count is the on-chain truth; a label list that disagrees with
 * it is a bug, and the safe failure is a numbered outcome rather than a
 * confidently wrong one.
 */
export function outcomeLabels(type: number, numOutcomes: number): string[] {
  const labels = marketInfo(type).outcomes;
  if (labels.length === numOutcomes) return labels;
  return Array.from({ length: numOutcomes }, (_, i) => labels[i] ?? `Outcome ${i + 1}`);
}
