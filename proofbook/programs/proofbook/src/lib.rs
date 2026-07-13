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
    ScoreStat, ScoresBatchSummary, ScoresUpdateStats, SettlementProof, SettlementProofV3, StatLeaf,
    StatPredicate, StatValidationInput, StatValidationInputV3, TraderPredicate,
};
pub use state::{
    ComboOutcome, ComboSpec, LegPredicate, Market, MarketStatus, OutcomeSpec, OutcomeState,
    Position, PropVault, StatLeg, VaultStatus,
};

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

    /// Attach a compound (multi-leg) resolution spec to a market, so it can be
    /// settled by proving several stats in ONE `validate_stat_v3` CPI.
    /// Open markets only; the spec is structurally validated on the way in.
    pub fn initialize_combo_spec(
        ctx: Context<InitializeComboSpec>,
        legs: Vec<StatLeg>,
        outcomes: Vec<ComboOutcome>,
    ) -> Result<()> {
        instructions::initialize_combo_spec::handler(ctx, legs, outcomes)
    }

    /// Locked -> Settled for a COMPOUND market: every leg proven together against
    /// one shared Merkle multiproof, in a single `validate_stat_v3` CPI.
    pub fn settle_market_v3(
        ctx: Context<SettleMarketV3>,
        claimed_outcome: u8,
        proof: SettlementProofV3,
    ) -> Result<()> {
        instructions::settle_market_v3::handler(ctx, claimed_outcome, proof)
    }

    // ── Parametric prop vault ────────────────────────────────────────────
    // A USDC vault that pays out automatically on a verified compound predicate,
    // settled by a single validate_stat_v3 proof. The parlay machinery, pointed
    // at parametric insurance instead of a pool.

    /// Escrow USDC against a compound predicate. The predicate is fixed here and
    /// structurally validated, so a vault that could never settle cannot be funded.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_prop_vault(
        ctx: Context<InitializePropVault>,
        vault_id: u64,
        legs: Vec<StatLeg>,
        predicates: Vec<LegPredicate>,
        fixture_id: i64,
        amount: u64,
        beneficiary: Pubkey,
        lock_time: i64,
        resolution_timeout: i64,
    ) -> Result<()> {
        instructions::prop_vault::initialize_handler(
            ctx,
            vault_id,
            legs,
            predicates,
            fixture_id,
            amount,
            beneficiary,
            lock_time,
            resolution_timeout,
        )
    }

    /// Permissionless. The PROOF decides where the money goes: predicate holds ->
    /// beneficiary, predicate fails -> depositor. No admin key on either path.
    pub fn settle_prop_vault(
        ctx: Context<SettlePropVault>,
        proof: SettlementProofV3,
    ) -> Result<()> {
        instructions::prop_vault::settle_handler(ctx, proof)
    }

    /// Liveness backstop: after the timeout, anyone may return the money to the
    /// depositor. The only non-proof path, and it can never pay the beneficiary.
    pub fn cancel_prop_vault(ctx: Context<CancelPropVault>) -> Result<()> {
        instructions::prop_vault::cancel_handler(ctx)
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
