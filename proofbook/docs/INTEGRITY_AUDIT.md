# Integrity Audit — every receipt, machine-verified

> Generated 2026-07-13T14:20:00.655Z by `npm run audit`.
> Nothing below was eyeballed. Re-run it yourself.

## The claim under audit

Every receipt is a real TxLINE merkle proof, verified on-chain. Zero fabricated.

## Per-receipt verification

| verdict | meaning | count |
|---|---|---|
| **VERIFIED_LIVE** | predicate read from chain, proof re-fetched from TxLINE, **TxLINE's own program re-adjudicated it by simulation and returned true** | **419** |
| **VERIFIED_TX** | TxLINE's ~23-day retention has expired for the fixture; the settle transaction on chain shows the txoracle CPI invoked and succeeding | **0** |
| **FAIL** | neither — a P0 bug | **0** |

### By market type

| type | live | tx | fail |
|---|---|---|---|
| 3 | 75 | 0 | 0 |
| 4 | 1 | 0 | 0 |
| 28 | 25 | 0 | 0 |
| 29 | 24 | 0 | 0 |
| 30 | 36 | 0 | 0 |
| 31 | 30 | 0 | 0 |
| 32 | 32 | 0 | 0 |
| 33 | 29 | 0 | 0 |
| 34 | 28 | 0 | 0 |
| 35 | 30 | 0 | 0 |
| 36 | 23 | 0 | 0 |
| 37 | 32 | 0 | 0 |
| 38 | 26 | 0 | 0 |
| 39 | 28 | 0 | 0 |

## Global checks

| check | result | detail |
|---|---|---|
| Allowlist airtight — no dead-generation market in the DB | ✅ PASS | allowlist [3,4,28,29,30,31,32,33,34,35,36,37,38,39], 0 rows outside it |
| No receipt settled against the mock oracle | ✅ PASS | every receipt's on-chain oracle is the real txoracle |
| No scoreline without a proof | ✅ PASS | provenP1/P2 are null on every non-proven fixture |
| Gap fixtures have no receipt | ✅ PASS | every no_proof fixture shows: no receipt, no score |
| Reconciliation — settled on chain == receipts in DB | ❌ FAIL | on chain but no DB receipt: 294; in DB but not settled on chain: 0 |

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
