use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ProofbookError;
use crate::oracle::{BinaryExpression, Comparison};

/// Lifecycle status of a market.
///
/// Legal transitions (enforced per-instruction):
///   Open ──lock_market──► Locked ──settle_market(winner pool > 0)──► Settled
///                              │
///                              ├─settle_market(winner pool == 0)──► Cancelled (refundable)
///                              └─cancel_market(after timeout)─────► Cancelled (refundable)
/// `Settled` and `Cancelled` are terminal: no re-settle, no settle-after-cancel,
/// no cancel-after-settle. Winners claim on `Settled`; everyone refunds on `Cancelled`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Open,
    Locked,
    Settled,
    Cancelled,
}

/// How a single outcome is resolved against TxLINE stats. Fixed at market
/// creation, so settlement can only ever prove the outcome it was configured
/// to prove (see `oracle::build_and_verify`).
///
/// Example — 1X2 on full-game goals (stat_a = P1 goals, stat_b = P2 goals):
///   Home win: op=Subtract, cmp=GreaterThan, threshold=0   (P1 - P2 > 0)
///   Away win: op=Subtract, cmp=LessThan,    threshold=0   (P1 - P2 < 0)
///   Draw    : op=Subtract, cmp=EqualTo,     threshold=0   (P1 - P2 == 0)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct OutcomeSpec {
    pub stat_a_key: u32,
    pub stat_a_period: i32,
    pub has_stat_b: bool,
    pub stat_b_key: u32,
    pub stat_b_period: i32,
    pub op: Option<BinaryExpression>,
    pub comparison: Comparison,
    pub threshold: i32,
}

impl OutcomeSpec {
    /// `op` must be present iff the outcome combines two stats.
    pub fn is_valid(&self) -> bool {
        self.has_stat_b == self.op.is_some()
    }
}

/// An outcome's resolution spec plus its running staked pool.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct OutcomeState {
    pub spec: OutcomeSpec,
    pub pool: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Creator (used only in the PDA seeds; has NO power over settlement).
    pub authority: Pubkey,
    /// TxLINE fixtureId == the on-chain match_id.
    pub fixture_id: i64,
    /// Opaque product-level market type tag (e.g. 0 = 1X2 match result).
    pub market_type: u8,
    pub status: MarketStatus,
    pub num_outcomes: u8,
    /// Winning outcome index after settlement; `UNSET_OUTCOME` until then.
    pub winning_outcome: u8,
    pub fee_bps: u16,
    /// Betting closes at/after this Unix-seconds time.
    pub lock_time: i64,
    /// Seconds after `lock_time` before `cancel_market` may be called (liveness
    /// escape hatch). `cancel` is legal only once `now > lock_time + timeout`.
    pub resolution_timeout: i64,
    /// Trusted oracle program (TxLINE or mock) — CPI target for settlement.
    pub oracle_program: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    /// Wallet that owns the fee destination token account (`withdraw_fees` target).
    pub fee_treasury: Pubkey,
    pub total_pool: u64,
    /// Snapshot of the winning outcome's pool at settlement (payout denominator).
    pub total_winning_pool: u64,
    /// Fee reserved out of the pool at settlement (0 on Cancelled markets).
    pub fee_amount: u64,
    /// Running sum of winner payouts already claimed (solvency + exact-remainder).
    pub paid_out: u64,
    /// Running sum of winning stake already claimed (detects the last claimer).
    pub winning_stake_claimed: u64,
    /// True once the protocol fee has been withdrawn to the treasury.
    pub fee_withdrawn: bool,
    // ── Proof Receipt (recorded at settlement) ───────────────────────────
    pub settled_at: i64,
    /// The events-subtree root proven at settlement.
    pub settle_proof_ref: [u8; 32],
    /// Batch timestamp (Unix ms) whose daily root was checked.
    pub settle_proof_ts: i64,
    /// `floor(settle_proof_ts / 86_400_000)` — the daily-root epoch day.
    pub settle_epoch_day: u16,
    /// The oracle's `daily_scores_merkle_roots` PDA that was verified against.
    pub settle_daily_roots: Pubkey,
    /// The account that submitted the winning proof (has no special power).
    pub settle_resolver: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    #[max_len(MAX_OUTCOMES)]
    pub outcomes: Vec<OutcomeState>,
}

impl Market {
    /// Size a market for the outcomes it ACTUALLY has.
    ///
    /// `InitSpace` reserves room for `MAX_OUTCOMES`, which a 2-outcome
    /// over/under market never uses — and with a market per fixture per type,
    /// that dead space is most of the rent bill. `num_outcomes` is fixed at init
    /// and the Vec never grows, so sizing to it is safe.
    ///
    /// Derived from `INIT_SPACE` rather than hand-counted, so it cannot drift
    /// when a field is added to `Market` or `OutcomeSpec`.
    pub fn space(num_outcomes: usize) -> usize {
        let unused = MAX_OUTCOMES.saturating_sub(num_outcomes);
        8 + Market::INIT_SPACE - unused * OutcomeState::INIT_SPACE
    }

    pub fn outcome_spec(&self, index: u8) -> Result<&OutcomeSpec> {
        self.outcomes
            .get(index as usize)
            .map(|o| &o.spec)
            .ok_or(error!(ProofbookError::InvalidOutcomeIndex))
    }

    /// The market-authority PDA signer seeds (for signing vault transfers).
    pub fn signer_seeds<'a>(
        authority: &'a [u8],
        fixture_id_le: &'a [u8],
        market_type: &'a [u8],
        bump: &'a [u8],
    ) -> [&'a [u8]; 5] {
        [MARKET_SEED, authority, fixture_id_le, market_type, bump]
    }
}

// ── Compound (multi-leg) markets ─────────────────────────────────────────────
//
// `OutcomeSpec` is hard-capped at two stats and ONE predicate, and it cannot be
// widened: it lives inside `Vec<OutcomeState>` inside `Market`, so changing its
// layout would shift every byte offset of the ~226 Market accounts already on
// devnet — including the settled ones that hold the Proof Receipts. Those are
// the product's only claim, so `Market` is frozen.
//
// Compound markets therefore keep a NORMAL `Market` (same pools, same betting,
// same claims, same audited parimutuel math) and put the richer resolution spec
// in this sidecar. Nothing about money changes; only how an outcome is proven.

/// One stat this market proves: a TxLINE `(key, period)` pair.
/// `key = period*1000 + base`, where base 1/2 = goals, 3/4 = yellows,
/// 5/6 = reds, 7/8 = corners. `period` is the ScoreStat period (100 = finalised).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct StatLeg {
    pub key: u32,
    pub period: i32,
}

/// A predicate over one leg, or over two legs combined with `op`.
/// Indices are into `ComboSpec.legs`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub enum LegPredicate {
    Single {
        index: u8,
        comparison: Comparison,
        threshold: i32,
    },
    Binary {
        index_a: u8,
        index_b: u8,
        op: BinaryExpression,
        comparison: Comparison,
        threshold: i32,
    },
}

impl LegPredicate {
    /// Mark the leg indices this predicate reads.
    pub(crate) fn mark(&self, seen: &mut [bool], n_legs: usize) -> Result<()> {
        let mut touch = |i: u8| -> Result<()> {
            let i = i as usize;
            require!(i < n_legs, ProofbookError::InvalidComboSpec);
            // TxLINE rejects a stat evaluated twice (DuplicateStatCoverage, 6070).
            require!(!seen[i], ProofbookError::DuplicateLegCoverage);
            seen[i] = true;
            Ok(())
        };
        match *self {
            LegPredicate::Single { index, .. } => touch(index),
            LegPredicate::Binary { index_a, index_b, .. } => {
                touch(index_a)?;
                touch(index_b)
            }
        }
    }
}

/// One outcome of a compound market: an AND of predicates over the market's legs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct ComboOutcome {
    #[max_len(MAX_LEGS)]
    pub predicates: Vec<LegPredicate>,
}

/// The compound resolution spec for a market, at PDA `["combo", market]`.
///
/// INVARIANT (enforced at init, so it cannot fail at settle time): every outcome
/// must reference EVERY leg EXACTLY ONCE. TxLINE validates the whole payload in
/// one shot and errors if any proven stat is evaluated twice
/// (`DuplicateStatCoverage`, 6070) or left unevaluated (`IncompleteStatCoverage`,
/// 6071) — both confirmed live against the devnet oracle. Checking it here turns
/// two settle-time failure modes into one create-time failure.
///
/// A direct consequence: a parlay's legs must read DISJOINT stats. "Home win AND
/// over 2.5 goals" is NOT expressible — both legs read goals P1/P2 — while
/// "Home win AND over 9.5 corners" is, because goals and corners are disjoint.
#[account]
#[derive(InitSpace)]
pub struct ComboSpec {
    /// The market this spec resolves. Checked against the passed market at settle.
    pub market: Pubkey,
    /// The stats proven for this market. Order defines the `LegPredicate` indices
    /// AND the order of `statKeys` in the proof request — they must agree.
    #[max_len(MAX_LEGS)]
    pub legs: Vec<StatLeg>,
    /// One entry per market outcome, in the same order as `Market.outcomes`.
    #[max_len(MAX_OUTCOMES)]
    pub outcomes: Vec<ComboOutcome>,
    pub bump: u8,
}

impl ComboSpec {
    /// Size the sidecar for the legs and outcomes it actually has. Same reason as
    /// `Market::space`: a 2-leg / 2-outcome over-under market should not pay rent
    /// for 5 legs and 12 outcomes.
    pub fn space(num_legs: usize, num_outcomes: usize) -> usize {
        let unused_legs = MAX_LEGS.saturating_sub(num_legs);
        let unused_outcomes = MAX_OUTCOMES.saturating_sub(num_outcomes);
        8 + ComboSpec::INIT_SPACE
            - unused_legs * StatLeg::INIT_SPACE
            - unused_outcomes * ComboOutcome::INIT_SPACE
    }

    /// Full structural validation. See the INVARIANT on the struct.
    pub fn validate(&self, num_outcomes: u8) -> Result<()> {
        require!(
            !self.legs.is_empty() && self.legs.len() <= MAX_LEGS,
            ProofbookError::InvalidComboSpec
        );
        require!(
            self.outcomes.len() == num_outcomes as usize,
            ProofbookError::InvalidComboSpec
        );
        for outcome in &self.outcomes {
            require!(
                !outcome.predicates.is_empty(),
                ProofbookError::InvalidComboSpec
            );
            let mut seen = [false; MAX_LEGS];
            for p in &outcome.predicates {
                p.mark(&mut seen, self.legs.len())?;
            }
            // Every leg must be covered — an uncovered leg is 6071 at settle time.
            for covered in seen.iter().take(self.legs.len()) {
                require!(*covered, ProofbookError::IncompleteLegCoverage);
            }
        }
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// The single outcome this position backs.
    pub outcome_index: u8,
    /// Total USDC staked by this owner on `outcome_index`.
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

// ── Parametric prop vault ────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum VaultStatus {
    /// Escrowed, awaiting a proof.
    Funded,
    /// The predicate HELD — the beneficiary was paid.
    PaidOut,
    /// The predicate FAILED, or the timeout fired — the depositor was refunded.
    Refunded,
}

/// A USDC vault that pays out automatically on a verified compound predicate.
///
/// "Team A corners + Team B corners > 10" — parametric insurance whose parameter
/// is a merkle-proven fact rather than an adjuster's opinion. Settled by a SINGLE
/// `validate_stat_v3` proof, permissionlessly.
///
/// The predicate is the same shape as a parlay's: an AND over legs, with the same
/// coverage invariant (every leg evaluated exactly once). It is fixed at creation
/// and validated there, so a vault that could never settle cannot be funded.
#[account]
#[derive(InitSpace)]
pub struct PropVault {
    pub depositor: Pubkey,
    /// Paid iff the predicate holds. May be the depositor (a self-hedge).
    pub beneficiary: Pubkey,
    /// Distinguishes several vaults from the same depositor (PDA seed).
    pub vault_id: u64,
    pub fixture_id: i64,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub status: VaultStatus,
    /// The stats proven. Order defines the predicate index space.
    #[max_len(MAX_LEGS)]
    pub legs: Vec<StatLeg>,
    /// AND-combined. Must cover every leg exactly once.
    #[max_len(MAX_LEGS)]
    pub predicates: Vec<LegPredicate>,
    /// The result is not knowable before this; settlement is refused earlier.
    pub lock_time: i64,
    /// After `lock_time + this`, anyone may refund the depositor.
    pub resolution_timeout: i64,
    pub oracle_program: Pubkey,
    // ── receipt ─────────────────────────────────────────────────────────
    pub settled_at: i64,
    pub settle_proof_ref: [u8; 32],
    pub settle_proof_ts: i64,
    pub settle_epoch_day: u16,
    pub settle_daily_roots: Pubkey,
    pub settle_resolver: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}

impl PropVault {
    pub fn space(num_legs: usize, num_preds: usize) -> usize {
        let unused_legs = MAX_LEGS.saturating_sub(num_legs);
        let unused_preds = MAX_LEGS.saturating_sub(num_preds);
        8 + PropVault::INIT_SPACE
            - unused_legs * StatLeg::INIT_SPACE
            - unused_preds * LegPredicate::INIT_SPACE
    }

    /// The same invariant a ComboSpec outcome lives by: every proven stat must be
    /// evaluated EXACTLY ONCE, or TxLINE rejects the payload (6070 / 6071).
    /// Checked at creation, while the vault is empty and can simply be rebuilt.
    pub fn validate(&self) -> Result<()> {
        require!(
            !self.legs.is_empty() && self.legs.len() <= MAX_LEGS,
            ProofbookError::InvalidComboSpec
        );
        require!(
            !self.predicates.is_empty() && self.predicates.len() <= MAX_LEGS,
            ProofbookError::InvalidComboSpec
        );
        let mut seen = [false; MAX_LEGS];
        for p in &self.predicates {
            p.mark(&mut seen, self.legs.len())?;
        }
        for covered in seen.iter().take(self.legs.len()) {
            require!(*covered, ProofbookError::IncompleteLegCoverage);
        }
        Ok(())
    }
}
