use anchor_lang::prelude::*;

use crate::error::ProofbookError;
use crate::events::MarketCancelled;
use crate::state::{Market, MarketStatus};

/// Liveness escape hatch. If a match is abandoned/postponed or TxLINE never
/// publishes a resolvable proof, `settle_market` can never succeed and user USDC
/// would be stuck. `cancel_market` is **permissionless** and **purely
/// time-triggered** — any signer may call it once `now > lock_time +
/// resolution_timeout`. It NEVER sets a winner; it only flips the market to
/// Cancelled so `claim_refund` unlocks exact-stake refunds. Trustlessness is
/// intact: there is no outcome decision here, only a clock check.
#[derive(Accounts)]
pub struct CancelMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// Any signer (has no special power; pays the tx fee).
    pub canceller: Signer<'info>,
}

pub fn handler(ctx: Context<CancelMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;

    match market.status {
        MarketStatus::Locked => {}
        MarketStatus::Open => return err!(ProofbookError::NotLocked),
        MarketStatus::Settled | MarketStatus::Cancelled => {
            return err!(ProofbookError::AlreadyResolved)
        }
    }

    let deadline = market
        .lock_time
        .checked_add(market.resolution_timeout)
        .ok_or(ProofbookError::MathOverflow)?;
    require!(now > deadline, ProofbookError::TooEarlyToCancel);

    market.status = MarketStatus::Cancelled;
    // winning_outcome intentionally stays UNSET — no outcome is decided here.

    emit!(MarketCancelled {
        market: market.key(),
        fixture_id: market.fixture_id,
        reason: "timeout".to_string(),
        cancelled_at: now,
        total_pool: market.total_pool,
        canceller: ctx.accounts.canceller.key(),
    });

    Ok(())
}
