# P10 — UI/UX and accessibility audit (notes)

Branch `phase/P10-ux-audit` from `integration/features` @ 4fa023b. Worktree `/workspace/sf-wt/P10`.
Session 1 restarted on 26 Nov 2026 (no prior progress file or commits on the branch).

## Plan

The phase changes audit tooling and documentation only. No product source file changes.

1. **Audit harness** `shark-fitness/e2e/audit/` run by `pnpm -F @shark/e2e audit` (`node audit/run.mjs`):
   - Own Playwright config (`audit/playwright.audit.config.ts`) reusing the e2e global setup/teardown (production
     single-origin build, temp seeded SQLite, owner TOTP). Not part of `pnpm e2e` (`testDir: ./specs` there) or `pnpm test`.
   - `audit/routes.ts`: the route catalogue of all three apps (website pages, member routes, console routes incl. tabs),
     each tagged with its PRD 03 screen ID.
   - Specs (`*.audit.ts`): screenshots (5 viewports × 2 themes, + compact density for the console); axe (wcag2a/aa,
     21a/aa, 22aa) per route per theme; target sizes; 320 px reflow, 200 % zoom, text-spacing override; reduced
     motion; forced states (loading/empty/500/403/offline) by route interception; ARIA snapshots of key screens;
     keyboard walkthroughs (scenario 17 + member check-in/booking/workout) recorded step by step; Lighthouse via
     `pnpm dlx lighthouse@13.6.0` with the session cookie.
   - `audit/contrast.mjs`: computes every text and non-text token on every surface token, both themes, from
     `packages/design-tokens/src/sonar.css` (alpha compositing) → `docs/ux-audit/contrast.md`.
   - `audit/report.mjs`: turns raw JSON into `docs/ux-audit/axe-summary.md`, `contrast.md`, `automated-checks.md`
     (targets, reflow, zoom, spacing, motion, states, Lighthouse) and the coverage table in UX-AUDIT.md.
   - `audit/validate-findings.mjs`: schema + severity counts, cross-checked against the summary table in UX-AUDIT.md.
   - Unit tests (`node --test`) for contrast maths, the CSS token parser and the validator.
2. **Manual/expert review** from screenshots, the accessibility tree, the keyboard runs and the code: Nielsen
   heuristics per app, copy/tone, forms, IA/navigation (member bottom-nav recommendation), performance perception,
   DESIGN.md visual consistency; per-screen contract sections for UX-A01…A15, UX-M01…M14 and each website page.
3. **Deliverables**: `docs/ux-audit/UX-AUDIT.md`, `findings.json`, `contrast.md`, `axe-summary.md` (+ supporting
   generated files and ARIA snapshots).
4. Gates: typecheck, lint, test, build, e2e; diff limited to `e2e/audit/**`, `docs/ux-audit/**`, package.json scripts.

## Checklist (mirrors P10-progress.json)

1. AC1 — audit runs end to end with one command, exits 0, outputs at stated paths, every route in coverage table.
2. AC2 — UX-AUDIT.md sections for UX-A01…A15, UX-M01…M14, each website page, every mandatory state evaluated.
3. AC3 — every finding has evidence + PRD/WCAG ref; validator prints counts matching the report.
4. AC4 — contrast table: all text tokens × all surfaces × both themes, failures flagged.
5. AC5 — keyboard walkthroughs of scenario 17 and member flows, step by step, pass/fail.
6. AC6 — no product source changes (diff limited to audit tooling, docs, package.json script lines).
7. AC7 — standard gates and `pnpm e2e` pass.
8. Unit tests for audit logic (contrast, parser, validator).
9. PR description pr/P10.md; scratch files removed; status done.

## Decisions

(added as they are made)

## Integration notes

(added as needed)
