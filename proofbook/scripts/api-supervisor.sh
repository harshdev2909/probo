#!/usr/bin/env bash
# The local API's "platform": relaunch on exit. Same rationale as the keeper
# supervisor — a stateless read server that dies must simply come back.
set -u
cd "$(dirname "$0")/.."
# Env from file, not from whoever happened to launch us: a supervisor relaunch
# after a crash once came back WITHOUT the faucet key, and the faucet silently
# reported disabled until someone noticed.
[ -f scripts/api.env ] && . scripts/api.env
LOG="${API_LOG:-/tmp/proofbook-api.log}"
while true; do
  npm run api >> "$LOG" 2>&1
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') api exited ($?) — restarting in 3s" | tee -a "$LOG"
  sleep 3
done
