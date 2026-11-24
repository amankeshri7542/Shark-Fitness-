# P01 notes — Finish pilot hosting (PR #27) and production readiness

Branch `phase/P01-prod-readiness`, based on `claude/musing-wilbur-d67503` (HEAD `654e2ac`, PR #27). Node 22.23.5 from `/tmp/node22`, pnpm 10.28.0.

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
