import * as http from "http";
import { PublicKey } from "@solana/web3.js";

import { KeeperConfig } from "../config";
import { Logger, logBus, LogRecord } from "../logger";
import { Store, type StoreLike } from "../state";
import { Chain, statusName, OUTCOME_LABELS } from "../chain/proofbook";
import { resolveTeam, stageOf } from "../../../data/tournament";

/**
 * The indexer read API the frontend consumes.
 *   GET /health
 *   GET /markets                — indexed markets + pools + crowd-implied odds
 *   GET /markets/:pda
 *   GET /fixtures/:id/live      — live score/phase state from the feed
 *   GET /receipts/:marketPda    — the Proof Receipt payload
 *   GET /positions/:wallet      — on-chain positions for a wallet
 *   POST /faucet/:wallet        — devnet demo faucet (demo token + a little SOL)
 *   GET /stream                 — SSE: score/market/receipt/log events
 */
export class ApiServer {
  private log = new Logger("api");
  private server?: http.Server;
  private clients = new Set<http.ServerResponse>();
  private marketCache: Record<string, any> = {};
  private logForward = (rec: LogRecord) => this.broadcast("log", rec);

  constructor(
    private cfg: KeeperConfig,
    private store: StoreLike,
    private chain: Chain
  ) {}

  start() {
    this.server = http.createServer((req, res) => this.route(req, res));
    this.server.listen(this.cfg.apiPort, () =>
      this.log.info("read API listening", { port: this.cfg.apiPort })
    );
    logBus.on("log", this.logForward);
  }

  stop() {
    logBus.removeListener("log", this.logForward);
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.server?.close();
  }

  /** Push an event to all connected SSE clients. */
  broadcast(type: string, data: unknown) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(payload);
  }

  /** Refresh the on-chain market cache (indexer loop calls this). */
  async refreshMarkets() {
    const all = await this.chain.allMarkets();
    const allow = new Set(this.cfg.marketTypes);

    // One market per fixture. Devnet keeps every generation ever created, so a
    // fixture can have both a dead market and a live one; a settled market (the
    // one carrying a real proof) always wins over an unsettled duplicate.
    const rank = (m: any) => {
      const st = statusName(m.status);
      return (
        (st === "settled"
          ? 300
          : st === "locked"
          ? 200
          : st === "open"
          ? 100
          : 0) + m.marketType
      );
    };
    const best = new Map<number, { pda: string; account: any }>();
    for (const { publicKey, account } of all) {
      if (!allow.has(account.marketType)) continue;
      const fid = Number(account.fixtureId);
      const cur = best.get(fid);
      if (!cur || rank(account) > rank(cur.account)) {
        best.set(fid, { pda: publicKey.toBase58(), account });
      }
    }

    this.marketCache = {};
    for (const { pda, account } of best.values()) {
      this.marketCache[pda] = this.marketView(pda, account);
    }
  }

  private marketView(pda: string, m: any) {
    const pools = m.outcomes.map((o: any) => o.pool.toString());
    const total = Number(m.totalPool);
    const impliedOdds = m.outcomes.map((o: any) =>
      total > 0 ? Number(o.pool) / total : null
    );
    const rec = this.store.data.markets[pda];
    const fx = this.store.data.fixtures[String(m.fixtureId)];
    // Prefer the stored participant names. Fixtures indexed before those were
    // persisted only carry a display name ("England vs Argentina"), so split it
    // rather than serving a market with no teams.
    const [n1, n2] = splitFixtureName(fx?.name);
    const home = resolveTeam(fx?.homeName ?? n1);
    const away = resolveTeam(fx?.awayName ?? n2);
    return {
      marketPda: pda,
      fixtureId: Number(m.fixtureId),
      fixtureName: fx?.name,
      home: {
        code: home.code,
        name: home.name,
        iso: home.iso,
        chip: home.chip,
        unknown: !!home.unknown,
      },
      away: {
        code: away.code,
        name: away.name,
        iso: away.iso,
        chip: away.chip,
        unknown: !!away.unknown,
      },
      stage:
        fx?.stage ?? (fx?.kickoffTs ? stageOf(fx.kickoffTs * 1000) : undefined),
      kickoffTs: fx?.kickoffTs,
      proofStatus: fx?.proofStatus ?? "upcoming",
      gapReason: fx?.gapReason,
      marketType: m.marketType,
      status: statusName(m.status),
      outcomes: m.outcomes.map(
        (_: any, i: number) => OUTCOME_LABELS[i] ?? `#${i}`
      ),
      pools,
      totalPool: m.totalPool.toString(),
      crowdImplied: impliedOdds,
      feeBps: m.feeBps,
      lockTime: Number(m.lockTime),
      resolutionTimeout: Number(m.resolutionTimeout),
      winningOutcome: m.winningOutcome === 255 ? null : m.winningOutcome,
      oracleProgram: m.oracleProgram.toBase58(),
      usdcMint: m.usdcMint.toBase58(),
      vault: m.vault.toBase58(),
      authority: m.authority.toBase58(),
      txs: {
        created: rec?.createdTx,
        locked: rec?.lockTx,
        settled: rec?.settleTx,
        cancelled: rec?.cancelTx,
      },
      live: fx
        ? { score: fx.score, statusId: fx.statusId, lastSeq: fx.lastSeq }
        : null,
    };
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    try {
      if (url.pathname === "/health")
        return json(res, { ok: true, mode: this.cfg.mode });

      if (url.pathname === "/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        this.clients.add(res);
        req.on("close", () => this.clients.delete(res));
        return;
      }

      if (parts[0] === "markets" && !parts[1]) {
        return json(res, Object.values(this.marketCache));
      }
      if (parts[0] === "markets" && parts[1]) {
        const m = await this.chain.fetchMarket(new PublicKey(parts[1]));
        if (!m) return json(res, { error: "not found" }, 404);
        const view = this.marketView(parts[1], m);
        this.marketCache[parts[1]] = view;
        return json(res, view);
      }
      if (parts[0] === "fixtures" && parts[1] && parts[2] === "live") {
        const fx = this.store.data.fixtures[parts[1]];
        if (!fx) return json(res, { error: "not found" }, 404);
        return json(res, fx);
      }
      if (parts[0] === "receipts" && parts[1]) {
        const r = this.store.data.receipts[parts[1]];
        if (!r)
          return json(res, { error: "not settled or unknown market" }, 404);
        return json(res, r);
      }
      // POST /faucet/:wallet — devnet only. Tops a connected wallet up with the
      // demo token AND a little SOL, because place_bet makes the bettor pay rent
      // for its own Position account. Without both, a bet cannot land.
      if (parts[0] === "faucet" && parts[1] && req.method === "POST") {
        const owner = new PublicKey(parts[1]);
        const out = await this.chain.faucet(owner);
        return json(res, { ok: true, ...out });
      }

      if (parts[0] === "positions" && parts[1]) {
        const owner = new PublicKey(parts[1]);
        const positions = await this.chain.positionsByOwner(owner);
        return json(
          res,
          positions.map((p: any) => ({
            position: p.publicKey.toBase58(),
            market: p.account.market.toBase58(),
            outcomeIndex: p.account.outcomeIndex,
            amount: p.account.amount.toString(),
            claimed: p.account.claimed,
          }))
        );
      }
      json(res, { error: "unknown route" }, 404);
    } catch (e: any) {
      json(res, { error: e?.message || String(e) }, 500);
    }
  }
}

/** "England vs Argentina" / "England v Argentina" -> ["England", "Argentina"]. */
function splitFixtureName(name?: string): [string?, string?] {
  const parts = name?.split(/\s+vs?\s+/i);
  return parts?.length === 2
    ? [parts[0].trim(), parts[1].trim()]
    : [undefined, undefined];
}

function json(res: http.ServerResponse, body: unknown, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
