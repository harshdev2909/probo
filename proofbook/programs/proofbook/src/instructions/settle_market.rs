use anchor_lang::prelude::*;

use crate::constants::MS_PER_DAY;
use crate::error::ProofbookError;
use crate::events::{MarketCancelled, MarketSettled};
use crate::math;
use crate::oracle::{ActiveOracle, OracleAdapter, SettlementProof};
use crate::state::{Market, MarketStatus};

/// THE flagship instruction. Locked -> Settled **only if** the oracle adapter
/// verifies the claimed outcome (real: CPI into TxLINE `validate_stat`; test:
/// CPI into the mock). There is NO admin override. It is one-shot / idempotent:
/// a settled market can never be re-settled.
#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Permissionless settler (pays fees; has no special authority).
    pub cranker: Signer<'info>,

    #[account(mut, has_one = oracle_program @ ProofbookError::WrongOracleProgram)]
    pub market: Account<'info, Market>,

    /// CHECK: bound to `market.oracle_program` via `has_one`, and required to
    /// equal the active adapter's program id. It is the `validate_stat` CPI target.
    pub oracle_program: UncheckedAccount<'info>,

    /// CHECK: verified inside the adapter to be the TxLINE daily-scores PDA
    /// derived from `oracle_program` and `proof.ts`. Read-only in the CPI.
    pub oracle_roots: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<SettleMarket>,
    claimed_outcome: u8,
    proof: SettlementProof,
) -> Result<()> {
    // ── State gate: must be Locked; terminal states are never re-resolved. ─
    match ctx.accounts.market.status {
        MarketStatus::Locked => {}
        MarketStatus::Settled | MarketStatus::Cancelled => {
            return err!(ProofbookError::AlreadyResolved)
        }
        MarketStatus::Open => return err!(ProofbookError::NotLocked),
    }
    require!(
        (claimed_outcome as usize) < ctx.accounts.market.outcomes.len(),
        ProofbookError::InvalidOutcomeIndex
    );

    // The trusted oracle must be exactly the active adapter's program.
    require_keys_eq!(
        ctx.accounts.oracle_program.key(),
        ActiveOracle::program_id(),
        ProofbookError::OracleAdapterMismatch
    );

    let oracle_program_ai = ctx.accounts.oracle_program.to_account_info();
    let oracle_roots_ai = ctx.accounts.oracle_roots.to_account_info();

    // ── Trustless verification via CPI. No admin path. ───────────────────
    let verified = ActiveOracle::verify_outcome(
        &oracle_program_ai,
        &oracle_roots_ai,
        &ctx.accounts.market,
        claimed_outcome,
        &proof,
    )?;
    require!(verified, ProofbookError::OutcomeNotVerified);

    // ── Record the Proof Receipt (see docs/ONCHAIN_INTERFACE.md). ────────
    let now = Clock::get()?.unix_timestamp;
    let epoch_day = proof.ts.div_euclid(MS_PER_DAY) as u16;
    let daily_roots = ctx.accounts.oracle_roots.key();
    let resolver = ctx.accounts.cranker.key();

    let market = &mut ctx.accounts.market;
    market.winning_outcome = claimed_outcome;
    market.settled_at = now;
    market.settle_proof_ref = proof.fixture_summary.events_sub_tree_root;
    market.settle_proof_ts = proof.ts;
    market.settle_epoch_day = epoch_day;
    market.settle_daily_roots = daily_roots;
    market.settle_resolver = resolver;

    // Zero-winning-pool policy: the outcome is proven, but nobody staked it, so
    // there is nothing to distribute. The market becomes REFUNDABLE (no fee) via
    // the same Cancelled refund path — never leaving user funds stuck.
    let winning_pool = market.outcomes[claimed_outcome as usize].pool;
    let refundable = winning_pool == 0;

    if refundable {
        market.status = MarketStatus::Cancelled;
        market.total_winning_pool = 0;
        market.fee_amount = 0;
    } else {
        market.status = MarketStatus::Settled;
        market.total_winning_pool = winning_pool;
        market.fee_amount = math::fee_amount(market.total_pool, market.fee_bps)?;
    }

    emit!(MarketSettled {
        market: market.key(),
        fixture_id: market.fixture_id,
        winning_outcome: claimed_outcome,
        oracle_program: market.oracle_program,
        oracle_label: ActiveOracle::LABEL.to_string(),
        proof_ref: market.settle_proof_ref,
        proof_ts: proof.ts,
        epoch_day,
        daily_roots,
        resolver,
        oracle_verified: verified,
        refundable,
        total_pool: market.total_pool,
        total_winning_pool: market.total_winning_pool,
        fee_amount: market.fee_amount,
        settled_at: now,
    });

    if refundable {
        emit!(MarketCancelled {
            market: market.key(),
            fixture_id: market.fixture_id,
            reason: "zero_winning_pool".to_string(),
            cancelled_at: now,
            total_pool: market.total_pool,
            canceller: resolver,
        });
    }

    Ok(())
}
