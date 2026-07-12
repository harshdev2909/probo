/** Canonical World Cup fixture loader: pulls the tournament from TxLINE once. */
import * as fs from "fs";
import * as path from "path";
import { ROOT } from "../config";
import { Logger } from "../logger";
import type { TxLineSession } from "./session";

export interface WcFixture {
  fixtureId: number;
  kickoffMs: number;
  p1Id?: number;
  p2Id?: number;
  p1Name?: string;
  p2Name?: string;
  competitionId?: number;
  raw: any;
}

const CACHE = path.join(ROOT, "keeper", "data", "fixtures-raw.json");

/** Fetch (and cache) the full World Cup fixture list. */
export async function loadWorldCupFixtures(
  session: TxLineSession,
  competitionId: number,
  log: Logger,
  { refresh = false }: { refresh?: boolean } = {}
): Promise<WcFixture[]> {
  let raw: any[] | null = null;

  if (!refresh && fs.existsSync(CACHE)) {
    raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    log.info("fixtures from cache", { count: raw!.length });
  }

  if (!raw || !raw.length) {
    // startEpochDay is required to get the FULL tournament (without it the API
    // only returns fixtures in the immediate window).
    const url = `/fixtures/snapshot?competitionId=${competitionId}&startEpochDay=20600`;
    const { data } = await session.api.get(url);
    raw = Array.isArray(data) ? data : data?.fixtures ?? [];
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(raw, null, 2));
    log.info("fixtures fetched", { count: raw!.length, url });
  }

  return raw!
    .map((f) => {
      const start = f.StartTime ?? f.startTime ?? f.Ts;
      const kickoffMs =
        typeof start === "number" ? start : Date.parse(String(start));
      return {
        fixtureId: Number(f.FixtureId ?? f.fixtureId),
        kickoffMs,
        p1Id: f.Participant1Id,
        p2Id: f.Participant2Id,
        p1Name: f.Participant1,
        p2Name: f.Participant2,
        competitionId: f.CompetitionId,
        raw: f,
      } as WcFixture;
    })
    .filter((f) => !isNaN(f.fixtureId) && !isNaN(f.kickoffMs))
    .sort((a, b) => a.kickoffMs - b.kickoffMs);
}
