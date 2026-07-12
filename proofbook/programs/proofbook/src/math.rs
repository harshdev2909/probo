//! Parimutuel payout math. Pure, `u128`-intermediate, fully checked, and unit
//! tested. No floating point; all division floors (dust stays in the vault).

use anchor_lang::prelude::*;

use crate::constants::BPS_DENOMINATOR;
use crate::error::ProofbookError;

/// Protocol fee taken from the whole pool: `floor(total_pool * fee_bps / 10_000)`.
pub fn fee_amount(total_pool: u64, fee_bps: u16) -> Result<u64> {
    let fee = (total_pool as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ProofbookError::MathOverflow)?
        / (BPS_DENOMINATOR as u128);
    u64::try_from(fee).map_err(|_| error!(ProofbookError::MathOverflow))
}

/// Pool distributed to winners: `total_pool - fee`.
pub fn distributable_pool(total_pool: u64, fee_bps: u16) -> Result<u64> {
    total_pool
        .checked_sub(fee_amount(total_pool, fee_bps)?)
        .ok_or(error!(ProofbookError::MathUnderflow))
}

/// Pro-rata parimutuel payout for one winning stake:
///   `payout = floor(stake * (total_pool - fee) / total_winning_pool)`
///
/// * `u128` intermediates guarantee no overflow for any `u64` inputs.
/// * Flooring guarantees the sum of all winners' payouts never exceeds the
///   distributable pool, so the vault can never be drained (dust is retained).
pub fn payout(
    stake: u64,
    total_pool: u64,
    total_winning_pool: u64,
    fee_bps: u16,
) -> Result<u64> {
    require!(total_winning_pool > 0, ProofbookError::ZeroWinningPool);
    // A winning stake is part of the winning pool; enforce the invariant.
    require!(
        stake <= total_winning_pool,
        ProofbookError::MathOverflow
    );

    let distributable = distributable_pool(total_pool, fee_bps)? as u128;
    let numerator = (stake as u128)
        .checked_mul(distributable)
        .ok_or(ProofbookError::MathOverflow)?;
    let payout = numerator / (total_winning_pool as u128);
    u64::try_from(payout).map_err(|_| error!(ProofbookError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_application() {
        // 5% of 1_000_000 = 50_000
        assert_eq!(fee_amount(1_000_000, 500).unwrap(), 50_000);
        // 0% fee
        assert_eq!(fee_amount(1_000_000, 0).unwrap(), 0);
        // 10% (max) of 999 floors to 99
        assert_eq!(fee_amount(999, 1_000).unwrap(), 99);
        assert_eq!(distributable_pool(1_000_000, 500).unwrap(), 950_000);
    }

    #[test]
    fn parimutuel_two_winners_no_fee() {
        // total pool 100 (two winners staked 30 + 10 = winning pool 40; losers 60)
        let total = 100u64;
        let win_pool = 40u64;
        let p1 = payout(30, total, win_pool, 0).unwrap();
        let p2 = payout(10, total, win_pool, 0).unwrap();
        assert_eq!(p1, 75); // 30/40 * 100
        assert_eq!(p2, 25); // 10/40 * 100
        assert_eq!(p1 + p2, 100); // exact, no dust
    }

    #[test]
    fn parimutuel_three_bettors_multiple_outcomes_with_fee() {
        // Outcome A winners: Alice 500, Bob 300 (winning pool 800).
        // Outcome B loser: Carol 200. Total pool = 1000. Fee = 5%.
        let total = 1_000u64;
        let win_pool = 800u64;
        let fee = fee_amount(total, 500).unwrap();
        assert_eq!(fee, 50);
        let dist = distributable_pool(total, 500).unwrap();
        assert_eq!(dist, 950);

        let alice = payout(500, total, win_pool, 500).unwrap(); // 500/800*950 = 593.75 -> 593
        let bob = payout(300, total, win_pool, 500).unwrap(); //   300/800*950 = 356.25 -> 356
        assert_eq!(alice, 593);
        assert_eq!(bob, 356);

        // No overpayment: winners + fee <= total; remaining is dust in the vault.
        assert!(alice + bob + fee <= total);
        let dust = total - (alice + bob + fee);
        assert_eq!(dust, 1); // 949 paid + 50 fee = 999, 1 lamport-unit dust retained
    }

    #[test]
    fn winner_takes_all_when_sole_winner() {
        // Sole winner staked 250 out of a 1000 pool, 2.5% fee.
        let total = 1_000u64;
        let win_pool = 250u64;
        let p = payout(250, total, win_pool, 250).unwrap();
        // fee = floor(1000*250/10000) = 25 -> dist 975 -> 250/250*975 = 975
        assert_eq!(fee_amount(total, 250).unwrap(), 25);
        assert_eq!(p, 975);
    }

    #[test]
    fn rounding_never_exceeds_distributable() {
        // Three winners with awkward ratios; assert sum(payouts) <= distributable.
        let total = 1_000_000u64;
        let stakes = [333_333u64, 333_333, 333_334]; // winning pool = 1_000_000
        let win_pool: u64 = stakes.iter().sum();
        let fee_bps = 300u16;
        let dist = distributable_pool(total, fee_bps).unwrap();
        let sum: u64 = stakes
            .iter()
            .map(|s| payout(*s, total, win_pool, fee_bps).unwrap())
            .sum();
        assert!(sum <= dist, "sum {sum} must not exceed distributable {dist}");
        assert!(dist - sum <= stakes.len() as u64, "dust is bounded by #winners");
    }

    #[test]
    fn zero_winning_pool_errors() {
        assert!(payout(0, 100, 0, 0).is_err());
    }

    #[test]
    fn no_overflow_on_extreme_values() {
        // u64::MAX-scale inputs must not overflow thanks to u128 intermediates.
        let big = u64::MAX;
        // Single winner owns the whole pool -> gets pool minus fee.
        let dist = distributable_pool(big, 1_000).unwrap();
        let p = payout(big, big, big, 1_000).unwrap();
        assert_eq!(p, dist);
    }

    #[test]
    fn fee_bounds_hold() {
        // Fee is always <= total pool for any allowed bps.
        for bps in [0u16, 1, 250, 500, 1_000] {
            let total = 123_456_789u64;
            let fee = fee_amount(total, bps).unwrap();
            assert!(fee <= total);
            assert_eq!(distributable_pool(total, bps).unwrap(), total - fee);
        }
    }

    /// Mirror of `claim_winnings`' last-claimer-absorbs-remainder scheme. Asserts
    /// the accounting invariants the on-chain instruction relies on:
    ///  (a) Σ(payouts) == distributable EXACTLY  (vault settles to zero),
    ///  (b) Σ(payouts) + fee == total_pool EXACTLY,
    ///  (c) the last claimer never receives less than its floored share,
    ///  (d) partial-claim solvency: distributable - paid_out is always >= the
    ///      sum of the not-yet-claimed winners' floors.
    fn simulate_claims(stakes: &[u64], total: u64, fee_bps: u16) -> (Vec<u64>, u64) {
        let win_pool: u64 = stakes.iter().sum();
        let dist = distributable_pool(total, fee_bps).unwrap();
        let mut paid_out = 0u64;
        let mut claimed_stake = 0u64;
        let mut payouts = Vec::new();
        for (i, &stake) in stakes.iter().enumerate() {
            claimed_stake += stake;
            let is_last = claimed_stake == win_pool;
            let floor = payout(stake, total, win_pool, fee_bps).unwrap();
            let p = if is_last { dist - paid_out } else { floor };
            assert!(p >= floor, "last claimer #{i} must get >= its floor");
            // (d) solvency before this claim: vault held >= remaining floors.
            let remaining_floor: u64 = stakes[i..]
                .iter()
                .map(|s| payout(*s, total, win_pool, fee_bps).unwrap())
                .sum();
            assert!(dist - paid_out >= remaining_floor);
            paid_out += p;
            payouts.push(p);
        }
        (payouts, fee_amount(total, fee_bps).unwrap())
    }

    #[test]
    fn last_claimer_remainder_is_exact_and_solvent() {
        // Awkward ratios that produce rounding dust.
        let stakes = [333_333u64, 333_333, 333_334];
        let total = 1_000_000u64;
        let (payouts, fee) = simulate_claims(&stakes, total, 300);
        let dist = distributable_pool(total, 300).unwrap();
        let sum: u64 = payouts.iter().sum();
        assert_eq!(sum, dist, "(a) winners get exactly the distributable pool");
        assert_eq!(sum + fee, total, "(b) payouts + fee == total_pool exactly");

        // Many winners, non-trivial fee, and a whole-USDC-scale pool.
        let stakes2 = [1u64, 7, 13, 100, 250, 629];
        let total2 = 2_000_000_000u64;
        let (payouts2, fee2) = simulate_claims(&stakes2, total2, 750);
        let sum2: u64 = payouts2.iter().sum();
        assert_eq!(sum2, distributable_pool(total2, 750).unwrap());
        assert_eq!(sum2 + fee2, total2);
    }
}
