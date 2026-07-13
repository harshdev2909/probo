/**
 * REGRESSION GUARD for the invariant that matters most:
 *
 *   "The 76 existing receipts must survive intact. Never regress them."
 *
 * The program upgrade raised MAX_OUTCOMES 8 -> 12 and added a ComboSpec account.
 * The claim is that this is ALLOCATION-only: `#[max_len]` sizes new accounts but
 * is not part of the serialized layout (a Borsh Vec is a u32 length prefix plus
 * that many elements), so the ~226 Market accounts already on devnet — including
 * every settled one holding a Proof Receipt — must still deserialize byte-for-byte
 * under the NEW IDL.
 *
 * This asserts that against the real chain rather than trusting the argument.
 * It reads every Market account with the new IDL and checks that the settled ones
 * still expose an intact receipt (winning outcome, proof ref, daily roots, resolver).
 *
 *   RPC_URL=... npx ts-node keeper/scripts/verify-legacy-accounts.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { loadConfig, ROOT } from "../src/config";

async function main() {
  const cfg = loadConfig("live");
  // Deliberately the FRESHLY BUILT idl, not the committed one — that is the
  // whole point: does the new layout still read the old accounts?
  const idlPath = path.join(ROOT, "target", "idl", "proofbook.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  console.log(`IDL: ${idlPath}`);
  console.log(
    `     instructions: ${idl.instructions.length}, accounts: ${idl.accounts
      .map((a: any) => a.name)
      .join(", ")}`
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

  let all: any[];
  try {
    all = await (prog.account as any).market.all();
  } catch (e: any) {
    console.error("\n✗ FATAL: could not deserialize Market accounts with the new IDL.");
    console.error("  The upgrade CHANGED THE LAYOUT and would destroy the receipts.");
    console.error(" ", e?.message || e);
    process.exit(1);
  }

  const settled = all.filter(
    (m: any) => Object.keys(m.account.status)[0] === "settled"
  );
  const inAllowlist = settled.filter((m: any) =>
    cfg.marketTypes.includes(m.account.marketType)
  );

  console.log(
    `\nread ${all.length} Market accounts with the NEW IDL — all deserialized.`
  );
  console.log(`  settled: ${settled.length}`);
  console.log(
    `  settled in the live allowlist [${cfg.marketTypes}]: ${inAllowlist.length}  <- the receipt wall`
  );

  // Every settled market must still expose an intact, non-zero receipt.
  const HEX32 = /^[0-9a-f]{64}$/;
  let broken = 0;
  for (const m of settled) {
    const a = m.account;
    const proofRef = Buffer.from(a.settleProofRef).toString("hex");
    const problems: string[] = [];
    if (a.winningOutcome === 255) problems.push("winningOutcome unset");
    if (!HEX32.test(proofRef) || /^0+$/.test(proofRef))
      problems.push("proofRef empty/invalid");
    if (a.settleDailyRoots.equals(PublicKey.default))
      problems.push("dailyRoots unset");
    if (a.settleResolver.equals(PublicKey.default))
      problems.push("resolver unset");
    if (Number(a.settleProofTs) <= 0) problems.push("proofTs unset");
    if (problems.length) {
      broken++;
      console.log(`  ✗ ${m.publicKey.toBase58()} — ${problems.join(", ")}`);
    }
  }

  if (broken) {
    console.log(`\n✗ ${broken} settled market(s) have a damaged receipt.`);
    process.exit(1);
  }

  const sample = inAllowlist[0];
  if (sample) {
    const a = sample.account;
    console.log("\nsample receipt, read through the new IDL:");
    console.log(`  market        ${sample.publicKey.toBase58()}`);
    console.log(`  fixture       ${a.fixtureId}  (type ${a.marketType})`);
    console.log(`  outcomes      ${a.outcomes.length}   winning: ${a.winningOutcome}`);
    console.log(
      `  proofRef      ${Buffer.from(a.settleProofRef).toString("hex")}`
    );
    console.log(`  epochDay      ${a.settleEpochDay}`);
    console.log(`  dailyRoots    ${a.settleDailyRoots.toBase58()}`);
    console.log(`  resolver      ${a.settleResolver.toBase58()}`);
  }

  console.log(
    `\n✓ All ${settled.length} settled markets intact under the new layout. ` +
      `The ${inAllowlist.length} receipts survive.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
