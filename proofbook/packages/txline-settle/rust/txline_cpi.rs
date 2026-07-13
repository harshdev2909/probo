//! # txline_cpi — CPI `validate_stat_v3` from any Anchor program
//!
//! Drop this module into your program. It is self-contained: the wire types are
//! byte-identical to TxLINE's IDL (txoracle v1.5.6), and `invoke_validate_stat_v3`
//! builds the instruction and decodes the `bool` the oracle returns.
//!
//! ```ignore
//! let verified = txline_cpi::invoke_validate_stat_v3(
//!     &ctx.accounts.oracle_program,   // 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J
//!     &ctx.accounts.oracle_roots,     // ["daily_scores_roots", u16_le(epoch_day)]
//!     payload,
//!     strategy,
//! )?;
//! require!(verified, MyError::OutcomeNotVerified);
//! ```
//!
//! ## The one design rule that matters
//!
//! **Take the VALUES from the caller. Take the PREDICATE from your own account.**
//!
//! The caller supplies proven values and merkle material. The stat keys, periods,
//! comparisons and thresholds must come from state your program fixed when the
//! market was created. Otherwise a settler simply submits the predicate that suits
//! them, and the "proof" proves whatever they wanted. That binding is the entire
//! security property; the merkle proof only ensures the values are real.
//!
//! ## Coverage (this WILL bite you)
//!
//! Every stat in `payload.leaves` must be referenced EXACTLY ONCE across
//! `strategy.discrete_predicates` / `geometric_targets`:
//!
//!   * a stat evaluated twice  -> `DuplicateStatCoverage`  (6070)
//!   * a stat left unevaluated -> `IncompleteStatCoverage` (6071)
//!
//! Consequence: a compound predicate's legs must read DISJOINT stats.
//! "home win AND over 2.5 goals" both read goals P1/P2 — it is NOT expressible.
//! "home win AND over 9.5 corners" (goals + corners) is fine.
//!
//! Validate that when the market is CREATED, not when it settles: then 6070/6071
//! become impossible at settle time, and a market that could never pay out can
//! never be minted.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
};

/// `sha256("global:validate_stat_v3")[..8]`
pub const VALIDATE_STAT_V3_DISCRIMINATOR: [u8; 8] = [150, 37, 155, 89, 141, 190, 77, 203];

pub const DAILY_SCORES_SEED: &[u8] = b"daily_scores_roots";
pub const MS_PER_DAY: i64 = 86_400_000;

/// TxLINE txoracle — devnet.
pub const TXORACLE_DEVNET: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
/// TxLINE txoracle — mainnet-beta.
pub const TXORACLE_MAINNET: Pubkey = pubkey!("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA");

// ── wire types — byte-identical to txoracle IDL v1.5.6 ──────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoreStat {
    /// `key = period*1000 + base`. Base: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners.
    pub key: u32,
    pub value: i32,
    /// The ScoreStat period. 100 = game_finalised (by ANY method).
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatLeaf {
    pub stat: ScoreStat,
    /// EMPTY in v3 — the shared multiproof supersedes the per-leaf paths.
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

/// `validate_stat_v3` arg 1. One shared Merkle multiproof over all the leaves.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatValidationInputV3 {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    pub leaves: Vec<StatLeaf>,
    pub multiproof_hashes: Vec<ProofNode>,
    pub leaf_indices: Vec<u32>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GeometricTarget {
    pub stat_index: u8,
    pub prediction: i32,
}

/// Predicates reference stats BY INDEX into `StatValidationInputV3.leaves`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum StatPredicate {
    Single {
        index: u8,
        predicate: TraderPredicate,
    },
    Binary {
        index_a: u8,
        index_b: u8,
        op: BinaryExpression,
        predicate: TraderPredicate,
    },
}

/// `validate_stat_v3` arg 2. Discrete predicates are AND-combined.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct NDimensionalStrategy {
    pub geometric_targets: Vec<GeometricTarget>,
    /// Required iff `geometric_targets` is non-empty (else err 6072).
    pub distance_predicate: Option<TraderPredicate>,
    pub discrete_predicates: Vec<StatPredicate>,
}

// ── the CPI ─────────────────────────────────────────────────────────────────

/// TxLINE's daily-roots PDA for a proof timestamp (Unix **milliseconds**).
///
/// Derived from the PROOF's timestamp, never the wall clock. Passing the wrong
/// day is the most common source of an opaque failure.
pub fn daily_scores_pda(oracle_program: &Pubkey, ts_ms: i64) -> (Pubkey, u8) {
    let epoch_day = ts_ms.div_euclid(MS_PER_DAY) as u16;
    Pubkey::find_program_address(&[DAILY_SCORES_SEED, &epoch_day.to_le_bytes()], oracle_program)
}

/// CPI `validate_stat_v3` and decode the `bool` it returns via return data.
///
/// Returns `Ok(false)` when the proof is VALID but the predicate does not hold —
/// that is a legitimate "this outcome did not happen", not an error. A malformed
/// or forged proof errors instead.
pub fn invoke_validate_stat_v3<'info>(
    oracle_program: &AccountInfo<'info>,
    daily_scores_roots: &AccountInfo<'info>,
    payload: StatValidationInputV3,
    strategy: NDimensionalStrategy,
) -> Result<bool> {
    // Guard the PDA yourself: the oracle takes the roots account unconstrained,
    // so passing some other (attacker-chosen) account is otherwise possible.
    let (expected, _) = daily_scores_pda(oracle_program.key, payload.ts);
    require_keys_eq!(*daily_scores_roots.key, expected, TxLineCpiError::WrongDailyRootAccount);

    let mut data = Vec::with_capacity(1024);
    data.extend_from_slice(&VALIDATE_STAT_V3_DISCRIMINATOR);
    payload
        .serialize(&mut data)
        .map_err(|_| error!(TxLineCpiError::Serialize))?;
    strategy
        .serialize(&mut data)
        .map_err(|_| error!(TxLineCpiError::Serialize))?;

    let ix = Instruction {
        program_id: *oracle_program.key,
        accounts: vec![AccountMeta::new_readonly(*daily_scores_roots.key, false)],
        data,
    };
    invoke(&ix, &[daily_scores_roots.clone(), oracle_program.clone()])?;

    let (ret_program, ret) =
        get_return_data().ok_or(error!(TxLineCpiError::OracleReturnedNothing))?;
    require_keys_eq!(ret_program, *oracle_program.key, TxLineCpiError::OracleReturnMismatch);
    Ok(ret.first().copied().unwrap_or(0) == 1)
}

#[error_code]
pub enum TxLineCpiError {
    #[msg("Provided daily-scores account is not the PDA for the proof timestamp.")]
    WrongDailyRootAccount,
    #[msg("Failed to serialize the validate_stat_v3 payload.")]
    Serialize,
    #[msg("Oracle CPI returned no data.")]
    OracleReturnedNothing,
    #[msg("Oracle return data came from an unexpected program.")]
    OracleReturnMismatch,
}
