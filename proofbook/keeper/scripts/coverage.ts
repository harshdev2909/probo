/**
 * PHASE 0 deliverable: scan ALL World Cup fixtures and write the honest
 * coverage matrix to docs/COVERAGE.md. Also caches the plan to
 * keeper/data/plan.json for the seeder + backfiller to consume.
 */
import * as fs from "fs";
import * as path from "path";

import { loadConfig, ROOT } from "../src/config";
import { Logger } from "../src/logger";
import { Store } from "../src/state";
import { Chain } from "../src/chain/proofbook";
import { TxLineSession } from "../src/txline/session";
import { TxLineClient } from "../src/txline/client";
import { loadWorldCupFixtures } from "../src/txline/fixtures";
import { planAll, type FixturePlan } from "../src/backfill/plan";
import { stageOf } from "../../data/tournament";

const log = new Logger("coverage");

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);
  const session = new TxLineSession(cfg, store, chain);
  await session.ensure();
  const client = new TxLineClient(session);

  const fixtures = await loadWorldCupFixtures(session, cfg.competitionId, log, {
    refresh: process.argv.includes("--refresh"),
  });
  log.info(`planning ${fixtures.length} fixtures…`);

  const plans = await planAll(fixtures, session, client, chain.connection, log);

  fs.writeFileSync(
    path.join(ROOT, "keeper", "data", "plan.json"),
    JSON.stringify(plans, null, 2)
  );

  const by = (s: string) => plans.filter((p) => p.status === s);
  const settleable = by("settleable");
  const noProof = by("no_proof");
  const noRoot = by("no_root");
  const notFinished = by("not_finished");
  const today = Math.floor(Date.now() / 86_400_000);

  const row = (p: FixturePlan) => {
    const d = new Date(p.kickoffMs).toISOString().slice(0, 10);
    const score = p.goals ? `**${p.goals.p1}–${p.goals.p2}**` : "—";
    const badge =
      p.status === "settleable"
        ? "✅ real proof"
        : p.status === "no_proof"
        ? "⚪️ no proof (honest gap)"
        : p.status === "no_root"
        ? "🟠 root missing"
        : "🕒 upcoming";
    return `| ${p.fixtureId} | ${stageOf(p.kickoffMs)} | ${d} | ${
      p.p1Name ?? "?"
    } v ${p.p2Name ?? "?"} | ${score} | ${p.terminalLabel ?? "—"} | ${
      p.period ?? "—"
    } | ${p.seq ?? "—"} | ${badge} |`;
  };

  const md = `# Coverage matrix — what we can settle with a REAL TxLINE proof

_Generated ${new Date().toISOString()} · today = epoch day ${today} · TxLINE devnet, free World Cup tier._

## Headline

| | count |
|---|---|
| Fixtures returned by TxLINE (competition ${cfg.competitionId}) | **${
    fixtures.length
  }** |
| ✅ **Settleable with a REAL proof** | **${settleable.length}** |
| ⚪️ No proof obtainable (outside retention) | ${noProof.length} |
| 🟠 Proof but no on-chain root | ${noRoot.length} |
| 🕒 Not finished (upcoming / in play) | ${notFinished.length} |

## What we learned probing the live API

**1. Fixture list.** \`GET /fixtures/snapshot?competitionId=${
    cfg.competitionId
  }&startEpochDay=20600\` returns
**${
    fixtures.length
  } fixtures**. Without \`startEpochDay\` the API returns only the immediate window (2).
Each carries \`FixtureId, StartTime, Participant1/2Id, Participant1/2 (names), CompetitionId\` —
so team identity comes straight from TxLINE, no guessing.

**2. Score retention is ~23 days.** Fixtures older than that return **zero** score records
(\`/scores/snapshot/{id}\` → empty). Their results are therefore **not provable** and we mark
them honestly rather than fabricate a receipt.

**3. The \`statusId=100\` (game_finalised) record is only retained ~10 days.** Older-but-retained
fixtures no longer carry it. **However** they still carry a terminal *match-ended* record:

| statusId | meaning | usable as the final? |
|---|---|---|
| \`100\` | game_finalised (method-agnostic) | yes — most authoritative |
| \`13\` | ended after penalties | yes |
| \`10\` | ended after extra time | yes |
| \`5\` | ended in regulation | yes |

We take the **highest-authority terminal record available** and prove *its* goal stats. This is
what unlocks the bulk of the backfill: a \`statusId=5\` record proves the full-time score with a
real Merkle proof at \`period=5\`.

**4. The snapshot's \`Score\` object is sampled and unreliable** (it often shows \`0-0\` for a match
the proof shows as \`0-2\`). We therefore settle **only on the proven stat values**, never on the
feed's score field.

**5. On-chain daily roots persist.** The oracle's \`daily_scores_roots\` PDA exists on devnet for
every epoch day we could fetch a proof for (verified back to epoch day 20624).

## Honest gaps

${
  noProof.length === 0
    ? "_None._"
    : `${noProof.length} fixtures cannot be settled because TxLINE no longer retains their score data.
We show the fixture and its real-world result where known, but **with no Proof Receipt** and a
clear \`Historical — proof outside TxLINE retention\` marker. A fabricated receipt would destroy
the product's entire thesis, so we do not produce one.`
}

## Full matrix

| fixture | stage | date | teams | proven score | terminal record | period | seq | verdict |
|---|---|---|---|---|---|---|---|---|
${plans.map(row).join("\n")}
`;

  fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "docs", "COVERAGE.md"), md);

  log.info("═══════════════════════════════════════");
  log.info(
    `SETTLEABLE WITH REAL PROOF: ${settleable.length} / ${fixtures.length}`
  );
  log.info(`no proof (honest gap):      ${noProof.length}`);
  log.info(`no on-chain root:           ${noRoot.length}`);
  log.info(`not finished:               ${notFinished.length}`);
  log.info("wrote docs/COVERAGE.md + keeper/data/plan.json");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e?.response?.data || e);
    process.exit(1);
  }
);
