/** The SDK's promise is that it refuses to build an unsettleable market. Prove it. */
import { parlay, homeWin, overGoals, overCorners, overCards, strategyFor, assertCoverage, familyOf, single, GT } from "./predicate";

let pass = 0, fail = 0;
const ok = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e: any) { console.log(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`); fail++; }
};
const throws = (name: string, re: RegExp, fn: () => void) => {
  try { fn(); console.log(`  ✗ ${name} — expected a throw`); fail++; }
  catch (e: any) {
    if (re.test(e.message)) { console.log(`  ✓ ${name}`); pass++; }
    else { console.log(`  ✗ ${name} — wrong error: ${e.message.slice(0,80)}`); fail++; }
  }
};

console.log("\n@proofbook/txline-settle\n");

throws("rejects a parlay whose legs share the goals family (6070)", /DuplicateStatCoverage|goals stat family/,
  () => parlay(homeWin, overGoals(2.5)));

ok("accepts goals + corners (disjoint)", () => {
  const m = parlay(homeWin, overCorners(9.5));
  if (m.legs.map(l => l.key).join() !== "1,2,7,8") throw new Error("wrong legs");
  if (m.outcomes.length !== 4) throw new Error("grid must be exhaustive (4 cells)");
});

ok("accepts corners + cards (disjoint)", () => {
  const m = parlay(overCorners(9.5), overCards(3.5));
  if (m.legs.map(l => l.key).join() !== "7,8,3,4") throw new Error("wrong legs");
});

ok("the 2x2 grid covers every leg exactly once, in every cell", () => {
  const m = parlay(homeWin, overCorners(9.5));
  m.outcomes.forEach((_, i) => strategyFor(m, i)); // throws on bad coverage
});

ok("outcome 0 is 'the parlay'", () => {
  const m = parlay(homeWin, overCorners(9.5));
  if (!/Home win & Over 9.5 corners/.test(m.outcomes[0].label)) throw new Error(m.outcomes[0].label);
});

throws("rejects an unprovable stat key (player props etc.)", /not provable/,
  () => familyOf(99));

throws("rejects incomplete coverage (6071)", /IncompleteStatCoverage|never evaluated/,
  () => assertCoverage(2, [single(0, GT, 0)]));   // leg 1 proven but unused

throws("rejects duplicate coverage (6070)", /DuplicateStatCoverage|evaluated 2 times/,
  () => assertCoverage(1, [single(0, GT, 0), single(0, GT, 1)]));

console.log(`\n  ${pass} passing, ${fail} failing\n`);
process.exit(fail ? 1 : 0);
