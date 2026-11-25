#!/usr/bin/env bash
# Back up the pilot database with the app's own tool, prove the copy restores,
# then prune old copies.
#
#   Run as root:  backup.sh [nightly|pre-deploy|manual]     (default: manual)
#
# pnpm db:backup uses SQLite's online backup, so the app keeps serving and
# writing. It checks the copy's integrity and writes a checksummed manifest
# beside it, and archives the private media directory (SHARK_MEDIA_DIR) as
# <copy>.media.tar with every file's SHA-256 in that manifest. The copy is
# then restored into a throwaway path, which checks the manifest (and every
# media file) end to end. Copies land in $SHARK_HOME/backups/<kind>/.
#
# The systemd timer runs `backup.sh nightly`. Only nightly runs ping
# SHARK_BACKUP_PING_URL, so a deploy's backup cannot hide a broken timer.
#
# These copies sit on the same disk as the database. They cover a bad deploy or
# a mistake, not the loss of the server. For that, either:
#   - off-site (optional, automatic): with SHARK_BACKUP_OFFSITE_REMOTE (an
#     rclone remote:path) and SHARK_BACKUP_AGE_RECIPIENT (an age public key)
#     both set in shark.env, every copy and its manifest are encrypted with age
#     and uploaded to <remote>/<kind>/ with rclone. The private key never lives
#     on this server. Off-site copies older than SHARK_BACKUP_OFFSITE_KEEP_DAYS
#     (default 30) are deleted only after an upload succeeds. If the upload
#     fails, the local copy is kept, local pruning is skipped, a nightly run
#     pings /fail and exits 1. With neither variable set it prints
#     offsite=skipped and does nothing else.
#   - pull-backup.sh, run from another machine, copies one off by hand.
set -euo pipefail

SHARK_HOME=${SHARK_HOME:-/srv/shark-fitness}
# rclone's remote and credentials, as `sudo rclone config` wrote them. Named
# explicitly because a systemd service may run without $HOME.
export RCLONE_CONFIG=${RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}
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
offsite_remote=$(setting SHARK_BACKUP_OFFSITE_REMOTE)
age_recipient=$(setting SHARK_BACKUP_AGE_RECIPIENT)
offsite_keep_days=$(setting SHARK_BACKUP_OFFSITE_KEEP_DAYS)
offsite_keep_days=${offsite_keep_days:-30}
[[ $offsite_keep_days =~ ^[0-9]+$ ]] && [ "$offsite_keep_days" -ge 1 ] \
  || { echo "SHARK_BACKUP_OFFSITE_KEEP_DAYS must be a whole number of days, at least 1." >&2; exit 1; }

ping() {
  [ "$kind" = nightly ] && [ -n "$ping_url" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" "$ping_url$1" \
    || echo "warning: could not reach the backup ping URL" >&2
}
trap 'ping /fail "backup.sh $kind failed on line $LINENO; see journalctl -u shark-backup"' ERR
ping /start

# Half a configuration is a mistake, not a choice: refuse it before backing up.
if [ -n "$offsite_remote" ] || [ -n "$age_recipient" ]; then
  [ -n "$offsite_remote" ] && [ -n "$age_recipient" ] \
    || { echo "Set both SHARK_BACKUP_OFFSITE_REMOTE and SHARK_BACKUP_AGE_RECIPIENT, or neither." >&2; false; }
  offsite_remote=${offsite_remote%/}
  [[ $offsite_remote =~ ^[A-Za-z0-9_.-]+:.+ ]] \
    || { echo "SHARK_BACKUP_OFFSITE_REMOTE must be an rclone remote:path, e.g. offsite:shark-pilot-backups." >&2; false; }
  for recipient in ${age_recipient//,/ }; do
    [[ $recipient =~ ^age1[0-9a-z]{58}$ ]] \
      || { echo "SHARK_BACKUP_AGE_RECIPIENT must be one or more age public keys (age1...), separated by commas." >&2; false; }
  done
  command -v age >/dev/null && command -v rclone >/dev/null \
    || { echo "Off-site backups need age and rclone; provision.sh installs both." >&2; false; }
fi

# Encrypts a copy and its manifest to every recipient, uploads both to
# <remote>/<kind>/, and checks the upload. Plaintext never leaves the server.
offsite_upload() {
  local database=$1 work recipients=() recipient name status=0
  for recipient in ${age_recipient//,/ }; do recipients+=(-r "$recipient"); done
  name=$(basename "$database")
  work=$(mktemp -d)
  {
    age "${recipients[@]}" -o "$work/$name.age" "$database" \
      && age "${recipients[@]}" -o "$work/$name.manifest.json.age" "$database.manifest.json" \
      && { [ ! -f "$database.media.tar" ] || age "${recipients[@]}" -o "$work/$name.media.tar.age" "$database.media.tar"; } \
      && rclone copy --no-traverse "$work" "$offsite_remote/$kind" \
      && rclone check --one-way "$work" "$offsite_remote/$kind"
  } || status=1
  rm -rf "$work"
  [ "$status" -eq 0 ] && echo "offsite_object=$offsite_remote/$kind/$name.age"
  return "$status"
}

# Only after an upload succeeded, so a broken remote never prunes the last
# good off-site copy. A failed prune costs storage, not data: warn only.
offsite_prune() {
  local old
  if old=$(rclone lsf -R --files-only --min-age "${offsite_keep_days}d" --include 'shark-*.age' "$offsite_remote") \
    && rclone delete --min-age "${offsite_keep_days}d" --include 'shark-*.age' "$offsite_remote"; then
    [ -z "$old" ] || printf '%s\n' "$old" | sed "s|^|offsite_pruned=$offsite_remote/|"
  else
    echo "warning: could not prune off-site copies older than $offsite_keep_days days." >&2
  fi
}

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
  # Media restores into the probe too, never over the live SHARK_MEDIA_DIR.
  SHARK_MEDIA_DIR="$probe/media" pnpm -s run db:restore "$backup" "$probe/shark.db" >/dev/null
  rm -rf "$probe"
  printf "%s\nrestore_probe=ok\n" "$out"
' sh "$kind")
result=$(printf '%s\n' "$result" | sed "s|/var/backups/shark-fitness/|$SHARK_HOME/backups/|")
echo "$result"
backup=$(printf '%s\n' "$result" | sed -n 's/^backup=//p')

offsite=skipped
if [ -n "$offsite_remote" ]; then
  if offsite_upload "$backup"; then
    offsite=uploaded
    offsite_prune
  else
    offsite=failed
  fi
fi
echo "offsite=$offsite"
result=$(printf '%s\noffsite=%s\n' "$result" "$offsite")

if [ "$offsite" = failed ]; then
  echo "The off-site upload to $offsite_remote failed. Every local copy is kept, and local pruning is skipped until an upload succeeds." >&2
  ping /fail "$result"
  # A deploy or a manual copy still has its good local backup; only the timer's
  # run is marked failed, so systemd and healthchecks.io both show it.
  if [ "$kind" = nightly ]; then exit 1; fi
  exit 0
fi

# Only after a good backup, so a run of failures never prunes the last copy.
# shark-*.db* also takes the manifest, the media archive and the empty
# -shm/-wal files SQLite leaves when the backup tool reopens a copy read-only.
find "$SHARK_HOME/backups" -type f -name 'shark-*.db*' -mtime +"$keep_days" -print -delete | sed 's/^/pruned=/'

ping "" "$result"
