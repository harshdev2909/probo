/**
 * PHASE 2 — seed a market for every World Cup fixture on devnet.
 *
 * Idempotent: existing markets are fetched in ONE getProgramAccounts call and
 * adopted, so re-running never double-creates and a crash resumes cleanly.
 * RPC-friendly: 429-aware retry + throttling (the public devnet RPC is strict).
 *
 * lock_time:
 *   · finished fixtures  -> now+30s so they're immediately lockable by backfill
 *   · upcoming fixtures  -> kickoff, so they stay OPEN for betting
 * stat period:
 *   · taken from THIS fixture's plan (5/10/13/100) so the market's OutcomeSpec
 *     matches the leaf the oracle will verify.
 */
import * as fs from "fs";
import * as path from "path";

import { loadConfig, ROOT } from "../src/config";
import { Logger } from "../src/logger";
import { Store, type MarketRecord } from "../src/state";
import { Chain, statusName } from "../src/chain/proofbook";
import { withRetry } from "../src/backfill/retry";
import type { FixturePlan } from "../src/backfill/plan";
import { resolveTeam, stageOf } from "../../data/tournament";

const log = new Logger("seed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const THROTTLE = Number(process.env.SEED_THROTTLE_MS ?? 700);
/**
 * Finished fixtures still need a betting window: place_bet requires
 * now < lock_time, but lock_market requires now >= lock_time. So a backfilled
 * market opens for a short window (long enough for the liquidity pass), then
 * becomes lockable. The backfiller waits out the remainder.
 */
const LOCK_DELAY = Number(process.env.SEED_LOCK_DELAY_SEC ?? 900);

/** Optional `FIXTURE_IDS=a,b,c` filter — lets one fixture be seeded or settled
 *  into a fresh market generation without touching the other 100+. */
function fixtureFilter(plans: FixturePlan[]): FixturePlan[] {
  const raw = process.env.FIXTURE_IDS;
  if (!raw) return plans;
  const want = new Set(raw.split(",").map((x) => Number(x.trim())));
  return plans.filter((p) => want.has(p.fixtureId));
}

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);

  const planFile = path.join(ROOT, "keeper", "data", "plan.json");
  if (!fs.existsSync(planFile))
    throw new Error("run `coverage` first to produce plan.json");
  const plans: FixturePlan[] = fixtureFilter(
    JSON.parse(fs.readFileSync(planFile, "utf8"))
  );

  const mint = await withRetry(
    "ensure mint",
    () => chain.ensureUsdcMint(),
    log
  );
  log.info("seeding tournament", {
    fixtures: plans.length,
    mint: mint.toBase58(),
  });

  // ── ONE call to learn everything that already exists (RPC-friendly) ──
  const existing = await withRetry(
    "load markets",
    () => chain.allMarkets(),
    log
  );
  const byPda = new Map(
    existing.map((m) => [m.publicKey.toBase58(), m.account])
  );
  log.info(`found ${existing.length} markets already on-chain`);

  let created = 0,
    adopted = 0,
    failed = 0;

  for (const p of plans) {
    const home = resolveTeam(p.p1Name);
    const away = resolveTeam(p.p2Name);
    const label = `${home.code} v ${away.code}`;
    const stage = stageOf(p.kickoffMs);
    const pda = chain.marketPdaFor(p.fixtureId, cfg.marketType);
    const key = pda.toBase58();

    const fx = store.fixture(p.fixtureId);
    fx.name = `${home.name} v ${away.name}`;
    fx.homeName = p.p1Name;
    fx.awayName = p.p2Name;
    fx.stage = stage;
    fx.kickoffTs = Math.floor(p.kickoffMs / 1000);
    fx.proofStatus =
      p.status === "settleable"
        ? "proven"
        : p.status === "not_finished"
        ? "upcoming"
        : "no_proof";
    fx.gapReason =
      p.status === "no_proof" || p.status === "no_root" ? p.reason : undefined;

    const onchain = byPda.get(key);
    if (onchain) {
      const st = statusName(onchain.status);
      store.data.markets[key] = {
        marketPda: key,
        fixtureId: p.fixtureId,
        marketType: cfg.marketType,
        phase: st === "open" ? "created" : (st as MarketRecord["phase"]),
        lockTime: Number(onchain.lockTime),
        resolutionTimeout: Number(onchain.resolutionTimeout),
        usdcMint: onchain.usdcMint.toBase58(),
        winningOutcome:
          onchain.winningOutcome === 255 ? undefined : onchain.winningOutcome,
      };
      store.saveSoon();
      adopted++;
      log.info(`adopt  ${label.padEnd(11)} ${stage.padEnd(5)} ${st}`);
      continue;
    }

    const kickoffSec = Math.floor(p.kickoffMs / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    const isFuture = kickoffSec > nowSec + 120;
    const lockTime = isFuture ? kickoffSec : nowSec + LOCK_DELAY;
    const period = p.period ?? cfg.statPeriod;

    try {
      const { sig } = await withRetry(
        `init ${label}`,
        () =>
          chain.initializeMarket(
            p.fixtureId,
            cfg.marketType,
            mint,
            lockTime,
            cfg.resolutionTimeoutSec,
            period
          ),
        log
      );
      store.data.markets[key] = {
        marketPda: key,
        fixtureId: p.fixtureId,
        marketType: cfg.marketType,
        phase: "created",
        lockTime,
        resolutionTimeout: cfg.resolutionTimeoutSec,
        usdcMint: mint.toBase58(),
        createdTx: sig,
      };
      store.saveSoon();
      created++;
      log.info(
        `create ${label.padEnd(11)} ${stage.padEnd(5)} p=${String(
          period
        ).padEnd(3)} ` +
          `${isFuture ? "OPEN for betting" : "lockable"} (${p.status})`
      );
    } catch (e: any) {
      failed++;
      log.error(`FAIL   ${label} ${p.fixtureId}`, {
        error:
          e?.error?.errorCode?.code ?? String(e?.message ?? e).slice(0, 80),
      });
    }
    await sleep(THROTTLE);
  }

  store.flush();
  log.info("═══════════════════════════════════");
  log.info(`created ${created} · adopted ${adopted} · failed ${failed}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
