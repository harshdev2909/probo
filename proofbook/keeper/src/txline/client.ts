import { Logger } from "../logger";
import { TxLineSession } from "./session";

/** Normalized score-feed event (tolerant of field-name casing in the raw feed). */
export interface ScoreUpdate {
  fixtureId: number;
  seq: number;
  ts: number; // unix ms
  statusId?: number; // in-play phase; 100 = game_finalised
  score?: { p1?: number; p2?: number }; // partial — merged by the keeper
  raw: any;
}

export function normalizeUpdate(raw: any): ScoreUpdate | null {
  const fixtureId = raw.FixtureId ?? raw.fixtureId;
  const seq = raw.Seq ?? raw.seq;
  if (fixtureId === undefined || seq === undefined) return null;
  const ts = raw.Ts ?? raw.ts ?? Date.now();
  const statusId = raw.StatusId ?? raw.statusId;
  // Score extraction (real TxLINE soccer feed shape). Events carry partial
  // score objects (often only the side that just scored), so p1/p2 are
  // optional here and merged with prior state by the keeper.
  let score: { p1?: number; p2?: number } | undefined;
  const s = raw.Score ?? raw.score;
  const g1 = s?.Participant1?.Total?.Goals;
  const g2 = s?.Participant2?.Total?.Goals;
  if (g1 !== undefined || g2 !== undefined) {
    score = {};
    if (g1 !== undefined) score.p1 = Number(g1);
    if (g2 !== undefined) score.p2 = Number(g2);
  }
  return { fixtureId: Number(fixtureId), seq: Number(seq), ts: Number(ts), statusId, score, raw };
}

export interface FixtureInfo {
  fixtureId: number;
  name?: string;
  kickoffTs?: number; // unix seconds
  competitionId?: number;
  raw: any;
}

export function normalizeFixture(raw: any): FixtureInfo | null {
  const fixtureId = raw.FixtureId ?? raw.fixtureId ?? raw.Id ?? raw.id;
  if (fixtureId === undefined) return null;
  const start =
    raw.StartTime ?? raw.startTime ?? raw.Kickoff ?? raw.kickoff ?? raw.StartTs ?? raw.startTs;
  let kickoffTs: number | undefined;
  if (typeof start === "number") kickoffTs = start > 1e12 ? Math.floor(start / 1000) : start;
  else if (typeof start === "string") {
    const t = Date.parse(start);
    if (!isNaN(t)) kickoffTs = Math.floor(t / 1000);
  }
  const p1 = raw.Participant1 ?? raw.participant1 ?? raw.HomeTeam ?? raw.Home;
  const p2 = raw.Participant2 ?? raw.participant2 ?? raw.AwayTeam ?? raw.Away;
  const name =
    raw.Name ?? raw.name ?? (p1 && p2 ? `${p1} vs ${p2}` : undefined);
  return {
    fixtureId: Number(fixtureId),
    name,
    kickoffTs,
    competitionId: raw.CompetitionId ?? raw.competitionId,
    raw,
  };
}

export class TxLineClient {
  private log = new Logger("txline:rest");
  constructor(private session: TxLineSession) {}

  async fixturesSnapshot(competitionId: number): Promise<FixtureInfo[]> {
    const { data } = await this.session.api.get(
      `/fixtures/snapshot?competitionId=${competitionId}`
    );
    const arr = Array.isArray(data) ? data : data?.fixtures || [];
    const out: FixtureInfo[] = [];
    for (const raw of arr) {
      const f = normalizeFixture(raw);
      if (f) out.push(f);
    }
    this.log.info("fixtures snapshot", { competitionId, count: out.length });
    return out;
  }

  async scoresUpdates(
    epochDay: number,
    hour: number,
    interval: number,
    fixtureId?: number
  ): Promise<any[]> {
    let url = `/scores/updates/${epochDay}/${hour}/${interval}`;
    if (fixtureId) url += `?fixtureId=${fixtureId}`;
    const { data } = await this.session.api.get(url);
    return Array.isArray(data) ? data : [];
  }

  async statValidation(fixtureId: number, seq: number, statKeys: number[]): Promise<any> {
    const url = `/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(",")}`;
    this.log.info("fetching proof", { url });
    const { data } = await this.session.api.get(url);
    return data;
  }
}
