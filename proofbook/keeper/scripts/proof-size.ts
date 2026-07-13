/**
 * v2 vs v3 proof size, MEASURED on real TxLINE proofs for a real fixture.
 *
 * The claim "v3 is smaller" is only worth making with numbers, so this fetches
 * both shapes for the same stat sets and counts what actually goes on the wire.
 *
 * A Solana transaction is capped at 1232 bytes. That cap is what decides how
 * many legs a parlay can have, so the interesting column is not "bytes saved" —
 * it is "how many legs still fit".
 *
 *   npx ts-node keeper/scripts/proof-size.ts
 */
import { loadConfig } from "../src/config";
import { Store } from "../src/state";
import { Chain } from "../src/chain/proofbook";
import { TxLineSession } from "../src/txline/session";
import { TxLineClient } from "../src/txline/client";

const FIXTURE = Number(process.env.FIXTURE ?? 18218149);
const SEQ = Number(process.env.SEQ ?? 1087);

/** Borsh: 32-byte hash + 1-byte bool. */
const NODE = 33;
/** Solana's hard transaction size limit. */
const TX_LIMIT = 1232;
/**
 * Everything in a settle transaction that is NOT proof nodes: signature, header,
 * account keys, blockhash, discriminators, the fixture summary, the strategy,
 * the leaf values/indices.
 *
 * MEASURED, not estimated: the real 4-leg settle_market_v3 transaction on devnet
 * (2ATSv1a4...) is 702 bytes on the wire and carries 198 bytes of multiproof, so
 * the non-proof remainder is 504. An earlier guess of 520 was enough to flip the
 * 4-leg verdict from "fits" to "does not fit" — which is exactly why this is
 * taken from a real transaction.
 */
const TX_OVERHEAD = 504;

const SETS: { label: string; keys: number[] }[] = [
  { label: "1 leg  (clean sheet)", keys: [1] },
  { label: "2 legs (match result)", keys: [1, 2] },
  { label: "3 legs", keys: [1, 2, 7] },
  { label: "4 legs (parlay: win + corners)", keys: [1, 2, 7, 8] },
  { label: "5 legs (TxLINE's maximum)", keys: [1, 2, 7, 8, 3] },
];

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);
  const session = new TxLineSession(cfg, store, chain);
  await session.ensure();
  const client = new TxLineClient(session);

  console.log(
    `\n  Proof size — v2 vs v3, measured on fixture ${FIXTURE} (seq ${SEQ})\n`
  );
  console.log(
    "  legs                            v2 nodes   v2 bytes   v3 nodes   v3 bytes   saving"
  );
  console.log(
    "  ─────────────────────────────   ────────   ────────   ────────   ────────   ──────"
  );

  const rows: any[] = [];
  for (const s of SETS) {
    const v2 = await client.statValidation(FIXTURE, SEQ, s.keys);
    const v3 = await client.statValidationV3(FIXTURE, SEQ, s.keys);

    // v2: a FULL sibling path per stat, plus the fixture + main tree proofs.
    const v2Nodes =
      v2.subTreeProof.length +
      v2.mainTreeProof.length +
      v2.statProofs.reduce((a: number, p: any[]) => a + p.length, 0);

    // v3: ONE shared multiproof for all leaves. The per-leaf paths come back
    // empty — the multiproof supersedes them.
    const v3Nodes =
      v3.subTreeProof.length +
      v3.mainTreeProof.length +
      v3.multiproof.hashes.length +
      v3.statsToProve.reduce(
        (a: number, l: any) => a + (l.statProof?.length ?? 0),
        0
      );

    const v2b = v2Nodes * NODE;
    const v3b = v3Nodes * NODE;
    const save = v2Nodes ? (100 * (1 - v3Nodes / v2Nodes)).toFixed(0) : "0";
    rows.push({ ...s, v2Nodes, v3Nodes, v2b, v3b, save });

    console.log(
      `  ${s.label.padEnd(29)}   ${String(v2Nodes).padStart(8)}   ${String(
        v2b
      ).padStart(8)}   ${String(v3Nodes).padStart(8)}   ${String(v3b).padStart(
        8
      )}   ${(save + "%").padStart(6)}`
    );
  }

  console.log(
    "\n  What that means for a transaction (Solana caps one at 1232 bytes):\n"
  );
  console.log(
    "  legs                            v2 tx size   v3 tx size   v2 fits?   v3 fits?"
  );
  console.log(
    "  ─────────────────────────────   ──────────   ──────────   ────────   ────────"
  );
  for (const r of rows) {
    const t2 = r.v2b + TX_OVERHEAD;
    const t3 = r.v3b + TX_OVERHEAD;
    console.log(
      `  ${r.label.padEnd(29)}   ${String(t2).padStart(10)}   ${String(
        t3
      ).padStart(10)}   ${(t2 <= TX_LIMIT ? "yes" : "NO").padStart(8)}   ${(t3 <=
      TX_LIMIT
        ? "yes"
        : "NO"
      ).padStart(8)}`
    );
  }

  console.log(
    `\n  The multiproof shares internal nodes between leaves, so it grows` +
      `\n  sub-linearly: each extra leg costs v2 a whole new sibling path, while` +
      `\n  v3 only pays for the nodes its leaves do not already have in common.\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
