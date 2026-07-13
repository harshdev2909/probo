use anchor_lang::prelude::*;

use crate::constants::{COMBO_MARKET_TYPE_MIN, COMBO_SEED};
use crate::error::ProofbookError;
use crate::events::ComboSpecCreated;
use crate::state::{ComboOutcome, ComboSpec, Market, MarketStatus, StatLeg};

/// Attach a compound (multi-leg) resolution spec to a market.
///
/// The market itself is an ordinary `Market` — same vault, same pools, same
/// parimutuel math. Only the way an outcome is PROVEN differs: instead of the
/// single 1-2 stat predicate in `Market.outcomes[i].spec`, a compound market
/// resolves through this sidecar, which can express an AND of predicates over up
/// to `MAX_LEGS` stats and settles in ONE `validate_stat_v3` CPI.
///
/// Must be called while the market is still Open — a locked market's resolution
/// rules are already relied on by everyone who has staked it.
#[derive(Accounts)]
#[instruction(legs: Vec<StatLeg>, outcomes: Vec<ComboOutcome>)]
pub struct InitializeComboSpec<'info> {
    /// The market's creator. Has no power over settlement — only over which
    /// predicate the market was BORN with, which is exactly what this sets.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        constraint = market.authority == authority.key() @ ProofbookError::WrongComboSpec,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        space = ComboSpec::space(legs.len(), outcomes.len()),
        seeds = [COMBO_SEED, market.key().as_ref()],
        bump,
    )]
    pub combo_spec: Account<'info, ComboSpec>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeComboSpec>,
    legs: Vec<StatLeg>,
    outcomes: Vec<ComboOutcome>,
) -> Result<()> {
    let market = &ctx.accounts.market;

    // Only compound market types resolve through a sidecar. Attaching one to a
    // legacy 1X2 market would create two competing sources of truth for how it
    // settles, and `settle_market` would keep using the other one.
    require!(
        market.market_type >= COMBO_MARKET_TYPE_MIN,
        ProofbookError::NotAComboMarket
    );
    // The rules cannot change under people who have already staked.
    require!(
        market.status == MarketStatus::Open,
        ProofbookError::MarketNotOpen
    );

    let spec = &mut ctx.accounts.combo_spec;
    spec.market = market.key();
    spec.legs = legs;
    spec.outcomes = outcomes;
    spec.bump = ctx.bumps.combo_spec;

    // The invariant that makes settlement structurally safe: every outcome must
    // cover every leg exactly once. TxLINE rejects a payload whose stats are
    // double-evaluated (6070) or left unevaluated (6071); enforcing it here turns
    // two settle-time failures into one create-time failure, when the market has
    // no money in it and can simply be rebuilt.
    spec.validate(market.num_outcomes)?;

    emit!(ComboSpecCreated {
        market: market.key(),
        combo_spec: spec.key(),
        fixture_id: market.fixture_id,
        market_type: market.market_type,
        num_legs: spec.legs.len() as u8,
        num_outcomes: spec.outcomes.len() as u8,
    });

    Ok(())
}
