/**
 * Tournament derivations — everything here is computed from the fixtures the
 * keeper actually indexed. Nothing is hardcoded, and nothing is inferred from a
 * result we cannot prove.
 *
 * Group membership comes from the fixture graph itself: in the group stage every
 * team plays only teams in its own group, so the groups fall out as the connected
 * components of "who played whom". No group table is typed in by hand, so none
 * can be wrong.
 *
 * Standings are built ONLY from fixtures with a real TxLINE proof. Where a result
 * is unprovable the match is counted as unplayed and reported as such — a table
 * that quietly folded in guessed results would be worse than an incomplete one.
 */
import type { MarketView } from "./api";
import { teamsForFixture, type Team } from "./teams";

export type Stage = "Group" | "R32" | "R16" | "QF" | "SF" | "3rd" | "Final";

export const KO_ORDER: Stage[] = ["R32", "R16", "QF", "SF", "3rd", "Final"];

export interface Fixture {
  market: MarketView;
  home: Team;
  away: Team;
  stage: Stage;
  /** Proven scoreline. Present only when a real proof settled this fixture. */
  score?: { p1: number; p2: number } | null;
  proven: boolean;
  /** Result is real but TxLINE can no longer prove it — shown without a receipt. */
  gap: boolean;
}

export function toFixture(m: MarketView): Fixture {
  const [home, away] = teamsForFixture(m.fixtureId, m.fixtureName, m.home, m.away);
  const proven = m.status === "settled";
  return {
    market: m,
    home,
    away,
    stage: (m.stage as Stage) ?? "Group",
    score: proven ? (m.live?.score ?? null) : null,
    proven,
    gap: m.proofStatus === "no_proof",
  };
}

export interface Row {
  team: Team;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}

export interface Group {
  label: string;
  rows: Row[];
  /** How much of this group we can actually prove. */
  provenCount: number;
  totalCount: number;
}

/** Connected components of the group-stage fixture graph = the groups. */
export function groupsOf(fixtures: Fixture[]): Group[] {
  const gs = fixtures.filter((f) => f.stage === "Group" && f.home.code !== "P1");

  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const f of gs) {
    link(f.home.code, f.away.code);
    link(f.away.code, f.home.code);
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const code of adj.keys()) {
    if (seen.has(code)) continue;
    const stack = [code];
    const comp: string[] = [];
    seen.add(code);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of adj.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    components.push(comp.sort());
  }

  // Stable, human-friendly labels: order groups by their alphabetically-first team.
  components.sort((a, b) => a[0].localeCompare(b[0]));

  return components.map((codes, i) => {
    const members = new Set(codes);
    const matches = gs.filter((f) => members.has(f.home.code) && members.has(f.away.code));
    const rows = new Map<string, Row>();

    const rowFor = (t: Team): Row => {
      if (!rows.has(t.code)) {
        rows.set(t.code, {
          team: t, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0,
        });
      }
      return rows.get(t.code)!;
    };
    for (const f of matches) {
      rowFor(f.home);
      rowFor(f.away);
    }

    for (const f of matches) {
      if (!f.proven || !f.score) continue; // unprovable => counted as unplayed
      const h = rowFor(f.home);
      const a = rowFor(f.away);
      const { p1, p2 } = f.score;
      h.played++; a.played++;
      h.gf += p1; h.ga += p2;
      a.gf += p2; a.ga += p1;
      if (p1 > p2) { h.won++; h.points += 3; a.lost++; }
      else if (p1 < p2) { a.won++; a.points += 3; h.lost++; }
      else { h.drawn++; a.drawn++; h.points++; a.points++; }
    }

    const list = [...rows.values()];
    for (const r of list) r.gd = r.gf - r.ga;
    list.sort(
      (x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf || x.team.code.localeCompare(y.team.code)
    );

    return {
      label: `Group ${String.fromCharCode(65 + i)}`,
      rows: list,
      provenCount: matches.filter((f) => f.proven).length,
      totalCount: matches.length,
    };
  });
}

/** Knockout fixtures bucketed by round, earliest kickoff first. */
export function bracketOf(fixtures: Fixture[]): [Stage, Fixture[]][] {
  return KO_ORDER.map((stage) => [
    stage,
    fixtures
      .filter((f) => f.stage === stage)
      .sort((a, b) => (a.market.kickoffTs ?? 0) - (b.market.kickoffTs ?? 0)),
  ]).filter(([, list]) => list.length > 0) as [Stage, Fixture[]][];
}

/** The winning side of a proven fixture, or null when it isn't proven. */
export function winnerOf(f: Fixture): Team | null {
  if (!f.proven || f.market.winningOutcome === null) return null;
  if (f.market.winningOutcome === 0) return f.home;
  if (f.market.winningOutcome === 2) return f.away;
  return null; // draw (knockouts settle on the 90/ET/PENS stat we proved)
}
