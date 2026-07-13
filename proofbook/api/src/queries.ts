/**
 * Every read path. Rules:
 *   · one indexed Postgres query per request — no N+1, no per-request chain reads
 *   · the shapes here are exactly the contracts in contracts.ts
 *   · nothing is inferred that we cannot prove: an unprovable fixture never gets a
 *     scoreline, never gets a winner, and never contributes to a table
 */
import {
  prisma,
  MarketStatus as DbMarketStatus,
  ProofStatus as DbProofStatus,
} from "../../db/src/client";
import { marketInfo, outcomeLabels } from "../../shared/markets";
import type {
  MarketView,
  ReceiptView,
  PositionView,
  GroupView,
  BracketRound,
  BracketTie,
  TeamRef,
  KeeperStatus,
  Paginated,
} from "./contracts";

export const OUTCOME_LABELS = ["Home", "Draw", "Away"];
const KO_ORDER = ["R32", "R16", "QF", "SF", "3rd", "Final"];

/** The keeper is considered dead if it hasn't checked in for this long. */
export const KEEPER_STALE_SEC = 90;

const unknownTeam = (name: string): TeamRef => ({
  code: "?",
  name: name || "Unknown",
  iso: "",
  chip: null,
  unknown: true,
});

type FixtureWithTeams = {
  id: number;
  homeName: string;
  awayName: string;
  stage: string;
  kickoffTs: Date;
  proofStatus: DbProofStatus;
  gapReason: string | null;
  statusId: number | null;
  provenP1: number | null;
  provenP2: number | null;
  lastSeq: number | null;
  homeTeam: { code: string; name: string; iso: string; chip: string } | null;
  awayTeam: { code: string; name: string; iso: string; chip: string } | null;
};

const teamRef = (
  t: { code: string; name: string; iso: string; chip: string } | null,
  fallbackName: string
): TeamRef =>
  t
    ? { code: t.code, name: t.name, iso: t.iso, chip: t.chip, unknown: false }
    : unknownTeam(fallbackName);

const fixtureInclude = {
  homeTeam: { select: { code: true, name: true, iso: true, chip: true } },
  awayTeam: { select: { code: true, name: true, iso: true, chip: true } },
} as const;

const sec = (d: Date | null | undefined) =>
  d ? Math.floor(d.getTime() / 1000) : null;

// ── markets ───────────────────────────────────────────────────────────────────

function toMarketView(m: any): MarketView {
  const f: FixtureWithTeams = m.fixture;
  const info = marketInfo(m.marketType);
  const home = teamRef(f.homeTeam, f.homeName);
  const away = teamRef(f.awayTeam, f.awayName);
  const pools: string[] = m.pools.map((p: bigint) => p.toString());
  const total = Number(m.totalPool);

  // A score is only ever shown when the proof attests it.
  const proven = f.proofStatus === DbProofStatus.proven;
  const score =
    proven && f.provenP1 !== null && f.provenP2 !== null
      ? { p1: f.provenP1, p2: f.provenP2 }
      : null;

  return {
    marketPda: m.pda,
    fixtureId: f.id,
    fixtureName: `${home.unknown ? f.homeName : home.name} v ${
      away.unknown ? f.awayName : away.name
    }`,
    home,
    away,
    stage: f.stage,
    kickoffTs: sec(f.kickoffTs)!,
    marketType: m.marketType,
    marketName: info.name,
    marketSlug: info.slug,
    isParlay: !!info.parlay,
    status: m.status,
    proofStatus: f.proofStatus,
    gapReason: f.gapReason,
    // Labels come from the market-type registry, NOT a hardcoded 1X2 list. A
    // two-way Over/Under was rendering a phantom "Draw" and a missing third pool.
    outcomes: outcomeLabels(m.marketType, m.pools.length),
    pools,
    totalPool: m.totalPool.toString(),
    crowdImplied: m.pools.map((p: bigint) =>
      total > 0 ? Number(p) / total : null
    ),
    feeBps: m.feeBps,
    lockTime: sec(m.lockTime)!,
    resolutionTimeout: m.resolutionTimeout,
    winningOutcome: m.winningOutcome,
    oracleProgram: m.oracleProgram,
    usdcMint: m.usdcMint,
    vault: m.vault,
    authority: m.authority,
    txs: {
      created: m.createdTx,
      locked: m.lockTx,
      settled: m.settleTx,
      cancelled: m.cancelTx,
    },
    live: { score, statusId: f.statusId, lastSeq: f.lastSeq },
  };
}

/** Parse "36,37,38" into [36,37,38]; undefined stays undefined. */
const parseTypes = (t?: string): number[] | undefined =>
  t
    ? t
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n))
    : undefined;

export async function listMarkets(q: {
  stage?: string;
  status?: string;
  proofStatus?: string;
  marketType?: string;
  fixtureId?: number;
  limit: number;
  offset: number;
  sort: "kickoff" | "-kickoff" | "pool" | "-settled";
}): Promise<Paginated<MarketView>> {
  const where: any = {};
  if (q.status) where.status = q.status as DbMarketStatus;
  if (q.fixtureId) where.fixtureId = q.fixtureId;
  const types = parseTypes(q.marketType);
  if (types?.length) where.marketType = { in: types };
  if (q.stage) where.fixture = { ...(where.fixture ?? {}), stage: q.stage };
  if (q.proofStatus)
    where.fixture = {
      ...(where.fixture ?? {}),
      proofStatus: q.proofStatus as DbProofStatus,
    };

  const orderBy: any =
    q.sort === "pool"
      ? { totalPool: "desc" }
      : q.sort === "-settled"
        ? { settledAt: "desc" }
        : { fixture: { kickoffTs: q.sort === "-kickoff" ? "desc" : "asc" } };

  const [total, rows] = await Promise.all([
    prisma.market.count({ where }),
    prisma.market.findMany({
      where,
      include: { fixture: { include: fixtureInclude } },
      orderBy,
      take: q.limit,
      skip: q.offset,
    }),
  ]);

  return {
    items: rows.map(toMarketView),
    total,
    limit: q.limit,
    offset: q.offset,
    hasMore: q.offset + rows.length < total,
  };
}

export async function getMarket(pda: string): Promise<MarketView | null> {
  const m = await prisma.market.findUnique({
    where: { pda },
    include: { fixture: { include: fixtureInclude } },
  });
  return m ? toMarketView(m) : null;
}

// ── receipts ──────────────────────────────────────────────────────────────────

function toReceiptView(r: any): ReceiptView {
  const f: FixtureWithTeams = r.market.fixture;
  const home = teamRef(f.homeTeam, f.homeName);
  const away = teamRef(f.awayTeam, f.awayName);
  return {
    marketPda: r.marketPda,
    matchId: r.fixtureId,
    fixtureName: `${home.name} v ${away.name}`,
    home,
    away,
    stage: f.stage,
    marketType: r.market.marketType,
    marketName: marketInfo(r.market.marketType).name,
    isParlay: !!marketInfo(r.market.marketType).parlay,
    statKeys: marketInfo(r.market.marketType).statKeys ?? [],
    winningOutcome: r.winningOutcome,
    outcomeLabel: r.outcomeLabel,
    provenScore:
      r.provenP1 !== null && r.provenP2 !== null
        ? { p1: r.provenP1, p2: r.provenP2 }
        : null,
    statPeriod: r.statPeriod,
    oracleProgram: r.oracleProgram,
    epochDay: r.epochDay,
    dailyRootsPda: r.dailyRootsPda,
    proofRef: r.proofRef,
    resolver: r.resolver,
    settleTx: r.settleTx,
    settledAt: sec(r.settledAt)!,
    totalPool: r.totalPool.toString(),
    totalWinningPool: r.totalWinningPool.toString(),
    feeAmount: r.feeAmount.toString(),
  };
}

const receiptInclude = {
  market: { include: { fixture: { include: fixtureInclude } } },
} as const;

export async function listReceipts(q: {
  stage?: string;
  marketType?: string;
  fixtureId?: number;
  limit: number;
  offset: number;
}): Promise<Paginated<ReceiptView>> {
  const where: any = {};
  if (q.stage) where.market = { fixture: { stage: q.stage } };
  if (q.fixtureId) where.fixtureId = q.fixtureId;
  const types = parseTypes(q.marketType);
  if (types?.length)
    where.market = { ...(where.market ?? {}), marketType: { in: types } };

  const [total, rows] = await Promise.all([
    prisma.receipt.count({ where }),
    prisma.receipt.findMany({
      where,
      include: receiptInclude,
      orderBy: { settledAt: "desc" },
      take: q.limit,
      skip: q.offset,
    }),
  ]);

  return {
    items: rows.map(toReceiptView),
    total,
    limit: q.limit,
    offset: q.offset,
    hasMore: q.offset + rows.length < total,
  };
}

export async function getReceipt(
  marketPda: string
): Promise<ReceiptView | null> {
  const r = await prisma.receipt.findUnique({
    where: { marketPda },
    include: receiptInclude,
  });
  return r ? toReceiptView(r) : null;
}

// ── positions ─────────────────────────────────────────────────────────────────

/**
 * Parimutuel payout, mirroring the on-chain math exactly (u128 intermediate, fee
 * off the LOSING pool only, floor division). The UI shows what the program will
 * actually pay — not a rounded-up guess that leaves a judge short.
 */
function projectPayout(
  stake: bigint,
  totalPool: bigint,
  winningPool: bigint,
  feeBps: number
): bigint {
  if (winningPool <= 0n) return 0n;
  const losing = totalPool - winningPool;
  const fee = (losing * BigInt(feeBps)) / 10_000n;
  const distributable = totalPool - fee;
  return (stake * distributable) / winningPool;
}

export async function listPositions(owner: string): Promise<PositionView[]> {
  const rows = await prisma.position.findMany({
    where: { owner },
    include: { market: { include: { fixture: { include: fixtureInclude } } } },
    orderBy: { updatedAt: "desc" },
  });

  return rows.map((p) => {
    const m = p.market;
    const f: FixtureWithTeams = m.fixture as any;
    const home = teamRef(f.homeTeam, f.homeName);
    const away = teamRef(f.awayTeam, f.awayName);

    let claimable: PositionView["claimable"] = "pending";
    let payout: bigint | null = null;

    if (p.claimed) {
      claimable = "lost"; // nothing left to do; the UI renders it as settled
    } else if (m.status === DbMarketStatus.settled) {
      if (m.winningOutcome === p.outcomeIndex) {
        claimable = "winnings";
        payout = projectPayout(
          p.amount,
          m.totalPool,
          m.totalWinningPool ?? m.pools[p.outcomeIndex] ?? 0n,
          m.feeBps
        );
      } else {
        claimable = "lost";
      }
    } else if (m.status === DbMarketStatus.cancelled) {
      claimable = "refund";
      payout = p.amount; // a refund returns the stake exactly
    }

    return {
      position: p.pda,
      market: p.marketPda,
      fixtureId: f.id,
      fixtureName: `${home.name} v ${away.name}`,
      outcomeIndex: p.outcomeIndex,
      // The label depends on the MARKET TYPE. "Draw" on an Over/Under position
      // is not a cosmetic slip — it tells a user they backed something they did not.
      outcomeLabel: outcomeLabels(m.marketType, m.pools.length)[p.outcomeIndex] ??
        `Outcome ${p.outcomeIndex + 1}`,
      amount: p.amount.toString(),
      claimed: p.claimed,
      marketStatus: m.status,
      winningOutcome: m.winningOutcome,
      claimable,
      payout: payout === null ? null : payout.toString(),
    };
  });
}

// ── standings ─────────────────────────────────────────────────────────────────

/**
 * Group tables, from PROVEN results only.
 *
 * Groups are derived from the fixture graph itself — in the group stage a team
 * only plays teams in its own group, so the groups fall out as connected
 * components of "who played whom". No group table is typed in by hand, so none
 * can be wrong. Unprovable matches are counted as UNPLAYED; folding in a result
 * we would have had to invent would be worse than an incomplete table.
 */
export async function getStandings(): Promise<GroupView[]> {
  const fixtures = await prisma.fixture.findMany({
    where: { stage: "Group" },
    include: fixtureInclude,
  });

  const resolved = fixtures.filter((f) => f.homeTeam && f.awayTeam);

  // connected components over the group-stage fixture graph
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const f of resolved) {
    link(f.homeTeam!.code, f.awayTeam!.code);
    link(f.awayTeam!.code, f.homeTeam!.code);
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const code of adj.keys()) {
    if (seen.has(code)) continue;
    const stack = [code];
    const comp: string[] = [];
    seen.add(code);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of adj.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    components.push(comp.sort());
  }
  components.sort((a, b) => a[0].localeCompare(b[0]));

  return components.map((codes, i) => {
    const members = new Set(codes);
    const matches = resolved.filter(
      (f) => members.has(f.homeTeam!.code) && members.has(f.awayTeam!.code)
    );

    const rows = new Map<string, any>();
    const rowFor = (t: any) => {
      if (!rows.has(t.code)) {
        rows.set(t.code, {
          team: teamRef(t, t.name),
          played: 0,
          won: 0,
          drawn: 0,
          lost: 0,
          gf: 0,
          ga: 0,
          gd: 0,
          points: 0,
        });
      }
      return rows.get(t.code)!;
    };
    for (const f of matches) {
      rowFor(f.homeTeam);
      rowFor(f.awayTeam);
    }

    for (const f of matches) {
      // Unprovable => counted as unplayed. This is the honest line.
      if (
        f.proofStatus !== DbProofStatus.proven ||
        f.provenP1 === null ||
        f.provenP2 === null
      )
        continue;
      const h = rowFor(f.homeTeam);
      const a = rowFor(f.awayTeam);
      const p1 = f.provenP1,
        p2 = f.provenP2;
      h.played++;
      a.played++;
      h.gf += p1;
      h.ga += p2;
      a.gf += p2;
      a.ga += p1;
      if (p1 > p2) {
        h.won++;
        h.points += 3;
        a.lost++;
      } else if (p1 < p2) {
        a.won++;
        a.points += 3;
        h.lost++;
      } else {
        h.drawn++;
        a.drawn++;
        h.points++;
        a.points++;
      }
    }

    const list = [...rows.values()];
    for (const r of list) r.gd = r.gf - r.ga;
    list.sort(
      (x, y) =>
        y.points - x.points ||
        y.gd - x.gd ||
        y.gf - x.gf ||
        x.team.code.localeCompare(y.team.code)
    );

    return {
      label: `Group ${String.fromCharCode(65 + i)}`,
      rows: list,
      provenCount: matches.filter((f) => f.proofStatus === DbProofStatus.proven)
        .length,
      totalCount: matches.length,
    };
  });
}

// ── bracket ───────────────────────────────────────────────────────────────────

export async function getBracket(): Promise<BracketRound[]> {
  const fixtures = await prisma.fixture.findMany({
    where: { stage: { in: KO_ORDER } },
    include: {
      ...fixtureInclude,
      markets: {
        select: { pda: true, status: true, winningOutcome: true, marketType: true },
      },
    },
    orderBy: { kickoffTs: "asc" },
  });

  // The RESULT lives in the 1X2 market. `markets[0]` was an arbitrary pick —
  // fine when a fixture had one market, wrong now that it has a dozen: a corners
  // Over/Under's winningOutcome=0 means "Over", and reading it as "home won"
  // would put the wrong team through the bracket.
  const RESULT_TYPES = new Set([3, 4, 28]);

  const byStage = new Map<string, BracketTie[]>();
  for (const f of fixtures) {
    const home = teamRef(f.homeTeam, f.homeName);
    const away = teamRef(f.awayTeam, f.awayName);
    const oneXtwo = f.markets.filter((m) => RESULT_TYPES.has(m.marketType));
    const market =
      oneXtwo.find((m) => m.status === DbMarketStatus.settled) ?? oneXtwo[0];
    const proven =
      f.proofStatus === DbProofStatus.proven &&
      f.provenP1 !== null &&
      f.provenP2 !== null;

    // A winner is only ever claimed for a proven tie.
    let winner: string | null = null;
    if (
      proven &&
      market?.winningOutcome !== null &&
      market?.winningOutcome !== undefined
    ) {
      if (market.winningOutcome === 0) winner = home.code;
      else if (market.winningOutcome === 2) winner = away.code;
    }

    const tie: BracketTie = {
      marketPda: market?.pda ?? null,
      fixtureId: f.id,
      stage: f.stage,
      kickoffTs: sec(f.kickoffTs)!,
      home,
      away,
      score: proven ? { p1: f.provenP1!, p2: f.provenP2! } : null,
      proven,
      gap: f.proofStatus === DbProofStatus.no_proof,
      winner,
    };
    if (!byStage.has(f.stage)) byStage.set(f.stage, []);
    byStage.get(f.stage)!.push(tie);
  }

  return KO_ORDER.filter((s) => byStage.has(s)).map((stage) => ({
    stage,
    ties: byStage.get(stage)!,
  }));
}

// ── keeper status ─────────────────────────────────────────────────────────────

export async function getKeeperStatus(): Promise<KeeperStatus> {
  const run = await prisma.keeperRun.findFirst({
    where: { isLeader: true },
    orderBy: { lastHeartbeat: "desc" },
  });

  if (!run) {
    return {
      alive: false,
      instance: null,
      mode: null,
      streamConnected: false,
      startedAt: null,
      lastHeartbeat: null,
      heartbeatAgeSec: null,
      lastEventAt: null,
      lastSettlementAt: null,
      marketsSettled: 0,
      lastError: "no keeper has ever checked in",
    };
  }

  const ageSec = Math.floor((Date.now() - run.lastHeartbeat.getTime()) / 1000);
  return {
    alive: ageSec <= KEEPER_STALE_SEC,
    instance: run.instance,
    mode: run.mode,
    streamConnected: run.streamConnected,
    startedAt: sec(run.startedAt),
    lastHeartbeat: sec(run.lastHeartbeat),
    heartbeatAgeSec: ageSec,
    lastEventAt: sec(run.lastEventAt),
    lastSettlementAt: sec(run.lastSettlementAt),
    marketsSettled: run.marketsSettled,
    lastError: run.lastError,
  };
}

export async function getCounts() {
  const [fixtures, markets, settled, receipts, gaps] = await Promise.all([
    prisma.fixture.count(),
    prisma.market.count(),
    prisma.market.count({ where: { status: DbMarketStatus.settled } }),
    prisma.receipt.count(),
    prisma.fixture.count({ where: { proofStatus: DbProofStatus.no_proof } }),
  ]);
  return { fixtures, markets, settled, receipts, gaps };
}

export async function getFixtureLive(id: number) {
  const f = await prisma.fixture.findUnique({
    where: { id },
    include: fixtureInclude,
  });
  if (!f) return null;
  const proven = f.proofStatus === DbProofStatus.proven;
  return {
    fixtureId: f.id,
    name: `${f.homeTeam?.name ?? f.homeName} v ${
      f.awayTeam?.name ?? f.awayName
    }`,
    kickoffTs: sec(f.kickoffTs),
    statusId: f.statusId,
    // Never a scoreline we cannot prove.
    score:
      proven && f.provenP1 !== null ? { p1: f.provenP1, p2: f.provenP2 } : null,
    lastSeq: f.lastSeq,
    proofStatus: f.proofStatus,
    gapReason: f.gapReason,
  };
}

/**
 * The settlement archive: the full, ordered event timeline for one fixture —
 * every score update, every market transition, and the receipt itself.
 *
 * This exists because a live settlement happens exactly once, at whatever hour
 * the match happens to finish. `feed_events` already captures it; without a read
 * path the moment is recorded and then unreachable. Replaying this timeline
 * reproduces the settlement after the fact, from the same rows the live SSE
 * stream served — no re-enactment, no reconstruction.
 */
export async function getArchive(fixtureId: number): Promise<ArchiveView | null> {
  const fixture = await prisma.fixture.findUnique({
    where: { id: fixtureId },
    include: fixtureInclude,
  });
  if (!fixture) return null;

  const events = await prisma.feedEvent.findMany({
    where: { fixtureId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      type: true,
      seq: true,
      marketPda: true,
      payload: true,
      createdAt: true,
    },
  });

  const settledAt = events.find((e) => e.type === "receipt")?.createdAt ?? null;
  return {
    fixtureId,
    name: `${fixture.homeTeam?.name ?? fixture.homeName} v ${
      fixture.awayTeam?.name ?? fixture.awayName
    }`,
    kickoffTs: sec(fixture.kickoffTs),
    settledAt: settledAt ? sec(settledAt) : null,
    events: events.map((e) => ({
      id: e.id.toString(),
      type: e.type,
      seq: e.seq,
      marketPda: e.marketPda,
      at: sec(e.createdAt),
      payload: e.payload as unknown,
    })),
  };
}

export interface ArchiveEvent {
  id: string;
  type: string;
  seq: number | null;
  marketPda: string | null;
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

/**
 * The TxLINE read credential the browser-side verifier needs.
 *
 * The keeper obtains these by subscribing on-chain (free World-Cup tier) and
 * mirrors them into `kv`. A browser cannot mint them for itself — `/auth/guest/start`
 * yields a JWT, but the proof endpoint answers "Missing API token" without the
 * subscription token too.
 *
 * Handing this out does not make the verifier trust us: the proof it fetches is
 * checked against a Merkle root read straight from Solana, by TxLINE's own
 * on-chain program. A forged proof cannot pass.
 */
export async function getTxlineCredential(): Promise<{
  origin: string;
  jwt: string;
  apiToken: string;
} | null> {
  const rows = await prisma.keyValue.findMany({
    where: { key: { in: ["txlineJwt", "txlineApiToken"] } },
  });
  const jwt = rows.find((r) => r.key === "txlineJwt")?.value;
  const apiToken = rows.find((r) => r.key === "txlineApiToken")?.value;
  if (!jwt || !apiToken) return null;
  return {
    origin: process.env.TXLINE_API ?? "https://txline-dev.txodds.com",
    jwt,
    apiToken,
  };
}

// ── the headline stat: receipts BY MARKET TYPE ───────────────────────────────

import type { ReceiptSummary } from "../../shared/contracts";
export type { ReceiptSummary };

export async function getReceiptSummary(): Promise<ReceiptSummary> {
  const [total, fixturesCovered, gaps] = await Promise.all([
    prisma.receipt.count(),
    prisma.receipt
      .findMany({ distinct: ["fixtureId"], select: { fixtureId: true } })
      .then((r) => r.length),
    prisma.fixture.count({ where: { proofStatus: DbProofStatus.no_proof } }),
  ]);

  // Prisma's groupBy cannot group by a related column, so the by-type rollup is
  // one raw GROUP BY over the join — a single indexed round trip at any size.
  const rows = await prisma.$queryRaw<
    { marketType: number; count: bigint }[]
  >`select m."marketType" as "marketType", count(*)::bigint as count
    from receipts r join markets m on m.pda = r."marketPda"
    group by 1 order by 1`;

  return {
    total,
    byType: rows.map((r) => {
      const info = marketInfo(r.marketType);
      return {
        marketType: r.marketType,
        name: info.name,
        slug: info.slug,
        parlay: !!info.parlay,
        count: Number(r.count),
      };
    }),
    fixturesCovered,
    gaps,
  };
}

// ── SHARP vs CROWD ──────────────────────────────────────────────────────────

export interface OddsPoint {
  at: number;
  /** ProofBook pool-implied probability per outcome. */
  crowd: number[];
  /** TxLINE demargined consensus probability per outcome. Empty when TxLINE published none. */
  sharp: number[];
  totalPool: string;
}

export interface OddsSeries {
  marketPda: string;
  outcomes: string[];
  points: OddsPoint[];
  /** Latest crowd/sharp/divergence, or null where TxLINE has no line. */
  latest: {
    crowd: number[];
    sharp: number[] | null;
    /** crowd - sharp, in percentage points. Positive = crowd rates it higher. */
    divergence: number[] | null;
    bookmaker: string | null;
  };
  /**
   * Why there may be no sharp line. TxLINE publishes odds only around kickoff
   * and purges them afterwards, so the backfilled wall has none — and we say so
   * rather than drawing a flat line at some invented number.
   */
  note: string | null;
}

export async function getOddsSeries(pda: string): Promise<OddsSeries | null> {
  const market = await prisma.market.findUnique({
    where: { pda },
    select: { pda: true, pools: true, marketType: true },
  });
  if (!market) return null;

  const rows = await prisma.oddsSnapshot.findMany({
    where: { marketPda: pda },
    orderBy: { takenAt: "asc" },
    take: 500,
  });

  const implied = (pools: bigint[]) => {
    const p = pools.map(Number);
    const t = p.reduce((a, b) => a + b, 0);
    return t > 0 ? p.map((x) => x / t) : p.map(() => 0);
  };

  const points: OddsPoint[] = rows.map((r) => ({
    at: sec(r.takenAt),
    crowd: implied(r.pools),
    sharp: r.consensusPct ?? [],
    totalPool: r.totalPool.toString(),
  }));

  const withSharp = [...rows].reverse().find((r) => r.consensusPct?.length);
  const crowd = implied(market.pools);
  const sharp = withSharp?.consensusPct ?? null;

  return {
    marketPda: pda,
    outcomes: OUTCOME_LABELS,
    points,
    latest: {
      crowd,
      sharp,
      divergence: sharp ? crowd.map((c, i) => c - sharp[i]) : null,
      bookmaker: withSharp?.bookmaker ?? null,
    },
    note: sharp
      ? null
      : "TxLINE publishes consensus odds only around kickoff and purges them afterwards, so there is no sharp line for this market. We show the crowd only, rather than invent one.",
  };
}
