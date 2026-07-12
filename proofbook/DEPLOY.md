# Deploying ProofBook

Four things go live. The split is the security model, not an architecture flourish:

| service | what it is | holds |
|---|---|---|
| **Postgres** | source of truth for everything the site reads | the 76 receipts |
| **Keeper** | long-running worker. The ONLY writer. | the key that settles markets |
| **API** | stateless read layer + faucet. Scale it freely. | a faucet key that can only move a valueless token |
| **Web** | Next.js | **no secrets at all** |

The chain stays **devnet**.

---

## 0. Before you touch a platform

```bash
# The IDL must be committed — target/ is gitignored and will not exist on a
# deploy host. Both the keeper and the API read it at boot.
anchor build && npm run idl:sync
git add idl/ && git commit -m "commit IDL for deploy"

# Snapshot the database. The 76 receipts cannot be re-created: TxLINE's retention
# window has already closed behind most of them.
npm run db:backup
```

---

## 1. Postgres

Any managed Postgres (Neon, Railway, Supabase, RDS). You already have a Neon URL
exported in your shell:

```
postgresql://neondb_owner:***@ep-shiny-river-...neon.tech/neondb?sslmode=require
```

That database was empty when I checked, so it's a fine target — but **it is your
call**; I did not write to it.

```bash
export DATABASE_URL="postgresql://...?sslmode=require"

npm run db:deploy      # apply migrations (prisma migrate deploy)
npm run db:import      # load the tournament: 104 fixtures, 104 markets, 76 receipts
```

`db:import` reads the chain for markets and positions and verifies itself — it
exits non-zero if the receipt count doesn't match the settled-market count, so a
half-finished import cannot pass silently.

---

## 2. Keeper — **the one that must not die**

A **worker**, not a web service. It has no HTTP port. It must run 24/7 through the
semi-finals and the Final, because it is the thing that settles them.

**Railway / Render / Fly — one instance.**

```
Start command:  npm run start:keeper
Health check:   none (it has no port) — use the platform's process monitor
Restart policy: always
```

Environment:

```ini
DATABASE_URL=postgresql://...?sslmode=require
ANCHOR_WALLET=/etc/secrets/id.json     # or paste the JSON array; see below
RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
ANCHOR_PROVIDER_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
MARKET_TYPE=3
MARKET_TYPES=3,4
TXLINE_API=https://txline-dev.txodds.com
COMPETITION_ID=72
KEEPER_INSTANCE=keeper-prod            # optional; shows on the status page
```

The wallet is a file. On Railway, add it as a **secret file** mounted at
`/etc/secrets/id.json` and point `ANCHOR_WALLET` at it. On Fly, use
`fly secrets set` plus a small entrypoint that writes the file.

**Running two keepers is safe** — they elect a leader through a Postgres advisory
lock and only one ever writes. A rolling deploy that briefly overlaps the old and
new instance will not double-settle. (This is enforced and tested; a follower
blocks and writes nothing.) But you still only *need* one.

---

## 3. API

Stateless. Scale to as many instances as you like — they all `LISTEN` on Postgres
for the keeper's events and fan them out over SSE.

```
Start command: npm run start:api
Health check:  GET /health   (200 = API+DB up; it reports keeper liveness separately)
Port:          $PORT
```

Environment:

```ini
DATABASE_URL=postgresql://...?sslmode=require
PORT=8787
CORS_ORIGINS=https://your-web-url.vercel.app   # ← set this. Not *.
RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY

# From `npm run faucet:setup` — a LOW-PRIVILEGE key. It can only transfer a
# valueless devnet token and a little SOL. It is NOT the keeper's key.
FAUCET_SECRET_KEY=[214,130,252,...]
USDC_MINT=3Srypwg8r4L4PbCcBeSgjveeixyH6sKAytJK11xVTMns
```

> `/health` returns 200 whenever the API and database are up, **even if the keeper
> is dead** — those are different failures. The keeper's liveness is a field in the
> response, and it's what the status page reads. Don't wire your platform's health
> check to the keeper, or a keeper blip will restart-loop your API.

---

## 4. Web (Vercel)

```
Root directory: web
Build command:  npm run build
```

Environment:

```ini
NEXT_PUBLIC_API_URL=https://your-api.up.railway.app
NEXT_PUBLIC_SITE_URL=https://your-web.vercel.app

# SECRET, and note there is NO NEXT_PUBLIC_ prefix. The browser never sees this.
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
```

**Do not** put the RPC key in a `NEXT_PUBLIC_` variable. Those are compiled into
the JavaScript bundle and anyone can read them out of devtools. The browser calls
`/api/rpc` on your own origin, and only the server knows the upstream URL.

Verify after deploying:

```bash
# must print 0
curl -s https://your-web.vercel.app/_next/static/chunks/*.js | grep -c "your-api-key"
```

---

## 5. Verify the judge path against the DEPLOYED site

Not localhost. Actually run this:

```bash
API_URL=https://your-api.up.railway.app npm run test:api   # 15 assertions
API_URL=https://your-api.up.railway.app \
RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY \
  npm run smoke                                            # walks the whole judge path
```

The smoke test creates a wallet that has never existed, faucets it, places a real
bet, waits for the keeper to index it, and verifies a receipt's settle transaction
on-chain. If it passes against your deployed URLs, a judge can do it too.

Then open the site yourself in a **fresh browser profile** with a **new Phantom
wallet** and do it by hand. That is the only test that counts.

---

## 6. On the night

- Watch **`/status`**. It shows the keeper's heartbeat, whether the score feed is
  connected, the last event it saw, and the last settlement. If the keeper dies,
  that page says so instead of the site quietly going stale.
- The faucet's reserves are on the same page. If they run low, judges can't get
  test funds — top up with `FAUCET_TOPUP=1 npm run faucet:setup`.
- `npm run db:backup` before any deploy.

---

## Troubleshooting

**Every fixture shows "Unknown" and pool 0.**
The keeper is pointed at the wrong market generation. `MARKET_TYPE=3` and
`MARKET_TYPES=3,4` must match what was seeded.

**Bets hang on "confirming".**
Almost always the wallet, not the app. Phantom needs **Testnet Mode** on. The app
broadcasts the signed transaction itself over devnet, so a mainnet Phantom will
still produce a bet that lands — but its preview will fail and look broken.

**"IDL not found".**
`anchor build && npm run idl:sync`, and commit `idl/`.

**The keeper starts and immediately exits.**
It lost the Postgres advisory lock, which means it can no longer be sure it is the
only writer. Exiting is deliberate — the platform restarts it and it re-elects.
Check the database connection.
