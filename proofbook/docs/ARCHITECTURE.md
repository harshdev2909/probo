# Architecture

Five pieces. One of them holds a key, and none of them can decide who won.

```
  TxLINE                    ProofBook                          Solana
  ══════                    ═════════                          ══════

  scores SSE ──────────▶ ┌──────────┐
  (statusId 100)         │  KEEPER  │ ── settle_market_v3 ──▶ ┌───────────┐
                         │          │                         │ proofbook │
  proof API  ◀───────────│  watch   │                         │  program  │
  (merkle multiproof)    │  prove   │                         └─────┬─────┘
       │                 │  settle  │                               │ CPI
       └────────────────▶│          │                               ▼
                         └────┬─────┘                         ┌───────────┐
  odds SSE ──────────────────▶│                               │ txoracle  │
  (display only)              │                               │  (TxLINE) │
                              │ project                       └───────────┘
                              ▼                            validate_stat_v3
                        ┌──────────┐                       verifies the proof
                        │ Postgres │                       against the daily
                        └────┬─────┘                       merkle root
                             │ read
                        ┌────▼─────┐      ┌─────┐      ┌─────┐
                        │   API    │◀─────│ WEB │      │ SDK │ (anyone)
                        └──────────┘      └─────┘      └──┬──┘
                                                          │
                                              re-derives the proof and
                                              replays the settlement
```

The arrow that matters is the CPI. The keeper hands the program a proof, and the
program hands that proof to TxLINE's own on chain oracle. If the oracle rejects it,
the transaction fails and nobody is paid. The keeper cannot overrule that, and neither
can we.

## The settlement flow, in six steps

1. **Watch.** The keeper holds an SSE subscription to TxLINE's scores feed and waits
   for `statusId = 100`, which is TxLINE saying the match is finalised.
2. **Fetch the proof.** It asks TxLINE for a merkle multiproof over the stats the
   market's spec pins, as `(key, period)` pairs. One proof covers every leg, even for
   a four leg parlay.
3. **Settle.** It calls `settle_market_v3` on the ProofBook program, passing the proof
   and the outcome it claims the proof implies.
4. **Verify.** The program CPIs into TxLINE's `txoracle` program, which recomputes the
   merkle root from the leaves and compares it to the daily root TxLINE published on
   chain. A single altered byte and the root will not reconstruct.
5. **Pay.** Only if the oracle returns does the program evaluate the outcome, take the
   fee, and open the pool for claims. The maths is parimutuel and is unit tested for
   solvency: the winners cannot be paid more than the pool holds.
6. **Receipt.** The program writes the proven values, the proof reference, the epoch
   day and the resolver into the `Market` account. That record is the receipt. It is
   not a log line we wrote, it is chain state that only a passing proof could produce.

Cancellation is the one path with no proof, so it is deliberately the weakest thing in
the system: it is time triggered, permissionless, and can only ever return money to the
people who put it in. It cannot pay a winner. See `docs/ENGINEERING_NOTES.md` for why a
cancellation cannot be proven at all.

## The pieces

### `programs/proofbook` — the program

The only component that can move money, and it will not do so without a proof that
TxLINE's own oracle accepts. Thirteen instructions, four accounts.

`Market` is a fixed 615 byte account, and that number is load bearing: roughly 226 live
accounts, including all 713 receipts, are laid out against it. Widening any field inside
it would shift every byte offset on every one of them. So compound markets keep their
predicates in a `ComboSpec` sidecar rather than growing `Market`, and `PropVault` is its
own account entirely.

`ComboSpec::validate()` refuses to create a spec whose outcomes do not read every leg
exactly once, and `initialize_prop_vault` refuses a vault whose beneficiary is its own
depositor. Both are the same principle: a position that could never pay out should not
be mintable in the first place. Devnet accounts cannot be deleted, so a bad account is
forever.

`programs/mock_oracle` exists only for the tests. It implements `validate_stat_v3` with
real index based multiproof verification, so the test suite proves the same thing the
real oracle would, offline. It is compiled out of the production build by a feature flag,
and the deploy artifact is checked for it.

### `keeper/` — the autonomous worker

Watches, proves, settles. It runs continuously and it is the only writer to Postgres.

It holds the market authority key, which sounds alarming and is not: that key exists so
that `initialize_market` has an authority signer, and because the market PDA is derived
from its pubkey. It does not authorise settlement. `settle_market_v3` is permissionless,
so anyone can settle any market by presenting a valid proof, and the keeper's signature
buys it nothing.

Only one keeper may settle at a time. Leadership is a session level Postgres advisory
lock taken on a direct connection, never through the pooler, for reasons written up in
the engineering notes.

### `api/` — the read layer

Fastify, stateless, horizontally scalable, and it never reads the chain on a request
path. It reads the projection in Postgres and serves it. It could be killed mid request
and nothing would be lost.

It holds exactly one key, the faucet's, which can move a valueless devnet token and a
little SOL. It cannot settle, cancel or create anything. That is the whole point of the
split: the process exposed to the internet holds the key that can do the least.

### `web/` — the frontend

Next.js. Holds no key at all. The RPC key it needs is kept server side and proxied, so
opening devtools reveals nothing.

`/verify` is the page that matters. It takes any settled market, refetches the proof from
TxLINE, rebuilds the transaction, and simulates it against the real oracle in the reader's
browser. It does not ask you to trust the API, and it does not trust it either. Tamper
with a byte and it says `REJECTED`.

### `sdk/` — `@h4rsharma/txline-settle`

The settlement core, extracted and published, so that none of the above has to be taken on
faith. It fetches a proof, builds the payload, verifies a settlement against the oracle and
reconstructs a receipt. Also a CLI, so verifying a receipt is one `npx` command and no
clone.

The keeper imports it rather than keeping a private copy, which means the published package
is on the same code path as production. If it broke, our settlements would break first.

## Where the data lives

The chain is the authority. Postgres is a projection, and can be rebuilt from the chain by
`npm run sync:now`. If the two ever disagree, the chain is right and the projection is a
bug. Nothing user facing is ever served from a source that cannot be re derived from chain
state, which is what makes the receipt wall checkable rather than merely claimed.
