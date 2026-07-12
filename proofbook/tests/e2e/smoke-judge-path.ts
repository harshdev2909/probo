/**
 * THE JUDGE PATH — end-to-end smoke test against a RUNNING stack.
 *
 * This walks exactly what a judge does, in order, from a wallet that has never
 * existed before:
 *
 *   1. open the site           -> API is up, keeper is alive
 *   2. see the tournament      -> 76 receipts, real teams, honest gaps
 *   3. connect a fresh wallet  -> zero SOL, zero tokens
 *   4. get test funds          -> faucet grants USDC *and* the SOL for rent
 *   5. place a bet             -> simulate, sign, WE broadcast, poll to confirm
 *   6. see the position        -> API reflects it (from Postgres, not the chain)
 *   7. open a receipt          -> a real proof, with a real settle tx
 *
 * It fails loudly. A judge cannot debug our stack, so if any of this is broken we
 * need to know before they do.
 *
 * Run against local:      npm run smoke
 * Run against deployed:   API_URL=https://... npm run smoke
 */
import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const API = process.env.API_URL ?? "http://localhost:8787";
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ROOT = path.resolve(__dirname, "..", "..");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(p: string): Promise<T> {
  const res = await fetch(`${API}${p}`);
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return (await res.json()) as T;
}

describe("judge path (smoke)", function () {
  this.timeout(180_000);

  const conn = new Connection(RPC, "confirmed");
  const judge = Keypair.generate(); // a wallet that has never existed
  let openMarket: any;

  it("1. the site loads: API up, database up, keeper alive", async () => {
    const h = await get<any>("/health");
    expect(h.ok, "API reports not ok").to.equal(true);
    expect(h.db, "database is down").to.equal(true);
    expect(h.keeper.alive, "KEEPER IS DEAD — nothing will settle").to.equal(
      true
    );
    expect(h.counts.settled).to.be.greaterThan(0);
  });

  it("2. the tournament is there: receipts, real teams, honest gaps", async () => {
    const receipts = await get<any>("/receipts?limit=200");
    expect(receipts.total, "no proof receipts").to.be.greaterThan(50);

    // Every receipt must carry the score its proof actually attests.
    for (const r of receipts.items) {
      expect(
        r.provenScore,
        `receipt ${r.marketPda} has no proven score`
      ).to.not.equal(null);
      expect(r.settleTx, `receipt ${r.marketPda} has no settle tx`).to.be.a(
        "string"
      );
    }

    const markets = await get<any>("/markets?limit=200");
    // No fixture may render as an unresolved team — that was a real bug once.
    const unknown = markets.items.filter(
      (m: any) => m.home.unknown || m.away.unknown
    );
    expect(unknown.length, "markets with unresolved teams").to.equal(0);

    // The honesty invariant: an unprovable fixture NEVER carries a scoreline.
    const gaps = markets.items.filter((m: any) => m.proofStatus === "no_proof");
    for (const g of gaps) {
      expect(
        g.live.score,
        `FABRICATED SCORE on unprovable fixture ${g.fixtureId}`
      ).to.equal(null);
    }
  });

  it("3. an open market exists to bet on", async () => {
    const open = await get<any>("/markets?status=open");
    expect(
      open.items.length,
      "nothing is open — a judge cannot place a bet"
    ).to.be.greaterThan(0);
    // Bet on one that already has liquidity, so odds are real.
    openMarket =
      open.items.find((m: any) => Number(m.totalPool) > 0) ?? open.items[0];
    expect(openMarket.lockTime * 1000).to.be.greaterThan(
      Date.now(),
      "the only open market has already closed for betting"
    );
  });

  it("4. a brand-new wallet starts with nothing", async () => {
    const sol = await conn.getBalance(judge.publicKey);
    expect(sol, "a fresh wallet should have no SOL").to.equal(0);
  });

  it("5. the faucet funds it — tokens AND the SOL a bet needs for rent", async () => {
    const res = await fetch(`${API}/faucet/${judge.publicKey.toBase58()}`, {
      method: "POST",
    });
    expect(res.status, "faucet rejected a fresh wallet").to.equal(200);
    const body: any = await res.json();
    expect(body.ok).to.equal(true);

    const sol = await conn.getBalance(judge.publicKey);
    expect(
      sol,
      "no SOL — the bet cannot pay rent for its Position account"
    ).to.be.greaterThan(0);

    const mint = new PublicKey(openMarket.usdcMint);
    const ata = getAssociatedTokenAddressSync(mint, judge.publicKey);
    const acc = await getAccount(conn, ata);
    expect(Number(acc.amount), "no demo USDC").to.be.greaterThan(0);
  });

  it("6. the bet lands: simulate -> sign -> WE broadcast -> poll to confirm", async () => {
    const idl = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "target", "idl", "proofbook.json"),
        "utf8"
      )
    );
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(judge), {
      commitment: "confirmed",
    });
    const program = new anchor.Program(idl, provider) as any;

    const marketPk = new PublicKey(openMarket.marketPda);
    const mint = new PublicKey(openMarket.usdcMint);
    const [position] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        marketPk.toBuffer(),
        judge.publicKey.toBuffer(),
      ],
      program.programId
    );

    const ix = await program.methods
      .placeBet(0, new BN(25).mul(new BN(1e6)))
      .accounts({
        bettor: judge.publicKey,
        market: marketPk,
        position,
        bettorToken: getAssociatedTokenAddressSync(mint, judge.publicKey),
        vault: new PublicKey(openMarket.vault),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
      "confirmed"
    );
    const tx = new Transaction().add(ix);
    tx.feePayer = judge.publicKey;
    tx.recentBlockhash = blockhash;

    // Simulate BEFORE the wallet is asked to sign — a program error must surface
    // as itself, not as an approved popup and a silent failure.
    const sim = await conn.simulateTransaction(tx);
    expect(
      sim.value.err,
      `bet would fail: ${JSON.stringify(sim.value.err)}`
    ).to.equal(null);

    tx.sign(judge);
    // The APP broadcasts. The wallet only signs — so a wallet on the wrong network
    // cannot misroute the bet.
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      maxRetries: 3,
    });

    // Confirm by POLLING, not a websocket subscription — a socket that never opens
    // hangs the UI on "confirming" forever even though the bet landed.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err)
        throw new Error(`bet failed on-chain: ${JSON.stringify(st.err)}`);
      if (
        st?.confirmationStatus === "confirmed" ||
        st?.confirmationStatus === "finalized"
      )
        break;
      if (Date.now() > deadline) throw new Error("bet timed out");
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight)
        throw new Error("blockhash expired");
      await sleep(1000);
    }
  });

  it("7. the API shows the position — from Postgres, without touching the chain", async () => {
    // The keeper indexes positions on its sync loop; give it a couple of ticks.
    let positions: any[] = [];
    for (let i = 0; i < 20; i++) {
      positions = await get<any[]>(`/positions/${judge.publicKey.toBase58()}`);
      if (positions.length > 0) break;
      await sleep(2000);
    }
    expect(
      positions.length,
      "the keeper never indexed the judge's bet"
    ).to.be.greaterThan(0);

    const p = positions[0];
    expect(p.market).to.equal(openMarket.marketPda);
    expect(p.amount).to.equal("25000000");
    expect(p.claimable).to.equal("pending"); // the match has not been played yet
  });

  it("8. a receipt is real: proof ref, resolver, and a settle tx anyone can check", async () => {
    const receipts = await get<any>("/receipts?limit=1");
    const r = receipts.items[0];

    expect(r.proofRef, "no proof ref").to.match(/^[0-9a-f]{64}$/);
    expect(r.settleTx).to.be.a("string");
    expect(r.oracleProgram).to.equal(
      "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
    );

    // The settle transaction must actually exist on-chain and have CPI'd the oracle.
    const tx = await conn.getTransaction(r.settleTx, {
      maxSupportedTransactionVersion: 0,
    });
    expect(tx, `settle tx ${r.settleTx} is NOT on devnet`).to.not.equal(null);
    expect(tx!.meta?.err, "the settle transaction failed").to.equal(null);

    const logs = tx!.meta?.logMessages ?? [];
    expect(
      logs.some((l) =>
        l.includes("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J invoke")
      ),
      "the settlement never called the TxLINE oracle"
    ).to.equal(true);
  });
});
