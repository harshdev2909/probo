//! # ProofBook
//!
//! A fully on-chain, **trustlessly-settled** FIFA World Cup prediction market.
//! User funds are USDC held in a per-market PDA vault. Outcomes are resolved by
//! CPI-ing into TxLINE's on-chain `validate_stat` program (behind the
//! `oracle_adapter` seam) — never by an admin key.
//!
//! Instructions: `initialize_market`, `place_bet`, `lock_market`,
//! `settle_market` (flagship), `claim_winnings`.
//!
//! See `README.md` for architecture and `docs/TXLINE_INTERFACE.md` for the
//! verified oracle interface.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

pub use constants::*;
pub use error::ProofbookError;
pub use instructions::*;
pub use oracle::{
    BinaryExpression, Comparison, GeometricTarget, NDimensionalStrategy, OracleAdapter, ProofNode,
    ScoreStat, ScoresBatchSummary, ScoresUpdateStats, SettlementProof, StatLeaf, StatPredicate,
    StatValidationInput, TraderPredicate,
};
pub use state::{Market, MarketStatus, OutcomeSpec, OutcomeState, Position};

declare_id!("4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63");

#[program]
pub mod proofbook {
    use super::*;

    /// Create a market PDA + USDC vault. Validates fee, outcome count, lock time,
    /// resolution timeout, and per-outcome resolution specs. Binds the market to
    /// the active oracle and records the fee treasury.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        fixture_id: i64,
        market_type: u8,
        outcome_options: Vec<OutcomeSpec>,
        fee_bps: u16,
        lock_time: i64,
        resolution_timeout: i64,
        fee_treasury: Pubkey,
    ) -> Result<()> {
        instructions::initialize_market::handler(
            ctx,
            fixture_id,
            market_type,
            outcome_options,
            fee_bps,
            lock_time,
            resolution_timeout,
            fee_treasury,
        )
    }

    /// Stake USDC on an outcome while the market is Open and before `lock_time`.
    pub fn place_bet(ctx: Context<PlaceBet>, outcome_index: u8, amount: u64) -> Result<()> {
        instructions::place_bet::handler(ctx, outcome_index, amount)
    }

    /// Open -> Locked, permissionlessly, at/after `lock_time`.
    pub fn lock_market(ctx: Context<LockMarket>) -> Result<()> {
        instructions::lock_market::handler(ctx)
    }

    /// Locked -> Settled iff the oracle adapter verifies the claimed outcome.
    pub fn settle_market(
        ctx: Context<SettleMarket>,
        claimed_outcome: u8,
        proof: SettlementProof,
    ) -> Result<()> {
        instructions::settle_market::handler(ctx, claimed_outcome, proof)
    }

    /// Pay a winner their pro-rata share of the (post-fee) pool. One-shot.
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        instructions::claim_winnings::handler(ctx)
    }

    /// Liveness escape hatch: Locked -> Cancelled once `now > lock_time +
    /// resolution_timeout`. Permissionless, time-triggered, sets no winner.
    pub fn cancel_market(ctx: Context<CancelMarket>) -> Result<()> {
        instructions::cancel_market::handler(ctx)
    }

    /// On a Cancelled market, reclaim the exact original stake (no fee). One-shot.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::claim_refund::handler(ctx)
    }

    /// Push the accrued protocol fee to the treasury. Settled markets only, once.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        instructions::withdraw_fees::handler(ctx)
    }
}
