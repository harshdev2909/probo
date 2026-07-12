# ProofBook

**Fully on-chain, trustlessly-settled FIFA World Cup prediction markets on Solana.**

User funds are USDC. Markets are parimutuel. Outcomes are **not** resolved by an
admin key — they are resolved by CPI-ing into [TxLINE](https://txline.txodds.com)'s
on-chain `validate_stat` program, which cryptographically proves a match statistic
against a published daily Merkle root. If the oracle can't verify the claimed
outcome, the market cannot be settled. That trustless, verifiable settlement is the
whole point of the product.

This repository is the **blockchain layer + the keeper/indexer**: the Anchor
program, a bundled mock oracle for testing, unit + integration tests, and the
autonomous `keeper/` service that creates, locks, and settles markets with real
TxLINE proofs — no human action. No frontend yet.

---

## Table of contents

- [Architecture](#architecture)
- [The oracle adapter (trustless settlement)](#the-oracle-adapter-trustless-settlement)
- [Accounts & PDAs](#accounts--pdas)
- [Instructions](#instructions)
- [Settlement / CPI flow](#settlement--cpi-flow)
- [Determinism & safety](#determinism--safety)
- [Build](#build)
- [Run the tests](#run-the-tests)
- [Deploy to devnet](#deploy-to-devnet)
- [Swapping in the real TxLineAdapter](#swapping-in-the-real-txlineadapter)
- [The keeper / indexer (autonomous settlement)](#the-keeper--indexer-autonomous-settlement)
- [Project layout](#project-layout)

---

## Architecture

Two Anchor programs in one workspace:

| Program | Id (default keypair) | Role |
|---------|----------------------|------|
| `proofbook` | `4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63` | The market program. |
| `mock_oracle` | `F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u` | **Test-only** reproduction of TxLINE `validate_stat`, so the full settlement flow is testable without live TxLINE. |

`proofbook` never talks to TxLINE directly. It talks to an **`oracle_adapter`**
(`programs/proofbook/src/oracle/`) that exposes one clean interface —
`verify_outcome(market, claimed_outcome, proof_data) -> Result<bool>` — implemented
twice:

- **`TxLineAdapter`** — CPIs the real TxLINE program (ids in `docs/TXLINE_INTERFACE.md`).
- **`MockOracleAdapter`** — CPIs the bundled `mock_oracle`.

Both share a single CPI path (`invoke_validate_stat`) because TxLINE and the mock
have a **byte-identical wire interface** (same 8-byte discriminator, same argument
layout, same single account, same `bool` return). The active adapter is chosen by
the `mock-oracle` Cargo feature via the `ActiveOracle` type alias, so
`settle_market` calls `ActiveOracle::verify_outcome(..)` and never names a concrete
oracle. That sameness is deliberate: it is exactly what lets the real adapter drop
in **without changing any market or settlement code**.

> The confirmed TxLINE interface (program ids, `validate_stat` discriminator/args,
> the Merkle proof shape, PDA derivation, scores schema) — and the handful of
> items still unconfirmed from public docs — are documented in
> [`docs/TXLINE_INTERFACE.md`](docs/TXLINE_INTERFACE.md).

---

## The oracle adapter (trustless settlement)

TxLINE's `validate_stat` proves that a claimed `(key, value, period)` statistic is
present in TxLINE's published daily Merkle tree **and** evaluates a trader predicate
over the proven values, returning a `bool`. ProofBook maps each market outcome to a
predicate at creation time. For a 1X2 (home/draw/away) market on full-game goals
(`stat_a` = P1 goals, `stat_b` = P2 goals, `op = Subtract`, i.e. goal difference):

| Outcome | op | comparison | threshold | proves |
|---------|----|-----------|-----------|--------|
| Home win | `Subtract` | `GreaterThan` | `0` | P1 − P2 > 0 |
| Away win | `Subtract` | `LessThan` | `0` | P1 − P2 < 0 |
| Draw | `Subtract` | `EqualTo` | `0` | P1 − P2 = 0 |

At settlement the caller supplies only the **proven values and their Merkle
proofs**. The **predicate is fixed by the market's stored `OutcomeSpec`**, so a
caller cannot substitute a predicate that doesn't correspond to the claimed
outcome. The proof values must match TxLINE's published tree or the CPI fails.
This is the trustless binding.

---

## Accounts & PDAs

### `Market` PDA — `["market", authority, fixture_id (i64 LE), market_type (u8)]`
Stores: `fixture_id` (TxLINE fixtureId == match_id), `market_type`, `status`
(Open/Locked/Settled), `num_outcomes`, `winning_outcome`, `fee_bps`, `lock_time`,
trusted `oracle_program`, `usdc_mint`, `vault`, `total_pool`, `total_winning_pool`,
`fee_amount`, `settled_at`, `settle_proof_ref` (proof-receipt anchor), bumps, and a
`Vec<OutcomeState>` (each = an `OutcomeSpec` predicate + its running staked `pool`).

### `Position` PDA — `["position", market, owner]`
One per (market, user): `market`, `owner`, `outcome_index` (the single outcome this
position backs), `amount` (total staked), `claimed`, `bump`.

### Escrow vault — `["vault", market]`
An SPL token (USDC) account whose **authority is the Market PDA**. All stakes flow
in on `place_bet`; payouts flow out on `claim_winnings`, signed by the Market PDA.

### TxLINE daily roots (read-only, external) — `["daily_scores_roots", epoch_day (u16 LE)]`
Owned by the oracle program; `epoch_day = floor(ts_ms / 86_400_000)`.

---

## Instructions

| Instruction | Effect |
|-------------|--------|
| `initialize_market(fixture_id, market_type, outcome_options, fee_bps, lock_time, resolution_timeout, fee_treasury)` | Creates the Market PDA + USDC vault. Validates fee ≤ 10%, 2..=8 outcomes, `lock_time` in the future, `resolution_timeout > 0`, and per-outcome spec consistency. Binds the market to `ActiveOracle::program_id()` and records the fee treasury. |
| `place_bet(outcome_index, amount)` | Transfers `amount` USDC user → vault; creates/updates the Position; updates pools. Only while **Open** and before `lock_time`. Enforces the deposit's mint == the market USDC mint. Rejects zero amounts, out-of-range outcomes, and switching outcomes. |
| `lock_market()` | Open → Locked, permissionlessly, at/after `lock_time`. No bets after lock. |
| `settle_market(claimed_outcome, proof)` | **Flagship.** Locked → Settled **only if** `ActiveOracle::verify_outcome` returns `true` (CPI into `validate_stat`). No admin override. One-shot. If the proven outcome had **zero stake**, the market instead becomes **Cancelled/refundable** (no fee). Records the full Proof Receipt. |
| `claim_winnings()` | Pays a winner `stake / total_winning_pool * (total_pool − fee)` (u128, floored); the **final** claimer absorbs rounding dust so `Σ payouts == distributable` exactly. Rejects losers, double claims, and claims before settlement. |
| `cancel_market()` | **Liveness escape hatch.** Locked → Cancelled, permissionlessly, once `now > lock_time + resolution_timeout`. Purely time-triggered — sets **no** winner. |
| `claim_refund()` | On a Cancelled market, returns each user's **exact** stake (no fee); marks the position claimed; rejects double-refund. |
| `withdraw_fees()` | Pushes the accrued fee from the vault to `fee_treasury`. Settled markets only, once. Cancelled markets take **no** fee. |

Every instruction emits an event (`MarketInitialized`, `BetPlaced`, `MarketLocked`,
`MarketSettled`, `MarketCancelled`, `WinningsClaimed`, `RefundClaimed`,
`FeesWithdrawn`) for indexing and Proof Receipts. Full layouts, events, and the
Proof-Receipt reconstruction recipe are in
[`docs/ONCHAIN_INTERFACE.md`](docs/ONCHAIN_INTERFACE.md); the threat model and
findings are in [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md).

### Liveness, refunds & fees

- **Never-stuck funds.** If a match is abandoned/postponed or TxLINE never
  publishes a resolvable proof, anyone can `cancel_market` after the timeout and
  every bettor reclaims their exact stake via `claim_refund`. This is trustless:
  cancellation is a pure clock check and decides no outcome.
- **Exact accounting.** `Σ winner payouts + fee == total_pool` exactly; the vault
  settles to zero after all winners claim and the fee is withdrawn (the last
  claimer absorbs sub-unit rounding dust). Proven in unit + integration tests.
- **Fee treasury** is set at creation and can only ever receive the protocol fee,
  never user stakes.

---

## Settlement / CPI flow

```
  settler ──► proofbook::settle_market(claimed_outcome, proof)
                 │  require status == Locked            (never re-settlable)
                 │  require oracle_program == market.oracle_program == ActiveOracle::program_id()
                 │  build validate_stat args from:
                 │     • market.outcomes[claimed_outcome]  (predicate: keys/op/comparison/threshold)
                 │     • proof                              (proven values + Merkle proofs)
                 ▼
              CPI  validate_stat(ts, fixture_summary, fixture_proof,
                                 main_tree_proof, predicate, stat_a, stat_b, op)
                 │      account: daily_scores_merkle_roots  (PDA for floor(ts/DAY))
                 ▼
        TxLINE / mock  ── verifies Merkle proofs vs the published daily root,
                          evaluates the predicate, returns `bool` via return data
                 │
                 ▼
   get_return_data() ─► true  → status = Settled, winning_outcome set, proof_ref recorded
                        false → ProofbookError::OutcomeNotVerified (refuse to settle)
                        err   → CPI error propagates (refuse to settle)
```

Both a `false` return and any CPI error mean "not verified" — the market stays
Locked. There is no code path that settles without the oracle's `true`.

---

## Determinism & safety

- **Checked math everywhere.** Pool updates use `checked_add`; payout math uses
  `u128` intermediates and floors division (`programs/proofbook/src/math.rs`), so no
  overflow/underflow and the vault can never be drained below the distributable
  amount. Dust (from flooring) and the protocol fee remain in the vault.
- **Zero-winning-pool** is guarded: `claim_winnings` errors rather than dividing by
  zero (and by construction no position can be a winner if the winning pool is 0).
- **PDA-driven authority.** The vault is owned by the Market PDA; payouts are signed
  by PDA seeds. No admin key can move funds or set outcomes.
- **State machine.** Can't bet after lock, can't lock early, can't settle before
  lock, can't settle twice, can't claim before settle, can't claim twice, losers
  can't claim.

---

## Build

Requires the Solana (Agave) toolchain and Anchor 1.0.2 (`anchor --version`).

```bash
# test/dev build — default features include `mock-oracle` (settles via mock_oracle)
anchor build

# production build — real TxLineAdapter, TxLINE devnet oracle id
anchor build -- --no-default-features
# ...or TxLINE mainnet oracle id
anchor build -- --no-default-features --features mainnet
```

> Fail-safe: if a `mock-oracle` build is ever shipped to a real cluster, its markets
> trust the mock program id (which isn't deployed there), so settlement CPIs simply
> fail — they can never settle to a wrong outcome.

---

## Run the tests

### Unit tests (Rust — payout math, fees, rounding/dust, zero-winning-pool, overflow)

```bash
cargo test -p proofbook --lib
```

### Integration tests (TypeScript — full lifecycle against a local validator)

**One command (recommended):**

```bash
anchor test --validator legacy
```

Anchor 1.0's default test runner is `surfpool`, whose `requestAirdrop` behaviour
hangs this suite; `--validator legacy` runs the exact same build/deploy/test flow
against a `solana-test-validator` instead, and the suite passes cleanly. (Bare
`anchor test` is therefore not supported on this toolchain — use the flag.)

**Equivalent, self-contained runner** (starts its own validator with both programs
preloaded; used for CI and for `make test-integration`):

```bash
./scripts/test-integration.sh      # or: make test-integration
```

The suite (`tests/proofbook.ts`, describes **A–G**) covers:

- **A** happy path: initialize → 4 users bet different outcomes → **mint
  validation** (foreign mint rejected) → lock → settle via a valid mock proof →
  winners claim exact pro-rata USDC (vault → fee) → losers get nothing → no
  double-claim → **withdraw_fees** to treasury, vault → 0, no double-withdraw.
- **B** settlement rejected: tampered Merkle proof; valid proof that doesn't
  satisfy the claimed outcome; then a correct settle.
- **C** liveness: refuse cancel before timeout → **cancel by a random signer**
  after timeout (no winner) → refuse settle/re-cancel → **exact-stake refunds**,
  vault → 0, no double-refund.
- **D** zero-winning-pool: a verified-but-unstaked outcome becomes refundable
  (no fee); all bettors refunded.
- **E** everyone bets the winner + awkward stakes: `Σ payouts == distributable`
  exactly (dust absorbed), vault → 0 after fee withdrawal.
- **F** overflow guard: a near-`u64::MAX` stake is accepted without truncation; a
  further overflowing bet reverts.
- **G** illegal-transition matrix: cancel-Open, refund-non-cancelled,
  claim-before-settle.

> The TS proof builder (`tests/helpers.ts`) reproduces the mock's exact keccak +
> borsh leaf/-node scheme so the on-chain Merkle verification succeeds.

---

## Deploy to devnet

> **Live on devnet:** `proofbook` is deployed at
> **`4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63`**
> (latest upgrade tx `msdFmxFZHmwXqcBsAvWDMHDKoX4CfqNfc9mawDFB1yfsriwDeCo6ns1rxvG8QCyEUBvHLra8NZ8j3zHDKfVDz1f`,
> upgrade authority `8Hfn9BsxYgaxJoDk3sDBBEZ65H79oTMYo7mkLSjhFzH1`). It is the
> production (`TxLineAdapter` → **`validate_stat_v2`**, TxLINE devnet oracle
> `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`) build.
> View: <https://explorer.solana.com/address/4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63?cluster=devnet>
>
> **✅ Proven with a REAL trustless settlement (no mock):** finalised World-Cup
> fixture `18193785` (final 1–4 → Away) was settled on devnet by CPI-ing the LIVE
> `validate_stat_v2` with TxLINE's real Merkle proof —
> settle tx `3GptFFBGbZpkSezLx3aTbNHome6gSjKEywiqoKfRsgujwFbTHnJuBVD4NdmLzGsR6DfqvkBiWoEW6XRsNNDNXAoP`,
> claim tx `3HuhfQujHKuKzRG9uZ2hbx39HqcBd4EUmhLyc6LVbhVVFBXkpT3wphAiLPZJ1UnP6RYXw6vrpbKvjSEhiLH1w5pf`.
> Reproduce with `scripts/settle-real-devnet.ts` (see below).

The workspace wallet (`~/.config/solana/id.json`) must hold devnet SOL
(`solana airdrop 2 --url devnet`). Program ids are fixed by the keypairs in
`target/deploy/`.

```bash
# 1) build the production (real-adapter) binary
anchor build -- --no-default-features

# 2) deploy proofbook to devnet
solana program deploy target/deploy/proofbook.so \
  --program-id target/deploy/proofbook-keypair.json \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/id.json

# proofbook program id: 4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63
```

(Deploying `mock_oracle` to devnet is optional and only useful for a mock-settled
demo: `solana program deploy target/deploy/mock_oracle.so --program-id target/deploy/mock_oracle-keypair.json --url devnet`.)

---

## Swapping in the real TxLineAdapter

Nothing in the market or settlement code references TxLINE. To go live:

1. Build with `--no-default-features` (selects `TxLineAdapter` → `ActiveOracle`).
2. Confirm the items under **UNCONFIRMED** in `docs/TXLINE_INTERFACE.md` against
   TxLINE devnet (leaf hashing algorithm, node-combination rule, root publication
   timing). These live entirely inside the oracle; no other code changes.
3. Markets created by this build store `market.oracle_program = TXLINE_DEVNET`
   (or `TXLINE_MAINNET` with `--features mainnet`); `settle_market` validates the
   CPI target against it.

A future keeper service fetches proofs from
`GET https://txline.txodds.com/api/scores/stat-validation` (see
`docs/TXLINE_INTERFACE.md` §4) and submits `settle_market`.

---

## Real devnet settlement (the demo centrepiece)

`scripts/settle-real-devnet.ts` runs the whole thing against the **live** devnet
TxLINE oracle — no mock. It: (1) gets a guest JWT, (2) does the **free** World-Cup
subscribe on-chain (`subscribe(serviceLevelId=1, weeks=4)`, Token-2022) + activates
an `X-Api-Token`, (3) fetches a real `stat-validation` proof, (4)
`initialize_market → place_bet → lock_market`, (5) `settle_market` **CPI-ing the
live `validate_stat_v2`** with the real proof, (6) `claim_winnings`, then prints the
Proof Receipt.

```bash
# deploy the production (real-adapter) build first:
anchor build -- --no-default-features && \
solana program deploy target/deploy/proofbook.so \
  --program-id target/deploy/proofbook-keypair.json --url devnet

# then settle a real finalised fixture (statKeys 1,2 return the finalised result):
ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
ANCHOR_WALLET="$HOME/.config/solana/id.json" \
FIXTURE_ID=<finalised fixtureId> SEQ=<seq> STAT_KEYS=1,2 MARKET_TYPE=1 \
NODE_OPTIONS='--no-experimental-strip-types' \
  npx ts-node scripts/settle-real-devnet.ts
```

The free tier only covers World Cup / International Friendlies, so a *finalised*
covered fixture must exist (`period:100` in the returned stats = game_finalised).
The verified run above used fixture `18193785` (final 1–4). No TxL purchase is
needed — service level 1 is priced at 0.

---

## The keeper / indexer (autonomous settlement)

`keeper/` is the off-chain brain that makes the demo prove **"nobody clicked
resolve"**. It ingests TxLINE's live feed, auto-creates World-Cup markets, locks
them at kickoff, and settles them with **real cryptographic proofs** — fully
autonomously. It also indexes everything into a small read API for the frontend.

What it does, end to end:

1. **Session management** — guest JWT → free World-Cup on-chain `subscribe`
   (Token-2022, level 1 @ price 0) → `/api/token/activate` → apiToken. Persisted;
   JWT auto-renews on 401, apiToken re-subscribes on 403. Never crashes on expiry.
2. **Fixture sync → market creation** — pulls the World-Cup schedule and
   idempotently `initialize_market`s each fixture (PDA derived + checked on-chain
   first; restart-safe). `lock_time` = kickoff.
3. **Live SSE ingestion** — `/api/scores/stream` with exponential-backoff
   reconnect, `Last-Event-ID` resume, inline JWT renewal, and per-event logging.
4. **Lock trigger** — a 5s sweeper locks markets at/after `lock_time`.
5. **Auto-settlement (flagship)** — on a `statusId=100` (game_finalised) record it
   fetches the real `/scores/stat-validation` proof and submits `settle_market`
   (CPI into the live `validate_stat_v2`). Bounded exponential retry for
   `RootNotAvailable` / proof-not-ready; idempotent (re-checks on-chain status);
   escalates to a loud ERROR state when the budget is exhausted. The
   **time-based cancel backstop** fires past `lock_time + resolution_timeout` so
   funds are never stuck. Emits a structured **Proof Receipt** per settlement.
6. **Read API** (default `:8787`) — `GET /markets`, `GET /markets/:pda`,
   `GET /fixtures/:id/live`, `GET /receipts/:marketPda`, `GET /positions/:wallet`,
   and `GET /stream` (SSE pushing `score` / `market` / `receipt` / `log` events).
   Markets include pool totals and crowd-implied odds.
7. **Replay mode** — replays a **recorded real fixture** (committed at
   `keeper/fixtures/18193785.json`: 1,108 real feed events + the real finalised
   record + its real proof) with time compression, so the whole lifecycle runs
   on demand in ~90 seconds, offline, deterministically.

### Run it

```bash
# THE demo one-command: full autonomous lifecycle on a local validator
# (create → bets → auto-lock → live replay → auto-settle via oracle CPI → claim):
yarn keeper:e2e

# replay mode manually (local validator with mock adapter must be running):
yarn keeper:replay keeper/fixtures/18193785.json --speed 600

# live mode (devnet + real TxLINE; production-build program deployed):
RPC_URL=https://api.devnet.solana.com KEEPER_WALLET=~/.config/solana/id.json \
  yarn keeper:live

# record a new replay fixture from a real covered match:
yarn keeper:capture <fixtureId> <epochDay>
```

Env vars (all optional, sane defaults): `RPC_URL`, `KEEPER_WALLET`, `USDC_MINT`
(auto-created + persisted if unset), `FEE_TREASURY`, `FEE_BPS`,
`RESOLUTION_TIMEOUT_SEC`, `KEEPER_API_PORT`, `TXLINE_API`, `COMPETITION_ID`,
`REPLAY_FILE`, `REPLAY_SPEED`, `REPLAY_LOCK_DELAY_SEC`, `SETTLE_MAX_ATTEMPTS`,
`LOG_JSON`, `LOG_LEVEL`.

The keeper's structured logs are demo material — every SSE event, every tx,
every retry is logged, ending in:
`SETTLED — trustlessly, via oracle proof. no human clicked resolve.`

---

## Project layout

```
programs/
  proofbook/
    src/
      lib.rs                     # program entry + instruction wiring
      constants.rs               # seeds, limits, TxLINE ids & discriminator
      error.rs                   # ProofbookError
      state.rs                   # Market, Position, OutcomeSpec/State, MarketStatus
      events.rs                  # emitted events
      math.rs                    # parimutuel payout math + unit tests
      oracle/mod.rs              # oracle_adapter: wire types, CPI, TxLine/Mock adapters
      instructions/              # initialize_market, place_bet, lock_market,
                                 #   settle_market, claim_winnings, cancel_market,
                                 #   claim_refund, withdraw_fees
  mock_oracle/
    src/lib.rs                   # test-only validate_stat + publish_daily_root
tests/
  helpers.ts                     # keccak/borsh Merkle proof builder + PDAs
  proofbook.ts                   # full integration suite (describes A–G)
keeper/                          # autonomous keeper/indexer (workspace package)
  src/
    core/                        # orchestrator, market manager, settler
    txline/                      # session/auth, REST, SSE, replay feed
    chain/                       # proofbook client, PDAs, mock-proof builder
    api/server.ts                # read API (HTTP + SSE) for the frontend
    capture.ts, index.ts         # fixture recorder + CLI
  fixtures/18193785.json         # committed REAL recorded fixture + real proof
  test/e2e.test.ts               # autonomous-lifecycle E2E (yarn keeper:e2e)
  scripts/e2e.sh                 # boots validator + runs the E2E (demo command)
scripts/
  test-integration.sh           # deterministic integration test runner
  settle-real-devnet.ts         # REAL devnet settlement (proven)
docs/
  TXLINE_INTERFACE.md            # verified TxLINE interface + unconfirmed items
  SECURITY_AUDIT.md              # threat model + findings (Tier 2)
  ONCHAIN_INTERFACE.md           # account/instruction/event contract + Proof Receipt
Makefile                         # make build / test / deploy-devnet
```

---

## The web app (`web/`)

A handcrafted Next.js frontend on top of the keeper API. Dark-first, built from
the design system in [`DESIGN.md`](DESIGN.md) (squares + quarter-circles, ink &
bone, one brass accent — see the living `/styleguide` route). Surfaces: editorial
landing with a real settled Proof Receipt, the match board (real national flags,
live SSE scores, crowd-implied odds), market detail + bet slip (wallet-adapter,
honest tx states), portfolio with claims, the Proof Receipt certificate with an
independent on-chain VERIFY, the keeper wire, a designed 404, and a football
cursor (fine pointers only; fully reduced-motion aware).

```bash
# full demo stack — validator + autonomous keeper (replay) + web:
./scripts/demo.sh          # then open http://localhost:3000

# web app alone (expects keeper API on :8787):
cd web && npm run dev

# env (web/.env.local):
#   NEXT_PUBLIC_KEEPER_API=http://localhost:8787
#   NEXT_PUBLIC_RPC=http://127.0.0.1:8899   # devnet URL for live mode
```

---

## The real tournament (`demo:seed`)

The product ships populated with the **actual** World Cup: every fixture TxLINE
reports, real teams, real groups, real bracket — and every match that can still be
proven is settled on devnet by a **real merkle proof**, not by an admin.

```bash
npm run demo:seed     # coverage -> markets -> liquidity -> backfill settlement
```

One idempotent command, four steps:

| step | what it does |
|---|---|
| `coverage` | asks TxLINE which fixtures it can still **prove**; writes [`docs/COVERAGE.md`](docs/COVERAGE.md) + `keeper/data/plan.json` |
| `seed:markets` | one market per fixture, each pinned to the stat period its own proof needs (5 / 10 / 13 / 100) |
| `seed:liquidity` | stakes all three outcomes **atomically** from three demo wallets |
| `backfill` | locks and settles every provable fixture by CPI into the live TxLINE oracle |

### Why liquidity has to exist before settlement

`settle_market` routes a market with a **zero-stake winning outcome** to
`Cancelled (refundable)` — correct, since there is nobody to pay. But it means an
unbet market can never reach `Settled`, and so never earns a Proof Receipt. The
three bets are placed in a single transaction so a market can never end up
half-booked with one outcome left empty.

Stakes are seeded from the fixture id, so the book is identical on every run. The
weights never look at the true result, so the crowd is wrong about as often as a
real crowd is — which is the point: the crowd is an opinion, the proof is not.

### Configuration (`keeper/.env`)

The keeper reads `keeper/.env` for the store and the market generation, so a plain
`npm run keeper:live` finds the seeded tournament. Explicit env always wins, so the
local-validator demo is unaffected.

```ini
KEEPER_DATA_DIR=keeper/data/devnet
MARKET_TYPE=3          # generation the seeder WRITES to
MARKET_TYPES=3,4       # generations the reader SURFACES
```

Devnet keeps every market ever created and they cannot be deleted, so generations
accumulate. The reader takes an allowlist and shows **one market per fixture** — a
settled market always beats an unsettled duplicate. Point the keeper at the wrong
generation and it serves markets with no teams and no pools, which looks like a
frontend bug but is really a config mismatch.

### Honest gaps — the rule we do not break

TxLINE keeps the data needed to prove a score for a limited window (~23 days).
Older fixtures fall outside it. For those matches we show the fixture and say
plainly that it cannot be proven.

**We never fabricate a receipt, a scoreline, or an admin settlement to fill the
hole.** A single invented receipt would falsify the only claim this product makes.
So the group tables count unprovable matches as unplayed and label themselves
`N/6 proven`, the bracket leaves those ties blank, and the Receipt Gallery lists
them under *"No receipt · and we won't pretend otherwise"*.

The headline number, and the honest remainder, live in
[`docs/COVERAGE.md`](docs/COVERAGE.md) — regenerated on every run, with the
settle-transaction signature for every fixture.
