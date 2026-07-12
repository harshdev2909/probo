#!/usr/bin/env bash
#
# Snapshot the database. Run this BEFORE any deploy, and before the semis.
#
# The 76 Proof Receipts are the only irreplaceable thing in this system. The
# markets can be re-seeded and the fixtures re-fetched, but a receipt records a
# settlement that already happened — and TxLINE's retention window has already
# closed behind most of them, so if these rows are lost, those proofs cannot be
# re-fetched. Ever. A bad `prisma migrate reset` would be unrecoverable.
#
# So this takes two independent backups:
#   1. a full pg_dump (restores everything)
#   2. a plain JSON export of the receipts alone (survives a Postgres version
#      mismatch, a corrupted dump, or a future schema change — and is readable
#      by eye)
#
#   ./scripts/backup-db.sh
#   ./scripts/backup-db.sh /path/to/backups
#
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL is required}"

# Prisma accepts ?schema=... ; pg_dump and psql do not and abort on it. Strip the
# Prisma-only params so the same URL works for both. (Found the hard way: without
# this the backup fails, and it would have failed on the night it was needed.)
PG_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's/([?&])schema=[^&]*&?//; s/[?&]$//')"

OUT="${1:-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

DUMP="$OUT/proofbook-$STAMP.dump"
JSON="$OUT/receipts-$STAMP.json"

echo "── pg_dump ──"
pg_dump --format=custom --no-owner --no-privileges "$PG_URL" --file "$DUMP"
echo "  $DUMP  ($(du -h "$DUMP" | cut -f1))"

echo "── receipts as plain JSON (the belt-and-braces copy) ──"
psql "$PG_URL" -At -c "
  SELECT json_agg(row_to_json(r))
  FROM (
    SELECT rc.*, f.\"homeName\", f.\"awayName\", f.stage
    FROM receipts rc
    JOIN fixtures f ON f.id = rc.\"fixtureId\"
    ORDER BY rc.\"settledAt\"
  ) r;
" > "$JSON"

COUNT=$(psql "$PG_URL" -At -c "SELECT count(*) FROM receipts;")
echo "  $JSON  ($COUNT receipts)"

# A backup you have not verified is a rumour, not a backup.
if [ "$COUNT" -eq 0 ]; then
  echo "REFUSING: the database has zero receipts — this is not a good snapshot." >&2
  rm -f "$DUMP" "$JSON"
  exit 1
fi
if ! pg_restore --list "$DUMP" > /dev/null 2>&1; then
  echo "REFUSING: pg_dump produced a file pg_restore cannot read." >&2
  exit 1
fi

echo
echo "Backed up $COUNT receipts."
echo "Restore with:"
echo "  pg_restore --clean --no-owner --dbname \"\$DATABASE_URL\" $DUMP"
