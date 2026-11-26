# P09 — Code review and fixes: notes

Branch `phase/P09-code-review` from `integration/features` (4fa023b). Worktree `/workspace/sf-wt/P09`.
Ports for any server: 18900–18999. Temp DBs via mktemp only.

## Plan

1. Baseline: install, typecheck, lint, test, build on the untouched branch (numbers recorded below).
2. Read-only review sweeps (security, correctness, formatting inventory, performance), each finding verified in code before it goes in the report.
3. Automated guards (API, Vitest, run by `pnpm test` → CI):
   - `security-route-enumeration.integration.test.ts`: every mutating route refuses a session without CSRF token and a foreign Origin (documented exemptions only); every unauthenticated route has a rate limiter in its chain (via Hono's router); every `:id` route answers 404 to another tenant's ids (admin: Reef owner vs Shark ids; member: a Reef member vs Shark ids).
   - strict-schema check: `validate()` records each JSON-body schema; a test asserts every one is `.strict()` (or explicitly passthrough-free by pick) — fixes the ones that are not.
4. Fix findings: Critical/High each with a regression test; Mediums fixed or rationale + KNOWN-ISSUES.
5. Formatting: one module in `@shark/domain` (`format.ts`): money (`−₹1,234.00`), numbers (en-IN grouping), dates in the branch timezone. Replace admin `money()` helpers, member `rupees()`, website price formatting; lint rule `no-restricted-syntax` forbids `toLocaleString`/`Intl.NumberFormat`/`Intl.DateTimeFormat` with `en-IN` outside the module.
6. Performance: `EXPLAIN QUERY PLAN` test over P02–P07 hot queries (index beginning with `tenant_id`); N+1 review of hot endpoints; `scripts/check-bundle-budgets.mjs` + CI step; profiling notes for Workout and Store register.
7. Supply chain: `pnpm audit --prod`, pinned gitleaks over full history with an allowlist (`.gitleaks.toml`), Docker image review.
8. Report `docs/reviews/CODE-REVIEW-2026-11.md`, `docs/KNOWN-ISSUES.md`, PR description.

## Checklist

See P09-progress.json (mirrors this list).

1. Report with findings table + ASVS L2 checklist; every Critical/High fixed with regression test; Mediums fixed or scheduled (AC1)
2. IDOR enumeration, mutating-route CSRF and strict-schema tests pass and run in CI (AC2)
3. `pnpm audit --prod` and gitleaks summarized; nothing unaddressed (AC3)
4. One money/date/number module used by website, member, admin; lint forbids stray `en-IN` locale formatting; unit tests (AC4)
5. Bundle budget script in CI and passing; budgets in report (AC5)
6. Query-plan tests; perf scripts within targets (AC6)
7. Standard gates, e2e, route coverage; test counts not lower (AC7)
8. Correctness sweep: dead/duplicate code, query keys, Platform comment, transactions, timezone, error codes, contracts
9. Docs: KNOWN-ISSUES, report, PR description

## Baseline (before any P09 change)

(filled in below)

## Decisions

(filled in as made)

## Integration notes

- P08 (test suite) runs in parallel and is not on this branch. `pnpm -F @shark/api test:route-coverage` and `pnpm perf:concurrency` are P08 deliverables; see below for how this phase handles them.
