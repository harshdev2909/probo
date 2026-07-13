/**
 * The parametric prop vault, driven end to end on devnet — for real.
 *
 *   create  escrow demo-USDC against a compound predicate on a fixture
 *           ("home corners + away corners > N"), beneficiary named up front
 *   settle  fetch the REAL TxLINE proof and submit it — the PROOF decides
 *           whether the money goes to the beneficiary or back to the depositor
 *   status  read the vault account
 *
 * This is parametric insurance whose adjuster is a merkle proof. The same
 * machinery as a parlay leg, pointed at a single escrowed sum.
 *
 *   npx ts-node keeper/scripts/prop-vault.ts create --fixture 17926765 --amount 100 --line 10
 *   npx ts-node keeper/scripts/prop-vault.ts settle --vault <pda>
 *   npx ts-node keeper/scripts/prop-vault.ts status --vault <pda>
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { loadConfig, ROOT } from "../src/config";
import { Store } from "../src/state";
// Dogfooding the published SDK for the TxLINE side, same as the keeper does.
import {
  TxLineSession,
  findFinalisedSeq,
  fetchProofV3,
  dailyRootsPda,
} from "@h4rsharma/txline-settle";

const USDC = (n: number) => new BN(Math.round(n * 1e6));
const MINT = new PublicKey("3Srypwg8r4L4PbCcBeSgjveeixyH6sKAytJK11xVTMns");

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  out._cmd = a[0];
  for (let i = 1; i < a.length; i++)
    if (a[i].startsWith("--")) out[a[i].slice(2)] = a[i + 1];
  return out;
}

async function main() {
  const flags = args();
  const cfg = loadConfig("live");
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8")
      )
    )
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "idl", "proofbook.json"), "utf8")
  );
  const prog = new anchor.Program(idl, provider) as any;

  const vaultPdas = (vaultId: BN) => {
    const [pv] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("prop_vault"),
        wallet.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      prog.programId
    );
    const [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), pv.toBuffer()],
      prog.programId
    );
    return { pv, escrow };
  };

  switch (flags._cmd) {
    case "create": {
      const fixtureId = Number(flags.fixture);
      const amount = Number(flags.amount ?? 100);
      const line = Number(flags.line ?? 10);
      const lockIn = Number(flags["lock-in"] ?? 90);
      if (!fixtureId) throw new Error("--fixture required");

      // The predicate must pin the period the fixture's proof ACTUALLY carries —
      // read it from the LIVE proof, never from a cached plan. Retention prunes
      // records continuously, and the same (fixture, seq) can resolve to a
      // different batch tomorrow: a plan that said "period 5" yesterday produced
      // leaves at period 0 today, and a vault pinned to the stale period could
      // never settle (InvalidStatProof 6023). Fetch first, then commit.
      const store0 = new Store(cfg.dataDir);
      const s0 = new TxLineSession({
        origin: cfg.txlineApi,
        jwt: store0.data.session.jwt,
        apiToken: store0.data.session.apiToken,
      });
      const seq0 = await findFinalisedSeq(s0, fixtureId);
      const probe: any = await fetchProofV3(s0, fixtureId, seq0, [7, 8]);
      const period = probe.statsToProve[0].stat.period;
      console.log(
        `  live proof: corners ${probe.statsToProve.map((l: any) => l.stat.value).join("+")} at period ${period} (seq ${seq0})`
      );

      const vaultId = new BN(Date.now() % 1_000_000_000);
      const { pv, escrow } = vaultPdas(vaultId);
      if (!flags.beneficiary)
        throw new Error(
          "--beneficiary required, and it must differ from the depositor: settle " +
            "passes beneficiaryToken and depositorToken as two mutable accounts, and " +
            "Anchor rejects the duplicate (2040) when they are the same wallet — a " +
            "self-hedge vault could never settle, only refund via the timeout backstop"
        );
      const beneficiary = new PublicKey(flags.beneficiary);
      if (beneficiary.equals(wallet.publicKey))
        throw new Error("beneficiary must differ from the depositor (see above)");
      const depositorToken = getAssociatedTokenAddressSync(MINT, wallet.publicKey);
      const lockTime = Math.floor(Date.now() / 1000) + lockIn;

      const sig = await prog.methods
        .initializePropVault(
          vaultId,
          [
            { key: 7, period }, // home corners
            { key: 8, period }, // away corners
          ],
          [
            {
              binary: {
                indexA: 0,
                indexB: 1,
                op: { add: {} },
                comparison: { greaterThan: {} },
                threshold: line, // corners > line
              },
            },
          ],
          new BN(fixtureId),
          USDC(amount),
          beneficiary,
          new BN(lockTime),
          new BN(21600)
        )
        .accounts({
          depositor: wallet.publicKey,
          propVault: pv,
          usdcMint: MINT,
          vault: escrow,
          depositorToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log(`✓ prop vault created — ${amount} USDC escrowed`);
      console.log(`  predicate : home corners + away corners > ${line}  (fixture ${fixtureId}, period ${period})`);
      console.log(`  vault     : ${pv.toBase58()}`);
      console.log(`  lock time : ${new Date(lockTime * 1000).toISOString()} (settleable after)`);
      console.log(`  tx        : ${sig}`);
      break;
    }

    case "settle": {
      const pv = new PublicKey(flags.vault ?? (() => { throw new Error("--vault required"); })());
      const v: any = await prog.account.propVault.fetch(pv);
      const fixtureId = Number(v.fixtureId);
      const keys = v.legs.map((l: any) => l.key);

      // The REAL proof, via the published SDK.
      const store = new Store(cfg.dataDir);
      const { jwt, apiToken } = store.data.session;
      const session = new TxLineSession({
        origin: cfg.txlineApi,
        jwt,
        apiToken,
      });
      const seq = await findFinalisedSeq(session, fixtureId);
      const val: any = await fetchProofV3(session, fixtureId, seq, keys);

      const node = (n: any) => ({
        hash: Array.from(Buffer.from(n.hash ?? n)),
        isRightSibling: !!n.isRightSibling,
      });
      const b32 = (x: any) => Array.from(Buffer.from(x));
      const tsMs = val.summary.updateStats.minTimestamp;
      const proof = {
        ts: new BN(tsMs),
        fixtureSummary: {
          fixtureId: new BN(val.summary.fixtureId),
          updateStats: {
            updateCount: val.summary.updateStats.updateCount,
            minTimestamp: new BN(tsMs),
            maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
          },
          eventsSubTreeRoot: b32(val.summary.eventStatsSubTreeRoot),
        },
        fixtureProof: (val.subTreeProof ?? []).map(node),
        mainTreeProof: (val.mainTreeProof ?? []).map(node),
        eventStatRoot: b32(val.eventStatRoot),
        leafValues: val.statsToProve.map((l: any) => l.stat.value),
        multiproofHashes: (val.multiproof.hashes ?? []).map(node),
        leafIndices: val.multiproof.indices,
      };

      const beneficiaryToken = (
        await getOrCreateAssociatedTokenAccount(conn, wallet, MINT, v.beneficiary)
      ).address;
      const depositorToken = getAssociatedTokenAddressSync(MINT, v.depositor);
      const oracle = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

      const sig = await prog.methods
        .settlePropVault(proof)
        .accounts({
          cranker: wallet.publicKey,
          propVault: pv,
          vault: v.vault,
          beneficiaryToken,
          depositorToken,
          oracleProgram: oracle,
          oracleRoots: dailyRootsPda(Math.floor(tsMs / 86_400_000), oracle),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ])
        .rpc();

      const after: any = await prog.account.propVault.fetch(pv);
      const status = Object.keys(after.status)[0];
      const values = val.statsToProve.map((l: any) => `${l.stat.key}=${l.stat.value}`).join(" ");
      console.log(`✓ vault settled by the PROOF — ${status === "paidOut" ? "predicate HELD → beneficiary paid" : "predicate FAILED → depositor refunded"}`);
      console.log(`  proven stats : ${values}`);
      console.log(`  proof ref    : ${Buffer.from(after.settleProofRef).toString("hex")}`);
      console.log(`  tx           : ${sig}`);
      break;
    }

    case "status": {
      const pv = new PublicKey(flags.vault!);
      const v: any = await prog.account.propVault.fetch(pv);
      console.log(JSON.stringify({
        status: Object.keys(v.status)[0],
        fixtureId: Number(v.fixtureId),
        amount: v.amount.toString(),
        depositor: v.depositor.toBase58(),
        beneficiary: v.beneficiary.toBase58(),
        legs: v.legs.map((l: any) => ({ key: l.key, period: l.period })),
        lockTime: Number(v.lockTime),
        proofRef: Buffer.from(v.settleProofRef).toString("hex"),
        resolver: v.settleResolver.toBase58(),
      }, null, 2));
      break;
    }

    /**
     * The refund backstop — the only path that does not go through a proof.
     *
     * It is time-triggered, permissionless, and can pay exactly one party: the
     * depositor. That is what makes it safe to leave open. It exists for the vault
     * no proof can resolve — e.g. one pinned to a stat period TxLINE's retention
     * has since moved past, which is unsettleable forever because the spec is
     * immutable.
     */
    case "refund": {
      const pv = new PublicKey(flags.vault ?? (() => { throw new Error("--vault required"); })());
      const v: any = await prog.account.propVault.fetch(pv);
      const deadline = Number(v.lockTime) + Number(v.resolutionTimeout);
      const now = Math.floor(Date.now() / 1000);
      if (now <= deadline)
        throw new Error(
          `too early: the backstop opens at ${new Date(deadline * 1000).toISOString()}. ` +
            `Until then the PROOF decides, not the clock.`
        );

      const sig = await prog.methods
        .cancelPropVault()
        .accounts({
          canceller: wallet.publicKey,
          propVault: pv,
          vault: v.vault,
          depositorToken: getAssociatedTokenAddressSync(MINT, v.depositor),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log(`✓ refunded — ${Number(v.amount) / 1e6} USDC returned to the depositor`);
      console.log(`  depositor : ${v.depositor.toBase58()}`);
      console.log(`  tx        : ${sig}`);
      break;
    }

    default:
      console.log("usage: prop-vault.ts create --fixture <id> --beneficiary <pubkey> [--amount 100] [--line 10] [--lock-in 90]\n       prop-vault.ts settle --vault <pda> | refund --vault <pda> | status --vault <pda>");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
