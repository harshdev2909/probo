/**
 * Chain -> Postgres projection. Runs only on the LEADER keeper.
 *
 * The API never touches Solana, so everything it serves has to land here first:
 * market state, pools, positions, and the keeper's own liveness. If this stops
 * running, the site goes stale — which is exactly why `keeper_runs.lastHeartbeat`
 * is written from the same loop, so a stale site always has a dead heartbeat next
 * to it rather than silently lying.
 */
import { prisma, MarketStatus } from "../../../db/src/client";
import { Chain, statusName } from "../chain/proofbook";
import { KeeperConfig } from "../config";
import { Logger } from "../logger";
import { emitEvent } from "../pgstore";
import type { TxLineClient } from "../txline/client";
import { fetchConsensus, consensusFor1x2 } from "../markets/odds";
import { outcomeLabels } from "../../../shared/markets";
import { PublicKey } from "@solana/web3.js";

const log = new Logger("sync");

/** Market types >= this are distinct PRODUCTS, not generations of one. */
const COMBO_MARKET_TYPE_MIN = 16;

/** Prefer the market that actually carries the truth for a fixture. */
function rank(status: string, totalPool: bigint): number {
  if (status === "settled") return 400;
  if (status === "locked") return 300;
  if (status === "open" && totalPool > 0n) return 200;
  if (status === "open") return 100;
  return 0; // cancelled
}

export class DbSync {
  constructor(
    private cfg: KeeperConfig,
    private chain: Chain,
    private instance: string,
    /** Live mode only — the odds feed is a REST call, not a chain read. */
    private client?: TxLineClient
  ) {}

  /**
   * Record ONE consensus tick straight off the odds stream.
   *
   * Called per tick rather than on a timer, because the stream is the only place
   * the full line movement exists — `/odds/snapshot` exposes a short-lived
   * buffer and drops ticks between polls.
   */
  async recordOddsTick(row: any): Promise<number> {
    const c = consensusFor1x2([row]);
    if (!c) return 0; // not the demargined 1X2 book — nothing to align

    const markets = await prisma.market.findMany({
      where: {
        fixtureId: Number(row.FixtureId),
        status: { in: [MarketStatus.open, MarketStatus.locked] },
      },
      select: { pda: true, pools: true, totalPool: true },
    });

    let n = 0;
    for (const m of markets) {
      // The consensus is 1X2-shaped. Attaching a 3-way probability to a 2-way
      // over/under would be a number that looks authoritative and means nothing.
      if (m.pools.length !== 3) continue;
      await prisma.oddsSnapshot.create({
        data: {
          marketPda: m.pda,
          pools: m.pools,
          totalPool: m.totalPool,
          consensusPct: c.pct,
          bookmaker: c.bookmaker,
          consensusTs: BigInt(c.ts),
        },
      });
      n++;
    }
    if (n) {
      log.info("consensus tick", {
        fixture: Number(row.FixtureId),
        sharp: c.pct.map((p) => `${(p * 100).toFixed(1)}%`).join(" / "),
        markets: n,
      });
    }
    return n;
  }

  /**
   * SHARP vs CROWD: sample TxLINE's consensus next to our own pools.
   *
   * Runs on its own timer rather than piggy-backing on the pool-change snapshot,
   * because the two move independently — the consensus line drifts all afternoon
   * while our pools sit still, and a sparkline that only ticked when someone bet
   * would be a sparkline of our own activity, not of the market's opinion.
   *
   * Only markets whose fixture is NEAR kickoff are polled: TxLINE publishes odds
   * from roughly a day before and purges them afterwards, so polling a finished
   * fixture is a guaranteed empty response. Where there is no consensus we still
   * record the crowd, with `consensusPct: []` — absent, not invented.
   */
  async syncOdds(): Promise<number> {
    if (!this.client) return 0;

    const now = Date.now();
    const markets = await prisma.market.findMany({
      where: { status: { in: [MarketStatus.open, MarketStatus.locked] } },
      select: {
        pda: true,
        fixtureId: true,
        pools: true,
        totalPool: true,
        fixture: { select: { kickoffTs: true } },
      },
    });

    // One odds call per FIXTURE, not per market — a fixture carries a dozen
    // markets and they all read the same consensus.
    const near = markets.filter((m) => {
      const ko = m.fixture.kickoffTs.getTime();
      return ko - now < 36 * 3600_000 && now - ko < 6 * 3600_000;
    });
    const byFixture = new Map<number, typeof near>();
    for (const m of near) {
      const arr = byFixture.get(m.fixtureId) ?? [];
      arr.push(m);
      byFixture.set(m.fixtureId, arr);
    }

    let written = 0;
    for (const [fixtureId, ms] of byFixture) {
      const c = await fetchConsensus(this.client, fixtureId);
      for (const m of ms) {
        await prisma.oddsSnapshot.create({
          data: {
            marketPda: m.pda,
            pools: m.pools,
            totalPool: m.totalPool,
            // The consensus is 1X2-shaped. Only attach it to a market whose
            // outcomes actually line up — attaching a 3-way probability to a
            // 2-way over/under would be a number that looks right and is not.
            consensusPct: c && m.pools.length === 3 ? c.pct : [],
            bookmaker: c && m.pools.length === 3 ? c.bookmaker : null,
            consensusTs: c && m.pools.length === 3 ? BigInt(c.ts) : null,
          },
        });
        written++;
      }
      if (c) {
        log.info("consensus sampled", {
          fixtureId,
          bookmaker: c.bookmaker,
          sharp: c.pct.map((p) => `${(p * 100).toFixed(1)}%`).join(" / "),
        });
      }
    }
    return written;
  }

  /**
   * Pull every market of an allowed generation and project it into Postgres.
   * One getProgramAccounts call — not one per market.
   */
  async syncMarkets(): Promise<{ markets: number; settled: number }> {
    const allow = new Set(this.cfg.marketTypes);
    const all = await this.chain.allMarkets();

    // Two different things are called "market type", and collapsing them was a
    // real bug.
    //
    //   types 0..15  — GENERATIONS of the same 1X2 product. Devnet keeps every
    //                  one ever created, so a fixture carries dead generations
    //                  next to the live one. Dedupe: project only the real one.
    //
    //   types >= 16  — DISTINCT PRODUCTS (total goals, corners, parlays...). A
    //                  fixture legitimately has a dozen at once. Keying these by
    //                  fixture alone would keep exactly one and make the entire
    //                  receipt wall invisible.
    //
    // So: dedupe generations by fixture, and keep products by (fixture, type).
    const best = new Map<string, { pda: string; acc: any }>();
    for (const { publicKey, account } of all) {
      if (!allow.has(account.marketType)) continue;
      const fid = Number(account.fixtureId);
      const isProduct = account.marketType >= COMBO_MARKET_TYPE_MIN;
      const key = isProduct ? `${fid}:${account.marketType}` : `${fid}`;

      const cur = best.get(key);
      const candRank = rank(
        statusName(account.status),
        BigInt(account.totalPool.toString())
      );
      const curRank = cur
        ? rank(statusName(cur.acc.status), BigInt(cur.acc.totalPool.toString()))
        : -1;
      if (candRank > curRank)
        best.set(key, { pda: publicKey.toBase58(), acc: account });
    }

    // A market row needs its fixture to exist (FK). Fixtures the keeper has never
    // indexed are skipped rather than invented.
    const known = new Set(
      (await prisma.fixture.findMany({ select: { id: true } })).map((f) => f.id)
    );

    // Prior state for EVERY market, in one query.
    //
    // This used to be a `findUnique` per market, i.e. two sequential round trips
    // each. That was fine at ~100 markets and is not at ~1,200: it became ~2,400
    // sequential queries, slow enough that Neon's pooler closed the connection
    // out from under the sync and the whole projection died half-finished.
    const prior = new Map<string, { status: string; totalPool: bigint }>(
      (
        await prisma.market.findMany({
          select: { pda: true, status: true, totalPool: true },
        })
      ).map((m) => [m.pda, { status: m.status as string, totalPool: m.totalPool }])
    );

    let settled = 0;
    let written = 0;
    for (const { pda, acc } of best.values()) {
      // The map key is now "fixture" or "fixture:type" — take the fixture id from
      // the ACCOUNT, which is the only place it is unambiguous.
      const fid = Number(acc.fixtureId);
      if (!known.has(fid)) continue;
      const status = statusName(acc.status) as MarketStatus;
      if (status === "settled") settled++;

      const data = {
        fixtureId: fid,
        marketType: acc.marketType,
        status,
        lockTime: new Date(Number(acc.lockTime) * 1000),
        resolutionTimeout: Number(acc.resolutionTimeout),
        feeBps: acc.feeBps,
        usdcMint: acc.usdcMint.toBase58(),
        vault: acc.vault.toBase58(),
        authority: acc.authority.toBase58(),
        oracleProgram: acc.oracleProgram.toBase58(),
        totalPool: BigInt(acc.totalPool.toString()),
        pools: acc.outcomes.map((o: any) => BigInt(o.pool.toString())),
        totalWinningPool: acc.totalWinningPool
          ? BigInt(acc.totalWinningPool.toString())
          : null,
        feeAmount: acc.feeAmount ? BigInt(acc.feeAmount.toString()) : null,
        winningOutcome: acc.winningOutcome === 255 ? null : acc.winningOutcome,
        settledAt:
          acc.settledAt && Number(acc.settledAt) > 0
            ? new Date(Number(acc.settledAt) * 1000)
            : null,
      };

      const before = prior.get(pda);

      await prisma.market.upsert({
        where: { pda },
        create: { pda, ...data },
        update: data,
      });
      written++;

      // Only shout when something actually changed — an event per market per tick
      // would drown the SSE stream in noise.
      if (!before || before.status !== status) {
        await emitEvent(
          "market",
          { marketPda: pda, fixtureId: fid, status },
          {
            fixtureId: fid,
            marketPda: pda,
          }
        );
      }
      if (before && before.totalPool !== data.totalPool) {
        // A bet landed. Capture the crowd immediately; the consensus is sampled
        // on its own timer (syncOdds), so leave it absent here rather than
        // carrying a stale one forward.
        await prisma.oddsSnapshot.create({
          data: {
            marketPda: pda,
            pools: data.pools,
            totalPool: data.totalPool,
            consensusPct: [],
          },
        });
      }
    }

    // The allowlist must be SELF-ENFORCING. Upserting allowed types is not
    // enough: rows synced before a generation was abandoned stay behind, and a
    // dead generation "surfacing" is precisely the failure the allowlist exists
    // to prevent. Deleting cascades to positions, odds and receipts — correct,
    // because a dead generation's rows are exactly the ones that must not show.
    const purged = await prisma.market.deleteMany({
      where: { marketType: { notIn: [...allow] } },
    });
    if (purged.count) {
      log.warn("purged markets of disallowed generations from the projection", {
        purged: purged.count,
      });
    }

    return { markets: written, settled };
  }

  /** Index positions so /positions/:wallet is a Postgres read, not a chain scan. */
  async syncPositions(): Promise<number> {
    const marketPdas = new Set(
      (await prisma.market.findMany({ select: { pda: true } })).map(
        (m) => m.pda
      )
    );
    const positions = await this.chain.program.account.position.all();
    let n = 0;
    for (const p of positions) {
      const marketPda = p.account.market.toBase58();
      if (!marketPdas.has(marketPda)) continue;
      const data = {
        marketPda,
        owner: p.account.owner.toBase58(),
        outcomeIndex: p.account.outcomeIndex,
        amount: BigInt(p.account.amount.toString()),
        claimed: !!p.account.claimed,
      };
      await prisma.position.upsert({
        where: { pda: p.publicKey.toBase58() },
        create: { pda: p.publicKey.toBase58(), ...data },
        update: data,
      });
      n++;
    }
    return n;
  }

  /**
   * Liveness. The public status page reads this row — if the keeper dies on Final
   * night, this is the thing that says so instead of the site quietly going stale.
   */
  async heartbeat(
    patch: {
      streamConnected?: boolean;
      lastEventAt?: Date;
      lastSettlementAt?: Date;
      marketsSettled?: number;
      lastError?: string | null;
    } = {}
  ) {
    // Exactly one leader row, always. Only the lock holder calls this, so demoting
    // everyone else is safe — and it keeps the status page from showing two.
    await prisma.keeperRun.updateMany({
      where: { NOT: { instance: this.instance } },
      data: { isLeader: false },
    });

    const existing = await prisma.keeperRun.findFirst({
      where: { instance: this.instance },
    });
    if (existing) {
      await prisma.keeperRun.update({
        where: { id: existing.id },
        data: { ...patch, lastHeartbeat: new Date(), isLeader: true },
      });
    } else {
      await prisma.keeperRun.create({
        data: {
          instance: this.instance,
          mode: this.cfg.mode,
          version: process.env.GIT_SHA ?? null,
          isLeader: true,
          lastHeartbeat: new Date(),
          ...patch,
        },
      });
    }
  }

  /**
   * Project a Proof Receipt for every settled market that lacks one.
   *
   * The receipts table used to be written only by the live settler, so the 76
   * original receipts existed and nothing else did: the catalogue backfill
   * settles hundreds of markets on-chain, and every one of them would have been
   * invisible on /receipts. A receipt is not a side effect of the settling
   * process — it is a projection of what the chain already says, so it is built
   * from the Market account itself.
   *
   * Everything comes from chain except the settle SIGNATURE, which the account
   * does not record. That is recovered once, from the market's own transaction
   * history, and then never looked up again.
   */
  async syncReceipts(): Promise<number> {
    const settled = await prisma.market.findMany({
      where: { status: MarketStatus.settled, receipt: { is: null } },
      select: { pda: true, fixtureId: true, marketType: true },
      take: 200, // bounded per tick; the wall fills in over a few minutes
    });
    await this.healBlankReceipts();
    if (!settled.length) return 0;

    let written = 0;
    for (const row of settled) {
      try {
        const market = new PublicKey(row.pda);
        const acc = await this.chain.fetchMarket(market);
        if (!acc || statusName(acc.status) !== "settled") continue;

        const fixture = await prisma.fixture.findUnique({
          where: { id: row.fixtureId },
          select: { provenP1: true, provenP2: true, proofStatus: true },
        });

        // The settle signature is not in the account. Find it in the market's
        // history — the newest transaction that touched it and succeeded.
        const sigs = await this.chain.connection.getSignaturesForAddress(market, {
          limit: 20,
        });
        const settleTx = sigs.find((s) => !s.err)?.signature;
        if (!settleTx) continue;

        const winning = Number(acc.winningOutcome);
        const labels = outcomeLabels(row.marketType, acc.outcomes.length);
        const proven =
          fixture?.proofStatus === "proven" && fixture.provenP1 !== null;

        await prisma.receipt.create({
          data: {
            marketPda: row.pda,
            fixtureId: row.fixtureId,
            winningOutcome: winning,
            outcomeLabel: labels[winning] ?? `Outcome ${winning + 1}`,
            // The match scoreline, and only when the proof attests it.
            provenP1: proven ? fixture!.provenP1 : null,
            provenP2: proven ? fixture!.provenP2 : null,
            statPeriod: 100,
            oracleProgram: acc.oracleProgram.toBase58(),
            epochDay: Number(acc.settleEpochDay),
            dailyRootsPda: acc.settleDailyRoots.toBase58(),
            proofRef: Buffer.from(acc.settleProofRef).toString("hex"),
            resolver: acc.settleResolver.toBase58(),
            settleTx,
            settledAt: new Date(Number(acc.settledAt) * 1000),
            totalPool: BigInt(acc.totalPool.toString()),
            totalWinningPool: BigInt(acc.totalWinningPool.toString()),
            feeAmount: BigInt(acc.feeAmount.toString()),
          },
        });
        written++;
      } catch (e: any) {
        // A duplicate is fine (another tick won the race); anything else is noise
        // we do not want taking the sync down.
        if (!String(e?.message).includes("Unique constraint")) {
          log.warn("receipt projection failed", {
            market: row.pda,
            error: String(e?.message).slice(0, 120),
          });
        }
      }
    }
    if (written) log.info("projected proof receipts", { written });
    return written;
  }

  /**
   * Heal receipts that exist but carry no proven scoreline.
   *
   * Two writers can race a settlement: this keeper (which records provenScore)
   * and a stale deployed keeper running older code (which does not). On-chain
   * the race is idempotent and harmless — but if the old writer's receipt row
   * lands last, the wall shows a blank scoreline for a match whose score is
   * proven. The fixture table holds the proven values, so a blank receipt on a
   * proven fixture is always healable, and healing is idempotent.
   */
  private async healBlankReceipts(): Promise<void> {
    const blanks = await prisma.receipt.findMany({
      where: { provenP1: null },
      select: { marketPda: true, fixtureId: true },
      take: 40,
    });
    for (const b of blanks) {
      const f = await prisma.fixture.findUnique({
        where: { id: b.fixtureId },
        select: { provenP1: true, provenP2: true, proofStatus: true },
      });
      // Only ever heal FROM PROOF. A fixture without proven values keeps its
      // blank receipt — we do not fill holes with feed data.
      if (f?.proofStatus !== "proven" || f.provenP1 === null) continue;
      await prisma.receipt.update({
        where: { marketPda: b.marketPda },
        data: { provenP1: f.provenP1, provenP2: f.provenP2 },
      });
      log.info("healed a blank receipt from the proven fixture", {
        market: b.marketPda,
      });
    }
  }

  private syncing = false;

  async fullSync() {
    // NON-REENTRANT. This runs on a 10-second interval, but a pass over ~1,000
    // markets and ~3,000 positions takes minutes on a pooled connection —
    // setInterval kept stacking new passes on top of running ones until the
    // Prisma pool starved and every query timed out. One pass at a time; a tick
    // that finds one running simply yields to it.
    if (this.syncing) return;
    this.syncing = true;
    try {
      const { markets, settled } = await this.syncMarkets();
      const positions = await this.syncPositions();
      const receipts = await this.syncReceipts();
      await this.heartbeat({ marketsSettled: settled, lastError: null });
      log.info("synced", { markets, settled, positions, receipts });
    } catch (e: any) {
      log.error("sync failed", { error: String(e?.message ?? e) });
      await this.heartbeat({
        lastError: String(e?.message ?? e).slice(0, 200),
      }).catch(() => {});
    } finally {
      this.syncing = false;
    }
  }
}
