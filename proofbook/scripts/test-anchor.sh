#!/usr/bin/env bash
#
# The Anchor program suite, runnable from any clone. 20 tests, local validator,
# mock oracle, no devnet, no network.
#
#   npm run test:anchor
#
# Why this is a script and not just `anchor test`.
#
# The program declares the address it lives at on devnet:
#
#     declare_id!("4kyf719yvcKf3qHKyLAQHbBEgLogrbJtC2nFZMMd7v63")
#
# and Anchor wants the matching keypair at target/deploy/proofbook-keypair.json in
# order to build and deploy. That keypair is the program's own address key. It is
# NOT in this repository and it should not be, because private keys do not belong in
# public repos.
#
# So on a fresh clone Anchor generates a new keypair, sees that it does not match the
# declared id, and refuses: "Program ID mismatch detected". Nothing is wrong with the
# code. The build simply cannot prove it owns an address it has no key for.
#
# `anchor keys sync` resolves it by rewriting declare_id (and Anchor.toml) to match
# whatever keypairs this machine actually has. The program is then self consistent and
# the suite runs against a local deployment, which is all a local test ever needed.
#
# Two consequences we handle:
#
#   · it edits source files, so we put them back on the way out. Run the suite, and
#     `git status` should still be clean. The devnet address stays in the source where
#     it belongs.
#
#   · the ids are no longer the hardcoded ones, so localnet.sh reads them from
#     Anchor.toml rather than assuming.
#
# On the maintainer's machine the keypairs already match, so `keys sync` is a no-op and
# nothing is rewritten at all.
set -uo pipefail
cd "$(dirname "$0")/.."

TOUCHED=(Anchor.toml programs/proofbook/src/lib.rs programs/mock_oracle/src/lib.rs)

restore() {
  git checkout -- "${TOUCHED[@]}" 2>/dev/null || true
}
trap restore EXIT INT TERM

# Anchor's npm wrapper prints "Could not find globally installed anchor" and then
# exits 0, so a missing CLI sails straight through `anchor build` and only surfaces
# later as a validator that "did not become healthy". Check the tool is real first,
# and check it produced something afterwards. Trust artifacts, not exit codes.
command -v anchor > /dev/null || { echo "anchor is not installed"; exit 1; }
anchor --version > /dev/null 2>&1 || {
  echo "the anchor binary is present but will not run (on CI this is usually a missing"
  echo "executable bit on the npm-shipped binary). Fix that before running the suite."
  exit 1
}

echo "→ syncing program ids to the keypairs on this machine"
anchor keys sync > /dev/null || { echo "anchor keys sync failed"; exit 1; }

echo "→ building"
anchor build || exit 1

for so in target/deploy/proofbook.so target/deploy/mock_oracle.so; do
  [ -f "$so" ] || { echo "anchor build reported success but did not produce $so"; exit 1; }
done

echo "→ booting a local validator with the programs pinned at their declared ids"
./scripts/localnet.sh || exit 1

echo "→ running the suite"

# The wallet Anchor.toml points at. A judge gets one from `solana-keygen new`.
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
[ -f "$WALLET" ] || {
  echo "no keypair at $WALLET — run: solana-keygen new"
  exit 1
}

# Point the suite at the LOCAL validator, and blank the keeper's own environment
# while doing it.
#
# This is not belt and braces. RPC_URL takes precedence over ANCHOR_PROVIDER_URL, so
# a populated keeper/.env once had a "local" test run creating and settling markets
# on DEVNET while it minted its tokens on localhost, and DATABASE_URL made the test
# keeper sit and wait to become leader of a cluster it was not in. The suite must be
# hermetic, so it is given nothing to be confused by.
DATABASE_URL= \
DIRECT_DATABASE_URL= \
RPC_URL= \
KEEPER_DATA_DIR= \
ANCHOR_PROVIDER_URL="http://127.0.0.1:8899" \
ANCHOR_WALLET="$WALLET" \
  npm test
exit $?
