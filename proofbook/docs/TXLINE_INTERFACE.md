# TxLINE On-Chain Interface — Verified Reference (`validate_stat_v3`)

> **Status: every claim below was measured against the live devnet oracle and the
> live TxLINE API, not read off a doc.** Where a claim comes from a primary
> source it is cited as `repo:<path>` (github.com/txodds/tx-on-chain) or
> `docs:<page>`. Where it was established empirically, the script that reproduces
> it is named. Nothing here is inferred.
>
> **ProofBook settles on `validate_stat_v3`.** `validate_stat_v2` remains behind
> the adapter and still settles the legacy 1X2 generation (market types 0–4).

Reproduce the findings in this document:

```bash
npm run proof:size          # v2 vs v3 proof size, on real proofs
npx ts-node keeper/scripts/txline-conformance.ts   # the coverage rules, live
npm run catalogue           # the build-time gate on illegal parlays
```

---

## 0. What changed from v2

| | v2 | v3 |
|---|---|---|
| Instruction | `validate_stat_v2` | **`validate_stat_v3`** |
| Discriminator | `[208,215,194,214,241,71,246,178]` | **`[150,37,155,89,141,190,77,203]`** |
| Payload | `StatValidationInput` | **`StatValidationInputV3`** |
| Stat authentication | one **full sibling path per stat** (`StatLeaf.stat_proof`) | **ONE shared Merkle multiproof** for all leaves |
| Strategy arg | `NDimensionalStrategy` | **identical — unchanged** |
| Accounts | `daily_scores_merkle_roots` | **identical — unchanged** |
| REST endpoint | `/api/scores/stat-validation` | **`/api/scores/stat-validation-v3`** |

**The IDL in the repo root is stale (1.5.5).** v3 lives in
`repo:examples/devnet/idl/txoracle.json`, version **1.5.6**. That file is
vendored here as `idl/txoracle.json`.

```rust
struct StatValidationInputV3 {
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    event_stat_root: [u8; 32],
    leaves: Vec<StatLeaf>,          // stat_proof comes back EMPTY — see below
    multiproof_hashes: Vec<ProofNode>,
    leaf_indices: Vec<u32>,
}
```

The v3 API returns `statsToProve` already `StatLeaf`-shaped (`[{ stat, statProof }]`)
plus `multiproof: { indices, hashes }`. **The per-leaf `statProof` arrays are
empty** — the multiproof supersedes them. (Confirmed: `[0,0,0,0]` for a 4-leg
proof on fixture 18218149.)

---

## 1. Proof size — MEASURED, on real proofs

Fixture 18218149, seq 1087. `npm run proof:size`.

| legs | v2 nodes | v2 bytes | v3 nodes | v3 bytes | saving |
|---|---|---|---|---|---|
| 1 | 7 | 231 | 7 | 231 | 0% |
| 2 | 12 | 396 | 6 | 198 | **50%** |
| 3 | 17 | 561 | 7 | 231 | **59%** |
| 4 | 22 | 726 | 6 | 198 | **73%** |
| 5 (TxLINE's max) | 27 | 891 | 6 | 198 | **78%** |

**v2 grows linearly — a whole new sibling path per leg. v3 is essentially flat**,
because the leaves share almost all of their internal nodes and the multiproof
carries each shared node exactly once.

### Why that matters: the 1232-byte transaction limit

A Solana transaction is capped at **1232 bytes**. The non-proof remainder of a
settle transaction — signature, header, account keys, blockhash, discriminators,
fixture summary, strategy, leaf values and indices — is **504 bytes**, measured
from the real 4-leg `settle_market_v3` transaction on devnet
([`2ATSv1a4…`](https://explorer.solana.com/tx/2ATSv1a41PBXXQRKTVNRrCXsqekU46f5kTTGijTkWLzYT1RQtgezs2uCAQygC6f86CCcUBDvFoTKdgztDstTn7hP?cluster=devnet),
702 bytes on the wire).

| legs | v2 tx | v3 tx | v2 fits? | v3 fits? |
|---|---|---|---|---|
| 2 | 900 B | 702 B | yes | yes |
| 3 | 1065 B | 735 B | yes | yes |
| 4 | **1230 B** | 702 B | **yes — by 2 bytes** | yes |
| 5 | **1395 B** | 702 B | **NO — over by 163 B** | yes |

So the honest statement is not "v2 can't do parlays". It is:

* At **4 legs v2 fits with two bytes to spare** — no margin whatsoever. One more
  account, one longer instruction, and it breaks.
* At **5 legs — TxLINE's own maximum — v2 does not fit at all.**
* **v3 settles all of them in ~702 bytes with 530 bytes of headroom**, and its
  size barely moves as legs are added.

---

## 2. THE THREE HARD CONSTRAINTS

These shape the entire product. Each was confirmed against the live oracle;
`keeper/scripts/txline-conformance.ts` reproduces all three.

### 2.1 At most **5 stat keys** per proof

```
GET /api/scores/stat-validation-v3?...&statKeys=1,2,3,4,5,6
-> 400 "Parameter statKeys must contain between 1 and 5 valid keys"
```

A market needing a 6th leg cannot obtain a proof **at all**. This is a product
limit, not a tuning knob. Encoded as `MAX_LEGS = 5` in `constants.rs`.

### 2.2 Every proven stat must be evaluated **exactly once**

```
Program log: AnchorError ... validate_stat_v3.rs:187.
  Error Code: DuplicateStatCoverage. Error Number: 6070.
  "Stat index is evaluated multiple times."

Program log: AnchorError ... validate_stat_v3.rs:229.
  Error Code: IncompleteStatCoverage. Error Number: 6071.
  "Not all extracted stats were evaluated."
```

### 2.3 ⚠️ Therefore: **parlay legs must read DISJOINT stats**

This is the counter-intuitive consequence, and it is the single most important
finding in this document.

> **"Home win AND over 2.5 goals" is NOT expressible in a single proof.**

Both legs read goals P1/P2. The second read is a *duplicate*, and the oracle
rejects the whole payload with `DuplicateStatCoverage (6070)`. It is not a matter
of encoding — there is no encoding.

What *is* expressible is a combination across **disjoint stat families**:

| parlay | stats | legal? |
|---|---|---|
| Home win **AND** over 9.5 corners | goals `{1,2}` + corners `{7,8}` | ✅ |
| Over 9.5 corners **AND** under 3.5 cards | corners `{7,8}` + yellows `{3,4}` | ✅ |
| Over 2.5 goals **AND** under 3.5 cards | goals `{1,2}` + yellows `{3,4}` | ✅ |
| Home win **AND** over 2.5 goals | goals `{1,2}` + goals `{1,2}` | ❌ **6070** |
| Home win **AND** BTTS | goals `{1,2}` + goals `{1,2}` | ❌ **6070** |

The families are: `goals {1,2}`, `yellows {3,4}`, `reds {5,6}`, `corners {7,8}`,
and their period-scoped variants (`ht_goals {1001,1002}`, …).

ProofBook enforces this **twice**, so an unprovable market can never exist:

* **At build time** — `parlayGrid()` in `keeper/src/markets/catalogue.ts` throws if
  two conditions share a family. `npm run catalogue` demonstrates it.
* **On-chain, at market creation** — `ComboSpec::validate()` requires every
  outcome to cover every leg exactly once. A market that would trip 6070/6071 at
  settle time cannot be created in the first place.

---

## 3. A parlay's outcome set must be EXHAUSTIVE — the 2×2 grid

An outcome is an **AND of predicates**. There is no OR and no negation.

The complement of `A ∧ B` is `¬A ∨ ¬B` — a disjunction. **It cannot be written as
an outcome.** So a two-way Hit/Miss parlay is *not* exhaustive: if it misses in
the wrong way, **no outcome is provable**, the market can never settle, and it
rides the cancel backstop to a refund.

ProofBook therefore models a parlay as a **2×2 grid**:

```
  A ∧ B        <- "the parlay"
  A ∧ ¬B
  ¬A ∧ B
  ¬A ∧ ¬B
```

Every cell is a pure AND, every cell is provable, and together they tile every
possible world. Each condition's negation must itself be expressible, which is
why the lines are half-integers: `over 2.5` is `> 2`, whose exact integer
complement is `< 3`.

The same reasoning kills **Correct Score**: an "any other score" bucket is the
negation of a disjunction, so a real score outside the listed set would leave no
provable outcome. ProofBook ships **Winning Margin** instead — margin buckets tile
the whole integer line, and every one of them is provable.

---

## 4. `validate_stat_v3` — the CPI

```jsonc
{
  "name": "validate_stat_v3",
  "discriminator": [150, 37, 155, 89, 141, 190, 77, 203],
  "accounts": [ { "name": "daily_scores_merkle_roots" } ],   // read-only, not signer
  "args": [
    { "name": "payload",  "type": { "defined": "StatValidationInputV3" } },
    { "name": "strategy", "type": { "defined": "NDimensionalStrategy" } }
  ],
  "returns": "bool"
}
```

Returns a Borsh `bool` via **return data**: a CPI reads it with
`get_return_data()` → first byte `== 1`. ProofBook's
`oracle::invoke_validate_stat_v3` builds
`discriminator ‖ borsh(payload) ‖ borsh(strategy)` and decodes exactly that.

Compute: the real 4-leg CPI consumed **176,632 CU** of a 1.4M budget.

**Daily-root PDA** (unchanged): `["daily_scores_roots", u16_le(epochDay)]` under
the txoracle program, `epochDay = floor(minTimestamp_ms / 86_400_000)`.

| Cluster | txoracle program | TxL mint (Token-2022) | API origin |
|---|---|---|---|
| Devnet | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` | `https://txline-dev.txodds.com` |
| Mainnet | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` | `https://txline.txodds.com` |

---

## 5. The provable stat surface

`statKey = (period * 1000) + base_key`

| base | stat | | period | scope |
|---|---|---|---|---|
| 1 / 2 | goals P1 / P2 | | +0 | full game |
| 3 / 4 | yellow cards | | +1000 | first half |
| 5 / 6 | red cards | | +2000 | second half |
| 7 / 8 | corners | | +3000 / +4000 | ET1 / ET2 |
| | | | +5000 | penalties |

The `ScoreStat.period` **field** is separate from the period encoded in the key:
it carries **100 = `game_finalised`**, meaning the game ended by *any* method
(regulation, extra time, penalties, abandonment). Confirmed live: fixture
18218149 returns `{key:1002, value:1, period:100}` — the key says "first-half away
goals", the period says "and the game is final".

**Availability**: probed across the provable fixtures, keys `1,2,3,4,5,6,7,8` and
`1001,1002` were present in **8/8** sampled. The whole catalogue is provable.

### What is NOT provable — and never will be, on this interface

* **Event timing.** There is no timestamp on a goal. "Next goal", "goal before
  minute X" are not expressible. Do not build them.
* **Player stats.** `PlayerStats` exists in the REST feed but is **not** in the
  stat-key table and is not merkle-committed. No player props.
* **Fixture status / cancellation.** See §6.

---

## 6. ⚠️ Cancellation is NOT provable — and that is a finding, not a gap

The temptation is to prove "this match was cancelled" and refund automatically.
**It cannot be done on this interface**, and the reason is worth stating exactly,
because the API *looks* like it offers what it does not.

**`GET /api/fixtures/snapshot` returns a `GameState` field.** It is right there in
the JSON. But `validate_fixture` authenticates the **`Fixture`** struct, and that
struct's merkle leaf preimage is:

```rust
struct Fixture {
    ts, start_time, competition, competition_id, fixture_group_id,
    participant1_id, participant1, participant2_id, participant2,
    fixture_id, participant1_is_home,
}   // <- eleven fields. NO game_state. NO status.
```

`game_state` occurs in **exactly one struct in the entire IDL: `Odds`.** It is not
in `Fixture`, not in `ScoreStat`, not in `ScoresBatchSummary`.

So the `GameState` in that REST response **is not part of what is hashed into the
tree**. Settling on it would mean trusting TxLINE's API — precisely the thing this
product exists to refute. It would look like a proof and be a promise.

And the absence of stats cannot substitute: **a Merkle inclusion proof cannot
prove absence.** "No stats exist, therefore the match was cancelled" is not a
statement the tree can make.

**Conclusion: the time-based permissionless cancel is not a fallback. It is the
correct primitive** — the only sound liveness escape hatch available, and
ProofBook keeps it as the sole cancellation path. (`Odds.game_state` *is*
merkle-committed via `validate_odds`, so a bookmaker's view of game state is
provable — but it is a bookmaker's view, and TxLINE publishes odds only around
kickoff. It is not a basis for voiding a market.)

---

## 7. The ODDS feed — a SECOND feed (Sharp vs Crowd)

Entirely separate from scores. **Never touches settlement**: no proof, no
predicate, no receipt is influenced by a price.

```jsonc
GET /api/odds/snapshot/{fixtureId}  ->
[{ "Bookmaker": "TXLineStablePriceDemargined", "BookmakerId": 10021,
   "SuperOddsType": "1X2_PARTICIPANT_RESULT",
   "PriceNames": ["part1","draw","part2"],
   "Prices":     [3189, 2262, 4091],            // decimal odds x1000
   "Pct":        ["31.358","44.209","24.444"],  // implied %, ALREADY DEMARGINED
   "GameState": null, "InRunning": false, "Ts": 1783914389652 }]
```

**Demargined** is the load-bearing word: the implied probabilities sum to
**1.0001**, i.e. the overround is stripped. These are true consensus
probabilities, not padded prices — which is what makes a divergence against our
own pools meaningful rather than an artefact of the vig.

Two things measured the hard way:

1. **Odds appear only around kickoff and are purged afterwards.** A finished
   fixture returns `[]`. So the backfilled receipt wall has **no** consensus line,
   and ProofBook shows none rather than inventing one.
2. **`/odds/snapshot` is a short-lived buffer.** It returned two ticks for the
   semi-final one minute and zero the next. Polling it samples a moving line at
   random and misses most of the movement — so ProofBook ingests
   **`/api/odds/stream` (SSE)**, which delivers every tick. Devnet service level 1
   reports `samplingIntervalSec = 0` in the on-chain pricing matrix: zero delay.

---

## 8. Auth

1. **Guest JWT** — `POST {origin}/auth/guest/start` → `{ token }`. No credentials.
2. **On-chain subscribe** (free World-Cup tier) — `subscribe(service_level_id, weeks)`
   on the txoracle program, Token-2022, `weeks` a multiple of 4.
3. **Activate** — sign `"{txSig}:{leagues.join(',')}:{jwt}"`, `POST /api/token/activate`
   → `{ token: apiToken }`.
4. Thereafter send **both** `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`.

A guest JWT **alone** is not enough: the proof endpoint answers
`403 Missing API token`. This is why `/verify` is handed a read credential by
ProofBook's API — and why that does not weaken it (see `docs/ONCHAIN_INTERFACE.md`
and the tamper control on the page itself).

CORS on `txline-dev.txodds.com` is `access-control-allow-origin: *` and permits
`Authorization` + `X-Api-Token`, so a browser can fetch proofs **directly**.

---

## Sources

* Repo: `github.com/txodds/tx-on-chain` @ `main` — `examples/devnet/idl/txoracle.json`
  (v1.5.6), `examples/devnet/scripts/subscription_scores_v3c.ts`,
  `documentation/scores/soccer-feed.mdx`, `documentation/worldcup.mdx`.
* Live devnet: `validate_stat_v3` CPI'd successfully in
  [`2ATSv1a4…`](https://explorer.solana.com/tx/2ATSv1a41PBXXQRKTVNRrCXsqekU46f5kTTGijTkWLzYT1RQtgezs2uCAQygC6f86CCcUBDvFoTKdgztDstTn7hP?cluster=devnet);
  6070/6071 reproduced by `keeper/scripts/txline-conformance.ts`.

_Verified 2026-07-13 against IDL 1.5.6 and live devnet._
