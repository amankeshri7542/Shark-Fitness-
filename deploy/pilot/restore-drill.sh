#!/usr/bin/env bash
# Restore drill: prove a backup brings the gym back, without touching the
# running app or its database.
#
#   Run as root:  restore-drill.sh [--gym <code> --email <owner email>]
#                                  [--skip-synthetic] [--keep]
#                                  [backup.db | --from-offsite <object> --age-identity <file>]
#
# The backup defaults to the newest nightly copy. To drill a copy that has been
# off the server, scp it and its .manifest.json into $SHARK_HOME/drill/inbox/
# and pass its path.
#
# --from-offsite drills an encrypted off-site copy that backup.sh uploaded:
# <object> is the offsite_object= line backup.sh printed (remote:path/x.db.age),
# or a path under SHARK_BACKUP_OFFSITE_REMOTE such as nightly/shark-<stamp>.db.
# It downloads the copy and its manifest with rclone, decrypts both with the
# age identity file (the private key: bring it for the drill only, keep it in
# /run or /dev/shm, and delete it afterwards), checks the copy's SHA-256
# against the manifest, then runs the drill below on it. The decrypted copy is
# deleted with the drill unless --keep.
#
#   1. pnpm db:backup:verify (scripts/verify-backup-restore.mjs) in a scratch
#      container: the app's full synthetic backup-and-restore proof.
#   2. pnpm db:restore the backup into $SHARK_HOME/drill/<stamp>/, which checks
#      it against its manifest (the database and, when present, every file in
#      its media archive), then boot the deployed image on that copy with no
#      network and scheduled jobs off, so it cannot reach members.
#   3. /ready must report ready. Prints row counts. With --gym and --email,
#      signs in as the owner and reads the dashboard; the password comes from a
#      hidden prompt, or from stdin when it is not a terminal.
#
# The drill copy is deleted afterwards unless --keep.
set -euo pipefail

SHARK_HOME=${SHARK_HOME:-/srv/shark-fitness}
# rclone's remote and credentials, as `sudo rclone config` wrote them. Named
# explicitly because a systemd service may run without $HOME.
export RCLONE_CONFIG=${RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}
image=shark-fitness:pilot
keep=0 synthetic=1 gym="" email="" backup="" offsite_object="" age_identity=""
while [ $# -gt 0 ]; do
  case $1 in
    --keep) keep=1 ;;
    --skip-synthetic) synthetic=0 ;;
    --gym) gym=${2:?--gym needs a gym code}; shift ;;
    --email) email=${2:?--email needs an address}; shift ;;
    --from-offsite) offsite_object=${2:?--from-offsite needs an object}; shift ;;
    --age-identity) age_identity=${2:?--age-identity needs a file}; shift ;;
    -*) echo "Unknown option $1. See the top of restore-drill.sh." >&2; exit 64 ;;
    *) backup=$1 ;;
  esac
  shift
done
{ [ -z "$gym" ] && [ -z "$email" ]; } || { [ -n "$gym" ] && [ -n "$email" ]; } \
  || { echo "--gym and --email go together." >&2; exit 64; }
{ [ -z "$offsite_object" ] && [ -z "$age_identity" ]; } || { [ -n "$offsite_object" ] && [ -n "$age_identity" ]; } \
  || { echo "--from-offsite and --age-identity go together." >&2; exit 64; }
[ -z "$offsite_object" ] || [ -z "$backup" ] \
  || { echo "Give a backup file or --from-offsite, not both." >&2; exit 64; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
download=""

if [ -n "$offsite_object" ]; then
  [ -r "$age_identity" ] || { echo "Cannot read the age identity file $age_identity." >&2; exit 1; }
  command -v age >/dev/null && command -v rclone >/dev/null \
    || { echo "--from-offsite needs age and rclone; provision.sh installs both." >&2; exit 1; }
  object=${offsite_object%.age}
  if [[ $object != *:* ]]; then
    remote=$(sed -n 's/^SHARK_BACKUP_OFFSITE_REMOTE=//p' "$SHARK_HOME/shark.env" 2>/dev/null | tail -n 1)
    [ -n "$remote" ] || { echo "$object is not remote:path and SHARK_BACKUP_OFFSITE_REMOTE is not set in $SHARK_HOME/shark.env." >&2; exit 1; }
    object=${remote%/}/${object#/}
  fi
  object_name=$(basename "$object")
  [[ $object_name == shark-*.db ]] || { echo "$offsite_object does not name a backup (shark-<stamp>.db.age)." >&2; exit 1; }

  download=$SHARK_HOME/drill/inbox/offsite-$stamp
  install -d -m 700 "$SHARK_HOME/drill" "$SHARK_HOME/drill/inbox" "$download"
  # Until the drill's own cleanup takes over: never leave a half-decrypted copy.
  trap 'rm -rf "$download"' EXIT
  echo "0/3 Downloading and decrypting $object.age"
  rclone copyto "$object.age" "$download/$object_name.age"
  rclone copyto "$object.manifest.json.age" "$download/$object_name.manifest.json.age"
  (
    umask 077
    age -d -i "$age_identity" -o "$download/$object_name" "$download/$object_name.age"
    age -d -i "$age_identity" -o "$download/$object_name.manifest.json" "$download/$object_name.manifest.json.age"
  )
  rm -f "$download/$object_name.age" "$download/$object_name.manifest.json.age"
  # A copy with private media names its archive in the manifest; fetch it too.
  if grep -q '"archiveFile": "' "$download/$object_name.manifest.json"; then
    rclone copyto "$object.media.tar.age" "$download/$object_name.media.tar.age"
    ( umask 077; age -d -i "$age_identity" -o "$download/$object_name.media.tar" "$download/$object_name.media.tar.age" )
    rm -f "$download/$object_name.media.tar.age"
  fi
  # The database's own checksum is the top-level one (two-space indent); the
  # media section's are nested deeper and checked by db:restore.
  expected=$(sed -n 's/^  "sha256": "\([a-f0-9]\{64\}\)".*/\1/p' "$download/$object_name.manifest.json")
  actual=$(sha256sum "$download/$object_name")
  actual=${actual%% *}
  [ -n "$expected" ] && [ "$expected" = "$actual" ] \
    || { rm -rf "$download"; echo "The decrypted copy does not match its manifest." >&2; exit 1; }
  echo "offsite_download=verified sha256=$actual"
  backup=$download/$object_name
fi

if [ -z "$backup" ]; then
  backup=$(ls -1t "$SHARK_HOME"/backups/nightly/shark-*.db 2>/dev/null | head -n 1 || true)
fi
[ -n "$backup" ] && [ -f "$backup" ] && [ -f "$backup.manifest.json" ] \
  || { echo "Need a backup and its .manifest.json beside it; none given or found in $SHARK_HOME/backups/nightly." >&2; exit 1; }
docker image inspect "$image" >/dev/null 2>&1 || { echo "No $image image yet. Run deploy.sh first." >&2; exit 1; }

password=""
if [ -n "$gym" ]; then
  if [ -t 0 ]; then
    read -rsp "Owner password for $email: " password
    echo
  else
    IFS= read -r password || true
  fi
fi

drill=$SHARK_HOME/drill/$stamp
name=shark-drill-$stamp
install -d -m 700 "$SHARK_HOME/drill"
install -d -m 700 -o 1000 -g 1000 "$drill" "$drill/in"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [ "$keep" -eq 0 ]; then
    rm -rf "$drill"
    # A decrypted off-site copy holds members' personal data: it goes too.
    if [ -n "$download" ]; then rm -rf "$download"; fi
  else
    echo "kept=$drill"
    if [ -n "$download" ]; then echo "kept=$download"; fi
  fi
}
trap cleanup EXIT

if [ "$synthetic" -eq 1 ]; then
  log=$SHARK_HOME/drill/$stamp-synthetic.log
  echo "1/3 Synthetic recovery proof (pnpm db:backup:verify); this takes a minute or two."
  if docker run --rm --network none --entrypoint pnpm "$image" -s run db:backup:verify >"$log" 2>&1; then
    echo "synthetic_proof=passed log=$log"
  else
    tail -n 40 "$log" >&2
    echo "synthetic_proof=FAILED log=$log" >&2
    exit 1
  fi
else
  echo "1/3 Synthetic recovery proof skipped."
fi

echo "2/3 Restoring $backup"
install -m 600 -o 1000 -g 1000 -t "$drill/in" "$backup" "$backup.manifest.json"
if [ -f "$backup.media.tar" ]; then install -m 600 -o 1000 -g 1000 -t "$drill/in" "$backup.media.tar"; fi
# Media (if the copy has any) is checked file by file and restored beside the
# restored database, in /drill/media.
docker run --rm --network none -v "$drill:/drill" -e SHARK_MEDIA_DIR=/drill/media --entrypoint pnpm "$image" \
  -s run db:restore "/drill/in/$(basename "$backup")" /drill/shark.db
docker run -d --name "$name" --network none -v "$drill:/drill" \
  -e SHARK_DB=/drill/shark.db \
  -e SHARK_MEDIA_DIR=/drill/media \
  -e SHARK_PASS_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
  -e SHARK_PUBLIC_ORIGIN=http://127.0.0.1:8787 \
  -e SHARK_DISABLE_JOBS=true \
  -e SHARK_SERVE_STATIC=false \
  -e SHARK_SEED_DEMO=false \
  -e SHARK_RELEASE="drill-$stamp" \
  "$image" >/dev/null

echo "3/3 Booting the restored copy"
ready=""
for _ in $(seq 1 60); do
  if ready=$(docker exec "$name" node -e '
    fetch("http://127.0.0.1:8787/ready")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || body.release !== process.argv[1]) process.exit(1);
        console.log(JSON.stringify(body));
      })
      .catch(() => process.exit(1));
  ' "drill-$stamp" 2>/dev/null); then
    break
  fi
  ready=""
  sleep 2
done
if [ -z "$ready" ]; then
  echo "The restored copy did not report ready. Its logs:" >&2
  docker logs --tail 80 "$name" >&2
  exit 1
fi
echo "ready=$ready"

docker exec "$name" node -e '
  const Database = require("./apps/api/node_modules/better-sqlite3");
  const db = new Database(process.env.SHARK_DB, { readonly: true });
  for (const table of ["tenants", "branches", "users", "members", "memberships", "invoices", "payments", "check_ins", "audit_log", "media_objects"]) {
    console.log(table + "=" + db.prepare("select count(*) from " + table).pluck().get());
  }
  // Every live media row has its file, byte for byte.
  const { createHash } = require("node:crypto");
  const fs = require("node:fs");
  const rows = db.prepare("select storage_key, sha256 from media_objects where deleted_at is null").all();
  const bad = rows.filter((row) => {
    const file = "/drill/media/" + row.storage_key;
    return !fs.existsSync(file) || createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== row.sha256;
  });
  console.log("media_files_verified=" + (rows.length - bad.length) + "/" + rows.length);
  db.close();
  if (bad.length > 0) process.exit(1);
'

if [ -n "$gym" ]; then
  printf '%s' "$password" | docker exec -i "$name" node -e '
    const [tenantSlug, email] = process.argv.slice(1);
    const password = require("node:fs").readFileSync(0, "utf8");
    const origin = "http://127.0.0.1:8787";
    (async () => {
      const signIn = await fetch(origin + "/v1/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ tenantSlug, email, password }),
      });
      console.log("owner_sign_in=" + signIn.status);
      if (!signIn.ok) process.exit(1);
      const session = signIn.headers.get("set-cookie")?.match(/shark_session=([^;,]+)/)?.[1];
      const dashboard = await fetch(origin + "/v1/admin/dashboard", { headers: { cookie: "shark_session=" + session, origin } });
      console.log("owner_dashboard=" + dashboard.status);
      if (!dashboard.ok) process.exit(1);
    })().catch((error) => { console.error(error.message); process.exit(1); });
  ' "$gym" "$email"
fi

echo "drill=passed backup=$backup"
