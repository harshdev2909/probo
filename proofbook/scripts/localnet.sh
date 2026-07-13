#!/usr/bin/env bash
# Start a fresh local validator with proofbook + mock_oracle preloaded.
#
# ONE ledger directory, always reset, always on a volume with room. A previous
# session minted a new ledger per test run and filled the boot disk, which took
# the whole toolchain down — a multi-GB ledger per run adds up fast.
set -euo pipefail
cd "$(dirname "$0")/.."

PROOFBOOK=4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63
MOCK=F7QqiHeEEDenTEY8fu55rrYTmFrX4K9KKe3hbcdgrZ7u
LEDGER="${PB_LEDGER:-/Volumes/Extreme SSD/.pb-ledger/ledger}"
RPC=http://127.0.0.1:8899

pkill -f solana-test-validator 2>/dev/null || true
sleep 1
rm -rf "$LEDGER"
mkdir -p "$(dirname "$LEDGER")"

solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$PROOFBOOK" target/deploy/proofbook.so \
  --bpf-program "$MOCK" target/deploy/mock_oracle.so > /dev/null 2>&1 &

n=0
until curl -s "$RPC" -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; do
  n=$((n + 1)); [ "$n" -gt 60 ] && { echo "validator did not become healthy"; exit 1; }
  sleep 1
done
echo "validator ready (ledger: $LEDGER)"
