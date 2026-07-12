# ProofBook — Security Audit

Scope: the `proofbook` Anchor program (`programs/proofbook/`). The `mock_oracle`
program is a test-only stand-in and is **not** part of the production trust
surface. Method: manual review against STRIDE + the Solana/Anchor common-pitfall
checklist, cross-checked with the unit + integration suites. Status of each
finding: **RESOLVED** unless marked otherwise.

Legend: 🟢 no issue / by design · 🟡 accepted risk (documented) · 🔴 must-fix.

---

## 1. PDA seeds, account substitution & vault spoofing — 🟢

| PDA | Seeds | Collision / substitution analysis |
|-----|-------|-------------------------------------|
| `Market` | `["market", authority, fixture_id:i64 LE, market_type:u8]` | Unique per (creator, fixture, type). Two creators can't collide; a creator can't create two markets with the same (fixture, type). |
| `vault`  | `["vault", market]` | One vault per market; bound to the market. |
| `Position` | `["position", market, owner]` | One position per (market, user). |
| oracle `daily_scores_roots` | `["daily_scores_roots", epoch_day:u16 LE]` (oracle-owned) | Verified equal to the PDA derived from `oracle_program` + `proof.ts` inside the adapter (`oracle::build_and_verify`), so a caller can't pass an unrelated roots account. |

- **Vault swap:** every instruction that touches the vault constrains it with
  `has_one = vault` against `Market.vault` (set at init from the vault PDA).
  Passing a foreign token account fails `WrongVault`. The winner/refund token
  accounts are constrained to the correct `mint` and `owner`.
- **Market swap:** `Market` is an Anchor `Account<Market>` (owner + discriminator
  checked). `Position` and `vault` derive from `market.key()`, so a swapped
  market can't be paired with another market's positions/vault.
- **Oracle swap:** `settle_market` requires `oracle_program == market.oracle_program`
  (`has_one`) **and** `== ActiveOracle::program_id()`; the return-data program id
  is re-checked after the CPI (`OracleReturnMismatch`).

## 2. Signer & authority checks — 🟢

| Instruction | Signer(s) | Authority model |
|-------------|-----------|-----------------|
| `initialize_market` | `authority` (payer) | Creator; **no settlement power** (only appears in seeds). |
| `place_bet` | `bettor` | Transfers from `bettor`'s own token account (`owner == bettor`). |
| `lock_market` | `cranker` (any) | Permissionless; only a clock check. |
| `settle_market` | `cranker` (any) | Permissionless; outcome decided **only** by the oracle CPI's `bool`. No admin path. |
| `cancel_market` | `canceller` (any) | Permissionless; only `now > lock_time + resolution_timeout`. |
| `claim_winnings` | `winner` | `position.owner == winner`; position PDA bound to `(market, winner)`. |
| `claim_refund` | `user` | Same binding as claim. |
| `withdraw_fees` | `caller` (any) | Permissionless push to the market-configured `fee_treasury` only. |

There is **no privileged key** anywhere: not the creator, not an upgrade
authority, not a keeper. Resolution is either the oracle's verified `bool` or a
pure timeout.

## 3. Token-account & mint validation — 🟢

- **Deposits:** `place_bet` constrains `bettor_token.mint == market.usdc_mint`
  (`WrongMint`) and `bettor_token.owner == bettor`. A non-USDC or foreign-owner
  token account is rejected (integration-tested).
- **Vault mint:** the vault is created at init with `token::mint = usdc_mint,
  token::authority = market`, so it can only ever hold the designated mint.
- **Payout/refund destinations:** `winner_token` / `user_token` are constrained to
  `mint == market.usdc_mint` and `owner == signer`.
- **Fee destination:** `fee_treasury_token.mint == usdc_mint` and
  `owner == market.fee_treasury` (`WrongFeeTreasury`).

## 4. Vault authority & fund isolation — 🟢

The vault's SPL authority is the **Market PDA** (`token::authority = market`).
Every outflow (`claim_winnings`, `claim_refund`, `withdraw_fees`) signs with the
market-authority seeds `["market", authority, fixture_id, market_type, bump]`.
No instruction lets any account other than the market PDA move vault funds, and a
transfer is only ever directed to a signer-owned or treasury-owned USDC account.

## 5. Arithmetic safety — 🟢

- All pool mutations use `checked_add` → `MathOverflow` (`place_bet`).
- Payout uses `u128` intermediates and floors (`math::payout`), so a `u64`×`u64`
  product cannot overflow.
- Fee = `floor(total_pool·bps/10_000)` via `u128` then `try_from` back to `u64`.
- The last-claimer remainder uses `checked_sub` (`MathUnderflow`).
- Overflow guard is integration-tested with near-`u64::MAX` stakes (Market F): a
  bet that would push the pool/vault past `u64::MAX` reverts with no state change.

## 6. State machine — 🟢 (exhaustive)

Legal edges only: `Open →(lock)→ Locked →(settle,pool>0)→ Settled`;
`Locked →(settle,pool==0 | cancel)→ Cancelled`. Enforced:

| Attempted illegal edge | Guard → error |
|------------------------|---------------|
| bet after lock | `status==Open` + `now<lock_time` → `MarketNotOpen`/`BettingClosed` |
| lock twice / lock non-Open | `status==Open` → `MarketNotOpen` |
| lock before time | `now>=lock_time` → `TooEarlyToLock` |
| settle before lock | `status==Locked` → `NotLocked` |
| settle twice / settle after cancel | terminal check → `AlreadyResolved` |
| cancel Open | `status==Locked` → `NotLocked` |
| cancel before timeout | `now>deadline` → `TooEarlyToCancel` |
| cancel Settled / cancel twice | terminal check → `AlreadyResolved` |
| claim winnings before settle / on cancelled | `status==Settled` → `NotSettled` |
| claim winnings by loser | `outcome==winning_outcome` → `NotAWinningPosition` |
| refund on non-cancelled | `status==Cancelled` → `NotCancelled` |
| withdraw fee on cancelled/unsettled | `status==Settled` → `NotSettled` |

Each edge is covered by an integration test (describes A, C, D, G).

## 7. Reentrancy / double-spend — 🟢

Solana has no synchronous re-entrancy into the same program mid-instruction, and
the token CPI cannot call back into `proofbook`. Regardless, each payout path is
**idempotent via a persisted flag set in the same instruction**:

- `claim_winnings` / `claim_refund`: `Position.claimed` gates entry and is set to
  `true` before the instruction returns; a repeat fails `AlreadyClaimed`.
- `withdraw_fees`: `Market.fee_withdrawn` gates entry and is set once;
  `FeesAlreadyWithdrawn` on repeat.

## 8. Solvency — 🟢 (proven + tested)

Let `D = distributable = total_pool − fee`, `W = total_winning_pool`,
`paid_out = Σ` of payouts so far. Winner payouts are `floor(stakeᵢ·D/W)` except
the final claimer, who receives `D − paid_out`.

- **Σ payouts = D exactly** (the last claimer absorbs the rounding dust), so
  `Σ payouts + fee = total_pool` and the vault settles to **exactly zero** after
  all winners claim and the fee is withdrawn.
- **Partial-claim solvency:** at any point the vault holds `total_pool − paid_out
  − fee_withdrawn`. Since `Σ(all winner payouts) = D`, the amount still owed is
  `D − paid_out`, and the vault always holds `≥ D − paid_out` (equality once the
  fee is out). Withdrawing exactly `fee` never dips below what remaining winners
  are owed. Proven in the unit test `last_claimer_remainder_is_exact_and_solvent`
  and exercised on-chain (Market E, and the last-claimer / vault-zero assertions).
- **Cancelled markets:** no fee is taken; `Σ refunds = Σ stakes = total_pool`, so
  the vault settles to zero (Markets C, D).

## 9. Rent / account close — 🟢

The program **closes no accounts** and returns no rent to arbitrary parties, so
there is no close-authority mis-routing risk. `Market`, `Position`, and the vault
persist after resolution (their rent was paid by their creators). A future
`close_position` could reclaim position rent to its owner after claim — out of
scope; not implementing it avoids a class of close-redirection bugs.

## 10. Accepted risks / notes — 🟡

- **Residual is zero in the happy path**, but if a winner never claims, its share
  (and any effect on the last-claimer detection) simply stays in the vault —
  legitimately unclaimed user funds, never lost to anyone else. `withdraw_fees`
  still succeeds (it only moves the fixed `fee`), so protocol fees are never
  locked by a non-claiming winner.
- **`fee_treasury` is set by the market creator.** Bettors should verify it before
  betting (it is in the `MarketInitialized` event and the `Market` account). It
  can only receive the fee, never user stakes.
- **Oracle trust** is delegated to TxLINE's `validate_stat` (by design). The
  program treats any CPI error or non-`true` return as "unverified" and refuses to
  settle, so an oracle failure degrades to "unsettleable → cancellable after
  timeout → refunds", never to a wrong settlement. Unconfirmed TxLINE internals
  are tracked in `docs/TXLINE_INTERFACE.md`.

---

## Test coverage of findings

`cargo test -p proofbook --lib` (10 unit tests) + the TypeScript integration suite
(`scripts/test-integration.sh`, describes A–G) exercise: mint rejection, vault
binding, every state-machine edge, pro-rata + dust + exact-zero solvency, refunds,
fee withdrawal + double-withdraw, zero-winning-pool, permissionless cancel by a
non-creator, and the overflow guard.
