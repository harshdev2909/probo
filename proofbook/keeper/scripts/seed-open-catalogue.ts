/**
 * Seed the FULL provable catalogue onto still-OPEN, not-yet-played fixtures.
 *
 * `backfill-catalogue.ts` is the sibling of this script, but it only targets
 * fixtures already in plan.json as `settleable` — i.e. PLAYED games TxLINE can
 * prove right now. An upcoming fixture (the Final, the 3rd-place playoff) has no
 * proof yet, so it never appears there, yet it is exactly where more markets are
 * wanted. This script fills that gap.
 *
 * What it does, per fixture, per catalogue type (29..39 by default — NOT 28, the
 * 1X2 already exists as the legacy type-3 market):
 *
 *   1. Reads the fixture's KICKOFF from its existing market's lock_time, so every
 *      new market locks at the same kickoff as the Match Winner already does.
 *   2. Idempotently creates the Market + its ComboSpec sidecar (one call), skipping
 *      anything already on chain.
 *   3. Stakes EVERY outcome — one bettor wallet per outcome — so no outcome has a
 *      zero pool. A zero-stake winning outcome silently cancels on settle.
 *
 * The spec pins period 100 (game_finalised). An upcoming fixture finalises at
 * period 100, and the catalogue's legs are P=100, so this is asserted, not assumed:
 * a period-5 pin would strand the market forever (InvalidStatProof 6023).
 *
 *   FIXTURE_IDS=18257739,18257865 TYPES=29,30,...,39 npm run seed:open-catalogue
 */
import { BN } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { loadConfig } from "../src/config";
import { Logger } from "../src/logger";
import { Store } from "../src/state";
import { Chain, statusName } from "../src/chain/proofbook";
import { CATALOGUE, MarketTypeDef } from "../src/markets/catalogue";

const log = new Logger("seed-open");

const FINALISED_PERIOD = 100;
// Modest, scoped funding: these bettors already hold ~0.05 SOL and this is a
// two-fixture job, not the 900-market wall. Top up only when genuinely low, and
// with a small amount, so this never over-draws the keeper's settlement reserve.
const BETTOR_MIN_SOL = Number(process.env.BETTOR_MIN_SOL ?? 0.12);
const BETTOR_TOPUP_SOL = Number(process.env.BETTOR_TOPUP_SOL ?? 0.15);
// Preview mode: resolve fixtures, kickoffs and the create/skip plan, spend nothing.
const DRY_RUN = process.env.DRY_RUN === "1";

const numList = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));

async function main() {
  const cfg = loadConfig("live");
  const store = new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);
  const usdcMint = await chain.ensureUsdcMint();

  const fixtureIds = numList(process.env.FIXTURE_IDS);
  if (!fixtureIds.length)
    throw new Error("FIXTURE_IDS is required (the open fixtures to extend)");

  // Default to the full non-1X2 catalogue. 28 (gen-2 Match Result) is skipped so
  // it never duplicates the legacy type-3 1X2 already on these fixtures.
  const typeFilter = numList(process.env.TYPES);
  const types: MarketTypeDef[] = (
    typeFilter.length
      ? CATALOGUE.filter((m) => typeFilter.includes(m.type))
      : CATALOGUE.filter((m) => m.type >= 29)
  ).sort((a, b) => a.type - b.type);

  // Hard rule: every spec must pin period 100. Refuse to create otherwise.
  for (const def of types)
    for (const leg of def.legs)
      if (leg.period !== FINALISED_PERIOD)
        throw new Error(
          `${def.slug} leg key ${leg.key} pins period ${leg.period}, not 100 — an ` +
            `upcoming fixture finalises at 100, so this spec could never settle`
        );

  const maxOutcomes = Math.max(...types.map((t) => t.outcomes.length));
  const bettors = loadBettors(cfg.dataDir, maxOutcomes);

  log.info("plan", {
    fixtures: fixtureIds,
    types: types.map((t) => t.type),
    outcomesWidest: maxOutcomes,
    bettors: bettors.length,
  });

  if (DRY_RUN) log.info("DRY_RUN — no transactions will be sent");
  if (!DRY_RUN) await fundBettors(chain, bettors, usdcMint);

  const created: Record<number, string[]> = {};
  const staked: Record<number, string[]> = {};

  for (const fixtureId of fixtureIds) {
    created[fixtureId] = [];
    staked[fixtureId] = [];

    const lockTime = await kickoffLockTime(chain, fixtureId);
    if (lockTime * 1000 <= Date.now())
      throw new Error(
        `fixture ${fixtureId} kickoff ${new Date(lockTime * 1000).toISOString()} is in ` +
          `the past — refusing to create markets that would lock immediately`
      );
    log.info(`fixture ${fixtureId}`, {
      kickoff: new Date(lockTime * 1000).toISOString(),
    });

    for (const def of types) {
      const market = chain.marketPdaFor(fixtureId, def.type);

      let existing: any = null;
      try {
        existing = await chain.fetchMarket(market);
      } catch (e: any) {
        log.warn("could not read market — skipping this tick (re-run picks it up)", {
          fixtureId,
          slug: def.slug,
          error: String(e?.message).slice(0, 100),
        });
        continue;
      }

      if (existing) {
        const st = statusName(existing.status);
        if (st === "settled" || st === "cancelled") continue;
        // Exists but open: make sure every outcome is actually staked.
        if (st === "open" || st === "locked") {
          const zero = existing.outcomes?.some((o: any) => Number(o.pool) === 0);
          if (zero && Number(existing.lockTime) * 1000 > Date.now()) {
            if (DRY_RUN) {
              log.info("would RE-STAKE (zero-pool outcome found)", { fixtureId, slug: def.slug });
            } else {
              await stakeAll(chain, market, bettors, def).catch((e) =>
                log.warn("re-stake failed", { fixtureId, type: def.type, e: e.message })
              );
            }
            staked[fixtureId].push(def.slug);
          }
        }
        continue;
      }

      if (DRY_RUN) {
        log.info("would CREATE + stake every outcome", {
          fixtureId,
          type: def.type,
          slug: def.slug,
          outcomes: def.outcomes.length,
        });
        created[fixtureId].push(def.slug);
        continue;
      }

      try {
        await chain.initializeComboMarket(
          fixtureId,
          def, // period-100 as authored — asserted above
          usdcMint,
          lockTime,
          cfg.resolutionTimeoutSec
        );
        await stakeAll(chain, market, bettors, def);
        created[fixtureId].push(def.slug);
        staked[fixtureId].push(def.slug);
        log.info("created + staked every outcome", {
          fixtureId,
          type: def.type,
          slug: def.slug,
          outcomes: def.outcomes.length,
        });
      } catch (e: any) {
        log.warn("create failed (idempotent — re-run to retry)", {
          fixtureId,
          slug: def.slug,
          error: String(e?.message).slice(0, 180),
        });
      }
    }
  }

  console.log("\n" + "═".repeat(64));
  console.log("  OPEN-FIXTURE CATALOGUE");
  console.log("═".repeat(64));
  for (const fixtureId of fixtureIds) {
    console.log(`  fixture ${fixtureId}`);
    console.log(`    created : ${created[fixtureId].join(", ") || "(all already existed)"}`);
    console.log(`    staked  : ${staked[fixtureId].join(", ") || "(none needed)"}`);
  }
  const bal = await chain.connection.getBalance(chain.wallet.publicKey);
  console.log(`\n  keeper SOL remaining: ${(bal / LAMPORTS_PER_SOL).toFixed(4)}`);
  store.flush();
}

/** The fixture's kickoff, read from any market already on it (its lock_time). */
async function kickoffLockTime(chain: Chain, fixtureId: number): Promise<number> {
  const all = await chain.program.account.market.all([
    // memcmp on fixture_id would be ideal, but a small scan is fine for 2 fixtures.
  ]);
  const mine = all.filter((a: any) => Number(a.account.fixtureId) === fixtureId);
  if (!mine.length)
    throw new Error(
      `fixture ${fixtureId} has no existing market to read a kickoff from — ` +
        `create its Match Winner first, or pass the lock time explicitly`
    );
  // They should all share the kickoff; take the max to be safe.
  return Math.max(...mine.map((a: any) => Number(a.account.lockTime)));
}

/** Stake EVERY outcome, one wallet per outcome. Deterministic, never zero. */
async function stakeAll(
  chain: Chain,
  market: PublicKey,
  bettors: Keypair[],
  def: MarketTypeDef
) {
  const n = def.outcomes.length;
  const amounts = Array.from(
    { length: n },
    (_, i) => new BN((25 + ((i * 37) % 60)) * 1_000_000)
  );
  await chain.placeBetsAtomic(bettors.slice(0, n), market, amounts);
}

/** Load (or extend) the persistent demo bettor pool to `need` wallets. */
function loadBettors(dataDir: string, need: number): Keypair[] {
  const file = path.join(dataDir, "bettors.json");
  const raw: number[][] = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : [];
  const kps = raw.map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
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

/** Modest SOL + generous demo-USDC top-up. See BETTOR_MIN_SOL above for why small. */
async function fundBettors(chain: Chain, bettors: Keypair[], usdcMint: PublicKey) {
  for (const b of bettors) {
    const sol = await chain.connection.getBalance(b.publicKey);
    if (sol < BETTOR_MIN_SOL * LAMPORTS_PER_SOL) {
      const tx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: chain.wallet.publicKey,
          toPubkey: b.publicKey,
          lamports: Math.floor(BETTOR_TOPUP_SOL * LAMPORTS_PER_SOL),
        })
      );
      await chain.provider.sendAndConfirm!(tx, []);
      log.info("topped up bettor SOL", {
        wallet: b.publicKey.toBase58().slice(0, 8),
        sol: BETTOR_TOPUP_SOL,
      });
    }
    const ata = await getOrCreateAssociatedTokenAccount(
      chain.connection,
      chain.wallet,
      usdcMint,
      b.publicKey
    );
    if (Number(ata.amount) < 100_000 * 1_000_000) {
      await mintTo(
        chain.connection,
        chain.wallet,
        usdcMint,
        ata.address,
        chain.wallet,
        BigInt(1_000_000 * 1_000_000)
      );
      log.info("funded bettor USDC", { wallet: b.publicKey.toBase58().slice(0, 8) });
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.stack ?? e));
    process.exit(1);
  });
