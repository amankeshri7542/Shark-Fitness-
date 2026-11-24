#!/usr/bin/env python3
"""Sequential phase runner for Shark Fitness. Orchestration only: all product code is written by Claude Code.
Usage: runner.py [--only P01] ; create STOP file in this dir to stop after current step."""
import json, os, re, subprocess, sys, time, datetime, pathlib

ORCH = pathlib.Path("/workspace/shark-fitness-orchestration")
REPO = pathlib.Path("/workspace/shark-fitness-repo")
LOGS = ORCH / "logs"; PHASES = ORCH / "phases"; PR = ORCH / "pr"
STATE = ORCH / "state.json"
MODEL = "claude-opus-5-5"
FIRST_BASE = "claude/musing-wilbur-d67503"   # PR #27 branch; phase 1 finishes it
CLAUDE = "/home/box/.local/bin/claude"
DENY = ["Bash(git push*)", "Bash(git reset --hard*)", "Bash(git rebase*)", "Bash(git branch -D*)",
        "Bash(git branch -d*)", "Bash(git push --force*)", "Bash(gh pr merge*)", "Bash(gh pr create*)",
        "Bash(gh pr close*)", "Bash(gh pr comment*)", "Bash(gh pr review*)", "Bash(gh issue*)",
        "Bash(gh release*)", "Bash(gh repo*)", "Bash(git checkout main*)", "Bash(git switch main*)",
        "Bash(vercel*)", "Bash(render*)", "Bash(flyctl*)", "Bash(railway*)"]
ENV = dict(os.environ, COREPACK_HOME="/home/box/.corepack", CI="1", PATH="/tmp/node22/bin:" + os.environ.get("PATH", ""))
NODE22 = r"""test -x /tmp/node22/bin/node || { V=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys;print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))'); mkdir -p /tmp/node22 && curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz | tar -xJ -C /tmp/node22 --strip-components=1; }; corepack enable --install-directory /tmp/node22/bin pnpm; node -v"""
LIMIT_RE = re.compile(r"usage limit|hit your limit|limit reached|rate[ _-]?limit|429|overloaded|quota", re.I)

def now(): return datetime.datetime.now().strftime("%Y-%m-%d %H:%M IST")
def log(msg):
    line = f"[{now()}] {msg}"; print(line, flush=True)
    with open(LOGS / "runner.log", "a") as f: f.write(line + "\n")
def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {"phases": {}}
def save_state(s):
    STATE.write_text(json.dumps(s, indent=2)); write_status(s)
def sh(cmd, cwd=REPO, check=False):
    r = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, env=ENV)
    if check and r.returncode: raise RuntimeError(f"{cmd}: {r.stderr[-2000:]}")
    return r

def write_status(s):
    rows = ["| Phase | Title | State | Branch | PR | Checks (runner-verified) | Notes |", "|---|---|---|---|---|---|---|"]
    for p in plan():
        st = s["phases"].get(p["id"], {})
        rows.append(f"| {p['id']} | {p['title']} | {st.get('state','pending')} | `{branch(p)}` | {st.get('pr','')} | {st.get('checks','')} | {st.get('note','')} |")
    blockers = s.get("blockers", [])
    txt = f"# Shark Fitness build status\n\nUpdated {now()} by runner.py. Model: `{MODEL}` (Claude Code CLI, effort high).\n\n" \
          f"Runner: `{ORCH}/runner.py`, log `{LOGS}/runner.log`, per-phase logs `{LOGS}/<phase>-*.json`.\n\n" + "\n".join(rows) + \
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

def run_claude(prompt, tag, resume=None, max_turns=400):
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
        with open(out, "w") as o, open(err, "w") as e:
            rc = subprocess.run(cmd, cwd=REPO, stdout=o, stderr=e, env=ENV).returncode
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
    r = sh("pnpm install --frozen-lockfile >/dev/null 2>&1; C='typecheck lint test build'; grep -q '\"e2e\"' package.json && C=\"$C e2e\"; for c in $C; do pnpm $c >/tmp/sf-$c.log 2>&1 && echo \"$c:pass\" || echo \"$c:FAIL\"; done", cwd=REPO / "shark-fitness")
    return " ".join(r.stdout.split())

def ensure_branch(p, base):
    b = branch(p)
    sh("git fetch origin --quiet")
    if sh(f"git rev-parse --verify --quiet {b}").returncode == 0: sh(f"git checkout {b}", check=True)
    else:
        start = base if sh(f"git rev-parse --verify --quiet {base}").returncode == 0 else f"origin/{base}"
        sh(f"git checkout -b {b} {start}", check=True)

def open_pr(p, base):
    b = branch(p); s = load_state()
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
    pid = p["id"]
    log("node: " + sh(NODE22).stdout.strip())
    ensure_branch(p, base)
    if st.get("state") in (None, "pending", "implementing"):
        st["state"] = "implementing"; save_state(s)
        res = run_claude(render("impl-template.md", p, base), f"{pid}-impl")
        sid = res.get("session_id")
        for i in range(3):
            if progress_done(pid) and not sh("git status --porcelain").stdout.strip(): break
            if (sh("git branch --show-current").stdout.strip() != branch(p)): sh(f"git checkout {branch(p)}")
            res = run_claude(f"Your checklist in /workspace/shark-fitness-orchestration/phases/{pid}-progress.json is not marked done, or the working tree has uncommitted changes. Continue with the open items, run the full verification, commit everything on {branch(p)}, write pr/{pid}.md, and set status done. If an item is truly blocked, mark it blocked with the reason and finish.",
                             f"{pid}-impl-cont{i+1}", resume=sid)
            sid = res.get("session_id", sid)
        s = load_state(); st = s["phases"][pid]
        st["state"] = "reviewing"; st["note"] = "" if progress_done(pid) else "impl not marked done after 3 continuations"; save_state(s)
    if st.get("state") == "reviewing":
        sh(f"git checkout {branch(p)}")
        run_claude(render("review-template.md", p, base), f"{pid}-review", max_turns=250)
        if sh("git status --porcelain").stdout.strip():
            run_claude(f"Commit all remaining changes from your review on {branch(p)} with a fix:/test: message and make sure the working tree is clean.", f"{pid}-review-commit", max_turns=30)
        s = load_state(); st = s["phases"][pid]
        st["checks"] = checks(); st["state"] = "pr"; save_state(s)
    if st.get("state") == "pr":
        try: st["pr"] = open_pr(p, base); st["state"] = "done"
        except Exception as e: st["state"] = "pr"; st["note"] = f"PR/push failed: {str(e)[:200]}"; log(st["note"])
        save_state(s)
    return st.get("state") == "done"

def main():
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
    main()
