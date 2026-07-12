/**
 * PHASE 2b — seed REAL liquidity into every settleable market.
 *
 * WHY THIS EXISTS
 * ───────────────
 * settle_market routes a market to `Cancelled (refundable)` when the winning
 * outcome has **zero** staked pool — correct behaviour (there is nobody to pay,
 * so everyone gets their money back), but it means a market with no bets can
 * never become `Settled` and therefore never earns a Proof Receipt.
 *
 * So the markets need genuine stake before the backfill settles them. Three
 * persistent bettor wallets each take a DIFFERENT outcome on each market
 * (Position is a PDA of (market, owner), so one wallet = one outcome), which
 * gives every outcome a non-zero pool. The result is a real parimutuel market:
 * real crowd-implied odds, real winners, real losers, real claimable payouts.
 *
 * The stakes are deterministic (PRNG seeded by fixtureId), so `demo:seed` is
 * reproducible and the pools are identical on every rebuild. The crowd is
 * deliberately NOT always right — weights are independent of the true result,
 * so plenty of markets settle against the favourite. That is the product's
 * whole point: the crowd is an opinion, the proof is not.
 */
import * as fs from "fs";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

import { loadConfig, ROOT } from "../src/config";
import { Logger } from "../src/logger";
import { Store } from "../src/state";
import { Chain, statusName } from "../src/chain/proofbook";
import { withRetry } from "../src/backfill/retry";
import type { FixturePlan } from "../src/backfill/plan";
import { resolveTeam } from "../../data/tournament";

const log = new Logger("liquidity");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const THROTTLE = Number(process.env.LIQ_THROTTLE_MS ?? 500);
const BETTOR_SOL = 0.55;

/** Deterministic PRNG so the seeded book is identical on every run. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A plausible-looking book for one fixture. Weights are drawn from the fixture
 * id alone — never from the true result — so the crowd is wrong about as often
 * as a real crowd is.
 */
function bookFor(fixtureId: number): [number, number, number] {
  const rnd = mulberry32(fixtureId);
  const total = 800 + Math.floor(rnd() * 5200); // 800 .. 6000 USDC
  // Dirichlet-ish: draw 3 weights, floor each at 8% so no pool is ever zero.
  const raw = [rnd() + 0.25, rnd() * 0.7 + 0.2, rnd() + 0.25];
  const sum = raw[0] + raw[1] + raw[2];
  const w = raw.map((x) => Math.max(0.08, x / sum));
  const wsum = w[0] + w[1] + w[2];
  return w.map((x) => Math.max(25, Math.round((total * x) / wsum))) as [
    number,
    number,
    number
  ];
}

/** Load (or create once) the three persistent demo bettors. */
function loadBettors(dataDir: string): Keypair[] {
  const file = path.join(dataDir, "bettors.json");
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as number[][];
    return raw.map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
  }
  const kps = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(kps.map((k) => Array.from(k.secretKey)))
  );
  return kps;
}

/** Optional `FIXTURE_IDS=a,b,c` filter — lets one fixture be seeded or settled
 *  into a fresh market generation without touching the other 100+. */
function fixtureFilter(plans: FixturePlan[]): FixturePlan[] {
  const raw = process.env.FIXTURE_IDS;
  if (!raw) return plans;
  const want = new Set(raw.split(",").map((x) => Number(x.trim())));
  return plans.filter((p) => want.has(p.fixtureId));
}

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);
  const conn = chain.connection;
  const payer = chain.payer;

  const plans: FixturePlan[] = JSON.parse(
    fs.readFileSync(path.join(ROOT, "keeper", "data", "plan.json"), "utf8")
  );
  // Stake only where a market can actually resolve: proven fixtures, plus the
  // still-open ones. Never stake an honest-gap market — that money could only
  // ever be refunded, and a fat pool there would imply a receipt is coming.
  const targets = fixtureFilter(
    plans.filter(
      (p) => p.status === "settleable" || p.status === "not_finished"
    )
  );

  const mint = await withRetry("mint", () => chain.ensureUsdcMint(), log);
  const bettors = loadBettors(cfg.dataDir);
  log.info(`seeding liquidity across ${targets.length} markets`, {
    bettors: bettors.map((b) => b.publicKey.toBase58().slice(0, 8)),
  });

  // ── fund the bettors once (SOL for position rent + fees, USDC to stake) ──
  for (const b of bettors) {
    const bal = await conn.getBalance(b.publicKey);
    if (bal < BETTOR_SOL * LAMPORTS_PER_SOL * 0.5) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: b.publicKey,
          lamports: Math.floor(BETTOR_SOL * LAMPORTS_PER_SOL),
        })
      );
      await withRetry(
        "fund SOL",
        () => chain.provider.sendAndConfirm!(tx, []),
        log
      );
    }
    const ata = await withRetry(
      "ata",
      () => getOrCreateAssociatedTokenAccount(conn, payer, mint, b.publicKey),
      log
    );
    if (Number(ata.amount) < 500_000 * 1e6) {
      await withRetry(
        "mint USDC",
        () =>
          mintTo(
            conn,
            payer,
            mint,
            ata.address,
            payer,
            BigInt(1_000_000 * 1e6)
          ),
        log
      );
    }
    log.info(`bettor ${b.publicKey.toBase58().slice(0, 8)} funded`);
  }

  const existing = await withRetry(
    "load markets",
    () => chain.allMarkets(),
    log
  );
  const byPda = new Map(
    existing.map((m) => [m.publicKey.toBase58(), m.account])
  );

  let staked = 0,
    skipped = 0,
    failed = 0;

  for (const p of targets) {
    const label = `${resolveTeam(p.p1Name).code} v ${
      resolveTeam(p.p2Name).code
    }`;
    const pda = chain.marketPdaFor(p.fixtureId, cfg.marketType);
    const m = byPda.get(pda.toBase58());
    if (!m) {
      skipped++;
      log.warn(`skip ${label}: not seeded`);
      continue;
    }
    if (statusName(m.status) !== "open") {
      skipped++;
      continue;
    }
    if (Number(m.totalPool) > 0) {
      skipped++;
      continue;
    } // already has a book
    if (Number(m.lockTime) * 1000 <= Date.now()) {
      // Betting has already closed on this market — place_bet would revert. It
      // can never carry a receipt, so leave it alone rather than fail loudly.
      skipped++;
      log.warn(`skip ${label}: betting window already closed`);
      continue;
    }

    const book = bookFor(p.fixtureId);
    // Rotate which wallet takes which outcome so the same wallet isn't always
    // on the same side of the board.
    const rot = p.fixtureId % 3;

    try {
      // outcome i is staked by bettor (i + rot) % 3 — rotated so the same wallet
      // isn't always on the same side of the board
      const signers = [0, 1, 2].map((i) => bettors[(i + rot) % 3]);
      const amounts = book.map((a) => new BN(a).mul(new BN(1e6)));
      await withRetry(
        `bet ${label}`,
        () => chain.placeBetsAtomic(signers, pda, amounts),
        log
      );
      await sleep(THROTTLE);
      staked++;
      log.info(
        `staked ${label.padEnd(11)} H:${book[0]} D:${book[1]} A:${book[2]} USDC`
      );
    } catch (e: any) {
      failed++;
      log.error(`FAIL  ${label}`, {
        error:
          e?.error?.errorCode?.code ?? String(e?.message ?? e).slice(0, 70),
      });
    }
  }

  log.info("═══════════════════════════════════");
  log.info(`staked ${staked} markets · skipped ${skipped} · failed ${failed}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
