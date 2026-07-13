"use client";

/**
 * /vault — the parametric prop vault, from the browser.
 *
 * Escrow USDC against a provable condition — "total corners > N" — with a named
 * beneficiary. When the match can be proven ANYONE can settle it, and the merkle
 * proof, not a person, routes the whole escrow: to the beneficiary if the
 * condition held, back to the depositor if it failed. Parametric insurance whose
 * loss adjuster is a proof.
 *
 * Vaults are read straight from the chain (`propVault.all()`), not from our API.
 * The API deliberately never touches the chain on a request path, and a page whose
 * whole claim is "don't trust us" should not ask you to trust our database either.
 *
 * The two ways a vault can be born dead — both found the hard way on devnet, both
 * refused here AND by the program:
 *
 *   1. beneficiary == depositor. Settlement passes beneficiary_token and
 *      depositor_token as two writable accounts, and the runtime rejects the same
 *      account twice (2040). Such a vault could never settle, only time out into a
 *      refund. The program now rejects it at creation (SelfHedgeVault).
 *
 *   2. A stat period that does not match the proof. The vault pins the (key,
 *      period) its leaves must hash to, and the spec is immutable — pin the wrong
 *      period and it can NEVER settle (InvalidStatProof 6023). TxLINE keeps the
 *      game_finalised record (period 100) only about ten days, after which the same
 *      fixture proves at period 5, then 0. So we never guess: for a match already
 *      played we read the LIVE proof and pin whatever period it actually carries;
 *      for a match not yet played there is no proof to read and a fresh one will be
 *      game_finalised, so we pin 100 — the same rule the keeper's catalogue uses.
 */
import { useCallback, useEffect, useState } from "react";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

import idl from "@/lib/idl/proofbook.json";
import { api, type MarketView } from "@/lib/api";
import { teamsForFixture } from "@/lib/teams";
import { Reveal } from "@/components/motion";
import { PageArt } from "@/components/PageArt";
import { QuarterLoader } from "@/components/primitives";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const USDC_MINT = new PublicKey("3Srypwg8r4L4PbCcBeSgjveeixyH6sKAytJK11xVTMns");
const ORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/** game_finalised — what a proof taken at full time carries. */
const FINALISED = 100;
const HOME_CORNERS = 7;
const AWAY_CORNERS = 8;

type Cred = { origin: string; jwt: string; apiToken: string };

interface Probe {
  /** The period this vault must pin. */
  period: number;
  /** Corner counts, when the match is already provable. */
  corners: number[] | null;
  /** TxLINE's validation payload, when one exists — settlement reuses it. */
  val: any | null;
  note: string;
}

interface VaultRow {
  pda: string;
  status: "funded" | "paidOut" | "refunded";
  fixtureId: number;
  amount: number;
  threshold: number;
  beneficiary: string;
  depositor: string;
  vault: string;
  lockTime: number;
  /** When the refund backstop opens. */
  deadline: number;
  /** The period its legs are pinned to. If TxLINE no longer proves the fixture at
   *  this period, the vault can NEVER settle — the spec is immutable. */
  legPeriod: number;
  proofRef: string | null;
}

const readOnlyWallet = () => ({
  publicKey: PublicKey.default,
  signTransaction: async (t: any) => t,
  signAllTransactions: async (t: any) => t,
});

function progOf(connection: any, wallet: any) {
  const provider = new anchor.AnchorProvider(connection, wallet as never, {
    commitment: "confirmed",
  });
  return new anchor.Program(idl as anchor.Idl, provider) as any;
}

const txHeaders = (c: Cred) => ({
  Authorization: `Bearer ${c.jwt}`,
  "X-Api-Token": c.apiToken,
});

/**
 * What period must this vault pin, and what does TxLINE already know?
 *
 * Never a guess: either the live proof tells us, or the match has not been played
 * and a fresh proof will be game_finalised. The one state we refuse outright is
 * "played, but TxLINE retains nothing" — a vault on it could never settle.
 */
async function probeFixture(
  cred: Cred,
  fixtureId: number,
  kickoffTs: number
): Promise<Probe> {
  const played = kickoffTs * 1000 < Date.now() - 2 * 3600_000;

  const snap = await fetch(`${cred.origin}/api/scores/snapshot/${fixtureId}`, {
    headers: txHeaders(cred),
  });
  const rows = snap.ok ? ((await snap.json()) as any[]) : [];
  const finalised = Array.isArray(rows) ? rows.filter((r) => r.StatusId === 100) : [];

  if (!finalised.length) {
    if (played) {
      throw new Error(
        "This match was played, but TxLINE no longer retains a finalised record for it — " +
          "a vault on it could never settle, so we will not open one."
      );
    }
    return {
      period: FINALISED,
      corners: null,
      val: null,
      note:
        "Not played yet, so there is no proof to read. The vault pins period 100 " +
        "(game_finalised) — what a proof taken at full time will carry.",
    };
  }

  const seq = finalised.reduce((m, r) => Math.max(m, r.Seq ?? 0), 0);
  const pr = await fetch(
    `${cred.origin}/api/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${HOME_CORNERS},${AWAY_CORNERS}`,
    { headers: txHeaders(cred) }
  );
  if (!pr.ok) throw new Error(`TxLINE would not produce a proof (${pr.status}).`);
  const val = await pr.json();
  const period = val.statsToProve[0].stat.period as number;
  const corners = val.statsToProve.map((l: any) => l.stat.value as number);

  return {
    period,
    corners,
    val,
    note:
      `Already provable: ${corners[0]} + ${corners[1]} = ${corners[0] + corners[1]} corners, ` +
      `at period ${period}. The vault pins that period — read from the live proof, not assumed.`,
  };
}

/** The on-chain SettlementProofV3, built from TxLINE's validation payload. */
function toProofV3(val: any) {
  const node = (n: any) => ({
    hash: Array.from(Buffer.from(n.hash ?? n)),
    isRightSibling: !!n.isRightSibling,
  });
  const b32 = (x: any) => Array.from(Buffer.from(x));
  const tsMs = val.summary.updateStats.minTimestamp;
  return {
    tsMs,
    proof: {
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
    },
  };
}

export default function VaultPage() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [cred, setCred] = useState<Cred | null>(null);
  const [fixtures, setFixtures] = useState<MarketView[]>([]);
  const [fixtureId, setFixtureId] = useState("");
  const [line, setLine] = useState("9");
  const [amount, setAmount] = useState("100");
  const [beneficiary, setBeneficiary] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [vaults, setVaults] = useState<VaultRow[]>([]);
  /** fixtureId → the period TxLINE proves it at TODAY. Retention moves this. */
  const [livePeriod, setLivePeriod] = useState<Record<number, number>>({});

  useEffect(() => {
    fetch(`${API_URL}/txline/credential`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setCred)
      .catch(() => setCred(null));

    // One row per fixture — a vault needs a fixture, not a market.
    api
      .allMarkets()
      .then((ms) => {
        const byFixture = new Map<number, MarketView>();
        for (const m of ms) if (!byFixture.has(m.fixtureId)) byFixture.set(m.fixtureId, m);
        setFixtures([...byFixture.values()].sort((a, b) => b.kickoffTs - a.kickoffTs));
      })
      .catch(() => {});
  }, []);

  /** Every vault that exists, read from the chain. Not from our API. */
  const refreshVaults = useCallback(async () => {
    try {
      const prog = progOf(connection, readOnlyWallet());
      const all = await prog.account.propVault.all();
      const rows: VaultRow[] = all.map((a: any) => {
        const ref = a.account.settleProofRef
          ? Buffer.from(a.account.settleProofRef).toString("hex")
          : "";
        return {
          pda: a.publicKey.toBase58(),
          status: Object.keys(a.account.status)[0] as VaultRow["status"],
          fixtureId: Number(a.account.fixtureId),
          amount: Number(a.account.amount) / 1e6,
          threshold: Number(a.account.predicates?.[0]?.binary?.threshold ?? 0),
          beneficiary: a.account.beneficiary.toBase58(),
          depositor: a.account.depositor.toBase58(),
          vault: a.account.vault.toBase58(),
          lockTime: Number(a.account.lockTime),
          deadline:
            Number(a.account.lockTime) + Number(a.account.resolutionTimeout ?? 0),
          legPeriod: Number(a.account.legs?.[0]?.period ?? -1),
          proofRef: ref && ref !== "0".repeat(64) ? ref : null,
        };
      });
      rows.sort(
        (a, b) =>
          Number(b.status === "funded") - Number(a.status === "funded") ||
          b.lockTime - a.lockTime
      );
      setVaults(rows);
    } catch {
      /* an RPC blip is not worth an error banner over a list */
    }
  }, [connection]);

  useEffect(() => {
    void refreshVaults();
  }, [refreshVaults]);

  // For every fixture that has a vault, ask TxLINE what period it proves at TODAY.
  // A vault pinned to a period TxLINE has since moved past can never settle, and
  // the honest thing is to say that on the row rather than hand the user a button
  // that fails with InvalidStatProof.
  useEffect(() => {
    if (!cred || !vaults.length) return;
    let alive = true;
    const wanted = [...new Set(vaults.filter((v) => v.status === "funded").map((v) => v.fixtureId))];
    void Promise.all(
      wanted
        .filter((f) => livePeriod[f] === undefined)
        .map(async (f) => {
          try {
            const p = await probeFixture(cred, f, 0);
            return [f, p.corners ? p.period : -1] as const;
          } catch {
            return [f, -1] as const; // not provable at all
          }
        })
    ).then((pairs) => {
      if (!alive || !pairs.length) return;
      setLivePeriod((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      alive = false;
    };
  }, [cred, vaults, livePeriod]);

  // Probe as soon as a fixture is picked: you should see exactly what is provable
  // BEFORE you sign anything.
  useEffect(() => {
    setProbe(null);
    setError(null);
    const fid = Number(fixtureId);
    if (!fid || !cred) return;
    const fx = fixtures.find((f) => f.fixtureId === fid);
    if (!fx) return;
    let alive = true;
    setProbing(true);
    probeFixture(cred, fid, fx.kickoffTs)
      .then((p) => alive && setProbe(p))
      .catch((e) => alive && setError(String(e?.message ?? e)))
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, [fixtureId, cred, fixtures]);

  async function create() {
    setError(null);
    setNotice(null);
    if (!wallet.publicKey) return setError("Connect a wallet first.");
    if (!probe) return setError("Pick a fixture we can prove.");

    let ben: PublicKey;
    try {
      ben = new PublicKey(beneficiary.trim());
    } catch {
      return setError("The beneficiary must be a valid Solana address.");
    }
    if (ben.equals(wallet.publicKey))
      return setError(
        "The beneficiary must not be your own wallet — see below. The program refuses it too."
      );

    const threshold = Math.floor(Number(line));
    const usdc = Math.round(Number(amount) * 1e6);
    if (!Number.isFinite(threshold) || !(usdc > 0))
      return setError("Give a whole corners line and a positive amount.");

    try {
      setBusy("Building the transaction…");
      const prog = progOf(connection, wallet);
      const vaultId = new BN(Date.now() % 1_000_000_000);
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

      // Settleable once the match is provable: immediately for a fixture that
      // already proves, otherwise a couple of hours after kickoff.
      const fx = fixtures.find((f) => f.fixtureId === Number(fixtureId))!;
      const lockTime = probe.corners
        ? Math.floor(Date.now() / 1000) + 60
        : fx.kickoffTs + 2 * 3600;

      setBusy("Waiting for your signature…");
      await prog.methods
        .initializePropVault(
          vaultId,
          [
            { key: HOME_CORNERS, period: probe.period },
            { key: AWAY_CORNERS, period: probe.period },
          ],
          [
            {
              binary: {
                indexA: 0,
                indexB: 1,
                op: { add: {} },
                comparison: { greaterThan: {} },
                threshold,
              },
            },
          ],
          new BN(Number(fixtureId)),
          new BN(usdc),
          ben,
          new BN(lockTime),
          new BN(14 * 86400) // refund backstop — it can only ever pay the depositor
        )
        .accounts({
          depositor: wallet.publicKey,
          propVault: pv,
          usdcMint: USDC_MINT,
          vault: escrow,
          depositorToken: getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      setNotice(
        `Vault open: ${amount} USDC escrowed on corners > ${threshold}, pinned to period ` +
          `${probe.period}. Anyone can settle it once the match is provable.`
      );
      await refreshVaults();
    } catch (e: any) {
      setError(String(e?.message ?? e).slice(0, 260));
    } finally {
      setBusy(null);
    }
  }

  /** Permissionless: this works on ANY funded vault, not just your own. */
  async function settle(row: VaultRow) {
    setError(null);
    setNotice(null);
    if (!wallet.publicKey) return setError("Connect a wallet first.");
    if (!cred) return setError("No TxLINE credential yet.");
    try {
      setBusy(`Fetching TxLINE's proof for fixture ${row.fixtureId}…`);
      const fx = fixtures.find((f) => f.fixtureId === row.fixtureId);
      const p = await probeFixture(cred, row.fixtureId, fx?.kickoffTs ?? 0);
      if (!p.val)
        throw new Error("The match is not provable yet — there is nothing to settle with.");

      const { tsMs, proof } = toProofV3(p.val);
      const eb = Buffer.alloc(2);
      eb.writeUInt16LE(Math.floor(tsMs / 86_400_000) & 0xffff, 0);
      const [roots] = PublicKey.findProgramAddressSync(
        [Buffer.from("daily_scores_roots"), eb],
        ORACLE
      );

      setBusy("Waiting for your signature…");
      const prog = progOf(connection, wallet);
      const sig: string = await prog.methods
        .settlePropVault(proof)
        .accounts({
          cranker: wallet.publicKey,
          propVault: new PublicKey(row.pda),
          vault: new PublicKey(row.vault),
          beneficiaryToken: getAssociatedTokenAddressSync(
            USDC_MINT,
            new PublicKey(row.beneficiary)
          ),
          depositorToken: getAssociatedTokenAddressSync(
            USDC_MINT,
            new PublicKey(row.depositor)
          ),
          oracleProgram: ORACLE,
          oracleRoots: roots,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ])
        .rpc();

      const total = (p.corners?.[0] ?? 0) + (p.corners?.[1] ?? 0);
      const held = total > row.threshold;
      setNotice(
        `Settled: ${total} corners ${held ? ">" : "≤"} ${row.threshold}, so the proof paid the ` +
          `${held ? "beneficiary" : "depositor"}. You cranked it and took nothing. ${sig.slice(0, 16)}…`
      );
      await refreshVaults();
    } catch (e: any) {
      setError(String(e?.message ?? e).slice(0, 260));
    } finally {
      setBusy(null);
    }
  }

  /**
   * The refund backstop. Also permissionless, and it can only ever pay the
   * depositor — a vault the proof cannot resolve is not money anyone can steer.
   */
  async function refund(row: VaultRow) {
    setError(null);
    setNotice(null);
    if (!wallet.publicKey) return setError("Connect a wallet first.");
    try {
      setBusy("Waiting for your signature…");
      const prog = progOf(connection, wallet);
      await prog.methods
        .cancelPropVault()
        .accounts({
          canceller: wallet.publicKey,
          propVault: new PublicKey(row.pda),
          vault: new PublicKey(row.vault),
          depositorToken: getAssociatedTokenAddressSync(
            USDC_MINT,
            new PublicKey(row.depositor)
          ),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      setNotice(`Refunded: ${row.amount} USDC returned to the depositor, and to no one else.`);
      await refreshVaults();
    } catch (e: any) {
      setError(String(e?.message ?? e).slice(0, 260));
    } finally {
      setBusy(null);
    }
  }

  const selfHedge = (() => {
    if (!wallet.publicKey || !beneficiary.trim()) return false;
    try {
      return new PublicKey(beneficiary.trim()).equals(wallet.publicKey);
    } catch {
      return false;
    }
  })();

  return (
    <main className="mx-auto w-full max-w-4xl px-6 pb-24 pt-12 lg:px-10">
      <PageArt src="/art-portfolio.jpg" opacity={0.24} />

      <header className="mb-8">
        <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">Prop vault</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-400">
          Escrow USDC against a provable condition — <em>total corners &gt; N</em> —
          payable to someone else. Once the match can be proven,{" "}
          <span className="text-ink-200">anyone</span> can settle it, and TxLINE&rsquo;s
          merkle proof decides where the money goes: to the beneficiary if the condition
          held, back to the depositor if it did not. Parametric insurance whose loss
          adjuster is a proof.
        </p>
      </header>

      <Reveal>
        <section className="panel border border-hairline p-6">
          <p className="label text-brass-500">Open a vault</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label !text-[10px] text-ink-500">Fixture</span>
              <select
                value={fixtureId}
                onChange={(e) => setFixtureId(e.target.value)}
                className="mt-1.5 w-full border border-hairline bg-ink-950 px-3 py-2 font-mono text-[13px] text-ink-200"
              >
                <option value="">pick a match…</option>
                {fixtures.map((m) => {
                  const [h, a] = teamsForFixture(
                    m.fixtureId,
                    m.fixtureName,
                    m.home,
                    m.away
                  );
                  const upcoming = m.kickoffTs * 1000 > Date.now();
                  return (
                    <option key={m.fixtureId} value={m.fixtureId}>
                      {h.code} v {a.code} · {upcoming ? "upcoming" : "played"} ·{" "}
                      {m.fixtureId}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="block">
              <span className="label !text-[10px] text-ink-500">
                Corners line — pays if total &gt;
              </span>
              <input
                value={line}
                onChange={(e) => setLine(e.target.value)}
                inputMode="numeric"
                className="mt-1.5 w-full border border-hairline bg-ink-950 px-3 py-2 font-mono text-[13px] text-ink-200"
              />
            </label>

            <label className="block">
              <span className="label !text-[10px] text-ink-500">Escrow (demo USDC)</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                className="mt-1.5 w-full border border-hairline bg-ink-950 px-3 py-2 font-mono text-[13px] text-ink-200"
              />
            </label>

            <label className="block">
              <span className="label !text-[10px] text-ink-500">
                Beneficiary — who gets paid if it holds
              </span>
              <input
                value={beneficiary}
                onChange={(e) => setBeneficiary(e.target.value)}
                placeholder="a wallet that is not yours"
                spellCheck={false}
                className={`mt-1.5 w-full border bg-ink-950 px-3 py-2 font-mono text-[13px] text-ink-200 ${
                  selfHedge ? "border-oxide-500" : "border-hairline"
                }`}
              />
            </label>
          </div>

          {/* exactly what the chain will be asked to prove — before you sign */}
          {probing && (
            <p className="mt-4 flex items-center gap-2 text-[12px] text-ink-400">
              <QuarterLoader size={14} label="" /> Reading TxLINE&rsquo;s live proof…
            </p>
          )}
          {probe && (
            <div className="mt-4 border-l-2 border-brass-600 bg-ink-950/60 px-4 py-3">
              <p className="label !text-[10px] text-ink-600">The proof this vault pins</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-300">{probe.note}</p>
            </div>
          )}
          {selfHedge && (
            <p className="mt-3 text-[12px] leading-relaxed text-oxide-400">
              That is your own wallet. Settlement moves the escrow between two distinct
              token accounts, so a vault that pays you could never settle — only time out
              into a refund. The program rejects it (SelfHedgeVault), and so do we.
            </p>
          )}

          <button
            onClick={() => void create()}
            disabled={!!busy || !wallet.publicKey || !probe || selfHedge}
            className="label mt-5 bg-brass-500 px-6 py-2.5 text-ink-950 transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ borderRadius: "0 0 0 12px" }}
          >
            {busy ? "Working…" : wallet.publicKey ? "Escrow it" : "Connect a wallet"}
          </button>

          {busy && (
            <p className="mt-3 flex items-center gap-2 text-[12px] text-amber-400">
              <QuarterLoader size={14} label="" /> {busy}
            </p>
          )}
          {notice && <p className="mt-3 break-words text-[12px] text-pitch-400">{notice}</p>}
          {error && <p className="mt-3 break-words text-[12px] text-oxide-400">{error}</p>}
        </section>
      </Reveal>

      <div className="mb-4 mt-12 flex items-center gap-3">
        <span
          aria-hidden
          className="h-2.5 w-2.5 bg-brass-500"
          style={{ borderRadius: "0 0 0 6px" }}
        />
        <h2 className="label !text-[12px]">Every vault ever opened</h2>
        <span className="rule flex-1" />
        <span className="font-mono text-[10px] text-ink-600">read from chain</span>
      </div>

      {vaults.length === 0 ? (
        <p className="text-[12px] text-ink-600">No vaults yet. Open the first one above.</p>
      ) : (
        <ul className="space-y-2">
          {vaults.map((v) => {
            const now = Date.now() / 1000;
            const funded = v.status === "funded";
            const live = livePeriod[v.fixtureId];
            // The immutable-spec trap, stated plainly. TxLINE's retention has moved
            // the fixture to a different period than this vault pinned, so no proof
            // it can accept will ever exist. Say so; don't offer a button that fails.
            const stranded = funded && live !== undefined && live !== v.legPeriod;
            const settleable = funded && !stranded && v.lockTime < now;
            const refundable = funded && v.deadline < now;

            return (
              <li
                key={v.pda}
                className="panel flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[12px] text-ink-200">
                    {v.amount.toLocaleString()} USDC · corners &gt; {v.threshold} · fixture{" "}
                    {v.fixtureId}
                  </p>
                  <p className="mt-1 truncate font-mono text-[10px] text-ink-600">{v.pda}</p>
                  {v.proofRef && (
                    <p className="mt-1 truncate font-mono text-[10px] text-ink-600">
                      proof {v.proofRef.slice(0, 24)}…
                    </p>
                  )}
                  {stranded && (
                    <p className="mt-2 max-w-lg text-[11px] leading-relaxed text-oxide-400">
                      Cannot settle: pinned to period {v.legPeriod}, but TxLINE now proves
                      this fixture at period {live < 0 ? "nothing at all" : live}. A spec is
                      immutable, so no proof it accepts will ever exist. The escrow returns
                      to the depositor at the timeout — that is the only path left, and it
                      pays no one else.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-4">
                  <span
                    className="font-mono text-[11px] uppercase tracking-[0.1em]"
                    style={{
                      color:
                        v.status === "paidOut"
                          ? "var(--color-pitch-400)"
                          : v.status === "refunded"
                            ? "var(--color-ink-400)"
                            : stranded
                              ? "var(--color-oxide-400)"
                              : "var(--color-ink-300)",
                    }}
                  >
                    {v.status === "paidOut"
                      ? "paid the beneficiary"
                      : v.status === "refunded"
                        ? "refunded"
                        : stranded
                          ? "stranded"
                          : "funded"}
                  </span>

                  {settleable && (
                    <button
                      onClick={() => void settle(v)}
                      disabled={!!busy}
                      className="label border border-brass-600 px-3 py-1.5 text-brass-400 transition-colors hover:bg-brass-500 hover:text-ink-950 disabled:opacity-40"
                    >
                      Settle by proof
                    </button>
                  )}
                  {refundable && (
                    <button
                      onClick={() => void refund(v)}
                      disabled={!!busy}
                      className="label border border-hairline-strong px-3 py-1.5 text-ink-400 transition-colors hover:border-ink-400 disabled:opacity-40"
                    >
                      Refund the depositor
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-6 border-t border-hairline pt-4 text-[11px] leading-relaxed text-ink-600">
        Settling is permissionless and pays the cranker nothing: you can settle a
        stranger&rsquo;s vault, and the only thing you get to choose is <em>when</em> the
        proof is read — never <em>where the money goes</em>. If nobody ever cranks it, a
        timeout returns the escrow to the depositor, and to no one else.
      </p>
    </main>
  );
}
