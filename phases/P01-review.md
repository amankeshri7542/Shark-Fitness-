# P01 independent review

Reviewer: independent senior review, 2026-11-25. Branch `phase/P01-prod-readiness`, reviewed from `128aec1` (the implementer's last commit) against `origin/claude/musing-wilbur-d67503`. 74 files, 11 implementer commits.

## Verdict

**Ready for PR.** All 10 acceptance criteria hold when re-run. I found one major and three minor issues, fixed all four in separate commits, and list the remaining minor notes below. As the spec requires, the Docker/systemd part of `pilot-stack.yml` has not run here: there is no Docker on this box.

## How it was checked

I re-ran everything myself rather than reading the checklist:

- **Gates:** typecheck, lint, test, build, plus `pnpm e2e` twice.
- **Migrations:** drizzle-kit generate and `db:check-drift`, plus a negative control.
- **Scripts:** shellcheck and `bash -n`.
- **Backup scripts:** a local harness with real `age` 1.2.1 and `rclone` 1.68.2.
- **Live server:** a production single-origin smoke of `/metrics` and `/v1/client-errors`.
- **Code:** the full diff (API, contracts, both SPAs, e2e, CI, deploy scripts, docs) and the four screenshots.

### Acceptance criteria

| # | Criterion | Result | Evidence (re-run by reviewer) |
| --- | --- | --- | --- |
| 1 | PR #27 on branch, shellcheck/bash -n clean | pass | `git merge-base --is-ancestor 654e2ac HEAD` true. shellcheck 0.10.0 `-S warning deploy/pilot/*.sh` silent (exit 0). `bash -n` passes on all 8 scripts. At `-S info` there are only SC2015/SC2012 notes on deliberate `a && b \|\| fail` guards. |
| 2 | Off-site backups, drill from off-site, forced failure, CI steps | pass (local harness); CI steps written, not run | **Harness:** stub `docker`, real age/rclone, rclone `local` remote, a ping recorder on :18050.<br>**Unset:** `offsite=skipped`; pings `/start` then success.<br>**Set:** remote holds `*.db.age` + `*.manifest.json.age`, with no plaintext SQLite header.<br>**`--from-offsite` (relative path):** `offsite_download=verified`. The rest of the drill needs real Docker.<br>**Wrong key:** exit 1. **Tampered object:** "does not match its manifest", exit 1. In both cases nothing is left in `drill/`.<br>**Unreachable WebDAV remote:** `offsite=failed`, nightly exit 1, `/fail` pinged, a 2020-dated local copy *not* pruned. Pre-deploy exits 0.<br>**Off-site prune:** runs only after a good upload, and removes only old objects.<br>**Refused before backing up:** half configuration, malformed recipient.<br>**`pilot-stack.yml`:** three new steps; config.ts/server.ts added to the triggers. |
| 3 | Config declares/validates every var; guard tests | pass | **Guard tests:** a `process.env` guard and an `.env.example` key guard.<br>**Refusal tests:** OTP provider without credentials; non-numeric limits; unknown reporter; malformed or non-HTTPS DSN in production; metrics token under 32 characters in production.<br>**Manual check:** grep finds no `process.env` outside `lib/config.ts`. `deploy/pilot/shark.env.example` and `compose.yaml` pass nothing the stricter schema refuses. |
| 4 | Sentry provider via local server; no PII; console/none | pass | `error-reporting.test.ts` checks the envelope URL `/api/7/envelope/`, `X-Sentry-Auth`, frames ≥ 1, release, environment and `request_id`. The `SENSITIVE_VALUES` fixtures are absent from the payload. |
| 5 | Scheduler failure → one capture + failed `job_runs`; child-process rejection | pass | `scheduler-observability` test, plus 3 child-process tests in `process-handlers.test.ts`. Uncaught exceptions exit 1 in production and keep running in development. |
| 6 | `/v1/client-errors` 204/413/422/403/429; SPA boundary tests | pass | Integration tests pass. **Live server:** 204 valid; 403 missing or foreign Origin; 422 invalid or non-JSON; 413 oversize with and without Content-Length (chunked); 429 after exactly 30 counted requests a minute. The logged message is redacted and the route collapsed to `/members/:id`. Both apps' `ErrorBoundary.test.tsx` cover the recovery screen and once-per-fingerprint. |
| 7 | `/metrics` 404/401/200; no ids in labels | pass | Integration tests pass. **Live server:** 401 without a token and with a wrong one, 16 families with the token. HTTP `route` labels were templates (`/*`, `/admin/*`, `/assets/*`, `/v1/admin/*`, `/ready`) even for `/admin/members/mbr_abc123`, `/usr_9/x` and `/v1/members/ten_shark/x`. |
| 8 | drizzle.config lists 8 files; generate no changes; SQL untouched; CI step | pass | `drizzle-kit generate` against a temp DB: "No schema changes, nothing to migrate". `db:check-drift`: `migration_drift=none`.<br>**Negative control:** a throwaway column made it exit 1, and it removed the files it wrote. The migrations diff vs base is only `meta/0014–0017_snapshot.json`; the journal and all SQL are unchanged. |
| 9 | `pnpm e2e` 3 green twice, no leftovers, never touches `data/shark.db` | pass | See final verification. After the runs: 0 `/tmp/shark-e2e-*` dirs, no `e2e/.state`, no listener, and no `apps/api/data/shark.db` (`data/test/` belongs to vitest). |
| 10 | Docs; standard gates | pass | See final verification. One README inaccuracy fixed (below). |

## Findings

### Fixed

1. **Major: public browser reports could suppress server error reporting** (`apps/api/src/lib/error-reporting.ts`). **Fixed in `af04509`.**
   - **The problem:** the outbound reporter capped *all* reports at 60 a minute in one shared budget. `POST /v1/client-errors` needs no auth and admits 30 a minute per IP and 300 a minute for the shared anonymous budget. A few IPs could therefore use up the budget every minute, and real 5xx errors, scheduler failures and crashes would be silently dropped before reaching Sentry or ntfy. Monitoring goes blind exactly when someone is probing the system.
   - **The fix:** browser reports (`source` = `admin`/`member`) get their own 60-a-minute budget, and server reports keep theirs.
   - **Test:** a new test sends 75 browser reports, then 5 server errors, and asserts all 5 server errors are sent. It failed before the fix (0 of 5).
   - **Docs:** OPERATIONS-ALERTS and PRODUCTION-READINESS updated.

2. **Minor: Sentry events tagged `branch_scope`.** **Fixed in `2c15353`.**
   - **The problem:** the spec limits a Sentry event to release, environment, request id, route and tenant/actor ids. The new envelope also carried the request's branch ids, which contradicted the PR description's "nothing else".
   - **The fix:** the tag is removed.
   - **Test:** the exact-tag-set test now passes a branch scope to prove it stays out.
   - **Unchanged on purpose:** the pre-existing `http` reporter, which already sent `branchScope`.

3. **Minor: the e2e server port could not be pinned** (`e2e/global-setup.ts`). **Fixed in `dccb696`.**
   - **The problem:** global setup always took a random ephemeral port. Machines that reserve a port range per build cannot keep the server inside it.
   - **The fix:** `SHARK_E2E_PORT` pins the port. Unset keeps the free-port default, and an invalid value fails setup with a clear message. Documented in `e2e/README.md`.

4. **Minor (docs): README overstated a refusal.** It said a short metrics token stops the process; that happens only in production. **Fixed in `6227a74`.**

### Not fixed (minor notes, for the PR or a later phase)

- **A bad off-site configuration skips that night's local backup.** `backup.sh` refuses half an off-site configuration, or a malformed remote or recipient, *before* taking the local copy.
  - **Effect:** a typo in `shark.env` loses that night's local backup. A deploy is blocked until it is fixed.
  - **Mitigation:** the ERR trap pings `/fail` straight away, so the owner hears the same night.
  - **Left as is:** this is a deliberate, documented choice ("half a configuration is a mistake").
  - **Alternative:** take the local copy first, then fail the run.
- **A failed upload is never retried.** The nightly copy from a failed night is not uploaded later; the next successful run uploads only its own copy, which leaves a one-day gap off-site. This is acceptable with a daily cadence.
- **`SharkJobStale` cannot fire for a job that has never succeeded.** That job has no `job_last_success_timestamp_seconds` series. Pair it with `absent()` when a scraper is set up.
- **Anonymous browser reports share one 300-a-minute budget.** A flood can answer 429 to legitimate anonymous reports. Reports are best-effort, and this matches the spec's "300/min/tenant".
- **"`drill=passed`" in the implementer's notes needs context.** The local evidence (notes and PILOT-HOSTING "Evidence") was produced with a stubbed `docker`. Locally this proves only the script's control flow up to and including `offsite_download=verified` and cleanup. The real restore and boot run only in `pilot-stack.yml`.
- **Pre-existing footgun: running vitest directly in `apps/api` touches the wrong database.** `pnpm exec vitest …` without the package's `test` script has no `SHARK_DB`, so the db client opens and creates `apps/api/data/shark.db`.
  - **What happened here:** my first direct run created an empty file, which I deleted; no data was involved.
  - **Use instead:** `pnpm -F @shark/api test`, which always uses `data/test/shark.db`.
  - **Also:** `pnpm -F @shark/api test -- <names>`, from the phase's "How to verify", does not filter; it runs the whole API suite. That is harmless but slower.
- **Not run here:** the Docker/systemd/Caddy flow in `pilot-stack.yml`, including the three new off-site steps. It will run on GitHub for the PR.

### Checked and found sound

- **Config:** OTP refactor to `runtimeConfig`; Twilio/MSG91/Resend credentials come from validated config. Behaviour change: an invalid OTP limit is now refused at boot instead of silently falling back to its default.
- **Error reporting:** Sentry envelope format and DSN parsing (including path prefixes); redaction of messages, frames and file names (query strings and cwd stripped).
- **Process lifecycle:** crash handlers (exit only in production; SIGTERM flushes); scheduler double-capture avoided (`executeJob` records, `runScheduledJob` captures once).
- **Metrics:** bounded label sets (method normalised, route templates, fixed job names); constant-time token comparison.
- **Client errors:** CSRF exemption limited to the one public, write-only path, which still needs a known Origin; body cap enforced on the stream.
- **SPAs:** fingerprint dedupe per tab session; the e2e spec uses a CDP block because of keepalive.
- **CI:** e2e job (browser cache keyed by Playwright version, report and traces on failure).
- **Migrations:** snapshot chain test.
- **Recovery screens:** plain register and Sonar tokens in both apps (screenshots 02 and 04).

## Final verification (reviewer, after fixes)

Run at `2c15353` (Node 22.23.5, pnpm 10.28.0), from `shark-fitness/`, every step exit 0:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass (0 warnings) |
| `pnpm test` | **1,502 tests in 127 files, all passing**: contracts 6/1, domain 271/12, member-pwa 40/11, admin-web 295/38, api 890/65 (implementer: 1,501; baseline 1,427/119) |
| `pnpm build` | pass |
| `SHARK_E2E_PORT=18062 pnpm e2e`, twice | 3 passed (13.0 s), then 3 passed (10.2 s); afterwards no `shark-e2e-*` dirs, no `e2e/.state`, no listener on 18062, no `apps/api/data/shark.db` |
| `pnpm -F @shark/api db:check-drift` | `migration_drift=none` |
| `drizzle-kit generate` against a temp `SHARK_DB` | "No schema changes, nothing to migrate" |
| `/tmp/shellcheck` 0.10.0 `-S warning deploy/pilot/*.sh`, `bash -n` on each | silent, all pass |
| `git diff --stat origin/claude/musing-wilbur-d67503 -- shark-fitness/infrastructure/migrations/` | only `meta/0014–0017_snapshot.json` |

Reviewer commits on top of `128aec1`: `dccb696`, `af04509`, `6227a74`, `2c15353`. Servers I started (production smoke on 18061, ping recorder on 18050, e2e on 18060/18062) were all stopped, and their temp dirs, the age/rclone downloads and the harness were deleted.
