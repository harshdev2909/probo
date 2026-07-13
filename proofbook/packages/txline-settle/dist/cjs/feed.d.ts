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
export declare function fixtures(session: TxLineSession, opts?: {
    competitionId?: number;
    startEpochDay?: number;
}): Promise<Fixture[]>;
/** Every retained score record for a fixture (raw TxLINE rows, newest state last). */
export declare function scoresSnapshot(session: TxLineSession, fixtureId: number): Promise<any[]>;
