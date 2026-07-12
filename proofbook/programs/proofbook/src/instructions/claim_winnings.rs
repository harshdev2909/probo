use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::ProofbookError;
use crate::events::WinningsClaimed;
use crate::math;
use crate::state::{Market, MarketStatus, Position};

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,

    #[account(mut, has_one = vault @ ProofbookError::WrongVault)]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), winner.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == winner.key(),
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = winner_token.mint == market.usdc_mint @ ProofbookError::WrongMint,
        constraint = winner_token.owner == winner.key(),
    )]
    pub winner_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimWinnings>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(
        market.status == MarketStatus::Settled,
        ProofbookError::NotSettled
    );

    // Losing positions and double-claims are rejected (no vault mutation).
    require!(
        !ctx.accounts.position.claimed,
        ProofbookError::AlreadyClaimed
    );
    require!(
        ctx.accounts.position.outcome_index == market.winning_outcome,
        ProofbookError::NotAWinningPosition
    );
    require!(
        market.total_winning_pool > 0,
        ProofbookError::ZeroWinningPool
    );

    let stake = ctx.accounts.position.amount;
    let outcome_index = ctx.accounts.position.outcome_index;

    // Detect the final winning claim so it can absorb rounding dust, making
    // Σ(payouts) == distributable EXACTLY and the vault settle to zero.
    let new_claimed = market
        .winning_stake_claimed
        .checked_add(stake)
        .ok_or(ProofbookError::MathOverflow)?;
    let is_last_claimer = new_claimed == market.total_winning_pool;

    let distributable = math::distributable_pool(market.total_pool, market.fee_bps)?;
    let payout = if is_last_claimer {
        // Remainder = distributable - everything paid so far (>= this stake's floor).
        distributable
            .checked_sub(market.paid_out)
            .ok_or(ProofbookError::MathUnderflow)?
    } else {
        // payout = floor(stake * (total_pool - fee) / total_winning_pool) [u128]
        math::payout(
            stake,
            market.total_pool,
            market.total_winning_pool,
            market.fee_bps,
        )?
    };

    // Sign the vault transfer as the market-authority PDA (the vault's authority).
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
                to: ctx.accounts.winner_token.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        payout,
    )?;

    let market_key = ctx.accounts.market.key();
    let winner_key = ctx.accounts.winner.key();

    // Update solvency accounting, then mark the position claimed.
    let market = &mut ctx.accounts.market;
    market.paid_out = market
        .paid_out
        .checked_add(payout)
        .ok_or(ProofbookError::MathOverflow)?;
    market.winning_stake_claimed = new_claimed;

    let position = &mut ctx.accounts.position;
    position.claimed = true;

    emit!(WinningsClaimed {
        market: market_key,
        winner: winner_key,
        outcome_index,
        stake,
        payout,
        is_last_claimer,
    });

    Ok(())
}
