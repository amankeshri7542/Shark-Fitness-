#!/usr/bin/env bash
# Back up the pilot database with the app's own tool, prove the copy restores,
# then prune old copies.
#
#   Run as root:  backup.sh [nightly|pre-deploy|manual]     (default: manual)
#
# pnpm db:backup uses SQLite's online backup, so the app keeps serving and
# writing. It checks the copy's integrity and writes a checksummed manifest
# beside it. The copy is then restored into a throwaway path, which checks the
# manifest end to end. Copies land in $SHARK_HOME/backups/<kind>/.
#
# The systemd timer runs `backup.sh nightly`. Only nightly runs ping
# SHARK_BACKUP_PING_URL, so a deploy's backup cannot hide a broken timer.
#
# These copies sit on the same disk as the database. They cover a bad deploy or
# a mistake, not the loss of the server: pull-backup.sh copies them off it.
set -euo pipefail

SHARK_HOME=${SHARK_HOME:-/srv/shark-fitness}
pilot=$(cd "$(dirname "$0")" && pwd)
kind=${1:-manual}
case $kind in
  nightly|pre-deploy|manual) ;;
  *) echo "Usage: backup.sh [nightly|pre-deploy|manual]" >&2; exit 64 ;;
esac

setting() { sed -n "s/^$1=//p" "$SHARK_HOME/shark.env" | tail -n 1; }
ping_url=$(setting SHARK_BACKUP_PING_URL)
keep_days=$(setting SHARK_BACKUP_KEEP_DAYS)
keep_days=${keep_days:-14}
[[ $keep_days =~ ^[0-9]+$ ]] || { echo "SHARK_BACKUP_KEEP_DAYS must be a whole number of days." >&2; exit 1; }

ping() {
  [ "$kind" = nightly ] && [ -n "$ping_url" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" "$ping_url$1" \
    || echo "warning: could not reach the backup ping URL" >&2
}
trap 'ping /fail "backup.sh $kind failed on line $LINENO; see journalctl -u shark-backup"' ERR
ping /start

cd "$pilot"
ln -sfn "$SHARK_HOME/shark.env" .env
docker image inspect shark-fitness:pilot >/dev/null 2>&1 \
  || { echo "No shark-fitness:pilot image yet. Run deploy.sh first." >&2; false; }

# A one-off container from the deployed image, with the app's mounts and
# SHARK_DB, so this works whether or not the app is running.
result=$(docker compose run --rm --no-deps -T --entrypoint sh app -euc '
  out=$(pnpm -s run db:backup "$SHARK_DB" "/var/backups/shark-fitness/$1")
  backup=$(printf "%s\n" "$out" | sed -n "s/^backup=//p")
  probe=$(mktemp -d)
  pnpm -s run db:restore "$backup" "$probe/shark.db" >/dev/null
  rm -rf "$probe"
  printf "%s\nrestore_probe=ok\n" "$out"
' sh "$kind")
result=$(printf '%s\n' "$result" | sed "s|/var/backups/shark-fitness/|$SHARK_HOME/backups/|")
echo "$result"

# Only after a good backup, so a run of failures never prunes the last copy.
# shark-*.db* also takes the manifest and the empty -shm/-wal files SQLite
# leaves when the backup tool reopens a copy read-only to check it.
find "$SHARK_HOME/backups" -type f -name 'shark-*.db*' -mtime +"$keep_days" -print -delete | sed 's/^/pruned=/'

ping "" "$result"
