# `txline_cpi` — CPI `validate_stat_v3` from any Anchor program

Copy [`txline_cpi.rs`](./txline_cpi.rs) into your program. Self-contained: the wire
types are byte-identical to txoracle IDL v1.5.6, and `invoke_validate_stat_v3`
builds the instruction and decodes the `bool` the oracle returns.

```rust
mod txline_cpi;
use txline_cpi::*;

pub fn settle(ctx: Context<Settle>, outcome: u8, proof: MyProof) -> Result<()> {
    // VALUES come from the caller. The PREDICATE comes from YOUR account.
    let spec = &ctx.accounts.market.spec;

    let leaves = spec.legs.iter().zip(proof.values.iter())
        .map(|(leg, v)| StatLeaf {
            stat: ScoreStat { key: leg.key, value: *v, period: leg.period },
            stat_proof: vec![],          // v3: the multiproof replaces these
        })
        .collect();

    let verified = invoke_validate_stat_v3(
        &ctx.accounts.oracle_program,
        &ctx.accounts.oracle_roots,
        StatValidationInputV3 {
            ts: proof.ts,
            fixture_summary: proof.summary,
            fixture_proof: proof.fixture_proof,
            main_tree_proof: proof.main_tree_proof,
            event_stat_root: proof.event_stat_root,
            leaves,
            multiproof_hashes: proof.multiproof_hashes,
            leaf_indices: proof.leaf_indices,
        },
        spec.strategy_for(outcome),      // from YOUR state
    )?;

    require!(verified, MyError::OutcomeNotVerified);
    Ok(())
}
```

## The one rule

**Take the VALUES from the caller. Take the PREDICATE from your own account.**

If the caller supplies the predicate, they submit the one that suits them and the
"proof" proves whatever they wanted. The merkle proof only guarantees the *values*
are real; the binding between values and question is yours to enforce.

## Coverage — validate at CREATION, not at settlement

Every stat in `payload.leaves` must be referenced **exactly once** by the strategy:

| error | meaning |
|---|---|
| `DuplicateStatCoverage` (6070) | a stat evaluated twice |
| `IncompleteStatCoverage` (6071) | a stat left unevaluated |

Consequence: **a compound predicate's legs must read disjoint stats.**
`home win AND over 2.5 goals` both read goals P1/P2 — not expressible.
`home win AND over 9.5 corners` (goals + corners) — fine.

Check this when the market is created. Then 6070/6071 are impossible at settle
time, and a market that could never pay out can never be minted. ProofBook does it
in `ComboSpec::validate()`.

## Accounts

| account | notes |
|---|---|
| `oracle_program` | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` (devnet) |
| `oracle_roots` | `["daily_scores_roots", u16_le(epoch_day)]`, **read-only** |

`epoch_day = floor(proof.ts / 86_400_000)` — from the **proof's** timestamp, not
the wall clock. The oracle takes the roots account unconstrained, so
`invoke_validate_stat_v3` re-derives and checks it for you.

## Budget

A real 4-leg CPI consumed **176,632 CU**. Request ~1.4M and you have room.
