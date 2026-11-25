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

## v3: parallel runner (25 Nov 2026)
- `schedule.json` is the DAG: P02, P03, P04, P06 branch from P01's head and run in parallel; P05 stacks on P02; P07 on P06.
  INT1 is a Claude Code session that merges P02-P07 into `integration/features` (never main) and resolves conflicts.
  P08, P09, P10 run in parallel from it; INT2 merges them into `integration/qa`; then P11, then P12.
- Cap: 4 Shark sessions at once, and the runner never launches when 6 or more `claude -p` processes already run on the box
  (other projects included). It won't launch with less than 2 GB of RAM free.
- Each node runs in its own worktree `/workspace/sf-wt/<ID>` (P01 stays in `/workspace/shark-fitness-repo`), with its own port block.
- Stalls: no session jsonl, output, commit, index or CPU activity for 30 min, so the runner kills that session's process tree and resumes it
  with `claude --resume`. After 2 stalled resumes, it restarts the attempt fresh.
- Adoption: `logs/<ID>.run.json` records the live claude pid. A restarted runner waits on it instead of launching a duplicate.
- Originals (v2) backed up in /home/box/opt/shark-orch-backup/orch-2026-11-25-pre-parallel/.
