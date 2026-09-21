#!/bin/sh
# Nightly Postgres backups for Hearth. Runs inside the "backup" container.
#   Scheduled:  started by docker compose, runs every day at BACKUP_TIME
#   On demand:  docker compose exec backup sh /backup.sh now
set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
AT="${BACKUP_TIME:-03:00}"
DIR=/backups

backup() {
  mkdir -p "$DIR"
  file="$DIR/hearth-$(date +%Y-%m-%d_%H%M).sql.gz"
  if (set -o pipefail; pg_dump -h db -U hearth --no-owner hearth | gzip > "$file.tmp"); then
    mv "$file.tmp" "$file"
    echo "$(date '+%F %T') backup written: $file ($(du -h "$file" | cut -f1))"
  else
    rm -f "$file.tmp"
    echo "$(date '+%F %T') BACKUP FAILED" >&2
    return 1
  fi
  find "$DIR" -name 'hearth-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
}

if [ "${1:-}" = "now" ]; then
  backup
  exit $?
fi

echo "Hearth backups: daily at $AT ($(date +%Z)), keeping $KEEP_DAYS days, into $DIR"
# Take one right away if there is no backup from today yet.
ls "$DIR"/hearth-"$(date +%Y-%m-%d)"_*.sql.gz >/dev/null 2>&1 || backup || true

while true; do
  now=$(date +%s)
  target=$(date -d "$AT" +%s 2>/dev/null || date -d "$(date +%Y-%m-%d) $AT" +%s)
  [ "$target" -le "$now" ] && target=$((target + 86400))
  sleep $((target - now))
  backup || true
done
