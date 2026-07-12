/**
 * One-time import: JSON store + on-chain state -> Postgres.
 *
 * The 76 Proof Receipts are the most valuable thing in this repo, so this script
 * is deliberately paranoid:
 *   · markets and positions are read from the CHAIN, not the JSON file — the chain
 *     is the authority, and the JSON store could have drifted
 *   · a receipt is only written if its market is actually `settled` on-chain
 *   · it is idempotent (upserts), so it can be re-run against a live database
 *   · it verifies its own output at the end and exits non-zero if the counts move
 *
 * Run:  npm run db:import
 */
import * as fs from "fs";
import * as path from "path";

import { prisma, ProofStatus, MarketStatus } from "./client";
import { loadConfig, ROOT } from "../../keeper/src/config";
import { Store } from "../../keeper/src/state";
import {
  Chain,
  statusName,
  OUTCOME_LABELS,
} from "../../keeper/src/chain/proofbook";
import { TEAMS, resolveTeam, stageOf } from "../../data/tournament";
import type { FixturePlan } from "../../keeper/src/backfill/plan";

const log = (...a: unknown[]) => console.log("[import]", ...a);

/** Rank a market so a fixture that has several generations keeps the real one. */
function rank(m: { status: string; totalPool: bigint }): number {
  if (m.status === "settled") return 400;
  if (m.status === "locked") return 300;
  if (m.status === "open" && m.totalPool > 0n) return 200;
  if (m.status === "open") return 100;
  return 0; // cancelled
}

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);

  const planFile = path.join(ROOT, "keeper", "data", "plan.json");
  const plans: FixturePlan[] = fs.existsSync(planFile)
    ? JSON.parse(fs.readFileSync(planFile, "utf8"))
    : [];
  const planBy = new Map(plans.map((p) => [p.fixtureId, p]));

  // ── teams ────────────────────────────────────────────────────────────────
  for (const t of Object.values(TEAMS)) {
    await prisma.team.upsert({
      where: { code: t.code },
      create: {
        code: t.code,
        name: t.name,
        iso: t.iso,
        confed: t.confed,
        chip: t.chip,
      },
      update: { name: t.name, iso: t.iso, confed: t.confed, chip: t.chip },
    });
  }
  log(`teams: ${Object.keys(TEAMS).length}`);

  // ── fixtures ─────────────────────────────────────────────────────────────
  const fixtures = Object.values(store.data.fixtures);
  for (const f of fixtures) {
    const plan = planBy.get(f.fixtureId);
    const homeName = f.homeName ?? plan?.p1Name ?? "";
    const awayName = f.awayName ?? plan?.p2Name ?? "";
    const home = resolveTeam(homeName);
    const away = resolveTeam(awayName);
    const kickoffMs = (f.kickoffTs ?? 0) * 1000;

    const proofStatus: ProofStatus =
      f.proofStatus === "proven"
        ? ProofStatus.proven
        : f.proofStatus === "no_proof"
        ? ProofStatus.no_proof
        : ProofStatus.upcoming;

    const data = {
      competitionId: f.competitionId ?? null,
      homeName,
      awayName,
      homeCode: home.unknown ? null : home.code,
      awayCode: away.unknown ? null : away.code,
      stage: f.stage ?? (kickoffMs ? stageOf(kickoffMs) : "Group"),
      kickoffTs: new Date(kickoffMs),
      proofStatus,
      gapReason: f.gapReason ?? plan?.reason ?? null,
      statusId: f.statusId ?? null,
      // PROVEN goals only — never the feed's sampled Score field.
      provenP1: proofStatus === ProofStatus.proven ? f.score?.p1 ?? null : null,
      provenP2: proofStatus === ProofStatus.proven ? f.score?.p2 ?? null : null,
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
  log(`fixtures: ${fixtures.length}`);

  // ── markets (from the CHAIN — the authority) ─────────────────────────────
  const allow = new Set(cfg.marketTypes);
  const onchain = await chain.allMarkets();
  const known = new Set(fixtures.map((f) => f.fixtureId));

  const best = new Map<number, { pda: string; acc: any }>();
  for (const { publicKey, account } of onchain) {
    if (!allow.has(account.marketType)) continue;
    const fid = Number(account.fixtureId);
    if (!known.has(fid)) continue; // a market for a fixture we never indexed
    const cur = best.get(fid);
    const cand = {
      status: statusName(account.status),
      totalPool: BigInt(account.totalPool.toString()),
    };
    if (
      !cur ||
      rank(cand) >
        rank({
          status: statusName(cur.acc.status),
          totalPool: BigInt(cur.acc.totalPool.toString()),
        })
    ) {
      best.set(fid, { pda: publicKey.toBase58(), acc: account });
    }
  }

  for (const [fid, { pda, acc }] of best) {
    const rec = store.data.markets[pda];
    const status = statusName(acc.status) as MarketStatus;
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
      createdTx: rec?.createdTx ?? null,
      lockTx: rec?.lockTx ?? null,
      settleTx: rec?.settleTx ?? null,
      cancelTx: rec?.cancelTx ?? null,
      settledAt:
        acc.settledAt && Number(acc.settledAt) > 0
          ? new Date(Number(acc.settledAt) * 1000)
          : null,
    };
    await prisma.market.upsert({
      where: { pda },
      create: { pda, ...data },
      update: data,
    });
  }
  log(
    `markets: ${best.size} (from ${onchain.length} on-chain, types [${[
      ...allow,
    ]}])`
  );

  // ── positions (from the CHAIN) ───────────────────────────────────────────
  const marketPdas = new Set([...best.values()].map((m) => m.pda));
  const positions = await chain.program.account.position.all();
  let pos = 0;
  for (const p of positions) {
    const marketPda = p.account.market.toBase58();
    if (!marketPdas.has(marketPda)) continue; // belongs to a dead generation
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
    pos++;
  }
  log(`positions: ${pos}`);

  // ── receipts (only where the chain says `settled`) ───────────────────────
  let receipts = 0;
  for (const [fid, { pda, acc }] of best) {
    if (statusName(acc.status) !== "settled") continue;
    const r = store.data.receipts[pda];
    if (!r) {
      log(
        `WARNING: market ${pda} (fixture ${fid}) is settled on-chain but has no receipt in the store`
      );
      continue;
    }
    const data = {
      fixtureId: fid,
      winningOutcome: r.winningOutcome,
      outcomeLabel:
        r.outcomeLabel ??
        OUTCOME_LABELS[r.winningOutcome] ??
        String(r.winningOutcome),
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
      where: { marketPda: pda },
      create: { marketPda: pda, ...data },
      update: data,
    });
    receipts++;
  }
  log(`receipts: ${receipts}`);

  // ── keeper-owned key/value (never read by the API) ───────────────────────
  const kv: Record<string, string | undefined> = {
    usdcMint: store.data.mints.usdcMint,
    txlineJwt: store.data.session.jwt,
    txlineApiToken: store.data.session.apiToken,
  };
  for (const [key, value] of Object.entries(kv)) {
    if (!value) continue;
    await prisma.keyValue.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  // ── verify: the numbers must not move ────────────────────────────────────
  const [nFix, nMkt, nRec, nPos, nProven, nGap] = await Promise.all([
    prisma.fixture.count(),
    prisma.market.count(),
    prisma.receipt.count(),
    prisma.position.count(),
    prisma.fixture.count({ where: { proofStatus: ProofStatus.proven } }),
    prisma.fixture.count({ where: { proofStatus: ProofStatus.no_proof } }),
  ]);
  const settledMarkets = await prisma.market.count({
    where: { status: MarketStatus.settled },
  });

  log("─".repeat(50));
  log(`fixtures ${nFix} · markets ${nMkt} · positions ${nPos}`);
  log(`settled markets ${settledMarkets} · receipts ${nRec}`);
  log(`proven ${nProven} · honest gaps ${nGap}`);

  const problems: string[] = [];
  if (nRec !== settledMarkets)
    problems.push(`receipts (${nRec}) != settled markets (${settledMarkets})`);
  const noScore = await prisma.receipt.count({ where: { provenP1: null } });
  if (noScore) problems.push(`${noScore} receipts have no proven score`);
  // A settled market must carry the winning outcome its receipt claims.
  const settled = await prisma.market.findMany({
    where: { status: MarketStatus.settled },
    select: {
      pda: true,
      winningOutcome: true,
      receipt: { select: { winningOutcome: true } },
    },
  });
  const mismatched = settled.filter(
    (m) => !m.receipt || m.receipt.winningOutcome !== m.winningOutcome
  );
  if (mismatched.length)
    problems.push(
      `${mismatched.length} settled markets disagree with their receipt`
    );

  // Every proven fixture must have a proven scoreline, and no unprovable one may.
  const provenNoScore = await prisma.fixture.count({
    where: { proofStatus: ProofStatus.proven, provenP1: null },
  });
  if (provenNoScore)
    problems.push(`${provenNoScore} proven fixtures have no score`);
  const gapWithScore = await prisma.fixture.count({
    where: { proofStatus: ProofStatus.no_proof, NOT: { provenP1: null } },
  });
  if (gapWithScore)
    problems.push(
      `${gapWithScore} UNPROVABLE fixtures carry a scoreline — that would be fabricated`
    );

  if (problems.length) {
    console.error("[import] INTEGRITY FAILURES:");
    problems.forEach((p) => console.error("  ✗ " + p));
    process.exit(1);
  }
  log("integrity checks passed ✓");
}

main()
  .then(() => prisma.$disconnect().then(() => process.exit(0)))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
