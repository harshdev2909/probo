use anchor_lang::prelude::*;

use crate::constants::{COMBO_MARKET_TYPE_MIN, COMBO_SEED};
use crate::error::ProofbookError;
use crate::instructions::settle_market::record_settlement;
use crate::oracle::{build_and_verify_v3, ActiveOracle, OracleAdapter, SettlementProofV3};
use crate::state::{ComboSpec, Market, MarketStatus};

/// Settle a COMPOUND market: every leg of the predicate proven in ONE
/// `validate_stat_v3` CPI, against a single shared Merkle multiproof.
///
/// This is the multi-leg parlay path. "Home win AND over 9.5 corners" is four
/// stats (goals P1/P2, corners P1/P2) authenticated together — v2 would need one
/// full sibling path per stat; v3 needs one multiproof for all of them.
///
/// The trustless binding is identical to v2's, and if anything tighter: the
/// caller supplies proven VALUES and Merkle material, but the stats those values
/// belong to, and the predicate applied to them, both come from the market's
/// `ComboSpec` — which was fixed and structurally validated at creation.
#[derive(Accounts)]
pub struct SettleMarketV3<'info> {
    /// Permissionless settler (pays fees; has no special authority).
    pub cranker: Signer<'info>,

    #[account(mut, has_one = oracle_program @ ProofbookError::WrongOracleProgram)]
    pub market: Account<'info, Market>,

    /// The compound predicate. Bound to this market by PDA seeds AND by the
    /// stored `market` field — a spec from another market cannot be substituted.
    #[account(
        seeds = [COMBO_SEED, market.key().as_ref()],
        bump = combo_spec.bump,
        constraint = combo_spec.market == market.key() @ ProofbookError::WrongComboSpec,
    )]
    pub combo_spec: Account<'info, ComboSpec>,

    /// CHECK: bound to `market.oracle_program` via `has_one`, and required to
    /// equal the active adapter's program id. It is the `validate_stat_v3` target.
    pub oracle_program: UncheckedAccount<'info>,

    /// CHECK: verified inside the adapter to be the TxLINE daily-scores PDA
    /// derived from `oracle_program` and `proof.ts`. Read-only in the CPI.
    pub oracle_roots: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<SettleMarketV3>,
    claimed_outcome: u8,
    proof: SettlementProofV3,
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
    // Legacy 1X2 markets have no sidecar and must keep settling through v2, so
    // that this path can never become a second way to resolve them.
    require!(
        ctx.accounts.market.market_type >= COMBO_MARKET_TYPE_MIN,
        ProofbookError::NotAComboMarket
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
    let verified = build_and_verify_v3(
        &oracle_program_ai,
        &oracle_roots_ai,
        &ctx.accounts.market,
        &ctx.accounts.combo_spec,
        claimed_outcome,
        &proof,
    )?;
    require!(verified, ProofbookError::OutcomeNotVerified);

    // Identical receipt + payout path as v2 — one implementation, not two.
    record_settlement(
        ctx.accounts.market.key(),
        &mut ctx.accounts.market,
        claimed_outcome,
        proof.ts,
        proof.fixture_summary.events_sub_tree_root,
        ctx.accounts.oracle_roots.key(),
        ctx.accounts.cranker.key(),
        verified,
    )
}
