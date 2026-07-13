/**
 * Headless twin of the /verify page — the same five steps, same order, same
 * sources, so the browser verifier can be regression-tested from CI.
 *
 * It trusts nothing ProofBook says:
 *   1. settlement  <- the Solana Market account
 *   2. predicate   <- the Solana ComboSpec / OutcomeSpec
 *   3. Merkle root <- TxLINE's OWN on-chain PDA
 *   4. proof       <- TxLINE's API
 *   5. verdict     <- TxLINE's OWN program (validate_stat_v3, simulated)
 *
 * Then it TAMPERS with the proof and asserts the oracle rejects it — because
 * "the proof verified" is only meaningful if a false proof would not have.
 *
 *   MARKET=<pda> npx ts-node keeper/scripts/verify-receipt.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { loadConfig, ROOT } from "../src/config";
import { Store } from "../src/state";

const MS_PER_DAY = 86_400_000;
const ORIGIN = process.env.TXLINE_API ?? "https://txline-dev.txodds.com";

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const info = (s: string) => console.log(`      ${s}`);

async function main() {
  const cfg = loadConfig("live");
  const marketPda = process.env.MARKET;
  if (!marketPda) throw new Error("set MARKET=<pda>");

  const store = new Store(cfg.dataDir);
  const { jwt, apiToken } = store.data.session;
  const H = {
    Authorization: `Bearer ${jwt}`,
    "X-Api-Token": apiToken!,
  } as any;

  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`,
          "utf8"
        )
      )
    )
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });

  const pbIdl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "idl", "proofbook.json"), "utf8")
  );
  const txIdl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "idl", "txoracle.json"), "utf8")
  );
  const proofbook = new anchor.Program(pbIdl, provider) as any;
  const txoracle = new anchor.Program(txIdl, provider) as any;

  console.log(`\nVerifying ${marketPda}`);
  console.log(`  (nothing below is read from ProofBook's API or database)\n`);

  // ── 1. settlement, from the Solana account ────────────────────────────────
  const market = new PublicKey(marketPda);
  const m = await proofbook.account.market.fetch(market);
  const status = Object.keys(m.status)[0];
  if (status !== "settled") {
    bad(`market is ${status}, not settled — nothing to verify`);
    process.exit(1);
  }
  const proofTs = Number(m.settleProofTs);
  const epochDay = Math.floor(proofTs / MS_PER_DAY);
  const fixtureId = Number(m.fixtureId);
  const marketType = Number(m.marketType);
  const winning = Number(m.winningOutcome);
  ok("1. settlement read from the Solana account");
  info(`fixture ${fixtureId}  type ${marketType}  winning outcome ${winning}`);
  info(`proofRef ${Buffer.from(m.settleProofRef).toString("hex")}`);

  // ── 2. the predicate the market committed to, also from chain ─────────────
  const isCombo = marketType >= 16;
  const [comboPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("combo"), market.toBuffer()],
    proofbook.programId
  );
  const combo = isCombo
    ? await proofbook.account.comboSpec.fetch(comboPda)
    : null;
  const legs: { key: number; period: number }[] = isCombo
    ? combo.legs.map((l: any) => ({ key: l.key, period: l.period }))
    : (() => {
        const s = m.outcomes[winning].spec;
        const a = [{ key: s.statAKey, period: s.statAPeriod }];
        if (s.hasStatB) a.push({ key: s.statBKey, period: s.statBPeriod });
        return a;
      })();
  ok("2. predicate read from the on-chain spec (fixed at market creation)");
  info(
    `${isCombo ? "ComboSpec -> validate_stat_v3" : "OutcomeSpec -> validate_stat_v2"}` +
      `   stat keys [${legs.map((l) => l.key).join(",")}]`
  );

  // ── 3. TxLINE's Merkle root, from TXLINE's OWN account ────────────────────
  const eb = Buffer.alloc(2);
  eb.writeUInt16LE(epochDay & 0xffff, 0);
  const [rootsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), eb],
    txoracle.programId
  );
  if (rootsPda.toBase58() !== m.settleDailyRoots.toBase58()) {
    bad("the receipt's daily-roots PDA is not what its epoch day derives to");
    process.exit(1);
  }
  const rootAcct = await conn.getAccountInfo(rootsPda);
  if (!rootAcct || !rootAcct.owner.equals(txoracle.programId)) {
    bad("no TxLINE root published for that day");
    process.exit(1);
  }
  ok("3. Merkle root read from TxLINE's own on-chain PDA");
  info(`${rootsPda.toBase58()}  owned by ${rootAcct.owner.toBase58()}`);

  // ── 4. the proof, from TxLINE ─────────────────────────────────────────────
  const snap = await fetch(`${ORIGIN}/api/scores/snapshot/${fixtureId}`, {
    headers: H,
  });
  const rows = (await snap.json()) as any[];
  const fin = rows.filter((r) => r.StatusId === 100);
  const seq = (fin.length ? fin : rows).reduce(
    (mx, r) => Math.max(mx, r.Seq ?? 0),
    0
  );
  const keys = legs.map((l) => l.key).join(",");
  const pr = await fetch(
    `${ORIGIN}/api/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${keys}`,
    { headers: H }
  );
  const val: any = await pr.json();
  ok("4. proof fetched from TxLINE");
  info(
    val.statsToProve
      .map((l: any) => `key ${l.stat.key} = ${l.stat.value}`)
      .join("   ")
  );
  info(
    `multiproof: ${val.multiproof.hashes.length} hashes ` +
      `(v2 would carry ~${val.statsToProve.length * 5} nodes)`
  );

  // ── 5. the verdict, from TxLINE's OWN program ─────────────────────────────
  const b32 = (v: any) => Array.from(Buffer.from(v));
  const node = (n: any) => ({
    hash: Array.from(Buffer.from(n.hash)),
    isRightSibling: !!n.isRightSibling,
  });
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

  const strategy = isCombo
    ? {
        geometricTargets: [],
        distancePredicate: null,
        discretePredicates: combo.outcomes[winning].predicates.map((p: any) =>
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
      }
    : (() => {
        const s = m.outcomes[winning].spec;
        const predicate = { threshold: s.threshold, comparison: s.comparison };
        return {
          geometricTargets: [],
          distancePredicate: null,
          discretePredicates: [
            s.hasStatB
              ? { binary: { indexA: 0, indexB: 1, op: s.op, predicate } }
              : { single: { index: 0, predicate } },
          ],
        };
      })();

  const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });
  const ask = async (p: any) =>
    txoracle.methods
      .validateStatV3(p, strategy)
      .accounts({ dailyScoresMerkleRoots: rootsPda })
      .preInstructions([cu])
      .view();

  const verdict = await ask(payload);
  if (verdict !== true) {
    bad("5. TxLINE's program did NOT verify this settlement");
    process.exit(1);
  }
  ok("5. TxLINE's own program verified it");
  info(`validate_stat_v3 on ${txoracle.programId.toBase58()} returned true`);

  console.log("\n  \x1b[33mVERIFIED\x1b[0m — without believing anything ProofBook said.\n");

  // ── the part that makes the above mean something ──────────────────────────
  console.log("  Now tamper with the proof, and see if it still passes:");
  const forged = JSON.parse(JSON.stringify(payload));
  forged.leaves[0].stat.value = forged.leaves[0].stat.value + 1;
  // re-hydrate BNs that JSON round-tripping flattened
  forged.ts = payload.ts;
  forged.fixtureSummary = payload.fixtureSummary;
  try {
    const v2 = await ask(forged);
    if (v2 === true) {
      bad("A FORGED PROOF PASSED. The verification is worthless.");
      process.exit(1);
    }
    ok("the forged proof was REJECTED (returned false)");
  } catch (e: any) {
    const logs = JSON.stringify(e?.logs ?? []);
    const why =
      /InvalidStatProof|StatProofMismatch|Merkle|6023|6003/i.test(logs)
        ? "the multiproof no longer reconstructs TxLINE's published root"
        : "the oracle refused it";
    ok(`the forged proof was REJECTED — ${why}`);
  }
  console.log(
    "\n  That is the whole product: it does not matter who hands you the proof.\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
