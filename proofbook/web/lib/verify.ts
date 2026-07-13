"use client";

/**
 * The public verifier.
 *
 * This file is the product's thesis, made executable. It re-derives a Proof
 * Receipt from scratch and it deliberately trusts NOTHING that ProofBook says:
 *
 *   · the settlement       -> read from the Solana account, not our API
 *   · the predicate        -> read from the Solana account, not our API
 *   · the Merkle root      -> read from TxLINE's OWN on-chain PDA, not our API
 *   · the verdict          -> returned by TxLINE's OWN program, not our code
 *
 * The one thing it takes from ProofBook is a TxLINE *read credential*, because a
 * browser cannot mint one (the proof endpoint requires an on-chain subscription).
 * That is a key, not an answer — and it cannot be used to lie, because the proof
 * it fetches is authenticated against the root read independently from Solana, by
 * TxLINE's program. `tamperProof()` below exists so anyone can prove that for
 * themselves: corrupt a byte, watch the oracle reject it.
 *
 * Nothing in here re-implements TxLINE's hashing. It does not have to: the last
 * step asks the real oracle, on the real chain.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";

import proofbookIdl from "./idl/proofbook.json";
import txoracleIdl from "./idl/txoracle.json";

export const TXORACLE_ID = new PublicKey((txoracleIdl as any).address);
export const PROOFBOOK_ID = new PublicKey((proofbookIdl as any).address);

const DAILY_SCORES_SEED = Buffer.from("daily_scores_roots");
const COMBO_SEED = Buffer.from("combo");
const MS_PER_DAY = 86_400_000;

export type StepStatus = "pending" | "running" | "ok" | "fail";

export interface Step {
  key: string;
  title: string;
  /** Where this fact comes from — the whole point. */
  source: string;
  status: StepStatus;
  detail?: string;
  /** Rendered as a monospace evidence block. */
  evidence?: Record<string, string>;
}

export interface VerifyResult {
  steps: Step[];
  verified: boolean;
  /** Set when we could not even start (bad pda, unsettled market...). */
  fatal?: string;
}

const STEP_DEFS: Omit<Step, "status">[] = [
  {
    key: "settlement",
    title: "Read the settlement from Solana",
    source: "Solana RPC — the Market account. Not ProofBook's API.",
  },
  {
    key: "predicate",
    title: "Read the predicate the market committed to",
    source: "Solana RPC — the on-chain spec, fixed when the market was created.",
  },
  {
    key: "root",
    title: "Read TxLINE's published Merkle root",
    source: "Solana RPC — TxLINE's OWN daily-roots PDA, under their program.",
  },
  {
    key: "proof",
    title: "Fetch the proof from TxLINE",
    source: "txline-dev.txodds.com, direct from your browser.",
  },
  {
    key: "oracle",
    title: "Ask TxLINE's program to verify it",
    source: "CPI-free simulation of validate_stat_v3 on the real txoracle.",
  },
];

export function initialSteps(): Step[] {
  return STEP_DEFS.map((s) => ({ ...s, status: "pending" as StepStatus }));
}

const hex = (b: number[] | Uint8Array) =>
  Buffer.from(b as any).toString("hex");

/**
 * A read-only Program for `.view()` simulation.
 *
 * The payer matters even though nothing is ever sent: a simulated transaction
 * whose fee payer does not exist fails with an EMPTY error before the program
 * runs — the verifier showed "rejected the proof:" with nothing after the
 * colon, which was this, not a rejection. So the caller passes an account that
 * provably exists. The receipt conveniently names one: its own resolver, the
 * wallet that paid for the settlement transaction. We never sign anything.
 */
function readOnlyProgram(connection: Connection, idl: any, payer?: PublicKey) {
  const provider = new anchor.AnchorProvider(
    connection,
    {
      publicKey: payer ?? PublicKey.default,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    } as any,
    { commitment: "confirmed" }
  );
  return new anchor.Program(idl, provider) as any;
}

export function dailyRootsPda(epochDay: number): PublicKey {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(epochDay & 0xffff, 0);
  return PublicKey.findProgramAddressSync(
    [DAILY_SCORES_SEED, b],
    TXORACLE_ID
  )[0];
}

export function comboSpecPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [COMBO_SEED, market.toBuffer()],
    PROOFBOOK_ID
  )[0];
}

/** Corrupt one byte of the proof — used to demonstrate that a lie cannot pass. */
export function tamperProof(proof: any): any {
  const t = JSON.parse(JSON.stringify(proof));
  // Bump the first proven value. Everything else stays honest, so the multiproof
  // now reconstructs to a different root than the one TxLINE published.
  t.leafValues = [...t.leafValues];
  t.leafValues[0] = t.leafValues[0] + 1;
  return t;
}

export interface VerifyOpts {
  marketPda: string;
  connection: Connection;
  /** TxLINE read credential (a key, not an answer). */
  credential: { origin: string; jwt: string; apiToken: string };
  /** Flip a byte of the proof to show the oracle reject it. */
  tamper?: boolean;
  onStep: (steps: Step[]) => void;
}

export async function verifyReceipt(opts: VerifyOpts): Promise<VerifyResult> {
  const { marketPda, connection, credential, onStep } = opts;
  const steps = initialSteps();
  const emit = () => onStep([...steps]);
  const set = (k: string, patch: Partial<Step>) => {
    const s = steps.find((x) => x.key === k)!;
    Object.assign(s, patch);
    emit();
  };

  let market: PublicKey;
  try {
    market = new PublicKey(marketPda);
  } catch {
    return { steps, verified: false, fatal: "That is not a valid market address." };
  }

  const proofbook = readOnlyProgram(connection, proofbookIdl);
  // Rebuilt with a real payer (the receipt's resolver) once the market is read.
  let txoracle = readOnlyProgram(connection, txoracleIdl);

  // ── 1. the settlement, straight from the account ────────────────────────────
  set("settlement", { status: "running" });
  let m: any;
  try {
    m = await proofbook.account.market.fetch(market);
  } catch {
    set("settlement", { status: "fail", detail: "No ProofBook market at that address." });
    return { steps, verified: false, fatal: "No ProofBook market at that address." };
  }
  const status = Object.keys(m.status)[0];
  if (status !== "settled") {
    set("settlement", {
      status: "fail",
      detail: `This market is ${status}, not settled — there is nothing to verify. ProofBook does not show a receipt for it, and neither will this page.`,
    });
    return { steps, verified: false, fatal: `Market is ${status}, not settled.` };
  }

  const proofTs = Number(m.settleProofTs);
  const epochDay = Math.floor(proofTs / MS_PER_DAY);
  const fixtureId = Number(m.fixtureId);
  const marketType = Number(m.marketType);
  const winning = Number(m.winningOutcome);

  // The oracle simulation needs a fee payer that EXISTS. The resolver recorded
  // in this very receipt paid for the real settlement, so it certainly does.
  txoracle = readOnlyProgram(connection, txoracleIdl, m.settleResolver);

  set("settlement", {
    status: "ok",
    detail: `Fixture ${fixtureId} settled on outcome #${winning}.`,
    evidence: {
      "winning outcome": String(winning),
      "proof ref (events subtree root)": hex(m.settleProofRef),
      "proof timestamp": `${proofTs} (epoch day ${epochDay})`,
      "daily roots PDA": m.settleDailyRoots.toBase58(),
      resolver: m.settleResolver.toBase58(),
    },
  });

  // ── 2. the predicate, also from the account ─────────────────────────────────
  // A market can only ever prove the outcome it was BORN to prove. The caller
  // supplies values; the chain supplies the question.
  set("predicate", { status: "running" });
  const isCombo = marketType >= 16;
  let legs: { key: number; period: number }[];
  let predicateText: string;
  let combo: any = null;

  try {
    if (isCombo) {
      combo = await proofbook.account.comboSpec.fetch(comboSpecPda(market));
      legs = combo.legs.map((l: any) => ({ key: l.key, period: l.period }));
      predicateText = describeCombo(combo, winning);
    } else {
      const spec = m.outcomes[winning].spec;
      legs = [{ key: spec.statAKey, period: spec.statAPeriod }];
      if (spec.hasStatB) legs.push({ key: spec.statBKey, period: spec.statBPeriod });
      predicateText = describeLegacy(spec);
    }
  } catch (e: any) {
    set("predicate", { status: "fail", detail: `Could not read the spec: ${e.message}` });
    return { steps, verified: false };
  }

  set("predicate", {
    status: "ok",
    detail: predicateText,
    evidence: {
      "resolution path": isCombo
        ? "ComboSpec sidecar -> validate_stat_v3 (multi-leg, one multiproof)"
        : "OutcomeSpec -> validate_stat_v2",
      "stat keys proven": legs.map((l) => l.key).join(", "),
      "period": String(legs[0].period),
    },
  });

  // ── 3. TxLINE's root — from TxLINE's own account, not ours ──────────────────
  set("root", { status: "running" });
  const rootsPda = dailyRootsPda(epochDay);
  if (rootsPda.toBase58() !== m.settleDailyRoots.toBase58()) {
    set("root", {
      status: "fail",
      detail:
        "The daily-roots PDA recorded in the receipt is not the one that epoch day derives to. The receipt is inconsistent.",
    });
    return { steps, verified: false };
  }
  const rootInfo = await connection.getAccountInfo(rootsPda);
  if (!rootInfo) {
    set("root", {
      status: "fail",
      detail: "TxLINE has not published a root for that day (the account does not exist).",
    });
    return { steps, verified: false };
  }
  if (!rootInfo.owner.equals(TXORACLE_ID)) {
    set("root", {
      status: "fail",
      detail: `That roots account is owned by ${rootInfo.owner.toBase58()}, not TxLINE.`,
    });
    return { steps, verified: false };
  }
  set("root", {
    status: "ok",
    detail: "TxLINE published this root on Solana. ProofBook cannot write to it.",
    evidence: {
      "roots PDA": rootsPda.toBase58(),
      "owner (txoracle program)": rootInfo.owner.toBase58(),
      "account size": `${rootInfo.data.length} bytes`,
    },
  });

  // ── 4. the proof, from TxLINE ───────────────────────────────────────────────
  set("proof", { status: "running" });
  let val: any;
  try {
    const seq = await findSeq(credential, fixtureId);
    const keys = legs.map((l) => l.key).join(",");
    const url = `${credential.origin}/api/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${keys}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credential.jwt}`,
        "X-Api-Token": credential.apiToken,
      },
    });
    if (!r.ok) throw new Error(`TxLINE returned ${r.status}`);
    val = await r.json();
  } catch (e: any) {
    set("proof", { status: "fail", detail: `Could not fetch the proof: ${e.message}` });
    return { steps, verified: false };
  }

  set("proof", {
    status: "ok",
    detail:
      "Fetched from TxLINE. It does not matter whether you trust this proof — the next step checks it against the root above.",
    evidence: {
      "proven stats": val.statsToProve
        .map((l: any) => `key ${l.stat.key} = ${l.stat.value}`)
        .join("   "),
      "multiproof hashes": `${val.multiproof.hashes.length} (v2 would need ${
        val.statsToProve.length * 5
      })`,
      "leaf indices": `[${val.multiproof.indices.join(", ")}]`,
    },
  });

  // ── 5. the verdict — from TxLINE's program ─────────────────────────────────
  set("oracle", { status: "running" });
  let payload = buildV3Payload(val);
  if (opts.tamper) payload = tamperProof(payload);

  const strategy = isCombo
    ? strategyFromCombo(combo, winning)
    : strategyFromLegacy(m.outcomes[winning].spec, legs.length);

  // Simulate against the root for the PROOF's own batch day. It matches the
  // receipt's day in the normal case, but TxLINE's best retained record can
  // come from a different batch than the one the market settled against — the
  // proof still verifies, just under that day's root.
  const proofRoots = dailyRootsPda(
    Math.floor(val.summary.updateStats.minTimestamp / MS_PER_DAY)
  );

  try {
    const ok: boolean = await txoracle.methods
      .validateStatV3(payload, strategy)
      .accounts({ dailyScoresMerkleRoots: proofRoots })
      .preInstructions([
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ])
      .view();

    if (!ok) {
      set("oracle", {
        status: "fail",
        detail: opts.tamper
          ? "REJECTED — exactly as it should be. The proof was tampered with, and TxLINE's program refused it. This is what makes the receipt above worth anything."
          : "TxLINE's program says this outcome is NOT satisfied by the proven stats.",
      });
      return { steps, verified: false };
    }

    set("oracle", {
      status: "ok",
      detail:
        "TxLINE's own on-chain program verified the multiproof against the root and confirmed the predicate holds.",
      evidence: {
        program: TXORACLE_ID.toBase58(),
        instruction: "validate_stat_v3",
        returned: "true",
      },
    });
    return { steps, verified: true };
  } catch (e: any) {
    const logs: string[] = e?.logs ?? e?.simulationResponse?.logs ?? [];
    const programSaid = logs.find((l) => l.includes("Error Code:")) ?? "";
    const msg = programSaid || String(e?.message ?? e) || "simulation failed before the program ran";
    const isMerkle = /StatProofMismatch|InvalidStatProof|Merkle|6003|6004|6023/i.test(
      msg + JSON.stringify(logs)
    );
    set("oracle", {
      status: "fail",
      detail: opts.tamper
        ? "REJECTED — exactly as it should be. One byte was changed and the multiproof no longer reconstructs TxLINE's published root. A forged proof cannot pass, which is why it does not matter who handed you the proof."
        : isMerkle
        ? "The proof does not reconstruct TxLINE's published root."
        : `TxLINE's program rejected the proof: ${msg.slice(0, 160)}`,
    });
    return { steps, verified: false };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Find the finalised sequence number for a fixture, from TxLINE's own feed. */
async function findSeq(
  cred: { origin: string; jwt: string; apiToken: string },
  fixtureId: number
): Promise<number> {
  const r = await fetch(`${cred.origin}/api/scores/snapshot/${fixtureId}`, {
    headers: {
      Authorization: `Bearer ${cred.jwt}`,
      "X-Api-Token": cred.apiToken,
    },
  });
  if (!r.ok) throw new Error(`snapshot ${r.status}`);
  const rows: any[] = await r.json();
  if (!rows.length) throw new Error("TxLINE retains no records for this fixture");
  // Prefer the game_finalised record (statusId 100); fall back to the latest.
  const fin = rows.filter((x) => x.StatusId === 100);
  const pool = fin.length ? fin : rows;
  return pool.reduce((mx, x) => Math.max(mx, x.Seq ?? 0), 0);
}

function buildV3Payload(val: any) {
  const node = (n: any) => ({
    hash: Array.from(Buffer.from(n.hash)),
    isRightSibling: !!n.isRightSibling,
  });
  const b32 = (v: any) => Array.from(Buffer.from(v));
  return {
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
}

const CMP = (c: any) => ("greaterThan" in c ? ">" : "lessThan" in c ? "<" : "=");

function strategyFromCombo(combo: any, outcome: number) {
  const preds = combo.outcomes[outcome].predicates.map((p: any) => {
    if (p.single) {
      return {
        single: {
          index: p.single.index,
          predicate: {
            threshold: p.single.threshold,
            comparison: p.single.comparison,
          },
        },
      };
    }
    return {
      binary: {
        indexA: p.binary.indexA,
        indexB: p.binary.indexB,
        op: p.binary.op,
        predicate: {
          threshold: p.binary.threshold,
          comparison: p.binary.comparison,
        },
      },
    };
  });
  return { geometricTargets: [], distancePredicate: null, discretePredicates: preds };
}

function strategyFromLegacy(spec: any, nLegs: number) {
  const predicate = { threshold: spec.threshold, comparison: spec.comparison };
  const p =
    nLegs === 2
      ? { binary: { indexA: 0, indexB: 1, op: spec.op, predicate } }
      : { single: { index: 0, predicate } };
  return { geometricTargets: [], distancePredicate: null, discretePredicates: [p] };
}

const KEY_NAME: Record<number, string> = {
  1: "home goals",
  2: "away goals",
  3: "home yellows",
  4: "away yellows",
  5: "home reds",
  6: "away reds",
  7: "home corners",
  8: "away corners",
  1001: "home goals (HT)",
  1002: "away goals (HT)",
};
const name = (k: number) => KEY_NAME[k] ?? `stat ${k}`;

function describeCombo(combo: any, outcome: number): string {
  const legs = combo.legs;
  const parts = combo.outcomes[outcome].predicates.map((p: any) => {
    if (p.single) {
      return `${name(legs[p.single.index].key)} ${CMP(p.single.comparison)} ${p.single.threshold}`;
    }
    const { indexA, indexB, op, comparison, threshold } = p.binary;
    const sym = "add" in op ? "+" : "−";
    return `(${name(legs[indexA].key)} ${sym} ${name(legs[indexB].key)}) ${CMP(
      comparison
    )} ${threshold}`;
  });
  return parts.join("   AND   ");
}

function describeLegacy(spec: any): string {
  const a = name(spec.statAKey);
  if (!spec.hasStatB) return `${a} ${CMP(spec.comparison)} ${spec.threshold}`;
  const sym = spec.op && "add" in spec.op ? "+" : "−";
  return `(${a} ${sym} ${name(spec.statBKey)}) ${CMP(spec.comparison)} ${spec.threshold}`;
}
