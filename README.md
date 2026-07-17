# ProofBook

[![CI](https://github.com/harshdev2909/probo/actions/workflows/ci.yml/badge.svg)](https://github.com/harshdev2909/probo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@h4rsharma/txline-settle)](https://www.npmjs.com/package/@h4rsharma/txline-settle)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**A World Cup prediction market where every payout is proven, not trusted.**

No admin key can settle a market here. The program will not move a cent until TxLINE's own
on chain oracle has verified a merkle proof of the result, by CPI, inside the very
transaction that pays you. If the proof does not verify, nobody is paid. That is the only
claim this product makes, and every number below is checkable.

## What is on chain right now

| | |
| --- | --- |
| **713** | proof receipts, each one a real TxLINE `validate_stat_v3` merkle multiproof |
| **789** | settled markets on devnet |
| **13** | market types: 1X2, goals, corners, cards, BTTS, clean sheet, half time, winning margin, and four parlays |
| **0** | fabricated receipts |
| **0** | admin settlements. The instruction does not exist |

Settled by a keeper nobody clicks. Verified by an audit anybody can re-run.

## Verify it yourself

Do not take our word for any of it. Pick a receipt and re-adjudicate it from scratch:

```bash
npx @h4rsharma/txline-settle verify 8m3iQDertFPaamME5zWgMyPU5KrSfBCFq1MSAjBj7Txx
```

That refetches the proof from TxLINE, rebuilds the settlement transaction, and simulates it
against TxLINE's real oracle program. It trusts nothing we host. Corrupt one byte and watch
it refuse:

```bash
npx @h4rsharma/txline-settle verify <marketPda> --tamper   # REJECTED
```

The same check runs in the browser at [`/verify`](https://probo-5xn6.vercel.app/verify), and
across every receipt at once via `npm run audit`, which re-adjudicates every receipt against
TxLINE's real oracle and exits non-zero if a single one does not hold up.

## Sixty seconds, as a judge

1. Open [the app](https://probo-5xn6.vercel.app) and connect a devnet wallet.
2. Take demo USDC from the faucet on the portfolio page.
3. Back an outcome on any open market.
4. Open [Receipts](https://probo-5xn6.vercel.app/receipts). Every one is a settlement that a
   merkle proof forced.
5. Hit **verify** on any of them, or run the `npx` line above. It re-checks against the chain
   and against TxLINE, never against us.

Worth a look too: [`/vault`](https://probo-5xn6.vercel.app/vault), parametric insurance whose
loss adjuster is a proof, and [`/status`](https://probo-5xn6.vercel.app/status) for the
keeper's own liveness. [`/docs`](https://probo-5xn6.vercel.app/docs) has the SDK and CLI.

## How a market settles

```
  TxLINE scores SSE ──▶ keeper sees statusId 100 (finalised)
                            │
                            ├──▶ fetch the merkle multiproof for the stats the spec pins
                            │
                            ▼
                     settle_market_v3 ─── CPI ──▶ txoracle.validate_stat_v3
                            │                            │
                            │            recomputes the root from the leaves and compares
                            │            it to the daily root TxLINE published on chain
                            │                            │
                            │◀───────────────────────────┘
                            │      rejects ▶ the transaction fails and nobody is paid
                            ▼      accepts ▶
                     parimutuel payout, fee taken, pool opened for claims
                            │
                            ▼
                     PROOF RECEIPT written into the Market account:
                     the proven values, the proof reference, the epoch day, the resolver
```

The keeper's signature is not among the things that authorise this. `settle_market_v3` is
permissionless: anyone holding a valid proof can settle any market, and the keeper gains
nothing by being the one who does.

## The 26 gaps, and why they stay empty

26 fixtures in this tournament carry no receipt and no scoreline. They were played. We show
them anyway, and we say plainly that we cannot prove them: TxLINE keeps a finalised record
for about ten days, and for those matches the record is gone.

We could fill those holes from the scores feed in an afternoon, and every one of them would
be a lie. **One invented receipt would falsify the only claim this product makes.** So the
gaps stay, labelled, in public. That is the feature, not the bug.

## TxLINE endpoints used

| endpoint | what for |
| --- | --- |
| `POST /api/auth/guest` | the session credential |
| `GET /api/fixtures/snapshot` | the tournament's fixtures |
| `GET /api/scores/snapshot/{fixtureId}` | finding the finalised sequence |
| `GET /api/scores/stat-validation-v3` | **the merkle multiproof that settles a market** |
| `GET /api/scores/stream` (SSE) | live scores, and the finalised trigger |
| `GET /api/odds/stream` (SSE) | demargined consensus odds. Display only, never a payout |
| on chain `txoracle.validate_stat_v3` | the CPI that adjudicates every settlement |

Stat keys 1 to 8 only, because those are the ones TxLINE can actually prove.

## Run it

```bash
git clone https://github.com/harshdev2909/probo.git && cd probo/proofbook
npm install            # also builds the SDK and generates the Prisma client
cp .env.example .env   # fill in DATABASE_URL, RPC_URL, KEEPER_SECRET_KEY
npm run db:deploy      # apply the migrations

npm run api            # the read API   :8787
npm run keeper:live    # the keeper
cd web && npm install && npm run dev    # the frontend :3000
```

## Test it

```bash
npm run test:all   # Rust unit + Anchor program + SDK. No network, no devnet.
```

| suite | what it proves | command |
| --- | --- | --- |
| **Rust** (10) | parimutuel solvency, rounding, fee bounds, the zero winning pool trap | `npm run test:rust` |
| **Anchor** (20) | parlays, the prop vault, tampered proofs, duplicate and incomplete stat coverage | `npm run test:anchor` |
| **SDK** (8) | predicate coverage, disjoint stat families, the proof payload shape | `npm run test:sdk` |
| **API** (45) | the contract, pagination, and the honesty invariants at the wire | `npm run test:api` |
| **keeper e2e** | watch, prove, settle, claim, against a local validator | `npm run keeper:e2e` |
| **audit** | re-adjudicates **every** receipt against TxLINE's real oracle | `npm run audit` |

The first three run in CI on every push. The last three assert against live state, since the
audit re-verifies all 713 receipts on devnet, so they run against a deployment rather than in
a sandbox. A red badge should mean the code is broken, never that devnet was slow.

## The SDK

The settlement core is published, so that none of the above has to be taken on faith:

```bash
npm i @h4rsharma/txline-settle
```

The keeper imports it rather than keeping a private copy, which means the package you install
sits on the same code path as production. If it broke, our settlements would break first.

Unofficial, community built. Not affiliated with TxODDS or TxLINE.

---

Program `4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63` on Solana devnet. MIT licensed.
