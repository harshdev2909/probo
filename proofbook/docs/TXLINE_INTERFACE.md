# TxLINE On-Chain Interface — Verified Reference (validate_stat_v2)

> **Status: verified against the real TxODDS repo and live devnet.** ProofBook
> resolves outcomes trustlessly by CPI-ing into TxLINE's on-chain `txoracle`
> program. This file was regenerated from primary sources — the official examples
> repo **`github.com/txodds/tx-on-chain`** (branch `nojira-re-adding-examples`) and
> the live devnet API — not from summaries. Source refs use the form
> `repo:<path>:<line>` (paths relative to that repo) and `docs:<page>`.
>
> **ProofBook targets `validate_stat_v2`.** `validate_stat` (v1) still exists and
> is byte-compatible with our earlier build, but v2 is the current, richer
> interface (batched stats + an N-dimensional strategy) and is the settlement path.

---

## 0. What changed from the earlier (mock-era) assumptions

| Item | Earlier (guessed) | Now (CONFIRMED) |
|------|-------------------|-----------------|
| Instruction | `validate_stat` | **`validate_stat_v2`** (v1 kept for reference) |
| Args | flat `(ts, summary, proofs, predicate, stat_a, stat_b, op)` | **`(payload: StatValidationInput, strategy: NDimensionalStrategy)`** |
| Per-stat event root | one root **per** `StatTerm` | **one shared** top-level `event_stat_root`; stats batched as `Vec<StatLeaf>` |
| Predicate model | single/binary op inline | **`NDimensionalStrategy`**: geometric targets + distance predicate + `Vec<StatPredicate>` (Single/Binary, referencing stats **by index**) |
| Leaf/node hash | mock-local keccak (a **guess**) | still **not public** — see §6; reverse-engineered from a live proof in `scripts/settle-real-devnet.ts` |

---

## 1. Program IDs & tokens — CONFIRMED
`repo:documentation/programs/addresses.mdx`, verified live on devnet.

| Cluster | txoracle program | TxL mint (Token-2022) | API origin |
|---------|------------------|-----------------------|------------|
| Devnet | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` | `https://txline-dev.txodds.com` |
| Mainnet | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` | `https://txline.txodds.com` |

A devnet subscribe must be activated at `txline-dev.txodds.com`; mainnet at
`txline.txodds.com`. The devnet program was confirmed **executable/live** via
`getAccountInfo` at slot ~474,077,615.

## 2. `validate_stat_v2` — CONFIRMED
`repo:examples/devnet/idl/txoracle.json` (IDL name `txoracle`, version `1.5.5`).

```jsonc
{
  "name": "validate_stat_v2",
  "discriminator": [208, 215, 194, 214, 241, 71, 246, 178],
  "accounts": [ { "name": "daily_scores_merkle_roots" } ],   // single, read-only, not signer
  "args": [
    { "name": "payload",  "type": { "defined": "StatValidationInput" } },
    { "name": "strategy", "type": { "defined": "NDimensionalStrategy" } }
  ],
  "returns": "bool"
}
```

- **Return value:** a Borsh `bool` via Solana **return data**. Clients read it with
  `.view()`; a CPI reads it with `get_return_data()` → first byte `== 1`
  (`repo:examples/devnet/scripts/subscription_scores_v2a.ts:317-323`).
- **v1** `validate_stat` discriminator `[107,197,232,90,191,136,105,185]` (unchanged).

### Types — CONFIRMED (Borsh, from the IDL `types`)

```rust
struct StatValidationInput {
    ts: i64,                          // Unix ms (== summary.updateStats.minTimestamp)
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,    // API `subTreeProof`
    main_tree_proof: Vec<ProofNode>,  // API `mainTreeProof`
    event_stat_root: [u8; 32],        // API `eventStatRoot` — SHARED by all stats
    stats: Vec<StatLeaf>,             // API `statsToProve[i]` + `statProofs[i]`
}
struct StatLeaf { stat: ScoreStat, stat_proof: Vec<ProofNode> }
struct ScoreStat { key: u32, value: i32, period: i32 }
struct ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }
struct ScoresUpdateStats { update_count: i32, min_timestamp: i64, max_timestamp: i64 }
struct ProofNode { hash: [u8;32], is_right_sibling: bool }

struct NDimensionalStrategy {
    geometric_targets: Vec<GeometricTarget>,      // exact-score / distance markets
    distance_predicate: Option<TraderPredicate>,  // required iff geometric_targets non-empty (err 6072)
    discrete_predicates: Vec<StatPredicate>,      // AND-combined; every referenced stat must be covered
}
struct GeometricTarget { stat_index: u8, prediction: i32 }
enum StatPredicate {
    Single { index: u8, predicate: TraderPredicate },
    Binary { index_a: u8, index_b: u8, op: BinaryExpression, predicate: TraderPredicate },
}
struct TraderPredicate { threshold: i32, comparison: Comparison }
enum Comparison { GreaterThan, LessThan, EqualTo }
enum BinaryExpression { Add, Subtract }
```

### Coverage rules (from the error set) — CONFIRMED
`repo:examples/devnet/idl/txoracle.json` errors: `6070 DuplicateStatCoverage`,
`6071 IncompleteStatCoverage`, `6069 TooManyStats`, `6072 MissingDistancePredicate`,
`6053 StatKeyMismatch`, `6021 PredicateFailed`, `6003 InvalidSubTreeProof`,
`6004 InvalidMainTreeProof`, `6005 TimeSlotMismatch`, `6007 RootNotAvailable`,
`6009 InvalidPda`, `6022 InvalidFixtureSubTreeProof`, `6023 InvalidStatProof`.
→ **Every stat in `payload.stats` must be referenced exactly once** across
`discrete_predicates`/`geometric_targets`, or validation errors. ProofBook builds
`stats` and the strategy together so coverage is always complete.

## 3. Daily-root PDA — CONFIRMED
`["daily_scores_roots", u16(epochDay) little-endian (2 bytes)]` under the txoracle
program; `epochDay = floor(minTimestamp_ms / 86_400_000)`.
`repo:examples/devnet/scripts/subscription_scores_v2a.ts:162-168`,
`docs:programs/addresses`.

## 4. Proof REST API — CONFIRMED
`GET {origin}/api/scores/stat-validation?fixtureId=..&seq=..&statKeys=1,2,3001,3002`
with headers `Authorization: Bearer <jwt>` + `X-Api-Token: <apiToken>`.
Response (`repo:...v2a.ts:157-192`):

```jsonc
{
  "summary": { "fixtureId": <i64>,
    "updateStats": { "updateCount": <i32>, "minTimestamp": <ms>, "maxTimestamp": <ms> },
    "eventStatsSubTreeRoot": "<32B>" },
  "subTreeProof":  [ {"hash":"<32B>","isRightSibling":<bool>}, ... ],   // -> fixture_proof
  "mainTreeProof": [ ... ],                                            // -> main_tree_proof
  "eventStatRoot": "<32B>",                                           // -> shared event_stat_root
  "statsToProve":  [ {"key":<u32>,"value":<i32>,"period":<i32>}, ... ], // one per statKey, in order
  "statProofs":    [ [ProofNode...], ... ]                            // proof per stat, by index
}
```
`statKeys` order defines the indices used by `StatPredicate`/`GeometricTarget`.

## 5. Auth & free World-Cup tier — CONFIRMED
`repo:examples/devnet/common/{users.ts,config.ts}`, `docs:quickstart`,`docs:worldcup`.

1. **Guest JWT:** `POST {origin}/auth/guest/start` → `{ token }` (**verified working**).
2. **On-chain subscribe (Token-2022):** `subscribe(service_level_id: u16, weeks: u8)`
   with accounts `user, pricing_matrix (PDA ["pricing_matrix"]), token_mint (TxL),
   user_token_account (Token-2022 ATA), token_treasury_vault, token_treasury_pda
   (PDA ["token_treasury_v2"]), token_program=TOKEN_2022, associated_token_program,
   system_program`. `weeks` must be a multiple of 4 (min 4). Free World-Cup tier =
   service level with price 0 (read from `pricing_matrix` at runtime).
3. **Activate:** sign `"{txSig}:{leagues.join(',')}:{jwt}"` (NaCl detached, base64),
   `POST {origin}/api/token/activate { txSig, walletSignature, leagues }` with
   `Authorization: Bearer jwt` → `{ token: apiToken }`.
4. Thereafter send **both** `Authorization: Bearer jwt` and `X-Api-Token: apiToken`.

## 6. Score encoding & match semantics — CONFIRMED (with two items to verify live)
`repo:documentation/scores/soccer-feed.mdx`.

- **Stat key** `= (period*1000) + base_key`. Base: `1`=P1 goals, `2`=P2 goals,
  `3/4`=P1/P2 yellow, `5/6`=red, `7/8`=corners. Period offsets: full-game `+0`,
  H1 `+1000`, H2 `+2000`, ET1 `+3000`, ET2 `+4000`, PE `+5000`.
- **Game phase** ids `1..19`: `5=F` (ended), `10=FET` (ended after extra time),
  `13=FPE` (ended after penalties), `15=A` (abandoned), `16=C` (cancelled),
  `19=P` (postponed). A `game_state` field exists in the IDL fixture/score structs.

### Live-data findings (verified 2026-07-07 against devnet)
1. **`period=100` "game_finalised" — CONFIRMED.** A live finalised World-Cup
   fixture (`18193785`, seq 1123) returned, for `statKeys=1,2`,
   `[{key:1,value:1,period:100},{key:2,value:4,period:100}]` — i.e. the finalised
   result is served under **period 100**. ProofBook's match-winner market settled
   on it correctly (Away). So a match-winner market simply reads `stat.period` from
   the proof (100 when finalised) and stores it in the `OutcomeSpec`.
2. **Leaf-hash + node-combination rule — NO LONGER LOAD-BEARING for ProofBook.**
   ProofBook forwards the API proof verbatim to the *real* `validate_stat_v2`, which
   does the hashing internally; a **real devnet settlement succeeded** this way (see
   README), so ProofBook's correctness never depends on reproducing the rule. It
   remains internal to TxLINE's on-chain program and is only needed to make the
   offline `mock_oracle` *byte*-identical (a test convenience). The mock currently
   uses a self-consistent keccak scheme (`leaf:`/`node:` domain tags); reconciling
   it byte-for-byte with TxLINE is optional future work.
3. **`GameState` enum** (task: `1=Scheduled`, `6=Cancelled`) — a fixture-level state
   distinct from the 1..19 in-play phase; the live scan showed in-play `statusId`
   values `4` (H2) and `100` (finalised). Exact `game_state` integers still to be
   read from a fixtures snapshot; used only by the (future) oracle-proven cancel.

## Sources
- Repo: `github.com/txodds/tx-on-chain` @ `nojira-re-adding-examples` —
  `examples/devnet/idl/txoracle.json`, `.../types/txoracle.ts`,
  `.../scripts/subscription_scores_v2a.ts`, `.../scripts/subscription_free_tier.ts`,
  `.../common/users.ts`, `.../common/config.ts`, `documentation/scores/soccer-feed.mdx`,
  `documentation/programs/addresses.mdx`, `documentation/examples/onchain-validation.mdx`.
- Live: `POST https://txline-dev.txodds.com/auth/guest/start` (JWT issued);
  `getAccountInfo(6pW6…P2J)` on devnet (executable).

_Verified 2026-07-05 against the repo above and live devnet._
