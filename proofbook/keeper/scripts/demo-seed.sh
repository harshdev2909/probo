#!/usr/bin/env bash
#
# demo:seed — build the whole tournament on devnet from nothing, in one command.
#
#   1. coverage   which fixtures TxLINE can still PROVE (writes docs/COVERAGE.md + plan.json)
#   2. seed       one market per fixture, each with the stat period its own proof needs
#   3. liquidity  stake all three outcomes atomically, so a market can actually settle
#   4. backfill   lock + settle every provable fixture against the LIVE TxLINE oracle
#
# Every step is idempotent: re-running adopts what already exists rather than
# double-creating, so a crash (or a rate-limited RPC) resumes cleanly.
#
# Deterministic: stakes are seeded from the fixture id, so the same command
# always produces the same book.
#
# It never fabricates a settlement. Fixtures whose proofs have aged out of
# TxLINE's retention window are left unsettled and reported as honest gaps.
#
# Usage:
#   npm run demo:seed                 # devnet, market type from $MARKET_TYPE
#   MARKET_TYPE=4 npm run demo:seed   # a fresh generation of markets
#
set -euo pipefail
cd "$(dirname "$0")/../.."

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export RPC_URL="${RPC_URL:-$ANCHOR_PROVIDER_URL}"
export KEEPER_DATA_DIR="${KEEPER_DATA_DIR:-$(pwd)/keeper/data/devnet}"
export MARKET_TYPE="${MARKET_TYPE:-3}"
export NODE_OPTIONS='--no-experimental-strip-types'

# Finished fixtures still need a betting window before they can be locked:
# place_bet requires now < lock_time, lock_market requires now >= lock_time.
export SEED_LOCK_DELAY_SEC="${SEED_LOCK_DELAY_SEC:-780}"

TS="npx ts-node -P keeper/tsconfig.json"

step() { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }

step "1/4  coverage — what can TxLINE still prove?"
$TS keeper/scripts/coverage.ts

step "2/4  markets — one per fixture"
$TS keeper/scripts/seed-tournament.ts

step "3/4  liquidity — stake every outcome (atomic)"
$TS keeper/scripts/seed-liquidity.ts

step "4/4  backfill — settle every provable fixture with a REAL proof"
$TS keeper/scripts/backfill-settle.ts

printf '\n\033[1mDone.\033[0m Settlement report: docs/COVERAGE.md\n'
