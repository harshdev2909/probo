# Integrity Audit — every receipt, machine-verified

> Generated 2026-07-13T14:55:30.095Z by `npm run audit`.
> Nothing below was eyeballed. Re-run it yourself.

## The claim under audit

Every receipt is a real TxLINE merkle proof, verified on-chain. Zero fabricated.

## Per-receipt verification

| verdict | meaning | count |
|---|---|---|
| **VERIFIED_LIVE** | predicate read from chain, proof re-fetched from TxLINE, **TxLINE's own program re-adjudicated it by simulation and returned true** | **713** |
| **VERIFIED_TX** | TxLINE's ~23-day retention has expired for the fixture; the settle transaction on chain shows the txoracle CPI invoked and succeeding | **0** |
| **FAIL** | neither — a P0 bug | **0** |

### By market type

| type | live | tx | fail |
|---|---|---|---|
| 3 | 75 | 0 | 0 |
| 4 | 1 | 0 | 0 |
| 28 | 54 | 0 | 0 |
| 29 | 54 | 0 | 0 |
| 30 | 56 | 0 | 0 |
| 31 | 53 | 0 | 0 |
| 32 | 54 | 0 | 0 |
| 33 | 53 | 0 | 0 |
| 34 | 52 | 0 | 0 |
| 35 | 52 | 0 | 0 |
| 36 | 53 | 0 | 0 |
| 37 | 52 | 0 | 0 |
| 38 | 52 | 0 | 0 |
| 39 | 52 | 0 | 0 |

## Global checks

| check | result | detail |
|---|---|---|
| Allowlist airtight — no dead-generation market in the DB | ✅ PASS | allowlist [3,4,28,29,30,31,32,33,34,35,36,37,38,39], 0 rows outside it |
| No receipt settled against the mock oracle | ✅ PASS | every receipt's on-chain oracle is the real txoracle |
| No scoreline without a proof | ✅ PASS | provenP1/P2 are null on every non-proven fixture |
| Gap fixtures have no receipt | ✅ PASS | every no_proof fixture shows: no receipt, no score |
| Reconciliation — settled on chain == receipts in DB | ✅ PASS | 713 settled markets == 713 receipts, both directions |

## What "no fabricated data" rests on, structurally

- **No admin settlement exists.** The program's only paths out of `Locked` are a
  successful oracle CPI (`settle_market`/`settle_market_v3`) or the time-based,
  permissionless `cancel_market`, which sets no winner and only unlocks refunds.
- **The mock oracle cannot settle real markets.** Each market records its trusted
  oracle at creation; production builds compile the TxLINE adapter (the mock id is
  absent from the binary), and this audit asserts every receipt's on-chain oracle
  is the real txoracle.
- **Scores come from proofs.** The projection writes `provenP1/P2` only when the
  fixture's proof status is `proven`; the feed's sampled score never lands in a
  receipt. Checked above.
- **Teams come from TxLINE.** Fixture names are TxLINE participant strings;
  the UI maps names to flags/codes for display and marks unknown teams as unknown
  rather than guessing.
- **Unprovable is unprovable.** Fixtures outside retention are `no_proof`: no
  receipt, no score, a stated reason. Checked above.
