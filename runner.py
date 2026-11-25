#!/usr/bin/env python3
"""Parallel phase runner for Shark Fitness (v3, 25 Nov 2026). Orchestration only: all product code is written by Claude Code.

Usage: runner.py | runner.py --dry-run | runner.py --sync-state [msg] | runner.py --push-phase
Create a STOP file in this dir to stop launching new Claude sessions (running ones finish their current step).

- schedule.json defines a DAG of nodes (phases and Claude-run integration merges), a concurrency cap, and the stall timeout.
- Each node runs in its own git worktree (P01 keeps the main checkout) on its own branch, in its own thread.
- Every Claude session: claude-opus-5-5, --effort high, --dangerously-skip-permissions, --disallowedTools guardrails,
  --session-id fixed up front so the runner can watch the session's jsonl for activity.
- Stall detection: no jsonl / output / commit / index activity and no CPU in the session's process tree for
  stall_minutes -> kill that session's process tree and resume it (claude --resume); after 2 stalled resumes, restart
  the attempt fresh (the prompt's resume check picks up the progress file and uncommitted work).
- Adoption: logs/<ID>.run.json records the live claude pid; a restarted runner waits on a live pid instead of
  launching a duplicate.
- Usage limits: a global gate pauses new launches for 30 minutes, then the limited session is resumed.
- Pushes: plain fast-forward pushes of phase/* and integration/* branches only; never --force, never main.
  The orchestration folder (no logs) is mirrored to the orphan branch orchestration/state."""
import json, os, re, subprocess, sys, time, datetime, pathlib, shutil, threading, zoneinfo, uuid, signal, traceback

ORCH = pathlib.Path("/workspace/shark-fitness-orchestration")
REPO = pathlib.Path("/workspace/shark-fitness-repo")
LOGS = ORCH / "logs"; PHASES = ORCH / "phases"; PR = ORCH / "pr"
STATE = ORCH / "state.json"; SCHED = ORCH / "schedule.json"
MODEL = "claude-opus-5-5"
STATE_BRANCH = "orchestration/state"
NODE_DIR = "/home/box/opt/node22"
CLAUDE = "/home/box/.local/bin/claude" if os.path.exists("/home/box/.local/bin/claude") else (shutil.which("claude") or "claude")
DENY_COMMON = ["Bash(git push*)", "Bash(git reset --hard*)", "Bash(git rebase*)", "Bash(git branch -D*)",
        "Bash(git branch -d*)", "Bash(git push --force*)", "Bash(gh pr merge*)", "Bash(gh pr create*)",
        "Bash(gh pr close*)", "Bash(gh pr comment*)", "Bash(gh pr review*)", "Bash(gh issue*)",
        "Bash(gh release*)", "Bash(gh repo*)", "Bash(git checkout main*)", "Bash(git switch main*)",
        "Bash(git worktree*)", "Bash(pkill*)", "Bash(killall*)",
        "Bash(vercel*)", "Bash(render*)", "Bash(flyctl*)", "Bash(railway*)"]
DENY_PHASE = DENY_COMMON + ["Bash(git merge*)"]       # phase sessions never merge other branches
DENY_INTEGRATE = DENY_COMMON                           # integration sessions merge phase branches into integration/*
ENV = dict(os.environ, COREPACK_HOME="/home/box/.corepack", CI="1", TZ="Asia/Kolkata",
           PATH=f"{NODE_DIR}/bin:/home/box/.local/bin:" + os.environ.get("PATH", ""))
NODE22 = rf"""test -x {NODE_DIR}/bin/node || {{ V=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys;print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))'); mkdir -p {NODE_DIR} && curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz | tar -xJ -C {NODE_DIR} --strip-components=1; }}; test -x {NODE_DIR}/bin/pnpm || corepack enable --install-directory {NODE_DIR}/bin pnpm; node -v"""
LIMIT_RE = re.compile(r"usage limit|hit your limit|limit reached|weekly limit|rate[ _-]?limit|429|overloaded|quota", re.I)
SYNC_GLOBS = ["runner.py", "start-runner.sh", "phases.json", "schedule.json", "state.json", "STATUS.md", "PHASE-PLAN.md",
              "PROMPT-GUIDE-NOTES.md", "README-ORCHESTRATION.md", "prompts/*", "phases/*.md", "phases/*.json", "pr/*"]
POLL_S = 60
SYNC_MAX_GAP_S = 20 * 60
LIMIT_WAIT_S = 30 * 60
GLOBAL_CLAUDE_CAP = int(os.environ.get("SHARK_GLOBAL_CLAUDE_CAP", "6"))  # all `claude -p` on the box (other projects too)
TERMINAL = ("done", "done_with_issues")
GIT_LOCK = threading.RLock(); STATE_LOCK = threading.RLock(); LOG_LOCK = threading.Lock()
LIMIT = {"until": 0.0}
class Stop(Exception): pass

def now(): return datetime.datetime.now(zoneinfo.ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d %H:%M IST")
def log(msg):
    line = f"[{now()}] {msg}"
    with LOG_LOCK:
        print(line, flush=True); LOGS.mkdir(exist_ok=True)
        with open(LOGS / "runner.log", "a") as f: f.write(line + "\n")
def sh(cmd, cwd=None, check=False, env=None):
    r = subprocess.run(cmd, cwd=cwd or REPO, shell=True, capture_output=True, text=True, env=env or ENV)
    if check and r.returncode: raise RuntimeError(f"{cmd}: {r.stderr[-2000:]}")
    return r

# ---------- schedule / state ----------
def sched(): return json.loads(SCHED.read_text())
def nodes(): return sched()["nodes"]
def node(nid): return next(n for n in nodes() if n["id"] == nid)
def titles(): return {p["id"]: p for p in json.loads((ORCH / "phases.json").read_text())["phases"]}
def title(n): return n.get("title") or titles()[n["id"]]["title"]
def branch(n):
    if isinstance(n, str): n = node(n)
    return n.get("branch") or f"phase/{n['id']}-{titles()[n['id']]['slug']}"
def workdir(n):
    return pathlib.Path(n["workdir"]) if n.get("workdir") else pathlib.Path(sched().get("worktree_root", "/workspace/sf-wt")) / n["id"]
def ports(n):
    i = [x["id"] for x in nodes()].index(n["id"]); lo = 18000 + i * 100
    return f"{lo}-{lo + 99}"
def load_state():
    with STATE_LOCK: return json.loads(STATE.read_text()) if STATE.exists() else {"phases": {}}
def save_state(s, sync=True):
    with STATE_LOCK: STATE.write_text(json.dumps(s, indent=2)); write_status(s)
    if sync: sync_state("state: " + ", ".join(f"{k}={v.get('state')}" for k, v in s.get("phases", {}).items()))
def update(nid, sync=True, **kw):
    with STATE_LOCK:
        s = load_state(); st = s["phases"].setdefault(nid, {}); st.update(kw); save_state(s, sync=False)
    if sync: sync_state(f"{nid}: " + ", ".join(f"{k}={v}" for k, v in kw.items())[:200])
    return st
def get(nid): return load_state()["phases"].get(nid, {})
def blocker(msg, add=True):
    with STATE_LOCK:
        s = load_state(); bl = s.setdefault("blockers", [])
        if add and msg not in bl: bl.append(msg)
        if not add: s["blockers"] = [b for b in bl if b != msg]
        save_state(s, sync=False)

def write_status(s):
    try: ns = nodes()
    except Exception: return
    rows = ["| Node | Title | State | Branch | Base | PR | Checks (runner-verified) | Notes |", "|---|---|---|---|---|---|---|---|"]
    for n in ns:
        st = s["phases"].get(n["id"], {})
        rows.append(f"| {n['id']} | {title(n)} | {st.get('state','pending')} | `{branch(n)}` | `{st.get('base','')}` | {st.get('pr','')} | {st.get('checks','')} | {st.get('note','')} |")
    run = ["| Node | Session tag | pid | Last activity | Started |", "|---|---|---|---|---|"]
    for n in ns:
        st = s["phases"].get(n["id"], {})
        if st.get("running"): r = st["running"]; run.append(f"| {n['id']} | {r.get('tag')} | {r.get('pid')} | {r.get('activity','')} | {r.get('started','')} |")
    sc = sched()
    txt = (f"# Shark Fitness build status\n\nUpdated {now()} by runner.py v3 (parallel). Model: `{MODEL}` (Claude Code CLI, effort high).\n"
           f"Concurrency cap: {sc.get('cap')} Shark sessions (and at most {GLOBAL_CLAUDE_CAP} `claude -p` processes on the box in total); stall timeout {sc.get('stall_minutes')} min.\n\n"
           f"Runner: `{ORCH}/runner.py`, log `{LOGS}/runner.log`, per-session logs `{LOGS}/<tag>-<n>.json`. Worktrees: `{sc.get('worktree_root')}/<ID>` (P01: `{REPO}`).\n"
           f"Backups on origin: `phase/*` and `integration/*` branches (pushed after every commit), orchestration state on `{STATE_BRANCH}`.\n"
           f"Last pushes: {json.dumps(s.get('pushes', {}))}\n\n## Nodes\n" + "\n".join(rows) +
           "\n\n## Running sessions\n" + ("\n".join(run) if len(run) > 2 else "- none") +
           "\n\n## Blockers / waiting\n" + ("\n".join(f"- {b}" for b in s.get("blockers", [])) or "- none") + "\n")
    (ORCH / "STATUS.md").write_text(txt)

def section(pid):
    text = (ORCH / "PHASE-PLAN.md").read_text()
    b = re.search(r"^## Environment bootstrap.*?(?=^## |\Z)", text, re.S | re.M)
    boot = b.group(0).strip() if b else ""
    if not re.match(r"P\d\d$", pid): return boot
    m = re.search(rf"^## Phase {pid}:.*?(?=^## |\Z)", text, re.S | re.M)
    return (boot + "\n\n" if boot else "") + (m.group(0).strip() if m else f"(section for {pid} not found; read PHASE-PLAN.md)")

def parallel_note(n, wd):
    lines = []
    if n.get("note"): lines.append("- " + n["note"])
    lines.append(f"- Parallel build: other Claude Code sessions work on this machine at the same time in other git worktrees. Yours is {wd}. "
                 f"For any server you start (API smoke, Vite, Playwright webServer) use ports {ports(n)}; if a script or config hard-codes a port, "
                 "make it overridable by an environment variable that keeps the current default. Use your own mktemp SHARK_DB and temp dirs. "
                 "Only stop processes you started yourself; never pkill or killall by name.")
    if n["kind"] == "phase" and n["id"] not in ("P01",):
        lines.append("- Where your phase spec depends on a phase that is not on your branch, build against the interface PHASE-PLAN.md describes for it, keep that seam small, "
                     "and list it under a heading \"## Integration notes\" in your notes file (what you assumed, which files, what the integration session must wire up). "
                     "Do not build the other phase's features yourself. Keep churn in shared files (root package.json, pnpm-lock.yaml, shared contracts, routers and layouts, CI workflow) "
                     "to additions, and put schema changes in as few migration files as possible so a later merge can renumber them.")
        lines.append("- If the @shark/e2e Playwright harness from P01 is not on your branch, cover your flows with integration and component tests plus a manual Playwright check with screenshots, "
                     "and list the e2e specs P08 should add in your notes. If it is on your branch, add e2e specs for your flows.")
    return "\n".join(lines)

def render(tpl, n, base, wd):
    t = (ORCH / "prompts" / tpl).read_text()
    base_sha = sh(f"git rev-parse --short {base}").stdout.strip() or sh(f"git rev-parse --short origin/{base}").stdout.strip()
    merge_list = "\n".join(f"  {i+1}. {branch(m)} (phase {m}: {titles()[m]['title']})" for i, m in enumerate(n.get("merge", [])))
    for k, v in {"ID": n["id"], "TITLE": title(n), "BRANCH": branch(n), "BASE": base, "BASE_SHA": base_sha, "WORKDIR": str(wd),
                 "PORTS": ports(n), "PARALLEL": parallel_note(n, wd), "MERGE_LIST": merge_list, "SECTION": section(n["id"])}.items():
        t = t.replace("{{" + k + "}}", v)
    return t

# ---------- backups to origin (plain pushes only, never --force) ----------
def pushable(b): return bool(b) and b not in ("main", "master") and (b.startswith("phase/") or b.startswith("integration/"))
def push_branch(b):
    if not pushable(b): return False
    msg = ""; r = None
    with GIT_LOCK:
        if sh(f"git rev-parse --verify --quiet refs/heads/{b}").returncode: return False
        sh(f"git fetch origin --quiet {b}")
        if sh(f"git rev-parse --verify --quiet refs/remotes/origin/{b}").returncode == 0:
            if sh(f"git rev-list --count origin/{b}..{b}").stdout.strip() == "0": return False
            if sh(f"git merge-base --is-ancestor origin/{b} {b}").returncode:
                msg = f"push of {b} skipped: origin/{b} has diverged from local (no force-push; needs a human)"
        if not msg: r = sh(f"git push --quiet -u origin refs/heads/{b}:refs/heads/{b}")
    if msg: log(msg); blocker(msg); return False
    if r.returncode: log(f"push of {b} failed: {r.stderr.strip()[-300:]}"); return False
    head = sh(f"git rev-parse --short {b}").stdout.strip()
    log(f"pushed {b} @ {head}")
    with STATE_LOCK:
        s = load_state(); s.setdefault("pushes", {})[b] = f"{head} at {now()}"; save_state(s, sync=False)
    return True

def sync_state(msg="sync"):
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

# ---------- process helpers ----------
def proc_table():
    t = {}
    for d in os.listdir("/proc"):
        if not d.isdigit(): continue
        try:
            raw = open(f"/proc/{d}/stat").read(); rest = raw[raw.rindex(")") + 2:].split()
            t[int(d)] = (int(rest[1]), int(rest[11]) + int(rest[12]), rest[0])   # ppid, utime+stime, state
        except Exception: pass
    return t
def descendants(pid, t=None):
    t = t or proc_table(); kids = {}
    for p, (pp, _, _) in t.items(): kids.setdefault(pp, []).append(p)
    out, stack = [], [pid]
    while stack:
        for c in kids.get(stack.pop(), []): out.append(c); stack.append(c)
    return out
def is_claude(pid):
    try:
        if open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0] == "Z": return False
        return "claude" in open(f"/proc/{pid}/cmdline", "rb").read().decode(errors="ignore")
    except Exception: return False
def kill_tree(pid, proc=None):
    pids = descendants(pid) + [pid]
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for p in pids:
            try: os.kill(p, sig)
            except Exception: pass
        for _ in range(30):
            if not any(os.path.exists(f"/proc/{p}") and is_alive_any(p) for p in pids): break
            time.sleep(1)
    if proc:
        try: proc.wait(timeout=10)
        except Exception: pass
def is_alive_any(pid):
    try: return open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0] != "Z"
    except Exception: return False
def count_claude_p():
    n = 0
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                c = open(f"/proc/{d}/cmdline", "rb").read().split(b"\0")
                if c and b"claude" in c[0].rsplit(b"/", 1)[-1] + c[0] and b"-p" in c and is_alive_any(int(d)): n += 1
            except Exception: pass
    return n
def mem_avail_gb():
    for l in open("/proc/meminfo"):
        if l.startswith("MemAvailable:"): return int(l.split()[1]) / 1048576
    return 99.0
def mtime(p):
    try: return os.path.getmtime(p)
    except Exception: return 0.0
def jsonl_dir(wd): return pathlib.Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(wd))
def newest_jsonl(wd):
    d = jsonl_dir(wd)
    try: return max((f.stat().st_mtime for f in d.glob("*.jsonl")), default=0.0)
    except Exception: return 0.0

def gate():
    """Block while STOP exists (raise) or a usage-limit pause is active."""
    while True:
        if (ORCH / "STOP").exists(): raise Stop()
        w = LIMIT["until"] - time.time()
        if w <= 0: return
        time.sleep(min(w, 60))

# ---------- Claude sessions ----------
def run_claude(n, prompt, tag, resume=None, max_turns=400):
    """Run (or adopt) one claude -p session for node n, with stall detection and usage-limit handling. Returns the result JSON."""
    nid = n["id"]; wd = workdir(n); b = branch(n)
    deny = DENY_INTEGRATE if n["kind"] == "integrate" else DENY_PHASE
    original = prompt; stall_resumes = 0; errors = 0
    stall_s = int(sched().get("stall_minutes", 30)) * 60
    runfile = LOGS / f"{nid}.run.json"
    while True:
        rec = None
        try:
            rec = json.loads(runfile.read_text()) if runfile.exists() else None
            if rec and not (rec.get("tag") == tag and is_claude(int(rec["pid"]))): rec = None
        except Exception: rec = None
        proc = None
        if rec:
            pid = int(rec["pid"]); out = pathlib.Path(rec["out"]); err = pathlib.Path(rec["err"]); sid = rec.get("session_id")
            log(f"{nid}: adopting live claude session {tag} pid {pid} (session {sid})")
        else:
            gate()
            while count_claude_p() >= GLOBAL_CLAUDE_CAP:
                gate(); time.sleep(60)
            k = 1
            while (LOGS / f"{tag}-{k}.json").exists() and (LOGS / f"{tag}-{k}.json").stat().st_size > 0: k += 1
            out = LOGS / f"{tag}-{k}.json"; err = LOGS / f"{tag}-{k}.err"
            sid = resume or str(uuid.uuid4())
            cmd = [CLAUDE, "-p", prompt, "--model", MODEL, "--effort", "high", "--dangerously-skip-permissions",
                   "--add-dir", str(ORCH), "--max-turns", str(max_turns), "--output-format", "json", "--disallowedTools", *deny]
            cmd += ["--resume", resume] if resume else ["--session-id", sid]
            log(f"{nid}: claude run {tag} #{k} (resume={resume}) in {wd}")
            with open(out, "w") as o, open(err, "w") as e:
                proc = subprocess.Popen(cmd, cwd=wd, stdout=o, stderr=e, stdin=subprocess.DEVNULL, env=ENV, start_new_session=True)
            pid = proc.pid
            runfile.write_text(json.dumps({"pid": pid, "tag": tag, "out": str(out), "err": str(err), "session_id": sid,
                                           "workdir": str(wd), "started": now()}))
        update(nid, sync=False, running={"tag": tag, "pid": pid, "started": now(), "activity": now()})
        outcome = watch(n, pid, proc, out, err, wd, b, stall_s)
        try: runfile.unlink()
        except Exception: pass
        update(nid, sync=False, running=None)
        push_branch(b); sync_state(f"after {tag} ({nid})")
        if outcome == "stalled":
            stall_resumes += 1
            if sid and stall_resumes <= 2 and jsonl_dir(wd).joinpath(f"{sid}.jsonl").exists():
                log(f"{nid}: session {tag} stalled > {stall_s//60} min; killed and resuming session {sid} ({stall_resumes}/2)")
                resume = sid; prompt = ("Your previous turn stalled and was stopped by the orchestrator. Continue the task from where you stopped: "
                                        "check git status, your notes and progress file first, commit any finished work, and avoid long-running "
                                        "commands that don't exit on their own (start servers in the background and stop them when done).")
            else:
                log(f"{nid}: session {tag} stalled again; restarting the attempt fresh (the prompt resumes from the progress file)")
                resume = None; prompt = original; stall_resumes = 0
            continue
        raw = (out.read_text() if out.exists() else "") + (err.read_text() if err.exists() else "")
        try: res = json.loads(out.read_text().strip().splitlines()[-1])
        except Exception: res = {}
        limited = (res.get("is_error") and LIMIT_RE.search(str(res.get("result", "")) + str(res.get("api_error_status", "")))) \
                  or (not res and LIMIT_RE.search(raw))
        if limited:
            LIMIT["until"] = max(LIMIT["until"], time.time() + LIMIT_WAIT_S)
            msg = f"Claude usage limit hit (latest during {tag}); new sessions paused, retrying every 30 min"
            blocker(msg); log(f"{nid}: {msg}: {str(res.get('result',''))[:200] or raw[-200:]}")
            resume = res.get("session_id") or sid
            prompt = "You were interrupted by a usage limit. Continue the task from where you stopped; check your progress file and git status first."
            time.sleep(60); gate(); blocker(msg, add=False)
            continue
        if not res:
            errors += 1
            if errors <= 4:
                log(f"{nid}: claude run {tag} produced no JSON ({raw.strip()[-200:]!r}); retry in 2 min")
                time.sleep(120)
                if sid and jsonl_dir(wd).joinpath(f"{sid}.jsonl").exists():
                    resume = sid; prompt = "Your previous run ended unexpectedly. Continue the task from where you stopped; check your progress file and git status first."
                continue
        log(f"{nid}: claude run {tag} finished subtype={res.get('subtype')} turns={res.get('num_turns')} cost={res.get('total_cost_usd')}")
        return res

def watch(n, pid, proc, out, err, wd, b, stall_s):
    """Wait for the session; push new commits each minute; return 'exited' or 'stalled'."""
    nid = n["id"]; last_act = time.time(); last_sync = time.time(); cpu_prev = {}
    idx = sh("git rev-parse --git-path index", cwd=wd).stdout.strip()
    idx = idx if os.path.isabs(idx) else str(pathlib.Path(wd) / idx)
    while True:
        alive = (proc.poll() is None) if proc else is_claude(pid)
        if not alive: return "exited"
        time.sleep(POLL_S)
        try:
            if push_branch(b) or time.time() - last_sync >= SYNC_MAX_GAP_S: sync_state(f"progress sync during {nid}"); last_sync = time.time()
        except Exception as e: print(f"[{now()}] {nid} push error: {e}", flush=True)
        ct = sh(f"git log -1 --format=%ct {b}").stdout.strip()
        act = max(mtime(out), mtime(err), newest_jsonl(wd), mtime(idx), float(ct or 0))
        t = proc_table(); busy = False; cur = {}
        for p in descendants(pid, t):
            cur[p] = t[p][1]
            if cur[p] - cpu_prev.get(p, 0 if p not in cpu_prev and cpu_prev else cur[p]) >= 100: busy = True   # >= 1 s CPU in the interval
        cpu_prev = cur
        if busy: act = time.time()
        if act > last_act:
            last_act = act
            update(nid, sync=False, running={**(get(nid).get("running") or {}), "activity": datetime.datetime.fromtimestamp(act, zoneinfo.ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d %H:%M IST")})
        if time.time() - last_act > stall_s:
            log(f"{nid}: no activity for {int((time.time()-last_act)//60)} min (jsonl, output, commits, index, CPU); killing pid {pid} tree")
            kill_tree(pid, proc); return "stalled"

# ---------- per-node flow ----------
def progress_done(nid):
    try: return json.loads((PHASES / f"{nid}-progress.json").read_text()).get("status") == "done"
    except Exception: return False
def dirty(wd): return bool(sh("git status --porcelain", cwd=wd).stdout.strip())

def checks(wd, n):
    sh(NODE22)
    lo = int(ports(n).split("-")[0])
    r = sh(f"export SHARK_DB=$(mktemp -d)/shark.db PORT={lo+90} E2E_PORT={lo+91}; pnpm install --frozen-lockfile >/dev/null 2>&1; C='typecheck lint test build'; grep -q '\"e2e\"' package.json && C=\"$C e2e\"; for c in $C; do pnpm $c >/tmp/sf-{n['id']}-$c.log 2>&1 && echo \"$c:pass\" || echo \"$c:FAIL\"; done", cwd=pathlib.Path(wd) / "shark-fitness")
    return " ".join(r.stdout.split())

def resolve_base(n):
    st = get(n["id"])
    if st.get("base"): return st["base"]
    return n.get("base") or branch(n["base_from"])

def ensure_worktree(n, base):
    b = branch(n); wd = workdir(n)
    with GIT_LOCK:
        sh("git fetch origin --quiet")
        local = sh(f"git rev-parse --verify --quiet refs/heads/{b}").returncode == 0
        remote = sh(f"git rev-parse --verify --quiet refs/remotes/origin/{b}").returncode == 0
        if wd == REPO:
            if sh("git branch --show-current").stdout.strip() != b:
                if local: sh(f"git checkout {b}", check=True)
                elif remote: sh(f"git checkout -b {b} --track origin/{b}", check=True)
                else: sh(f"git checkout -b {b} {base if sh(f'git rev-parse --verify --quiet {base}').returncode == 0 else 'origin/' + base}", check=True)
            return wd
        if (wd / ".git").exists():
            cur = sh("git branch --show-current", cwd=wd).stdout.strip()
            if cur != b: raise RuntimeError(f"worktree {wd} is on {cur!r}, expected {b}")
            if remote and sh(f"git merge-base --is-ancestor {b} origin/{b}").returncode == 0: sh(f"git merge --ff-only origin/{b}", cwd=wd)
            return wd
        sh("git worktree prune"); wd.parent.mkdir(parents=True, exist_ok=True)
        if local: sh(f"git worktree add '{wd}' {b}", check=True)
        elif remote: sh(f"git worktree add --track -b {b} '{wd}' origin/{b}", check=True); log(f"{n['id']}: restored {b} from origin")
        else:
            start = base if sh(f"git rev-parse --verify --quiet refs/heads/{base}").returncode == 0 else f"origin/{base}"
            sh(f"git worktree add -b {b} '{wd}' {start}", check=True)
            log(f"{n['id']}: created worktree {wd} on {b} from {start} @ {sh(f'git rev-parse --short {b}').stdout.strip()}")
    return wd

def open_pr(n, base, wd):
    b = branch(n)
    push_branch(b)
    if sh(f"git rev-parse --verify --quiet refs/remotes/origin/{b}").returncode: raise RuntimeError(f"{b} is not on origin")
    existing = sh(f"gh pr list --head {b} --state all --json url -q '.[0].url'").stdout.strip()
    if existing: return existing
    f = PR / f"{n['id']}.md"
    body = f.read_text() if f.exists() else f"{n['id']}: {title(n)}\n\nSee PHASE-PLAN.md."
    lines = body.splitlines(); hdr = bool(lines) and lines[0].startswith("#")
    ttl = lines[0].lstrip("# ").strip() if hdr else f"{n['id']}: {title(n)}"
    rest = "\n".join(lines[1:]) if hdr else body
    kind = "integration merge (done by Claude Code)" if n["kind"] == "integrate" else f"Phase {n['id']} of the Shark Fitness build plan"
    rest += f"\n\n---\nStacked PR: base `{base}`. {kind}. Code written by Claude Code (`{MODEL}`){'' if n['kind']=='integrate' else ', reviewed by a separate fresh Claude Code session'}. Built in parallel with other phases; integration branches combine them. Not merged automatically; please review."
    bf = PR / f"{n['id']}.body.md"; bf.write_text(rest)
    r = sh(f"gh pr create --base '{base}' --head '{b}' --title {json.dumps(ttl[:200])} --body-file '{bf}'")
    if r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip().splitlines()[-1]

def run_node(n):
    nid = n["id"]; b = branch(n)
    base = resolve_base(n)
    log(f"=== {nid} {title(n)} (branch {b}, base {base}) ===")
    sh(NODE22)
    wd = ensure_worktree(n, base)
    st = get(nid)
    if not st.get("base"): update(nid, base=base, base_sha=sh(f"git merge-base {b} {base}").stdout.strip()[:9])
    st = get(nid)
    work_state = "integrating" if n["kind"] == "integrate" else "implementing"
    if st.get("state") in (None, "pending", "implementing", "integrating"):
        update(nid, state=work_state)
        tpl = "integrate-template.md" if n["kind"] == "integrate" else "impl-template.md"
        res = run_claude(n, render(tpl, n, base, wd), f"{nid}-impl")
        sid = res.get("session_id")
        for i in range(3):
            if progress_done(nid) and not dirty(wd): break
            if sh("git branch --show-current", cwd=wd).stdout.strip() != b: sh(f"git checkout {b}", cwd=wd)
            res = run_claude(n, f"Your checklist in /workspace/shark-fitness-orchestration/phases/{nid}-progress.json is not marked done, or the working tree has uncommitted changes. "
                                f"Continue with the open items, run the full verification, commit everything on {b}, write pr/{nid}.md, and set status done. "
                                "If an item is truly blocked, mark it blocked with the reason and finish.", f"{nid}-impl-cont{i+1}", resume=sid)
            sid = res.get("session_id", sid)
        update(nid, state="reviewing" if n["kind"] == "phase" else "verifying",
               note="" if progress_done(nid) else "work not marked done after 3 continuations")
    st = get(nid)
    if st.get("state") == "reviewing":
        run_claude(n, render("review-template.md", n, base, wd), f"{nid}-review", max_turns=250)
        update(nid, state="verifying")
    st = get(nid)
    if st.get("state") == "verifying":
        if dirty(wd):
            run_claude(n, f"Commit all remaining finished changes on {b} with a fix:/test:/chore: message and make sure the working tree is clean.", f"{nid}-commit", max_turns=30)
        update(nid, state="pr", checks=checks(wd, n))
    st = get(nid)
    if st.get("state") == "pr":
        try: update(nid, pr=open_pr(n, base, wd), state="done")
        except Exception as e:
            errs = st.get("pr_errors", 0) + 1
            note = f"PR/push failed: {str(e)[:200]}"; log(f"{nid}: {note}")
            update(nid, note=note, pr_errors=errs, state="done_with_issues" if errs >= 3 else "pr")
    log(f"{nid}: finished with state {get(nid).get('state')}")

def node_thread(n):
    try: run_node(n)
    except Stop: log(f"{n['id']}: STOP file present; not launching more sessions")
    except Exception as e:
        st = get(n["id"]); errs = st.get("errors", 0) + 1
        log(f"{n['id']}: runner error #{errs}: {e}\n{traceback.format_exc()[-1500:]}")
        update(n["id"], errors=errs, note=f"runner error: {str(e)[:150]}", running=None)
        if errs >= 5:
            update(n["id"], state="done_with_issues"); blocker(f"{n['id']} failed 5 times in the runner: {str(e)[:150]}")
        else: time.sleep(300)

def discover():
    pp, pj = ORCH / "PHASE-PLAN.md", ORCH / "phases.json"
    if pp.exists() and pp.stat().st_size > 10_000 and pj.exists() and pj.stat().st_size > 0: return
    log("PHASE-PLAN.md/phases.json missing; restore them from origin/orchestration/state (start-runner.sh does this)"); sys.exit(1)

def main(dry=False):
    discover()
    s = load_state()
    for n in nodes(): s["phases"].setdefault(n["id"], {}).setdefault("state", "pending")
    s.pop("finished", None); save_state(s)
    threads = {}; noted = set()
    log(f"runner v3 (parallel) started: cap {sched().get('cap')}, global claude cap {GLOBAL_CLAUDE_CAP}, stall {sched().get('stall_minutes')} min")
    while True:
        sc = sched(); cap = int(sc.get("cap", 4)); minmem = float(sc.get("min_mem_avail_gb", 2.0))
        st = load_state()["phases"]
        done = {k for k, v in st.items() if v.get("state") in TERMINAL}
        if all(n["id"] in done for n in sc["nodes"]): break
        running = [k for k, t in threads.items() if t.is_alive()]
        stop = (ORCH / "STOP").exists()
        if stop and not running: log("STOP file present and no sessions running; exiting"); return
        for n in sc["nodes"]:
            nid = n["id"]
            if nid in done or nid in running or stop: continue
            if not all(d in done for d in n.get("after", [])): continue
            adopt = (LOGS / f"{nid}.run.json").exists()
            if len(running) >= cap and not adopt: break
            if not adopt and time.time() < LIMIT["until"]: break
            if not adopt and mem_avail_gb() < minmem:
                if "mem" not in noted: log(f"waiting for memory before starting {nid} ({mem_avail_gb():.1f} GB available)"); noted.add("mem")
                break
            if not adopt and count_claude_p() >= GLOBAL_CLAUDE_CAP:
                if "glob" not in noted: log(f"waiting: {count_claude_p()} claude sessions already running on the box (global cap {GLOBAL_CLAUDE_CAP})"); noted.add("glob")
                break
            noted.discard("mem"); noted.discard("glob")
            if dry: log(f"[dry-run] would start {nid} (base {resolve_base(n)})"); running.append(nid); continue
            t = threading.Thread(target=node_thread, args=(n,), name=nid, daemon=True); t.start()
            threads[nid] = t; running.append(nid); time.sleep(5)
        if dry: return
        with STATE_LOCK: write_status(load_state())
        time.sleep(30)
    log("all nodes finished"); s = load_state(); s["finished"] = now(); save_state(s)

if __name__ == "__main__":
    LOGS.mkdir(exist_ok=True); PHASES.mkdir(exist_ok=True); PR.mkdir(exist_ok=True)
    if "--sync-state" in sys.argv:
        i = sys.argv.index("--sync-state"); sync_state(sys.argv[i + 1] if len(sys.argv) > i + 1 else "manual sync"); sys.exit(0)
    if "--push-phase" in sys.argv:
        for n in nodes():
            if n["id"] in load_state()["phases"]: push_branch(branch(n))
        sys.exit(0)
    main(dry="--dry-run" in sys.argv)
