# Engineering notes

Seven things this build learned the expensive way. Each one changed the design, and most
of them are not written down anywhere else, because you only find them by settling real
markets against a real oracle and watching them fail.

## 1. `validate_stat_v2` to `validate_stat_v3`: one proof instead of many

v2 carried a sibling path per stat. Every leg you added carried its own merkle path, and
the paths overlapped, so a four leg parlay shipped the same interior nodes several times
over. v3 replaces them with a single shared multiproof: the leaves, the hashes needed to
reconstruct the root, and the indices that say where each leaf sits.

Measured on fixture 18218149, a four leg proof:

|          | nodes | proof bytes |
| -------- | ----- | ----------- |
| v2       | 22    | 726         |
| v3       | 6     | 198         |

The real settle transaction is 702 bytes, of which 504 is non proof overhead (accounts,
signatures, instruction data). Solana's limit is 1232. So v2 at four legs came to 1230
bytes and fit by two bytes, and v2 at five legs came to 1395 and did not fit at all. v3
lands flat around 700 whatever you ask it to prove.

The parlay grid is not a feature we chose so much as one v3 made reachable.

## 2. `DuplicateStatCoverage`: parlay legs must read disjoint stat families

The oracle imposes three constraints, all confirmed against the live devnet oracle rather
than read off a spec:

1. A proof may carry at most five stat keys. Ask for a sixth and the API refuses.
2. Every proven stat must be evaluated exactly once. Evaluate one twice and you get
   `DuplicateStatCoverage (6070)`. Leave one unevaluated and you get
   `IncompleteStatCoverage (6071)`.
3. Therefore the legs of a parlay must read from **disjoint stat families**: goals are
   keys 1 and 2, yellows 3 and 4, reds 5 and 6, corners 7 and 8.

The consequence is sharper than it first looks. "Home win AND over 2.5 goals" is **not
expressible**, because both legs read the goals family, so the goal stats would be
evaluated twice. "Home win AND over 9.5 corners" is fine. Every parlay in the catalogue
is built from disjoint families, and `parlayGrid()` throws at build time if you try to
overlap them, because the alternative is minting a market that can never settle.

`ComboSpec::validate()` enforces the same rule on chain, so the program will not accept a
spec the oracle would later reject.

## 3. There is no complement, so the grid must be exhaustive

An outcome is an AND of predicates. There is no OR and no negation. So for a parlay `A AND
B`, the complement is `NOT A OR NOT B`, which cannot be expressed as an outcome at all.

Hit versus Miss is therefore **not exhaustive**, and a market whose outcomes do not cover
the space is a market that can be settled into a hole. The fix is the 2x2 grid: four
outcomes, `A AND B`, `A AND NOT B`, `NOT A AND B`, `NOT A AND NOT B`. Outcome 0 is still
"the parlay"; the other three are the rest of reality.

The same reasoning kills Correct Score, which needs an "any other score" bucket that
cannot be built, so Winning Margin shipped instead.

## 4. The period trap, and why a bad spec is forever

Each merkle leaf is keyed by `(stat key, period)`, and the program rebuilds the leaf from
the spec when it verifies. So a spec pins the period its proof must carry.

TxLINE keeps the `game_finalised` record, period 100, for roughly ten days. After that the
record is pruned and the same fixture proves at period 5, full time. Later still we watched
it prove at period 0. The fixture has not changed. Its retention has.

A spec is immutable. Pin period 100 to a fixture that now proves at period 5 and it can
**never** settle: `InvalidStatProof (6023)`, forever, with no way to amend it.

This cost us a whole generation of markets. The catalogue hardcoded period 100, 58 of the
76 fixtures had aged past it, and 171 settlements failed before the cause was clear. Market
types 16 to 27 are permanently unsettleable and were replaced by generation 2, types 28 to
39. They cannot be deleted, because devnet accounts never can, so the market type allowlist
is what keeps them off the board.

Two rules came out of it, and both are now enforced in code:

- Never take a period from a cache or a plan. Fetch the live proof and commit to the period
  it actually carries. The prop vault does this before it will let you sign.
- For a fixture that has not been played, there is no proof to read, so pin period 100,
  because that is what a proof taken at full time will carry.

## 5. A cancellation cannot be proven

Merkle inclusion proves that something **is** in a tree. It cannot prove that something is
**absent**, and it cannot prove a negative.

We went looking for a way to prove a match was abandoned, and the search ended quickly:
`game_state` appears in exactly one struct in the entire IDL, `Odds`. The `Fixture` merkle
leaf preimage that `validate_fixture` authenticates has eleven fields, and not one of them
is a status.

So a proof of cancellation does not exist and cannot be made to exist. Time based
permissionless cancellation is therefore not a fallback or a compromise. It is the correct
primitive, and it is why cancellation can only ever return money to the people who put it
in, and can never pay a winner.

## 6. A winning outcome with zero stake silently voids the market

If the proven outcome has no stake on it, `settle_market` routes the market to Cancelled:
refundable, no fee, and **no receipt**. It looks like a settlement failure and it is not,
it is the program declining to divide by zero.

This voided 74 markets before anyone noticed, because nothing about it is loud.

Hence the rule, enforced by `npm run preflight`, which refuses to arm a market that would
hit it: **seed liquidity on every outcome before settling.** Not on the likely outcome. On
every one.

## 7. Split brain: session locks do not survive a connection pooler

Only one keeper may settle at a time, so leadership is a Postgres advisory lock. Advisory
locks at session scope are, by definition, tied to one backend connection.

pgbouncer multiplexes many clients onto few backends. So the lock is not held by a keeper,
it is held by the pooler, and it is handed around. We watched two keepers each believe they
were the leader while `pg_locks` cheerfully reported the holder as
`application_name = pgbouncer`. Both were settling.

The fix is `DIRECT_DATABASE_URL`: take the lock on a direct, unpooled connection so it has a
real session to live in, and re assert it every fifteen seconds. Ordinary reads and writes
still go through the pooler, where pooling is an asset rather than a liability.

## 8. A vault that pays itself can never settle

`settle_prop_vault` takes the beneficiary's token account and the depositor's token account
as two writable accounts. When they are the same wallet, they are the same account, and the
runtime rejects the duplicate: `ConstraintDuplicateMutableAccount (2040)`.

So a self hedge vault is not merely useless, it is **unsettleable**. It could only ever time
out into a refund, and the escrow would sit there until it did.

The guard belongs on chain, not in the UI, because a UI check stops nobody who calls the
program directly. `initialize_prop_vault` now rejects it at creation with `SelfHedgeVault`,
which is the same principle as `ComboSpec::validate()`: if it can never pay out, it should
never have existed.
