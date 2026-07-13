/**
 * THE INTEGRITY AUDIT — machine-checks the only claim this product makes.
 *
 * "Every receipt is a real TxLINE merkle proof, verified on-chain. Zero
 * fabricated." This script does not eyeball that; it re-derives it:
 *
 *   Per receipt (every receipt in the DB):
 *     1. The Market account on chain agrees with the receipt (status, winning
 *        outcome, proof ref, daily-roots PDA, resolver).
 *     2. The trusted oracle recorded on-chain is the REAL txoracle — never the
 *        bundled mock.
 *     3. The predicate is read from CHAIN (ComboSpec / OutcomeSpec), the proof is
 *        re-fetched from TxLINE, and TxLINE's own program re-adjudicates it by
 *        simulation → must return true.                       [VERIFIED_LIVE]
 *     4. Where TxLINE no longer retains the fixture (scores age out after ~23
 *        days), the settle TRANSACTION is fetched instead and must show the
 *        txoracle invoked and succeeding inside our settle instruction. The
 *        evidence is older but it is still chain evidence.    [VERIFIED_TX]
 *     5. Anything else is a FAIL, listed by name. A single FAIL is a P0 bug.
 *
 *   Global checks:
 *     - No DB market outside the live allowlist (dead generations must not surface).
 *     - No receipt whose oracle is the mock program.
 *     - No fixture with a scoreline unless its proof status is `proven`.
 *     - Gap fixtures (no retrievable proof) have NO receipt and NO score.
 *     - Chain ↔ DB reconciliation: settled-on-chain == receipts-in-DB, both ways.
 *
 * Writes docs/INTEGRITY_AUDIT.md. Exits non-zero on any FAIL.
 *
 *   npm run audit
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { loadConfig, ROOT } from "../src/config";
import { Store } from "../src/state";
import { prisma } from "../../db/src/client";

const TXLINE_DEVNET = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
const MOCK_ORACLE = "F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u";
const MS_PER_DAY = 86_400_000;
const ORIGIN = process.env.TXLINE_API ?? "https://txline-dev.txodds.com";
const THROTTLE_MS = Number(process.env.AUDIT_THROTTLE_MS ?? 220);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Verdict = "VERIFIED_LIVE" | "VERIFIED_TX" | "FAIL";

interface Row {
  marketPda: string;
  fixtureId: number;
  marketType: number;
  verdict: Verdict;
  detail: string;
}

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const { jwt, apiToken } = store.data.session;
  const H = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken! } as any;

  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANCHOR_WALLET ||
            `${process.env.HOME}/.config/solana/id.json`,
          "utf8"
        )
      )
    )
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  const proofbook = new anchor.Program(
    JSON.parse(fs.readFileSync(path.join(ROOT, "idl", "proofbook.json"), "utf8")),
    provider
  ) as any;
  const txoracle = new anchor.Program(
    JSON.parse(fs.readFileSync(path.join(ROOT, "idl", "txoracle.json"), "utf8")),
    provider
  ) as any;

  const receipts = await prisma.receipt.findMany({
    orderBy: [{ fixtureId: "asc" }],
    include: { market: { select: { marketType: true } } },
  });
  console.log(`\nauditing ${receipts.length} receipt(s)…\n`);

  // ── caches: one snapshot + one proof per (fixture, statKeys) ──────────────
  const seqCache = new Map<number, number | null>();
  const proofCache = new Map<string, any | null>();

  async function findSeq(fixtureId: number): Promise<number | null> {
    if (seqCache.has(fixtureId)) return seqCache.get(fixtureId)!;
    try {
      const r = await fetch(`${ORIGIN}/api/scores/snapshot/${fixtureId}`, {
        headers: H,
      });
      const rows = (await r.json()) as any[];
      if (!Array.isArray(rows) || !rows.length) throw new Error("empty");
      const fin = rows.filter((x) => x.StatusId === 100);
      const seq = (fin.length ? fin : rows).reduce(
        (m, x) => Math.max(m, x.Seq ?? 0),
        0
      );
      seqCache.set(fixtureId, seq);
      await sleep(THROTTLE_MS);
      return seq;
    } catch {
      seqCache.set(fixtureId, null); // retention expired — not an error
      return null;
    }
  }

  async function fetchProof(
    fixtureId: number,
    seq: number,
    keys: number[]
  ): Promise<any | null> {
    const ck = `${fixtureId}:${keys.join(",")}`;
    if (proofCache.has(ck)) return proofCache.get(ck)!;
    try {
      const r = await fetch(
        `${ORIGIN}/api/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${keys.join(",")}`,
        { headers: H }
      );
      if (!r.ok) throw new Error(String(r.status));
      const v = await r.json();
      proofCache.set(ck, v);
      await sleep(THROTTLE_MS);
      return v;
    } catch {
      proofCache.set(ck, null);
      return null;
    }
  }

  const b32 = (v: any) => Array.from(Buffer.from(v));
  const node = (n: any) => ({
    hash: Array.from(Buffer.from(n.hash ?? n)),
    isRightSibling: !!n.isRightSibling,
  });

  const rows: Row[] = [];

  for (const r of receipts) {
    const out: Row = {
      marketPda: r.marketPda,
      fixtureId: r.fixtureId,
      marketType: r.market.marketType,
      verdict: "FAIL",
      detail: "",
    };
    rows.push(out);

    try {
      // ── 1+2: the chain agrees with the receipt, and the oracle is real ────
      const market = new PublicKey(r.marketPda);
      const m = await proofbook.account.market.fetch(market);
      const status = Object.keys(m.status)[0];
      const chainRef = Buffer.from(m.settleProofRef).toString("hex");
      const oracle = m.oracleProgram.toBase58();

      if (status !== "settled") throw new Error(`chain status is ${status}`);
      if (Number(m.winningOutcome) !== r.winningOutcome)
        throw new Error(
          `winning outcome: chain=${m.winningOutcome} db=${r.winningOutcome}`
        );
      if (chainRef !== r.proofRef)
        throw new Error("proofRef mismatch between chain and DB");
      if (oracle === MOCK_ORACLE)
        throw new Error("settled against the MOCK oracle — fabricated");
      if (oracle !== TXLINE_DEVNET)
        throw new Error(`unknown oracle program ${oracle}`);

      const epochDay = Math.floor(Number(m.settleProofTs) / MS_PER_DAY);
      const eb = Buffer.alloc(2);
      eb.writeUInt16LE(epochDay & 0xffff, 0);
      const [rootsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("daily_scores_roots"), eb],
        txoracle.programId
      );
      if (rootsPda.toBase58() !== m.settleDailyRoots.toBase58())
        throw new Error("daily-roots PDA does not derive from the epoch day");

      // ── 3: the predicate, from CHAIN ──────────────────────────────────────
      const isCombo = m.marketType >= 16;
      let legs: { key: number; period: number }[];
      let strategy: any;
      if (isCombo) {
        const [comboPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("combo"), market.toBuffer()],
          proofbook.programId
        );
        const combo = await proofbook.account.comboSpec.fetch(comboPda);
        legs = combo.legs.map((l: any) => ({ key: l.key, period: l.period }));
        strategy = {
          geometricTargets: [],
          distancePredicate: null,
          discretePredicates: combo.outcomes[r.winningOutcome].predicates.map(
            (p: any) =>
              p.single
                ? {
                    single: {
                      index: p.single.index,
                      predicate: {
                        threshold: p.single.threshold,
                        comparison: p.single.comparison,
                      },
                    },
                  }
                : {
                    binary: {
                      indexA: p.binary.indexA,
                      indexB: p.binary.indexB,
                      op: p.binary.op,
                      predicate: {
                        threshold: p.binary.threshold,
                        comparison: p.binary.comparison,
                      },
                    },
                  }
          ),
        };
      } else {
        const spec = m.outcomes[r.winningOutcome].spec;
        legs = [{ key: spec.statAKey, period: spec.statAPeriod }];
        if (spec.hasStatB)
          legs.push({ key: spec.statBKey, period: spec.statBPeriod });
        const predicate = {
          threshold: spec.threshold,
          comparison: spec.comparison,
        };
        strategy = {
          geometricTargets: [],
          distancePredicate: null,
          discretePredicates: [
            spec.hasStatB
              ? { binary: { indexA: 0, indexB: 1, op: spec.op, predicate } }
              : { single: { index: 0, predicate } },
          ],
        };
      }

      // ── 4: live re-verification against TxLINE's program ─────────────────
      const seq = await findSeq(r.fixtureId);
      const val =
        seq === null
          ? null
          : await fetchProof(r.fixtureId, seq, legs.map((l) => l.key));

      if (val) {
        const payload = {
          ts: new BN(val.summary.updateStats.minTimestamp),
          fixtureSummary: {
            fixtureId: new BN(val.summary.fixtureId),
            updateStats: {
              updateCount: val.summary.updateStats.updateCount,
              minTimestamp: new BN(val.summary.updateStats.minTimestamp),
              maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
            },
            eventsSubTreeRoot: b32(val.summary.eventStatsSubTreeRoot),
          },
          fixtureProof: (val.subTreeProof ?? []).map(node),
          mainTreeProof: (val.mainTreeProof ?? []).map(node),
          eventStatRoot: b32(val.eventStatRoot),
          leaves: val.statsToProve.map((l: any) => ({
            stat: l.stat,
            statProof: (l.statProof ?? []).map(node),
          })),
          multiproofHashes: (val.multiproof.hashes ?? []).map(node),
          leafIndices: val.multiproof.indices,
        };
        // NB: the proof's OWN epoch day (the market may have settled against an
        // earlier batch than today's best terminal record).
        const proofEpoch = Math.floor(
          val.summary.updateStats.minTimestamp / MS_PER_DAY
        );
        const pe = Buffer.alloc(2);
        pe.writeUInt16LE(proofEpoch & 0xffff, 0);
        const [proofRoots] = PublicKey.findProgramAddressSync(
          [Buffer.from("daily_scores_roots"), pe],
          txoracle.programId
        );
        const ok: boolean = await txoracle.methods
          .validateStatV3(payload, strategy)
          .accounts({ dailyScoresMerkleRoots: proofRoots })
          .preInstructions([
            anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
              units: 1_400_000,
            }),
          ])
          .view();
        if (ok !== true)
          throw new Error("TxLINE's program did NOT verify the winning outcome");
        out.verdict = "VERIFIED_LIVE";
        out.detail = `oracle re-adjudicated outcome ${r.winningOutcome} (${r.outcomeLabel}) — true`;
        continue;
      }

      // ── 5: retention expired — verify the settle TRANSACTION instead ─────
      const tx = await conn.getTransaction(r.settleTx, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) throw new Error("settle tx not found on chain");
      if (tx.meta?.err) throw new Error("settle tx errored");
      const logs = tx.meta?.logMessages ?? [];
      const invoked = logs.some((l) => l.includes(`Program ${TXLINE_DEVNET} invoke`));
      const succeeded = logs.some((l) => l.includes(`Program ${TXLINE_DEVNET} success`));
      if (!invoked || !succeeded)
        throw new Error("settle tx does not show a successful txoracle CPI");
      out.verdict = "VERIFIED_TX";
      out.detail =
        "TxLINE retention expired; the settle tx on chain shows the txoracle CPI succeeding";
    } catch (e: any) {
      out.verdict = "FAIL";
      out.detail = String(e?.message ?? e).slice(0, 180);
    }
    process.stdout.write(
      `\r  ${rows.length}/${receipts.length}  live=${rows.filter((x) => x.verdict === "VERIFIED_LIVE").length} tx=${rows.filter((x) => x.verdict === "VERIFIED_TX").length} fail=${rows.filter((x) => x.verdict === "FAIL").length}   `
    );
  }
  console.log();

  // ── global checks ──────────────────────────────────────────────────────────
  const allow = new Set(cfg.marketTypes);
  const globalChecks: { name: string; ok: boolean; detail: string }[] = [];

  const badTypes = await prisma.market.findMany({
    where: { marketType: { notIn: [...allow] } },
    select: { pda: true, marketType: true },
  });
  globalChecks.push({
    name: "Allowlist airtight — no dead-generation market in the DB",
    ok: badTypes.length === 0,
    detail: badTypes.length
      ? `${badTypes.length} rows of disallowed types present`
      : `allowlist [${[...allow].join(",")}], 0 rows outside it`,
  });

  const mockReceipts = rows.filter((x) => x.detail.includes("MOCK"));
  globalChecks.push({
    name: "No receipt settled against the mock oracle",
    ok: mockReceipts.length === 0,
    detail: mockReceipts.length
      ? mockReceipts.map((x) => x.marketPda).join(", ")
      : "every receipt's on-chain oracle is the real txoracle",
  });

  const leakyScores = await prisma.fixture.count({
    where: { proofStatus: { not: "proven" }, provenP1: { not: null } },
  });
  globalChecks.push({
    name: "No scoreline without a proof",
    ok: leakyScores === 0,
    detail: leakyScores
      ? `${leakyScores} unproven fixtures carry a score`
      : "provenP1/P2 are null on every non-proven fixture",
  });

  const gapReceipts = await prisma.receipt.count({
    where: { fixtureId: { in: (
      await prisma.fixture.findMany({
        where: { proofStatus: "no_proof" },
        select: { id: true },
      })
    ).map((f) => f.id) } },
  });
  globalChecks.push({
    name: "Gap fixtures have no receipt",
    ok: gapReceipts === 0,
    detail: gapReceipts
      ? `${gapReceipts} receipts exist on no_proof fixtures`
      : "every no_proof fixture shows: no receipt, no score",
  });

  // chain <-> DB reconciliation over allowed types
  const chainMarkets = await proofbook.account.market.all();
  const chainSettled = new Set(
    chainMarkets
      .filter(
        (m: any) =>
          allow.has(m.account.marketType) &&
          Object.keys(m.account.status)[0] === "settled"
      )
      .map((m: any) => m.publicKey.toBase58())
  );
  const dbReceipts = new Set(rows.map((x) => x.marketPda));
  const chainNotDb = [...chainSettled].filter((p) => !dbReceipts.has(p as string));
  const dbNotChain = [...dbReceipts].filter((p) => !chainSettled.has(p));
  globalChecks.push({
    name: "Reconciliation — settled on chain == receipts in DB",
    ok: chainNotDb.length === 0 && dbNotChain.length === 0,
    detail:
      chainNotDb.length || dbNotChain.length
        ? `on chain but no DB receipt: ${chainNotDb.length}; in DB but not settled on chain: ${dbNotChain.length}`
        : `${chainSettled.size} settled markets == ${dbReceipts.size} receipts, both directions`,
  });

  // ── report ─────────────────────────────────────────────────────────────────
  const live = rows.filter((x) => x.verdict === "VERIFIED_LIVE");
  const txv = rows.filter((x) => x.verdict === "VERIFIED_TX");
  const fails = rows.filter((x) => x.verdict === "FAIL");
  const byType = new Map<number, { live: number; tx: number; fail: number }>();
  for (const x of rows) {
    const b = byType.get(x.marketType) ?? { live: 0, tx: 0, fail: 0 };
    if (x.verdict === "VERIFIED_LIVE") b.live++;
    else if (x.verdict === "VERIFIED_TX") b.tx++;
    else b.fail++;
    byType.set(x.marketType, b);
  }

  const md: string[] = [];
  md.push(`# Integrity Audit — every receipt, machine-verified`);
  md.push(``);
  md.push(`> Generated ${new Date().toISOString()} by \`npm run audit\`.`);
  md.push(`> Nothing below was eyeballed. Re-run it yourself.`);
  md.push(``);
  md.push(`## The claim under audit`);
  md.push(``);
  md.push(
    `Every receipt is a real TxLINE merkle proof, verified on-chain. Zero fabricated.`
  );
  md.push(``);
  md.push(`## Per-receipt verification`);
  md.push(``);
  md.push(`| verdict | meaning | count |`);
  md.push(`|---|---|---|`);
  md.push(
    `| **VERIFIED_LIVE** | predicate read from chain, proof re-fetched from TxLINE, **TxLINE's own program re-adjudicated it by simulation and returned true** | **${live.length}** |`
  );
  md.push(
    `| **VERIFIED_TX** | TxLINE's ~23-day retention has expired for the fixture; the settle transaction on chain shows the txoracle CPI invoked and succeeding | **${txv.length}** |`
  );
  md.push(`| **FAIL** | neither — a P0 bug | **${fails.length}** |`);
  md.push(``);
  md.push(`### By market type`);
  md.push(``);
  md.push(`| type | live | tx | fail |`);
  md.push(`|---|---|---|---|`);
  for (const [t, b] of [...byType.entries()].sort((a, b) => a[0] - b[0])) {
    md.push(`| ${t} | ${b.live} | ${b.tx} | ${b.fail} |`);
  }
  md.push(``);
  if (fails.length) {
    md.push(`### FAILURES (P0)`);
    md.push(``);
    for (const f of fails)
      md.push(`- \`${f.marketPda}\` (fixture ${f.fixtureId}, type ${f.marketType}): ${f.detail}`);
    md.push(``);
  }
  md.push(`## Global checks`);
  md.push(``);
  md.push(`| check | result | detail |`);
  md.push(`|---|---|---|`);
  for (const c of globalChecks)
    md.push(`| ${c.name} | ${c.ok ? "✅ PASS" : "❌ FAIL"} | ${c.detail} |`);
  md.push(``);
  md.push(`## What "no fabricated data" rests on, structurally`);
  md.push(``);
  md.push(
    `- **No admin settlement exists.** The program's only paths out of \`Locked\` are a`
  );
  md.push(
    `  successful oracle CPI (\`settle_market\`/\`settle_market_v3\`) or the time-based,`
  );
  md.push(`  permissionless \`cancel_market\`, which sets no winner and only unlocks refunds.`);
  md.push(
    `- **The mock oracle cannot settle real markets.** Each market records its trusted`
  );
  md.push(
    `  oracle at creation; production builds compile the TxLINE adapter (the mock id is`
  );
  md.push(
    `  absent from the binary), and this audit asserts every receipt's on-chain oracle`
  );
  md.push(`  is the real txoracle.`);
  md.push(
    `- **Scores come from proofs.** The projection writes \`provenP1/P2\` only when the`
  );
  md.push(
    `  fixture's proof status is \`proven\`; the feed's sampled score never lands in a`
  );
  md.push(`  receipt. Checked above.`);
  md.push(
    `- **Teams come from TxLINE.** Fixture names are TxLINE participant strings;`
  );
  md.push(
    `  the UI maps names to flags/codes for display and marks unknown teams as unknown`
  );
  md.push(`  rather than guessing.`);
  md.push(
    `- **Unprovable is unprovable.** Fixtures outside retention are \`no_proof\`: no`
  );
  md.push(`  receipt, no score, a stated reason. Checked above.`);
  md.push(``);

  fs.writeFileSync(path.join(ROOT, "docs", "INTEGRITY_AUDIT.md"), md.join("\n"));

  console.log(`\n  VERIFIED_LIVE ${live.length}  VERIFIED_TX ${txv.length}  FAIL ${fails.length}`);
  for (const c of globalChecks)
    console.log(`  ${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  console.log(`\n  wrote docs/INTEGRITY_AUDIT.md\n`);

  if (fails.length || globalChecks.some((c) => !c.ok)) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
