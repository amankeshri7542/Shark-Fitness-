#!/usr/bin/env bash
# Take a fresh backup on the pilot server and copy it, with its manifest, to
# the machine you run this on: the off-server copy. Checks the copy's SHA-256
# against the manifest. Works with macOS's bash 3.2.
#
#   pull-backup.sh <user@host> [destination]   (default: ~/shark-pilot-backups)
#
# Uses the SSH key in SHARK_SSH_KEY (default ~/.ssh/shark_pilot_ed25519) when it
# exists. The copy holds members' personal data: keep the folder private.
set -euo pipefail

host=${1:?Usage: pull-backup.sh <user@host> [destination]}
dest=${2:-$HOME/shark-pilot-backups}
key=${SHARK_SSH_KEY:-$HOME/.ssh/shark_pilot_ed25519}
remote_home=${SHARK_REMOTE_HOME:-/srv/shark-fitness}
ssh_opts=()
[ -f "$key" ] && ssh_opts=(-i "$key")

backup=$(ssh ${ssh_opts[@]+"${ssh_opts[@]}"} "$host" "$remote_home/src/deploy/pilot/backup.sh manual" | sed -n 's/^backup=//p')
[ -n "$backup" ] || { echo "The server did not report a backup." >&2; exit 1; }

mkdir -p "$dest"
chmod 700 "$dest"
scp -q ${ssh_opts[@]+"${ssh_opts[@]}"} "$host:$backup" "$host:$backup.manifest.json" "$dest/"
file=$dest/$(basename "$backup")
chmod 600 "$file" "$file.manifest.json"

expected=$(sed -n 's/.*"sha256": "\([a-f0-9]\{64\}\)".*/\1/p' "$file.manifest.json")
if command -v shasum >/dev/null; then actual=$(shasum -a 256 "$file"); else actual=$(sha256sum "$file"); fi
actual=${actual%% *}
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "The copy of $file does not match its manifest." >&2; exit 1; }

echo "copied=$file"
echo "sha256=$actual"
