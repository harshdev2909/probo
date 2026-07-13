/**
 * DECISIVE PROBE: does validate_stat_v3 enforce "every stat covered exactly once"?
 *
 * If it does, a parlay's legs must read DISJOINT stats — which makes
 * "Home win AND over 2.5 goals" (both read goals P1/P2) impossible in one call,
 * while "over 9.5 corners AND under 3.5 cards" (disjoint) is fine.
 *
 * Run against the REAL txoracle on devnet with .view() — no writes.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";

const IDL = "/private/tmp/claude-501/-Volumes-Extreme-SSD-probo/fd28259b-3764-46f9-a6ff-bd0a45da9489/scratchpad/txonchain/examples/devnet/idl/txoracle.json";
const ORIGIN = "https://txline-dev.txodds.com/api";
const FIX = 18218149;
const SEQ = 1087;

const parseHash = (h: any) => {
  const raw = h?.hash ?? h;
  if (typeof raw === "string")
    return Array.from(
      raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64")
    );
  return Array.from(raw as number[]);
};
const mapProof = (p: any[]) =>
  (p || []).map((n) => ({
    hash: parseHash(n),
    isRightSibling: !!n.isRightSibling,
  }));

async function main() {
  const st = JSON.parse(
    fs.readFileSync("keeper/data/devnet/state.json", "utf8")
  );
  const { jwt, apiToken } = st.session;
  const H = {
    Authorization: `Bearer ${jwt}`,
    "X-Api-Token": apiToken,
  } as any;

  // stats: goals P1(1), goals P2(2), corners P1(7), corners P2(8)
  const KEYS = "1,2,7,8";
  const res = await fetch(
    `${ORIGIN}/scores/stat-validation-v3?fixtureId=${FIX}&seq=${SEQ}&statKeys=${KEYS}`,
    { headers: H }
  );
  const v: any = await res.json();
  console.log(
    "leaves:",
    v.statsToProve.map((l: any) => `${l.stat.key}=${l.stat.value}`).join("  ")
  );

  const idl = JSON.parse(fs.readFileSync(IDL, "utf8"));
  const conn = new Connection(process.env.RPC_URL!, "confirmed");
  // .view() simulates a real transaction — the fee payer must exist and be
  // funded, or simulation fails with an empty error before the program runs.
  const secret = JSON.parse(
    fs.readFileSync(
      process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`,
      "utf8"
    )
  );
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log("fee payer:", kp.publicKey.toBase58());
  const prog = new anchor.Program(
    idl,
    new anchor.AnchorProvider(conn, new anchor.Wallet(kp), {
      commitment: "confirmed",
    })
  );

  const ts = v.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(ts / 86_400_000);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    prog.programId
  );

  const payload = {
    ts: new BN(ts),
    fixtureSummary: {
      fixtureId: new BN(v.summary.fixtureId),
      updateStats: {
        updateCount: v.summary.updateStats.updateCount,
        minTimestamp: new BN(v.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: parseHash(v.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(v.subTreeProof),
    mainTreeProof: mapProof(v.mainTreeProof),
    eventStatRoot: parseHash(v.eventStatRoot),
    leaves: v.statsToProve.map((l: any) => ({
      stat: l.stat,
      statProof: mapProof(l.statProof),
    })),
    multiproofHashes: mapProof(v.multiproof.hashes),
    leafIndices: v.multiproof.indices,
  };

  const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });
  const run = async (label: string, strategy: any) => {
    try {
      const ok = await (prog.methods as any)
        .validateStatV3(payload, strategy)
        .accounts({ dailyScoresMerkleRoots: pda })
        .preInstructions([cu])
        .view();
      console.log(`  ${ok ? "PASSED" : "REJECTED(false)"}  ${label}`);
    } catch (e: any) {
      console.log(`  ERROR   ${label}`);
      console.log("     name:", e?.name, "| msg:", String(e?.message).slice(0, 200));
      if (e?.error) console.log("     anchorError:", JSON.stringify(e.error).slice(0, 300));
      const logs = e?.logs || e?.simulationResponse?.logs;
      if (logs) console.log("     logs:", JSON.stringify(logs.slice(-6)));
    }
  };

  const GT = (t: number) => ({ threshold: t, comparison: { greaterThan: {} } });
  const LT = (t: number) => ({ threshold: t, comparison: { lessThan: {} } });

  console.log("\n--- A: DISJOINT coverage (goals 0,1 | corners 2,3) ---");
  console.log("    'home win AND over 9.5 corners'");
  await run("disjoint 2-leg", {
    geometricTargets: [],
    distancePredicate: null,
    discretePredicates: [
      { binary: { indexA: 0, indexB: 1, op: { subtract: {} }, predicate: GT(0) } },
      { binary: { indexA: 2, indexB: 3, op: { add: {} }, predicate: GT(9) } },
    ],
  });

  console.log("\n--- B: DUPLICATE coverage (goals 0,1 used TWICE) ---");
  console.log("    'home win AND over 2.5 goals'  <-- the task's own example");
  await run("duplicate 2-leg", {
    geometricTargets: [],
    distancePredicate: null,
    discretePredicates: [
      { binary: { indexA: 0, indexB: 1, op: { subtract: {} }, predicate: GT(0) } },
      { binary: { indexA: 0, indexB: 1, op: { add: {} }, predicate: GT(2) } },
    ],
  });

  console.log("\n--- C: INCOMPLETE coverage (corners 2,3 left uncovered) ---");
  await run("incomplete", {
    geometricTargets: [],
    distancePredicate: null,
    discretePredicates: [
      { binary: { indexA: 0, indexB: 1, op: { subtract: {} }, predicate: GT(0) } },
    ],
  });

  console.log("\n--- D: disjoint parlay that should be TRUE ---");
  console.log("    'home win AND over 3.5 corners'  (2-1, corners 5+1=6)");
  await run("TRUE 2-leg parlay", {
    geometricTargets: [],
    distancePredicate: null,
    discretePredicates: [
      { binary: { indexA: 0, indexB: 1, op: { subtract: {} }, predicate: GT(0) } },
      { binary: { indexA: 2, indexB: 3, op: { add: {} }, predicate: GT(3) } },
    ],
  });
}

main().then(() => process.exit(0));
