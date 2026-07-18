# ProofBook — Technical Documentation

A fully on-chain, trustlessly-settled FIFA World Cup prediction market on Solana devnet.
No admin key settles a market: the program moves no money until TxLINE's own on-chain
oracle verifies a Merkle proof of the result, by CPI, inside the same transaction that
pays out. If the proof does not verify, nobody is paid.

- **Program:** `4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63` (devnet)
- **SDK:** [`@h4rsharma/txline-settle`](https://www.npmjs.com/package/@h4rsharma/txline-settle) (MIT)
- **App:** https://probo-5xn6.vercel.app

This document describes how the system is built. For the product pitch and the "verify it
yourself" quickstart, see [`README.md`](README.md).

---

## 1. System overview

ProofBook is five cooperating pieces around one Anchor program. The organising principle is
a hard **writer/reader split**: exactly one process holds signing authority and mutates
state; everything else is stateless and read-only.

```
  TxLINE API + on-chain oracle
        │  (SSE scores, REST proofs, on-chain daily Merkle roots)
        ▼
  ┌───────────┐   settle CPI    ┌──────────────────┐
  │  KEEPER   │────────────────▶│  proofbook       │  Solana program
  │ (writer)  │                 │  (+ mock_oracle) │  the only authority over funds
  └─────┬─────┘                 └──────────────────┘
        │ writes                          ▲
        ▼                                 │ read accounts / simulate CPI
  ┌───────────┐   LISTEN/NOTIFY    ┌───────────┐        ┌──────────────┐
  │ Postgres  │◀──────────────────▶│   API     │◀──────▶│  web (Next)  │
  │ (Prisma)  │   (reader only)    │ (Fastify) │  REST  │  browser     │
  └───────────┘                    └───────────┘  +SSE  └──────────────┘
                                                              │ sign+broadcast
                                                              ▼  via /api/rpc proxy
                                                          Solana devnet
```

| Component | Path | Role | Holds secrets? |
| --- | --- | --- | --- |
| **Program** | `proofbook/programs/proofbook` | On-chain settlement, escrow, payout math | — (no admin key exists) |
| **Mock oracle** | `proofbook/programs/mock_oracle` | Test/dev CPI target with the same v2/v3 ABI as TxLINE | — |
| **Keeper** | `proofbook/keeper` | Autonomous off-chain brain: create → lock → settle → cancel | **Yes** — market + mint authority |
| **API** | `proofbook/api` | Stateless read layer + devnet faucet | Only a faucet wallet (valueless token) |
| **SDK/CLI** | `proofbook/sdk` | Published settlement core + independent verifier | — (verifier trusts nothing) |
| **Web** | `proofbook/web` | Next.js frontend | — (`NEXT_PUBLIC_*` only) |
| **DB** | `proofbook/db` | Prisma schema + client | — |
| **Shared** | `proofbook/shared` | Import-light types + market registry | — |

The repo is an npm-workspaces project (`keeper`, `sdk` are workspaces; `api`, `db`, `shared`,
`web` are path-imported). The whole thing lives under `proofbook/`, one level below the git
root, because Vercel is linked at the repo root and Railway watches `proofbook/**`.

---

## 2. The on-chain program

Anchor 0.32-era program. Source in `programs/proofbook/src`, ~2000 lines. Money is USDC
(6-decimal SPL token) held in a per-market PDA vault. All arithmetic is `u128`-intermediate,
checked, and flooring (dust stays in the vault).

### 2.1 Accounts (state)

| Account | Seeds | Purpose |
| --- | --- | --- |
| `Market` | `["market", authority, fixture_id (u64 LE), market_type (u8)]` | One prediction market: pools, lifecycle, and the Proof Receipt |
| `vault` (SPL TokenAccount) | `["vault", market]` | USDC escrow, authority = the market PDA |
| `Position` | `["position", market, owner]` | One bettor's stake on one outcome |
| `ComboSpec` | `["combo", market]` | Sidecar predicate for compound (multi-leg) markets |
| `PropVault` | `["prop_vault", depositor, vault_id (u64 LE)]` | Parametric insurance vault |
| `daily_scores_roots` | `["daily_scores_roots", epoch_day (u16 LE)]` **on the oracle program** | TxLINE's published daily Merkle root — the CPI reads this |

`Market` is deliberately **frozen** in layout: ~226 accounts already exist on devnet,
including settled ones holding Proof Receipts, and changing byte offsets would corrupt them.
`Market::space(num_outcomes)` sizes each account to the outcomes it actually has (derived from
`INIT_SPACE`, so it can't drift), rather than always reserving `MAX_OUTCOMES = 12` slots.

Key sentinels/limits (`constants.rs`): `MAX_OUTCOMES = 12`, `MIN_OUTCOMES = 2`,
`MAX_LEGS = 5` (TxLINE rejects >5 stat keys per proof), `UNSET_OUTCOME = u8::MAX`,
`MAX_FEE_BPS = 1000` (10%), `BPS_DENOMINATOR = 10_000`, `COMBO_MARKET_TYPE_MIN = 16`.

### 2.2 Lifecycle & instructions

```
  Open ──lock_market──▶ Locked ──settle_market / settle_market_v3 (winner pool > 0)──▶ Settled
                          │                    (winner pool == 0)──▶ Cancelled (refundable)
                          └──cancel_market (after timeout)─────────▶ Cancelled (refundable)
```

`Settled` and `Cancelled` are terminal; no re-settle, no settle-after-cancel. Every state
gate is enforced per-instruction.

| Instruction | Signer | Gate | Effect |
| --- | --- | --- | --- |
| `initialize_market` | authority | fee ≤ max, 2–12 outcomes, lock in future, valid specs | Create Market PDA + vault, bind oracle + fee treasury |
| `place_bet(outcome, amount)` | bettor | Open, `now < lock_time` | Escrow USDC into vault, grow pools + Position (one outcome per position) |
| `lock_market` | anyone | Open, `now ≥ lock_time` | Open → Locked (permissionless crank) |
| `settle_market(outcome, proof)` | anyone | Locked, `market_type < 16` | **Flagship v2 path.** CPI-verify outcome → Settled + Proof Receipt |
| `initialize_combo_spec(legs, outcomes)` | authority | Open, structurally valid | Attach compound predicate sidecar |
| `settle_market_v3(outcome, proof)` | anyone | Locked, `market_type ≥ 16` | Compound settle: every leg in one `validate_stat_v3` CPI |
| `claim_winnings` | winner | Settled | Pro-rata parimutuel payout, one-shot per position |
| `cancel_market` | anyone | Locked, `now > lock_time + timeout` | Liveness escape hatch → Cancelled (no winner set) |
| `claim_refund` | user | Cancelled | Reclaim exact stake, no fee, one-shot |
| `withdraw_fees` | anyone | Settled, once | Push accrued fee to treasury |
| `initialize_prop_vault(...)` | depositor | valid predicate, beneficiary ≠ depositor | Escrow USDC against a compound predicate |
| `settle_prop_vault(proof)` | anyone | Funded, `now ≥ lock_time` | Proof decides: holds → beneficiary, fails → depositor |
| `cancel_prop_vault` | anyone | Funded, after timeout | Only non-proof path; can only refund depositor |

**Permissionlessness is the whole point.** `settle_market*` take a `cranker: Signer` who
"pays fees; has no special authority." Anyone holding a valid proof can settle any market;
the keeper gains nothing by being the one who does. The keeper's signature is not among the
things that authorise settlement — the proof is.

### 2.3 The settlement CPI (`oracle/mod.rs`)

Settlement is a CPI into an oracle program's `validate_stat_v2` / `validate_stat_v3`,
reading back a `bool` return value via `get_return_data()`. The `OracleAdapter` trait has two
implementations chosen at compile time by the `mock-oracle` Cargo feature:

- `TxLineAdapter` (real): CPIs deployed TxLINE. Program id `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` (devnet), `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` (mainnet, `mainnet` feature).
- `MockOracleAdapter` (test/dev): CPIs the bundled `mock_oracle` (`F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u`), which performs the *same* Merkle verification.

Both share a byte-identical wire ABI, so they funnel through one `invoke_validate_stat_*` and
differ only in the trusted program id. CPI discriminators are pinned constants
(`VALIDATE_STAT_V3_DISCRIMINATOR = [150,37,155,89,141,190,77,203]`, etc.).

**The trustless binding.** The caller supplies only *proven values* and Merkle material. The
resolution predicate — which stats, which comparisons, which thresholds — is fixed in the
market's stored spec (`OutcomeSpec` for v2, `ComboSpec` for v3) and cannot be substituted. In
v3 the caller cannot even choose which stats are proven: leaf `i`'s `(key, period)` come from
`combo.legs[i]`, and the program builds the leaf itself from the spec's key and the caller's
value. The daily-root account is checked to be the PDA derived from the proof's timestamp
(`WrongDailyRootAccount` otherwise), and the CPI's return program is checked
(`OracleReturnMismatch`).

**v2 vs v3.** v3 takes the same `NDimensionalStrategy` but replaces v2's per-stat sibling
paths with one shared Merkle multiproof (`multiproof_hashes` + `leaf_indices`). Measured on a
real 4-leg proof (fixture 18218149): 22 proof nodes → 11. Legacy 1X2 markets (`market_type <
16`) must keep settling through v2 — `settle_market` refuses compound markets
(`ComboRequiresV3`) so a parlay can never settle on one leg, and `settle_market_v3` refuses
non-compound markets (`NotAComboMarket`).

### 2.4 Payout math (`math.rs`)

Parimutuel, pure, `u128`-intermediate, floored, unit-tested (10 Rust tests):

```
fee        = floor(total_pool * fee_bps / 10_000)
distributable = total_pool - fee
payout(stake) = floor(stake * distributable / total_winning_pool)
```

Flooring guarantees `Σ payouts ≤ distributable`, so the vault can never be drained; dust
stays behind. `claim_winnings` detects the **last claimer** (`winning_stake_claimed + stake ==
total_winning_pool`) and gives it `distributable - paid_out` instead of its floored share, so
`Σ payouts == distributable` exactly and the vault settles to zero. The unit tests assert
solvency at every partial-claim step.

**Zero-winning-pool policy** (`record_settlement`): if the proven outcome had zero stake,
there is nothing to distribute — the market becomes refundable (routed to `Cancelled`, no fee)
rather than leaving funds stuck.

### 2.5 The Proof Receipt

On settlement, `record_settlement` writes a receipt into the `Market` account and emits
`MarketSettled`. This is the product's only claim, reconstructable and re-verifiable from
chain alone:

- `settle_proof_ref` — the events-subtree root proven at settlement
- `settle_proof_ts` — batch timestamp (Unix ms) whose daily root was checked
- `settle_epoch_day` — `floor(proof_ts / 86_400_000)`
- `settle_daily_roots` — the oracle PDA verified against
- `settle_resolver` — who submitted the winning proof (no special power)
- `winning_outcome`, `total_pool`, `total_winning_pool`, `fee_amount`, `settled_at`

### 2.6 Events

`MarketInitialized`, `BetPlaced`, `MarketLocked`, `MarketSettled` (the full receipt data
contract), `MarketCancelled` (reason `"timeout"` | `"zero_winning_pool"`), `WinningsClaimed`,
`RefundClaimed`, `FeesWithdrawn`, `ComboSpecCreated`, `PropVaultCreated`, `PropVaultResolved`.
Indexers can render everything from events without reading the PDAs.

### 2.7 Errors

`error.rs` defines a `ProofbookError` enum grouped by instruction. Notable ones tie directly
to TxLINE behaviour: `DuplicateLegCoverage` / `IncompleteLegCoverage` mirror TxLINE's `6070` /
`6071`; `OutcomeNotVerified` is the CPI returning `false`. The full list is the source of
truth for the on-chain failure surface.

---

## 3. The parametric prop vault

`prop_vault.rs` is the parlay machinery pointed at insurance instead of a pool. A depositor
escrows USDC against a fixed compound predicate ("Team A corners + Team B corners > 10").
Settlement is a single `validate_stat_v3` proof:

- predicate **holds** → whole balance to the beneficiary
- predicate **fails** → whole balance back to the depositor
- **nobody settles** → after `lock_time + resolution_timeout`, anyone refunds the depositor

No admin key on any path. `settle_prop_vault` is permissionless and the proof, not the caller,
decides where money goes. The predicate is validated at creation (every leg evaluated exactly
once — the same coverage invariant a `ComboSpec` lives by), so a vault that could never settle
can't be funded. `beneficiary != depositor` is enforced at creation: settlement passes both
token accounts as distinct writable accounts and the runtime rejects the same account twice
(`ConstraintDuplicateMutableAccount`, `2040`), so a self-hedge vault could only time out — the
program refuses to create it (`SelfHedgeVault`). `/vault` reads these directly from chain (not
from Postgres) so the page doesn't ask you to trust the database.

---

## 4. The keeper (autonomous off-chain brain)

`keeper/src`, orchestrated by `core/keeper.ts`. Two run modes, one pipeline:

- **`live`** — auth → fixture sync → market creation → SSE ingest → lock → settle, against
  devnet + TxLINE.
- **`replay`** — a recorded fixture, time-compressed, through the same pipeline against a
  local validator + mock oracle.
- **`capture <fixtureId> <epochDay>`** — brute-force scans an epoch day, finds the finalised
  (`statusId 100`) record, fetches the **real** proof, and writes a replay fixture.

Nothing requires human action: creation, locking, settlement, and the cancel backstop are all
automatic and idempotent.

> ⚠️ **Working-tree note:** `keeper/src/core/keeper.ts` is currently **empty** in the working
> tree (`git diff` shows 348 uncommitted deletions; `index.ts` imports `Keeper` from it, so
> `live`/`replay` will not start as-is). The committed `HEAD` version is intact. If this was
> accidental, restore it with `git checkout -- proofbook/keeper/src/core/keeper.ts`. Section
> 4 describes the committed version.

### 4.1 The main loop

- **Watching TxLINE is SSE, not polling.** `ScoresStream` on `GET /api/scores/stream` carries
  scores; a 10-minute REST `fixtures/snapshot` poll is only for *fixture discovery*. A second,
  independent `OddsStream` feeds display odds and never touches settlement.
- **Settlement trigger:** `ingest()` fires once per fixture when it first sees `statusId ===
  100` (finalised). A `statusId=100` record is never dropped as stale, even if its seq looks
  old. It then fires **both** settlers.
- **Two settlers, side by side, sharing nothing mutable:**
  - `Settler` (`core/settler.ts`) — the one 1X2 market per fixture, via v2.
  - `CatalogueSettler` (`core/catalogueSettler.ts`) — the rest of the catalogue (goals,
    corners, cards, parlays), each via `validate_stat_v3`. Bails immediately in mock/replay
    (v3 needs a real TxLINE proof). Walks *every* catalogue type and logs full disposition
    (`settled | cancelled | absent | due`) as proof of coverage. Caches one proof per distinct
    stat-key set.
- **Phase state machine** (`state.ts`): `created → locked → settling → settled | cancelled |
  error`. `created→locked` is the market sweeper; `locked→settling→settled` is the settler;
  the **cancel backstop** fires `→cancelled` when `now > lock_time + resolution_timeout` (even
  for `error` markets, so refunds always open).

### 4.2 Settlement mechanics

- **Idempotency first:** every attempt re-reads on-chain status before acting; an
  already-settled market backfills the proven scoreline onto the receipt and stops.
- **Provenance:** the receipt's `provenScore` comes from the Merkle proof, never the feed's
  sampled `Score` (which has been observed to disagree with the proof).
- **Never settle on a guess:** the v3 path computes the claimed outcome locally
  (`claimedOutcomeFor`) but that has *no authority* — the chain re-derives the predicate from
  the `ComboSpec` and re-proves it. A local `-1` (no outcome matched an exhaustive catalogue)
  throws rather than settles.
- **Retry/backoff:** exponential, `min(base * 2^(n-1), max)`, budget `SETTLE_MAX_ATTEMPTS`
  (12). `RootNotAvailable` / `InvalidStatProof` are retryable (roots land on batch boundaries,
  minutes after a match is API-provable); `AlreadyResolved` / `NotLocked` /
  `OracleAdapterMismatch` are fatal. `AlreadyResolved` is treated as success (the cancel
  backstop raced us).
- **v3 proof assembly** (`markets/v3proof.ts`, shared by live settler and backfiller):
  verifies leaf order matches `def.legs` (the load-bearing invariant — leg order *is* statKeys
  request order *is* the predicate index space), then assembles the anchor-shaped
  `SettlementProofV3`. The trustless binding is in what is *not* sent: values + Merkle material
  only, never the keys or predicate.

### 4.3 Distributed operation

- **Leader election** (`leader.ts`): a Postgres **session-level advisory lock** ensures only
  one keeper settles at a time. Three hard-won behaviours: (1) the lock must be taken on a
  **direct** connection, not through PgBouncer (`DIRECT_DATABASE_URL`, or strip `-pooler.`) —
  a pooler multiplexes the lock onto the wrong backend and both keepers believe they lead;
  (2) `run()` resolves *only* on acquisition, blocking as a follower otherwise; (3) a 15s
  verify loop re-asserts the lock and stands down (`process.exit(1)`) if the connection died.
- **Persistence** (`state.ts`, `pgstore.ts`): a `StoreLike` seam holds either a JSON `Store`
  (replay/local, debounced atomic writes) or `PgStore` (live). Crash recovery is by
  **idempotency anchors** not a journal — `marketPda` is deterministic from
  `(authority, fixtureId, marketType)`, so `ensureMarket` adopts an existing on-chain market
  if state was wiped.
- **Event bridge:** the keeper is the sole writer. It `INSERT`s a `feed_event` and `NOTIFY`s;
  every stateless API instance `LISTEN`s and fans out (see §5.3). The NOTIFY payload is the
  event **id only** (Postgres caps payloads at 8 KB).

### 4.4 TxLINE integration (`txline/`)

Two-token auth (`session.ts`): a short-lived **guest JWT** (`POST /auth/guest/start`) plus a
long-lived **apiToken** obtained by a *free on-chain World-Cup subscription* — create a
Token-2022 ATA, CPI `txoracle.subscribe(serviceLevelId, weeks)` at price 0, sign
`${txSig}::${jwt}` with NaCl, and `POST /api/token/activate`. Self-healing: **401 → renew JWT,
403 → re-subscribe** (conflating the two loops forever against a lapsed subscription).

Endpoints used (`client.ts`, all under `{TXLINE_API}/api`):

| Endpoint | Purpose |
| --- | --- |
| `POST /auth/guest/start` | guest session credential |
| `GET /fixtures/snapshot?competitionId=` | the tournament's fixtures |
| `GET /scores/snapshot/{fixtureId}` | find the finalised sequence |
| `GET /scores/stat-validation?fixtureId&seq&statKeys` | v2 Merkle proof |
| `GET /scores/stat-validation-v3?fixtureId&seq&statKeys` | **the v3 multiproof that settles** (1–5 keys) |
| `GET /scores/stream` (SSE) | live scores + the finalised trigger |
| `GET /odds/stream` (SSE) | demargined consensus odds — display only |
| on-chain `txoracle.validate_stat_v3` | the CPI that adjudicates every settlement |

Only stat keys 1–8 are used — the ones TxLINE can actually prove.

### 4.5 Configuration

Env is loaded from `keeper/.env` at import time and **never overrides already-set env**.
Full reference in `.env.example`; the ones that matter:

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | **Mode switch**: set → Postgres store + leader-elected worker |
| `DIRECT_DATABASE_URL` | strip `-pooler.` | Non-pooled connection for the advisory lock only |
| `RPC_URL` / `ANCHOR_PROVIDER_URL` | devnet public | Solana RPC (use a dedicated endpoint at scale) |
| `KEEPER_SECRET_KEY` | — | Market + mint authority (JSON array or base58). Takes precedence over a wallet file |
| `TXLINE_API` | `https://txline-dev.txodds.com` | oracle data API |
| `COMPETITION_ID` | `72` | World Cup competition id |
| `MARKET_TYPE` | `0` | generation the writer creates into |
| `MARKET_TYPES` | `=MARKET_TYPE` | CSV reader allowlist (devnet can't delete botched generations) |
| `FEE_BPS` | `500` | protocol fee (5%) |
| `RESOLUTION_TIMEOUT_SEC` | `21600` live / `600` replay | seconds after lock before the cancel backstop |
| `SETTLE_MAX_ATTEMPTS` / `_BASE_DELAY_MS` / `_MAX_DELAY_MS` | 12 / 30000 / 600000 (live) | retry budget + backoff |
| `ORACLE_MODE` | `txline` live / `mock` replay | which oracle the settle CPI targets |

`statKeys` is hardcoded `[1,2]` (P1/P2 goals) for the 1X2 settler. Other keys used elsewhere:
`ALLOW_MINT_AUTOCREATE`, `PRIORITY_FEE_MICROLAMPORTS` (default 20 000), `GIT_SHA`, `LOG_JSON`,
`LOG_LEVEL`.

---

## 5. The API (`api/src`)

Fastify 5, Postgres via Prisma, **stateless and read-only** by design — it never reads chain
on a request path and never writes, except the faucet. Listens on `PORT ?? API_PORT ?? 8787`,
host `0.0.0.0`.

### 5.1 Middleware

CORS (custom origin matcher supporting `*` and `https://*.vercel.app` globs, trailing-slash
tolerant), compression (`threshold 1024`), etag (conditional GETs for the polled board), and
rate limiting (`RATE_LIMIT_MAX ?? 300`/min, `/stream` allowlisted). `trustProxy: true` so the
limiter sees the real IP behind Railway. `unhandledRejection` / `uncaughtException` are logged,
not fatal — Neon's pooler drops idle connections outside any handler and that must not kill the
process.

### 5.2 Routes

| Method | Path | Purpose | Cache |
| --- | --- | --- | --- |
| GET | `/health` | Liveness; 503 if DB down (keeper down ≠ unhealthy) | — |
| GET | `/markets` | Market board (`stage`, `status`, `proofStatus`, `marketType`, `sort`, paged ≤200) | `max-age=5` |
| GET | `/markets/:pda` | One market | `max-age=5` |
| GET | `/markets/:pda/odds` | Sharp-vs-crowd time series | `max-age=15` |
| GET | `/fixtures/:id/live` | Live fixture state | — |
| GET | `/receipts/summary` | Headline: receipts by market type | `max-age=15` |
| GET | `/receipts` | Receipt gallery (`stage`, `marketType`, `fixtureId`, paged) | `max-age=30` |
| GET | `/receipts/:pda` | One receipt, or 404 if unsettled | `max-age=300` |
| GET | `/archive/:fixtureId` | Ordered settlement-replay timeline | 300 if settled else 5 |
| GET | `/positions/:wallet` | Wallet positions | `no-store` |
| GET | `/txline/credential` | Hands the browser verifier a TxLINE read token | `max-age=60` |
| GET | `/standings` | Group tables from proven results | `max-age=30` |
| GET | `/bracket` | Knockout bracket | `max-age=30` |
| GET | `/keeper/status` | Keeper liveness + faucet reserves | `no-store` |
| POST | `/faucet/:wallet` | Devnet demo funding (rate `FAUCET_RATE_MAX ?? 10`/min) | — |
| GET | `/stream` | SSE multiplexed feed (`?types=`, `?lastEventId=`) | `no-cache` |

Notable query logic (`queries.ts`): `getStandings` derives groups as **connected components of
the fixture graph** (no hand-typed table can be wrong); `getBracket` restricts to result market
types `{3,4,28}` so a corners-O/U `winningOutcome=0` ("Over") can't be misread as "home won"
and send the wrong team through; `projectPayout` mirrors the on-chain parimutuel math with the
fee off the losing pool.

### 5.3 SSE fan-out (`stream.ts`)

Because the keeper is the sole writer and the API is stateless, there is no in-process event
bus. `EventStream` opens a dedicated Postgres connection, `LISTEN`s on `proofbook_events`,
looks up each notified event id, and fans out to subscribers. Backlog replay: 50 fresh events,
500 when resuming by id. The SSE handler emits `retry: 3000`, a 25s `: ping` keepalive, and
`X-Accel-Buffering: no`.

### 5.4 Faucet privilege separation (`faucet.ts`)

The keeper's mint/market authority never leaves the keeper. The API holds a plain pre-funded
wallet that can only move a valueless devnet token plus a little SOL (bettors pay Position-account
rent). "If the API is compromised, an attacker drains a faucet — not the tournament." Limits:
10 000 USDC / grant, 0.02 SOL / grant, ceiling 5 000 USDC, max 5 grants, 30s cooldown, tracked
in `faucet_grants`.

### 5.5 The `/txline/credential` exception

The one place the API hands the browser something: `/verify` runs entirely in-browser and reads
nothing from the API for its verdict — except a TxLINE **read** token, which a browser cannot
mint (it requires an on-chain subscription the keeper holds). A forged proof served this way
would still *fail* verification, which is exactly what `--tamper` demonstrates.

---

## 6. Data model (`db/prisma/schema.prisma`)

PostgreSQL; client generated to `db/generated/client`. A Prisma singleton is cached on
`globalThis`. The LISTEN/NOTIFY channel `proofbook_events` is defined in `db/` so the keeper
needn't import the API to know the channel name.

Enums: `ProofStatus` (`proven | no_proof | upcoming`), `MarketStatus` (`open | locked | settled
| cancelled`).

| Model → table | PK | Notable fields / indexes |
| --- | --- | --- |
| `Team → teams` | `code` (3) | `name` unique, `iso`, `confed` |
| `Fixture → fixtures` | `id` (TxLINE fixture id) | `homeName`/`awayName` (raw TxLINE = source of truth), `stage`, `kickoffTs`, `proofStatus`, `provenP1`/`provenP2`, `finalisedSeq`; indexed on stage/kickoff/proofStatus |
| `Market → markets` | `pda` | `fixtureId`, `marketType`, `status`, `pools BigInt[]`, `winningOutcome?`, tx signatures; **`@@unique([fixtureId, marketType])`** |
| `Position → positions` | `pda` | `owner`, `outcomeIndex`, `amount`, `claimed` |
| `Receipt → receipts` | `marketPda` | `winningOutcome`, `provenP1`/`provenP2`, `epochDay`, `dailyRootsPda`, `proofRef`, `resolver`, `settleTx` |
| `FeedEvent → feed_events` | `id` (BigInt) | `type`, `payload Json`; indexed on `[type, createdAt]` — powers §5.3 |
| `OddsSnapshot → odds_snapshots` | `id` | `pools[]`, `consensusPct Float[]`, `bookmaker?` — display only |
| `KeeperRun → keeper_runs` | `id` (uuid) | `instance`, `isLeader`, `streamConnected`, heartbeats, `marketsSettled` |
| `FaucetGrant → faucet_grants` | `wallet` | `grants`, `totalUsdc`, `lastGrantAt` |
| `KeyValue → kv` | `key` | generic k/v (stores the TxLINE credential read by `/txline/credential`) |

Recurring invariant across the schema: **"absent is absent."** A scoreline is never written
without a proof (`Fixture.provenP1` — the feed's own sampled `Score` never lands here because
it has disagreed with the proof); a receipt never exists without a proof; a consensus odds
number is never invented when TxLINE published none.

> Two documented comments have drifted and are worth correcting when touched: `KeyValue`'s
> "never read by the API" (it is, by `getTxlineCredential`), and any lingering "13 market
> types" phrasing — the registry is 5 legacy (0–4) + 12 catalogue (28–39); see §7.

---

## 7. Market-type registry & stat encoding (`shared/`)

`shared/` is import-light by design (zero third-party imports) so `web/` can consume it under
Vercel's Root-Directory constraint. On-chain, `market_type` is an opaque tag — a PDA seed and
nothing more. `shared/markets.ts` holds *presentation*; the keeper's `markets/catalogue.ts`
holds the *predicates*, and asserts the two agree at import so a label can't drift from the
outcome it names.

**The live catalogue (types 28–39), each a consequence of what's provable:**

| Type | Name | Outcomes | Stat keys |
| --- | --- | --- | --- |
| 28 | Match Result | Home / Draw / Away | 1,2 |
| 29 | Total Goals O/U 2.5 | Over / Under | 1,2 |
| 30 | Total Corners O/U 9.5 | Over / Under | 7,8 |
| 31 | Total Cards O/U 3.5 | Over / Under (yellows only) | 3,4 |
| 32 | Both Teams To Score | Both / Home only / Away only / Neither | 1,2 |
| 33 | Clean Sheet | Home / Away / Both (0-0) / Neither | 1,2 |
| 34 | Half-Time Result | Home / Draw / Away | 1001,1002 |
| 35 | Winning Margin | Home 2+ / Home 1 / Draw / Away 1 / Away 2+ | 1,2 |
| 36 | Parlay: Home win & Over 9.5 corners | 2×2 grid | 1,2,7,8 |
| 37 | Parlay: Over 9.5 corners & Over 3.5 cards | 2×2 grid | 7,8,3,4 |
| 38 | Parlay: Over 2.5 goals & Over 3.5 cards | 2×2 grid | 1,2,3,4 |
| 39 | Parlay: Home win & Over 3.5 cards | 2×2 grid | 1,2,3,4 |

Types **0–4** are legacy 1X2 generations (the first 76 receipts). Types **16–27** are an
**abandoned** generation-1 catalogue: their `ComboSpec`s hardcoded `period=100`, but 58 of the
76 provable fixtures carry `period=5` (TxLINE keeps the `game_finalised` record only ~10 days,
so an older fixture's terminal record is a plain FT one). The program rebuilds each leaf from
the spec's `(key, period)`, so a spec saying 100 against a leaf saying 5 hashes differently and
the oracle rejects it (`InvalidStatProof`, 6023). The spec is immutable and devnet markets
can't be deleted, so `MARKET_TYPES` (the reader allowlist) is the only thing keeping the dead
generation off the site.

**Why the odd shapes:** BTTS is split four ways because "BTTS No" is an OR (unprovable) — pure
ANDs say the same thing. Winning Margin tiles every result because "Correct Score" needs an
"any other score" bucket, which isn't provable. Cards are yellows-only because a Binary op
combines exactly two stats. Parlay legs must read **disjoint stat families**: "Home win AND
over 2.5 goals" is impossible (both read goals), "Home win AND over 9.5 corners" is fine.

**Stat key encoding:** `statKey = period*1000 + base`. Base: 1/2 goals, 3/4 yellows, 5/6 reds,
7/8 corners (home/away). Period offset: full +0, H1 +1000, H2 +2000, ET1 +3000, ET2 +4000,
PE +5000 — hence type 34's `1001/1002` = half-time goals. Separately, the record-kind
`statPeriod` axis: 5 = FT, 10 = AET, 13 = pens, 100 = game_finalised. No event timing and no
player stats are provable ("next goal", "goal before minute X", player props are out).

---

## 8. The SDK & CLI (`@h4rsharma/txline-settle`)

The published, MIT-licensed settlement core. The keeper imports it rather than keeping a
private copy, so the package you install sits on the production code path. Dual CJS/ESM;
bundles `idl/txoracle.json` + `idl/proofbook.json` so `npx` needs zero setup.

**Modules** (`sdk/src`): `network` (devnet/mainnet constants), `session` (guest JWT +
subscription apiToken, self-healing 401/403), `feed` (fixtures/scores), `proof` (fetch + shape
the v3 multiproof), `predicate` (build-time coverage guard), `settle` (the CPI helper),
`verify` (the module that trusts nothing), `receipt` (reconstruct + verify from chain).

**`predicate.ts`** stops you shipping an unsettleable market: it encodes the disjoint-stat-family
rule and the "each stat exactly once" rule locally, so you get a readable error instead of a raw
`DuplicateStatCoverage (6070)` / `IncompleteStatCoverage (6071)` at settle time. There's no NOT
operator, so `> t` negates to `< t+1` (which is why over/under lines are half-integers). `parlay(a,b)`
builds the exhaustive 2×2 grid `[A∧B, A∧¬B, ¬A∧B, ¬A∧¬B]` because a two-way Hit/Miss isn't
exhaustive (the complement of `A∧B` is `¬A∨¬B`, unexpressible) and would void.

**`verify.ts`** is the whole thesis in code — five facts, each from its only acceptable source:

| Fact | Source |
| --- | --- |
| settlement | the settling program's account (Solana) |
| predicate | the same account, fixed at creation (Solana) |
| merkle root | TxLINE's own daily-roots PDA (Solana) |
| proof | TxLINE's API (TxLINE) |
| verdict | TxLINE's own program, simulated (Solana) |

`--tamper` corrupts one leaf byte; the oracle rejects it, and a rejected proof throwing *is* the
negative verdict. The reconstruction reads only Solana accounts and pulls the predicate from
chain (a `ComboSpec` PDA for `market_type ≥ 16`, else the market's `OutcomeSpec`) — "a receipt
that can only be checked by asking the protocol whether it is telling the truth is not a
receipt."

**CLI** (`txline-settle` / `txsettle`), session cached at `~/.txline-settle/<host>.json`:

| Command | Behaviour |
| --- | --- |
| `auth` | guest JWT → free on-chain subscribe → activate |
| `fixtures [--league 72]` | list fixtures |
| `scores <fixtureId> [--watch]` | snapshot or SSE |
| `proof <fixtureId> [--seq n] --stats 1,2` | fetch a real v3 proof |
| `predicate [--a --b] \| [--check "1,2+7,8"]` | build/check a parlay grid |
| **`verify <marketPda\|txSig> [--tamper]`** | the headline: re-adjudicate a settlement against the live oracle |
| `market create\|bet\|lock\|settle\|claim\|receipt` | full lifecycle reference |

`verify` accepts a market PDA or a settle tx signature (it resolves the market from the tx),
prints the 5 steps, and exits `0` when the proof verifies *or* when `--tamper` is correctly
rejected — CI-friendly. `market settle` refuses compound markets (they need `settle_market_v3`
with a `ComboSpec` — use the keeper).

---

## 9. The web frontend (`web/`)

Next.js 16 App Router, React 19, Tailwind v4, framer-motion, Solana wallet-adapter + Anchor.
Nearly every page is a client component. Routes: `/` (landing), `/matches`, `/m/[pda]`,
`/receipts` (the hero surface) + `/receipts/[pda]`, `/verify` (the thesis made literal),
`/vault`, `/portfolio`, `/standings`, `/bracket`, `/status`, `/keeper`, `/docs`, plus the
server route `POST /api/rpc`.

**Three separate channels to the backend:**

1. **REST** (`lib/api.ts`) — every list comes from here, never from chain, so loading the board
   doesn't fire 100+ RPC calls. `NEXT_PUBLIC_API_URL`; `no-store`. `allMarkets()` pages at 200
   (a fixture now carries a dozen markets — an earlier one-page fetch silently returned a sixth
   of the tournament).
2. **SSE** (`lib/stream.tsx`) — one shared `EventSource` to `/stream`, multiplexed over
   `score/market/receipt/log`, exponential backoff, `?lastEventId=` resume. Never polls.
3. **Chain** via **`POST /api/rpc`** proxy — the browser signs and broadcasts but never talks
   to the RPC directly. The Helius URL carries a key and must never be `NEXT_PUBLIC_` (that
   inlines it into the bundle); the proxy reads server-only `SOLANA_RPC_URL`. It enforces a
   20-method allowlist, restricts `getProgramAccounts` to the ProofBook program *with* a filter
   (so `/vault`'s Anchor `.all()` works but a bare scan doesn't), caps body at 200 KB, rate
   limits per IP, and never echoes the upstream URL in errors.

`lib/cluster.ts` verifies the chain by **genesis hash**, not by trusting a config string.

---

## 10. Testing & CI

```bash
npm run test:all   # Rust unit + SDK + Anchor program. No network, no devnet.
```

| Suite | Count | Proves | Command |
| --- | --- | --- | --- |
| **Rust** | 10 | parimutuel solvency, rounding, fee bounds, zero-winning-pool | `npm run test:rust` |
| **Anchor** | 20 | parlays, prop vault, tampered proofs, duplicate/incomplete coverage | `npm run test:anchor` |
| **SDK** | 8 | predicate coverage, disjoint families, v3 payload shape | `npm run test:sdk` |
| **API** | 45 | the wire contract, pagination, honesty invariants | `npm run test:api` |
| **keeper e2e** | — | watch → prove → settle → claim against a local validator | `npm run keeper:e2e` |
| **audit** | — | re-adjudicates every receipt against TxLINE's real oracle | `npm run audit` |

The first three are hermetic and run in CI on every push (pinned `SOLANA_VERSION=v3.1.14`,
`ANCHOR_VERSION=1.0.2`). The last three assert against live devnet state and run against a
deployment, not in a sandbox — a red badge should mean the code is broken, never that devnet
was slow. CI runs `npm run test:anchor` (not `anchor test`) because the program's address
keypair is deliberately absent from the repo; the script boots a validator with programs pinned
at their declared ids via `--bpf-program`.

---

## 11. Running it locally

```bash
git clone https://github.com/harshdev2909/probo.git && cd probo/proofbook
npm install            # also builds the SDK and generates the Prisma client
cp .env.example .env   # fill DATABASE_URL, RPC_URL, KEEPER_SECRET_KEY
npm run db:deploy      # apply migrations

npm run api            # read API           :8787
npm run keeper:live    # the keeper
cd web && npm install && npm run dev    # frontend :3000
```

Deployment shape: **web** on Vercel (Root Directory `web/`, no secrets), **API** and **keeper**
on Railway (`railway.api.json`, `railway.keeper.json`), **Postgres** managed (Neon), the keeper
holding the only signing key. The security model is the split: keeper holds market/mint
authority, API holds only a faucet key for a valueless token, web holds nothing.

---

## Appendix — the design invariants

1. **The trust boundary is the product.** The SDK verifier, the browser verifier, `/verify`,
   and `--tamper` all exist to make "don't trust us" falsifiable against TxLINE's own program.
2. **No admin settlement.** The instruction does not exist. Settlement is permissionless and
   authorised by a proof, never a key.
3. **Writer/reader split is absolute.** One keeper writes; everything else is stateless and
   read-only; communication is one-way through Postgres LISTEN/NOTIFY.
4. **"Absent is absent."** No scoreline, receipt, or odds number is ever invented to fill a
   gap. Unprovable fixtures stay visibly empty rather than being faked.
5. **The gaps stay.** ~26 played fixtures carry no receipt because TxLINE's ~10-day retention
   window closed. One invented receipt would falsify the only claim the product makes, so the
   holes are labelled and left in public.
