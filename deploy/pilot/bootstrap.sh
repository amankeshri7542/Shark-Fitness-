#!/usr/bin/env bash
# Create the real gym, empty: one tenant, its first branch and the owner's
# account, through pnpm db:bootstrap (apps/api/src/db/bootstrap.ts). No demo
# data. A gym code that already exists is refused, never overwritten.
#
#   Run as root, after deploy.sh:  bootstrap.sh            (asks each question)
#                                  bootstrap.sh < gym.json (the JSON shape in
#                                  shark-fitness/docs/deployment-stabilization.md)
#
# The owner's password is typed at a hidden prompt and goes to the container
# on stdin only: never in argv, the environment, logs or a file.
set -euo pipefail

SHARK_HOME=${SHARK_HOME:-/srv/shark-fitness}
pilot=$(cd "$(dirname "$0")" && pwd)
cd "$pilot"
ln -sfn "$SHARK_HOME/shark.env" .env

ask() { # ask <prompt> <default>; the answer goes to stdout
  local answer
  read -rp "$1${2:+ [$2]}: " answer </dev/tty
  printf '%s' "${answer:-$2}"
}

gym_json() {
  local slug legal display tz owner email password confirm branch branch_slug address city capacity opens closes
  echo "New gym. Press Enter to accept a [default]." >/dev/tty
  slug=$(ask "Gym code members and staff type to sign in (lowercase, hyphens)" "")
  display=$(ask "Gym name shown in the apps" "")
  legal=$(ask "Legal name" "$display")
  tz=$(ask "Timezone" "Asia/Kolkata")
  owner=$(ask "Owner's full name" "")
  email=$(ask "Owner's email (their sign-in)" "")
  while :; do
    read -rsp "Owner's password (12+ characters): " password </dev/tty; echo >/dev/tty
    read -rsp "Same password again: " confirm </dev/tty; echo >/dev/tty
    [ "$password" = "$confirm" ] && [ ${#password} -ge 12 ] && break
    echo "The passwords differ or are shorter than 12 characters. Try again." >/dev/tty
  done
  branch=$(ask "First branch name" "Main")
  branch_slug=$(ask "Branch code" "main")
  address=$(ask "Branch street address" "")
  city=$(ask "Branch city" "")
  capacity=$(ask "Branch capacity (people at once)" "60")
  opens=$(ask "Opens at (24h HH:MM)" "06:00")
  closes=$(ask "Closes at (24h HH:MM, same day)" "22:00")
  for clock in "$opens" "$closes"; do
    [[ $clock =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo "Use HH:MM, e.g. 06:00, not $clock." >&2; exit 1; }
  done

  # printf is a shell builtin, so the password is never a process argument.
  printf '%s\n' "$slug" "$legal" "$display" "$tz" "$owner" "$email" "$password" \
    "$branch" "$branch_slug" "$address" "$city" "$capacity" "$opens" "$closes" |
    python3 -c '
import json, sys
(slug, legal, display, tz, owner, email, password,
 branch, branch_slug, address, city, capacity, opens, closes) = sys.stdin.read().split("\n")[:14]
minutes = lambda t: int(t[:2]) * 60 + int(t[3:])
print(json.dumps({
    "slug": slug, "legalName": legal, "displayName": display, "timezone": tz,
    "owner": {"name": owner, "email": email, "password": password},
    "branch": {"name": branch, "slug": branch_slug, "addressLine": address, "city": city,
               "capacity": int(capacity), "opensMinutes": minutes(opens), "closesMinutes": minutes(closes)},
}))'
}

if [ -t 0 ]; then
  input=$(gym_json)
else
  input=$(cat)
fi

# Migrating first is a no-op once the app has started, and lets this run on a
# database the app has not opened yet.
printf '%s' "$input" | docker compose run --rm --no-deps -T --entrypoint sh app -euc '
  pnpm -s run db:migrate </dev/null >/dev/null
  pnpm -s run db:bootstrap
'
echo
echo "Created. The owner signs in at https://$(sed -n 's/^SHARK_DOMAIN=//p' "$SHARK_HOME/shark.env" | tail -n 1)/admin/ with the gym code, email and password."
