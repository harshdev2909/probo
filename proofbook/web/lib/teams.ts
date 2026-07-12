/**
 * Nation registry. Flags are national flags (public-domain state symbols) via
 * the MIT `flag-icons` set — never FIFA badges or club crests.
 * TxLINE fixtures carry participant IDs; `PARTICIPANTS` maps known IDs.
 * Unknown fixtures degrade gracefully to P1/P2 with neutral chips.
 */
export interface Team {
  code: string; // 3-letter display code
  name: string;
  iso: string; // flag-icons ISO 3166-1 alpha-2
}

export const TEAMS: Record<string, Team> = {
  ARG: { code: "ARG", name: "Argentina", iso: "ar" },
  BEL: { code: "BEL", name: "Belgium", iso: "be" },
  BRA: { code: "BRA", name: "Brazil", iso: "br" },
  CAN: { code: "CAN", name: "Canada", iso: "ca" },
  ENG: { code: "ENG", name: "England", iso: "gb-eng" },
  ESP: { code: "ESP", name: "Spain", iso: "es" },
  FRA: { code: "FRA", name: "France", iso: "fr" },
  GER: { code: "GER", name: "Germany", iso: "de" },
  ITA: { code: "ITA", name: "Italy", iso: "it" },
  MAR: { code: "MAR", name: "Morocco", iso: "ma" },
  MEX: { code: "MEX", name: "Mexico", iso: "mx" },
  NED: { code: "NED", name: "Netherlands", iso: "nl" },
  NOR: { code: "NOR", name: "Norway", iso: "no" },
  POR: { code: "POR", name: "Portugal", iso: "pt" },
  SUI: { code: "SUI", name: "Switzerland", iso: "ch" },
  USA: { code: "USA", name: "United States", iso: "us" },
};

/** TxLINE participantId → team code (extend as fixtures are adopted). */
export const PARTICIPANTS: Record<number, string> = {
  3220: "MEX", // demo mapping for the recorded replay fixture 18193785
  1575: "USA",
};

/** fixtureId → [home, away] team codes (demo registry; keeper name wins if set). */
export const FIXTURES: Record<number, [string, string]> = {
  18193785: ["MEX", "USA"],
  18218149: ["ARG", "SUI"],
};

export function teamsForFixture(fixtureId: number, fixtureName?: string): [Team, Team] {
  const codes = FIXTURES[fixtureId];
  if (codes) return [TEAMS[codes[0]], TEAMS[codes[1]]];
  const m = fixtureName?.match(/([A-Z]{3})\s+vs\s+([A-Z]{3})/i);
  if (m && TEAMS[m[1].toUpperCase()] && TEAMS[m[2].toUpperCase()]) {
    return [TEAMS[m[1].toUpperCase()], TEAMS[m[2].toUpperCase()]];
  }
  return [
    { code: "P1", name: "Participant 1", iso: "" },
    { code: "P2", name: "Participant 2", iso: "" },
  ];
}

/** In-play phase → short status label. 100 = game_finalised. */
export function phaseLabel(statusId?: number): string {
  if (statusId === undefined) return "";
  const map: Record<number, string> = {
    1: "KO soon", 2: "1H", 3: "HT", 4: "2H", 5: "FT",
    7: "ET1", 8: "ET HT", 9: "ET2", 10: "AET",
    12: "PENS", 13: "PENS", 14: "INT", 15: "ABD", 19: "PPD", 100: "FT",
  };
  return map[statusId] ?? `#${statusId}`;
}

export const isLivePhase = (s?: number) => s !== undefined && [2, 3, 4, 7, 8, 9, 12].includes(s);
