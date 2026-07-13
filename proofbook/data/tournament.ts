/**
 * Tournament metadata — original, no FIFA IP.
 * Team identity (names, participant ids) comes from TxLINE itself; this file
 * adds our own 3-letter codes, confederations and colour chips, plus the stage
 * calendar. No emblems, no official assets.
 *
 * Team resolution is deliberately explicit: `resolveTeam` matches on the TxLINE
 * participant name and NEVER guesses. Unknown names surface as `unknown: true`
 * so they can be added here rather than silently mislabelled.
 */

export type Confed = "UEFA" | "CONMEBOL" | "CONCACAF" | "CAF" | "AFC" | "OFC";

export interface Team {
  code: string; // our 3-letter code
  name: string; // canonical display name
  iso: string; // ISO 3166-1 alpha-2 for the flag set ("" = unknown)
  confed: Confed;
  chip: string; // brand colour chip (hex)
  unknown?: boolean;
}

/** The 48-team field. `chip` is a single representative colour, never a flag. */
/**
 * The 48-team field — taken verbatim from the participants TxLINE reports for
 * this tournament, not from memory. `chip` is a confederation colour, never a flag
 * or an emblem.
 */
export const TEAMS: Record<string, Team> = {
  ALG: {
    code: "ALG",
    name: "Algeria",
    iso: "dz",
    confed: "CAF",
    chip: "#b5713f",
  },
  ARG: {
    code: "ARG",
    name: "Argentina",
    iso: "ar",
    confed: "CONMEBOL",
    chip: "#c8a04a",
  },
  AUS: {
    code: "AUS",
    name: "Australia",
    iso: "au",
    confed: "AFC",
    chip: "#8a5fa8",
  },
  AUT: {
    code: "AUT",
    name: "Austria",
    iso: "at",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  BEL: {
    code: "BEL",
    name: "Belgium",
    iso: "be",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  BIH: {
    code: "BIH",
    name: "Bosnia & Herzegovina",
    iso: "ba",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  BRA: {
    code: "BRA",
    name: "Brazil",
    iso: "br",
    confed: "CONMEBOL",
    chip: "#c8a04a",
  },
  CAN: {
    code: "CAN",
    name: "Canada",
    iso: "ca",
    confed: "CONCACAF",
    chip: "#4a9a7c",
  },
  CPV: {
    code: "CPV",
    name: "Cape Verde",
    iso: "cv",
    confed: "CAF",
    chip: "#b5713f",
  },
  COL: {
    code: "COL",
    name: "Colombia",
    iso: "co",
    confed: "CONMEBOL",
    chip: "#c8a04a",
  },
  COD: {
    code: "COD",
    name: "Congo DR",
    iso: "cd",
    confed: "CAF",
    chip: "#b5713f",
  },
  CRO: {
    code: "CRO",
    name: "Croatia",
    iso: "hr",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  CUW: {
    code: "CUW",
    name: "Curacao",
    iso: "cw",
    confed: "CONCACAF",
    chip: "#4a9a7c",
  },
  CZE: {
    code: "CZE",
    name: "Czech Republic",
    iso: "cz",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  ECU: {
    code: "ECU",
    name: "Ecuador",
    iso: "ec",
    confed: "CONMEBOL",
    chip: "#c8a04a",
  },
  EGY: {
    code: "EGY",
    name: "Egypt",
    iso: "eg",
    confed: "CAF",
    chip: "#b5713f",
  },
  ENG: {
    code: "ENG",
    name: "England",
    iso: "gb-eng",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  FRA: {
    code: "FRA",
    name: "France",
    iso: "fr",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  GER: {
    code: "GER",
    name: "Germany",
    iso: "de",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  GHA: {
    code: "GHA",
    name: "Ghana",
    iso: "gh",
    confed: "CAF",
    chip: "#b5713f",
  },
  HAI: {
    code: "HAI",
    name: "Haiti",
    iso: "ht",
    confed: "CONCACAF",
    chip: "#4a9a7c",
  },
  IRN: { code: "IRN", name: "Iran", iso: "ir", confed: "AFC", chip: "#8a5fa8" },
  IRQ: { code: "IRQ", name: "Iraq", iso: "iq", confed: "AFC", chip: "#8a5fa8" },
  CIV: {
    code: "CIV",
    name: "Ivory Coast",
    iso: "ci",
    confed: "CAF",
    chip: "#b5713f",
  },
  JPN: {
    code: "JPN",
    name: "Japan",
    iso: "jp",
    confed: "AFC",
    chip: "#8a5fa8",
  },
  JOR: {
    code: "JOR",
    name: "Jordan",
    iso: "jo",
    confed: "AFC",
    chip: "#8a5fa8",
  },
  MEX: {
    code: "MEX",
    name: "Mexico",
    iso: "mx",
    confed: "CONCACAF",
    chip: "#4a9a7c",
  },
  MAR: {
    code: "MAR",
    name: "Morocco",
    iso: "ma",
    confed: "CAF",
    chip: "#b5713f",
  },
  NED: {
    code: "NED",
    name: "Netherlands",
    iso: "nl",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  NZL: {
    code: "NZL",
    name: "New Zealand",
    iso: "nz",
    confed: "OFC",
    chip: "#5f8aa8",
  },
  NOR: {
    code: "NOR",
    name: "Norway",
    iso: "no",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  PAN: {
    code: "PAN",
    name: "Panama",
    iso: "pa",
    confed: "CONCACAF",
    chip: "#4a9a7c",
  },
  PAR: {
    code: "PAR",
    name: "Paraguay",
    iso: "py",
    confed: "CONMEBOL",
    chip: "#c8a04a",
  },
  POR: {
    code: "POR",
    name: "Portugal",
    iso: "pt",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  QAT: {
    code: "QAT",
    name: "Qatar",
    iso: "qa",
    confed: "AFC",
    chip: "#8a5fa8",
  },
  KSA: {
    code: "KSA",
    name: "Saudi Arabia",
    iso: "sa",
    confed: "AFC",
    chip: "#8a5fa8",
  },
  SCO: {
    code: "SCO",
    name: "Scotland",
    iso: "gb-sct",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  SEN: {
    code: "SEN",
    name: "Senegal",
    iso: "sn",
    confed: "CAF",
    chip: "#b5713f",
  },
  RSA: {
    code: "RSA",
    name: "South Africa",
    iso: "za",
    confed: "CAF",
    chip: "#b5713f",
  },
  KOR: {
    code: "KOR",
    name: "South Korea",
    iso: "kr",
    confed: "AFC",
    chip: "#8a5fa8",
  },
  ESP: {
    code: "ESP",
    name: "Spain",
    iso: "es",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  SWE: {
    code: "SWE",
    name: "Sweden",
    iso: "se",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  SUI: {
    code: "SUI",
    name: "Switzerland",
    iso: "ch",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  TUN: {
    code: "TUN",
    name: "Tunisia",
    iso: "tn",
    confed: "CAF",
    chip: "#b5713f",
  },
  TUR: {
    code: "TUR",
    name: "Turkey",
    iso: "tr",
    confed: "UEFA",
    chip: "#4a6fa5",
  },
  USA: {
    code: "USA",
    name: "USA",
    iso: "us",
    confed: "CONCACAF",
    chip: "#4a9a7c",
  },
  URU: {
    code: "URU",
    name: "Uruguay",
    iso: "uy",
    confed: "CONMEBOL",
    chip: "#c8a04a",
  },
  UZB: {
    code: "UZB",
    name: "Uzbekistan",
    iso: "uz",
    confed: "AFC",
    chip: "#8a5fa8",
  },
};

/** Alternate spellings TxLINE may use → our code. Explicit, never fuzzy. */
const ALIASES: Record<string, string> = {
  "united states": "USA",
  usa: "USA",
  "united states of america": "USA",
  "south korea": "KOR",
  "korea republic": "KOR",
  "republic of korea": "KOR",
  iran: "IRN",
  "ir iran": "IRN",
  "islamic republic of iran": "IRN",
  "ivory coast": "CIV",
  "cote d'ivoire": "CIV",
  "côte d'ivoire": "CIV",
  netherlands: "NED",
  holland: "NED",
  "saudi arabia": "KSA",
  "south africa": "RSA",
  czechia: "CZE",
  "cape verde": "CPV",
  "cabo verde": "CPV",
  curacao: "CUW",
  curaçao: "CUW",
  "new zealand": "NZL",
  "costa rica": "CRC",
  switzerland: "SUI",
  germany: "GER",
  portugal: "POR",
  denmark: "DEN",
  uruguay: "URU",
  paraguay: "PAR",
  algeria: "ALG",
  "el salvador": "SLV",
};

const BY_NAME: Record<string, Team> = (() => {
  const m: Record<string, Team> = {};
  for (const t of Object.values(TEAMS)) m[t.name.toLowerCase()] = t;
  return m;
})();

/**
 * Resolve a TxLINE participant name to a team. Never guesses: an unmatched name
 * returns a placeholder flagged `unknown` (rendered as a neutral chip + the raw
 * name) so gaps are visible instead of silently wrong.
 */
export function resolveTeam(name?: string): Team {
  if (!name)
    return {
      code: "???",
      name: "Unknown",
      iso: "",
      confed: "UEFA",
      chip: "#6f6455",
      unknown: true,
    };
  const key = name.trim().toLowerCase();
  const direct = BY_NAME[key];
  if (direct) return direct;
  const alias = ALIASES[key];
  if (alias && TEAMS[alias]) return TEAMS[alias];
  const code = name.trim().slice(0, 3).toUpperCase();
  return {
    code,
    name: name.trim(),
    iso: "",
    confed: "UEFA",
    chip: "#6f6455",
    unknown: true,
  };
}

/** Host cities (the three host nations). Venue names are generic, not licensed. */
export const HOSTS = ["Canada", "Mexico", "United States"] as const;

// ── Stage calendar (2026 tournament shape: 104 matches) ───────────────────────
export type Stage = "Group" | "R32" | "R16" | "QF" | "SF" | "3rd" | "Final";

/**
 * Stage boundaries by kickoff (UTC).
 *
 * Each stage ends at 08:00Z the morning AFTER its last LOCAL match day — not at
 * UTC midnight. Every venue is UTC-4..UTC-7, so a 22:00 local kickoff lands at
 * up to 03:00Z the NEXT UTC day. Midnight boundaries misfiled exactly those
 * late games: Colombia v Ghana (Jul 4 01:30Z — an R32 game played the evening
 * of Jul 3) showed as R16, and Argentina v Switzerland (Jul 12 01:00Z — a QF)
 * showed as a semi-final, so the bracket rendered 17/9/3/3 ties instead of
 * 16/8/4/2.
 */
const STAGE_BOUNDS: Array<[Stage, string]> = [
  ["Group", "2026-06-28T08:00:00Z"],
  ["R32", "2026-07-04T08:00:00Z"],
  ["R16", "2026-07-08T08:00:00Z"],
  ["QF", "2026-07-12T08:00:00Z"],
  ["SF", "2026-07-16T08:00:00Z"],
  ["3rd", "2026-07-19T08:00:00Z"],
  ["Final", "2026-12-31T23:59:59Z"],
];

export function stageOf(kickoffMs: number): Stage {
  for (const [stage, until] of STAGE_BOUNDS) {
    if (kickoffMs <= Date.parse(until)) return stage;
  }
  return "Final";
}

export const STAGE_ORDER: Stage[] = [
  "Group",
  "R32",
  "R16",
  "QF",
  "SF",
  "3rd",
  "Final",
];
export const KNOCKOUT_STAGES: Stage[] = [
  "R32",
  "R16",
  "QF",
  "SF",
  "3rd",
  "Final",
];
export const isKnockout = (s: Stage) => s !== "Group";
