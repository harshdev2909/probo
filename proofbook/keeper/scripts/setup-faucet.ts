/**
 * Provision the faucet wallet. Run ONCE by an operator holding the keeper's key.
 *
 * PRIVILEGE SEPARATION — the whole point.
 * The keeper's keypair is the market authority AND the escrow mint's authority: it
 * can create markets and settle them. The API must never hold it. So the keeper
 * mints a float into a plain, separate wallet, and the API only ever gets THAT
 * wallet's key. If the API is compromised, an attacker drains a faucet of
 * valueless devnet tokens — not the tournament.
 *
 *   npm run faucet:setup            # create + fund, print the API env var
 *   FAUCET_TOPUP=1 npm run faucet:setup   # top an existing faucet back up
 */
import * as fs from "fs";
import * as path from "path";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

import { loadConfig, ROOT } from "../src/config";
import { Logger } from "../src/logger";
import { Store } from "../src/state";
import { PgStore } from "../src/pgstore";
import { Chain } from "../src/chain/proofbook";
import { withRetry } from "../src/backfill/retry";

const log = new Logger("faucet-setup");

const SOL_FLOAT = Number(process.env.FAUCET_SOL_FLOAT ?? 2);
const USDC_FLOAT = Number(process.env.FAUCET_USDC_FLOAT ?? 5_000_000);

async function main() {
  const cfg = loadConfig("live");
  const store = cfg.databaseUrl ? await PgStore.open() : new Store(cfg.dataDir);
  const chain = new Chain({ ...cfg, oracleMode: "txline" }, store);

  const keyFile = path.join(ROOT, "keeper", "data", "faucet.json");
  let faucet: Keypair;
  if (fs.existsSync(keyFile)) {
    faucet = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8")))
    );
    log.info("reusing existing faucet wallet", {
      address: faucet.publicKey.toBase58(),
    });
  } else {
    faucet = Keypair.generate();
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify(Array.from(faucet.secretKey)));
    log.info("created faucet wallet", { address: faucet.publicKey.toBase58() });
  }

  const mint = await withRetry("mint", () => chain.ensureUsdcMint(), log);

  // ── SOL float: the faucet pays rent for each judge's token account, and hands
  //    out the SOL their bet needs to pay for its own Position account. ──
  const bal = await chain.connection.getBalance(faucet.publicKey);
  if (bal < SOL_FLOAT * LAMPORTS_PER_SOL * 0.5) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: chain.payer.publicKey,
        toPubkey: faucet.publicKey,
        lamports: Math.floor(SOL_FLOAT * LAMPORTS_PER_SOL),
      })
    );
    await withRetry(
      "fund SOL",
      () => chain.provider.sendAndConfirm!(tx, []),
      log
    );
    log.info(`sent ${SOL_FLOAT} SOL to the faucet`);
  }

  // ── token float: minted ONCE, here, by the authority. The API can only transfer. ──
  const ata = await withRetry(
    "faucet ata",
    () =>
      getOrCreateAssociatedTokenAccount(
        chain.connection,
        chain.payer,
        mint,
        faucet.publicKey
      ),
    log
  );
  const held = Number(ata.amount) / 1e6;
  if (held < USDC_FLOAT / 2) {
    await withRetry(
      "mint float",
      () =>
        mintTo(
          chain.connection,
          chain.payer,
          mint,
          ata.address,
          chain.payer,
          BigInt(Math.round(USDC_FLOAT * 1e6))
        ),
      log
    );
    log.info(`minted ${USDC_FLOAT.toLocaleString()} demo USDC to the faucet`);
  }

  const sol =
    (await chain.connection.getBalance(faucet.publicKey)) / LAMPORTS_PER_SOL;
  const usdc =
    Number(
      (
        await getOrCreateAssociatedTokenAccount(
          chain.connection,
          chain.payer,
          mint,
          faucet.publicKey
        )
      ).amount
    ) / 1e6;

  console.log("\n" + "═".repeat(72));
  console.log(
    "FAUCET READY — put these in the API's environment (NOT the web app's):\n"
  );
  console.log(`USDC_MINT=${mint.toBase58()}`);
  console.log(
    `FAUCET_SECRET_KEY=${JSON.stringify(Array.from(faucet.secretKey))}`
  );
  console.log(`\naddress : ${faucet.publicKey.toBase58()}`);
  console.log(
    `reserves: ${sol.toFixed(3)} SOL · ${usdc.toLocaleString()} demo USDC`
  );
  console.log(
    `\nThat key can ONLY move a valueless devnet token and a little SOL.\n` +
      `The keeper's key — which settles markets — stays in the keeper.`
  );
  console.log("═".repeat(72) + "\n");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
