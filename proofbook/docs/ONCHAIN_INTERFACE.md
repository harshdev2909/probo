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

## 1. Accounts

### `Market` — PDA `["market", authority, fixture_id:i64 LE, market_type:u8]`

| Field | Type | Meaning |
|-------|------|---------|
| `authority` | `Pubkey` | Creator (seed only; no power). |
| `fixture_id` | `i64` | TxLINE fixtureId == match_id. |
| `market_type` | `u8` | Product tag (0 = 1X2). |
| `status` | `MarketStatus` | `Open`/`Locked`/`Settled`/`Cancelled`. |
| `num_outcomes` | `u8` | 2..=8. |
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
