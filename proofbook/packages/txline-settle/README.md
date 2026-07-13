# `@proofbook/txline-settle`

Settle a Solana market against a **real TxLINE Merkle proof**.

Everything ProofBook learned about TxLINE's on-chain interface, extracted so the
next program doesn't have to learn it the same way — by failed CPIs.

```bash
npm i @proofbook/txline-settle
```

---

## Settle your own market with a real proof

```ts
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TxLineSession, TXLINE_API_DEVNET,
  parlay, homeWin, overCorners, strategyFor,
  findFinalisedSeq, fetchProofV3, toPayloadV3, proofEpochDay,
  dailyRootsPda,
} from "@proofbook/txline-settle";

// "Home win AND over 9.5 corners" — an exhaustive 2x2 grid, not Hit/Miss.
const market  = parlay(homeWin, overCorners(9.5));      // legs: [1,2,7,8]
const statKeys = market.legs.map(l => l.key);

const session = new TxLineSession({ origin: TXLINE_API_DEVNET, wallet, subscribe });
const seq     = await findFinalisedSeq(session, fixtureId);
const val     = await fetchProofV3(session, fixtureId, seq, statKeys);

const payload  = toPayloadV3(val, BN);                   // ONE shared multiproof
const epochDay = proofEpochDay(val);
const strategy = strategyFor(market, 0);                 // outcome 0 = the parlay

await myProgram.methods
  .settle(0, payload)                                    // your instruction
  .accounts({
    market: myMarket,
    oracleProgram: TXORACLE_DEVNET,
    oracleRoots: dailyRootsPda(epochDay),                // TxLINE's own PDA
  })
  .rpc();
```

That's it. Your program CPIs `validate_stat_v3`, the oracle checks the multiproof
against the root **TxLINE published on Solana**, and returns a `bool`.

---

## The three things that will cost you a day each

None of these are in TxLINE's docs. All three are confirmed against the live
devnet oracle (`keeper/scripts/txline-conformance.ts` in the ProofBook repo
reproduces them).

### 1. At most **5 stat keys** per proof

```
statKeys=1,2,3,4,5,6  ->  400 "Parameter statKeys must contain between 1 and 5 valid keys"
```

A market needing a 6th leg cannot obtain a proof at all.

### 2. Every proven stat must be evaluated **exactly once**

```
DuplicateStatCoverage   (6070)  — a stat evaluated twice
IncompleteStatCoverage  (6071)  — a stat left unevaluated
```

### 3. ⚠️ Therefore a compound predicate's legs must read **DISJOINT stats**

This is the one that gets everybody.

```ts
parlay(homeWin, overGoals(2.5));
// Error: Cannot combine "Home win" with "Over 2.5 goals": both read the goals
// stat family. TxLINE evaluates each proven stat EXACTLY ONCE
// (DuplicateStatCoverage, error 6070), so legs that share a stat can never be
// proven together. This is not an encoding problem — there is no encoding.

parlay(homeWin, overCorners(9.5));   // ✅  goals {1,2} + corners {7,8}
parlay(overCorners(9.5), overCards(3.5));   // ✅  corners {7,8} + yellows {3,4}
```

**"Home win AND over 2.5 goals" is not expressible in a single proof.** Both legs
read goals P1/P2. The library throws at build time so you find out in your editor
rather than in production.

---

## Why a parlay is a 2×2 grid, not Hit/Miss

An outcome is an **AND of predicates**. There is no OR and no negation.

The complement of `A ∧ B` is `¬A ∨ ¬B` — a disjunction, which cannot be written as
an outcome. So a two-way Hit/Miss parlay is **not exhaustive**: if it misses in
the wrong way, *no outcome is provable*, the market can never settle, and it
voids.

`parlay()` returns the full grid:

```
  0:  A ∧ B      <- "the parlay"
  1:  A ∧ ¬B
  2:  ¬A ∧ B
  3:  ¬A ∧ ¬B
```

Every cell is a pure AND, every cell is provable, and together they tile every
possible result. Each condition carries its own exact complement, which is why the
lines are half-integers: `over 2.5` is `> 2`, and its integer complement is `< 3`.

The same reasoning rules out **Correct Score**: an "any other score" bucket is the
negation of a disjunction. Use winning-margin buckets, which tile the integer line.

---

## Why v3 (and not v2)

v3 replaces v2's per-stat sibling paths with **one shared Merkle multiproof**.
Measured on real proofs for fixture 18218149:

| legs | v2 nodes | v3 nodes | v2 tx | v3 tx |
|---|---|---|---|---|
| 2 | 12 | 6 | 900 B | 702 B |
| 3 | 17 | 7 | 1065 B | 735 B |
| 4 | 22 | 6 | **1230 B** | 702 B |
| 5 | 27 | 6 | **1395 B ✗** | 702 B |

A Solana transaction caps at **1232 bytes**. v2 grows linearly — a whole new
sibling path per leg — and at 4 legs it fits *by two bytes*. At 5 legs (TxLINE's
own maximum) **it does not fit at all**. v3 is essentially flat, because the
leaves share almost all their internal nodes.

---

## Verify a receipt, trusting nobody

```ts
import { verifyReceipt } from "@proofbook/txline-settle";

const r = await verifyReceipt({
  connection, session, txoracle, BN,
  fixtureId,
  statKeys,                    // read from the settling program's on-chain spec
  strategy,                    // ditto — NOT from its API
});

r.verified;      // adjudicated by TxLINE's OWN program
r.provenValues;  // the values the merkle proof attests
```

The five facts and where each must come from:

| fact | source |
|---|---|
| settlement | the settling program's account (Solana) |
| predicate | the same account — fixed at creation |
| merkle root | TxLINE's **own** daily-roots PDA (Solana) |
| proof | TxLINE's API |
| verdict | TxLINE's **own** program (simulated) |

Note what is absent: the settling protocol's API and database. **A receipt that
can only be checked by asking the protocol whether it is telling the truth is not
a receipt.** If someone hands you a forged proof, the multiproof will not
reconstruct TxLINE's published root and the oracle will reject it — so it does not
matter who handed it to you.

---

## What is NOT provable

* **Event timing.** No timestamps on goals. "Next goal", "goal before minute X" —
  not expressible.
* **Player stats.** In the REST feed, not in the merkle tree.
* **Fixture cancellation.** `GET /fixtures/snapshot` returns a `GameState` field,
  but the `Fixture` struct that `validate_fixture` authenticates has **no such
  field** — so it is not part of what is hashed. Settling on it means trusting
  TxLINE's API. And Merkle inclusion cannot prove *absence*, so "no stats ⇒
  cancelled" is not a statement the tree can make. Use a time-based liveness
  escape hatch; it is not a fallback, it is the correct primitive.

---

## Rust

For CPI-ing `validate_stat_v3` from your own Anchor program, see
[`rust/README.md`](./rust/README.md) — the wire types and the `invoke` helper,
copy-pasteable.

## License

MIT
