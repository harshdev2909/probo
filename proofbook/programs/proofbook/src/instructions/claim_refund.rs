use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::ProofbookError;
use crate::events::RefundClaimed;
use crate::state::{Market, MarketStatus, Position};

/// On a Cancelled market, each user reclaims their EXACT original stake — no fee.
/// Idempotent per position (reuses `Position.claimed`); double-refund rejected.
#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(has_one = vault @ ProofbookError::WrongVault)]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key(),
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token.mint == market.usdc_mint @ ProofbookError::WrongMint,
        constraint = user_token.owner == user.key(),
    )]
    pub user_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Cancelled,
        ProofbookError::NotCancelled
    );
    require!(
        !ctx.accounts.position.claimed,
        ProofbookError::AlreadyClaimed
    );

    let amount = ctx.accounts.position.amount; // exact stake, no fee
    let outcome_index = ctx.accounts.position.outcome_index;

    // Sign the vault transfer as the market-authority PDA (the vault's authority).
    let market = &ctx.accounts.market;
    let fixture_le = market.fixture_id.to_le_bytes();
    let market_type = [market.market_type];
    let bump = [market.bump];
    let authority = market.authority;
    let seeds: [&[u8]; 5] = [
        MARKET_SEED,
        authority.as_ref(),
        &fixture_le,
        &market_type,
        &bump,
    ];
    let signer_seeds: &[&[&[u8]]] = &[&seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();
    let position = &mut ctx.accounts.position;
    position.claimed = true;

    emit!(RefundClaimed {
        market: market_key,
        user: user_key,
        outcome_index,
        amount,
    });

    Ok(())
}
