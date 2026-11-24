#!/usr/bin/env python3
"""Sequential phase runner for Shark Fitness. Orchestration only: all product code is written by Claude Code.
Usage: runner.py [--only P01] | runner.py --sync-state | runner.py --push-phase
Create a STOP file in this dir to stop after the current step.

v2 (2026-11-24, after the box reset): Node 22 lives in /home/box/opt/node22; the phase branch is pushed to
origin after every commit (polled each minute) and at least every 20 minutes while a session runs; the
orchestration folder (no logs) is mirrored to the orphan branch `orchestration/state` after every state change.
Pushes are always plain fast-forward pushes, never forced."""
import json, os, re, subprocess, sys, time, datetime, pathlib, shutil, threading, zoneinfo

ORCH = pathlib.Path("/workspace/shark-fitness-orchestration")
REPO = pathlib.Path("/workspace/shark-fitness-repo")
LOGS = ORCH / "logs"; PHASES = ORCH / "phases"; PR = ORCH / "pr"
STATE = ORCH / "state.json"
MODEL = "claude-opus-5-5"
FIRST_BASE = "claude/musing-wilbur-d67503"   # PR #27 branch; phase 1 finishes it
STATE_BRANCH = "orchestration/state"
NODE_DIR = "/home/box/opt/node22"
CLAUDE = "/home/box/.local/bin/claude" if os.path.exists("/home/box/.local/bin/claude") else (shutil.which("claude") or "claude")
DENY = ["Bash(git push*)", "Bash(git reset --hard*)", "Bash(git rebase*)", "Bash(git branch -D*)",
        "Bash(git branch -d*)", "Bash(git push --force*)", "Bash(gh pr merge*)", "Bash(gh pr create*)",
        "Bash(gh pr close*)", "Bash(gh pr comment*)", "Bash(gh pr review*)", "Bash(gh issue*)",
        "Bash(gh release*)", "Bash(gh repo*)", "Bash(git checkout main*)", "Bash(git switch main*)",
        "Bash(vercel*)", "Bash(render*)", "Bash(flyctl*)", "Bash(railway*)"]
ENV = dict(os.environ, COREPACK_HOME="/home/box/.corepack", CI="1", TZ="Asia/Kolkata",
           PATH=f"{NODE_DIR}/bin:/home/box/.local/bin:" + os.environ.get("PATH", ""))
NODE22 = rf"""test -x {NODE_DIR}/bin/node || {{ V=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys;print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))'); mkdir -p {NODE_DIR} && curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz | tar -xJ -C {NODE_DIR} --strip-components=1; }}; test -x {NODE_DIR}/bin/pnpm || corepack enable --install-directory {NODE_DIR}/bin pnpm; node -v"""
LIMIT_RE = re.compile(r"usage limit|hit your limit|limit reached|rate[ _-]?limit|429|overloaded|quota", re.I)
# Files mirrored to orchestration/state (never logs/, which can hold tool output).
SYNC_GLOBS = ["runner.py", "start-runner.sh", "phases.json", "state.json", "STATUS.md", "PHASE-PLAN.md",
              "PROMPT-GUIDE-NOTES.md", "README-ORCHESTRATION.md", "prompts/*", "phases/*", "pr/*"]
PUSH_POLL_S = 60          # check for new commits this often while a session runs
PUSH_MAX_GAP_S = 20 * 60  # and push / sync at least this often
GIT_LOCK = threading.Lock()

def now(): return datetime.datetime.now(zoneinfo.ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d %H:%M IST")
def log(msg):
    line = f"[{now()}] {msg}"; print(line, flush=True)
    LOGS.mkdir(exist_ok=True)
    with open(LOGS / "runner.log", "a") as f: f.write(line + "\n")
def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {"phases": {}}
def save_state(s, sync=True):
    STATE.write_text(json.dumps(s, indent=2)); write_status(s)
    if sync: sync_state("state: " + ", ".join(f"{k}={v.get('state')}" for k, v in s.get("phases", {}).items()))
def sh(cmd, cwd=None, check=False, env=None):
    r = subprocess.run(cmd, cwd=cwd or REPO, shell=True, capture_output=True, text=True, env=env or ENV)
    if check and r.returncode: raise RuntimeError(f"{cmd}: {r.stderr[-2000:]}")
    return r

def write_status(s):
    if not (ORCH / "phases.json").exists(): return
    rows = ["| Phase | Title | State | Branch | PR | Checks (runner-verified) | Notes |", "|---|---|---|---|---|---|---|"]
    for p in plan():
        st = s["phases"].get(p["id"], {})
        rows.append(f"| {p['id']} | {p['title']} | {st.get('state','pending')} | `{branch(p)}` | {st.get('pr','')} | {st.get('checks','')} | {st.get('note','')} |")
    blockers = s.get("blockers", [])
    txt = f"# Shark Fitness build status\n\nUpdated {now()} by runner.py. Model: `{MODEL}` (Claude Code CLI, effort high).\n\n" \
          f"Runner: `{ORCH}/runner.py`, log `{LOGS}/runner.log`, per-phase logs `{LOGS}/<phase>-*.json`.\n" \
          f"Backups on origin: phase branches `phase/*` (pushed after every commit), orchestration state on `{STATE_BRANCH}`.\n" \
          f"Last pushes: {json.dumps(s.get('pushes', {}))}\n\n" + "\n".join(rows) + \
          "\n\n## Blockers / waiting\n" + ("\n".join(f"- {b}" for b in blockers) or "- none") + "\n"
    (ORCH / "STATUS.md").write_text(txt)

def plan(): return json.loads((ORCH / "phases.json").read_text())["phases"]
def branch(p): return f"phase/{p['id']}-{p['slug']}"
def section(pid):
    text = (ORCH / "PHASE-PLAN.md").read_text()
    m = re.search(rf"^## Phase {pid}:.*?(?=^## |\Z)", text, re.S | re.M)
    sec = m.group(0).strip() if m else f"(section for {pid} not found; read PHASE-PLAN.md)"
    b = re.search(r"^## Environment bootstrap.*?(?=^## |\Z)", text, re.S | re.M)
    return (b.group(0).strip() + "\n\n" if b else "") + sec
def render(tpl, p, base):
    t = (ORCH / "prompts" / tpl).read_text()
    for k, v in {"ID": p["id"], "TITLE": p["title"], "BRANCH": branch(p), "BASE": base, "SECTION": section(p["id"])}.items():
        t = t.replace("{{" + k + "}}", v)
    return t

# ---------- backups to origin (plain pushes only, never --force) ----------
def push_branch(b):
    """Push local branch b to origin if it is ahead. Refuses (and records a blocker) if origin has diverged."""
    if not b or b in ("main", "master") or not b.startswith("phase/"): return False
    msg = ""
    with GIT_LOCK:
        if sh(f"git rev-parse --verify --quiet refs/heads/{b}").returncode: return False
        sh(f"git fetch origin --quiet {b}")
        if sh(f"git rev-parse --verify --quiet refs/remotes/origin/{b}").returncode == 0:
            if sh(f"git rev-list --count origin/{b}..{b}").stdout.strip() == "0": return False
            if sh(f"git merge-base --is-ancestor origin/{b} {b}").returncode:
                msg = f"push of {b} skipped: origin/{b} has diverged from local (no force-push; needs a human)"
        if not msg: r = sh(f"git push --quiet -u origin refs/heads/{b}:refs/heads/{b}")
    if msg:
        log(msg); s = load_state(); bl = s.setdefault("blockers", [])
        if msg not in bl: bl.append(msg); save_state(s)
        return False
    if r.returncode: log(f"push of {b} failed: {r.stderr.strip()[-300:]}"); return False
    head = sh(f"git rev-parse --short {b}").stdout.strip()
    log(f"pushed {b} @ {head}")
    s = load_state(); s.setdefault("pushes", {})[b] = f"{head} at {now()}"; save_state(s)
    return True

def sync_state(msg="sync"):
    """Commit the orchestration folder (no logs) onto orphan branch orchestration/state and push it (fast-forward)."""
    files = sorted({str(f.relative_to(ORCH)) for g in SYNC_GLOBS for f in ORCH.glob(g) if f.is_file()})
    if not files or not (REPO / ".git").exists(): return
    idx = f"/tmp/shark-orch-index-{os.getpid()}-{threading.get_ident()}"
    genv = dict(ENV, GIT_INDEX_FILE=idx, GIT_WORK_TREE=str(ORCH), GIT_DIR=str(REPO / ".git"))
    with GIT_LOCK:
        try:
            sh(f"git fetch origin --quiet {STATE_BRANCH}", env=genv)
            parent = sh(f"git rev-parse --verify --quiet refs/remotes/origin/{STATE_BRANCH}", env=genv).stdout.strip()
            sh("rm -f " + idx); sh("git read-tree --empty", env=genv, check=True)
            sh("git add -f -- " + " ".join(f"'{f}'" for f in files), cwd=ORCH, env=genv, check=True)
            tree = sh("git write-tree", env=genv, check=True).stdout.strip()
            if parent and sh(f"git rev-parse {parent}^{{tree}}", env=genv).stdout.strip() == tree: return
            commit = sh(f"git commit-tree {tree} {'-p ' + parent if parent else ''} -m {json.dumps(msg[:300])}", env=genv, check=True).stdout.strip()
            r = sh(f"git push --quiet origin {commit}:refs/heads/{STATE_BRANCH}", env=genv)
            if r.returncode: print(f"[{now()}] state sync push failed: {r.stderr.strip()[-300:]}", flush=True)
            else: sh(f"git update-ref refs/remotes/origin/{STATE_BRANCH} {commit}", env=genv)
        except Exception as e:
            print(f"[{now()}] state sync failed: {e}", flush=True)
        finally:
            sh("rm -f " + idx)

class Pusher(threading.Thread):
    """While a Claude session runs: push the phase branch within ~1 min of each commit, and at least every 20 min."""
    def __init__(self, b):
        super().__init__(daemon=True); self.b = b; self.stop = threading.Event()
    def run(self):
        last = time.time()
        while not self.stop.wait(PUSH_POLL_S):
            try:
                pushed = push_branch(self.b)
                if pushed or time.time() - last >= PUSH_MAX_GAP_S:
                    sync_state(f"progress sync during {self.b}"); last = time.time()
            except Exception as e:
                print(f"[{now()}] pusher error: {e}", flush=True)

def run_claude(prompt, tag, resume=None, max_turns=400, push=None):
    """Runs claude -p; waits and retries on usage limits. Returns parsed JSON result (or {})."""
    attempt = 0
    while True:
        if (ORCH / "STOP").exists(): log("STOP file present; exiting"); sys.exit(0)
        attempt += 1
        out = LOGS / f"{tag}-{attempt}.json"; err = LOGS / f"{tag}-{attempt}.err"
        cmd = [CLAUDE, "-p", prompt, "--model", MODEL, "--effort", "high", "--dangerously-skip-permissions",
               "--add-dir", str(ORCH), "--max-turns", str(max_turns), "--output-format", "json",
               "--disallowedTools", *DENY]
        if resume: cmd += ["--resume", resume]
        log(f"claude run {tag} attempt {attempt} (resume={resume})")
        pusher = Pusher(push) if push else None
        if pusher: pusher.start()
        try:
            with open(out, "w") as o, open(err, "w") as e:
                rc = subprocess.run(cmd, cwd=REPO, stdout=o, stderr=e, env=ENV).returncode
        finally:
            if pusher: pusher.stop.set(); pusher.join(timeout=120)
        if push: push_branch(push); sync_state(f"after {tag} attempt {attempt}")
        raw = out.read_text() + err.read_text()
        try: res = json.loads(out.read_text().strip().splitlines()[-1])
        except Exception: res = {}
        limited = (res.get("is_error") and LIMIT_RE.search(str(res.get("result", "")) + str(res.get("api_error_status", "")))) \
                  or (not res and LIMIT_RE.search(raw))
        if limited:
            s = load_state(); msg = f"{now()}: Claude usage limit hit during {tag}; waiting 30 min then retrying"
            s.setdefault("blockers", []).append(msg); save_state(s); log(msg)
            if res.get("session_id"): resume = res["session_id"]; prompt = "You were interrupted by a usage limit. Continue the task from where you stopped; check your progress file first."
            time.sleep(1800); s = load_state(); s["blockers"] = [b for b in s["blockers"] if b != msg]; save_state(s)
            continue
        if not res and attempt < 4:
            log(f"claude run {tag} produced no JSON (rc={rc}); retry in 2 min"); time.sleep(120); continue
        log(f"claude run {tag} finished rc={rc} subtype={res.get('subtype')} turns={res.get('num_turns')} cost={res.get('total_cost_usd')}")
        return res

def progress_done(pid):
    f = PHASES / f"{pid}-progress.json"
    try: return json.loads(f.read_text()).get("status") == "done"
    except Exception: return False

def checks():
    sh(NODE22)
    r = sh("export SHARK_DB=$(mktemp -d)/shark.db; pnpm install --frozen-lockfile >/dev/null 2>&1; C='typecheck lint test build'; grep -q '\"e2e\"' package.json && C=\"$C e2e\"; for c in $C; do pnpm $c >/tmp/sf-$c.log 2>&1 && echo \"$c:pass\" || echo \"$c:FAIL\"; done", cwd=REPO / "shark-fitness")
    return " ".join(r.stdout.split())

def ensure_branch(p, base):
    """Reuse the local branch, else the pushed origin branch (fresh box), else create from base."""
    b = branch(p)
    sh("git fetch origin --quiet")
    local = sh(f"git rev-parse --verify --quiet refs/heads/{b}").returncode == 0
    remote = sh(f"git rev-parse --verify --quiet refs/remotes/origin/{b}").returncode == 0
    if local:
        sh(f"git checkout {b}", check=True)
        if remote and sh(f"git merge-base --is-ancestor {b} origin/{b}").returncode == 0:
            sh(f"git merge --ff-only origin/{b}")   # local behind origin: fast-forward only
    elif remote:
        sh(f"git checkout -b {b} --track origin/{b}", check=True); log(f"restored {b} from origin")
    else:
        start = base if sh(f"git rev-parse --verify --quiet {base}").returncode == 0 else f"origin/{base}"
        sh(f"git checkout -b {b} {start}", check=True)

def open_pr(p, base):
    b = branch(p); s = load_state()
    push_branch(b)
    sh(f"git push -u origin {b}", check=True)   # never force
    existing = sh(f"gh pr list --head {b} --state all --json url -q '.[0].url'").stdout.strip()
    if existing: return existing
    f = PR / f"{p['id']}.md"
    body = f.read_text() if f.exists() else f"Phase {p['id']}: {p['title']}\n\nSee PHASE-PLAN.md."
    lines = body.splitlines(); title = lines[0].lstrip("# ").strip() if lines and lines[0].startswith("#") else f"{p['id']}: {p['title']}"
    rest = "\n".join(lines[1:]) if lines and lines[0].startswith("#") else body
    rest += f"\n\n---\nStacked PR: base `{base}`. Phase {p['id']} of the Shark Fitness build plan. Code written by Claude Code (`{MODEL}`), reviewed by a separate fresh Claude Code session. Not merged automatically; please review."
    bf = PR / f"{p['id']}.body.md"; bf.write_text(rest)
    r = sh(f"gh pr create --base '{base}' --head '{b}' --title {json.dumps(title[:200])} --body-file '{bf}'")
    if r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip().splitlines()[-1]

def run_phase(p, base):
    s = load_state(); st = s["phases"].setdefault(p["id"], {})
    pid = p["id"]; b = branch(p)
    log("node: " + sh(NODE22).stdout.strip())
    ensure_branch(p, base)
    if st.get("state") in (None, "pending", "implementing"):
        st["state"] = "implementing"; save_state(s)
        res = run_claude(render("impl-template.md", p, base), f"{pid}-impl", push=b)
        sid = res.get("session_id")
        for i in range(3):
            if progress_done(pid) and not sh("git status --porcelain").stdout.strip(): break
            if (sh("git branch --show-current").stdout.strip() != b): sh(f"git checkout {b}")
            res = run_claude(f"Your checklist in /workspace/shark-fitness-orchestration/phases/{pid}-progress.json is not marked done, or the working tree has uncommitted changes. Continue with the open items, run the full verification, commit everything on {b}, write pr/{pid}.md, and set status done. If an item is truly blocked, mark it blocked with the reason and finish.",
                             f"{pid}-impl-cont{i+1}", resume=sid, push=b)
            sid = res.get("session_id", sid)
        s = load_state(); st = s["phases"][pid]
        st["state"] = "reviewing"; st["note"] = "" if progress_done(pid) else "impl not marked done after 3 continuations"; save_state(s)
    if st.get("state") == "reviewing":
        sh(f"git checkout {b}")
        run_claude(render("review-template.md", p, base), f"{pid}-review", max_turns=250, push=b)
        if sh("git status --porcelain").stdout.strip():
            run_claude(f"Commit all remaining changes from your review on {b} with a fix:/test: message and make sure the working tree is clean.", f"{pid}-review-commit", max_turns=30, push=b)
        s = load_state(); st = s["phases"][pid]
        st["checks"] = checks(); st["state"] = "pr"; save_state(s)
    if st.get("state") == "pr":
        try: st["pr"] = open_pr(p, base); st["state"] = "done"
        except Exception as e: st["state"] = "pr"; st["note"] = f"PR/push failed: {str(e)[:200]}"; log(st["note"])
        save_state(s)
    return st.get("state") == "done"

def discover():
    """Regenerate PHASE-PLAN.md + phases.json with a read-only Claude Code discovery session if they are missing."""
    pp, pj = ORCH / "PHASE-PLAN.md", ORCH / "phases.json"
    if pp.exists() and pp.stat().st_size > 10_000 and pj.exists() and pj.stat().st_size > 0: return
    log("PHASE-PLAN.md/phases.json missing: running the Claude Code discovery session (prompts/00-discovery.md)")
    run_claude((ORCH / "prompts" / "00-discovery.md").read_text(), "00-discovery")
    if not (pp.exists() and pj.exists()): log("discovery did not produce PHASE-PLAN.md and phases.json; stopping"); sys.exit(1)
    sync_state("discovery: regenerated PHASE-PLAN.md and phases.json")

def main():
    discover()
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    s = load_state(); save_state(s)
    base = FIRST_BASE
    for p in plan():
        if only and p["id"] != only: base = branch(p); continue
        st = s["phases"].get(p["id"], {})
        if st.get("state") != "done":
            log(f"=== phase {p['id']} {p['title']} (base {base}) ===")
            ok = run_phase(p, base)
            if not ok: log(f"phase {p['id']} not completed (state {load_state()['phases'][p['id']].get('state')}); continuing with next phase stacked on it")
        s = load_state(); base = branch(p)
    log("all phases processed"); s = load_state(); s["finished"] = now(); save_state(s)

if __name__ == "__main__":
    LOGS.mkdir(exist_ok=True); PHASES.mkdir(exist_ok=True); PR.mkdir(exist_ok=True)
    if "--sync-state" in sys.argv:
        sync_state(sys.argv[sys.argv.index("--sync-state") + 1] if len(sys.argv) > sys.argv.index("--sync-state") + 1 else "manual sync"); sys.exit(0)
    if "--push-phase" in sys.argv:
        st = load_state()["phases"]
        for p in plan():
            if p["id"] in st: push_branch(branch(p))
        sys.exit(0)
    main()
