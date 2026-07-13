# `txline-settle` — CLI reference

> Unofficial, community-built CLI for TxLINE's on-chain sports oracle. Not
> affiliated with TxODDS/TxLINE. Published as
> [`@h4rsharma/txline-settle`](https://www.npmjs.com/package/@h4rsharma/txline-settle);
> short alias `txsettle` once installed. Every command works with zero setup via
> `npx @h4rsharma/txline-settle …` (plus a Solana keypair where signing is needed).

## Global flags

| flag | meaning |
|---|---|
| `--json` | machine-readable output, on every command |
| `--devnet` *(default)* / `--mainnet` | selects oracle program id + TxLINE API origin |
| `--rpc <url>` | Solana RPC (default: public cluster RPC; env `RPC_URL` respected) |
| `--api <origin>` | TxLINE origin override |
| `--keypair <path>` | signer, default `~/.config/solana/id.json` |

---

## `auth`

Guest JWT → **free** on-chain World-Cup subscription (Token-2022, price 0) →
activation. Caches the session at `~/.txline-settle/<origin>.json` — read
credentials, not funds. Needs a funded keypair to sign the subscribe transaction.

```bash
npx @h4rsharma/txline-settle auth --keypair ~/.config/solana/id.json
# options: --service-level 1 (default) · --weeks 4 (must be a multiple of 4)
```

## `fixtures`

```bash
npx @h4rsharma/txline-settle fixtures --league 72     # World Cup (default)
```

## `scores <fixtureId>`

Retained score records, with the best terminal record highlighted
(`statusId 100` = game_finalised). `--watch` streams live updates over SSE.

```bash
npx @h4rsharma/txline-settle scores 18218149
npx @h4rsharma/txline-settle scores 18237038 --watch
```

If TxLINE retains nothing, the command says so and exits non-zero — scores age
out after ~23 days and an unprovable result must never be pretended otherwise.

## `proof <fixtureId>`

Fetch a real `stat-validation-v3` merkle multiproof.

```bash
npx @h4rsharma/txline-settle proof 18218149 --stats 1,2,7,8
# --seq <n> pins a record; default = the finalised one
# --stats: leg keys in order, MAX 5 (the API rejects a 6th)
```

## `predicate`

Build the exhaustive 2×2 parlay grid from two conditions, or check whether two
leg sets are provable together. Overlapping stat families are refused with the
`DuplicateStatCoverage` (6070) explanation — the oracle would refuse them too.

```bash
npx @h4rsharma/txline-settle predicate --a homeWin --b overCorners:9.5
npx @h4rsharma/txline-settle predicate --a homeWin --b overGoals:2.5   # throws: both read goals
npx @h4rsharma/txline-settle predicate --check "1,2+7,8"               # ✓ combinable
```

Conditions: `homeWin` · `overGoals[:2.5]` · `overCorners[:9.5]` · `overCards[:3.5]`.

## `verify <marketPda|txSig>` ⭐

Independently re-verify a settlement, trusting nothing of the settling app:

1. the settlement — read from the **Solana account**
2. the predicate — the same account, fixed at creation
3. the merkle root — **TxLINE's own daily-roots PDA**, under their program
4. the proof — **TxLINE's API**, fetched fresh
5. the verdict — **TxLINE's own program**, by simulation

```bash
npx @h4rsharma/txline-settle verify 8m3iQDertFPaamME5zWgMyPU5KrSfBCFq1MSAjBj7Txx
npx @h4rsharma/txline-settle verify <settleTxSig>          # resolves the market from the tx
npx @h4rsharma/txline-settle verify <marketPda> --tamper   # corrupt a byte → REJECTED
```

Exit code 0 on VERIFIED (or on a tamper run that was correctly rejected), 1 otherwise.

## `market …` — the full lifecycle (reference integration)

Runs against the ProofBook reference program (override with `--program`).

```bash
# create a 1X2 market. --period matters: pin what the fixture's proof carries —
# period 100 (game_finalised) is only retained ~10 days; older fixtures prove at 5.
npx @h4rsharma/txline-settle market create --fixture 18237038 --mint <usdcMint> \
  --lock 1784055600 --period 100

npx @h4rsharma/txline-settle market bet    --market <pda> --outcome 0 --amount 25
npx @h4rsharma/txline-settle market lock   --market <pda>
# settle: fetches the real proof, derives the outcome the proven values satisfy,
# submits the oracle CPI — the same trustless path the keeper takes
npx @h4rsharma/txline-settle market settle --market <pda>
npx @h4rsharma/txline-settle market claim  --market <pda>
npx @h4rsharma/txline-settle market receipt --market <pda> --json   # chain-only receipt
```

---

## The two gotchas (they will bite you)

- **Disjoint stat families.** The oracle evaluates each proven stat exactly once
  (6070/6071). A compound predicate's legs must read disjoint families —
  goals 1|2 · yellows 3|4 · reds 5|6 · corners 7|8. "Home win AND over 2.5
  goals" is not expressible.
- **Period 100 vs 5.** TxLINE keeps the `game_finalised` record ~10 days; older
  fixtures prove at period 5 (full time). The proof leaf commits to the period,
  so a market spec pinned to the wrong one can **never** settle
  (`InvalidStatProof` 6023). Read the proof's period first, then create.
