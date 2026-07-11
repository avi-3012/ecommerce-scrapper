#!/usr/bin/env bash
# Nightly database backup (NFR-9, WP-2.10). Run from deploy/ on the VPS via cron:
#   15 2 * * * cd /opt/pricepulse/deploy && ENV_FILE=.env.production ./scripts/backup.sh >> /var/log/pricepulse-backup.log 2>&1
# Retention: 30 daily + 12 monthly. Offsite copy hook at the bottom (H-19).
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.staging}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
source "$ENV_FILE"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/monthly"
STAMP=$(date +%Y-%m-%d)
FILE="$BACKUP_DIR/daily/pricepulse-$STAMP.dump"

echo "==> $(date -Iseconds) dumping database"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 > "$FILE"

# Sanity: a dump under 10KB is almost certainly broken — fail loudly (NFR-2)
[ "$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE")" -gt 10240 ] || {
  echo "BACKUP FAILED: dump suspiciously small" >&2
  exit 1
}

# First of the month → keep a monthly copy
if [ "$(date +%d)" = "01" ]; then
  cp "$FILE" "$BACKUP_DIR/monthly/pricepulse-$(date +%Y-%m).dump"
fi

# Retention
find "$BACKUP_DIR/daily" -name '*.dump' -mtime +30 -delete
ls -t "$BACKUP_DIR/monthly"/*.dump 2>/dev/null | tail -n +13 | xargs -r rm --

# Offsite copy (H-19): uncomment and configure once storage is approved, e.g.:
# rclone copy "$FILE" remote:pricepulse-backups/daily/
echo "==> $(date -Iseconds) backup complete: $FILE"
