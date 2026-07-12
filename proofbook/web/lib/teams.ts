/**
 * Nation registry. Flags are national flags (public-domain state symbols) via
 * the MIT `flag-icons` set — never FIFA badges or club crests.
 *
 * Teams are resolved from the participant names TxLINE itself reports (the
 * keeper passes them through as `fixtureName`). Nothing here guesses which
 * teams played a fixture: an earlier hardcoded fixtureId→teams map mislabelled
 * a real settled match, so the map is gone. If a name does not resolve, the
 * fixture degrades to P1/P2 rather than showing a confident wrong answer.
 */
export interface Team {
  code: string; // 3-letter display code
  name: string;
  iso: string; // flag-icons ISO 3166-1 alpha-2 ("" = no flag, render a chip)
}

export const TEAMS: Record<string, Team> = {
  ALG: { code: "ALG", name: "Algeria", iso: "dz" },
  ARG: { code: "ARG", name: "Argentina", iso: "ar" },
  AUS: { code: "AUS", name: "Australia", iso: "au" },
  AUT: { code: "AUT", name: "Austria", iso: "at" },
  BEL: { code: "BEL", name: "Belgium", iso: "be" },
  BIH: { code: "BIH", name: "Bosnia & Herzegovina", iso: "ba" },
  BRA: { code: "BRA", name: "Brazil", iso: "br" },
  CAN: { code: "CAN", name: "Canada", iso: "ca" },
  CPV: { code: "CPV", name: "Cape Verde", iso: "cv" },
  COL: { code: "COL", name: "Colombia", iso: "co" },
  COD: { code: "COD", name: "Congo DR", iso: "cd" },
  CRO: { code: "CRO", name: "Croatia", iso: "hr" },
  CUW: { code: "CUW", name: "Curacao", iso: "cw" },
  CZE: { code: "CZE", name: "Czech Republic", iso: "cz" },
  ECU: { code: "ECU", name: "Ecuador", iso: "ec" },
  EGY: { code: "EGY", name: "Egypt", iso: "eg" },
  ENG: { code: "ENG", name: "England", iso: "gb-eng" },
  FRA: { code: "FRA", name: "France", iso: "fr" },
  GER: { code: "GER", name: "Germany", iso: "de" },
  GHA: { code: "GHA", name: "Ghana", iso: "gh" },
  HAI: { code: "HAI", name: "Haiti", iso: "ht" },
  IRN: { code: "IRN", name: "Iran", iso: "ir" },
  IRQ: { code: "IRQ", name: "Iraq", iso: "iq" },
  CIV: { code: "CIV", name: "Ivory Coast", iso: "ci" },
  JPN: { code: "JPN", name: "Japan", iso: "jp" },
  JOR: { code: "JOR", name: "Jordan", iso: "jo" },
  MEX: { code: "MEX", name: "Mexico", iso: "mx" },
  MAR: { code: "MAR", name: "Morocco", iso: "ma" },
  NED: { code: "NED", name: "Netherlands", iso: "nl" },
  NZL: { code: "NZL", name: "New Zealand", iso: "nz" },
  NOR: { code: "NOR", name: "Norway", iso: "no" },
  PAN: { code: "PAN", name: "Panama", iso: "pa" },
  PAR: { code: "PAR", name: "Paraguay", iso: "py" },
  POR: { code: "POR", name: "Portugal", iso: "pt" },
  QAT: { code: "QAT", name: "Qatar", iso: "qa" },
  KSA: { code: "KSA", name: "Saudi Arabia", iso: "sa" },
  SCO: { code: "SCO", name: "Scotland", iso: "gb-sct" },
  SEN: { code: "SEN", name: "Senegal", iso: "sn" },
  RSA: { code: "RSA", name: "South Africa", iso: "za" },
  KOR: { code: "KOR", name: "South Korea", iso: "kr" },
  ESP: { code: "ESP", name: "Spain", iso: "es" },
  SWE: { code: "SWE", name: "Sweden", iso: "se" },
  SUI: { code: "SUI", name: "Switzerland", iso: "ch" },
  TUN: { code: "TUN", name: "Tunisia", iso: "tn" },
  TUR: { code: "TUR", name: "Turkey", iso: "tr" },
  USA: { code: "USA", name: "USA", iso: "us" },
  URU: { code: "URU", name: "Uruguay", iso: "uy" },
  UZB: { code: "UZB", name: "Uzbekistan", iso: "uz" },
};

/** Lowercased team name -> code, plus the aliases TxLINE uses. */
const BY_NAME: Record<string, string> = {
  "algeria": "ALG",
  "argentina": "ARG",
  "australia": "AUS",
  "austria": "AUT",
  "belgium": "BEL",
  "bosnia & herzegovina": "BIH",
  "brazil": "BRA",
  "canada": "CAN",
  "cape verde": "CPV",
  "colombia": "COL",
  "congo dr": "COD",
  "croatia": "CRO",
  "curacao": "CUW",
  "czech republic": "CZE",
  "ecuador": "ECU",
  "egypt": "EGY",
  "england": "ENG",
  "france": "FRA",
  "germany": "GER",
  "ghana": "GHA",
  "haiti": "HAI",
  "iran": "IRN",
  "iraq": "IRQ",
  "ivory coast": "CIV",
  "japan": "JPN",
  "jordan": "JOR",
  "mexico": "MEX",
  "morocco": "MAR",
  "netherlands": "NED",
  "new zealand": "NZL",
  "norway": "NOR",
  "panama": "PAN",
  "paraguay": "PAR",
  "portugal": "POR",
  "qatar": "QAT",
  "saudi arabia": "KSA",
  "scotland": "SCO",
  "senegal": "SEN",
  "south africa": "RSA",
  "south korea": "KOR",
  "spain": "ESP",
  "sweden": "SWE",
  "switzerland": "SUI",
  "tunisia": "TUN",
  "turkey": "TUR",
  "usa": "USA",
  "uruguay": "URU",
  "uzbekistan": "UZB",
  // aliases for the same nations
  "united states": "USA",
  "korea republic": "KOR",
  "cote d'ivoire": "CIV",
  "turkiye": "TUR",
};

export const UNKNOWN: Team = { code: "?", name: "Unknown", iso: "" };

/** Resolve one participant name. Never guesses — unknown names stay unknown. */
export function teamByName(name?: string): Team {
  if (!name) return UNKNOWN;
  const code = BY_NAME[name.trim().toLowerCase()];
  return (code && TEAMS[code]) || UNKNOWN;
}

/**
 * Teams for a fixture, from the keeper's real participant names.
 * `home`/`away` come straight from the API when present; `fixtureName`
 * ("United States v Belgium") is the fallback.
 */
export function teamsForFixture(
  _fixtureId: number,
  fixtureName?: string,
  home?: { code?: string; name?: string; iso?: string; unknown?: boolean },
  away?: { code?: string; name?: string; iso?: string; unknown?: boolean }
): [Team, Team] {
  // The keeper flags a participant it could not resolve with `unknown` (and a
  // "???" placeholder code). Trusting that payload blindly renders a board of
  // identical "Unknown" rows, which reads as a broken UI rather than as missing
  // data — so an unresolved side falls through to the name parse below.
  const resolved = (t?: { code?: string; unknown?: boolean }) =>
    !!t?.code && !t.unknown && !t.code.startsWith("?");

  if (resolved(home) && resolved(away)) {
    return [
      { code: home!.code!, name: home!.name ?? home!.code!, iso: home!.iso ?? "" },
      { code: away!.code!, name: away!.name ?? away!.code!, iso: away!.iso ?? "" },
    ];
  }
  const parts = fixtureName?.split(/\s+v\s+/i);
  if (parts?.length === 2) {
    const h = teamByName(parts[0]);
    const a = teamByName(parts[1]);
    if (h !== UNKNOWN || a !== UNKNOWN) return [h, a];
  }
  return [
    { code: "P1", name: "Participant 1", iso: "" },
    { code: "P2", name: "Participant 2", iso: "" },
  ];
}

/** In-play phase -> short status label. 100 = game_finalised. */
export function phaseLabel(statusId?: number | null): string {
  if (statusId === undefined || statusId === null) return "";
  const map: Record<number, string> = {
    1: "KO soon", 2: "1H", 3: "HT", 4: "2H", 5: "FT",
    7: "ET1", 8: "ET HT", 9: "ET2", 10: "AET",
    12: "PENS", 13: "PENS", 14: "INT", 15: "ABD", 19: "PPD", 100: "FT",
  };
  return map[statusId] ?? `#${statusId}`;
}

export const isLivePhase = (s?: number | null) =>
  s !== undefined && s !== null && [2, 3, 4, 7, 8, 9, 12].includes(s);
