"use strict";
/**
 * The predicate builder — and the part that stops you shipping an unsettleable
 * market.
 *
 * TxLINE evaluates a proof against an `NDimensionalStrategy`: a set of predicates
 * over the proven stats, AND-combined. Two rules govern it, neither documented,
 * both confirmed against the live oracle:
 *
 *   DuplicateStatCoverage (6070)   a stat evaluated twice
 *   IncompleteStatCoverage (6071)  a stat left unevaluated
 *
 * Every proven stat must be referenced EXACTLY ONCE. The consequence is
 * counter-intuitive and it is the thing that will bite you:
 *
 *   "home win AND over 2.5 goals"     -> BOTH legs read goals P1/P2.
 *                                        Rejected. There is no encoding for it.
 *   "home win AND over 9.5 corners"   -> goals {1,2} + corners {7,8}. Fine.
 *
 * So a compound predicate's legs must read DISJOINT stat families. `parlay()`
 * below throws if they do not, at build time, in your editor — rather than as a
 * failed CPI in production.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.overCards = exports.overCorners = exports.overGoals = exports.homeWin = exports.binary = exports.single = exports.STAT_FAMILY = exports.SUB = exports.ADD = exports.EQ = exports.LT = exports.GT = void 0;
exports.familyOf = familyOf;
exports.parlay = parlay;
exports.strategyFor = strategyFor;
exports.assertCoverage = assertCoverage;
exports.GT = { greaterThan: {} };
exports.LT = { lessThan: {} };
exports.EQ = { equalTo: {} };
exports.ADD = { add: {} };
exports.SUB = { subtract: {} };
// ── the provable stat surface ───────────────────────────────────────────────
//
// statKey = period*1000 + base. Periods: full +0, H1 +1000, H2 +2000,
// ET1 +3000, ET2 +4000, PE +5000.
//
// There is NO event timing and NO player stat on-chain. "Next goal", "goal
// before minute X" and player props are not provable. Do not try.
exports.STAT_FAMILY = {
    1: "goals",
    2: "goals",
    3: "yellows",
    4: "yellows",
    5: "reds",
    6: "reds",
    7: "corners",
    8: "corners",
};
/** The family a stat key belongs to. Throws if the key is not provable. */
function familyOf(key) {
    const base = key % 1000;
    const period = Math.floor(key / 1000);
    const fam = exports.STAT_FAMILY[base];
    if (!fam) {
        throw new Error(`stat key ${key} is not provable. TxLINE's only provable base keys are ` +
            `1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (period-scoped as ` +
            `period*1000 + base).`);
    }
    return period ? `p${period}_${fam}` : fam;
}
const single = (index, comparison, threshold) => ({ single: { index, predicate: { threshold, comparison } } });
exports.single = single;
const binary = (indexA, indexB, op, comparison, threshold) => ({
    binary: { indexA, indexB, op, predicate: { threshold, comparison } },
});
exports.binary = binary;
const P = 100; // game_finalised
exports.homeWin = {
    label: "Home win",
    negLabel: "No home win",
    legs: [
        { key: 1, period: P },
        { key: 2, period: P },
    ],
    pred: (o) => (0, exports.binary)(o, o + 1, exports.SUB, exports.GT, 0),
    neg: (o) => (0, exports.binary)(o, o + 1, exports.SUB, exports.LT, 1),
};
const total = (keys, noun, line) => {
    const t = Math.floor(line);
    return {
        label: `Over ${line} ${noun}`,
        negLabel: `Under ${line} ${noun}`,
        legs: keys.map((key) => ({ key, period: P })),
        pred: (o) => (0, exports.binary)(o, o + 1, exports.ADD, exports.GT, t),
        neg: (o) => (0, exports.binary)(o, o + 1, exports.ADD, exports.LT, t + 1),
    };
};
const overGoals = (line) => total([1, 2], "goals", line);
exports.overGoals = overGoals;
const overCorners = (line) => total([7, 8], "corners", line);
exports.overCorners = overCorners;
const overCards = (line) => total([3, 4], "cards", line);
exports.overCards = overCards;
/**
 * Build an EXHAUSTIVE 2x2 parlay over two conditions.
 *
 * Why 2x2 and not Hit/Miss: an outcome is an AND of predicates, so the complement
 * of `A ∧ B` — which is `¬A ∨ ¬B` — is not expressible. A two-way parlay is
 * therefore not exhaustive, and when it misses in the wrong way NO outcome is
 * provable, the market cannot settle, and it voids. The grid tiles every world:
 *
 *     A ∧ B     <- "the parlay"
 *     A ∧ ¬B
 *     ¬A ∧ B
 *     ¬A ∧ ¬B
 *
 * THROWS if the two conditions read the same stat family, because the oracle
 * would reject the proof with DuplicateStatCoverage (6070) and the market could
 * never settle. Better a stack trace now than a voided market later.
 */
function parlay(a, b) {
    const famA = new Set(a.legs.map((l) => familyOf(l.key)));
    const famB = new Set(b.legs.map((l) => familyOf(l.key)));
    const clash = [...famA].filter((f) => famB.has(f));
    if (clash.length) {
        throw new Error(`Cannot combine "${a.label}" with "${b.label}": both read the ` +
            `${clash.join("/")} stat family.\n\n` +
            `TxLINE evaluates each proven stat EXACTLY ONCE (DuplicateStatCoverage, ` +
            `error 6070), so legs that share a stat can never be proven together. ` +
            `This is not an encoding problem — there is no encoding.\n\n` +
            `Combine disjoint families instead, e.g. goals + corners, or corners + cards.`);
    }
    const legs = [...a.legs, ...b.legs];
    if (legs.length > 5) {
        throw new Error(`"${a.label} AND ${b.label}" needs ${legs.length} stat keys, but TxLINE's ` +
            `proof API accepts at most 5.`);
    }
    const oA = 0;
    const oB = a.legs.length;
    return {
        legs,
        outcomes: [
            { label: `${a.label} & ${b.label}`, predicates: [a.pred(oA), b.pred(oB)] },
            { label: `${a.label} & ${b.negLabel}`, predicates: [a.pred(oA), b.neg(oB)] },
            { label: `${a.negLabel} & ${b.label}`, predicates: [a.neg(oA), b.pred(oB)] },
            {
                label: `${a.negLabel} & ${b.negLabel}`,
                predicates: [a.neg(oA), b.neg(oB)],
            },
        ],
    };
}
/**
 * Turn one outcome of a compound market into the `NDimensionalStrategy` the
 * oracle expects, and CHECK its coverage before you send it.
 */
function strategyFor(market, outcomeIndex) {
    const outcome = market.outcomes[outcomeIndex];
    if (!outcome)
        throw new Error(`no outcome ${outcomeIndex}`);
    assertCoverage(market.legs.length, outcome.predicates);
    return {
        geometricTargets: [],
        distancePredicate: null,
        discretePredicates: outcome.predicates,
    };
}
/**
 * Every leg referenced exactly once — the invariant behind 6070 and 6071.
 * Checked locally so the failure is a readable error, not a raw program error.
 */
function assertCoverage(nLegs, preds) {
    const seen = new Array(nLegs).fill(0);
    for (const p of preds) {
        const idxs = "single" in p ? [p.single.index] : [p.binary.indexA, p.binary.indexB];
        for (const i of idxs) {
            if (i >= nLegs)
                throw new Error(`predicate references leg ${i}, only ${nLegs} exist`);
            seen[i]++;
        }
    }
    seen.forEach((n, i) => {
        if (n === 0)
            throw new Error(`leg ${i} is proven but never evaluated — TxLINE rejects this with ` +
                `IncompleteStatCoverage (6071). Every proven stat must be used.`);
        if (n > 1)
            throw new Error(`leg ${i} is evaluated ${n} times — TxLINE rejects this with ` +
                `DuplicateStatCoverage (6070). Each proven stat may be used exactly once.`);
    });
}
