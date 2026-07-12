use anchor_lang::prelude::*;

// ── PDA seeds ────────────────────────────────────────────────────────────────
#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const POSITION_SEED: &[u8] = b"position";

/// TxLINE's daily scores-root PDA seed (see docs/TXLINE_INTERFACE.md §3).
pub const DAILY_SCORES_SEED: &[u8] = b"daily_scores_roots";

// ── Limits & sentinels ───────────────────────────────────────────────────────
/// Maximum outcome options per market (bounds account size deterministically).
pub const MAX_OUTCOMES: usize = 8;
/// Minimum outcome options (a market needs at least two sides).
pub const MIN_OUTCOMES: usize = 2;
/// Maximum protocol fee, in basis points (10%).
pub const MAX_FEE_BPS: u16 = 1_000;
/// Basis-point denominator.
pub const BPS_DENOMINATOR: u64 = 10_000;
/// `winning_outcome` sentinel before settlement.
pub const UNSET_OUTCOME: u8 = u8::MAX;

// ── TxLINE interface constants (CONFIRMED — docs/TXLINE_INTERFACE.md §2/§3) ─────
/// `validate_stat` (v1) discriminator = sha256("global:validate_stat")[..8].
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];
/// `validate_stat_v2` discriminator (the current settlement path).
/// Source: txodds/tx-on-chain examples/devnet/idl/txoracle.json.
pub const VALIDATE_STAT_V2_DISCRIMINATOR: [u8; 8] = [208, 215, 194, 214, 241, 71, 246, 178];
/// TxLINE timestamps are Unix milliseconds; daily root keyed by `floor(ts/DAY)`.
pub const MS_PER_DAY: i64 = 86_400_000;

/// TxLINE oracle program — devnet.
pub const TXLINE_DEVNET: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
/// TxLINE oracle program — mainnet-beta.
pub const TXLINE_MAINNET: Pubkey = pubkey!("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA");
/// Bundled `mock_oracle` program id (test/dev builds only).
pub const MOCK_ORACLE_ID: Pubkey = pubkey!("F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u");
