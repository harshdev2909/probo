use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::ProofbookError;
use crate::events::BetPlaced;
use crate::state::{Market, MarketStatus, Position};

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(mut, has_one = vault @ ProofbookError::WrongVault)]
    pub market: Account<'info, Market>,

    /// One position per (market, bettor); backs a single outcome.
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        constraint = bettor_token.mint == market.usdc_mint @ ProofbookError::WrongMint,
        constraint = bettor_token.owner == bettor.key(),
    )]
    pub bettor_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceBet>, outcome_index: u8, amount: u64) -> Result<()> {
    require!(amount > 0, ProofbookError::ZeroAmount);

    let market = &mut ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        ProofbookError::MarketNotOpen
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now < market.lock_time, ProofbookError::BettingClosed);
    require!(
        (outcome_index as usize) < market.outcomes.len(),
        ProofbookError::InvalidOutcomeIndex
    );

    let market_key = market.key();
    let position = &mut ctx.accounts.position;
    if position.market == Pubkey::default() {
        // Freshly created position.
        position.market = market_key;
        position.owner = ctx.accounts.bettor.key();
        position.outcome_index = outcome_index;
        position.claimed = false;
        position.bump = ctx.bumps.position;
    } else {
        require!(
            position.outcome_index == outcome_index,
            ProofbookError::CannotSwitchOutcome
        );
    }

    // Move USDC from the bettor into the market vault.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.bettor_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.bettor.to_account_info(),
            },
        ),
        amount,
    )?;

    position.amount = position
        .amount
        .checked_add(amount)
        .ok_or(ProofbookError::MathOverflow)?;
    let position_total = position.amount;

    {
        let outcome = &mut market.outcomes[outcome_index as usize];
        outcome.pool = outcome
            .pool
            .checked_add(amount)
            .ok_or(ProofbookError::MathOverflow)?;
    }
    market.total_pool = market
        .total_pool
        .checked_add(amount)
        .ok_or(ProofbookError::MathOverflow)?;

    emit!(BetPlaced {
        market: market_key,
        bettor: ctx.accounts.bettor.key(),
        outcome_index,
        amount,
        position_total,
        outcome_pool: market.outcomes[outcome_index as usize].pool,
        total_pool: market.total_pool,
    });

    Ok(())
}
