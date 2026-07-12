/**
 * Postgres-backed keeper store.
 *
 * Same surface as the old JSON `Store`, so the keeper's call sites are unchanged —
 * but Postgres, not a file, is now the source of truth, and the API reads it
 * directly. The keeper keeps an in-memory mirror and writes through on every
 * change; that is safe precisely because the keeper is a SINGLE leader (see the
 * advisory lock in `leader.ts`). Two writers would corrupt this; the lock is what
 * makes it sound, not luck.
 *
 * Every mutation also appends a `feed_event` and NOTIFYs, which is how a stateless
 * API instance learns anything happened.
 */
import { prisma, CHANNEL, ProofStatus, MarketStatus } from "../../db/src/client";
import { Logger } from "./logger";
import { resolveTeam, stageOf } from "../../data/tournament";
import type {
  FixtureLive,
  MarketRecord,
  ProofReceipt,
  StoreLike,
} from "./state";

const log = new Logger("pgstore");

export class PgStore implements StoreLike {
  data: {
    fixtures: Record<string, FixtureLive>;
    markets: Record<string, MarketRecord>;
    receipts: Record<string, ProofReceipt>;
    session: { jwt?: string; apiToken?: string };
    mints: { usdcMint?: string };
  } = { fixtures: {}, markets: {}, receipts: {}, session: {}, mints: {} };

  private dirtyFixtures = new Set<number>();
  private dirtyMarkets = new Set<string>();
  private dirtyReceipts = new Set<string>();
  private dirtyKv = new Set<string>();
  private timer?: NodeJS.Timeout;
  private flushing = false;

  static async open(): Promise<PgStore> {
    const s = new PgStore();
    await s.load();
    return s;
  }

  private async load() {
    const [fixtures, markets, receipts, kv] = await Promise.all([
      prisma.fixture.findMany(),
      prisma.market.findMany(),
      prisma.receipt.findMany(),
      prisma.keyValue.findMany(),
    ]);

    for (const f of fixtures) {
      this.data.fixtures[String(f.id)] = {
        fixtureId: f.id,
        competitionId: f.competitionId ?? undefined,
        name: `${f.homeName} v ${f.awayName}`,
        homeName: f.homeName,
        awayName: f.awayName,
        stage: f.stage,
        proofStatus: f.proofStatus as FixtureLive["proofStatus"],
        gapReason: f.gapReason ?? undefined,
        kickoffTs: Math.floor(f.kickoffTs.getTime() / 1000),
        lastSeq: f.lastSeq ?? undefined,
        lastTs: f.lastTs ? Number(f.lastTs) : undefined,
        statusId: f.statusId ?? undefined,
        score:
          f.provenP1 !== null && f.provenP2 !== null
            ? { p1: f.provenP1, p2: f.provenP2 }
            : undefined,
        finalisedSeq: f.finalisedSeq ?? undefined,
      };
    }

    for (const m of markets) {
      this.data.markets[m.pda] = {
        marketPda: m.pda,
        fixtureId: m.fixtureId,
        marketType: m.marketType,
        phase:
          m.status === "open" ? "created" : (m.status as MarketRecord["phase"]),
        lockTime: Math.floor(m.lockTime.getTime() / 1000),
        resolutionTimeout: m.resolutionTimeout,
        usdcMint: m.usdcMint,
        createdTx: m.createdTx ?? undefined,
        lockTx: m.lockTx ?? undefined,
        settleTx: m.settleTx ?? undefined,
        cancelTx: m.cancelTx ?? undefined,
        winningOutcome: m.winningOutcome ?? undefined,
      };
    }

    for (const r of receipts) {
      this.data.receipts[r.marketPda] = {
        marketPda: r.marketPda,
        matchId: r.fixtureId,
        winningOutcome: r.winningOutcome,
        outcomeLabel: r.outcomeLabel,
        provenScore:
          r.provenP1 !== null && r.provenP2 !== null
            ? { p1: r.provenP1, p2: r.provenP2 }
            : undefined,
        statPeriod: r.statPeriod ?? undefined,
        oracleProgram: r.oracleProgram,
        epochDay: r.epochDay,
        dailyRootsPda: r.dailyRootsPda,
        proofRef: r.proofRef,
        resolver: r.resolver,
        settleTx: r.settleTx,
        settledAt: Math.floor(r.settledAt.getTime() / 1000),
        totalPool: r.totalPool.toString(),
        totalWinningPool: r.totalWinningPool.toString(),
        feeAmount: r.feeAmount.toString(),
      };
    }

    const kvMap = Object.fromEntries(kv.map((k) => [k.key, k.value]));
    this.data.session.jwt = kvMap.txlineJwt;
    this.data.session.apiToken = kvMap.txlineApiToken;
    this.data.mints.usdcMint = kvMap.usdcMint;

    log.info("state loaded from Postgres", {
      fixtures: fixtures.length,
      markets: markets.length,
      receipts: receipts.length,
    });
  }

  fixture(id: number): FixtureLive {
    const k = String(id);
    if (!this.data.fixtures[k]) this.data.fixtures[k] = { fixtureId: id };
    this.dirtyFixtures.add(id);
    return this.data.fixtures[k];
  }

  marketByFixture(
    fixtureId: number,
    marketType: number
  ): MarketRecord | undefined {
    return Object.values(this.data.markets).find(
      (m) => m.fixtureId === fixtureId && m.marketType === marketType
    );
  }

  /**
   * The keeper mutates `store.data.*` in place and then calls this, so we cannot
   * know WHICH object changed. Marking everything touched-since-load would be a
   * full table rewrite every 250ms, so instead the whole working set is diffed on
   * flush — it is ~100 rows, and correctness beats cleverness here.
   */
  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushAsync();
    }, 250);
  }

  flush() {
    void this.flushAsync();
  }

  async flushAsync(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const f of Object.values(this.data.fixtures))
        await this.writeFixture(f);
      for (const m of Object.values(this.data.markets))
        await this.writeMarket(m);
      for (const r of Object.values(this.data.receipts))
        await this.writeReceipt(r);
      await this.writeKv();
      this.dirtyFixtures.clear();
      this.dirtyMarkets.clear();
      this.dirtyReceipts.clear();
      this.dirtyKv.clear();
    } catch (e) {
      log.error("flush failed", { error: String(e) });
    } finally {
      this.flushing = false;
    }
  }

  private async writeFixture(f: FixtureLive) {
    const home = resolveTeam(f.homeName);
    const away = resolveTeam(f.awayName);
    const kickoffMs = (f.kickoffTs ?? 0) * 1000;
    const proofStatus = (f.proofStatus ?? "upcoming") as ProofStatus;

    const data = {
      competitionId: f.competitionId ?? null,
      homeName: f.homeName ?? "",
      awayName: f.awayName ?? "",
      homeCode: home.unknown ? null : home.code,
      awayCode: away.unknown ? null : away.code,
      stage: f.stage ?? (kickoffMs ? stageOf(kickoffMs) : "Group"),
      kickoffTs: new Date(kickoffMs),
      proofStatus,
      gapReason: f.gapReason ?? null,
      statusId: f.statusId ?? null,
      // A scoreline is written ONLY when it is proven. The feed's own Score field
      // is sampled and has been observed to disagree with the proof.
      provenP1: proofStatus === "proven" ? f.score?.p1 ?? null : null,
      provenP2: proofStatus === "proven" ? f.score?.p2 ?? null : null,
      lastSeq: f.lastSeq ?? null,
      lastTs: f.lastTs ? BigInt(f.lastTs) : null,
      finalisedSeq: f.finalisedSeq ?? null,
    };
    await prisma.fixture.upsert({
      where: { id: f.fixtureId },
      create: { id: f.fixtureId, ...data },
      update: data,
    });
  }

  private async writeMarket(m: MarketRecord) {
    const status: MarketStatus =
      m.phase === "settled"
        ? "settled"
        : m.phase === "cancelled"
        ? "cancelled"
        : m.phase === "locked"
        ? "locked"
        : "open";

    // The market row is created by syncMarkets() from chain state (it owns pools,
    // vault, mint...). Here we only carry the keeper's own bookkeeping across.
    await prisma.market
      .update({
        where: { pda: m.marketPda },
        data: {
          status,
          createdTx: m.createdTx ?? null,
          lockTx: m.lockTx ?? null,
          settleTx: m.settleTx ?? null,
          cancelTx: m.cancelTx ?? null,
          winningOutcome: m.winningOutcome ?? null,
        },
      })
      .catch(() => {
        /* not synced from chain yet — syncMarkets will create it */
      });
  }

  private async writeReceipt(r: ProofReceipt) {
    const exists = await prisma.market.findUnique({
      where: { pda: r.marketPda },
      select: { pda: true },
    });
    if (!exists) return; // market row lands first

    const data = {
      fixtureId: r.matchId,
      winningOutcome: r.winningOutcome,
      outcomeLabel: r.outcomeLabel,
      provenP1: r.provenScore?.p1 ?? null,
      provenP2: r.provenScore?.p2 ?? null,
      statPeriod: r.statPeriod ?? null,
      oracleProgram: r.oracleProgram,
      epochDay: r.epochDay,
      dailyRootsPda: r.dailyRootsPda,
      proofRef: r.proofRef,
      resolver: r.resolver,
      settleTx: r.settleTx,
      settledAt: new Date(
        (r.settledAt || Math.floor(Date.now() / 1000)) * 1000
      ),
      totalPool: BigInt(r.totalPool),
      totalWinningPool: BigInt(r.totalWinningPool),
      feeAmount: BigInt(r.feeAmount),
    };
    await prisma.receipt.upsert({
      where: { marketPda: r.marketPda },
      create: { marketPda: r.marketPda, ...data },
      update: data,
    });
  }

  private async writeKv() {
    const kv: Record<string, string | undefined> = {
      usdcMint: this.data.mints.usdcMint,
      txlineJwt: this.data.session.jwt,
      txlineApiToken: this.data.session.apiToken,
    };
    for (const [key, value] of Object.entries(kv)) {
      if (!value) continue;
      await prisma.keyValue.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
  }
}

/**
 * Append an event and wake every API instance.
 *
 * NOTIFY carries only the row id: Postgres caps the payload at 8000 bytes, and a
 * single oversized event would silently kill the stream.
 */
export async function emitEvent(
  type: string,
  payload: unknown,
  opts: { fixtureId?: number; marketPda?: string; seq?: number } = {}
): Promise<void> {
  try {
    const ev = await prisma.feedEvent.create({
      data: {
        type,
        fixtureId: opts.fixtureId ?? null,
        marketPda: opts.marketPda ?? null,
        seq: opts.seq ?? null,
        payload: JSON.parse(JSON.stringify(payload ?? {})),
      },
      select: { id: true },
    });
    await prisma.$executeRawUnsafe(
      `SELECT pg_notify('${CHANNEL}', $1)`,
      ev.id.toString()
    );
  } catch (e) {
    // The stream is a nicety; never let it take the keeper down.
    log.warn("failed to emit event", { type, error: String(e) });
  }
}
