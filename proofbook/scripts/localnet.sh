#!/usr/bin/env bash
# Start a fresh local validator with proofbook + mock_oracle preloaded.
#
# ONE ledger directory, always reset, always on a volume with room. A previous
# session minted a new ledger per test run and filled the boot disk, which took
# the whole toolchain down — a multi-GB ledger per run adds up fast.
set -euo pipefail
cd "$(dirname "$0")/.."

# Read the ids from Anchor.toml rather than hardcoding them. On a fresh clone the
# suite runs `anchor keys sync` first (the program's address keypair is not in this
# repo, and should not be), which rewrites these ids to the ones that machine can
# actually build — so a hardcoded id here would deploy the program at an address its
# own code does not declare.
PROOFBOOK=$(sed -n 's/^proofbook = "\(.*\)"/\1/p' Anchor.toml)
MOCK=$(sed -n 's/^mock_oracle = "\(.*\)"/\1/p' Anchor.toml)
[ -n "$PROOFBOOK" ] && [ -n "$MOCK" ] || { echo "could not read program ids from Anchor.toml"; exit 1; }
# One reusable ledger, inside the repo and gitignored, so a clone just works.
# Override with PB_LEDGER to park it on another disk (a ledger churns writes, and
# a per-run ledger on the boot drive filled it during development).
LEDGER="${PB_LEDGER:-$PWD/.test-ledger}"
RPC=http://127.0.0.1:8899

for so in target/deploy/proofbook.so target/deploy/mock_oracle.so; do
  [ -f "$so" ] || {
    echo "missing $so — run \`anchor build\` first (or \`npm run test:anchor\`, which does)."
    exit 1
  }
done

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
