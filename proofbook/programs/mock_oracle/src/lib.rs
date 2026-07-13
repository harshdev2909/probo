//! # mock_oracle
//!
//! A **local, test-only** reproduction of TxLINE's on-chain `validate_stat`
//! program. It exists so ProofBook's full trustless settlement flow (a CPI into
//! an external oracle that returns a verified `bool`) can be exercised in tests
//! today, without depending on live TxLINE devnet availability or a paid
//! subscription.
//!
//! ## Fidelity to the real interface (see `docs/TXLINE_INTERFACE.md`)
//!
//! * The instruction is named `validate_stat`, so Anchor derives the **exact same
//!   8-byte discriminator** as the real program: `[107,197,232,90,191,136,105,185]`.
//! * The argument list, types, single read-only `daily_scores_merkle_roots`
//!   account, and the `bool` return value are byte-for-byte identical to the
//!   confirmed TxLINE IDL. => The identical CPI encoding in ProofBook's
//!   `oracle_adapter` drives either program unchanged.
//!
//! ## What is *mock-local* (documented as such, NOT a claim about TxLINE)
//!
//! The real leaf-hashing algorithm and node-combination rule are UNCONFIRMED in
//! TxLINE's public docs. This mock therefore picks a concrete, self-consistent
//! scheme purely to make proofs verifiable in tests: leaves are
//! `keccak256(borsh(payload))`, and a parent is `keccak256(left ‖ right)` where
//! `is_right_sibling` marks the sibling as the right child. ProofBook never
//! re-implements any of this — it delegates the whole check to this program via
//! CPI, exactly as it will delegate to TxLINE.

use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

declare_id!("F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u");

pub const DAILY_SCORES_SEED: &[u8] = b"daily_scores_roots";
/// TxLINE timestamps are Unix milliseconds; the daily-root PDA is keyed by day.
pub const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

#[program]
pub mod mock_oracle {
    use super::*;

    /// Mirrors TxLINE `validate_stat_v2`. Returns `true` iff every stat leaf in
    /// `payload.stats` is proven under the published daily Merkle root AND the
    /// `NDimensionalStrategy` (AND-combined discrete predicates + optional
    /// geometric distance) holds over the proven values.
    ///
    /// A **bad Merkle proof / bad coverage errors** (mirrors TxLINE's verification
    /// errors); a **failing predicate returns `Ok(false)`** (mirrors
    /// `PredicateFailed`). ProofBook treats *either* as "not verified".
    pub fn validate_stat_v2(
        ctx: Context<ValidateStatV2>,
        payload: StatValidationInput,
        strategy: NDimensionalStrategy,
    ) -> Result<bool> {
        let roots = &ctx.accounts.daily_scores_merkle_roots;

        let epoch_day = epoch_day_of(payload.ts);
        require!(roots.epoch_day == epoch_day, MockOracleError::WrongDailyRoot);

        // (1) The shared event root must belong to the fixture; every stat leaf
        //     must prove up to it.
        require!(
            payload.event_stat_root == payload.fixture_summary.events_sub_tree_root,
            MockOracleError::StatNotInFixture
        );
        for leaf in &payload.stats {
            verify_stat_leaf(leaf, &payload.event_stat_root)?;
        }

        // (2) The fixture summary must be proven under the published daily root.
        let fixture_leaf = leaf_hash(&borsh_bytes(&payload.fixture_summary));
        let sub_root = fold_proof(fixture_leaf, &payload.fixture_proof);
        let computed_root = fold_proof(sub_root, &payload.main_tree_proof);
        require!(computed_root == roots.root, MockOracleError::MerkleRootMismatch);

        // (3) + (4) Coverage and evaluation.
        let stats: Vec<ScoreStat> = payload.stats.iter().map(|l| l.stat.clone()).collect();
        evaluate_strategy(&stats, &strategy)
    }

    /// Mirrors TxLINE `validate_stat_v3`. Same authentication and the same
    /// `NDimensionalStrategy`, but the per-leaf sibling paths are replaced by ONE
    /// shared Merkle **multiproof** (`multiproof_hashes` + `leaf_indices`).
    ///
    /// The coverage rules are identical to v2's and were confirmed against the
    /// REAL devnet oracle: a stat evaluated twice errors `DuplicateStatCoverage`
    /// (6070), and a stat left unevaluated errors `IncompleteStatCoverage` (6071).
    pub fn validate_stat_v3(
        ctx: Context<ValidateStatV2>,
        payload: StatValidationInputV3,
        strategy: NDimensionalStrategy,
    ) -> Result<bool> {
        let roots = &ctx.accounts.daily_scores_merkle_roots;

        let epoch_day = epoch_day_of(payload.ts);
        require!(roots.epoch_day == epoch_day, MockOracleError::WrongDailyRoot);

        require!(
            payload.event_stat_root == payload.fixture_summary.events_sub_tree_root,
            MockOracleError::StatNotInFixture
        );
        require!(
            payload.leaves.len() == payload.leaf_indices.len(),
            MockOracleError::MissingStat
        );

        // (1) All stat leaves are authenticated TOGETHER by one multiproof.
        let leaf_hashes: Vec<[u8; 32]> = payload
            .leaves
            .iter()
            .map(|l| leaf_hash(&borsh_bytes(&l.stat)))
            .collect();
        verify_multiproof(
            &leaf_hashes,
            &payload.leaf_indices,
            &payload.multiproof_hashes,
            &payload.event_stat_root,
        )?;

        // (2) The fixture summary must be proven under the published daily root.
        let fixture_leaf = leaf_hash(&borsh_bytes(&payload.fixture_summary));
        let sub_root = fold_proof(fixture_leaf, &payload.fixture_proof);
        let computed_root = fold_proof(sub_root, &payload.main_tree_proof);
        require!(computed_root == roots.root, MockOracleError::MerkleRootMismatch);

        // (3) + (4) Coverage and evaluation are identical to v2.
        let stats: Vec<ScoreStat> = payload.leaves.iter().map(|l| l.stat.clone()).collect();
        evaluate_strategy(&stats, &strategy)
    }

    /// TEST-ONLY: publish (or overwrite) the daily scores Merkle root for a day.
    /// Mimics TxLINE's off-chain batching that lands a signed daily root on-chain.
    /// Not part of the real `validate_stat` interface.
    pub fn publish_daily_root(
        ctx: Context<PublishDailyRoot>,
        epoch_day: u16,
        root: [u8; 32],
    ) -> Result<()> {
        let acct = &mut ctx.accounts.daily_scores_merkle_roots;
        acct.epoch_day = epoch_day;
        acct.root = root;
        Ok(())
    }
}

/// Convert a Unix-ms timestamp to the `u16` epoch-day seed used by TxLINE.
pub fn epoch_day_of(ts_ms: i64) -> u16 {
    (ts_ms.div_euclid(MS_PER_DAY)) as u16
}

/// Borsh-serialize any Anchor type. Serializing to a growable `Vec` is infallible.
pub fn borsh_bytes<T: AnchorSerialize>(v: &T) -> Vec<u8> {
    let mut buf = Vec::new();
    v.serialize(&mut buf).expect("borsh serialize to Vec is infallible");
    buf
}

/// Domain-separated leaf hash (mock-local scheme). `pub` so the test harness can
/// build proofs with the exact same primitive the program verifies against.
pub fn leaf_hash(bytes: &[u8]) -> [u8; 32] {
    hashv(&[b"leaf:".as_ref(), bytes]).to_bytes()
}

/// Fold a Merkle authentication path over a starting node hash.
/// `is_right_sibling == true` => sibling is the right child, current node is left.
pub fn fold_proof(mut node: [u8; 32], proof: &[ProofNode]) -> [u8; 32] {
    for p in proof {
        node = if p.is_right_sibling {
            hashv(&[b"node:".as_ref(), node.as_ref(), p.hash.as_ref()]).to_bytes()
        } else {
            hashv(&[b"node:".as_ref(), p.hash.as_ref(), node.as_ref()]).to_bytes()
        };
    }
    node
}

/// A stat leaf must hash + prove up to the shared `event_stat_root` (v2).
fn verify_stat_leaf(leaf: &StatLeaf, event_stat_root: &[u8; 32]) -> Result<()> {
    let hashed = leaf_hash(&borsh_bytes(&leaf.stat));
    let computed = fold_proof(hashed, &leaf.stat_proof);
    require!(
        &computed == event_stat_root,
        MockOracleError::StatProofMismatch
    );
    Ok(())
}

/// Combine two sibling hashes into their parent (mock-local scheme).
fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"node:".as_ref(), left.as_ref(), right.as_ref()]).to_bytes()
}

/// Verify a Merkle **multiproof**: several leaves authenticated together under
/// one root, sharing their internal nodes.
///
/// This is what makes v3 smaller than v2. v2 carries a full sibling path per
/// leaf, so leaves that live near each other pay for the same internal nodes
/// over and over. v3 carries each needed sibling ONCE.
///
/// Walk the tree level by level. At each level the known nodes are held as
/// (index, hash), sorted. Two known nodes that are siblings combine directly and
/// cost nothing; a known node whose sibling is unknown consumes the next hash
/// from `multiproof_hashes`. Every node moves up to `index / 2`, and the walk
/// ends when only the root (index 0) remains.
fn verify_multiproof(
    leaf_hashes: &[[u8; 32]],
    leaf_indices: &[u32],
    multiproof: &[ProofNode],
    root: &[u8; 32],
) -> Result<()> {
    require!(!leaf_hashes.is_empty(), MockOracleError::MissingStat);

    // Sort by tree index so siblings are adjacent.
    let mut level: Vec<(u32, [u8; 32])> = leaf_indices
        .iter()
        .copied()
        .zip(leaf_hashes.iter().copied())
        .collect();
    level.sort_by_key(|(i, _)| *i);
    for w in level.windows(2) {
        require!(w[0].0 != w[1].0, MockOracleError::DuplicateStatCoverage);
    }

    let mut fed = 0usize;
    // A single leaf that IS the root needs no hashing at all.
    while level.len() > 1 || level[0].0 != 0 {
        let mut next: Vec<(u32, [u8; 32])> = Vec::with_capacity(level.len());
        let mut i = 0usize;
        while i < level.len() {
            let (idx, hash) = level[i];
            let sibling_idx = idx ^ 1;

            let (left, right) = if i + 1 < level.len() && level[i + 1].0 == sibling_idx {
                // Both siblings are known — the shared-node saving.
                let (_, sib) = level[i + 1];
                i += 2;
                if idx % 2 == 0 {
                    (hash, sib)
                } else {
                    (sib, hash)
                }
            } else {
                // Sibling is not in our set — take it from the multiproof.
                require!(fed < multiproof.len(), MockOracleError::StatProofMismatch);
                let sib = multiproof[fed].hash;
                fed += 1;
                i += 1;
                if idx % 2 == 0 {
                    (hash, sib)
                } else {
                    (sib, hash)
                }
            };

            next.push((idx / 2, node_hash(&left, &right)));
        }
        next.sort_by_key(|(i, _)| *i);
        next.dedup_by_key(|(i, _)| *i);
        level = next;
    }

    // Every supplied hash must have been needed — a proof with slack is malformed.
    require!(fed == multiproof.len(), MockOracleError::StatProofMismatch);
    require!(&level[0].1 == root, MockOracleError::StatProofMismatch);
    Ok(())
}

/// Coverage check + AND-evaluation of an `NDimensionalStrategy` over proven stats.
///
/// Shared by v2 and v3 — the strategy semantics are identical between them, and a
/// second copy would be a second set of bugs. Coverage: every stat must be
/// referenced EXACTLY ONCE. Both failure modes were confirmed against the real
/// devnet oracle (6070 DuplicateStatCoverage, 6071 IncompleteStatCoverage).
fn evaluate_strategy(stats: &[ScoreStat], strategy: &NDimensionalStrategy) -> Result<bool> {
    let n = stats.len();
    require!(n <= 32, MockOracleError::TooManyStats);

    let mut refs: Vec<u8> = Vec::new();
    for gt in &strategy.geometric_targets {
        refs.push(gt.stat_index);
    }
    for p in &strategy.discrete_predicates {
        match p {
            StatPredicate::Single { index, .. } => refs.push(*index),
            StatPredicate::Binary {
                index_a, index_b, ..
            } => {
                refs.push(*index_a);
                refs.push(*index_b);
            }
        }
    }
    let mut covered = vec![false; n];
    for &idx in &refs {
        let i = idx as usize;
        require!(i < n, MockOracleError::MissingStat);
        require!(!covered[i], MockOracleError::DuplicateStatCoverage);
        covered[i] = true;
    }
    require!(
        covered.iter().all(|c| *c),
        MockOracleError::IncompleteStatCoverage
    );

    let val = |i: u8| stats[i as usize].value as i64;

    if !strategy.geometric_targets.is_empty() {
        let dp = strategy
            .distance_predicate
            .as_ref()
            .ok_or(MockOracleError::MissingDistancePredicate)?;
        let mut dist: i64 = 0;
        for gt in &strategy.geometric_targets {
            let d = val(gt.stat_index) - gt.prediction as i64;
            dist = dist
                .checked_add(
                    d.checked_mul(d)
                        .ok_or(MockOracleError::ArithmeticOverflow)?,
                )
                .ok_or(MockOracleError::ArithmeticOverflow)?;
        }
        if !compare(dist, dp.threshold as i64, dp.comparison) {
            return Ok(false);
        }
    }

    for p in &strategy.discrete_predicates {
        let (value, pred) = match p {
            StatPredicate::Single { index, predicate } => (val(*index), predicate),
            StatPredicate::Binary {
                index_a,
                index_b,
                op,
                predicate,
            } => {
                let combined = match op {
                    BinaryExpression::Add => val(*index_a).checked_add(val(*index_b)),
                    BinaryExpression::Subtract => val(*index_a).checked_sub(val(*index_b)),
                }
                .ok_or(MockOracleError::ArithmeticOverflow)?;
                (combined, predicate)
            }
        };
        if !compare(value, pred.threshold as i64, pred.comparison) {
            return Ok(false);
        }
    }

    Ok(true)
}

fn compare(value: i64, threshold: i64, cmp: Comparison) -> bool {
    match cmp {
        Comparison::GreaterThan => value > threshold,
        Comparison::LessThan => value < threshold,
        Comparison::EqualTo => value == threshold,
    }
}

#[derive(Accounts)]
pub struct ValidateStatV2<'info> {
    /// The published daily scores Merkle roots account (read-only), exactly as
    /// in the real TxLINE IDL (a single, unconstrained account).
    pub daily_scores_merkle_roots: Account<'info, DailyScoresMerkleRoots>,
}

#[derive(Accounts)]
#[instruction(epoch_day: u16)]
pub struct PublishDailyRoot<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + DailyScoresMerkleRoots::LEN,
        seeds = [DAILY_SCORES_SEED, &epoch_day.to_le_bytes()],
        bump,
    )]
    pub daily_scores_merkle_roots: Account<'info, DailyScoresMerkleRoots>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct DailyScoresMerkleRoots {
    pub epoch_day: u16,
    pub root: [u8; 32],
}

impl DailyScoresMerkleRoots {
    pub const LEN: usize = 2 + 32;
}

// ────────────────────────────────────────────────────────────────────────────
// Wire types — byte-identical to the confirmed TxLINE IDL (docs/TXLINE_INTERFACE.md §2)
// ────────────────────────────────────────────────────────────────────────────

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
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatLeaf {
    pub stat: ScoreStat,
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatValidationInput {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    pub stats: Vec<StatLeaf>,
}

/// v3: leaves authenticated together by ONE shared multiproof. The leaves' own
/// `stat_proof` vectors are unused (the real v3 API returns them empty).
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct NDimensionalStrategy {
    pub geometric_targets: Vec<GeometricTarget>,
    pub distance_predicate: Option<TraderPredicate>,
    pub discrete_predicates: Vec<StatPredicate>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[error_code]
pub enum MockOracleError {
    #[msg("Daily root account does not match the timestamp's epoch day.")]
    WrongDailyRoot,
    #[msg("Stat proof does not reconstruct the declared event stat root.")]
    StatProofMismatch,
    #[msg("Stat's event root is not the fixture's events subtree root.")]
    StatNotInFixture,
    #[msg("Fixture proof does not reconstruct the published daily root.")]
    MerkleRootMismatch,
    #[msg("Arithmetic overflow while combining stats.")]
    ArithmeticOverflow,
    #[msg("Too many stats in the payload.")]
    TooManyStats,
    #[msg("Strategy references a stat index that is not present.")]
    MissingStat,
    #[msg("A stat index is evaluated more than once.")]
    DuplicateStatCoverage,
    #[msg("Not all stats in the payload were evaluated.")]
    IncompleteStatCoverage,
    #[msg("Distance predicate is required when geometric targets are present.")]
    MissingDistancePredicate,
}
