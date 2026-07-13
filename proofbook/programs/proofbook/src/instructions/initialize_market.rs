use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::ProofbookError;
use crate::events::MarketInitialized;
use crate::oracle::{ActiveOracle, OracleAdapter};
use crate::state::{Market, MarketStatus, OutcomeSpec, OutcomeState};

#[derive(Accounts)]
#[instruction(fixture_id: i64, market_type: u8, outcome_options: Vec<OutcomeSpec>)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Market::space(outcome_options.len()),
        seeds = [MARKET_SEED, authority.key().as_ref(), &fixture_id.to_le_bytes(), &[market_type]],
        bump,
    )]
    pub market: Account<'info, Market>,

    pub usdc_mint: Account<'info, Mint>,

    /// USDC escrow vault owned by the market PDA.
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeMarket>,
    fixture_id: i64,
    market_type: u8,
    outcome_options: Vec<OutcomeSpec>,
    fee_bps: u16,
    lock_time: i64,
    resolution_timeout: i64,
    fee_treasury: Pubkey,
) -> Result<()> {
    require!(fixture_id > 0, ProofbookError::InvalidFixtureId);
    require!(fee_bps <= MAX_FEE_BPS, ProofbookError::FeeTooHigh);
    require!(
        resolution_timeout > 0,
        ProofbookError::InvalidResolutionTimeout
    );

    let n = outcome_options.len();
    require!(
        (MIN_OUTCOMES..=MAX_OUTCOMES).contains(&n),
        ProofbookError::InvalidOutcomeCount
    );

    let now = Clock::get()?.unix_timestamp;
    require!(lock_time > now, ProofbookError::LockTimeInPast);

    for spec in &outcome_options {
        require!(spec.is_valid(), ProofbookError::InvalidOutcomeSpec);
    }

    let market = &mut ctx.accounts.market;
    market.authority = ctx.accounts.authority.key();
    market.fixture_id = fixture_id;
    market.market_type = market_type;
    market.status = MarketStatus::Open;
    market.num_outcomes = n as u8;
    market.winning_outcome = UNSET_OUTCOME;
    market.fee_bps = fee_bps;
    market.lock_time = lock_time;
    market.resolution_timeout = resolution_timeout;
    market.oracle_program = ActiveOracle::program_id();
    market.usdc_mint = ctx.accounts.usdc_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.fee_treasury = fee_treasury;
    market.total_pool = 0;
    market.total_winning_pool = 0;
    market.fee_amount = 0;
    market.paid_out = 0;
    market.winning_stake_claimed = 0;
    market.fee_withdrawn = false;
    market.settled_at = 0;
    market.settle_proof_ref = [0u8; 32];
    market.settle_proof_ts = 0;
    market.settle_epoch_day = 0;
    market.settle_daily_roots = Pubkey::default();
    market.settle_resolver = Pubkey::default();
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.vault;
    market.outcomes = outcome_options
        .into_iter()
        .map(|spec| OutcomeState { spec, pool: 0 })
        .collect();

    emit!(MarketInitialized {
        market: market.key(),
        authority: market.authority,
        fixture_id,
        market_type,
        num_outcomes: market.num_outcomes,
        fee_bps,
        lock_time,
        resolution_timeout,
        oracle_program: market.oracle_program,
        usdc_mint: market.usdc_mint,
        fee_treasury,
    });

    Ok(())
}
