import * as http from "http";
import { PublicKey } from "@solana/web3.js";

import { KeeperConfig } from "../config";
import { Logger, logBus, LogRecord } from "../logger";
import { Store } from "../state";
import { Chain, statusName, OUTCOME_LABELS } from "../chain/proofbook";

/**
 * The indexer read API the frontend consumes.
 *   GET /health
 *   GET /markets                — indexed markets + pools + crowd-implied odds
 *   GET /markets/:pda
 *   GET /fixtures/:id/live      — live score/phase state from the feed
 *   GET /receipts/:marketPda    — the Proof Receipt payload
 *   GET /positions/:wallet      — on-chain positions for a wallet
 *   GET /stream                 — SSE: score/market/receipt/log events
 */
export class ApiServer {
  private log = new Logger("api");
  private server?: http.Server;
  private clients = new Set<http.ServerResponse>();
  private marketCache: Record<string, any> = {};
  private logForward = (rec: LogRecord) => this.broadcast("log", rec);

  constructor(private cfg: KeeperConfig, private store: Store, private chain: Chain) {}

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
    for (const { publicKey, account } of all) {
      this.marketCache[publicKey.toBase58()] = this.marketView(publicKey.toBase58(), account);
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
    return {
      marketPda: pda,
      fixtureId: Number(m.fixtureId),
      fixtureName: fx?.name,
      marketType: m.marketType,
      status: statusName(m.status),
      outcomes: m.outcomes.map((_: any, i: number) => OUTCOME_LABELS[i] ?? `#${i}`),
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
        created: rec?.createdTx, locked: rec?.lockTx,
        settled: rec?.settleTx, cancelled: rec?.cancelTx,
      },
      live: fx ? { score: fx.score, statusId: fx.statusId, lastSeq: fx.lastSeq } : null,
    };
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    res.setHeader("Access-Control-Allow-Origin", "*");

    try {
      if (url.pathname === "/health") return json(res, { ok: true, mode: this.cfg.mode });

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
        if (!r) return json(res, { error: "not settled or unknown market" }, 404);
        return json(res, r);
      }
      if (parts[0] === "positions" && parts[1]) {
        const owner = new PublicKey(parts[1]);
        const positions = await this.chain.positionsByOwner(owner);
        return json(res, positions.map((p: any) => ({
          position: p.publicKey.toBase58(),
          market: p.account.market.toBase58(),
          outcomeIndex: p.account.outcomeIndex,
          amount: p.account.amount.toString(),
          claimed: p.account.claimed,
        })));
      }
      json(res, { error: "unknown route" }, 404);
    } catch (e: any) {
      json(res, { error: e?.message || String(e) }, 500);
    }
  }
}

function json(res: http.ServerResponse, body: unknown, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
