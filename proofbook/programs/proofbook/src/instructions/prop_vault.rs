use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::ProofbookError;
use crate::events::{PropVaultCreated, PropVaultResolved};
use crate::oracle::{build_and_verify_v3_legs, ActiveOracle, OracleAdapter, SettlementProofV3};
use crate::state::{LegPredicate, PropVault, StatLeg, VaultStatus};

/// # Parametric prop vault
///
/// A USDC vault that pays out automatically on a **verified compound predicate**
/// — "Team A corners + Team B corners > 10" — settled by a single
/// `validate_stat_v3` proof. Parametric insurance, with the parameter being a
/// merkle-proven fact rather than an adjuster's opinion.
///
/// It is the parlay machinery pointed at a different problem. Same legs, same
/// AND-of-predicates, same one-CPI settlement, same coverage invariant enforced
/// at creation. What differs is the shape of the money: not a parimutuel pool
/// with many bettors, but a single escrowed sum with two possible destinations.
///
/// * predicate HOLDS  -> the whole balance goes to the beneficiary
/// * predicate FAILS  -> the whole balance returns to the depositor
/// * nobody settles   -> after the timeout, anyone can refund the depositor
///
/// There is no admin key on any of those paths. `settle_prop_vault` is
/// permissionless: whoever holds a valid proof can trigger it, and the proof —
/// not the caller — decides where the money goes.

#[derive(Accounts)]
#[instruction(vault_id: u64, legs: Vec<StatLeg>, predicates: Vec<LegPredicate>)]
pub struct InitializePropVault<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        init,
        payer = depositor,
        space = PropVault::space(legs.len(), predicates.len()),
        seeds = [PROP_VAULT_SEED, depositor.key().as_ref(), &vault_id.to_le_bytes()],
        bump,
    )]
    pub prop_vault: Account<'info, PropVault>,

    pub usdc_mint: Account<'info, Mint>,

    /// Escrow, owned by the vault PDA. Not by us, and not by the beneficiary.
    #[account(
        init,
        payer = depositor,
        seeds = [VAULT_SEED, prop_vault.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = prop_vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_token.mint == usdc_mint.key() @ ProofbookError::WrongMint,
        constraint = depositor_token.owner == depositor.key() @ ProofbookError::WrongMint,
    )]
    pub depositor_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[allow(clippy::too_many_arguments)]
pub fn initialize_handler(
    ctx: Context<InitializePropVault>,
    vault_id: u64,
    legs: Vec<StatLeg>,
    predicates: Vec<LegPredicate>,
    fixture_id: i64,
    amount: u64,
    beneficiary: Pubkey,
    lock_time: i64,
    resolution_timeout: i64,
) -> Result<()> {
    require!(amount > 0, ProofbookError::ZeroAmount);
    require!(fixture_id > 0, ProofbookError::InvalidFixtureId);
    // A vault whose beneficiary IS the depositor can never settle: the settle
    // instruction takes beneficiary_token and depositor_token as two writable
    // accounts, and the runtime rejects the same account twice (found live —
    // ConstraintDuplicateMutableAccount, 2040). It could only ever time out into
    // a refund. Refuse to create what cannot settle.
    require!(
        beneficiary != ctx.accounts.depositor.key(),
        ProofbookError::SelfHedgeVault
    );
    require!(
        resolution_timeout > 0,
        ProofbookError::InvalidResolutionTimeout
    );
    let now = Clock::get()?.unix_timestamp;
    require!(lock_time > now, ProofbookError::LockTimeInPast);

    let v = &mut ctx.accounts.prop_vault;
    v.depositor = ctx.accounts.depositor.key();
    v.beneficiary = beneficiary;
    v.vault_id = vault_id;
    v.fixture_id = fixture_id;
    v.usdc_mint = ctx.accounts.usdc_mint.key();
    v.vault = ctx.accounts.vault.key();
    v.amount = amount;
    v.status = VaultStatus::Funded;
    v.legs = legs;
    v.predicates = predicates;
    v.lock_time = lock_time;
    v.resolution_timeout = resolution_timeout;
    v.oracle_program = ActiveOracle::program_id();
    v.bump = ctx.bumps.prop_vault;
    v.vault_bump = ctx.bumps.vault;

    // The same invariant the parlay grid lives by: every proven stat must be
    // evaluated exactly once, or TxLINE rejects the payload (6070 / 6071). Check
    // it now, while the vault is empty and can simply be rebuilt.
    v.validate()?;

    // Escrow the money. It leaves the depositor's control here and can only be
    // moved by the proof.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.depositor_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(PropVaultCreated {
        prop_vault: v.key(),
        depositor: v.depositor,
        beneficiary,
        fixture_id,
        amount,
        num_legs: v.legs.len() as u8,
        lock_time,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SettlePropVault<'info> {
    /// Permissionless. Whoever holds a valid proof may trigger this; they gain
    /// nothing by it. The PROOF decides where the money goes, not the caller.
    pub cranker: Signer<'info>,

    #[account(
        mut,
        has_one = oracle_program @ ProofbookError::WrongOracleProgram,
        has_one = vault @ ProofbookError::WrongVault,
    )]
    pub prop_vault: Account<'info, PropVault>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// Paid iff the predicate HOLDS.
    #[account(
        mut,
        constraint = beneficiary_token.owner == prop_vault.beneficiary @ ProofbookError::WrongBeneficiary,
        constraint = beneficiary_token.mint == prop_vault.usdc_mint @ ProofbookError::WrongMint,
    )]
    pub beneficiary_token: Account<'info, TokenAccount>,

    /// Refunded iff the predicate FAILS.
    #[account(
        mut,
        constraint = depositor_token.owner == prop_vault.depositor @ ProofbookError::WrongDepositor,
        constraint = depositor_token.mint == prop_vault.usdc_mint @ ProofbookError::WrongMint,
    )]
    pub depositor_token: Account<'info, TokenAccount>,

    /// CHECK: bound via `has_one`; must equal the active adapter's program id.
    pub oracle_program: UncheckedAccount<'info>,

    /// CHECK: verified inside the adapter to be TxLINE's daily-scores PDA.
    pub oracle_roots: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn settle_handler(
    ctx: Context<SettlePropVault>,
    proof: SettlementProofV3,
) -> Result<()> {
    {
        let v = &ctx.accounts.prop_vault;
        require!(
            v.status == VaultStatus::Funded,
            ProofbookError::AlreadyResolved
        );
        // The result is not knowable before the game ends; settling early could
        // only ever prove a partial state.
        let now = Clock::get()?.unix_timestamp;
        require!(now >= v.lock_time, ProofbookError::TooEarlyToLock);
    }

    require_keys_eq!(
        ctx.accounts.oracle_program.key(),
        ActiveOracle::program_id(),
        ProofbookError::OracleAdapterMismatch
    );

    let oracle_program_ai = ctx.accounts.oracle_program.to_account_info();
    let oracle_roots_ai = ctx.accounts.oracle_roots.to_account_info();

    // ── the whole product, in one call ────────────────────────────────────
    // The caller supplies proven values and merkle material. The stats and the
    // predicate come from the vault, fixed at creation. A caller cannot choose a
    // question that pays them.
    let v = &ctx.accounts.prop_vault;
    let holds = build_and_verify_v3_legs(
        &oracle_program_ai,
        &oracle_roots_ai,
        v.fixture_id,
        &v.legs,
        &v.predicates,
        &proof,
    )?;

    let amount = ctx.accounts.vault.amount;
    let destination = if holds {
        ctx.accounts.beneficiary_token.to_account_info()
    } else {
        ctx.accounts.depositor_token.to_account_info()
    };

    let vault_key = ctx.accounts.prop_vault.key();
    let depositor = ctx.accounts.prop_vault.depositor;
    let vault_id_le = ctx.accounts.prop_vault.vault_id.to_le_bytes();
    let bump = [ctx.accounts.prop_vault.bump];
    let seeds: [&[u8]; 4] = [
        PROP_VAULT_SEED,
        depositor.as_ref(),
        vault_id_le.as_ref(),
        bump.as_ref(),
    ];
    let signer: &[&[&[u8]]] = &[&seeds];

    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: destination,
                    authority: ctx.accounts.prop_vault.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let v = &mut ctx.accounts.prop_vault;
    v.status = if holds {
        VaultStatus::PaidOut
    } else {
        VaultStatus::Refunded
    };
    v.settled_at = now;
    v.settle_proof_ref = proof.fixture_summary.events_sub_tree_root;
    v.settle_proof_ts = proof.ts;
    v.settle_epoch_day = proof.ts.div_euclid(MS_PER_DAY) as u16;
    v.settle_daily_roots = ctx.accounts.oracle_roots.key();
    v.settle_resolver = ctx.accounts.cranker.key();

    emit!(PropVaultResolved {
        prop_vault: vault_key,
        fixture_id: v.fixture_id,
        predicate_held: holds,
        paid_to: if holds { v.beneficiary } else { v.depositor },
        amount,
        proof_ref: v.settle_proof_ref,
        proof_ts: proof.ts,
        daily_roots: v.settle_daily_roots,
        resolver: v.settle_resolver,
        settled_at: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelPropVault<'info> {
    /// Permissionless liveness backstop.
    pub canceller: Signer<'info>,

    #[account(mut, has_one = vault @ ProofbookError::WrongVault)]
    pub prop_vault: Account<'info, PropVault>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_token.owner == prop_vault.depositor @ ProofbookError::WrongDepositor,
        constraint = depositor_token.mint == prop_vault.usdc_mint @ ProofbookError::WrongMint,
    )]
    pub depositor_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// The liveness escape hatch.
///
/// If no proof ever arrives — TxLINE's retention window closes, the match is
/// abandoned, the world ends — the depositor's money must not be trapped. After
/// `lock_time + resolution_timeout`, ANYONE can return it.
///
/// Note this is the ONLY non-proof path, it is time-triggered rather than
/// discretionary, and it can only ever move the money BACK to where it came
/// from. There is no version of this that pays the beneficiary without a proof.
pub fn cancel_handler(ctx: Context<CancelPropVault>) -> Result<()> {
    let v = &ctx.accounts.prop_vault;
    require!(
        v.status == VaultStatus::Funded,
        ProofbookError::AlreadyResolved
    );
    let now = Clock::get()?.unix_timestamp;
    let deadline = v
        .lock_time
        .checked_add(v.resolution_timeout)
        .ok_or(ProofbookError::MathOverflow)?;
    require!(now > deadline, ProofbookError::TooEarlyToCancel);

    let amount = ctx.accounts.vault.amount;
    let depositor = v.depositor;
    let vault_id_le = v.vault_id.to_le_bytes();
    let bump = [v.bump];
    let seeds: [&[u8]; 4] = [
        PROP_VAULT_SEED,
        depositor.as_ref(),
        vault_id_le.as_ref(),
        bump.as_ref(),
    ];
    let signer: &[&[&[u8]]] = &[&seeds];

    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.depositor_token.to_account_info(),
                    authority: ctx.accounts.prop_vault.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
    }

    let vault_key = ctx.accounts.prop_vault.key();
    let v = &mut ctx.accounts.prop_vault;
    v.status = VaultStatus::Refunded;
    v.settled_at = now;

    emit!(PropVaultResolved {
        prop_vault: vault_key,
        fixture_id: v.fixture_id,
        predicate_held: false,
        paid_to: v.depositor,
        amount,
        proof_ref: [0u8; 32],
        proof_ts: 0,
        daily_roots: Pubkey::default(),
        resolver: ctx.accounts.canceller.key(),
        settled_at: now,
    });
    Ok(())
}
