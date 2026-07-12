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
    pub fn space(_num_outcomes: usize) -> usize {
        // Allocate for MAX_OUTCOMES (deterministic); `InitSpace` sizes the Vec.
        8 + Market::INIT_SPACE
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
