/**
 * The settlement plan: for every World Cup fixture, decide honestly whether we
 * can obtain a REAL TxLINE proof of its result.
 *
 * Terminal-record preference (most authoritative first):
 *   100 = game_finalised (method-agnostic; retained ~10 days)
 *    13 = FPE  ended after penalties
 *    10 = FET  ended after extra time
 *     5 = F    ended in regulation
 * The PROVEN stat values are the only source of truth for the result. The
 * feed's Score object is sampled and unreliable, so we never settle from it.
 *
 * HARD RULE: if no real proof is obtainable, the fixture is marked
 * `no_proof` and is NEVER faked, mocked, or admin-settled.
 */
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";

import { TXLINE_DEVNET } from "../chain/proofbook";
import { TxLineClient } from "../txline/client";
import type { TxLineSession } from "../txline/session";
import { Logger } from "../logger";

export const TERMINAL_PREFERENCE = [100, 13, 10, 5] as const;
export const TERMINAL_LABEL: Record<number, string> = {
  100: "game_finalised",
  13: "after penalties",
  10: "after extra time",
  5: "full time",
};

export type PlanStatus =
  | "settleable" // real proof + on-chain root: we can settle for real
  | "no_proof" // outside TxLINE retention: result NOT provable (never fake it)
  | "not_finished" // still to be played / in play
  | "no_root"; // proof exists but the oracle root is missing on devnet

export interface FixturePlan {
  fixtureId: number;
  kickoffMs: number;
  epochDay: number;
  p1Id?: number;
  p2Id?: number;
  p1Name?: string;
  p2Name?: string;
  status: PlanStatus;
  terminalStatusId?: number;
  terminalLabel?: string;
  seq?: number;
  /** PROVEN goals (authoritative). */
  goals?: { p1: number; p2: number };
  /** The ScoreStat period the proof carries (5/10/13/100). */
  period?: number;
  epochDayOfProof?: number;
  reason?: string;
}

export function dailyRootPda(epochDay: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("daily_scores_roots"),
      new BN(epochDay).toArrayLike(Buffer, "le", 2),
    ],
    TXLINE_DEVNET
  )[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build the plan for one fixture by probing the live API. */
export async function planFixture(
  fixture: {
    fixtureId: number;
    kickoffMs: number;
    p1Id?: number;
    p2Id?: number;
    p1Name?: string;
    p2Name?: string;
  },
  session: TxLineSession,
  client: TxLineClient,
  connection: Connection,
  log: Logger
): Promise<FixturePlan> {
  const base: FixturePlan = {
    ...fixture,
    epochDay: Math.floor(fixture.kickoffMs / 86_400_000),
    status: "not_finished",
  };

  // A match needs ~2h before a terminal record can exist.
  if (Date.now() < fixture.kickoffMs + 105 * 60_000) {
    base.reason = "not played yet";
    return base;
  }

  let recs: any[] = [];
  try {
    const { data } = await session.api.get(
      `/scores/snapshot/${fixture.fixtureId}`
    );
    recs = Array.isArray(data) ? data : data ? [data] : [];
  } catch (e: any) {
    base.status = "no_proof";
    base.reason = `snapshot unavailable (${e?.response?.status ?? "error"})`;
    return base;
  }

  if (!recs.length) {
    base.status = "no_proof";
    base.reason = "outside TxLINE score retention (no records)";
    return base;
  }

  let chosen: any = null;
  for (const want of TERMINAL_PREFERENCE) {
    const hits = recs.filter((r) => (r.StatusId ?? r.statusId) === want);
    if (hits.length) {
      chosen = {
        rec: hits.sort((a, b) => (b.Seq ?? 0) - (a.Seq ?? 0))[0],
        statusId: want,
      };
      break;
    }
  }
  if (!chosen) {
    const seen = [...new Set(recs.map((r) => r.StatusId ?? r.statusId))].join(
      ","
    );
    // Match may still be in play, or its terminal record was trimmed.
    base.status =
      Date.now() < fixture.kickoffMs + 4 * 3600_000
        ? "not_finished"
        : "no_proof";
    base.reason = `no terminal record retained (phases seen: ${seen})`;
    return base;
  }

  const seq = chosen.rec.Seq ?? chosen.rec.seq;
  base.terminalStatusId = chosen.statusId;
  base.terminalLabel = TERMINAL_LABEL[chosen.statusId];
  base.seq = seq;

  try {
    const val = await client.statValidation(fixture.fixtureId, seq, [1, 2]);
    const stats = val?.statsToProve;
    if (!stats || stats.length < 2) throw new Error("proof missing stats");
    base.goals = { p1: stats[0].value, p2: stats[1].value };
    base.period = stats[0].period;

    const tsMs = val.summary.updateStats.minTimestamp;
    const ed = Math.floor(tsMs / 86_400_000);
    base.epochDayOfProof = ed;
    const rootExists = !!(await connection.getAccountInfo(dailyRootPda(ed)));
    if (!rootExists) {
      base.status = "no_root";
      base.reason = `oracle root for epoch day ${ed} not on devnet`;
      return base;
    }
    base.status = "settleable";
    return base;
  } catch (e: any) {
    base.status = "no_proof";
    base.reason = `proof unavailable (${e?.response?.status ?? ""} ${
      e?.message ?? ""
    })`.trim();
    return base;
  }
}

/** Plan every fixture, throttled. */
export async function planAll(
  fixtures: Array<{
    fixtureId: number;
    kickoffMs: number;
    p1Id?: number;
    p2Id?: number;
    p1Name?: string;
    p2Name?: string;
  }>,
  session: TxLineSession,
  client: TxLineClient,
  connection: Connection,
  log: Logger,
  throttleMs = 140
): Promise<FixturePlan[]> {
  const out: FixturePlan[] = [];
  for (const f of fixtures) {
    const p = await planFixture(f, session, client, connection, log);
    const score = p.goals ? `${p.goals.p1}-${p.goals.p2}` : "—";
    log.info(
      `${p.fixtureId} ${new Date(p.kickoffMs).toISOString().slice(0, 10)} ` +
        `${(p.p1Name ?? "?").slice(0, 12)} v ${(p.p2Name ?? "?").slice(
          0,
          12
        )} :: ` +
        `${p.status.toUpperCase()} ${score} ${p.terminalLabel ?? ""} ${
          p.reason ?? ""
        }`
    );
    out.push(p);
    await sleep(throttleMs);
  }
  return out;
}
