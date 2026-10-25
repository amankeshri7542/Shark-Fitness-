#!/usr/bin/env bash
# Build and start a git ref of Shark Fitness on the pilot server.
#
#   Run as root:  deploy.sh [ref]     (default: origin/main)
#                 deploy.sh --current (the checkout exactly as it is; CI uses this)
#
# Takes a pre-deploy backup when a database exists, because the new release
# migrates it on start and migrations only go forward. Then it builds the image,
# tags it with the commit, restarts, and waits until /ready reports this commit.
#
# Rolling back is deploying the earlier commit: deploy.sh <commit>. If that
# commit cannot read the migrated database, restore the pre-deploy backup
# (shark-fitness/docs/PILOT-HOSTING.md, "Rolling back").
set -euo pipefail

# Everything runs from main, which bash reads in full before running, because
# `git checkout` below rewrites this file.
main() {
  local ref=${1:-origin/main}
  local SHARK_HOME=${SHARK_HOME:-/srv/shark-fitness}
  local pilot
  pilot=$(cd "$(dirname "$0")" && pwd)
  [ -f "$SHARK_HOME/shark.env" ] || { echo "No $SHARK_HOME/shark.env. Run provision.sh first." >&2; exit 1; }

  cd "$pilot"
  if [ "$ref" != "--current" ]; then
    git fetch --quiet origin
    git checkout --quiet --detach "$ref"
  fi
  local release
  release=$(git rev-parse --short=12 HEAD)
  ln -sfn "$SHARK_HOME/shark.env" .env
  echo "Deploying $release."

  if [ -f "$SHARK_HOME/data/shark.db" ] && docker image inspect shark-fitness:pilot >/dev/null 2>&1; then
    "$pilot/backup.sh" pre-deploy
  fi

  docker compose build app
  docker tag shark-fitness:pilot "shark-fitness:$release"
  printf 'SHARK_RELEASE=%s\n' "$release" > "$SHARK_HOME/release.env"
  docker compose up -d --remove-orphans

  local ready=""
  for _ in $(seq 1 60); do
    if ready=$(docker compose exec -T app node -e '
      fetch("http://127.0.0.1:8787/ready")
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok || body.release !== process.argv[1]) process.exit(1);
          console.log(JSON.stringify(body));
        })
        .catch(() => process.exit(1));
    ' "$release" 2>/dev/null); then
      break
    fi
    ready=""
    sleep 2
  done
  if [ -z "$ready" ]; then
    echo "The app did not report ready for $release within two minutes. Recent logs:" >&2
    docker compose logs --tail 80 app >&2
    exit 1
  fi
  echo "ready=$ready"

  local domain
  domain=$(sed -n 's/^SHARK_DOMAIN=//p' "$SHARK_HOME/shark.env" | tail -n 1)
  if curl -fsS --max-time 15 -o /dev/null "https://$domain/ready"; then
    echo "https://$domain/ready answers."
  else
    echo "warning: https://$domain/ready does not answer yet. Check the A record, then: docker compose logs caddy" >&2
  fi

  docker image prune -f >/dev/null
}

main "$@"
