#!/bin/sh
set -eu

DB_PATH="${SHARK_DB:-/tmp/shark-fitness/shark.db}"
export SHARK_DB="$DB_PATH"
mkdir -p "$(dirname "$DB_PATH")"

fresh=0
if [ ! -f "$DB_PATH" ]; then
  fresh=1
fi

pnpm db:migrate
if [ "$fresh" -eq 1 ]; then
  pnpm db:seed
fi

exec pnpm -F @shark/api start
