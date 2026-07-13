"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fixtures = fixtures;
exports.scoresSnapshot = scoresSnapshot;
/** World Cup = competition 72. `startEpochDay` widens the window (default: now-40d). */
async function fixtures(session, opts = {}) {
    const comp = opts.competitionId ?? 72;
    const start = opts.startEpochDay ?? Math.floor(Date.now() / 86400000) - 40;
    const rows = await session.get(`/fixtures/snapshot?competitionId=${comp}&startEpochDay=${start}`);
    return (rows ?? []).map((f) => ({
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
async function scoresSnapshot(session, fixtureId) {
    const rows = await session.get(`/scores/snapshot/${fixtureId}`);
    return Array.isArray(rows) ? rows : [];
}
