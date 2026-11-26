# P08 — Full test pass (route coverage, critical scenarios, Playwright E2E)

Branch `phase/P08-test-suite` from `integration/features` (4fa023b). Worktree `/workspace/sf-wt/P08`.
Node 22 from `/home/box/opt/node22`, pnpm 10.28.0. Servers I start use ports 18800–18899.

## Baseline (before P08, `pnpm test` at 4fa023b)

contracts 28/2 files, domain 300/15, website 16 (+10 skipped until built)/2, member-pwa 192/27, admin-web 411/55, api (see below).

## Plan

1. **Test infrastructure first**
   - API test DB directory overridable (`SHARK_TEST_DIR`, default `data/test`) so parallel sessions/agents can run the API suite.
   - Route coverage: a Vitest setup file wraps `app.request` and appends `METHOD path` to an NDJSON log when `SHARK_ROUTE_COVERAGE_LOG` is set. `scripts/route-coverage.ts` lists `app.routes` (same logic as `scripts/postman/list-routes.ts`), resolves every logged request through Hono's own router (first non-`ALL` match = the route that served it), writes `apps/api/route-coverage.json`, fails on any uncovered route not in `route-coverage-exceptions.json` (≤ 5, each with a reason). `pnpm -F @shark/api test:route-coverage` runs the suite with logging on, then the check.
   - `scripts/untested-screens.mjs`: every `apps/{admin-web,member-pwa}/src/screens/**/*.tsx` must be imported by at least one test file; prints the ones that are not and exits 1.
2. **API**: integration tests for every uncovered route; a data-driven authorization matrix (`authorization-matrix.integration.test.ts`) that, for every admin route, proves reception/trainer/accountant without the permission get 403 and a Reef owner gets 404 for Shark ids.
3. **Critical scenarios**: tests named `[PRD01-Sx]` / `[PRD02-14.2-…]`; `docs/TEST-STRATEGY.md` maps scenario → file → layer.
4. **Front end**: component tests for every untested admin and member screen (loading, empty, error, permission, offline where relevant).
5. **Playwright**: projects `desktop-1440`, `tablet-768` (admin), `pixel7`, `iphone13` (member, website), plus the existing PWA project. Owner session reused through a storage state created in global setup (one TOTP step instead of one per spec), parallel workers, per-spec data. Axe scan of every visited page into `e2e/reports/a11y.json` (reported, not gating).
6. **Perf**: `pnpm perf:concurrency` (50 concurrent check-ins, 50 concurrent last-seat bookings against a production build) → `docs/PERFORMANCE-BASELINE.md`.
7. **Coverage**: Vitest v8 coverage per package; thresholds = measured values rounded down; CI coverage step.
8. **CI**: e2e job with retries=1 and report/trace/a11y upload; route-coverage step; coverage step; actionlint.
9. Bugs found → fixed with a regression test, or `docs/KNOWN-ISSUES.md` with severity.

## Checklist (mirrors P08-progress.json)

1. Route coverage script + `route-coverage.json` at 100 % except ≤ 5 documented exceptions (AC1)
2. Authorization matrix: every admin route × reception/trainer/accountant + cross-tenant owner (AC2)
3. Critical scenarios named `[PRD0…]` + `docs/TEST-STRATEGY.md` (AC3)
4. Component tests for every admin/member screen + untested-screens script prints none (AC4)
5. Playwright suite ≥ 45 specs on desktop-1440/tablet-768/pixel7/iphone13, 3 consecutive green runs, a11y JSON (AC5)
6. `pnpm perf:concurrency` invariants + p95 in PERFORMANCE-BASELINE.md; `perf:baseline` passes (AC6)
7. Coverage thresholds configured and passing; CI updated and actionlint-clean (AC7)
8. Standard gates pass; per-package test counts in PR (AC8)
9. Bugs fixed with regression tests / KNOWN-ISSUES.md
10. PR description `pr/P08.md`

## Decisions

(added as work proceeds)

## Integration notes

(none yet)
