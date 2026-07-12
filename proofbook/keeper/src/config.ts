import * as fs from "fs";
import * as path from "path";

/** Repo root (keeper/src -> repo). */
export const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Load `keeper/.env` into the environment WITHOUT overriding anything already
 * set. This is what points a plain `npm run keeper:live` at the seeded devnet
 * tournament (data dir + market generation) instead of an empty default store —
 * running the keeper against the wrong generation silently serves markets with
 * no teams and no pools, which looks like a frontend bug but isn't.
 *
 * Explicit env always wins, so the local-validator demo (which pins its own
 * values) is unaffected.
 */
function loadDotEnv() {
  const file = path.join(ROOT, "keeper", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

export type OracleMode = "mock" | "txline";

export interface KeeperConfig {
  mode: "live" | "replay";
  rpcUrl: string;
  walletPath: string;
  /**
   * The keeper's signing key as an inline secret (JSON byte array or base58).
   * Most platforms hand you ENV VARS, not secret files — Railway and Fly have no
   * secret-file mount at all — so requiring a path made the keeper undeployable
   * there. This takes precedence over `walletPath` when set.
   */
  walletSecret?: string;
  dataDir: string;
  apiPort: number;

  /** TxLINE API origin (devnet). */
  txlineApi: string;
  /** World Cup competition id (72 per the free-tier examples). */
  competitionId: number;
  /** Free-tier on-chain subscription params. */
  serviceLevelId: number;
  subscribeWeeks: number;

  /** Market escrow mint; auto-created & persisted on first run if unset. */
  usdcMint?: string;
  /** Fee treasury wallet; defaults to the keeper wallet. */
  feeTreasury?: string;
  feeBps: number;
  /** Seconds after lock before the permissionless cancel backstop fires. */
  resolutionTimeoutSec: number;
  /** Match-winner stat keys (P1/P2 goals) and the finalised period (100). */
  statKeys: [number, number];
  statPeriod: number;
  marketType: number;
  /**
   * Market generations the API surfaces. Devnet accumulates generations (a
   * botched seed can't be deleted), so the reader takes an allowlist and the
   * writer always uses `marketType`.
   */
  marketTypes: number[];
  /** When set, Postgres is the store and the keeper runs as a leader-elected worker. */
  databaseUrl?: string;
  /** Identifies this keeper process in keeper_runs (the status page shows it). */
  instanceId: string;

  /** Which oracle the settle CPI targets. live => txline, replay => mock. */
  oracleMode: OracleMode;

  /** Replay-only. */
  replayFile?: string;
  replaySpeed: number;
  replayMaxGapMs: number;
  replayLockDelaySec: number;

  /** Settlement retry policy. */
  settleMaxAttempts: number;
  settleBaseDelayMs: number;
  settleMaxDelayMs: number;
}

const num = (v: string | undefined, d: number) =>
  v !== undefined ? Number(v) : d;

export function loadConfig(
  mode: "live" | "replay",
  overrides: Partial<KeeperConfig> = {}
): KeeperConfig {
  const e = process.env;
  const cfg: KeeperConfig = {
    mode,
    rpcUrl:
      e.RPC_URL || e.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com",
    walletSecret: e.KEEPER_SECRET_KEY || e.ANCHOR_WALLET_SECRET,
    walletPath:
      e.KEEPER_WALLET ||
      e.ANCHOR_WALLET ||
      path.join(process.env.HOME || "~", ".config/solana/id.json"),
    // Resolved against the repo root, not the cwd: the keeper is launched from
    // both the repo root and keeper/, and a relative path would otherwise point
    // at two different stores.
    dataDir: e.KEEPER_DATA_DIR
      ? path.isAbsolute(e.KEEPER_DATA_DIR)
        ? e.KEEPER_DATA_DIR
        : path.join(ROOT, e.KEEPER_DATA_DIR)
      : path.join(ROOT, "keeper", "data"),
    apiPort: num(e.KEEPER_API_PORT, 8787),

    txlineApi: e.TXLINE_API || "https://txline-dev.txodds.com",
    competitionId: num(e.COMPETITION_ID, 72),
    serviceLevelId: num(e.SERVICE_LEVEL_ID, 1),
    subscribeWeeks: num(e.SUBSCRIBE_WEEKS, 4),

    usdcMint: e.USDC_MINT,
    feeTreasury: e.FEE_TREASURY,
    feeBps: num(e.FEE_BPS, 500),
    resolutionTimeoutSec: num(
      e.RESOLUTION_TIMEOUT_SEC,
      mode === "replay" ? 600 : 6 * 3600
    ),
    statKeys: [1, 2],
    statPeriod: num(e.STAT_PERIOD, 100), // game_finalised (proven live)
    marketType: num(e.MARKET_TYPE, 0),
    databaseUrl: e.DATABASE_URL,
    instanceId:
      e.KEEPER_INSTANCE ??
      e.RAILWAY_REPLICA_ID ??
      e.FLY_ALLOC_ID ??
      `${require("os").hostname()}-${process.pid}`,
    marketTypes: (e.MARKET_TYPES ?? String(num(e.MARKET_TYPE, 0)))
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((x) => !Number.isNaN(x)),

    oracleMode:
      (e.ORACLE_MODE as OracleMode) || (mode === "replay" ? "mock" : "txline"),

    replayFile: e.REPLAY_FILE,
    replaySpeed: num(e.REPLAY_SPEED, 60),
    replayMaxGapMs: num(e.REPLAY_MAX_GAP_MS, 2500),
    replayLockDelaySec: num(e.REPLAY_LOCK_DELAY_SEC, 20),

    settleMaxAttempts: num(e.SETTLE_MAX_ATTEMPTS, 12),
    settleBaseDelayMs: num(
      e.SETTLE_BASE_DELAY_MS,
      mode === "replay" ? 2_000 : 30_000
    ),
    settleMaxDelayMs: num(
      e.SETTLE_MAX_DELAY_MS,
      mode === "replay" ? 10_000 : 600_000
    ),
  };
  return { ...cfg, ...overrides };
}
