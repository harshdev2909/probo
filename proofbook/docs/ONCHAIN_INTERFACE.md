# ProofBook — On-Chain Interface & Proof Receipt Contract

The data contract the keeper service and frontend build against. Everything here
is derived from the Anchor IDL (`target/idl/proofbook.json`); field names are
shown in the on-chain (snake_case) form — Anchor TS clients expose them
camelCased.

- **proofbook program:** `4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63`
- **oracle (prod):** TxLINE `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` (devnet) /
  `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` (mainnet). Test builds use the
  bundled `mock_oracle` `F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u`.

---

## 0. What the program does, in one paragraph

A market escrows USDC in a PDA vault and resolves by **CPI-ing TxLINE's on-chain
`validate_stat_v3`** — never by an admin key. The caller supplies proven VALUES
and Merkle material; the **predicate** (which stats, which comparisons, which
thresholds) is fixed on-chain when the market is created. That binding is the
whole security property: a settler can only ever prove the question the market
was born to ask.

Two resolution paths, one payout path:

| market types | spec lives in | settles via |
|---|---|---|
| **0–15** (legacy 1X2 generations; the original 76 receipts) | `Market.outcomes[i].spec` — 1–2 stats, one predicate | `settle_market` → `validate_stat_v2` |
| **≥ 16** (the provable catalogue — goals, corners, cards, parlays…) | a **`ComboSpec` sidecar** — up to 5 legs, an AND of predicates | `settle_market_v3` → `validate_stat_v3`, ONE shared multiproof |

`Market` is **byte-frozen**. `OutcomeSpec` lives inside `Vec<OutcomeState>` inside
`Market`, so widening it would shift every byte offset of the ~400 market accounts
already on devnet — including every settled one holding a Proof Receipt. Compound
markets therefore keep an ordinary `Market` (same vault, same pools, same audited
parimutuel math) and put the richer predicate in a sidecar. Nothing about money
changed; only how an outcome is proven.

`settle_market` **refuses** market types ≥ 16 (`ComboRequiresV3`). Without that
guard a parlay could be settled by proving only its FIRST leg — `Market.outcomes[i].spec`
can only hold a single 1–2 stat predicate, so "Home win AND over 9.5 corners" would
have settled on "Home win" alone and paid out the whole parlay.

---

## 1. Accounts

### `Market` — PDA `["market", authority, fixture_id:i64 LE, market_type:u8]`

| Field | Type | Meaning |
|-------|------|---------|
| `authority` | `Pubkey` | Creator (seed only; no power). |
| `fixture_id` | `i64` | TxLINE fixtureId == match_id. |
| `market_type` | `u8` | Product tag (0 = 1X2). |
| `status` | `MarketStatus` | `Open`/`Locked`/`Settled`/`Cancelled`. |
| `num_outcomes` | `u8` | 2..=12. Accounts are sized to the outcomes they ACTUALLY have — a 2-way over/under does not pay rent for twelve. |
| `winning_outcome` | `u8` | Winning index; `255` until resolved. |
| `fee_bps` | `u16` | Protocol fee (≤ 1000). |
| `lock_time` | `i64` | Unix s; betting closes at/after. |
| `resolution_timeout` | `i64` | Seconds after lock before `cancel` is legal. |
| `oracle_program` | `Pubkey` | Trusted oracle (CPI target). |
| `usdc_mint` | `Pubkey` | Designated deposit mint. |
| `vault` | `Pubkey` | Escrow token account (authority = this PDA). |
| `fee_treasury` | `Pubkey` | Wallet owning the fee destination. |
| `total_pool` | `u64` | Sum of all stakes. |
| `total_winning_pool` | `u64` | Winning outcome's stake at settle (payout denominator). |
| `fee_amount` | `u64` | Fee reserved at settle (0 if cancelled). |
| `paid_out` | `u64` | Running sum of winner payouts. |
| `winning_stake_claimed` | `u64` | Running sum of winning stake claimed (last-claimer detection). |
| `fee_withdrawn` | `bool` | Fee pushed to treasury. |
| `settled_at` | `i64` | Resolution time. |
| **`settle_proof_ref`** | `[u8;32]` | Events-subtree root proven. |
| **`settle_proof_ts`** | `i64` | Batch timestamp (Unix ms). |
| **`settle_epoch_day`** | `u16` | `floor(proof_ts / 86_400_000)`. |
| **`settle_daily_roots`** | `Pubkey` | Oracle daily-roots PDA verified against. |
| **`settle_resolver`** | `Pubkey` | Who submitted the winning proof. |
| `bump`, `vault_bump` | `u8` | PDA bumps. |
| `outcomes` | `Vec<OutcomeState>` | Per-outcome `{spec, pool}` (≤ 8). |

`OutcomeSpec = { stat_a_key:u32, stat_a_period:i32, has_stat_b:bool,
stat_b_key:u32, stat_b_period:i32, op:Option<BinaryExpression>,
comparison:Comparison, threshold:i32 }`. `OutcomeState = { spec, pool:u64 }`.

### `Position` — PDA `["position", market, owner]`
`{ market:Pubkey, owner:Pubkey, outcome_index:u8, amount:u64, claimed:bool, bump:u8 }`.
`claimed` gates both `claim_winnings` and `claim_refund`.

### Vault — PDA `["vault", market]`
SPL token account, mint = `usdc_mint`, authority = the Market PDA.

### Oracle `daily_scores_merkle_roots` — PDA `["daily_scores_roots", epoch_day:u16 LE]`
Owned by `oracle_program`; `epoch_day = floor(ts_ms / 86_400_000)`.

---

## 2. Instructions

| Instruction | Args | Accounts (s=signer, w=writable) |
|-------------|------|----------------------------------|
| `initialize_market` | `fixture_id:i64, market_type:u8, outcome_options:Vec<OutcomeSpec>, fee_bps:u16, lock_time:i64, resolution_timeout:i64, fee_treasury:Pubkey` | authority(s,w), market(w), usdc_mint, vault(w), token_program, system_program, rent |
| `place_bet` | `outcome_index:u8, amount:u64` | bettor(s,w), market(w), position(w), bettor_token(w), vault(w), token_program, system_program |
| `lock_market` | — | market(w), cranker(s) |
| `settle_market` | `claimed_outcome:u8, proof:SettlementProof` | cranker(s), market(w), oracle_program, oracle_roots |
| `claim_winnings` | — | winner(s,w), market(w), position(w), vault(w), winner_token(w), token_program |
| `cancel_market` | — | market(w), canceller(s) |
| `claim_refund` | — | user(s,w), market, position(w), vault(w), user_token(w), token_program |
| `withdraw_fees` | — | caller(s), market(w), vault(w), fee_treasury, fee_treasury_token(w), token_program |

`SettlementProof = { ts:i64, fixture_summary:ScoresBatchSummary,
fixture_proof:Vec<ProofNode>, main_tree_proof:Vec<ProofNode>, stat_a_value:i32,
stat_a_event_root:[u8;32], stat_a_proof:Vec<ProofNode>, has_stat_b:bool,
stat_b_value:i32, stat_b_event_root:[u8;32], stat_b_proof:Vec<ProofNode> }`.
(TxLINE wire types: see `docs/TXLINE_INTERFACE.md` §2. The predicate — stat keys,
periods, op, comparison, threshold — is NOT in the proof; it is fixed by the
market's `OutcomeSpec`, so the caller can only ever prove the configured outcome.)

---

## 3. Events

- **`MarketInitialized`** `{ market, authority, fixture_id, market_type,
  num_outcomes, fee_bps, lock_time, resolution_timeout, oracle_program,
  usdc_mint, fee_treasury }`
- **`BetPlaced`** `{ market, bettor, outcome_index, amount, position_total,
  outcome_pool, total_pool }`
- **`MarketLocked`** `{ market, locked_at, total_pool }`
- **`MarketSettled`** (the Proof Receipt) `{ market, fixture_id, winning_outcome,
  oracle_program, oracle_label, proof_ref, proof_ts, epoch_day, daily_roots,
  resolver, oracle_verified, refundable, total_pool, total_winning_pool,
  fee_amount, settled_at }`
- **`MarketCancelled`** `{ market, fixture_id, reason, cancelled_at, total_pool,
  canceller }` — `reason ∈ {"timeout","zero_winning_pool"}`.
- **`WinningsClaimed`** `{ market, winner, outcome_index, stake, payout,
  is_last_claimer }`
- **`RefundClaimed`** `{ market, user, outcome_index, amount }`
- **`FeesWithdrawn`** `{ market, fee_treasury, amount }`

---

## 4. Proof Receipt — reconstruct & verify from chain data

A **Proof Receipt** proves *why* a market resolved to its winner, trustlessly and
independently of ProofBook. To reconstruct and verify one:

1. **Read the settlement.** Fetch the `Market` account (or the `MarketSettled`
   event). Take `winning_outcome`, `settle_proof_ts` (`proof_ts`),
   `settle_epoch_day`, `settle_daily_roots`, `settle_proof_ref`, `settle_resolver`,
   `oracle_program`.

2. **Re-derive the outcome predicate.** From `Market.outcomes[winning_outcome].spec`
   read `stat_a_key/period`, optional `stat_b_key/period`, `op`, `comparison`,
   `threshold`. This is the exact predicate the program required the oracle to
   satisfy (e.g. Home win ⇒ `P1_goals − P2_goals > 0`).

3. **Re-derive the daily-root PDA.** Compute
   `find_program_address(["daily_scores_roots", u16(settle_epoch_day) LE],
   oracle_program)` and check it equals `settle_daily_roots`. Confirm
   `settle_epoch_day == floor(settle_proof_ts / 86_400_000)`.

4. **Fetch the published root.** Read the `daily_scores_merkle_roots` account at
   `settle_daily_roots` from the oracle program. This is TxLINE's signed daily
   Merkle root for that day.

5. **Re-run `validate_stat` yourself.** Ask TxLINE's proof API for the same
   fixture/stat (`GET /api/scores/stat-validation?fixtureId=&seq=&statKey=` — see
   `docs/TXLINE_INTERFACE.md` §4), build the `SettlementProof`, and call
   `oracle_program.validate_stat(...).view()` (read-only simulation) with the
   predicate from step 2. A `true` return independently confirms the winner. The
   `settle_proof_ref` equals the proven `events_sub_tree_root`, tying the receipt
   to a specific fixture batch.

Because step 5 uses the *same* on-chain program and the *same* published root that
the settlement used, anyone can verify the outcome without trusting ProofBook, the
market creator, or the resolver. `oracle_verified = true` in the event is the
program's own record that this check passed at settlement time.

> A keeper service automates steps 1–5 in reverse to *drive* settlement: watch for
> `MarketLocked`, poll TxLINE until the fixture's daily root is published, build
> the `SettlementProof`, and submit `settle_market`. If no resolvable proof appears
> before `lock_time + resolution_timeout`, submit `cancel_market` instead.


---

## 8. `ComboSpec` — the compound predicate  (added with `validate_stat_v3`)

PDA `["combo", market]`. Present only for market types ≥ 16.

| Field | Type | Meaning |
|---|---|---|
| `market` | `Pubkey` | The market this resolves. Checked at settle. |
| `legs` | `Vec<StatLeg>` | The stats proven. Order defines the predicate index space AND the `statKeys` request order. Max **5** — TxLINE's proof API rejects a 6th. |
| `outcomes` | `Vec<ComboOutcome>` | One per market outcome. Each is an **AND** of `LegPredicate`s. |

```rust
struct StatLeg     { key: u32, period: i32 }              // key = period*1000 + base
enum  LegPredicate { Single { index, comparison, threshold },
                     Binary { index_a, index_b, op, comparison, threshold } }
struct ComboOutcome { predicates: Vec<LegPredicate> }
```

### The invariant enforced at CREATION

**Every outcome must reference every leg exactly once.**

TxLINE validates the whole payload in one shot and errors if a proven stat is
evaluated twice (`DuplicateStatCoverage`, 6070) or left unevaluated
(`IncompleteStatCoverage`, 6071) — both reproduced live against the devnet oracle.
`ComboSpec::validate()` checks it in `initialize_combo_spec`, which turns two
settle-time failures into one create-time failure, while the market is still empty
and can simply be rebuilt. A market that could never pay out cannot be minted.

A direct consequence, and the least obvious thing in this repo:

> **A parlay's legs must read DISJOINT stats.** "Home win AND over 2.5 goals" is
> NOT expressible — both legs read goals P1/P2. "Home win AND over 9.5 corners" is,
> because goals `{1,2}` and corners `{7,8}` are disjoint families.

See `docs/TXLINE_INTERFACE.md` §2–3 for the evidence and the 2×2 grid that keeps a
parlay's outcome set exhaustive.

---

## 9. `PropVault` — parametric payout on a proven predicate

PDA `["prop_vault", depositor, vault_id:u64 LE]`. USDC escrowed against a compound
predicate — "Team A corners + Team B corners > 10" — settled by a single
`validate_stat_v3` proof. The parlay machinery, pointed at parametric insurance
instead of a pool.

| status | meaning |
|---|---|
| `Funded` | Escrowed, awaiting a proof. |
| `PaidOut` | The predicate **held** — the beneficiary was paid. |
| `Refunded` | The predicate **failed**, or the timeout fired — the depositor was refunded. |

`settle_prop_vault` is **permissionless**: whoever holds a valid proof may call it,
and they gain nothing by doing so. The PROOF decides where the money goes, not the
caller. `cancel_prop_vault` is the only non-proof path, it is time-triggered, and
it can only ever return the money to where it came from — there is no version of it
that pays the beneficiary.

---

## 10. Instructions

| Instruction | Notes |
|---|---|
| `initialize_market` | Sized to its actual outcome count. |
| `initialize_combo_spec` | Attaches a compound predicate. Open markets, types ≥ 16, coverage validated. |
| `place_bet` / `lock_market` / `claim_winnings` / `claim_refund` / `withdraw_fees` | Unchanged. Shared by every market type. |
| `settle_market` | v2 path. **Refuses types ≥ 16.** |
| `settle_market_v3` | Compound path. Every leg proven in ONE CPI against one multiproof. |
| `cancel_market` | Time-based liveness backstop. See below. |
| `initialize_prop_vault` / `settle_prop_vault` / `cancel_prop_vault` | Parametric vault. |

Both settle paths share **one** `record_settlement()`: the zero-winning-pool policy,
the fee, and every receipt field are a single implementation. The parlay path is not
a second, unaudited copy of the payout logic.

---

## 11. ⚠️ Why cancellation is time-based, and why that is CORRECT

The obvious design is to prove "this match was cancelled" and refund automatically.
**It cannot be done**, and the API makes it look like it can.

`GET /api/fixtures/snapshot` returns a `GameState` field. But `validate_fixture`
authenticates the **`Fixture`** struct, whose merkle leaf preimage is:

```rust
struct Fixture {
    ts, start_time, competition, competition_id, fixture_group_id,
    participant1_id, participant1, participant2_id, participant2,
    fixture_id, participant1_is_home,
}   // eleven fields. NO game_state. NO status.
```

`game_state` occurs in **exactly one struct in the entire IDL: `Odds`.** So the
`GameState` in that REST response **is not part of what is hashed into the tree**.
Settling on it would mean trusting TxLINE's API — precisely what this product exists
to refute. It would look like a proof and be a promise.

And absence cannot substitute: **a Merkle inclusion proof cannot prove absence.**
"No stats exist, therefore the match was cancelled" is not a statement the tree can
make.

So `cancel_market` is time-triggered, permissionless, sets no winner, and only ever
unlocks refunds. It is not a fallback for a missing feature. It is the only sound
liveness primitive this interface admits.
