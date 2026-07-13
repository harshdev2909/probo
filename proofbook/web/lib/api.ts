/**
 * The ProofBook API client.
 *
 * Every list on this site comes from here — never from Solana RPC. The browser
 * touches the chain for exactly one thing: asking the wallet to sign, then
 * broadcasting the result through our own proxy. Reads are Postgres, served by a
 * stateless API; a judge loading the board does not fire 104 chain calls.
 *
 * Types come from the API's own contract file, so a field the server stops
 * sending breaks the build here rather than the page.
 */
import type { ReceiptSummary,
  MarketView,
  ReceiptView,
  PositionView,
  GroupView,
  BracketRound,
  BracketTie,
  KeeperStatus,
  HealthView,
  FaucetResult,
  TeamRef,
  Paginated,
} from "./contracts";

export type {
  ReceiptSummary,
  MarketView,
  ReceiptView,
  PositionView,
  GroupView,
  BracketRound,
  BracketTie,
  KeeperStatus,
  HealthView,
  FaucetResult,
  TeamRef,
  Paginated,
};

/** Public API base URL. Not a secret — it is a URL anyone can curl. */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_KEEPER_API ||
  "http://localhost:8787";

/** Kept for older imports; the API base is the same thing. */
export const KEEPER_API = API_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  } catch {
    // fetch() only rejects on a network-level failure, so this genuinely means
    // "the API is unreachable" — worth saying plainly.
    throw new ApiError("Can't reach ProofBook's API.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface MarketFilter {
  stage?: string;
  status?: MarketView["status"];
  proofStatus?: MarketView["proofStatus"];
  /** One type or comma-separated types, e.g. "36,37,38,39" = the parlays. */
  marketType?: string;
  fixtureId?: number;
  limit?: number;
  offset?: number;
  sort?: "kickoff" | "-kickoff" | "pool" | "-settled";
}

export const api = {
  health: () => get<HealthView>("/health"),

  markets: (f: MarketFilter = {}) =>
    get<Paginated<MarketView>>(`/markets${qs({ ...f, limit: f.limit ?? 200 })}`),
  /**
   * The whole board, PAGED.
   *
   * This used to take the first page and stop, on the assumption that ~104
   * fixtures meant ~104 markets. A fixture now carries a dozen markets, so the
   * board is well over a thousand rows and the API caps a page at 200 — one
   * request silently returned a sixth of the tournament.
   */
  allMarkets: async (f: MarketFilter = {}): Promise<MarketView[]> => {
    const items: MarketView[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await api.markets({ ...f, limit: 200, offset });
      items.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      if (items.length > 5000) break; // a runaway guard, not a real limit
    }
    return items;
  },
  market: (pda: string) => get<MarketView>(`/markets/${pda}`),

  receipts: (
    f: {
      stage?: string;
      marketType?: string;
      fixtureId?: number;
      limit?: number;
      offset?: number;
    } = {}
  ) =>
    get<Paginated<ReceiptView>>(`/receipts${qs({ ...f, limit: f.limit ?? 200 })}`),
  /** The headline stat: receipts by market type. */
  receiptSummary: () => get<ReceiptSummary>("/receipts/summary"),
  receipt: (pda: string) => get<ReceiptView>(`/receipts/${pda}`),

  positions: (wallet: string) => get<PositionView[]>(`/positions/${wallet}`),
  standings: () => get<GroupView[]>("/standings"),
  bracket: () => get<BracketRound[]>("/bracket"),

  keeperStatus: () =>
    get<
      KeeperStatus & {
        faucet: {
          enabled: boolean;
          address: string | null;
          reserves: { sol: number; usdc: number } | null;
        };
      }
    >("/keeper/status"),

  /**
   * Devnet demo faucet. Hands out the demo token AND a little SOL — placing a bet
   * opens a Position account and the BETTOR pays its rent, so a wallet with no SOL
   * cannot bet however much of the token it holds.
   */
  faucet: async (wallet: string): Promise<FaucetResult> => {
    const res = await fetch(`${API_URL}/faucet/${wallet}`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || body?.ok === false) {
      throw new ApiError(body?.error ?? `Faucet failed (${res.status})`, res.status);
    }
    return body as unknown as FaucetResult;
  },
};
