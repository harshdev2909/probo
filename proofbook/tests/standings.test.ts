/**
 * Standings + bracket derivation.
 *
 * The property that matters most here is the honest one: an unprovable fixture
 * must never contribute to a table. If a proof aged out of TxLINE's retention
 * window we count the match as unplayed — we do not quietly fold in a result we
 * would have had to invent.
 */
import { expect } from "chai";
import {
  groupsOf,
  bracketOf,
  toFixture,
  winnerOf,
} from "../web/lib/tournament";
import type { MarketView } from "../web/lib/api";

type Opts = {
  id: number;
  home: string;
  away: string;
  stage: string;
  score?: [number, number];
  status?: MarketView["status"];
  proofStatus?: MarketView["proofStatus"];
};

const NAMES: Record<string, string> = {
  ARG: "Argentina",
  BRA: "Brazil",
  FRA: "France",
  ESP: "Spain",
  ENG: "England",
  GER: "Germany",
  ITA: "Italy",
  USA: "United States",
};
const ISO: Record<string, string> = {
  ARG: "ar",
  BRA: "br",
  FRA: "fr",
  ESP: "es",
  ENG: "gb-eng",
  GER: "de",
  ITA: "it",
  USA: "us",
};

/** A market as the keeper's API would serve it. */
function mkt({
  id,
  home,
  away,
  stage,
  score,
  status,
  proofStatus,
}: Opts): MarketView {
  const settled = status === "settled";
  const winning = score
    ? score[0] > score[1]
      ? 0
      : score[0] < score[1]
      ? 2
      : 1
    : null;
  return {
    marketPda: `pda-${id}`,
    fixtureId: id,
    fixtureName: `${NAMES[home]} v ${NAMES[away]}`,
    home: { code: home, name: NAMES[home], iso: ISO[home] },
    away: { code: away, name: NAMES[away], iso: ISO[away] },
    stage,
    kickoffTs: 1_700_000_000 + id,
    proofStatus: proofStatus ?? (settled ? "proven" : "no_proof"),
    marketType: 3,
    status: status ?? "open",
    outcomes: ["Home", "Draw", "Away"],
    pools: ["1", "1", "1"],
    totalPool: "3",
    crowdImplied: [0.33, 0.33, 0.34],
    feeBps: 500,
    lockTime: 0,
    resolutionTimeout: 0,
    winningOutcome: settled ? winning : null,
    oracleProgram: "oracle",
    usdcMint: "mint",
    vault: "vault",
    authority: "auth",
    txs: {},
    live: settled && score ? { score: { p1: score[0], p2: score[1] } } : null,
  } as MarketView;
}

describe("standings", () => {
  it("derives groups from the fixture graph, not a hardcoded table", () => {
    // Two disjoint 3-team round-robins => exactly two groups.
    const markets = [
      mkt({
        id: 1,
        home: "ARG",
        away: "BRA",
        stage: "Group",
        score: [2, 1],
        status: "settled",
      }),
      mkt({
        id: 2,
        home: "BRA",
        away: "FRA",
        stage: "Group",
        score: [0, 0],
        status: "settled",
      }),
      mkt({
        id: 3,
        home: "ARG",
        away: "FRA",
        stage: "Group",
        score: [1, 3],
        status: "settled",
      }),
      mkt({
        id: 4,
        home: "ENG",
        away: "GER",
        stage: "Group",
        score: [1, 0],
        status: "settled",
      }),
      mkt({
        id: 5,
        home: "GER",
        away: "ITA",
        stage: "Group",
        score: [2, 2],
        status: "settled",
      }),
      mkt({
        id: 6,
        home: "ENG",
        away: "ITA",
        stage: "Group",
        score: [0, 1],
        status: "settled",
      }),
    ];
    const groups = groupsOf(markets.map(toFixture));
    expect(groups).to.have.length(2);
    expect(groups.flatMap((g) => g.rows)).to.have.length(6);
    // no team appears in two groups
    const codes = groups.flatMap((g) => g.rows.map((r) => r.team.code));
    expect(new Set(codes).size).to.equal(codes.length);
  });

  it("computes points, goal difference and order correctly", () => {
    const markets = [
      mkt({
        id: 1,
        home: "ARG",
        away: "BRA",
        stage: "Group",
        score: [2, 1],
        status: "settled",
      }),
      mkt({
        id: 2,
        home: "BRA",
        away: "FRA",
        stage: "Group",
        score: [0, 0],
        status: "settled",
      }),
      mkt({
        id: 3,
        home: "ARG",
        away: "FRA",
        stage: "Group",
        score: [1, 3],
        status: "settled",
      }),
    ];
    const [g] = groupsOf(markets.map(toFixture));
    const by = (c: string) => g.rows.find((r) => r.team.code === c)!;

    // ARG: beat BRA, lost to FRA => 3 pts, GF 3 GA 4
    expect(by("ARG").points).to.equal(3);
    expect(by("ARG").gf).to.equal(3);
    expect(by("ARG").ga).to.equal(4);
    expect(by("ARG").gd).to.equal(-1);
    // FRA: drew BRA, beat ARG => 4 pts
    expect(by("FRA").points).to.equal(4);
    // BRA: lost ARG, drew FRA => 1 pt
    expect(by("BRA").points).to.equal(1);

    expect(g.rows[0].team.code).to.equal("FRA"); // most points leads
    expect(g.provenCount).to.equal(3);
    expect(g.totalCount).to.equal(3);
  });

  it("NEVER counts an unprovable fixture — it is treated as unplayed", () => {
    const markets = [
      mkt({
        id: 1,
        home: "ARG",
        away: "BRA",
        stage: "Group",
        score: [2, 1],
        status: "settled",
      }),
      // played in reality, but TxLINE can no longer prove it
      mkt({
        id: 2,
        home: "BRA",
        away: "FRA",
        stage: "Group",
        proofStatus: "no_proof",
      }),
      mkt({
        id: 3,
        home: "ARG",
        away: "FRA",
        stage: "Group",
        proofStatus: "no_proof",
      }),
    ];
    const [g] = groupsOf(markets.map(toFixture));
    const by = (c: string) => g.rows.find((r) => r.team.code === c)!;

    expect(g.provenCount).to.equal(1);
    expect(g.totalCount).to.equal(3);
    // FRA played two matches in reality; neither is provable, so FRA has nothing.
    expect(by("FRA").played).to.equal(0);
    expect(by("FRA").points).to.equal(0);
    // ARG only carries the one match we can actually prove.
    expect(by("ARG").played).to.equal(1);
    expect(by("ARG").points).to.equal(3);
    // Every team still appears in the table — the fixture is known even when the result isn't.
    expect(g.rows).to.have.length(3);
  });

  it("orders the bracket and marks only proven winners", () => {
    const markets = [
      mkt({
        id: 10,
        home: "FRA",
        away: "ESP",
        stage: "SF",
        score: [1, 2],
        status: "settled",
      }),
      mkt({
        id: 11,
        home: "ARG",
        away: "BRA",
        stage: "QF",
        score: [3, 0],
        status: "settled",
      }),
      mkt({
        id: 12,
        home: "ENG",
        away: "GER",
        stage: "QF",
        proofStatus: "no_proof",
      }),
    ];
    const rounds = bracketOf(markets.map(toFixture));
    expect(rounds.map(([s]) => s)).to.deep.equal(["QF", "SF"]); // QF before SF

    const fixtures = markets.map(toFixture);
    expect(winnerOf(fixtures[0])!.code).to.equal("ESP"); // away won 1-2
    expect(winnerOf(fixtures[1])!.code).to.equal("ARG");
    expect(winnerOf(fixtures[2])).to.equal(null); // unprovable => no winner claimed
  });
});
