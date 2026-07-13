/**
 * TxLINE's data feeds: fixtures and score records. Read-only REST; the SSE
 * stream lives in the CLI (it is a consumption pattern, not an API).
 */
import type { TxLineSession } from "./session";

export interface Fixture {
  fixtureId: number;
  startTime: number;
  competition: string;
  competitionId: number;
  participant1: string;
  participant2: string;
  participant1IsHome: boolean;
  gameState?: number;
}

/** World Cup = competition 72. `startEpochDay` widens the window (default: now-40d). */
export async function fixtures(
  session: TxLineSession,
  opts: { competitionId?: number; startEpochDay?: number } = {}
): Promise<Fixture[]> {
  const comp = opts.competitionId ?? 72;
  const start =
    opts.startEpochDay ?? Math.floor(Date.now() / 86_400_000) - 40;
  const rows = await session.get<any[]>(
    `/fixtures/snapshot?competitionId=${comp}&startEpochDay=${start}`
  );
  return (rows ?? []).map((f: any) => ({
    fixtureId: f.FixtureId,
    startTime: f.StartTime,
    competition: f.Competition,
    competitionId: f.CompetitionId,
    participant1: f.Participant1,
    participant2: f.Participant2,
    participant1IsHome: !!f.Participant1IsHome,
    gameState: f.GameState,
  }));
}

/** Every retained score record for a fixture (raw TxLINE rows, newest state last). */
export async function scoresSnapshot(
  session: TxLineSession,
  fixtureId: number
): Promise<any[]> {
  const rows = await session.get<any[]>(`/scores/snapshot/${fixtureId}`);
  return Array.isArray(rows) ? rows : [];
}
