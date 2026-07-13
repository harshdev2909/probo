use anchor_lang::prelude::*;

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub fixture_id: i64,
    pub market_type: u8,
    pub num_outcomes: u8,
    pub fee_bps: u16,
    pub lock_time: i64,
    pub resolution_timeout: i64,
    pub oracle_program: Pubkey,
    pub usdc_mint: Pubkey,
    pub fee_treasury: Pubkey,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub outcome_index: u8,
    pub amount: u64,
    pub position_total: u64,
    pub outcome_pool: u64,
    pub total_pool: u64,
}

#[event]
pub struct MarketLocked {
    pub market: Pubkey,
    pub locked_at: i64,
    pub total_pool: u64,
}

/// Emitted on trustless settlement — the full Proof Receipt data contract.
/// See `docs/ONCHAIN_INTERFACE.md` for how to reconstruct & verify a receipt.
#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub winning_outcome: u8,
    pub oracle_program: Pubkey,
    /// Which adapter verified the outcome ("txline" | "mock").
    pub oracle_label: String,
    /// The events-subtree root proven at settlement (proof-receipt anchor).
    pub proof_ref: [u8; 32],
    /// Batch timestamp (Unix ms) whose daily root was checked.
    pub proof_ts: i64,
    /// `floor(proof_ts / 86_400_000)` — the daily-root epoch day.
    pub epoch_day: u16,
    /// The oracle `daily_scores_merkle_roots` PDA verified against.
    pub daily_roots: Pubkey,
    /// The account that submitted the winning proof (no special power).
    pub resolver: Pubkey,
    /// The oracle CPI's `validate_stat` return value (always `true` on settle).
    pub oracle_verified: bool,
    /// True when the winning outcome had zero stake → market is refundable.
    pub refundable: bool,
    pub total_pool: u64,
    pub total_winning_pool: u64,
    pub fee_amount: u64,
    pub settled_at: i64,
}

/// Emitted when a stalled market is cancelled (liveness escape hatch).
#[event]
pub struct MarketCancelled {
    pub market: Pubkey,
    pub fixture_id: i64,
    /// "timeout" (never resolved) | "zero_winning_pool" (verified, none staked).
    pub reason: String,
    pub cancelled_at: i64,
    pub total_pool: u64,
    /// The account that triggered the cancel (no special power).
    pub canceller: Pubkey,
}

#[event]
pub struct WinningsClaimed {
    pub market: Pubkey,
    pub winner: Pubkey,
    pub outcome_index: u8,
    pub stake: u64,
    pub payout: u64,
    /// True when this claim was the final winning stake (absorbs rounding dust).
    pub is_last_claimer: bool,
}

#[event]
pub struct RefundClaimed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub outcome_index: u8,
    /// Exact original stake, returned with no fee.
    pub amount: u64,
}

#[event]
pub struct FeesWithdrawn {
    pub market: Pubkey,
    pub fee_treasury: Pubkey,
    pub amount: u64,
}

/// A compound (multi-leg) resolution spec was attached to a market. Emitted at
/// creation so an indexer can render the parlay's legs without reading the PDA.
#[event]
pub struct ComboSpecCreated {
    pub market: Pubkey,
    pub combo_spec: Pubkey,
    pub fixture_id: i64,
    pub market_type: u8,
    pub num_legs: u8,
    pub num_outcomes: u8,
}

/// A parametric prop vault was funded. The predicate is fixed from here.
#[event]
pub struct PropVaultCreated {
    pub prop_vault: Pubkey,
    pub depositor: Pubkey,
    pub beneficiary: Pubkey,
    pub fixture_id: i64,
    pub amount: u64,
    pub num_legs: u8,
    pub lock_time: i64,
}

/// The vault resolved. `predicate_held` decided where the money went — not a key.
#[event]
pub struct PropVaultResolved {
    pub prop_vault: Pubkey,
    pub fixture_id: i64,
    pub predicate_held: bool,
    pub paid_to: Pubkey,
    pub amount: u64,
    pub proof_ref: [u8; 32],
    pub proof_ts: i64,
    pub daily_roots: Pubkey,
    pub resolver: Pubkey,
    pub settled_at: i64,
}
