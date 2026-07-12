/**
 * The wire contract between the API and the web app.
 *
 * This file is the ONLY definition of what the API returns. The web app imports
 * the inferred types from here, so a field the API stops sending becomes a
 * TypeScript error in the frontend instead of `undefined` on a judge's screen.
 *
 * Money is always a decimal STRING (base units, 6dp). JSON has no BigInt, and
 * `number` silently loses precision above 2^53 — a pool of 9e18 base units would
 * round. Never widen these to `number`.
 */
import { z } from "zod";

export const API_VERSION = "1";

// ── primitives ────────────────────────────────────────────────────────────────

/** u64 base units as a decimal string, e.g. "1733000000" = 1,733.00 USDC. */
export const Amount = z.string().regex(/^\d+$/);

export const TeamRef = z.object({
  code: z.string(),
  name: z.string(),
  iso: z.string(),
  chip: z.string().nullable(),
  /** True when TxLINE named a participant we could not resolve. Never guessed. */
  unknown: z.boolean(),
});

export const ProofStatus = z.enum(["proven", "no_proof", "upcoming"]);
export const MarketStatus = z.enum(["open", "locked", "settled", "cancelled"]);
export const Stage = z.enum([
  "Group",
  "R32",
  "R16",
  "QF",
  "SF",
  "3rd",
  "Final",
]);

// ── markets ───────────────────────────────────────────────────────────────────

export const MarketView = z.object({
  marketPda: z.string(),
  fixtureId: z.number(),
  fixtureName: z.string(),
  home: TeamRef,
  away: TeamRef,
  stage: z.string(),
  kickoffTs: z.number(), // unix seconds
  marketType: z.number(),
  status: MarketStatus,

  /**
   * proven   — a real TxLINE merkle proof settled this market; it has a receipt
   * no_proof — outside TxLINE's retention window. Shown WITHOUT a receipt and
   *            WITHOUT a scoreline. We never fabricate either.
   * upcoming — not played yet
   */
  proofStatus: ProofStatus,
  gapReason: z.string().nullable(),

  outcomes: z.array(z.string()), // ["Home", "Draw", "Away"]
  pools: z.array(Amount),
  totalPool: Amount,
  /** Crowd-implied probability per outcome; null when nothing is staked. */
  crowdImplied: z.array(z.number().nullable()),
  feeBps: z.number(),
  lockTime: z.number(),
  resolutionTimeout: z.number(),
  winningOutcome: z.number().nullable(),

  oracleProgram: z.string(),
  usdcMint: z.string(),
  vault: z.string(),
  authority: z.string(),

  txs: z.object({
    created: z.string().nullable(),
    locked: z.string().nullable(),
    settled: z.string().nullable(),
    cancelled: z.string().nullable(),
  }),

  /** Only ever the PROVEN score. A live/unproven fixture has `score: null`. */
  live: z.object({
    score: z.object({ p1: z.number(), p2: z.number() }).nullable(),
    statusId: z.number().nullable(),
    lastSeq: z.number().nullable(),
  }),
});

// ── receipts ──────────────────────────────────────────────────────────────────

export const ReceiptView = z.object({
  marketPda: z.string(),
  matchId: z.number(),
  fixtureName: z.string(),
  home: TeamRef,
  away: TeamRef,
  stage: z.string(),

  winningOutcome: z.number(),
  outcomeLabel: z.string(),
  /** The goals the merkle proof attests. Absent = there is no receipt at all. */
  provenScore: z.object({ p1: z.number(), p2: z.number() }).nullable(),
  /** 5 = full time · 10 = after extra time · 13 = after penalties · 100 = finalised. */
  statPeriod: z.number().nullable(),

  oracleProgram: z.string(),
  epochDay: z.number(),
  dailyRootsPda: z.string(),
  proofRef: z.string(),
  resolver: z.string(),
  settleTx: z.string(),
  settledAt: z.number(),

  totalPool: Amount,
  totalWinningPool: Amount,
  feeAmount: Amount,
});

// ── positions ─────────────────────────────────────────────────────────────────

export const PositionView = z.object({
  position: z.string(),
  market: z.string(),
  fixtureId: z.number(),
  fixtureName: z.string(),
  outcomeIndex: z.number(),
  outcomeLabel: z.string(),
  amount: Amount,
  claimed: z.boolean(),
  marketStatus: MarketStatus,
  winningOutcome: z.number().nullable(),
  /** What this position can do right now, decided server-side so the UI can't lie. */
  claimable: z.enum(["winnings", "refund", "lost", "pending"]),
  /** Projected payout for a claimable win, in base units. */
  payout: Amount.nullable(),
});

// ── standings / bracket ───────────────────────────────────────────────────────

export const StandingsRow = z.object({
  team: TeamRef,
  played: z.number(),
  won: z.number(),
  drawn: z.number(),
  lost: z.number(),
  gf: z.number(),
  ga: z.number(),
  gd: z.number(),
  points: z.number(),
});

export const GroupView = z.object({
  label: z.string(),
  rows: z.array(StandingsRow),
  /** How much of this group we can actually PROVE. Never hidden. */
  provenCount: z.number(),
  totalCount: z.number(),
});

export const BracketTie = z.object({
  marketPda: z.string().nullable(),
  fixtureId: z.number(),
  stage: z.string(),
  kickoffTs: z.number(),
  home: TeamRef,
  away: TeamRef,
  score: z.object({ p1: z.number(), p2: z.number() }).nullable(),
  proven: z.boolean(),
  gap: z.boolean(),
  winner: z.string().nullable(), // team code, only when proven
});

export const BracketRound = z.object({
  stage: z.string(),
  ties: z.array(BracketTie),
});

// ── keeper status ─────────────────────────────────────────────────────────────

export const KeeperStatus = z.object({
  alive: z.boolean(),
  instance: z.string().nullable(),
  mode: z.string().nullable(),
  streamConnected: z.boolean(),
  startedAt: z.number().nullable(),
  lastHeartbeat: z.number().nullable(),
  /** Seconds since the keeper last checked in. The number that matters. */
  heartbeatAgeSec: z.number().nullable(),
  lastEventAt: z.number().nullable(),
  lastSettlementAt: z.number().nullable(),
  marketsSettled: z.number(),
  lastError: z.string().nullable(),
});

export const HealthView = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.boolean(),
  keeper: z.object({
    alive: z.boolean(),
    heartbeatAgeSec: z.number().nullable(),
  }),
  counts: z.object({
    fixtures: z.number(),
    markets: z.number(),
    settled: z.number(),
    receipts: z.number(),
    gaps: z.number(),
  }),
});

// ── faucet ────────────────────────────────────────────────────────────────────

export const FaucetResult = z.object({
  ok: z.boolean(),
  usdc: z.number(),
  sol: z.number(),
  mint: z.string(),
  sig: z.string().nullable(),
  /** Set when we deliberately gave nothing (already funded, or rate limited). */
  note: z.string().nullable(),
});

// ── pagination ────────────────────────────────────────────────────────────────

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  });
}

/** Query params accepted by /markets. */
export const MarketQuery = z.object({
  stage: z.string().optional(),
  status: MarketStatus.optional(),
  proofStatus: ProofStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(120),
  offset: z.coerce.number().int().min(0).default(0),
  /** `kickoff` (default) or `-kickoff` for newest first. */
  sort: z.enum(["kickoff", "-kickoff"]).default("kickoff"),
});

export const ReceiptQuery = z.object({
  stage: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── inferred types (imported by the web app) ─────────────────────────────────

export type TeamRef = z.infer<typeof TeamRef>;
export type MarketView = z.infer<typeof MarketView>;
export type ReceiptView = z.infer<typeof ReceiptView>;
export type PositionView = z.infer<typeof PositionView>;
export type GroupView = z.infer<typeof GroupView>;
export type StandingsRow = z.infer<typeof StandingsRow>;
export type BracketTie = z.infer<typeof BracketTie>;
export type BracketRound = z.infer<typeof BracketRound>;
export type KeeperStatus = z.infer<typeof KeeperStatus>;
export type HealthView = z.infer<typeof HealthView>;
export type FaucetResult = z.infer<typeof FaucetResult>;
export type MarketStatus = z.infer<typeof MarketStatus>;
export type ProofStatus = z.infer<typeof ProofStatus>;
export type Paginated<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};
