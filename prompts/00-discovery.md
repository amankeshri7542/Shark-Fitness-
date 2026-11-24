<role>
You are the lead engineer and technical architect on Shark Fitness, a gym management product, delivering it for a paying freelance client (Aman). This is the client's flagship project, so the plan you write now decides how good the finished product is. You are working inside the repository at /workspace/shark-fitness-repo.
</role>

<context>
- The client wants the product "fully built, everything: from the website to the mobile app to everything, plus testing, review and changes, and most importantly an audit of the UI/UX and user experience of all the apps, with good practices throughout."
- The client is travelling and cannot answer questions. You will not be able to ask anyone anything; make the decisions a senior freelancer would make and write your assumptions down.
- Requirements live at the repo root: 01_Shark_Fitness_Product_Functional_PRD.md, 02_Shark_Fitness_Engineering_Technical_PRD.md, 03_Shark_Fitness_Design_UIUX_PRD.md, 04_Shark_Fitness_Enterprise_Compliance_PRD.md, 05_Shark_Fitness_Remaining_Implementation_Plan.md.
- The code is a pnpm monorepo in shark-fitness/ (apps/api, apps/admin-web, apps/member-pwa, packages/*, docs/, context.md). shark-fitness/docs/PRODUCTION-READINESS.md lists the remaining production work (backups, payment provider, boot-time env validation, error reporting).
- "Shark-inspired member app prototype/" at the repo root is a design prototype (HTML/JSX) of the member app.
- Open PR #27 "Pilot hosting: one server, nightly backups, restore drill, alerts" is on branch origin/claude/musing-wilbur-d67503 and is not merged. Inspect it with `git fetch origin && git diff origin/main...origin/claude/musing-wilbur-d67503` and `gh pr view 27`.
- Box environment: Node 24 (repo says 22.x; it generally works), pnpm 10.28 via corepack, PostgreSQL client present, no Docker, no Android SDK, no iOS tooling. Chromium/Playwright may need installing. 8 CPU, 15 GB RAM.
- Later, each phase you plan will be executed by a separate Claude Code session that only sees the phase section you write plus the repo, so every phase must stand on its own.
</context>

<task>
This is a READ-ONLY discovery and planning pass. Do not modify, create or commit anything inside the repository. You may run read-only commands (install deps, typecheck, test, build) to learn the real state, but leave the git working tree clean.

1. Read all five PRDs fully, docs/PRODUCTION-READINESS.md, context.md, the prototype folder, and the PR #27 diff.
2. Inventory what actually exists in each app (API, admin web, member PWA, any marketing/public website, any mobile app, packages). Open the code; never speculate about code you have not read. Run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` in shark-fitness/ and record the real results.
3. Compare the inventory against PRDs 01-04, PRODUCTION-READINESS.md and PR #27. List concrete gaps with PRD section references.
4. Write the ordered phase plan to /workspace/shark-fitness-orchestration/PHASE-PLAN.md and a machine-readable index to /workspace/shark-fitness-orchestration/phases.json.
</task>

<phase_coverage>
The plan must cover, in a sensible dependency order (merge or split as you judge best, roughly 8-12 phases total, each sized to be finishable in one long session):
a. Finishing PR #27 and production readiness: backups/restore drill, boot-time env validation, error reporting (provider-agnostic with a no-op/console default, DSN via env var), and a real payment provider integration (pick the one the PRDs imply, likely Razorpay for India; sandbox/test mode only, placeholder env vars, webhook signature verification, idempotency).
b. A public marketing website for the gym (if not present): pages, SEO, performance, lead capture/trial booking wired to the API.
c. The member mobile app (and staff/admin mobile if the PRDs require it). Decide the technology from the PRDs (e.g. Expo/React Native sharing packages/contracts and design-tokens, or a hardened installable PWA with a Trusted Web Activity path for the Play Store). Remember there is no Android SDK on this machine, so verification must be by typecheck, unit tests, and web/export builds.
d. Any remaining PRD feature gaps you found.
e. A full test pass: unit, integration (API against a real database), and end-to-end browser tests (Playwright) for the main flows of every app.
f. A code review and fixes phase (security, correctness, performance, consistency).
g. A thorough UI/UX and user-experience audit of every app against 03_Shark_Fitness_Design_UIUX_PRD.md and good practice: accessibility (WCAG 2.2 AA, keyboard, contrast, labels), responsive layouts, empty/error/loading states, copy and microcopy, navigation and flows, form validation, performance perception. The audit writes a findings report with severity, and a following phase implements the fixes.
</phase_coverage>

<output_format>
PHASE-PLAN.md must contain:
- "## Current state" (inventory per app, test/build results with the commands run)
- "## Gaps vs PRDs" (bulleted, each with the PRD file and section)
- "## Decisions and assumptions" (technology choices and why, anything assumed because the client could not be asked)
- One section per phase with the exact heading form "## Phase P<NN>: <title>" (P01, P02, ...), each containing: Goal, Why, Scope (in / out), Acceptance criteria (numbered, testable), How to verify (exact commands and what passing looks like), Dependencies, Risks.

phases.json must be exactly this shape:
<example>
{"phases":[{"id":"P01","slug":"prod-readiness","title":"Finish pilot hosting and production readiness"},{"id":"P02","slug":"payments-razorpay","title":"Razorpay sandbox payments"}]}
</example>
Slugs are lowercase kebab-case, at most 30 characters, used as git branch names (phase/P01-prod-readiness).
</output_format>

<constraints>
- Read-only for the repository: no edits, no commits, no branches, no pushes, no PR comments.
- Be ambitious in scope (this is the client's showcase), but keep each phase concrete and verifiable; no vague "improve X" items.
- Never plan anything that deploys to production, sends real emails/SMS/messages, stores real secrets, or charges real money.
</constraints>

<final_report>
End with a short plain-text summary: the phase list (id + title), the baseline test/build results, and the top 5 assumptions.
</final_report>
