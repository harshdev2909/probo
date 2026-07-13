//! # oracle_adapter
//!
//! The single seam between ProofBook's settlement logic and the outside oracle.
//! ProofBook settles via TxLINE's **`validate_stat_v2`** (see
//! `docs/TXLINE_INTERFACE.md`), verified against the real txodds/tx-on-chain repo.
//!
//! * All v2 wire types are mirrored here, byte-for-byte with the confirmed IDL.
//! * [`invoke_validate_stat_v2`] performs the CPI: it builds
//!   `discriminator ‖ borsh(payload) ‖ borsh(strategy)` and reads back the `bool`
//!   return value via return data.
//! * [`OracleAdapter`] is implemented by [`TxLineAdapter`] (the real program) and
//!   [`MockOracleAdapter`] (the bundled test program). The active one is chosen by
//!   the `mock-oracle` Cargo feature via the [`ActiveOracle`] alias — so
//!   `settle_market` calls `ActiveOracle::verify_outcome(..)` and never names a
//!   concrete oracle. Because both share the identical v2 wire ABI, they funnel
//!   through the same [`invoke_validate_stat_v2`] and differ only in the trusted
//!   [`OracleAdapter::program_id`].

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
};

use crate::constants::*;
use crate::error::ProofbookError;
use crate::state::{ComboSpec, LegPredicate, Market, StatLeg};

// ── TxLINE validate_stat_v2 wire types — byte-identical to the confirmed IDL ──

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
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
    pub key: u32,
    pub value: i32,
    pub period: i32,
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

/// One claimed stat plus its proof up to the (shared) event stat root.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatLeaf {
    pub stat: ScoreStat,
    pub stat_proof: Vec<ProofNode>,
}

/// `validate_stat_v2` arg 1. A batch of stat leaves under ONE shared
/// `event_stat_root`, authenticated up to the daily root via fixture/main proofs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatValidationInput {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    pub stats: Vec<StatLeaf>,
}

/// `validate_stat_v3` arg 1. Same authentication path as v2 (fixture proof +
/// main-tree proof up to the daily root), but the per-stat sibling paths are
/// replaced by ONE shared Merkle **multiproof** over all the leaves.
///
/// The leaves' own `stat_proof` vectors come back EMPTY from the v3 API — the
/// multiproof supersedes them. Measured on a real 4-leg proof (fixture
/// 18218149): v2 needed 4 x 5-node paths + 2 = 22 nodes (~726 B); v3 needs one
/// 9-hash multiproof + 2 = 11 nodes (~363 B). Half the proof, same guarantee.
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

/// A discrete predicate over one stat (`Single`) or a combination of two
/// (`Binary`), referencing stats by index into `StatValidationInput.stats`.
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

/// `validate_stat_v2` arg 2. Geometric (exact-score/distance) targets plus a set
/// of AND-combined discrete predicates. Every stat in the payload must be covered.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct NDimensionalStrategy {
    pub geometric_targets: Vec<GeometricTarget>,
    pub distance_predicate: Option<TraderPredicate>,
    pub discrete_predicates: Vec<StatPredicate>,
}

// ── SettlementProof — caller-supplied proof material for `settle_market` ──────
//
// The caller supplies only the *proven values* and their Merkle proofs. The
// resolution predicate (stat keys/periods, op, comparison, threshold) is fixed by
// the Market's stored `OutcomeSpec`, so a caller cannot substitute a predicate
// that does not correspond to the claimed outcome. This is the trustless binding.
// (v2: one shared `event_stat_root` for the batch.)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SettlementProof {
    /// Batch timestamp (Unix ms) — selects the daily root PDA.
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    /// Shared event-stat root for all stats in this batch (v2).
    pub event_stat_root: [u8; 32],
    /// Proven value of stat A (its key/period come from the outcome spec).
    pub stat_a_value: i32,
    pub stat_a_proof: Vec<ProofNode>,
    /// Only meaningful when the outcome spec uses two stats.
    pub has_stat_b: bool,
    pub stat_b_value: i32,
    pub stat_b_proof: Vec<ProofNode>,
}

// ── SettlementProofV3 — caller-supplied material for `settle_market_v3` ───────
//
// Same trustless binding as v2: the caller supplies only PROVEN VALUES and the
// Merkle material. The predicate — which stats, which comparisons, which
// thresholds — is fixed by the market's `ComboSpec` and cannot be substituted.
// The caller cannot even choose WHICH stats are proven: `leaf_values[i]` must be
// the value of `combo.legs[i]`, whose key/period the program supplies itself.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SettlementProofV3 {
    /// Batch timestamp (Unix ms) — selects the daily root PDA.
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    /// Proven value of each leg, in `ComboSpec.legs` order. Keys/periods are NOT
    /// taken from here — they come from the spec.
    pub leaf_values: Vec<i32>,
    /// The shared multiproof: sibling hashes + the leaves' indices in the tree.
    pub multiproof_hashes: Vec<ProofNode>,
    pub leaf_indices: Vec<u32>,
}

/// CPI into an oracle's `validate_stat_v3` and decode its `bool` return value.
fn invoke_validate_stat_v3<'info>(
    oracle_program: &AccountInfo<'info>,
    daily_scores_roots: &AccountInfo<'info>,
    payload: StatValidationInputV3,
    strategy: NDimensionalStrategy,
) -> Result<bool> {
    let mut data = Vec::with_capacity(1024);
    data.extend_from_slice(&VALIDATE_STAT_V3_DISCRIMINATOR);
    payload
        .serialize(&mut data)
        .map_err(|_| error!(ProofbookError::MathOverflow))?;
    strategy
        .serialize(&mut data)
        .map_err(|_| error!(ProofbookError::MathOverflow))?;

    let ix = Instruction {
        program_id: *oracle_program.key,
        accounts: vec![AccountMeta::new_readonly(*daily_scores_roots.key, false)],
        data,
    };

    invoke(&ix, &[daily_scores_roots.clone(), oracle_program.clone()])?;

    let (ret_program, ret_data) =
        get_return_data().ok_or(error!(ProofbookError::OracleReturnedNothing))?;
    require_keys_eq!(
        ret_program,
        *oracle_program.key,
        ProofbookError::OracleReturnMismatch
    );
    Ok(ret_data.first().copied().unwrap_or(0) == 1)
}

/// Translate a market's `ComboSpec` + a v3 proof into a `validate_stat_v3` call.
///
/// The `ComboSpec` was validated at creation (every outcome covers every leg
/// exactly once), so the strategy built here can never trip TxLINE's
/// DuplicateStatCoverage / IncompleteStatCoverage checks.
pub fn build_and_verify_v3<'info>(
    oracle_program: &AccountInfo<'info>,
    daily_scores_roots: &AccountInfo<'info>,
    market: &Market,
    combo: &ComboSpec,
    claimed_outcome: u8,
    proof: &SettlementProofV3,
) -> Result<bool> {
    let outcome = combo
        .outcomes
        .get(claimed_outcome as usize)
        .ok_or(error!(ProofbookError::InvalidOutcomeIndex))?;

    build_and_verify_v3_legs(
        oracle_program,
        daily_scores_roots,
        market.fixture_id,
        &combo.legs,
        &outcome.predicates,
        proof,
    )
}

/// The leg-level CPI. Shared by compound markets and the parametric prop vault —
/// they differ in where the money goes, not in how a predicate is proven, and a
/// second copy of this would be a second set of bugs.
pub fn build_and_verify_v3_legs<'info>(
    oracle_program: &AccountInfo<'info>,
    daily_scores_roots: &AccountInfo<'info>,
    fixture_id: i64,
    legs: &[StatLeg],
    predicates: &[LegPredicate],
    proof: &SettlementProofV3,
) -> Result<bool> {
    require!(
        proof.fixture_summary.fixture_id == fixture_id,
        ProofbookError::FixtureMismatch
    );
    // One proven value per leg, in spec order — no more, no fewer.
    require!(
        proof.leaf_values.len() == legs.len(),
        ProofbookError::LegCountMismatch
    );
    require!(
        proof.leaf_indices.len() == legs.len(),
        ProofbookError::LegCountMismatch
    );

    let (expected_pda, _) = daily_scores_pda(oracle_program.key, proof.ts);
    require_keys_eq!(
        *daily_scores_roots.key,
        expected_pda,
        ProofbookError::WrongDailyRootAccount
    );

    // The leaves are built from the SPEC's (key, period) and the proof's values.
    // The caller supplies numbers; it never chooses which stats they are.
    let leaves: Vec<StatLeaf> = legs
        .iter()
        .zip(proof.leaf_values.iter())
        .map(|(leg, value)| StatLeaf {
            stat: ScoreStat {
                key: leg.key,
                value: *value,
                period: leg.period,
            },
            // v3 authenticates leaves via the shared multiproof, not per-leaf paths.
            stat_proof: vec![],
        })
        .collect();

    let discrete_predicates: Vec<StatPredicate> = predicates
        .iter()
        .map(|p| match *p {
            LegPredicate::Single {
                index,
                comparison,
                threshold,
            } => StatPredicate::Single {
                index,
                predicate: TraderPredicate {
                    threshold,
                    comparison,
                },
            },
            LegPredicate::Binary {
                index_a,
                index_b,
                op,
                comparison,
                threshold,
            } => StatPredicate::Binary {
                index_a,
                index_b,
                op,
                predicate: TraderPredicate {
                    threshold,
                    comparison,
                },
            },
        })
        .collect();

    let payload = StatValidationInputV3 {
        ts: proof.ts,
        fixture_summary: proof.fixture_summary.clone(),
        fixture_proof: proof.fixture_proof.clone(),
        main_tree_proof: proof.main_tree_proof.clone(),
        event_stat_root: proof.event_stat_root,
        leaves,
        multiproof_hashes: proof.multiproof_hashes.clone(),
        leaf_indices: proof.leaf_indices.clone(),
    };
    let strategy = NDimensionalStrategy {
        geometric_targets: vec![],
        distance_predicate: None,
        discrete_predicates,
    };

    invoke_validate_stat_v3(oracle_program, daily_scores_roots, payload, strategy)
}

/// Derive TxLINE's daily-scores-root PDA for a program id and Unix-ms timestamp.
pub fn daily_scores_pda(oracle_program: &Pubkey, ts_ms: i64) -> (Pubkey, u8) {
    let epoch_day = ts_ms.div_euclid(MS_PER_DAY) as u16;
    Pubkey::find_program_address(
        &[DAILY_SCORES_SEED, &epoch_day.to_le_bytes()],
        oracle_program,
    )
}

/// CPI into an oracle's `validate_stat_v2` and decode its `bool` return value.
fn invoke_validate_stat_v2<'info>(
    oracle_program: &AccountInfo<'info>,
    daily_scores_roots: &AccountInfo<'info>,
    payload: StatValidationInput,
    strategy: NDimensionalStrategy,
) -> Result<bool> {
    let mut data = Vec::with_capacity(512);
    data.extend_from_slice(&VALIDATE_STAT_V2_DISCRIMINATOR);
    payload
        .serialize(&mut data)
        .map_err(|_| error!(ProofbookError::MathOverflow))?;
    strategy
        .serialize(&mut data)
        .map_err(|_| error!(ProofbookError::MathOverflow))?;

    let ix = Instruction {
        program_id: *oracle_program.key,
        accounts: vec![AccountMeta::new_readonly(*daily_scores_roots.key, false)],
        data,
    };

    invoke(&ix, &[daily_scores_roots.clone(), oracle_program.clone()])?;

    let (ret_program, ret_data) =
        get_return_data().ok_or(error!(ProofbookError::OracleReturnedNothing))?;
    require_keys_eq!(
        ret_program,
        *oracle_program.key,
        ProofbookError::OracleReturnMismatch
    );
    Ok(ret_data.first().copied().unwrap_or(0) == 1)
}

/// Shared verification body used by both adapters. Translates the market's fixed
/// per-outcome `OutcomeSpec` (1 or 2 stats) into a v2 `StatValidationInput` +
/// `NDimensionalStrategy`, CPIs `validate_stat_v2`, and returns the verdict.
fn build_and_verify<'info>(
    oracle_program: &AccountInfo<'info>,
    daily_scores_roots: &AccountInfo<'info>,
    market: &Market,
    claimed_outcome: u8,
    proof: &SettlementProof,
) -> Result<bool> {
    let outcome = market.outcome_spec(claimed_outcome)?;

    require!(
        proof.fixture_summary.fixture_id == market.fixture_id,
        ProofbookError::FixtureMismatch
    );
    require!(
        proof.has_stat_b == outcome.has_stat_b,
        ProofbookError::ProofShapeMismatch
    );

    let (expected_pda, _) = daily_scores_pda(oracle_program.key, proof.ts);
    require_keys_eq!(
        *daily_scores_roots.key,
        expected_pda,
        ProofbookError::WrongDailyRootAccount
    );

    let mut stats = vec![StatLeaf {
        stat: ScoreStat {
            key: outcome.stat_a_key,
            value: proof.stat_a_value,
            period: outcome.stat_a_period,
        },
        stat_proof: proof.stat_a_proof.clone(),
    }];

    let discrete = if outcome.has_stat_b {
        stats.push(StatLeaf {
            stat: ScoreStat {
                key: outcome.stat_b_key,
                value: proof.stat_b_value,
                period: outcome.stat_b_period,
            },
            stat_proof: proof.stat_b_proof.clone(),
        });
        vec![StatPredicate::Binary {
            index_a: 0,
            index_b: 1,
            op: outcome.op.unwrap_or(BinaryExpression::Subtract),
            predicate: TraderPredicate {
                threshold: outcome.threshold,
                comparison: outcome.comparison,
            },
        }]
    } else {
        vec![StatPredicate::Single {
            index: 0,
            predicate: TraderPredicate {
                threshold: outcome.threshold,
                comparison: outcome.comparison,
            },
        }]
    };

    let payload = StatValidationInput {
        ts: proof.ts,
        fixture_summary: proof.fixture_summary.clone(),
        fixture_proof: proof.fixture_proof.clone(),
        main_tree_proof: proof.main_tree_proof.clone(),
        event_stat_root: proof.event_stat_root,
        stats,
    };
    let strategy = NDimensionalStrategy {
        geometric_targets: vec![],
        distance_predicate: None,
        discrete_predicates: discrete,
    };

    invoke_validate_stat_v2(oracle_program, daily_scores_roots, payload, strategy)
}

/// The clean interface: given `(market, claimed_outcome, proof_data)`, return
/// whether the outcome is verified — or an error.
pub trait OracleAdapter {
    /// Human label for logs / the Proof Receipt.
    const LABEL: &'static str;
    /// The trusted oracle program id this adapter validates & CPIs.
    fn program_id() -> Pubkey;

    fn verify_outcome<'info>(
        oracle_program: &AccountInfo<'info>,
        daily_scores_roots: &AccountInfo<'info>,
        market: &Market,
        claimed_outcome: u8,
        proof: &SettlementProof,
    ) -> Result<bool> {
        build_and_verify(
            oracle_program,
            daily_scores_roots,
            market,
            claimed_outcome,
            proof,
        )
    }
}

/// Real settlement: CPIs the deployed TxLINE `validate_stat_v2` program.
pub struct TxLineAdapter;
impl OracleAdapter for TxLineAdapter {
    const LABEL: &'static str = "txline";
    fn program_id() -> Pubkey {
        #[cfg(feature = "mainnet")]
        {
            TXLINE_MAINNET
        }
        #[cfg(not(feature = "mainnet"))]
        {
            TXLINE_DEVNET
        }
    }
}

/// Test/dev settlement: CPIs the bundled `mock_oracle` program.
pub struct MockOracleAdapter;
impl OracleAdapter for MockOracleAdapter {
    const LABEL: &'static str = "mock";
    fn program_id() -> Pubkey {
        MOCK_ORACLE_ID
    }
}

/// The adapter compiled into this build. Flip via the `mock-oracle` feature.
#[cfg(feature = "mock-oracle")]
pub type ActiveOracle = MockOracleAdapter;
#[cfg(not(feature = "mock-oracle"))]
pub type ActiveOracle = TxLineAdapter;
