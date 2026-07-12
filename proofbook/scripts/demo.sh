#!/usr/bin/env bash
# ProofBook full-stack demo: local validator + autonomous keeper (replay of the
# real recorded fixture) + web app. One command; Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

PROOFBOOK=4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63
MOCK=F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u
LEDGER="${TMPDIR:-/tmp}/proofbook-demo-ledger"
RPC=http://127.0.0.1:8899

# Betting window + replay pace tuned for an on-camera demo (~2 min lifecycle).
export REPLAY_LOCK_DELAY_SEC="${REPLAY_LOCK_DELAY_SEC:-75}"
export REPLAY_SPEED="${REPLAY_SPEED:-450}"
export KEEPER_DATA_DIR="${TMPDIR:-/tmp}/proofbook-demo-keeper"
# Pinned so keeper/.env (which points at the seeded devnet tournament) can never
# leak into this self-contained local-validator demo.
export MARKET_TYPE=0

if [ ! -f target/deploy/proofbook.so ]; then
  echo "Building programs (mock-oracle adapter)…"
  anchor build
fi

pkill -f solana-test-validator 2>/dev/null || true
pkill -f surfpool 2>/dev/null || true
sleep 1
rm -rf "$LEDGER" "$KEEPER_DATA_DIR"

echo "▸ starting local validator…"
solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$PROOFBOOK" target/deploy/proofbook.so \
  --bpf-program "$MOCK" target/deploy/mock_oracle.so &
VPID=$!

echo "▸ starting web app…"
(cd web && npm run dev > /tmp/proofbook-web.log 2>&1) &
WPID=$!

cleanup() { kill $VPID $WPID 2>/dev/null || true; pkill -f "keeper/src/index.ts" 2>/dev/null || true; }
trap cleanup EXIT

n=0
until curl -s "$RPC" -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; do
  n=$((n + 1)); [ "$n" -gt 60 ] && { echo "validator failed to start"; exit 1; }
  sleep 1
done
echo "▸ validator healthy. starting the autonomous keeper (replay)…"
echo "  open http://localhost:3000 — market opens, locks, settles by itself."

# demo bettors join during the betting window so settlement pays a real winner
(ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}" RPC_URL="$RPC" \
  NODE_OPTIONS='--no-experimental-strip-types' \
  npx ts-node -P keeper/tsconfig.json keeper/scripts/demo-bets.ts &)

ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}" \
RPC_URL="$RPC" NODE_OPTIONS='--no-experimental-strip-types' \
  npx ts-node -P keeper/tsconfig.json keeper/src/index.ts replay keeper/fixtures/18193785.json
