#!/usr/bin/env bash
# The local API's "platform": relaunch on exit. Same rationale as the keeper
# supervisor — a stateless read server that dies must simply come back.
set -u
cd "$(dirname "$0")/.."
LOG="${API_LOG:-/tmp/proofbook-api.log}"
while true; do
  npm run api >> "$LOG" 2>&1
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') api exited ($?) — restarting in 3s" | tee -a "$LOG"
  sleep 3
done
