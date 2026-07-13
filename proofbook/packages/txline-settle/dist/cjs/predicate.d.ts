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
export type Comparison = {
    greaterThan: {};
} | {
    lessThan: {};
} | {
    equalTo: {};
};
export type BinaryExpression = {
    add: {};
} | {
    subtract: {};
};
export declare const GT: Comparison;
export declare const LT: Comparison;
export declare const EQ: Comparison;
export declare const ADD: BinaryExpression;
export declare const SUB: BinaryExpression;
/** A stat to prove: TxLINE `(key, period)`. period 100 = game_finalised. */
export interface Leg {
    key: number;
    period: number;
}
export type StatPredicate = {
    single: {
        index: number;
        predicate: TraderPredicate;
    };
} | {
    binary: {
        indexA: number;
        indexB: number;
        op: BinaryExpression;
        predicate: TraderPredicate;
    };
};
export interface TraderPredicate {
    threshold: number;
    comparison: Comparison;
}
export interface NDimensionalStrategy {
    geometricTargets: {
        statIndex: number;
        prediction: number;
    }[];
    distancePredicate: TraderPredicate | null;
    discretePredicates: StatPredicate[];
}
export declare const STAT_FAMILY: Record<number, string>;
/** The family a stat key belongs to. Throws if the key is not provable. */
export declare function familyOf(key: number): string;
export declare const single: (index: number, comparison: Comparison, threshold: number) => StatPredicate;
export declare const binary: (indexA: number, indexB: number, op: BinaryExpression, comparison: Comparison, threshold: number) => StatPredicate;
/**
 * A named condition over some legs, WITH its exact complement.
 *
 * The complement matters: a compound market's outcome set has to be exhaustive
 * (see `parlay()`), and there is no NOT operator — so a condition has to know how
 * to negate itself. On integers `> t` negates to `< t+1`, which is why over/under
 * lines are half-integers.
 */
export interface Condition {
    label: string;
    negLabel: string;
    legs: Leg[];
    pred: (offset: number) => StatPredicate;
    neg: (offset: number) => StatPredicate;
}
export declare const homeWin: Condition;
export declare const overGoals: (line: number) => Condition;
export declare const overCorners: (line: number) => Condition;
export declare const overCards: (line: number) => Condition;
export interface CompoundOutcome {
    label: string;
    predicates: StatPredicate[];
}
export interface CompoundMarket {
    legs: Leg[];
    outcomes: CompoundOutcome[];
}
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
export declare function parlay(a: Condition, b: Condition): CompoundMarket;
/**
 * Turn one outcome of a compound market into the `NDimensionalStrategy` the
 * oracle expects, and CHECK its coverage before you send it.
 */
export declare function strategyFor(market: CompoundMarket, outcomeIndex: number): NDimensionalStrategy;
/**
 * Every leg referenced exactly once — the invariant behind 6070 and 6071.
 * Checked locally so the failure is a readable error, not a raw program error.
 */
export declare function assertCoverage(nLegs: number, preds: StatPredicate[]): void;
