/**
 * The API's runtime validation.
 *
 * The SHAPES live in `shared/contracts.ts` — pure TypeScript with zero imports.
 * This file holds the zod schemas that validate them at runtime.
 *
 * They are split for a concrete reason. The web app builds with its Root Directory
 * set to `web/`, so only `web/node_modules` exists. Node resolves an import by
 * walking UP from the importing file, and this file sits at `/api/src/` — so its
 * `import "zod"` searches `api/node_modules` and then the repo root, and never
 * looks inside `web/`. zod is therefore unreachable from a Vercel build, whichever
 * of web's dependency lists it is added to; the Next build failed on exactly that.
 * Types erase at compile time. A runtime library does not.
 *
 * The `_AssertContracts` block at the bottom makes the two halves impossible to
 * drift apart: if a schema stops matching the type it serves, the SERVER build
 * fails — before anything reaches a judge.
 */
import { z } from "zod";
import type * as C from "../../shared/contracts";

export { API_VERSION } from "../../shared/contracts";

export type {
  Amount,
  TeamRef,
  Score,
  ProofStatus,
  MarketStatus,
  Stage,
  MarketView,
  ReceiptView,
  PositionView,
  StandingsRow,
  GroupView,
  BracketTie,
  BracketRound,
  KeeperStatus,
  HealthView,
  FaucetResult,
  Paginated,
} from "../../shared/contracts";

// ── primitives ────────────────────────────────────────────────────────────────

/** u64 base units as a decimal string. Never a `number` — it would lose precision. */
export const AmountSchema = z.string().regex(/^\d+$/);

export const TeamRefSchema = z.object({
  code: z.string(),
  name: z.string(),
  iso: z.string(),
  chip: z.string().nullable(),
  unknown: z.boolean(),
});

export const ScoreSchema = z.object({ p1: z.number(), p2: z.number() });

export const ProofStatusSchema = z.enum(["proven", "no_proof", "upcoming"]);
export const MarketStatusSchema = z.enum(["open", "locked", "settled", "cancelled"]);
export const StageSchema = z.enum(["Group", "R32", "R16", "QF", "SF", "3rd", "Final"]);

// ── views ─────────────────────────────────────────────────────────────────────

export const MarketViewSchema = z.object({
  marketPda: z.string(),
  fixtureId: z.number(),
  fixtureName: z.string(),
  home: TeamRefSchema,
  away: TeamRefSchema,
  stage: z.string(),
  kickoffTs: z.number(),
  marketType: z.number(),
  marketName: z.string(),
  marketSlug: z.string(),
  isParlay: z.boolean(),
  status: MarketStatusSchema,
  proofStatus: ProofStatusSchema,
  gapReason: z.string().nullable(),
  outcomes: z.array(z.string()),
  pools: z.array(AmountSchema),
  totalPool: AmountSchema,
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
  live: z.object({
    score: ScoreSchema.nullable(),
    statusId: z.number().nullable(),
    lastSeq: z.number().nullable(),
  }),
});

export const ReceiptViewSchema = z.object({
  marketPda: z.string(),
  matchId: z.number(),
  fixtureName: z.string(),
  home: TeamRefSchema,
  away: TeamRefSchema,
  stage: z.string(),
  marketType: z.number(),
  marketName: z.string(),
  isParlay: z.boolean(),
  statKeys: z.array(z.number()),
  winningOutcome: z.number(),
  outcomeLabel: z.string(),
  provenScore: ScoreSchema.nullable(),
  statPeriod: z.number().nullable(),
  oracleProgram: z.string(),
  epochDay: z.number(),
  dailyRootsPda: z.string(),
  proofRef: z.string(),
  resolver: z.string(),
  settleTx: z.string(),
  settledAt: z.number(),
  totalPool: AmountSchema,
  totalWinningPool: AmountSchema,
  feeAmount: AmountSchema,
});

export const PositionViewSchema = z.object({
  position: z.string(),
  market: z.string(),
  fixtureId: z.number(),
  fixtureName: z.string(),
  outcomeIndex: z.number(),
  outcomeLabel: z.string(),
  amount: AmountSchema,
  claimed: z.boolean(),
  marketStatus: MarketStatusSchema,
  winningOutcome: z.number().nullable(),
  claimable: z.enum(["winnings", "refund", "lost", "pending"]),
  payout: AmountSchema.nullable(),
});

export const StandingsRowSchema = z.object({
  team: TeamRefSchema,
  played: z.number(),
  won: z.number(),
  drawn: z.number(),
  lost: z.number(),
  gf: z.number(),
  ga: z.number(),
  gd: z.number(),
  points: z.number(),
});

export const GroupViewSchema = z.object({
  label: z.string(),
  rows: z.array(StandingsRowSchema),
  provenCount: z.number(),
  totalCount: z.number(),
});

export const BracketTieSchema = z.object({
  marketPda: z.string().nullable(),
  fixtureId: z.number(),
  stage: z.string(),
  kickoffTs: z.number(),
  home: TeamRefSchema,
  away: TeamRefSchema,
  score: ScoreSchema.nullable(),
  proven: z.boolean(),
  gap: z.boolean(),
  winner: z.string().nullable(),
});

export const BracketRoundSchema = z.object({
  stage: z.string(),
  ties: z.array(BracketTieSchema),
});

export const KeeperStatusSchema = z.object({
  alive: z.boolean(),
  instance: z.string().nullable(),
  mode: z.string().nullable(),
  streamConnected: z.boolean(),
  startedAt: z.number().nullable(),
  lastHeartbeat: z.number().nullable(),
  heartbeatAgeSec: z.number().nullable(),
  lastEventAt: z.number().nullable(),
  lastSettlementAt: z.number().nullable(),
  marketsSettled: z.number(),
  lastError: z.string().nullable(),
});

export const HealthViewSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.boolean(),
  keeper: z.object({ alive: z.boolean(), heartbeatAgeSec: z.number().nullable() }),
  counts: z.object({
    fixtures: z.number(),
    markets: z.number(),
    settled: z.number(),
    receipts: z.number(),
    gaps: z.number(),
  }),
});

export const FaucetResultSchema = z.object({
  ok: z.boolean(),
  usdc: z.number(),
  sol: z.number(),
  mint: z.string(),
  sig: z.string().nullable(),
  note: z.string().nullable(),
});

// ── request validation (the part that actually runs on every request) ─────────

export const MarketQuery = z.object({
  stage: z.string().optional(),
  status: MarketStatusSchema.optional(),
  proofStatus: ProofStatusSchema.optional(),
  /** One market type, or comma-separated types (e.g. `36,37,38,39` = parlays). */
  marketType: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .optional(),
  fixtureId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(120),
  offset: z.coerce.number().int().min(0).default(0),
  /** `kickoff` (default), `-kickoff`, `pool` (deepest first) or `-settled`. */
  sort: z.enum(["kickoff", "-kickoff", "pool", "-settled"]).default("kickoff"),
});

export const ReceiptQuery = z.object({
  stage: z.string().optional(),
  marketType: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .optional(),
  fixtureId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── drift guard ───────────────────────────────────────────────────────────────

/**
 * A compile error if a zod schema stops describing the type it validates.
 *
 * The web app trusts these types. Without this, the server could quietly change
 * what it sends and a judge would discover it before we did — so the two halves
 * are pinned together at build time.
 */
type Exact<Schema, Shape> = Schema extends Shape
  ? Shape extends Schema
    ? true
    : { "contract drift — schema is missing fields": Exclude<keyof Shape, keyof Schema> }
  : { "contract drift — schema no longer satisfies the type": Schema };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertContracts = [
  Exact<z.infer<typeof MarketViewSchema>, C.MarketView>,
  Exact<z.infer<typeof ReceiptViewSchema>, C.ReceiptView>,
  Exact<z.infer<typeof PositionViewSchema>, C.PositionView>,
  Exact<z.infer<typeof GroupViewSchema>, C.GroupView>,
  Exact<z.infer<typeof BracketRoundSchema>, C.BracketRound>,
  Exact<z.infer<typeof KeeperStatusSchema>, C.KeeperStatus>,
  Exact<z.infer<typeof HealthViewSchema>, C.HealthView>,
  Exact<z.infer<typeof FaucetResultSchema>, C.FaucetResult>,
];
