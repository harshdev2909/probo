#!/usr/bin/env bash
# The local keeper's "platform".
#
# A keeper that loses the leader lock EXITS — deliberately, because a keeper that
# is no longer certain it leads must stop writing immediately, and a clean restart
# re-elects from scratch. On Railway the platform provides the restart. Locally,
# this loop is the platform. Without it, a single Neon connection blip the night
# of the Final would leave NO keeper running and nothing would settle.
set -u
cd "$(dirname "$0")/.."

LOG="${KEEPER_LOG:-/tmp/proofbook-keeper.log}"
echo "keeper supervisor: relaunching on exit, logging to $LOG"

while true; do
  npm run keeper:live >> "$LOG" 2>&1
  code=$?
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') keeper exited (code $code) — restarting in 5s" | tee -a "$LOG"
  sleep 5
done
