/**
 * PHASE 3 — ⭐ MASS BACKFILL SETTLEMENT.
 *
 * For every fixture the coverage plan marks `settleable`:
 *   1. re-fetch the REAL proof from /scores/stat-validation (terminal record)
 *   2. lock_market (if still open)
 *   3. settle_market, CPI-ing the LIVE devnet validate_stat_v2 with that proof
 *
 * HARD RULES
 *   · No fake, mock, or admin settlement. If a real proof cannot be obtained the
 *     fixture is left unsettled and reported as an honest gap.
 *   · Idempotent: on-chain status is checked first; already-settled markets are
 *     recorded and skipped.
 *   · Every failure is logged with its reason and appears in the final report.
 */
import * as fs from "fs";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { loadConfig, ROOT } from "../src/config";
import { Logger } from "../src/logger";
import { Store, type ProofReceipt } from "../src/state";
import { Chain, statusName, OUTCOME_LABELS } from "../src/chain/proofbook";
import { TxLineSession } from "../src/txline/session";
import { TxLineClient } from "../src/txline/client";
import { withRetry } from "../src/backfill/retry";
import type { FixturePlan } from "../src/backfill/plan";
import { resolveTeam, stageOf } from "../../data/tournament";

const log = new Logger("backfill");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const toBytes32 = (v: any): number[] => {
  const b = Array.isArray(v)
    ? Uint8Array.from(v)
    : v instanceof Uint8Array
    ? v
    : typeof v === "string"
    ? v.startsWith("0x")
      ? Buffer.from(v.slice(2), "hex")
      : Buffer.from(v, "base64")
    : Uint8Array.from(v);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return Array.from(b);
};
const mapProof = (nodes: any[]) =>
  nodes.map((n) => ({
    hash: toBytes32(n.hash),
    isRightSibling: n.isRightSibling,
  }));

interface Outcome {
  fixtureId: number;
  teams: string;
  stage: string;
  ok: boolean;
  score?: string;
  outcome?: string;
  settleTx?: string;
  reason?: string;
}

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
  const session = new TxLineSession(cfg, store, chain);
  await session.ensure();
  const client = new TxLineClient(session);

  const plans: FixturePlan[] = JSON.parse(
    fs.readFileSync(path.join(ROOT, "keeper", "data", "plan.json"), "utf8")
  );
  const targets = fixtureFilter(plans.filter((p) => p.status === "settleable"));
  log.info(`backfilling ${targets.length} fixtures with REAL TxLINE proofs`);

  // one getProgramAccounts call instead of 75 lookups (public RPC is strict)
  const existing = await withRetry(
    "load markets",
    () => chain.allMarkets(),
    log
  );

  // Pick the right market per fixture across every allowed generation. Devnet
  // keeps every market ever created, so a fixture can carry both a dead market
  // (betting closed with nothing staked — it could only ever settle into a
  // refund) and a live one. Prefer settled, then a market with real stake.
  const allow = new Set(cfg.marketTypes);
  const rank = (m: any) => {
    const st = statusName(m.status);
    if (st === "settled") return 400;
    if (st === "locked") return 300;
    if (st === "open" && Number(m.totalPool) > 0) return 200;
    if (st === "open") return 100;
    return 0; // cancelled
  };
  const byFixture = new Map<number, { pda: PublicKey; account: any }>();
  for (const { publicKey, account } of existing) {
    if (!allow.has(account.marketType)) continue;
    const fid = Number(account.fixtureId);
    const cur = byFixture.get(fid);
    if (!cur || rank(account) > rank(cur.account)) {
      byFixture.set(fid, { pda: publicKey, account });
    }
  }
  log.info(
    `loaded ${existing.length} markets · ${
      byFixture.size
    } fixtures across generations [${[...allow].join(", ")}]`
  );

  const results: Outcome[] = [];
  let settled = 0,
    already = 0,
    failed = 0;

  for (const p of targets) {
    const home = resolveTeam(p.p1Name);
    const away = resolveTeam(p.p2Name);
    const teams = `${home.code} v ${away.code}`;
    const stage = stageOf(p.kickoffMs);
    const res: Outcome = { fixtureId: p.fixtureId, teams, stage, ok: false };

    try {
      const chosen = byFixture.get(p.fixtureId);
      if (!chosen) throw new Error("market not seeded (run seed-tournament)");
      const pda = chosen.pda;
      const key = pda.toBase58();
      let m: any = chosen.account;

      // ── 1) real proof (terminal record) ──
      // Fetched BEFORE the idempotency check so that a re-run also back-fills the
      // proven scoreline onto markets settled by an earlier run.
      const val = await client.statValidation(
        p.fixtureId,
        p.seq!,
        cfg.statKeys as any
      );
      const stats = val.statsToProve;
      const g1 = stats[0].value,
        g2 = stats[1].value;
      const period = stats[0].period;
      if (period !== p.period) {
        log.warn(
          `period drift for ${p.fixtureId}: plan=${p.period} now=${period}`
        );
      }
      const tsMs = val.summary.updateStats.minTimestamp;
      const epochDay = Math.floor(tsMs / 86_400_000);
      const claimed = g1 > g2 ? 0 : g1 < g2 ? 2 : 1;
      res.score = `${g1}-${g2}`;
      res.outcome = OUTCOME_LABELS[claimed];

      // The proven score is the only score we ever show for a settled fixture.
      const fx = store.fixture(p.fixtureId);
      fx.score = { p1: g1, p2: g2 };
      fx.statusId = 100;
      store.saveSoon();

      // ── idempotency: already terminal? record what we proved and move on ──
      let st = statusName(m.status);
      if (st === "settled" || st === "cancelled") {
        already++;
        res.ok = st === "settled";
        res.reason = `already ${st}`;
        // Carry the original settle signature through, so a re-run still reports
        // the real transaction rather than an empty cell.
        const priorTx =
          store.data.markets[key]?.settleTx ??
          store.data.receipts[key]?.settleTx ??
          "";
        res.settleTx = priorTx || undefined;
        recordReceipt(store, key, m, priorTx, g1, g2, period);
        results.push(res);
        log.info(`skip   ${teams.padEnd(11)} already ${st} ${res.score}`);
        continue;
      }

      const proof = {
        ts: new BN(tsMs),
        fixtureSummary: {
          fixtureId: new BN(val.summary.fixtureId),
          updateStats: {
            updateCount: val.summary.updateStats.updateCount,
            minTimestamp: new BN(val.summary.updateStats.minTimestamp),
            maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
          },
          eventsSubTreeRoot: toBytes32(val.summary.eventStatsSubTreeRoot),
        },
        fixtureProof: mapProof(val.subTreeProof),
        mainTreeProof: mapProof(val.mainTreeProof),
        eventStatRoot: toBytes32(val.eventStatRoot),
        statAValue: g1,
        statAProof: mapProof(val.statProofs[0]),
        hasStatB: true,
        statBValue: g2,
        statBProof: mapProof(val.statProofs[1]),
      };

      // A market with no stake can only settle into `Cancelled (refundable)` —
      // the winning outcome has nobody to pay — so it can never earn a receipt.
      // If betting has already closed on it, settling would just void it. Leave
      // it alone and say so.
      if (
        st === "open" &&
        Number(m.totalPool) === 0 &&
        Number(m.lockTime) * 1000 <= Date.now()
      ) {
        throw new Error(
          "betting closed with zero stake — cannot earn a receipt"
        );
      }

      // ── 2) lock if needed ──
      if (st === "open") {
        // The market may still be inside its betting window (lock_market rejects
        // until lock_time). Wait it out rather than failing the fixture.
        const waitMs = (Number(m.lockTime) + 3) * 1000 - Date.now();
        if (waitMs > 0) {
          log.info(
            `waiting ${Math.ceil(waitMs / 1000)}s for betting window to close…`
          );
          await sleep(waitMs);
        }
        await withRetry(`lock ${teams}`, () => chain.lockMarket(pda), log);
        await sleep(700);
        m = await withRetry(
          `refetch ${teams}`,
          () => chain.fetchMarket(pda),
          log
        );
        st = statusName(m.status);
      }
      if (st !== "locked") throw new Error(`market is ${st}, expected locked`);

      // ── 3) settle with the REAL proof (CPI -> live validate_stat_v2) ──
      const sig = await withRetry(
        `settle ${teams}`,
        () => chain.settleMarket(pda, claimed, proof, epochDay),
        log
      );
      settled++;
      res.ok = true;
      res.settleTx = sig;
      const after = await withRetry(
        `verify ${teams}`,
        () => chain.fetchMarket(pda),
        log
      );
      recordReceipt(store, key, after, sig, g1, g2, period);
      store.data.markets[key].phase = "settled";
      store.data.markets[key].settleTx = sig;
      store.data.markets[key].winningOutcome = claimed;
      store.saveSoon();

      log.info(
        `SETTLED ${teams.padEnd(11)} ${stage.padEnd(5)} ${
          res.score
        } → ${res.outcome!.padEnd(4)} ` + `p${period} ${sig.slice(0, 16)}…`
      );
    } catch (e: any) {
      failed++;
      res.reason =
        e?.error?.errorCode?.code ??
        (e?.response
          ? `API ${e.response.status}`
          : (e?.message ?? String(e)).slice(0, 90));
      log.error(`FAIL   ${teams.padEnd(11)} ${res.reason}`);
    }
    results.push(res);
    await sleep(Number(process.env.BACKFILL_THROTTLE_MS ?? 650)); // throttle RPC + API
  }

  store.flush();

  // ── report ─────────────────────────────────────────────────────────────
  const noProof = plans.filter((p) => p.status === "no_proof");
  const upcoming = plans.filter((p) => p.status === "not_finished");
  const okRows = results.filter((r) => r.ok);

  const report = `
## Settlement report (${new Date().toISOString()})

**${okRows.length} of ${
    plans.length
  } World Cup fixtures settled on devnet with a REAL TxLINE proof.**

| | count |
|---|---|
| ✅ Settled this run | ${settled} |
| ✅ Already settled (idempotent skip) | ${already} |
| ❌ Failed | ${failed} |
| ⚪️ No proof obtainable (honest gap) | ${noProof.length} |
| 🕒 Upcoming | ${upcoming.length} |

### Settled with real proofs

| fixture | stage | teams | proven score | outcome | settle tx |
|---|---|---|---|---|---|
${okRows
  .map(
    (r) =>
      `| ${r.fixtureId} | ${r.stage} | ${r.teams} | ${r.score ?? "—"} | ${
        r.outcome ?? "—"
      } | \`${r.settleTx ?? "(earlier run)"}\` |`
  )
  .join("\n")}

${
  failed
    ? `### Failures (not hidden)\n\n| fixture | teams | reason |\n|---|---|---|\n${results
        .filter((r) => !r.ok)
        .map((r) => `| ${r.fixtureId} | ${r.teams} | ${r.reason} |`)
        .join("\n")}\n`
    : ""
}
### Honest gaps — outside TxLINE retention, so neither proof nor score

These ${
    noProof.length
  } fixtures were played, but they fall outside the window in which TxLINE
still retains score records. So we have **no proof** — and because TxLINE is our only
source of truth, **no verified scoreline either**.

They appear in the product as real fixtures, with no receipt and no score. We could
fill the scoreline in from memory and mint a receipt to match; both would be fabricated,
and one invented receipt would falsify the only claim this product makes. So we show the
gap instead.

| fixture | stage | teams | reason |
|---|---|---|---|
${noProof
  .map(
    (p) =>
      `| ${p.fixtureId} | ${stageOf(p.kickoffMs)} | ${
        resolveTeam(p.p1Name).code
      } v ${resolveTeam(p.p2Name).code} | ${p.reason} |`
  )
  .join("\n")}
`;

  const cov = path.join(ROOT, "docs", "COVERAGE.md");
  const prevDoc = fs.existsSync(cov) ? fs.readFileSync(cov, "utf8") : "";
  const marker = "\n<!-- SETTLEMENT REPORT -->\n";
  const base = prevDoc.split(marker)[0];
  fs.writeFileSync(cov, base + marker + report);

  log.info("═══════════════════════════════════════════════════");
  log.info(`REAL PROOFS SETTLED: ${okRows.length} / ${plans.length} fixtures`);
  log.info(`  settled now ${settled} · already ${already} · failed ${failed}`);
  log.info(`  honest gaps ${noProof.length} · upcoming ${upcoming.length}`);
  log.info("appended settlement report to docs/COVERAGE.md");
}

function recordReceipt(
  store: Store,
  key: string,
  m: any,
  sig: string,
  g1?: number,
  g2?: number,
  period?: number
) {
  if (statusName(m.status) !== "settled") return;
  const receipt: ProofReceipt = {
    marketPda: key,
    matchId: Number(m.fixtureId),
    winningOutcome: m.winningOutcome,
    provenScore:
      g1 !== undefined && g2 !== undefined ? { p1: g1, p2: g2 } : undefined,
    statPeriod: period,
    outcomeLabel: OUTCOME_LABELS[m.winningOutcome] ?? String(m.winningOutcome),
    oracleProgram: m.oracleProgram.toBase58(),
    epochDay: m.settleEpochDay,
    dailyRootsPda: m.settleDailyRoots.toBase58(),
    proofRef: Buffer.from(m.settleProofRef).toString("hex"),
    resolver: m.settleResolver.toBase58(),
    settleTx: sig,
    settledAt: Number(m.settledAt),
    totalPool: m.totalPool.toString(),
    totalWinningPool: m.totalWinningPool.toString(),
    feeAmount: m.feeAmount.toString(),
  };
  store.data.receipts[key] = receipt;
  store.saveSoon();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
