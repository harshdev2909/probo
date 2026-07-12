use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::ProofbookError;
use crate::events::FeesWithdrawn;
use crate::state::{Market, MarketStatus};

/// Sends the accrued protocol fee from the vault to the market's `fee_treasury`.
/// Only after `Settled`, only once. Cancelled markets take NO fee (full refunds),
/// so this instruction rejects them.
///
/// Solvency: withdrawing exactly `fee_amount` leaves `distributable - paid_out`
/// in the vault, which is always ≥ what the remaining winners are owed (the sum
/// of all winner payouts can never exceed `distributable`). Permissionless push.
#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    /// Any signer may push fees to the treasury (has no special power).
    pub caller: Signer<'info>,

    #[account(
        mut,
        has_one = vault @ ProofbookError::WrongVault,
        has_one = fee_treasury @ ProofbookError::WrongFeeTreasury,
    )]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: matched to `market.fee_treasury` via `has_one`; only used as the
    /// wallet that must own the destination token account.
    pub fee_treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = fee_treasury_token.mint == market.usdc_mint @ ProofbookError::WrongMint,
        constraint = fee_treasury_token.owner == fee_treasury.key() @ ProofbookError::WrongFeeTreasury,
    )]
    pub fee_treasury_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawFees>) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Settled,
        ProofbookError::NotSettled
    );
    require!(
        !ctx.accounts.market.fee_withdrawn,
        ProofbookError::FeesAlreadyWithdrawn
    );

    let fee = ctx.accounts.market.fee_amount;
    require!(fee > 0, ProofbookError::NothingToWithdraw);

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
                to: ctx.accounts.fee_treasury_token.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        fee,
    )?;

    let market_key = ctx.accounts.market.key();
    let treasury = ctx.accounts.fee_treasury.key();
    let market = &mut ctx.accounts.market;
    market.fee_withdrawn = true;

    emit!(FeesWithdrawn {
        market: market_key,
        fee_treasury: treasury,
        amount: fee,
    });

    Ok(())
}
