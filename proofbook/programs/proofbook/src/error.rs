use anchor_lang::prelude::*;

#[error_code]
pub enum ProofbookError {
    // ── initialize_market ────────────────────────────────────────────────
    #[msg("Fee exceeds the maximum allowed basis points.")]
    FeeTooHigh,
    #[msg("Outcome count out of range (must be MIN_OUTCOMES..=MAX_OUTCOMES).")]
    InvalidOutcomeCount,
    #[msg("Lock time must be in the future.")]
    LockTimeInPast,
    #[msg("Invalid outcome spec: `op` must be Some iff the outcome uses two stats.")]
    InvalidOutcomeSpec,
    #[msg("fixture_id / match_id must be positive.")]
    InvalidFixtureId,

    // ── place_bet ────────────────────────────────────────────────────────
    #[msg("Bet amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Outcome index is out of range for this market.")]
    InvalidOutcomeIndex,
    #[msg("Market is not open for betting.")]
    MarketNotOpen,
    #[msg("Betting is closed (past lock time).")]
    BettingClosed,
    #[msg("A position can only back one outcome; open a new position for another outcome.")]
    CannotSwitchOutcome,
    #[msg("Provided token account does not match the market's USDC mint.")]
    WrongMint,

    // ── lock_market ──────────────────────────────────────────────────────
    #[msg("Too early to lock: current time is before lock_time.")]
    TooEarlyToLock,

    // ── settle_market ────────────────────────────────────────────────────
    #[msg("Market must be Locked before it can be settled.")]
    NotLocked,
    #[msg("Market is already settled; settlement is idempotent and one-shot.")]
    AlreadySettled,
    #[msg("Provided oracle program does not match the market's trusted oracle.")]
    WrongOracleProgram,
    #[msg("Oracle program does not match the active adapter's program id.")]
    OracleAdapterMismatch,
    #[msg("Proof fixture_id does not match this market's fixture_id.")]
    FixtureMismatch,
    #[msg("Proof shape does not match the outcome spec (stat_b presence mismatch).")]
    ProofShapeMismatch,
    #[msg("Provided daily-scores account is not the PDA for the proof timestamp.")]
    WrongDailyRootAccount,
    #[msg("Oracle CPI returned no data.")]
    OracleReturnedNothing,
    #[msg("Oracle return data came from an unexpected program.")]
    OracleReturnMismatch,
    #[msg("Outcome could not be verified by the oracle; refusing to settle.")]
    OutcomeNotVerified,

    // ── compound (multi-leg) markets ─────────────────────────────────────
    #[msg("Compound market spec is malformed (leg count, outcome count, or an out-of-range leg index).")]
    InvalidComboSpec,
    #[msg("A leg is evaluated more than once by one outcome; TxLINE rejects duplicate stat coverage.")]
    DuplicateLegCoverage,
    #[msg("An outcome leaves a leg unevaluated; TxLINE requires every proven stat to be covered.")]
    IncompleteLegCoverage,
    #[msg("This ComboSpec does not belong to the market being settled.")]
    WrongComboSpec,
    #[msg("Compound markets must be settled with settle_market_v3, not settle_market.")]
    ComboRequiresV3,
    #[msg("settle_market_v3 requires a compound market type (>= COMBO_MARKET_TYPE_MIN).")]
    NotAComboMarket,
    #[msg("Proof leaf count does not match the ComboSpec's leg count.")]
    LegCountMismatch,
    #[msg("Proof leaf does not match the stat (key/period) the ComboSpec pins for that leg.")]
    LegStatMismatch,

    // ── prop vault ───────────────────────────────────────────────────────
    #[msg("Provided beneficiary token account is not owned by the vault's beneficiary.")]
    WrongBeneficiary,
    #[msg("Provided depositor token account is not owned by the vault's depositor.")]
    WrongDepositor,

    // ── claim_winnings ───────────────────────────────────────────────────
    #[msg("Market is not settled yet.")]
    NotSettled,
    #[msg("Position has already been claimed.")]
    AlreadyClaimed,
    #[msg("This position did not back the winning outcome; no payout.")]
    NotAWinningPosition,
    #[msg("Winning pool has zero stake; nothing to claim.")]
    ZeroWinningPool,
    #[msg("Provided vault does not belong to this market.")]
    WrongVault,

    // ── cancel_market / claim_refund (liveness escape hatch) ─────────────
    #[msg("Resolution timeout must be positive.")]
    InvalidResolutionTimeout,
    #[msg("Market is already resolved (Settled or Cancelled).")]
    AlreadyResolved,
    #[msg("Too early to cancel: now <= lock_time + resolution_timeout.")]
    TooEarlyToCancel,
    #[msg("Market is not cancelled; refunds are not available.")]
    NotCancelled,

    // ── withdraw_fees ────────────────────────────────────────────────────
    #[msg("Provided fee destination is not owned by the market's fee treasury.")]
    WrongFeeTreasury,
    #[msg("Protocol fee has already been withdrawn.")]
    FeesAlreadyWithdrawn,
    #[msg("There is no fee to withdraw (zero-fee or cancelled market).")]
    NothingToWithdraw,

    // ── math ─────────────────────────────────────────────────────────────
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Arithmetic underflow.")]
    MathUnderflow,
}
