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
    status: m.status,
    proofStatus: f.proofStatus,
    gapReason: f.gapReason,
    outcomes: OUTCOME_LABELS,
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

export async function listMarkets(q: {
  stage?: string;
  status?: string;
  proofStatus?: string;
  limit: number;
  offset: number;
  sort: "kickoff" | "-kickoff";
}): Promise<Paginated<MarketView>> {
  const where: any = {};
  if (q.status) where.status = q.status as DbMarketStatus;
  if (q.stage) where.fixture = { ...(where.fixture ?? {}), stage: q.stage };
  if (q.proofStatus)
    where.fixture = {
      ...(where.fixture ?? {}),
      proofStatus: q.proofStatus as DbProofStatus,
    };

  const [total, rows] = await Promise.all([
    prisma.market.count({ where }),
    prisma.market.findMany({
      where,
      include: { fixture: { include: fixtureInclude } },
      orderBy: {
        fixture: { kickoffTs: q.sort === "-kickoff" ? "desc" : "asc" },
      },
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
  limit: number;
  offset: number;
}): Promise<Paginated<ReceiptView>> {
  const where: any = {};
  if (q.stage) where.market = { fixture: { stage: q.stage } };

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
      outcomeLabel: OUTCOME_LABELS[p.outcomeIndex] ?? String(p.outcomeIndex),
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
      markets: { select: { pda: true, status: true, winningOutcome: true } },
    },
    orderBy: { kickoffTs: "asc" },
  });

  const byStage = new Map<string, BracketTie[]>();
  for (const f of fixtures) {
    const home = teamRef(f.homeTeam, f.homeName);
    const away = teamRef(f.awayTeam, f.awayName);
    const market = f.markets[0];
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
