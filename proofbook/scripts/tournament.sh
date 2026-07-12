#!/usr/bin/env bash
#
# The real tournament, on devnet.
#
# Runs the keeper against the markets `npm run demo:seed` created: 103 fixtures,
# 75 of them already settled by a REAL TxLINE proof, and the semi-final still open
# for bets. The keeper keeps ingesting scores and will settle the open market by
# itself when the match ends — nobody clicks resolve.
#
#   ./scripts/tournament.sh        # keeper (:8787) + web (:3000)
#
# Seed it first if the markets don't exist yet:
#   npm run demo:seed
#
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export RPC_URL="${RPC_URL:-$ANCHOR_PROVIDER_URL}"
export KEEPER_DATA_DIR="${KEEPER_DATA_DIR:-$ROOT/keeper/data/devnet}"
# The generation of markets the tournament was seeded into. Must match demo:seed.
export MARKET_TYPE="${MARKET_TYPE:-3}"
export NODE_OPTIONS='--no-experimental-strip-types'

if [ ! -f "$KEEPER_DATA_DIR/state.json" ]; then
  echo "No seeded tournament found at $KEEPER_DATA_DIR"
  echo "Run:  npm run demo:seed"
  exit 1
fi

cleanup() { kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "── keeper (devnet, market type $MARKET_TYPE) ──"
npx ts-node -P keeper/tsconfig.json keeper/src/index.ts live &

# wait for the read API before starting the web app
for _ in $(seq 1 40); do
  curl -sf http://localhost:8787/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf http://localhost:8787/health >/dev/null || { echo "keeper did not come up"; exit 1; }

SETTLED=$(curl -s http://localhost:8787/markets | grep -c '"status": "settled"' || true)
echo "keeper up · $SETTLED markets settled by real proofs"

echo "── web (http://localhost:3000) ──"
(cd web && NEXT_PUBLIC_KEEPER_API=http://localhost:8787 \
           NEXT_PUBLIC_RPC="$RPC_URL" npm run dev) &

wait
