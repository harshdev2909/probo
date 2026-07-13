/**
 * Project the chain into Postgres, once, on demand — markets, positions, and the
 * Proof Receipts that hang off them.
 *
 * The leader keeper does this every tick. This exists for when the leader is some
 * OTHER process (a deployed instance still on an older market-type allowlist, say)
 * and the chain has run ahead of what the database can see: the catalogue backfill
 * settles hundreds of markets, and if nothing projects them, the entire receipt
 * wall is invisible on the site while being perfectly real on-chain.
 *
 * Safe to run alongside the leader. Every write is an idempotent upsert of what
 * the chain already says. It settles nothing and it signs nothing.
 *
 *   npm run sync:now
 */
import { loadConfig } from "../src/config";
import { Store } from "../src/state";
import { Chain } from "../src/chain/proofbook";
import { DbSync } from "../src/db/sync";

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);
  const sync = new DbSync(cfg, chain, "sync-now");

  console.log(`\n  projecting market types [${cfg.marketTypes}]\n`);

  const { markets, settled } = await sync.syncMarkets();
  console.log(`  markets    ${markets} projected  (${settled} settled)`);

  const positions = await sync.syncPositions();
  console.log(`  positions  ${positions}`);

  let receipts = 0;
  for (;;) {
    const n = await sync.syncReceipts();
    receipts += n;
    if (n === 0) break;
    process.stdout.write(`\r  receipts   ${receipts} projected…`);
  }
  console.log(`\r  receipts   ${receipts} projected from chain    \n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
