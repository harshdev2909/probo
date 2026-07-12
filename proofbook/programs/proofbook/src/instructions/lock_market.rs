use anchor_lang::prelude::*;

use crate::error::ProofbookError;
use crate::events::MarketLocked;
use crate::state::{Market, MarketStatus};

#[derive(Accounts)]
pub struct LockMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// Permissionless crank — any signer may lock once `lock_time` has passed.
    pub cranker: Signer<'info>,
}

pub fn handler(ctx: Context<LockMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        ProofbookError::MarketNotOpen
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now >= market.lock_time, ProofbookError::TooEarlyToLock);

    market.status = MarketStatus::Locked;

    emit!(MarketLocked {
        market: market.key(),
        locked_at: now,
        total_pool: market.total_pool,
    });

    Ok(())
}
