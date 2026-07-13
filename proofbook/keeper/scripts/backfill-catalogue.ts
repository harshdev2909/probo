/**
 * THE RECEIPT WALL — backfill the provable market catalogue across every fixture
 * whose proof TxLINE still retains, and settle each one with a REAL v3 multiproof.
 *
 * Nothing here is fabricated. Every market settles by CPI-ing the real
 * `validate_stat_v3` on the real txoracle program, against a real Merkle root
 * TxLINE published on devnet. If a proof cannot be obtained, the market is not
 * created and the fixture is reported as a gap — never invented, never
 * admin-settled.
 *
 * Three phases, because `place_bet` requires `now < lock_time` while
 * `lock_market` requires `now >= lock_time`, so every market needs a real betting
 * window:
 *
 *   1. CREATE  — market + ComboSpec (one atomic tx), then stake EVERY outcome
 *   2. WAIT    — until the last market's lock_time passes
 *   3. SETTLE  — lock, fetch the v3 multiproof, settle_market_v3
 *
 * Idempotent and resumable at every step: it re-reads on-chain state before each
 * action, so a re-run skips what is already done and finishes what is not.
 *
 *   npm run backfill:catalogue                    # everything
 *   FIXTURE_IDS=18218149 npm run backfill:catalogue
 *   TYPES=24,25 npm run backfill:catalogue        # just the parlays
 *   PHASE=settle npm run backfill:catalogue       # resume mid-run
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { loadConfig } from "../src/config";
import { Logger } from "../src/logger";
import { Store } from "../src/state";
import { Chain, statusName } from "../src/chain/proofbook";
import { TxLineSession } from "../src/txline/session";
import { TxLineClient } from "../src/txline/client";
import { CATALOGUE, MarketTypeDef, statKeysOf, withPeriod } from "../src/markets/catalogue";
import { buildV3Proof, claimedOutcomeFor } from "../src/markets/v3proof";
import { withRetry } from "../src/backfill/retry";
import type { FixturePlan } from "../src/backfill/plan";

const log = new Logger("backfill:catalogue");

/**
 * A three-hour batch job must not die because a socket blinked.
 *
 * Twice now an RPC connect-reset surfaced as an unhandled rejection from deep
 * inside web3.js and took the whole process down mid-run — once at 623 markets,
 * once at 154. Every step here is idempotent and re-reads chain state before
 * acting, so the correct response to a transient network fault is to log it and
 * keep going; the next pass picks up whatever was missed.
 *
 * This is NOT a blanket "ignore errors": settlement failures are still caught,
 * counted, and reported per market. This only stops the PROCESS from dying.
 */
process.on("unhandledRejection", (e: any) => {
  log.warn("unhandled rejection — continuing (the run is idempotent)", {
    error: String(e?.message ?? e).slice(0, 160),
  });
});

const LOCK_DELAY_SEC = Number(process.env.CATALOGUE_LOCK_DELAY_SEC ?? 900);
const THROTTLE_MS = Number(process.env.CATALOGUE_THROTTLE_MS ?? 350);
/** Stop creating markets if the keeper drops below this — never strand a market. */
const MIN_SOL = Number(process.env.CATALOGUE_MIN_SOL ?? 0.5);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  fixtureId: number;
  type: number;
  slug: string;
  market: PublicKey;
  outcomes: number;
  status: "created" | "settled" | "cancelled" | "skipped" | "failed";
  winning?: number;
  label?: string;
  values?: number[];
  settleTx?: string;
  reason?: string;
}

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);
  const session = new TxLineSession(cfg, store, chain);
  await session.ensure();
  const client = new TxLineClient(session);

  const usdcMint = await chain.ensureUsdcMint();
  const phase = (process.env.PHASE ?? "all").toLowerCase();

  // ── which market types ────────────────────────────────────────────────────
  // NB: "".split(",") is [""], and Number("") is 0 — so an unset var must be
  // screened for emptiness BEFORE Number(), or "no filter" becomes "filter to 0".
  const typeFilter = (process.env.TYPES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const types = typeFilter.length
    ? CATALOGUE.filter((m) => typeFilter.includes(m.type))
    : CATALOGUE;

  // ── which fixtures: ONLY those with a retrievable proof ───────────────────
  const planFile = path.join(cfg.dataDir, "..", "plan.json");
  const planPath = fs.existsSync(planFile)
    ? planFile
    : path.join(cfg.dataDir, "plan.json");
  const plan: FixturePlan[] = JSON.parse(fs.readFileSync(planPath, "utf8"));

  const idFilter = (process.env.FIXTURE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));

  let fixtures = plan.filter(
    (p) => p.status === "settleable" && p.seq && p.period !== undefined
  );
  if (idFilter.length)
    fixtures = fixtures.filter((f) => idFilter.includes(f.fixtureId));

  const gaps = plan.filter((p) => p.status !== "settleable");

  log.info("backfill plan", {
    marketTypes: types.length,
    provableFixtures: fixtures.length,
    gapFixtures: gaps.length,
    potentialMarkets: fixtures.length * types.length,
  });

  // ── bettor pool: ONE WALLET PER OUTCOME ──────────────────────────────────
  // Position is a PDA of (market, owner), so one wallet can back exactly one
  // outcome of a given market. The widest market has 5 outcomes.
  const maxOutcomes = Math.max(...types.map((t) => t.outcomes.length));
  const bettors = loadBettors(cfg.dataDir, maxOutcomes);
  log.info("bettor pool", {
    need: maxOutcomes,
    have: bettors.length,
    wallets: bettors.map((b) => b.publicKey.toBase58().slice(0, 6)),
  });
  await fundBettors(chain, bettors, usdcMint);

  const rows: Row[] = [];
  let lastLockTime = 0;

  // ══ PHASE 1 — CREATE + STAKE EVERY OUTCOME ═══════════════════════════════
  if (phase === "all" || phase === "create") {
    log.info("PHASE 1 — creating markets and staking every outcome");
    let made = 0;
    for (const fx of fixtures) {
      // Bettors burn SOL on Position rent as we go; keep them solvent.
      if (made && made % 40 === 0) {
        await fundBettors(chain, bettors, usdcMint).catch((e) =>
          log.warn("bettor top-up failed (will retry next batch)", {
            error: String(e?.message).slice(0, 100),
          })
        );
      }
      for (const def of types) {
        const market = chain.marketPdaFor(fx.fixtureId, def.type);
        let existing: any = null;
        try {
          existing = await chain.fetchMarket(market);
        } catch (e: any) {
          log.warn("could not read market — skipping this tick", {
            fixture: fx.fixtureId,
            slug: def.slug,
            error: String(e?.message).slice(0, 100),
          });
          continue; // idempotent: a re-run will pick it up
        }

        if (existing) {
          const st = statusName(existing.status);
          if (st === "settled" || st === "cancelled") continue; // done already
          // Exists but Open/Locked: make sure it is actually staked everywhere.
          if (st === "open") {
            const zero = existing.outcomes.some((o: any) => Number(o.pool) === 0);
            if (zero && Number(existing.lockTime) * 1000 > Date.now()) {
              await stakeAll(chain, market, bettors, def).catch((e) =>
                log.warn("stake failed", { fixture: fx.fixtureId, type: def.type, e: e.message })
              );
            }
            lastLockTime = Math.max(lastLockTime, Number(existing.lockTime));
          }
          continue;
        }

        // A bare await here once killed the whole run: an RPC connect timeout
        // threw outside the try/catch below and took the process down after 623
        // markets. Every network call in this loop has to be survivable — the
        // run is hours long and the RPC will blink.
        let sol = Infinity;
        try {
          sol =
            (await chain.connection.getBalance(chain.wallet.publicKey)) /
            LAMPORTS_PER_SOL;
        } catch {
          /* can't read the balance right now; the create below will fail loudly
             if we are genuinely broke */
        }
        if (sol < MIN_SOL) {
          log.error("SOL floor reached — stopping creation rather than stranding markets", {
            balance: sol,
            floor: MIN_SOL,
          });
          break;
        }

        const lockTime = Math.floor(Date.now() / 1000) + LOCK_DELAY_SEC;
        try {
          // The spec must pin the period the fixture's proof ACTUALLY carries.
          // 58 of 76 fixtures end at period 5, not 100 — and a spec that
          // disagrees with its leaf can never settle (InvalidStatProof, 6023).
          const bound = withPeriod(def, fx.period!);
          await withRetry(
            `create ${fx.fixtureId}/${def.slug}`,
            () =>
              chain.initializeComboMarket(
                fx.fixtureId,
                bound,
                usdcMint,
                lockTime,
                cfg.resolutionTimeoutSec
              ),
            log
          );
          await stakeAll(chain, market, bettors, def);
          lastLockTime = Math.max(lastLockTime, lockTime);
          made++;
          log.info("created + staked", {
            fixture: fx.fixtureId,
            type: def.type,
            slug: def.slug,
            outcomes: def.outcomes.length,
          });
        } catch (e: any) {
          log.warn("create failed", {
            fixture: fx.fixtureId,
            slug: def.slug,
            error: String(e?.message).slice(0, 160),
          });
        }
        await sleep(THROTTLE_MS);
      }
    }
  }

  // ══ PHASE 2 — WAIT OUT THE BETTING WINDOW ════════════════════════════════
  if ((phase === "all" || phase === "settle") && lastLockTime) {
    const waitMs = lastLockTime * 1000 + 5_000 - Date.now();
    if (waitMs > 0) {
      log.info(`PHASE 2 — waiting ${Math.ceil(waitMs / 1000)}s for the last betting window to close`);
      await sleep(waitMs);
    }
  }

  // ══ PHASE 3 — LOCK + SETTLE WITH REAL v3 MULTIPROOFS ═════════════════════
  if (phase === "all" || phase === "settle") {
    log.info("PHASE 3 — locking and settling with REAL validate_stat_v3 proofs");

    for (const fx of fixtures) {
      // One REST call per distinct stat-key set, reused across market types.
      // Five of the twelve types read [1,2]; fetching per market would be 5x the
      // calls for byte-identical proofs.
      const proofCache = new Map<string, any>();

      for (const def of types) {
        const market = chain.marketPdaFor(fx.fixtureId, def.type);
        const row: Row = {
          fixtureId: fx.fixtureId,
          type: def.type,
          slug: def.slug,
          market,
          outcomes: def.outcomes.length,
          status: "failed",
        };

        try {
          const onchain = await chain.fetchMarket(market);
          if (!onchain) {
            row.status = "skipped";
            row.reason = "no market";
            rows.push(row);
            continue;
          }
          const st = statusName(onchain.status);
          if (st === "settled" || st === "cancelled") {
            row.status = st;
            row.winning = onchain.winningOutcome;
            row.label = def.outcomes[onchain.winningOutcome]?.label;
            rows.push(row);
            continue; // idempotent
          }

          // ── the REAL proof ────────────────────────────────────────────────
          const keys = statKeysOf(def);
          const ck = keys.join(",");
          if (!proofCache.has(ck)) {
            proofCache.set(
              ck,
              await withRetry(
                `v3 proof ${fx.fixtureId} [${ck}]`,
                () => client.statValidationV3(fx.fixtureId, fx.seq!, keys),
                log
              )
            );
            await sleep(THROTTLE_MS);
          }
          const val = proofCache.get(ck);

          const built = buildV3Proof(val, withPeriod(def, fx.period!), fx.fixtureId);
          const claimed = claimedOutcomeFor(def, built.values);
          if (claimed < 0) {
            // An exhaustive catalogue must always have a matching outcome. If it
            // does not, the data is not what we believe it is — do not settle.
            throw new Error(
              `no outcome matches proven values [${built.values}] — refusing to settle`
            );
          }

          if (st === "open") {
            if (Number(onchain.lockTime) * 1000 > Date.now()) {
              row.status = "skipped";
              row.reason = "still in its betting window";
              rows.push(row);
              continue;
            }
            const zero = onchain.outcomes.some((o: any) => Number(o.pool) === 0);
            if (zero) {
              // Would settle straight to Cancelled and earn no receipt.
              throw new Error("an outcome has zero stake — would cancel, not settle");
            }
            await withRetry(`lock ${fx.fixtureId}/${def.slug}`, () => chain.lockMarket(market), log);
          }

          const sig = await withRetry(
            `settle_v3 ${fx.fixtureId}/${def.slug}`,
            () => chain.settleMarketV3(market, claimed, built.proof, built.epochDay),
            log
          );

          const after = await chain.fetchMarket(market);
          row.status = statusName(after.status) as any;
          row.winning = claimed;
          row.label = def.outcomes[claimed].label;
          row.values = built.values;
          row.settleTx = sig;
          log.info("SETTLED via validate_stat_v3", {
            fixture: fx.fixtureId,
            slug: def.slug,
            outcome: def.outcomes[claimed].label,
            values: built.values,
            tx: sig,
          });
        } catch (e: any) {
          row.reason = String(e?.message ?? e).slice(0, 180);
          log.warn("settle failed", {
            fixture: fx.fixtureId,
            slug: def.slug,
            error: row.reason,
          });
        }
        rows.push(row);
        await sleep(THROTTLE_MS);
      }
    }
  }

  report(rows, types, fixtures.length, gaps.length);
  store.flush();
}

/** Stake EVERY outcome, atomically. One wallet per outcome. */
async function stakeAll(
  chain: Chain,
  market: PublicKey,
  bettors: Keypair[],
  def: MarketTypeDef
) {
  const n = def.outcomes.length;
  // Deterministic, fixture-independent book: never zero, and rotated so the same
  // wallet is not always on outcome 0.
  const amounts = Array.from({ length: n }, (_, i) =>
    new BN((25 + ((i * 37) % 60)) * 1_000_000)
  );
  await chain.placeBetsAtomic(bettors.slice(0, n), market, amounts);
}

/** Load (or extend) the persistent demo bettor pool to `need` wallets. */
function loadBettors(dataDir: string, need: number): Keypair[] {
  const file = path.join(dataDir, "bettors.json");
  let raw: number[][] = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : [];
  const kps = raw.map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
  // APPEND only — the existing wallets already hold positions on live markets.
  while (kps.length < need) kps.push(Keypair.generate());
  if (kps.length > raw.length) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(kps.map((k) => Array.from(k.secretKey)), null, 2)
    );
  }
  return kps;
}

/**
 * Top every bettor up with SOL (position rent) and demo USDC (the stake).
 *
 * `place_bet` opens a Position account and the BETTOR pays its rent, so across a
 * ~900-market wall each wallet needs real SOL — the wallet on outcome 0 alone
 * opens one position per market. Topped up INCREMENTALLY during the run rather
 * than pre-loaded, so the keeper only parts with what is actually consumed.
 */
async function fundBettors(chain: Chain, bettors: Keypair[], usdcMint: PublicKey) {
  for (const b of bettors) {
    const sol = await chain.connection.getBalance(b.publicKey);
    if (sol < 0.5 * LAMPORTS_PER_SOL) {
      const tx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: chain.wallet.publicKey,
          toPubkey: b.publicKey,
          lamports: 1.0 * LAMPORTS_PER_SOL,
        })
      );
      await chain.provider.sendAndConfirm!(tx, []);
      log.info("topped up bettor SOL", { wallet: b.publicKey.toBase58().slice(0, 8) });
    }
    const ata = await getOrCreateAssociatedTokenAccount(
      chain.connection,
      chain.wallet,
      usdcMint,
      b.publicKey
    );
    if (Number(ata.amount) < 200_000 * 1_000_000) {
      await mintTo(
        chain.connection,
        chain.wallet,
        usdcMint,
        ata.address,
        chain.wallet,
        BigInt(2_000_000 * 1_000_000)
      );
      log.info("funded bettor USDC", { wallet: b.publicKey.toBase58().slice(0, 8) });
    }
  }
}

function report(
  rows: Row[],
  types: MarketTypeDef[],
  provable: number,
  gaps: number
) {
  const settled = rows.filter((r) => r.status === "settled");
  const cancelled = rows.filter((r) => r.status === "cancelled");
  const failed = rows.filter((r) => r.status === "failed");
  const skipped = rows.filter((r) => r.status === "skipped");

  console.log("\n" + "═".repeat(72));
  console.log("  RECEIPT WALL — settled by REAL validate_stat_v3 multiproofs");
  console.log("═".repeat(72));
  console.log(`  provable fixtures : ${provable}`);
  console.log(`  unprovable (gaps) : ${gaps}   (outside TxLINE retention — no receipt, and we say so)`);
  console.log(`  market types      : ${types.length}\n`);

  console.log("  type  market                    settled  cancelled  failed");
  console.log("  ────  ────────────────────────  ───────  ─────────  ──────");
  for (const t of types) {
    const s = settled.filter((r) => r.type === t.type).length;
    const c = cancelled.filter((r) => r.type === t.type).length;
    const f = failed.filter((r) => r.type === t.type).length;
    console.log(
      `  ${String(t.type).padEnd(4)}  ${t.name.padEnd(24)}  ${String(s).padStart(7)}  ${String(
        c
      ).padStart(9)}  ${String(f).padStart(6)}${t.parlay ? "   parlay" : ""}`
    );
  }
  console.log("  ────  ────────────────────────  ───────  ─────────  ──────");
  console.log(
    `        TOTAL                     ${String(settled.length).padStart(7)}  ${String(
      cancelled.length
    ).padStart(9)}  ${String(failed.length).padStart(6)}`
  );
  if (skipped.length) console.log(`\n  skipped: ${skipped.length}`);

  if (failed.length) {
    console.log("\n  failures (no receipt — not invented):");
    const byReason = new Map<string, number>();
    failed.forEach((f) =>
      byReason.set(f.reason ?? "?", (byReason.get(f.reason ?? "?") ?? 0) + 1)
    );
    [...byReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([r, n]) => console.log(`    ${String(n).padStart(4)} x  ${r}`));
  }

  const ex = settled.find((r) => r.settleTx && r.values);
  if (ex) {
    console.log(`\n  sample REAL v3 settlement:`);
    console.log(`    ${ex.slug}  fixture ${ex.fixtureId}`);
    console.log(`    proven stats  [${ex.values}]  ->  "${ex.label}"`);
    console.log(`    tx  ${ex.settleTx}`);
  }
  console.log("═".repeat(72) + "\n");

  fs.writeFileSync(
    path.join("keeper", "data", "catalogue-report.json"),
    JSON.stringify(rows, null, 2)
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
