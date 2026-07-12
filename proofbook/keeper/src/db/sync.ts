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

const log = new Logger("sync");

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
    private instance: string
  ) {}

  /**
   * Pull every market of an allowed generation and project it into Postgres.
   * One getProgramAccounts call — not one per market.
   */
  async syncMarkets(): Promise<{ markets: number; settled: number }> {
    const allow = new Set(this.cfg.marketTypes);
    const all = await this.chain.allMarkets();

    // Devnet keeps every generation ever created, so a fixture can carry a dead
    // market and a live one. Only the real one is projected.
    const best = new Map<number, { pda: string; acc: any }>();
    for (const { publicKey, account } of all) {
      if (!allow.has(account.marketType)) continue;
      const fid = Number(account.fixtureId);
      const cur = best.get(fid);
      const candRank = rank(
        statusName(account.status),
        BigInt(account.totalPool.toString())
      );
      const curRank = cur
        ? rank(statusName(cur.acc.status), BigInt(cur.acc.totalPool.toString()))
        : -1;
      if (candRank > curRank)
        best.set(fid, { pda: publicKey.toBase58(), acc: account });
    }

    // A market row needs its fixture to exist (FK). Fixtures the keeper has never
    // indexed are skipped rather than invented.
    const known = new Set(
      (await prisma.fixture.findMany({ select: { id: true } })).map((f) => f.id)
    );

    let settled = 0;
    let written = 0;
    for (const [fid, { pda, acc }] of best) {
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

      const before = await prisma.market.findUnique({
        where: { pda },
        select: { status: true, totalPool: true },
      });

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
        await prisma.oddsSnapshot.create({
          data: {
            marketPda: pda,
            pools: data.pools,
            totalPool: data.totalPool,
          },
        });
      }
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

  async fullSync() {
    try {
      const { markets, settled } = await this.syncMarkets();
      const positions = await this.syncPositions();
      await this.heartbeat({ marketsSettled: settled, lastError: null });
      log.info("synced", { markets, settled, positions });
    } catch (e: any) {
      log.error("sync failed", { error: String(e?.message ?? e) });
      await this.heartbeat({
        lastError: String(e?.message ?? e).slice(0, 200),
      }).catch(() => {});
    }
  }
}
