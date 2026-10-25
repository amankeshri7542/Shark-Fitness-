#!/usr/bin/env bash
# Restore drill: prove a backup brings the gym back, without touching the
# running app or its database.
#
#   Run as root:  restore-drill.sh [--gym <code> --email <owner email>]
#                                  [--skip-synthetic] [--keep] [backup.db]
#
# The backup defaults to the newest nightly copy. To drill a copy that has been
# off the server, scp it and its .manifest.json into $SHARK_HOME/drill/inbox/
# and pass its path.
#
#   1. pnpm db:backup:verify (scripts/verify-backup-restore.mjs) in a scratch
#      container: the app's full synthetic backup-and-restore proof.
#   2. pnpm db:restore the backup into $SHARK_HOME/drill/<stamp>/, which checks
#      it against its manifest, then boot the deployed image on that copy with
#      no network and scheduled jobs off, so it cannot reach members.
#   3. /ready must report ready. Prints row counts. With --gym and --email,
#      signs in as the owner and reads the dashboard; the password comes from a
#      hidden prompt, or from stdin when it is not a terminal.
#
# The drill copy is deleted afterwards unless --keep.
set -euo pipefail

SHARK_HOME=${SHARK_HOME:-/srv/shark-fitness}
image=shark-fitness:pilot
keep=0 synthetic=1 gym="" email="" backup=""
while [ $# -gt 0 ]; do
  case $1 in
    --keep) keep=1 ;;
    --skip-synthetic) synthetic=0 ;;
    --gym) gym=${2:?--gym needs a gym code}; shift ;;
    --email) email=${2:?--email needs an address}; shift ;;
    -*) echo "Unknown option $1. See the top of restore-drill.sh." >&2; exit 64 ;;
    *) backup=$1 ;;
  esac
  shift
done
{ [ -z "$gym" ] && [ -z "$email" ]; } || { [ -n "$gym" ] && [ -n "$email" ]; } \
  || { echo "--gym and --email go together." >&2; exit 64; }

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

stamp=$(date -u +%Y%m%dT%H%M%SZ)
drill=$SHARK_HOME/drill/$stamp
name=shark-drill-$stamp
install -d -m 700 "$SHARK_HOME/drill"
install -d -m 700 -o 1000 -g 1000 "$drill" "$drill/in"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [ "$keep" -eq 0 ]; then rm -rf "$drill"; else echo "kept=$drill"; fi
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
docker run --rm --network none -v "$drill:/drill" --entrypoint pnpm "$image" \
  -s run db:restore "/drill/in/$(basename "$backup")" /drill/shark.db
docker run -d --name "$name" --network none -v "$drill:/drill" \
  -e SHARK_DB=/drill/shark.db \
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
  for (const table of ["tenants", "branches", "users", "members", "memberships", "invoices", "payments", "check_ins", "audit_log"]) {
    console.log(table + "=" + db.prepare("select count(*) from " + table).pluck().get());
  }
  db.close();
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
