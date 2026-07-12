#!/usr/bin/env bash
# Runs the TypeScript integration suite against a fresh solana-test-validator with
# both programs (built with the `mock-oracle` adapter) preloaded at their program
# ids. Deterministic and independent of `anchor test`'s validator choice.
set -euo pipefail
cd "$(dirname "$0")/.."

PROOFBOOK=4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63
MOCK=F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u
LEDGER="${TMPDIR:-/tmp}/proofbook-test-ledger"
RPC=http://127.0.0.1:8899

# Always build with default features so the loaded binary uses the mock-oracle
# adapter (a prior `--no-default-features` production build would otherwise settle
# via TxLINE and fail these tests).
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
echo "Validator ready."

ANCHOR_PROVIDER_URL="$RPC" \
ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}" \
NODE_OPTIONS='--no-experimental-strip-types' \
  yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.ts'
