import * as fs from "fs";
import * as path from "path";

import { KeeperConfig, ROOT } from "./config";
import { Logger } from "./logger";
import { Store } from "./state";
import { Chain } from "./chain/proofbook";
import { TxLineSession } from "./txline/session";
import { TxLineClient, normalizeUpdate } from "./txline/client";

/**
 * Records a real TxLINE fixture into a committed replay file: every score
 * update found for the fixture across a day's 5-minute intervals, the
 * finalised (statusId=100) record, and the REAL stat-validation proof for it.
 */
export async function capture(
  cfg: KeeperConfig,
  fixtureId: number,
  epochDay: number,
  outFile?: string
) {
  const log = new Logger("capture");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);
  const session = new TxLineSession(cfg, store, chain);
  await session.ensure();
  const client = new TxLineClient(session);

  log.info("scanning day for fixture updates", { fixtureId, epochDay });
  const events: any[] = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let interval = 0; interval < 12; interval++) {
      try {
        const batch = await client.scoresUpdates(
          epochDay,
          hour,
          interval,
          fixtureId
        );
        if (batch.length) {
          events.push(...batch);
          log.info(
            `+${batch.length} @ ${epochDay}/${hour}/${interval} (total ${events.length})`
          );
        }
      } catch {
        /* empty interval */
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  if (!events.length)
    throw new Error("no events captured — wrong epochDay or uncovered fixture");

  events.sort(
    (a, b) =>
      (a.Ts ?? a.ts ?? 0) - (b.Ts ?? b.ts ?? 0) ||
      (a.Seq ?? a.seq ?? 0) - (b.Seq ?? b.seq ?? 0)
  );
  const norm = events.map(normalizeUpdate).filter(Boolean) as any[];
  const finalised = norm.find((u) => u.statusId === 100);
  if (!finalised)
    throw new Error("no game_finalised (statusId=100) record found");
  const last = norm[norm.length - 1];
  log.info("finalised record", {
    seq: finalised.seq,
    ts: finalised.ts,
    score: finalised.score,
  });

  const statKeys = cfg.statKeys.join(",");
  const proof = await client.statValidation(
    fixtureId,
    finalised.seq,
    cfg.statKeys as any
  );
  const p1 = proof.statsToProve[0],
    p2 = proof.statsToProve[1];
  log.info("real proof captured", {
    stats: JSON.stringify(proof.statsToProve),
  });

  const fixture = {
    fixtureId,
    name: `Fixture ${fixtureId}`,
    capturedAt: new Date().toISOString(),
    finalisedSeq: finalised.seq,
    finalScore: { p1: p1.value, p2: p2.value },
    finalisedTsMs: proof.summary.updateStats.minTimestamp,
    events,
    realProof: { request: { seq: finalised.seq, statKeys }, response: proof },
    provenance: {
      note: "Real TxLINE devnet data. This fixture was settled trustlessly on devnet via the live validate_stat_v2 CPI.",
      lastEvent: { seq: last.seq, score: last.score, statusId: last.statusId },
    },
  };

  const file =
    outFile || path.join(ROOT, "keeper", "fixtures", `${fixtureId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
  log.info("replay fixture written", { file, events: events.length });
  return file;
}
