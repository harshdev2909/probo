#!/usr/bin/env bash
# Keeper E2E / demo: full autonomous lifecycle in replay mode against a fresh
# local validator (mock-adapter build). This is also the on-camera demo command.
set -euo pipefail
cd "$(dirname "$0")/../.."

PROOFBOOK=4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63
MOCK=F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u
LEDGER="${TMPDIR:-/tmp}/proofbook-keeper-ledger"
RPC=http://127.0.0.1:8899

echo "Building programs (default features => mock-oracle adapter)..."
anchor build

echo "Stopping any stray validators..."
pkill -f solana-test-validator 2>/dev/null || true
pkill -f surfpool 2>/dev/null || true
sleep 1
rm -rf "$LEDGER"

echo "Starting solana-test-validator with proofbook + mock_oracle preloaded..."
solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$PROOFBOOK" target/deploy/proofbook.so \
  --bpf-program "$MOCK" target/deploy/mock_oracle.so &
VPID=$!
trap 'kill $VPID 2>/dev/null || true' EXIT

echo "Waiting for validator health..."
n=0
until curl -s "$RPC" -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; do
  n=$((n + 1)); [ "$n" -gt 60 ] && { echo "validator did not become healthy"; exit 1; }
  sleep 1
done
echo "Validator ready. Running the keeper E2E (autonomous lifecycle)..."

ANCHOR_PROVIDER_URL="$RPC" \
ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}" \
NODE_OPTIONS='--no-experimental-strip-types' \
  yarn run ts-mocha -p keeper/tsconfig.json -t 300000 keeper/test/e2e.test.ts
