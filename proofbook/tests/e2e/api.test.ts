/**
 * API integration tests — against a RUNNING API + Postgres.
 *
 * These assert the two things that would embarrass us most:
 *   · the contract (pagination, filters, cache headers, SSE) actually behaves
 *   · the HONESTY invariants hold at the wire, not just in a unit test — no
 *     fabricated score, no receipt without a proof, no winner claimed for a tie
 *     we cannot prove
 *
 *   npm run test:api                       # local
 *   API_URL=https://... npm run test:api   # deployed
 */
import { expect } from "chai";

const API = process.env.API_URL ?? "http://localhost:8787";

async function raw(p: string, init?: RequestInit) {
  return fetch(`${API}${p}`, init);
}
async function get<T>(p: string): Promise<T> {
  const res = await raw(p);
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return (await res.json()) as T;
}

describe("API", function () {
  this.timeout(30_000);

  describe("health", () => {
    it("reports database and keeper separately", async () => {
      const h = await get<any>("/health");
      expect(h.ok).to.equal(true);
      expect(h.db).to.equal(true);
      expect(h.version).to.be.a("string");
      // The keeper being down must NOT be reported as the API being down — they
      // are different failures and need different responses.
      expect(h.keeper).to.have.property("alive");
      expect(h.counts.settled).to.be.greaterThan(0);
    });
  });

  describe("pagination", () => {
    it("honours limit/offset and reports hasMore truthfully", async () => {
      const page1 = await get<any>("/markets?limit=10&offset=0");
      expect(page1.items).to.have.length(10);
      expect(page1.limit).to.equal(10);
      expect(page1.offset).to.equal(0);
      expect(page1.total).to.be.greaterThan(10);
      expect(page1.hasMore).to.equal(true);

      const page2 = await get<any>("/markets?limit=10&offset=10");
      expect(page2.offset).to.equal(10);
      // Pages must not overlap.
      const ids1 = page1.items.map((m: any) => m.marketPda);
      const ids2 = page2.items.map((m: any) => m.marketPda);
      expect(ids1.some((i: string) => ids2.includes(i))).to.equal(false);

      // The last page reports hasMore = false.
      const last = await get<any>(
        `/markets?limit=10&offset=${page1.total - 1}`
      );
      expect(last.hasMore).to.equal(false);
    });

    it("rejects a nonsense limit rather than silently clamping", async () => {
      const res = await raw("/markets?limit=99999");
      expect(res.status).to.equal(400);
      const body: any = await res.json();
      expect(body.error).to.match(/invalid/i);
    });
  });

  describe("filters", () => {
    it("filters by status", async () => {
      const open = await get<any>("/markets?status=open");
      expect(open.items.every((m: any) => m.status === "open")).to.equal(true);

      const settled = await get<any>("/markets?status=settled");
      expect(settled.items.every((m: any) => m.status === "settled")).to.equal(
        true
      );
      expect(settled.total).to.be.greaterThan(50);
    });

    it("filters by stage", async () => {
      const sf = await get<any>("/markets?stage=SF");
      expect(sf.items.length).to.be.greaterThan(0);
      expect(sf.items.every((m: any) => m.stage === "SF")).to.equal(true);
    });

    it("filters by proofStatus", async () => {
      const gaps = await get<any>("/markets?proofStatus=no_proof");
      expect(
        gaps.items.every((m: any) => m.proofStatus === "no_proof")
      ).to.equal(true);
      expect(gaps.total).to.be.greaterThan(0);
    });

    it("sorts by kickoff in both directions", async () => {
      const asc = await get<any>("/markets?sort=kickoff&limit=20");
      const desc = await get<any>("/markets?sort=-kickoff&limit=20");
      const isSorted = (a: any[], dir: 1 | -1) =>
        a.every(
          (m, i) => i === 0 || dir * (m.kickoffTs - a[i - 1].kickoffTs) >= 0
        );
      expect(isSorted(asc.items, 1)).to.equal(true);
      expect(isSorted(desc.items, -1)).to.equal(true);
    });
  });

  describe("honesty invariants (the ones that matter)", () => {
    it("NEVER serves a scoreline for a fixture it cannot prove", async () => {
      const gaps = await get<any>("/markets?proofStatus=no_proof&limit=200");
      for (const m of gaps.items) {
        expect(
          m.live.score,
          `fabricated score on fixture ${m.fixtureId}`
        ).to.equal(null);
        expect(m.gapReason, "a gap must say why").to.be.a("string");
      }
    });

    it("every receipt carries a proven score, a proof ref and a settle tx", async () => {
      const receipts = await get<any>("/receipts?limit=200");
      expect(receipts.total).to.be.greaterThan(50);
      for (const r of receipts.items) {
        expect(
          r.provenScore,
          `receipt ${r.marketPda} has no proven score`
        ).to.not.equal(null);
        expect(r.proofRef).to.match(/^[0-9a-f]{64}$/);
        expect(r.settleTx).to.be.a("string");
        // The winning outcome must agree with the score the proof attests.
        const { p1, p2 } = r.provenScore;
        const expected = p1 > p2 ? 0 : p1 < p2 ? 2 : 1;
        expect(
          r.winningOutcome,
          `receipt ${r.marketPda} disagrees with its own score`
        ).to.equal(expected);
      }
    });

    it("standings count an unprovable match as UNPLAYED and say so", async () => {
      const groups = await get<any[]>("/standings");
      expect(groups.length).to.be.greaterThan(0);

      for (const g of groups) {
        // The group must disclose how much of it is actually proven.
        expect(g.provenCount).to.be.at.most(g.totalCount);

        // Points can only come from proven matches: with 3 points a win and 1 a
        // draw, total points across a group can never exceed 3 x provenCount.
        const points = g.rows.reduce((a: number, r: any) => a + r.points, 0);
        expect(
          points,
          `${g.label} has points from matches it cannot prove`
        ).to.be.at.most(3 * g.provenCount);

        // And games played must match too.
        const played = g.rows.reduce((a: number, r: any) => a + r.played, 0);
        expect(
          played,
          `${g.label} counted an unprovable match as played`
        ).to.equal(2 * g.provenCount);
      }
    });

    it("the bracket claims a winner ONLY for a proven tie", async () => {
      const rounds = await get<any[]>("/bracket");
      for (const round of rounds) {
        for (const tie of round.ties) {
          if (!tie.proven) {
            expect(
              tie.winner,
              `winner claimed for unproven tie ${tie.fixtureId}`
            ).to.equal(null);
            expect(
              tie.score,
              `score shown for unproven tie ${tie.fixtureId}`
            ).to.equal(null);
          }
        }
      }
    });
  });

  describe("caching", () => {
    it("serves an ETag and honours If-None-Match with a 304", async () => {
      const first = await raw("/receipts?limit=5");
      const etag = first.headers.get("etag");
      expect(etag, "no ETag — the board is polled constantly").to.be.a(
        "string"
      );

      const second = await raw("/receipts?limit=5", {
        headers: { "if-none-match": etag! },
      });
      expect(second.status).to.equal(304);
    });
  });

  describe("SSE", () => {
    it("opens a stream and keeps it open", async () => {
      const ctrl = new AbortController();
      const res = await fetch(`${API}/stream`, {
        headers: { accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/text\/event-stream/);

      // The first frame carries the retry hint, which is what makes a browser
      // reconnect on its own if the API restarts.
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).to.match(/retry:/);

      ctrl.abort();
    });
  });

  describe("errors", () => {
    it("404s an unknown market instead of 500ing", async () => {
      const res = await raw("/markets/11111111111111111111111111111111");
      expect(res.status).to.equal(404);
    });

    it("404s a receipt for a market that never settled", async () => {
      const open = await get<any>("/markets?status=open&limit=1");
      if (!open.items.length) return; // nothing open — skip
      const res = await raw(`/receipts/${open.items[0].marketPda}`);
      expect(res.status).to.equal(404);
      const body: any = await res.json();
      expect(body.error).to.match(/not settled|not found/i);
    });
  });
});
