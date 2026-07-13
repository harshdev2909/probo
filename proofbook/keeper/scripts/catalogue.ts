/**
 * Print the provable market catalogue, and demonstrate the build-time gate that
 * rejects an unprovable (overlapping-leg) parlay.
 *
 *   npm run catalogue
 */
import {
  CATALOGUE,
  parlayGrid,
  homeWin,
  overGoals,
  overCorners,
  statKeysOf,
} from "../src/markets/catalogue";

console.log("catalogue self-check passed at import.\n");
console.log("  type  slug                    outcomes  legs  statKeys");
console.log("  ────  ──────────────────────  ────────  ────  ────────");
for (const m of CATALOGUE) {
  console.log(
    `  ${String(m.type).padEnd(4)}  ${m.slug.padEnd(22)}  ${String(
      m.outcomes.length
    ).padStart(6)}    ${String(m.legs.length).padStart(3)}   [${statKeysOf(m).join(
      ","
    )}]${m.parlay ? "   parlay" : ""}`
  );
}

const p24 = CATALOGUE.find((m) => m.type === 36)!;
console.log(`\n2x2 exhaustive grid — ${p24.name}:`);
p24.outcomes.forEach((o, i) =>
  console.log(`   ${i}: ${o.label}${i === 0 ? "    <- 'the parlay'" : ""}`)
);
console.log("   every cell is a pure AND, and together they cover every result.");

console.log("\nbuild-time gate — an ILLEGAL parlay (legs share a stat family):");
try {
  // "Home win AND over 2.5 goals": both legs read goals P1/P2.
  parlayGrid(99, "illegal", homeWin, overGoals(2.5));
  console.log("   BUG: this should not have been accepted");
  process.exit(1);
} catch (e: any) {
  console.log("   rejected:", e.message.replace(/\s+/g, " "));
}

console.log("\nbuild-time gate — a LEGAL parlay (disjoint families):");
const ok = parlayGrid(98, "legal", homeWin, overCorners(9.5));
console.log(
  `   accepted: ${ok.name} — legs [${statKeysOf(ok).join(",")}], ${
    ok.outcomes.length
  } outcomes`
);
