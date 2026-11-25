# P01 notes — Finish pilot hosting (PR #27) and production readiness

Branch `phase/P01-prod-readiness`, based on `claude/musing-wilbur-d67503` (HEAD `654e2ac`, PR #27). Node 22.23.5 from `/home/box/opt/node22`, pnpm 10.28.0.

## Plan

1. **Migration metadata** (first, because it is self-contained): add the 3 missing schema files to `drizzle.config.ts`; run `drizzle-kit generate` once to obtain the true post-0017 snapshot, prove it equals `0013 + (0014..0017)`, derive 0014–0017 snapshots as a chain, discard the generated SQL. `scripts/check-migration-drift.mjs` (`pnpm -F @shark/api db:check-drift`) + CI step + a unit test for the config list and snapshot chain.
2. **Config** (`lib/config.ts`): declare OTP provider/credential vars, OTP limits, `SHARK_ERROR_REPORTER`, `SHARK_ERROR_DSN`, `SHARK_METRICS_TOKEN`; refusals at boot; export the key list. `otp-delivery.ts`/`otp-limits.ts` read `runtimeConfig` only. Guard test: no `process.env` outside `lib/config.ts`; every key in `.env.example`.
3. **Error reporting**: reporters `none|console|http|sentry` (Sentry envelope over `fetch`, no SDK), `auto` selection, `flushErrorReports(cap)`, `lib/process-handlers.ts` for `unhandledRejection`/`uncaughtException`, scheduler tick capture with job name. Tests with a local HTTP server and child processes.
4. **Metrics**: `lib/metrics.ts` (hand-rolled Prometheus text exposition, no dependency), HTTP middleware with route templates, job counters, scrape-time DB gauges; `GET /metrics` bearer-gated, 404 when unset.
5. **Client errors**: `POST /v1/client-errors` route; shared client reporter + error boundary in both SPAs (recovery screen in plain register, fingerprint dedupe per session).
6. **Backups**: `backup.sh` off-site step (age + rclone), `restore-drill.sh --from-offsite`, `provision.sh` packages, `pilot-stack.yml` steps, docs.
7. **E2E**: `shark-fitness/e2e` (`@shark/e2e`), global setup/teardown, 3 specs, CI job.
8. Docs: `.env.example`, PRODUCTION-READINESS §1–2/§9/§12, README, OPERATIONS-ALERTS, PILOT-HOSTING.

## Checklist (mirrors P01-progress.json)

1. PR #27 content on branch; shellcheck -S warning silent; bash -n passes.
2. Off-site encrypted backup + `--from-offsite` drill + forced-failure path, scripted in pilot-stack.yml.
3. Config declares/validates every env var; guard tests (process.env, .env.example) + refusal tests.
4. Sentry provider (envelope, auth header, frames, release/env/request_id, no PII) + console/none tests.
5. Scheduler job failure → one capture with job tag + failed job_runs row; unhandled rejection in child process captured and logged.
6. `POST /v1/client-errors` 204/413/422/403/429 tests; SPA error boundaries + component tests.
7. `GET /metrics` 404/401/200 + label-id test.
8. drizzle.config lists 8 files; generate → no changes; no applied SQL changed; CI step.
9. `pnpm e2e` 3 specs green twice, no leftovers, never touches apps/api/data/shark.db.
10. Docs updated (placeholders only); standard gates pass.

## Decisions and assumptions

- **Snapshots 0014–0017 were derived, not hand-written.** `drizzle-kit generate` with all 8 schema files emitted SQL identical in effect to 0014–0017 (minus triggers, which drizzle does not model). A script verified that the generated snapshot minus those four changes equals 0013 exactly, then wrote 0014, 0015, 0016 and 0017 as a `prevId` chain. The generated SQL was discarded; no applied SQL was touched.
- `drizzle.config.ts` `dbCredentials.url` now honours `SHARK_DB` (only push/studio/introspect open it), so tooling can be pointed at a scratch DB.
- **Session 2 (resume):** found the observability WIP (error reporters, crash handlers, metrics, client-error route) uncommitted after a box reset; reviewed it, ran all 875 API tests green, committed it as d6a9202, then added integration tests for /v1/client-errors and /metrics.
- Member ids are `mbr_` (not `mem_` as the phase spec says); the label test refuses `ten_|usr_|mem_|mbr_|br_`.
- `/v1/client-errors` is exempt from the CSRF double-submit token (a crashed page may not have read its token) but still passes the global Origin check, and the route itself demands a known Origin. Rate limits: 30/min/IP, then 300/min per signed-in tenant or one shared anonymous budget.
- `/metrics` disabled returns the API's normal 404 JSON. Extra gauges beyond the spec: `data_filesystem_size_bytes`/`data_filesystem_avail_bytes` (for the disk > 80 % alert) and `app_build_info`.
- **Client-error contract lives in `@shark/contracts`** (schema, fingerprint, `ERR-XXXX-XXXX` reference, framework-free reporter with once-per-fingerprint-per-session dedupe in sessionStorage). The API validates exactly what the apps send; each app keeps only a thin module (its own `ApiError`/`OfflineError` exclusions) and its own recovery screen styled for its surface.
- **API and offline failures are not reported from the window listeners**: the server already knows about API errors, and offline is not a bug. Render crashes are always reported by the boundary.
- **Recovery screen inside the router's shell**: the routers' `defaultErrorComponent` renders the same recovery screen as the top-level boundary, so a crashed console screen keeps the rail. Found by e2e: the router first renders it for an intermediate error, so the reference is keyed on the error (`useMemo`) to match the one reported.
- **Reports use `fetch(..., { keepalive: true })`** so a report leaves even when the person taps Reload at once. Playwright's `page.route` interception swallows keepalive requests and Playwright does not surface them as page events; the e2e spec blocks the chunk with CDP `Network.setBlockedURLs` and asserts on the server's own log (one `client_error` line with the shown reference, one 204).
- **Off-site upload failure is fatal only for the nightly run** (unit failed + `/fail`); pre-deploy and manual runs warn and exit 0 because their local copy is good and a deploy should not be blocked by a bucket outage. In every case local pruning is skipped until an upload succeeds.
- **Off-site layout** `<remote>/<kind>/shark-<stamp>.db.age` + `.manifest.json.age`; recipients are age `age1…` keys only (comma-separated), validated before backing up. `RCLONE_CONFIG` defaults to root's config because the systemd unit runs without `$HOME`.
- **Retention**: erased members persist in backups up to max(14 local, 30 off-site) days; documented with the re-apply-after-restore procedure and the need to state the window in the privacy notice.
- **Disk/memory alerts for the pilot** use DigitalOcean Monitoring (free) rather than adding a scraper; Prometheus rules are written for later. `/metrics` adds `data_filesystem_*` gauges for the disk rule.
- **e2e runs with jobs disabled** (deterministic data) and `SHARK_ERROR_REPORTER=console` so the server log carries reports; service workers are blocked so the build under test is what loads. Playwright 1.65.1 pinned; added because PRD 02 §7.2/§14.1 call for E2E and it is the standard.
- Dependencies added: `@playwright/test` 1.65.1 (+ `@types/node`, `typescript` already in the workspace) in `@shark/e2e` only. No runtime dependency added.
- **Not run here**: the Docker/systemd parts of `pilot-stack.yml` (no Docker on this box). Exercised locally instead with a stub `docker`, real age/rclone and an rclone local remote.
- **Noticed, not fixed (out of scope)**: when a lazy route chunk fails to load, TanStack Router first renders the error component with React error #31 ("object with keys {default}") before the real `Failed to fetch dynamically imported module` error. Harmless now (only the final error is reported), worth a look in P09.
