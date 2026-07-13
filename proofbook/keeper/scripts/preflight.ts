/**
 * Settlement preflight — run this BEFORE a live fixture kicks off.
 *
 * `settle_market` routes a market to Cancelled (refundable) when the WINNING
 * outcome has zero staked pool. That is correct behaviour (there is nobody to
 * pay), but it means the market never earns a Proof Receipt — and it is decided
 * by which outcome happens to win, so it cannot be detected after the fact. It
 * silently voided 74 markets once already.
 *
 * The check is therefore per-OUTCOME, not per-market: a market can hold a large
 * total pool and still be voided because the one outcome nobody backed came in.
 *
 * Reports, for every market in the allowlisted generations that has not yet
 * locked: the pools, any zero-staked outcome, and whether the market is still
 * bettable. Exits non-zero if a live market is at risk, so it can gate a deploy.
 *
 *   npx ts-node keeper/scripts/preflight.ts            # allowlisted generations
 *   FIXTURE_IDS=18237038,18241006 npx ts-node ...      # just these fixtures
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { loadConfig, ROOT } from "../src/config";

async function main() {
  const cfg = loadConfig("live");
  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "idl", "proofbook.json"), "utf8")
  );
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const prog = new anchor.Program(
    idl,
    new anchor.AnchorProvider(
      conn,
      {
        publicKey: PublicKey.default,
        signTransaction: async (t: any) => t,
        signAllTransactions: async (t: any) => t,
      } as any,
      {}
    )
  );

  const only = (process.env.FIXTURE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const all = await (prog.account as any).market.all();
  const now = Math.floor(Date.now() / 1000);

  const live = all
    .filter((m: any) => cfg.marketTypes.includes(m.account.marketType))
    .filter((m: any) =>
      only.length ? only.includes(m.account.fixtureId.toString()) : true
    )
    .filter((m: any) => Object.keys(m.account.status)[0] === "open")
    .sort((a: any, b: any) => Number(a.account.lockTime) - Number(b.account.lockTime));

  console.log(
    `preflight — ${live.length} open market(s) in generation(s) [${cfg.marketTypes}]\n`
  );

  let atRisk = 0;
  for (const m of live) {
    const a = m.account;
    const pools: number[] = a.outcomes.map((o: any) => Number(o.pool));
    const zero = pools
      .map((p, i) => (p === 0 ? i : -1))
      .filter((i) => i >= 0);
    const lock = Number(a.lockTime);
    const hrs = ((lock - now) / 3600).toFixed(1);
    const usdc = (p: number) => (p / 1e6).toFixed(0);

    if (zero.length) {
      atRisk++;
      console.log(
        `  ✗ fixture ${a.fixtureId}  type=${a.marketType}  locks in ${hrs}h\n` +
          `      pools=[${pools.map(usdc).join(", ")}]  — outcome(s) ${zero.join(
            ","
          )} have ZERO stake.\n` +
          `      If one of them wins, this market CANCELS and earns no receipt.\n` +
          `      Fix: npm run seed:liquidity  (before lock_time)\n` +
          `      ${m.publicKey.toBase58()}`
      );
    } else {
      console.log(
        `  ✓ fixture ${a.fixtureId}  type=${a.marketType}  locks in ${hrs}h  ` +
          `pools=[${pools.map(usdc).join(", ")}] — every outcome staked`
      );
    }
  }

  if (atRisk) {
    console.log(
      `\n${atRisk} market(s) AT RISK of a zero-winning-pool cancellation.`
    );
    process.exit(1);
  }
  console.log("\nAll open markets have every outcome staked. Safe to settle.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
