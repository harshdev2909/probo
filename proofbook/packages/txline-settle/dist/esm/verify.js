/**
 * Independent verification — the module that trusts nothing.
 *
 * `verifyProof` re-adjudicates a claim against TxLINE's ON-CHAIN merkle root and
 * TxLINE's OWN program, by simulation. `verifySettlement` goes further: it reads
 * a settled market account, extracts the predicate the market committed to at
 * creation, re-fetches the proof from TxLINE, and asks the oracle whether the
 * recorded winning outcome actually holds. Neither function consults anyone's
 * API or database for the verdict.
 *
 * The five facts and their only acceptable sources:
 *
 *   settlement    the settling program's account          (Solana)
 *   predicate     the same account — fixed at creation    (Solana)
 *   merkle root   TxLINE's OWN daily-roots PDA            (Solana)
 *   proof         TxLINE's API                            (TxLINE)
 *   verdict       TxLINE's OWN program, simulated         (Solana)
 */
import { PublicKey } from "@solana/web3.js";
import { DEVNET } from "./network";
import { fetchProofV3, findFinalisedSeq, toPayloadV3, proofEpochDay } from "./proof";
import { dailyRootsPda } from "./settle";
/** Build a read-only Anchor Program whose simulated payer EXISTS.
 *
 * `.view()` simulates a transaction, and a payer that does not exist fails with
 * an EMPTY error before the program runs — the least debuggable failure in this
 * whole stack. Always pass an account you know exists (a settlement's resolver
 * is ideal: it demonstrably paid a fee once).
 */
export function readOnlyProgram(anchor, connection, idl, payer) {
    const provider = new anchor.AnchorProvider(connection, {
        publicKey: payer,
        signTransaction: async (t) => t,
        signAllTransactions: async (t) => t,
    }, { commitment: "confirmed" });
    return new anchor.Program(idl, provider);
}
/**
 * Verify a claim ("these stats satisfy this strategy for this fixture") against
 * the live oracle. Returns the oracle's verdict; throws only on infrastructure
 * failure, never on a negative verdict.
 */
export async function verifyProof(opts) {
    const net = opts.network ?? DEVNET;
    const seq = opts.seq ?? (await findFinalisedSeq(opts.session, opts.fixtureId));
    const val = await fetchProofV3(opts.session, opts.fixtureId, seq, opts.statKeys);
    const payload = toPayloadV3(val, opts.anchor.BN);
    if (opts.tamper) {
        payload.leaves = payload.leaves.map((l, i) => i === 0 ? { ...l, stat: { ...l.stat, value: l.stat.value + 1 } } : l);
    }
    const epochDay = proofEpochDay(val);
    const oracle = new PublicKey(net.oracleProgram);
    const roots = dailyRootsPda(epochDay, oracle);
    const rootInfo = await opts.connection.getAccountInfo(roots);
    if (!rootInfo)
        throw new Error(`TxLINE has not published a root for epoch day ${epochDay}`);
    if (!rootInfo.owner.equals(oracle))
        throw new Error(`roots account is owned by ${rootInfo.owner.toBase58()}, not the oracle`);
    const prog = readOnlyProgram(opts.anchor, opts.connection, { ...opts.txoracleIdl, address: net.oracleProgram }, opts.payer ?? oracle);
    let verified = false;
    try {
        verified =
            (await prog.methods
                .validateStatV3(payload, opts.strategy)
                .accounts({ dailyScoresMerkleRoots: roots })
                .preInstructions([
                opts.anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
            ])
                .view()) === true;
    }
    catch {
        verified = false; // a rejected/forged proof throws — that IS the negative verdict
    }
    return {
        verified,
        provenValues: val.statsToProve.map((l) => l.stat.value),
        epochDay,
        rootsPda: roots.toBase58(),
    };
}
/**
 * Re-derive a settlement end to end. The market account supplies the predicate
 * (never the caller, never an API), TxLINE supplies the proof, the oracle
 * supplies the verdict.
 *
 * Convention understood: `market_type >= 16` means the predicate lives in a
 * `ComboSpec` PDA at ["combo", market]; below that it is the market's own
 * per-outcome spec (1–2 stats). This matches the reference Rust module.
 */
export async function verifySettlement(opts) {
    const { anchor, connection, session } = opts;
    const net = opts.network ?? DEVNET;
    const steps = [];
    const step = (s) => {
        steps.push(s);
        opts.onStep?.(s);
        return s.ok;
    };
    // 1. settlement
    const market = new PublicKey(opts.marketPda);
    const settler = readOnlyProgram(anchor, connection, opts.settlerIdl, market);
    let m;
    try {
        m = await settler.account.market.fetch(market);
    }
    catch {
        step({ key: "settlement", ok: false, detail: "no market account at that address" });
        return { verified: false, steps };
    }
    const status = Object.keys(m.status)[0];
    if (status !== "settled") {
        step({ key: "settlement", ok: false, detail: `market is ${status}, not settled` });
        return { verified: false, steps };
    }
    const winning = Number(m.winningOutcome);
    const fixtureId = Number(m.fixtureId);
    step({
        key: "settlement",
        ok: true,
        detail: `fixture ${fixtureId} settled on outcome ${winning}`,
        evidence: {
            proofRef: Buffer.from(m.settleProofRef).toString("hex"),
            resolver: m.settleResolver.toBase58(),
            dailyRoots: m.settleDailyRoots.toBase58(),
        },
    });
    // 2. predicate — from chain
    let legs;
    let strategy;
    const isCombo = Number(m.marketType) >= 16;
    try {
        if (isCombo) {
            const [comboPda] = PublicKey.findProgramAddressSync([Buffer.from("combo"), market.toBuffer()], settler.programId);
            const combo = await settler.account.comboSpec.fetch(comboPda);
            legs = combo.legs.map((l) => ({ key: l.key, period: l.period }));
            strategy = {
                geometricTargets: [],
                distancePredicate: null,
                discretePredicates: combo.outcomes[winning].predicates.map((p) => p.single
                    ? { single: { index: p.single.index, predicate: { threshold: p.single.threshold, comparison: p.single.comparison } } }
                    : { binary: { indexA: p.binary.indexA, indexB: p.binary.indexB, op: p.binary.op, predicate: { threshold: p.binary.threshold, comparison: p.binary.comparison } } }),
            };
        }
        else {
            const spec = m.outcomes[winning].spec;
            legs = [{ key: spec.statAKey, period: spec.statAPeriod }];
            if (spec.hasStatB)
                legs.push({ key: spec.statBKey, period: spec.statBPeriod });
            const predicate = { threshold: spec.threshold, comparison: spec.comparison };
            strategy = {
                geometricTargets: [],
                distancePredicate: null,
                discretePredicates: [
                    spec.hasStatB
                        ? { binary: { indexA: 0, indexB: 1, op: spec.op, predicate } }
                        : { single: { index: 0, predicate } },
                ],
            };
        }
    }
    catch (e) {
        step({ key: "predicate", ok: false, detail: `could not read the on-chain spec: ${e?.message}` });
        return { verified: false, steps };
    }
    step({
        key: "predicate",
        ok: true,
        detail: `${isCombo ? "ComboSpec" : "OutcomeSpec"} pins stat keys [${legs.map((l) => l.key).join(",")}]`,
    });
    // 3–5. root + proof + verdict, with a payer that exists (the resolver).
    try {
        const res = await verifyProof({
            anchor,
            connection,
            session,
            txoracleIdl: opts.txoracleIdl,
            fixtureId,
            statKeys: legs.map((l) => l.key),
            strategy,
            payer: m.settleResolver,
            network: net,
            tamper: opts.tamper,
        });
        step({ key: "root", ok: true, detail: `root for epoch day ${res.epochDay} at ${res.rootsPda}, owned by the oracle` });
        step({ key: "proof", ok: true, detail: `proven values [${res.provenValues.join(",")}]` });
        step({
            key: "oracle",
            ok: res.verified,
            detail: res.verified
                ? "TxLINE's program re-adjudicated the winning outcome: TRUE"
                : "TxLINE's program did NOT verify this claim",
        });
        return { verified: res.verified, steps, provenValues: res.provenValues };
    }
    catch (e) {
        step({ key: "proof", ok: false, detail: String(e?.message ?? e).slice(0, 200) });
        return { verified: false, steps };
    }
}
