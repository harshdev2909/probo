/** Keeper indexer API client. Lists come from here — never from Solana RPC. */
export const KEEPER_API =
  process.env.NEXT_PUBLIC_KEEPER_API || "http://localhost:8787";

export interface MarketView {
  marketPda: string;
  fixtureId: number;
  fixtureName?: string;
  marketType: number;
  status: "open" | "locked" | "settled" | "cancelled";
  outcomes: string[];
  pools: string[];
  totalPool: string;
  crowdImplied: (number | null)[];
  feeBps: number;
  lockTime: number;
  resolutionTimeout: number;
  winningOutcome: number | null;
  oracleProgram: string;
  usdcMint: string;
  vault: string;
  authority: string;
  txs: { created?: string; locked?: string; settled?: string; cancelled?: string };
  live: { score?: { p1: number; p2: number }; statusId?: number; lastSeq?: number } | null;
}

export interface FixtureLive {
  fixtureId: number;
  name?: string;
  kickoffTs?: number;
  statusId?: number;
  score?: { p1: number; p2: number };
  lastSeq?: number;
  lastUpdateAt?: string;
}

export interface ProofReceipt {
  marketPda: string;
  matchId: number;
  winningOutcome: number;
  outcomeLabel: string;
  oracleProgram: string;
  epochDay: number;
  dailyRootsPda: string;
  proofRef: string;
  resolver: string;
  settleTx: string;
  settledAt: number;
  totalPool: string;
  totalWinningPool: string;
  feeAmount: string;
}

export interface PositionView {
  position: string;
  market: string;
  outcomeIndex: number;
  amount: string;
  claimed: boolean;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${KEEPER_API}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

export const api = {
  markets: () => get<MarketView[]>("/markets"),
  market: (pda: string) => get<MarketView>(`/markets/${pda}`),
  fixtureLive: (id: number) => get<FixtureLive>(`/fixtures/${id}/live`),
  receipt: (pda: string) => get<ProofReceipt>(`/receipts/${pda}`),
  positions: (wallet: string) => get<PositionView[]>(`/positions/${wallet}`),
  health: () => get<{ ok: boolean; mode: string }>("/health"),
};
