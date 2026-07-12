import * as path from "path";

/** Repo root (keeper/src -> repo). */
export const ROOT = path.resolve(__dirname, "..", "..");

export type OracleMode = "mock" | "txline";

export interface KeeperConfig {
  mode: "live" | "replay";
  rpcUrl: string;
  walletPath: string;
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

const num = (v: string | undefined, d: number) => (v !== undefined ? Number(v) : d);

export function loadConfig(
  mode: "live" | "replay",
  overrides: Partial<KeeperConfig> = {}
): KeeperConfig {
  const e = process.env;
  const cfg: KeeperConfig = {
    mode,
    rpcUrl: e.RPC_URL || e.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com",
    walletPath:
      e.KEEPER_WALLET || e.ANCHOR_WALLET || path.join(process.env.HOME || "~", ".config/solana/id.json"),
    dataDir: e.KEEPER_DATA_DIR || path.join(ROOT, "keeper", "data"),
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

    oracleMode: (e.ORACLE_MODE as OracleMode) || (mode === "replay" ? "mock" : "txline"),

    replayFile: e.REPLAY_FILE,
    replaySpeed: num(e.REPLAY_SPEED, 60),
    replayMaxGapMs: num(e.REPLAY_MAX_GAP_MS, 2500),
    replayLockDelaySec: num(e.REPLAY_LOCK_DELAY_SEC, 20),

    settleMaxAttempts: num(e.SETTLE_MAX_ATTEMPTS, 12),
    settleBaseDelayMs: num(e.SETTLE_BASE_DELAY_MS, mode === "replay" ? 2_000 : 30_000),
    settleMaxDelayMs: num(e.SETTLE_MAX_DELAY_MS, mode === "replay" ? 10_000 : 600_000),
  };
  return { ...cfg, ...overrides };
}
