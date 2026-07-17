/**
 * The API's wire contract — TYPES ONLY. No imports, no npm packages, nothing that
 * survives compilation.
 *
 * WHY THIS FILE IS SEPARATE FROM THE ZOD SCHEMAS
 * The web app is built with its Root Directory set to `web/`, so only
 * `web/node_modules` exists. Node resolves an import by walking UP from the
 * importing file, and `api/src/contracts.ts` sits at `/api/src/` — so its
 * `import "zod"` searches `api/node_modules`, then the repo root, and never looks
 * inside `web/`. zod is therefore unreachable from a Vercel build no matter which
 * of web's dependency lists it is added to. The Next build failed on exactly that.
 *
 * So the shape lives here, with zero imports, and the runtime VALIDATION (zod)
 * stays server-side in `api/src/contracts.ts`, which asserts at compile time that
 * its schemas still match these types. Drift between the two is a build error, not
 * a surprise on a judge's screen.
 *
 * Money is always a decimal STRING of base units (6dp). JSON has no BigInt, and
 * `number` silently loses precision above 2^53 — a large pool would round. Never
 * widen these to `number`.
 */

export const API_VERSION = "1";

/** u64 base units as a decimal string, e.g. "1733000000" = 1,733.00 USDC. */
export type Amount = string;

export type ProofStatus = "proven" | "no_proof" | "upcoming";
export type MarketStatus = "open" | "locked" | "settled" | "cancelled";
export type Stage = "Group" | "R32" | "R16" | "QF" | "SF" | "3rd" | "Final";

export interface TeamRef {
  code: string;
  name: string;
  iso: string;
  chip: string | null;
  /** True when TxLINE named a participant we could not resolve. Never guessed. */
  unknown: boolean;
}

export interface Score {
  p1: number;
  p2: number;
}

export interface MarketView {
  marketPda: string;
  fixtureId: number;
  fixtureName: string;
  home: TeamRef;
  away: TeamRef;
  stage: string;
  kickoffTs: number;
  marketType: number;
  /** What this market type MEANS, e.g. "Total Goals O/U 2.5". */
  marketName: string;
  marketSlug: string;
  /** True for the 2x2 parlay grids — outcome 0 is "the parlay". */
  isParlay: boolean;
  status: MarketStatus;

  /**
   * proven   — a real TxLINE merkle proof settled this market; it has a receipt
   * no_proof — outside TxLINE's retention window. Shown WITHOUT a receipt and
   *            WITHOUT a scoreline. We never fabricate either.
   * upcoming — not played yet
   */
  proofStatus: ProofStatus;
  gapReason: string | null;

  outcomes: string[];
  pools: Amount[];
  totalPool: Amount;
  /** Crowd-implied probability per outcome; null when nothing is staked. */
  crowdImplied: (number | null)[];
  feeBps: number;
  lockTime: number;
  resolutionTimeout: number;
  winningOutcome: number | null;

  oracleProgram: string;
  usdcMint: string;
  vault: string;
  authority: string;

  txs: {
    created: string | null;
    locked: string | null;
    settled: string | null;
    cancelled: string | null;
  };

  /** Only ever the PROVEN score. A live or unproven fixture has `score: null`. */
  live: {
    score: Score | null;
    statusId: number | null;
    lastSeq: number | null;
  };
}

export interface ReceiptView {
  marketPda: string;
  matchId: number;
  fixtureName: string;
  home: TeamRef;
  away: TeamRef;
  stage: string;
  /** What this market type MEANS — a corners receipt must not read as a 1X2. */
  marketType: number;
  marketName: string;
  isParlay: boolean;
  /** The TxLINE stat keys the settling proof carried. */
  statKeys: number[];

  winningOutcome: number;
  outcomeLabel: string;
  /** The goals the merkle proof attests. Absent = there is no receipt at all. */
  provenScore: Score | null;
  /** 5 = full time · 10 = after extra time · 13 = after penalties · 100 = finalised. */
  statPeriod: number | null;

  oracleProgram: string;
  epochDay: number;
  dailyRootsPda: string;
  proofRef: string;
  resolver: string;
  settleTx: string;
  settledAt: number;

  totalPool: Amount;
  totalWinningPool: Amount;
  feeAmount: Amount;
}

export interface PositionView {
  position: string;
  market: string;
  fixtureId: number;
  fixtureName: string;
  outcomeIndex: number;
  outcomeLabel: string;
  amount: Amount;
  claimed: boolean;
  marketStatus: MarketStatus;
  winningOutcome: number | null;
  /** What this position can do right now, decided server-side so the UI can't lie. */
  claimable: "winnings" | "refund" | "lost" | "pending";
  /** Projected payout for a claimable win, in base units. */
  payout: Amount | null;
}

export interface StandingsRow {
  team: TeamRef;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}

export interface GroupView {
  label: string;
  rows: StandingsRow[];
  /** How much of this group we can actually PROVE. Never hidden. */
  provenCount: number;
  totalCount: number;
}

export interface BracketTie {
  marketPda: string | null;
  fixtureId: number;
  stage: string;
  kickoffTs: number;
  home: TeamRef;
  away: TeamRef;
  score: Score | null;
  proven: boolean;
  gap: boolean;
  /** Team code — only ever set for a PROVEN tie. */
  winner: string | null;
}

export interface BracketRound {
  stage: string;
  ties: BracketTie[];
}

export interface KeeperStatus {
  alive: boolean;
  instance: string | null;
  mode: string | null;
  streamConnected: boolean;
  startedAt: number | null;
  lastHeartbeat: number | null;
  /** Seconds since the keeper last checked in. The number that matters. */
  heartbeatAgeSec: number | null;
  lastEventAt: number | null;
  lastSettlementAt: number | null;
  marketsSettled: number;
  lastError: string | null;
}

export interface HealthView {
  ok: boolean;
  version: string;
  db: boolean;
  keeper: { alive: boolean; heartbeatAgeSec: number | null };
  counts: {
    fixtures: number;
    markets: number;
    settled: number;
    receipts: number;
    gaps: number;
  };
}

export interface FaucetResult {
  ok: boolean;
  usdc: number;
  sol: number;
  mint: string;
  sig: string | null;
  /** Set when we deliberately gave nothing (already funded, or rate limited). */
  note: string | null;
}

/** The headline stat: receipts by market type. Every one is a real proof. */
export interface ReceiptSummary {
  total: number;
  byType: {
    marketType: number;
    name: string;
    slug: string;
    parlay: boolean;
    count: number;
  }[];
  fixturesCovered: number;
  /** Fixtures whose result is not provable (retention) — shown, never filled. */
  gaps: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * The recorded event timeline for one fixture — the Settlement Theater's replay
 * source. `/archive/:fixtureId` returns it. Every event is a real row the keeper
 * persisted as it happened; nothing here is synthesized.
 */
export interface ArchiveEvent {
  id: string;
  /** "score" | "market" | "receipt" */
  type: string;
  seq: number | null;
  marketPda: string | null;
  /** Unix seconds. */
  at: number;
  payload: unknown;
}

export interface ArchiveView {
  fixtureId: number;
  name: string;
  kickoffTs: number;
  /** When the settlement event landed — null if this fixture never settled. */
  settledAt: number | null;
  events: ArchiveEvent[];
}
