#!/usr/bin/env bash
# Idempotent launcher for the Shark Fitness phase runner (orchestration only; Claude Code writes all product code).
#   start-runner.sh               restore anything missing, check logins, start runner.py in the background
#   start-runner.sh --foreground  same, but run in the foreground
#   start-runner.sh --check       restore + check only, do not start
#   start-runner.sh <PID>         (legacy) wait for PID to exit first
# On a fresh box it can be fetched from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/amankeshri7542/Shark-Fitness-/orchestration/state/start-runner.sh | bash
set -uo pipefail
ORCH=/workspace/shark-fitness-orchestration
REPO=/workspace/shark-fitness-repo
URL=https://github.com/amankeshri7542/Shark-Fitness-.git
STATE_BRANCH=orchestration/state
NODE_DIR=/home/box/opt/node22
LOCK=/tmp/shark-runner.lock
export COREPACK_HOME=/home/box/.corepack TZ=Asia/Kolkata
export PATH="$NODE_DIR/bin:/home/box/.local/bin:$PATH"
MODE=background
case "${1:-}" in
  --foreground) MODE=foreground ;;
  --check) MODE=check ;;
  [0-9]*) while kill -0 "$1" 2>/dev/null; do sleep 30; done ;;
esac
say() { echo "[$(date '+%Y-%m-%d %H:%M IST')] start-runner: $*"; mkdir -p "$ORCH/logs" 2>/dev/null && echo "[$(date '+%Y-%m-%d %H:%M IST')] start-runner: $*" >> "$ORCH/logs/runner.log"; }

# 0. Already running? (runner.py holds the flock for its whole life)
if ! flock -n "$LOCK" true 2>/dev/null; then say "runner already running (lock $LOCK held); nothing to do"; exit 0; fi

# 1. Node 22 + pnpm (better-sqlite3 needs Node 22)
if [ ! -x "$NODE_DIR/bin/node" ]; then
  V=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys;print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))')
  mkdir -p "$NODE_DIR" && curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz" | tar -xJ -C "$NODE_DIR" --strip-components=1 || { say "Node 22 install failed"; exit 1; }
fi
[ -x "$NODE_DIR/bin/pnpm" ] || corepack enable --install-directory "$NODE_DIR/bin" pnpm
say "node $(node -v)"

# 2. Claude Code CLI (native build). The installer may leave a stale npm-style symlink; point it at the binary.
if ! /home/box/.local/bin/claude --version >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
  latest=$(ls -1t /home/box/.local/share/claude/versions/ 2>/dev/null | head -1)
  if ! /home/box/.local/bin/claude --version >/dev/null 2>&1 && [ -n "$latest" ]; then
    mkdir -p /home/box/.local/bin && ln -sfn "/home/box/.local/share/claude/versions/$latest" /home/box/.local/bin/claude
  fi
fi
/home/box/.local/bin/claude --version >/dev/null 2>&1 || { say "Claude Code CLI missing and install failed"; exit 1; }
say "claude $(/home/box/.local/bin/claude --version)"

# 3. Repository: clone if missing or an empty stub (stub is moved aside, never deleted)
if ! git -C "$REPO" rev-parse --verify -q HEAD >/dev/null 2>&1; then
  [ -e "$REPO" ] && mv "$REPO" "$REPO.stub-$(date +%s)"
  git clone -q "$URL" "$REPO" || { say "clone failed (is gh logged in?)"; exit 1; }
  say "cloned $URL"
fi
git -C "$REPO" config user.name >/dev/null || git -C "$REPO" config user.name sauravkeshri333
git -C "$REPO" config user.email >/dev/null || git -C "$REPO" config user.email sauravkeshri333@gmail.com
git -C "$REPO" fetch -q origin || say "warning: git fetch failed"

# 4. Orchestration folder: restore missing files from origin/orchestration/state (existing local files win)
if [ ! -f "$ORCH/runner.py" ] || [ ! -f "$ORCH/state.json" ] || [ ! -f "$ORCH/phases.json" ] || [ ! -f "$ORCH/PHASE-PLAN.md" ]; then
  if git -C "$REPO" rev-parse --verify -q "refs/remotes/origin/$STATE_BRANCH" >/dev/null; then
    mkdir -p "$ORCH" && git -C "$REPO" archive "origin/$STATE_BRANCH" | tar -x -C "$ORCH" --skip-old-files
    say "restored orchestration files from origin/$STATE_BRANCH ($(git -C "$REPO" rev-parse --short origin/$STATE_BRANCH))"
  else
    say "no origin/$STATE_BRANCH to restore from"
  fi
fi
[ -f "$ORCH/runner.py" ] || { say "runner.py missing and could not be restored"; exit 1; }
[ -f "$ORCH/prompts/impl-template.md" ] || { say "prompts missing"; exit 1; }
mkdir -p "$ORCH/logs" "$ORCH/phases" "$ORCH/pr"
[ -f "$ORCH/PHASE-PLAN.md" ] || say "PHASE-PLAN.md missing: runner will run the discovery session first"

# 5. Logins (never performed here; a human must log in)
ok=1
if ! /home/box/.local/bin/claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then say "Claude Code is NOT logged in: run 'claude auth login' (account sauravkeshri333@gmail.com)"; ok=0; fi
if ! gh auth status >/dev/null 2>&1; then say "gh is NOT logged in: run 'gh auth login -h github.com -p https -w' (account amankeshri7542)"; ok=0; fi
[ $ok = 1 ] || exit 2
say "logins OK; state: $(python3 -c "import json;print({k:v.get('state') for k,v in json.load(open('$ORCH/state.json'))['phases'].items()})" 2>/dev/null)"

[ "$MODE" = check ] && { say "check only; not starting"; exit 0; }
rm -f "$ORCH/STOP"
cd "$ORCH"
if [ "$MODE" = foreground ]; then
  exec flock -n "$LOCK" python3 runner.py >> logs/runner.out 2>&1
else
  setsid nohup flock -n "$LOCK" python3 runner.py >> logs/runner.out 2>&1 < /dev/null &
  sleep 3; say "runner started in background (pid $!); log: $ORCH/logs/runner.log, status: $ORCH/STATUS.md"
fi
