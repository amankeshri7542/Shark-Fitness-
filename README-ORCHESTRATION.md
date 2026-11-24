# Shark Fitness orchestration (box-side)

Orchestration only. All product code is written by the Claude Code CLI (`claude-opus-5-5`, `--effort high`), driven by
prompts written per Anthropic's prompting best-practices guide (see PROMPT-GUIDE-NOTES.md).

- `runner.py`: sequential phase runner (P01..P12 from `phases.json`, specs in `PHASE-PLAN.md`). Per phase: implementation
  session (+ up to 3 continuations), fresh review session, runner-verified gates (typecheck/lint/test/build/e2e with a
  temporary SHARK_DB), plain push, stacked PR via `gh`. Usage limits: wait 30 min and resume. `STOP` file stops it.
- Reset safety (v2, 24 Nov 2026): the phase branch is pushed within ~1 minute of each commit and at least every
  20 minutes while a session runs; this folder (minus `logs/`) is committed to the orphan branch `orchestration/state`
  and pushed after every state change. Never force-pushes.
- `start-runner.sh`: idempotent. Installs Node 22 (/home/box/opt/node22) and Claude Code if missing, clones the repo if
  missing, restores this folder from `origin/orchestration/state` if missing, checks both logins, then starts the runner
  under `flock /tmp/shark-runner.lock`. It resumes whatever `state.json` says, reusing the pushed phase branch.
- Fresh box: `curl -fsSL https://raw.githubusercontent.com/amankeshri7542/Shark-Fitness-/orchestration/state/start-runner.sh | bash`
