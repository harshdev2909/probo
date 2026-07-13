use anchor_lang::prelude::*;

// ── PDA seeds ────────────────────────────────────────────────────────────────
#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const POSITION_SEED: &[u8] = b"position";
/// Sidecar holding a compound (multi-leg) resolution spec for a market.
#[constant]
pub const COMBO_SEED: &[u8] = b"combo";
/// Parametric prop vault: pays out on a verified compound predicate.
#[constant]
pub const PROP_VAULT_SEED: &[u8] = b"prop_vault";

/// TxLINE's daily scores-root PDA seed (see docs/TXLINE_INTERFACE.md §3).
pub const DAILY_SCORES_SEED: &[u8] = b"daily_scores_roots";

// ── Limits & sentinels ───────────────────────────────────────────────────────
/// Maximum outcome options per market (bounds account size deterministically).
///
/// Raised 8 -> 12 to fit HT/FT (3 half-time results x 3 full-time = 9 outcomes).
/// This is SAFE for the ~226 Market accounts already on devnet: `MAX_OUTCOMES`
/// only feeds `#[max_len]`, which sizes the ALLOCATION for *new* accounts. It is
/// not part of the serialized layout — a Borsh `Vec` is a u32 length prefix plus
/// that many elements, so an existing 615-byte account holding 3 outcomes still
/// deserializes byte-identically, and writing it back still fits. Only newly
/// initialized markets get the larger allocation.
pub const MAX_OUTCOMES: usize = 12;
/// Minimum outcome options (a market needs at least two sides).
pub const MIN_OUTCOMES: usize = 2;

/// Maximum stat legs in a compound (parlay / multi-stat) market.
///
/// Hard-capped by TxLINE's proof API, which rejects a `statKeys` list with more
/// than 5 entries ("Parameter statKeys must contain between 1 and 5 valid
/// keys"). A market that needs a 6th leg cannot obtain a proof at all, so this
/// is a product limit, not a tuning knob.
pub const MAX_LEGS: usize = 5;

/// Market types >= this are COMPOUND: their resolution spec lives in a
/// `ComboSpec` sidecar, not in `Market.outcomes[i].spec`.
///
/// The legacy `settle_market` refuses them. Without that guard a parlay could be
/// settled by proving only its FIRST leg — `Market.outcomes[i].spec` necessarily
/// holds a single 1-2 stat predicate, so "Home win AND over 9.5 corners" would
/// settle on "Home win" alone. Generations 0-4 are the existing 1X2 markets.
pub const COMBO_MARKET_TYPE_MIN: u8 = 16;
/// Maximum protocol fee, in basis points (10%).
pub const MAX_FEE_BPS: u16 = 1_000;
/// Basis-point denominator.
pub const BPS_DENOMINATOR: u64 = 10_000;
/// `winning_outcome` sentinel before settlement.
pub const UNSET_OUTCOME: u8 = u8::MAX;

// ── TxLINE interface constants (CONFIRMED — docs/TXLINE_INTERFACE.md §2/§3) ─────
/// `validate_stat` (v1) discriminator = sha256("global:validate_stat")[..8].
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];
/// `validate_stat_v2` discriminator (the legacy settlement path, kept as a fallback).
/// Source: txodds/tx-on-chain examples/devnet/idl/txoracle.json.
pub const VALIDATE_STAT_V2_DISCRIMINATOR: [u8; 8] = [208, 215, 194, 214, 241, 71, 246, 178];
/// `validate_stat_v3` discriminator — the CURRENT settlement path.
///
/// v3 takes the same `NDimensionalStrategy`, but replaces v2's per-stat sibling
/// paths with ONE shared Merkle multiproof (`multiproof_hashes` + `leaf_indices`).
/// Measured on a real 4-leg proof (fixture 18218149): 22 proof nodes -> 11.
/// Source: txodds/tx-on-chain examples/devnet/idl/txoracle.json (IDL v1.5.6).
pub const VALIDATE_STAT_V3_DISCRIMINATOR: [u8; 8] = [150, 37, 155, 89, 141, 190, 77, 203];
/// TxLINE timestamps are Unix milliseconds; daily root keyed by `floor(ts/DAY)`.
pub const MS_PER_DAY: i64 = 86_400_000;

/// TxLINE oracle program — devnet.
pub const TXLINE_DEVNET: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
/// TxLINE oracle program — mainnet-beta.
pub const TXLINE_MAINNET: Pubkey = pubkey!("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA");
/// Bundled `mock_oracle` program id (test/dev builds only).
pub const MOCK_ORACLE_ID: Pubkey = pubkey!("F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u");
