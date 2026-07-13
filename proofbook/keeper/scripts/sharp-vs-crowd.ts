/**
 * SHARP vs CROWD, on the real semi-final.
 *
 * Sharp: TxLINE's demargined consensus (a SECOND TxLINE feed — nothing to do
 *        with the scores feed that settles markets).
 * Crowd: ProofBook's own parimutuel pools.
 *
 *   npx ts-node keeper/scripts/sharp-vs-crowd.ts
 */
import { loadConfig } from "../src/config";
import { Store } from "../src/state";
import { Chain } from "../src/chain/proofbook";
import { TxLineSession } from "../src/txline/session";
import { TxLineClient } from "../src/txline/client";
import { fetchConsensus, crowdImplied, divergence } from "../src/markets/odds";

const SEMIS: Record<number, string> = {
  18237038: "France v Spain",
  18241006: "England v Argentina",
};
const LABELS = ["Home", "Draw", "Away"];

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);
  const session = new TxLineSession(cfg, store, chain);
  await session.ensure();
  const client = new TxLineClient(session);

  const all = await chain.allMarkets();

  for (const [idStr, name] of Object.entries(SEMIS)) {
    const fixtureId = Number(idStr);
    console.log(`\n${"═".repeat(64)}\n  ${name}   (fixture ${fixtureId})\n${"═".repeat(64)}`);

    const c = await fetchConsensus(client, fixtureId);
    if (!c) {
      console.log(
        "  TxLINE publishes no odds for this fixture yet.\n" +
          "  So there is no consensus line, and we show none. We do not invent one."
      );
      continue;
    }

    // The 1X2 market of the live generation.
    const m = all.find(
      (x: any) =>
        Number(x.account.fixtureId) === fixtureId &&
        cfg.marketTypes.includes(x.account.marketType) &&
        x.account.outcomes.length === 3
    );
    if (!m) {
      console.log("  no 1X2 market for this fixture in the live generation");
      continue;
    }

    const pools = m.account.outcomes.map((o: any) => Number(o.pool));
    const crowd = crowdImplied(pools);
    const div = divergence(crowd, c.pct);

    console.log(`  consensus book : ${c.bookmaker}`);
    console.log(`  market         : ${m.publicKey.toBase58()}\n`);
    console.log("           SHARP (TxLINE)   CROWD (ProofBook)   DIVERGENCE");
    console.log("           ──────────────   ─────────────────   ──────────");
    LABELS.forEach((l, i) => {
      const s = (c.pct[i] * 100).toFixed(1) + "%";
      const cr = (crowd[i] * 100).toFixed(1) + "%";
      const d = div[i] * 100;
      const arrow = d > 2 ? "crowd HIGH" : d < -2 ? "crowd LOW " : "aligned   ";
      console.log(
        `  ${l.padEnd(7)}  ${s.padStart(12)}   ${cr.padStart(17)}   ` +
          `${(d >= 0 ? "+" : "") + d.toFixed(1)}pp  ${arrow}`
      );
    });

    const sum = c.pct.reduce((a, b) => a + b, 0);
    console.log(
      `\n  sharp probabilities sum to ${sum.toFixed(4)} — demargined, so this is a` +
        `\n  real probability, not a padded price. That is what makes the` +
        `\n  divergence column mean something.`
    );
    const edge = div
      .map((d, i) => ({ d, i }))
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    console.log(
      `\n  biggest edge: the crowd rates ${LABELS[edge.i]} ` +
        `${Math.abs(edge.d * 100).toFixed(1)}pp ${edge.d > 0 ? "higher" : "lower"} than the sharps do.`
    );
  }
  console.log(
    "\n  Display only. No price ever touches a proof, a predicate, or a receipt.\n"
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
