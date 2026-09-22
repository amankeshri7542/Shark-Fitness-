# Staffed-gym stabilization — 20 September 2026

Resumed and verified on **22 September 2026**. This report supersedes older README claims that every module is complete. Scope remains one staffed gym, not completion of the full product.

## Scope and scoring fixed before implementation

Phase 1 audit and phase 2 local stabilization only. One staffed gym; staff record cash actually received or UPI independently verified in the gym's bank/provider app. Reception records attendance. Integrated collection, physical door hardware, marketing providers, credit-pack purchasing, member import/edit expansion, progress-entry and richer trainer authoring are outside this offering. Workout and class booking are included only if the checks below pass; otherwise explicitly unavailable/not demonstrated.

Scores are acceptance evidence, not screen counts or unit-test counts. Each row is binary: all specified evidence earns the full weight; failed, partial or unexecuted evidence earns zero. Same denominator and weights before/after. Unknown is recorded separately from a reproduced failure. A pilot remains NO-GO if money confirmation/balances, privacy, activation, effective membership access or deployment persistence/recovery is failed or unproven.

| Acceptance evidence | Demo weight | Pilot weight |
| --- | ---: | ---: |
| Fresh empty gym, staff/member activation and sign-in, no DB edits for day-to-day use | 15 | 15 |
| Enrollment → plan → verified recorded payment → receipt → reception attendance persisted | 20 | 20 |
| Multiple invoices, partial payments/refunds, repeat submissions agree across surfaces | 10 | 15 |
| Role/tenant privacy and revoked realtime access | 10 | 15 |
| Cancellation/freeze/access around effective dates; renewal behavior truthful | 10 | 10 |
| Directory beyond 50, desktop and phone critical browser journeys | 10 | 5 |
| Workout/offline and booking/waitlist proved, or safely excluded from offering | 5 | 5 |
| Build, lint, types and regression suite; apps boot and serve assets | 10 | 5 |
| Deployment migrations, persistent restart/redeploy and configured DB recovery demonstrated | 5 | 10 |
| Operator checklist, reset procedure, honest demo and known limits | 5 | 0 |
| Total | 100 | 100 |

## Baseline

Local HEAD `c9211b7`, branch `codex/production-hardening-p0`, matches cached remote ref; 31 commits ahead of `main`. No network freshness implied. Preserved six modified tracked files and two untracked UI/store test files from the user. Shared contracts, domain rules, integer money, transactions, idempotency, additive migrations and existing UI primitives retained.

The default local pnpm resolved Node 24 despite the repository requiring Node 22; pinned Node 22/pnpm 10.28 then reached the known `tsx` launcher IPC sandbox restriction. Equivalent `node --import tsx` launch will be used and reported, not counted as an application defect.

Confirmed from code and failing regressions: no directory next-page action; interrupted outbox `sending` entries never retry. Fake pass grid is a deterministic drawing, not a QR encoder; remove the misleading reader claim for reception-only scope.

## Outcome and branch reconciliation

Remote state fetched on 22 September: local HEAD and `origin/codex/production-hardening-p0` were both `c9211b7e00212d4115058eaceed9900d94fc4502`, with zero divergence. `origin/main` was an ancestor; candidate was 31 commits ahead. No older feature branch was merged and no history was rewritten. PR: [#15](https://github.com/amankeshri7542/Shark-Fitness-/pull/15), targeting `main`. GitHub CLI's active account was `amankeshri7542`.

The original six tracked edits and two new tests were inspected and retained: OTP identifier disambiguation, member-session role handling, rail accessibility and command-palette focus handling are relevant stabilization work. No new dependency was added. Shared contracts, domain functions, transactional writes, integer minor-unit amounts, immutable money/audit records, idempotency and Sonar UI primitives remain in place.

**Demonstration: conditional GO for the documented supervised synthetic walkthrough.** You can show enrollment, membership assignment, manual payment recording, acknowledgement receipt and reception attendance. Do not claim new-account browser activation is fully rehearsed until the human password step is completed. **Real-member pilot: NO-GO**, regardless of the score, until the actual target environment passes persistence/recovery and operator acceptance gates.

## Findings and disposition

| Finding | Final disposition and practical effect |
| --- | --- |
| New staff/member accounts lacked a usable password path | Fixed with operator empty-gym bootstrap plus authenticated, scoped, in-person one-time activation issuance and redemption. Tokens hashed, expire after 24 hours, replacement invalidates prior links, already-passworded/disabled/deleted/held accounts cannot use activation as reset. Both clients accept gym code. |
| Activation URL changed on an already-mounted sign-in screen | Reproduced; both screens react to `hashchange`, including removal. Strengthened tests verify the latest token/gym and return to ordinary sign-in. |
| Fresh browser activation attempted authenticated CSRF preflight | Found during resumed review: anonymous `/auth/csrf` returned 401 before redemption. Both clients now treat redemption as a session-entry endpoint, matching the server. Real client regressions failed before the exemption and passed after; no CSRF protection removed from issuance or ordinary writes. |
| Members could subscribe to staff feeds; revoked live sessions retained authority | Member subscriptions now limited to their own member channel; ticket redemption and every inbound/outbound delivery recheck session authority. Real WebSocket tests cover subscription/replay denial and revocation. Malformed JSON primitives no longer crash the handler. |
| Cancellation ended access before notice, freeze completion was absent | Explicit branch-local effective dates reconciled on scheduler and relevant read/write boundaries. Freeze end stored by additive migration 0014. Manual unfreeze cannot revive an expired term; immediate/zero-notice cancellation updates lifecycle immediately. Scheduled cancellation while frozen or in grace is refused rather than upgrading access; staff must resolve state or cancel immediately. |
| Partial refunds hid debt or reduced unpaid principal twice | Nonvoid unpaid principal is `max(total − gross payments, 0)`; refunds separately reduce money retained. All-invoice totals replace truncated-history sums. Paying remaining principal activates eligible pending membership and stops dunning even if display state remains partially refunded. |
| Financial test expected 7,000 rather than 7,500 | Reviewed, not loosened: invoice 10,000, gross payments 2,500, refund 500 leaves 7,500 unpaid and 2,000 retained. Refund is neither another payment nor a credit note. Exact assertion changed to 7,500; new multi-surface and final-payment regressions cover the rule. |
| Repeated partial-refund submission could refund twice | Existing idempotency mechanism now covers refund requests; UI retains one attempt key, duplicate replays once and changed body under the same key fails. |
| Walk-in enrollment required a fictitious completed trial | Qualified leads may now convert atomically without claiming a trial occurred. Duplicate contact/account and repeated conversion protections retained. |
| No receipt issuance | Scoped succeeded-payment download supplies a stable-ID plain-text acknowledgement with gym/member/invoice/payment/reference/refund information. It is expressly not certified fiscal/GST invoicing. |
| Manual payment could be mistaken for collection | UI explicitly requires independently received-funds acknowledgement; UPI reference validated by UI and both payment routes. No bank/provider verification is claimed. |
| Directory stopped at 50 | URL-backed pagination and deterministic ID tie-breaker added; 51-member API fixture and UI regression verify access to page two/filter reset. Metrics labelled as page-local. |
| Interrupted offline writes stayed `sending` | Replay includes interrupted writes with their original idempotency key and owner partition. Regression passes; full phone interruption/resume rehearsal remains outside the demo and unverified. |
| Pass graphic was not QR encoding and timing drifted | Removed the fake graphic/countdown; show reception ID and manual attendance instructions. No physical-reader integration claimed. |
| Waitlist offers did not reserve seats/advance reliably | New joins/promotions disabled with explicit unavailable copy. Existing queue retained for staff review. Ordinary booking is outside the demonstration. Full reservation/expiry accounting deferred. |
| Ephemeral deployment storage, implicit demo seed, wrong backup source | Persistent-disk source configuration; explicit opt-in synthetic seed; backup honors configured DB; runtime ships recovery scripts. Local fresh provisioning, checksum/restore/migration and restored production boot verified. Hosted behavior remains unknown. |
| Existing GitHub verify job failed | Historical exact HEAD run failed at `git diff HEAD^ HEAD` because checkout was shallow; later gates were skipped. Checkout depth corrected and `codex/**` push coverage added. New exact-SHA results recorded at handoff, not inferred from historical image success. |

Already-present strengths are not attributed to this patch: local baseline lint, typecheck, build and **1,231 tests** were already green. The baseline was actually rerun from an isolated archive of `c9211b7`, with workspace dependency links verified to point inside the archive. These tests had not covered the defects above. Baseline logs: `/tmp/shark-head-baseline-{lint,typecheck,build,test}.log`; result manifest `/tmp/shark-head-baseline-results.json`.

## Final local evidence (22 September)

Commands used Node **22.23.2**, pnpm **10.28.0**, and the repository scripts. The ordinary test command was run outside the restricted sandbox to permit `tsx` IPC and loopback WebSocket listeners; no launcher workaround or skipped suite was necessary in this final run.

| Check | Result / evidence |
| --- | --- |
| `pnpm typecheck` | Passed all packages; `/tmp/shark-sep22-typecheck.log`. Production builds also perform TypeScript checks. |
| `pnpm lint` | Passed with `--max-warnings=0`; `/tmp/shark-sep22-lint.log`. |
| `pnpm test` | **1,259 passed, 96 test files**: domain 255, API 714, admin 262, member 28. No skipped test credit. `/tmp/shark-sep22-tests.log`. Deliberately induced failure logs in tests are expected assertions, not ignored suite failures. |
| Fresh core journey | `staffed-gym.integration.test.ts`: bootstrap empty tenant; create/activate receptionist; qualify/convert member; activate; assign product; deny unpaid attendance; record payment twice → one payment; authorized receipt, member receipt/admin denial; granted attendance twice → one open visit. Only pagination test uses bulk synthetic DB fixtures, clearly separate from onboarding. |
| Finance and membership | Multiple invoices beyond history limits, partial payments/refunds, replay/mismatch, notice/freeze/unfreeze/expiry/grace and immediate cancellation tests pass. Detailed evidence in linked subreports. |
| Offline recovery | Client outbox regression passes with an interrupted `sending` entry, original key, and other-owner entry untouched. This is a mocked IndexedDB/API unit test, not an end-to-end device crash recovery proof. |
| `pnpm build` | Passed API and both production front ends; `/tmp/shark-sep22-build.log`. |
| Recovery | `verify-deployment.mjs` and `pnpm db:backup:verify` passed, including restored migration, integrity/checksum, immutable rows, `/ready` and authenticated dashboard. Latest log `/tmp/shark-final-recovery-2026-09-22.log`; recovery artifact path in deployment subreport. |
| Source review | Complete changes reviewed across account/privacy, money/membership, UI and deployment; no new packages or unrelated product modules. `git diff --check` passed. Secret/private-key/conflict signature scan across 85 candidate paths found none; synthetic credentials are clearly test fixtures. |

Browser evidence and exact pushed-SHA CI results are recorded in the release handoff below. Browser activation-password submission remains **pending human execution**: automatic approval review rejected that credential-change action, and it was not bypassed. Component/API tests do not substitute for that browser step.

## Readiness scores using the unchanged rubric

The very low BEFORE score reflects strict completed-journey evidence and known blockers, not the amount of existing functionality. A row gets no partial points. For example, many enrollment screens existed before, but fresh activation and receipts were missing, so those end-to-end rows earned zero.

| Acceptance row (same order as rubric) | Demo before → after | Pilot before → after | Evidence / unknown |
| --- | ---: | ---: | --- |
| Fresh empty gym/account journey | 0 → 15 | 0 → 15 | API journey and real client tests pass; browser credential step separately withheld below. |
| Enrollment/payment/receipt/attendance | 0 → 20 | 0 → 20 | Stored-results integration journey passes; manual external-settlement workflow, no provider claim. |
| Financial consistency and retries | 0 → 10 | 0 → 15 | Exact ledger assertions and retry tests pass. |
| Role/tenant privacy and revocation | 0 → 10 | 0 → 15 | HTTP and real socket regressions pass; member privacy boundary fixed. |
| Effective membership rules | 0 → 10 | 0 → 10 | Date and mutation-boundary regressions pass; legacy undated freezes require staff review. |
| Directory + complete critical browser journeys | 0 → 0 | 0 → 0 | 51-member/API/UI pagination proved; full fresh password submission remains unexecuted, so whole row withheld. |
| Optional workout/booking handling | 0 → 5 | 0 → 5 | Explicitly excluded from offering; false QR and unsafe waitlist behavior removed/disabled. No credit for unexecuted full-device offline proof. |
| Engineering gates and app boot | 10 → 10 | 5 → 5 | Clean baseline already passed; final local gates and production smoke pass. |
| Target deployment persistence/recovery | 0 → 0 | 0 → 0 | Local recovery passed; actual hosted restart/redeploy and off-instance restore unknown. Whole row withheld. |
| Operator guide and truthful demo | 0 → 5 | 0 → 0 | Setup, roles, expected stored results, failure/reset checks and timed script supplied. |
| **Total / 100** | **10% → 85%** | **5% → 85%** | **15 points unknown/incomplete in each AFTER score.** |

**Hard gates:** real-member pilot stays NO-GO for unproven target-host persistence/recovery and incomplete human onboarding acceptance, even at 85%. A high score never overrides incorrect money/access/privacy behavior or unusable activation if discovered. Synthetic demo is conditional GO after the human privately completes the activation step, or with that step explicitly labelled prepared/pending; do not advertise it as fully browser-verified.

## Deployment and release boundaries

No live deployment, production data change, force-push, branch deletion or merge to `main` is part of this task. GitHub's read-only deployment records on 22 September refer to historical `agent/demo-deployment` commits, not this candidate; they do not prove what is currently live. The previously guessed Render `/ready` hostname timed out and was never independently established as the actual deployment. Current hosted release identity is unknown.

Blueprint source now explicitly targets `main` and disables automatic deploys, with a Starter persistent disk; applying it is a separate reviewed phase and incurs hosting cost. It does **not** change or prove existing live Render settings. Before phase 3, an operator must confirm the actual service, tracked branch, disk mount/permissions, origins, secrets and backup destination. Migrating from the old temporary DB path requires backup/restore, not merely changing the environment variable. Run migrations before server start; `/ready` must show schema ready. Default startup never seeds real customer records.

Local Docker was unavailable; the pushed candidate's GitHub image job is the container proof. Even green container replacement/volume tests do not certify the real host or the gym's recovery process.

## Four-phase completion plan

This is **four phases for the staffed-gym offering**. It is not a promise to finish every module in the original product PRDs. The full-product roadmap is separate and should follow observed customer needs.

| Phase | Status / concrete exit | Remaining effort and dependencies |
| --- | --- | --- |
| 1. Audit baseline | Complete: ancestry, prior work, baseline checks, reproduced defects and acceptance rubric recorded. | About 0.5 day for the owner/receptionist to review scope and confirm actual gym policies; no implementation expansion. |
| 2. Focused stabilization and verification | Implemented and locally verified; final exact-SHA CI/handoff below. | Human activation browser check plus review/merge decision. Reserve 0.5–1 engineer day if CI/environment-specific issues or operator acceptance reveal defects. |
| 3. Deployment rehearsal and supervised demo | Next: reviewed artifact to isolated persistent environment, fresh staff/member browsers, exact 10–15 minute demo, restart/redeploy and off-instance restore rehearsal. | **2–4 engineer days**, plus **half a day with gym staff**, assuming hosting access, domain/TLS, budget and policies are available. Complete password-recovery procedure and fiscal receipt requirements before pilot; allow 1–3 extra days if a minimal recovery flow is required. |
| 4. Limited real-member pilot | Start only after hard gates green. Suggested 10–25 consenting members, one branch, named receptionist/owner, daily money/attendance reconciliation and backup checks, documented rollback and support contact. | **1–2 calendar weeks of observation**, approximately **2–5 engineer days** of support/fixes plus daily staff participation. Exit: no unexplained balance/access discrepancies, successful restore rehearsal, acceptable operator workflow and incident handling. |

Assumptions: one capable engineer familiar with this tree, supported Node/runtime, cooperative gym operator, manual cash/verified UPI and reception attendance. Hosting approvals, payment-provider procurement, hardware, legal/tax decisions and unavailable people can extend calendar time. These are planning ranges, not delivery guarantees.

**Smallest next phase:** phase 3, after candidate review and the pending manual password check. Do not start integrated payments, doors or advanced modules to make the demo larger. A new feature backlog should separately prioritize account recovery/contact corrections, fiscal receipt requirements, and only then customer-requested booking/workout or integration work.

## Evidence and operator handoff

- [Manual QA, reset procedure and 10–15 minute script](PILOT-TEST-AND-DEMO.md)
- [Account/privacy findings and browser restrictions](account-privacy-stabilization.md)
- [Money/membership rules and remaining limits](money-membership-stabilization.md)
- [Deployment, bootstrap, backup and remote evidence](deployment-stabilization.md)

### Release handoff

Candidate branch: `codex/production-hardening-p0`; [PR #15](https://github.com/amankeshri7542/Shark-Fitness-/pull/15), targeting `main`. Remote reconciliation was a fast-forward from `c9211b7`; no merge, force-push, branch deletion or live deployment was performed.

| Commit | Purpose |
| --- | --- |
| `7085299` | Staffed-gym onboarding, account/privacy, membership, money and reception regressions/fixes. |
| `f932d2b` | Release configuration, recovery/deployment checks, browser rehearsal and operator reports. |
| `35c46fe82cb0721b2632903474282ea4a1298dcc` | CI-discovered recovery process cleanup and unique restored-server identity check. |

[Exact-SHA push CI for `35c46fe`](https://github.com/amankeshri7542/Shark-Fitness-/actions/runs/35764043769) passed both **verify** and **image** on 22 September. It covers fresh migration/seed, backup/restore/authenticated boot, deployment guards, lint, typecheck, all tests, builds, browser smoke, non-root production image without build tooling, and database preservation across replacement containers using a named volume. This is container evidence, not hosted persistence evidence.

The first run on `f932d2b` was cancelled after recovery assertions completed but pnpm's server descendant kept the process alive on Linux. The fix launches the rehearsal API directly under Node. Local retesting exited successfully; a deliberately occupied port returning a different release was rejected. A preliminary local run had reached the leftover browser server, so it is superseded by the unique-release recovery proof. The disposable browser server, Chrome profile process and collision stub were stopped.

The PR-event run on `35c46fe` found two inherited trailing blank lines (`Branches.tsx` and `branch-scope.integration.test.ts`); these were removed in the final handoff change. The complete candidate diff against `origin/main` then passed whitespace checks. The final documentation/whitespace commit must also have green exact-SHA push and PR checks; its SHA and run results are supplied in the task handoff rather than embedding a commit's own hash in its contents.

Local final application evidence remains **1,259 passing tests in 96 files** (API 714, admin 262, member 28, domain 255), successful lint/typecheck/build, and desktop/mobile activation-fragment navigation, existing-account login, pagination and PWA smoke. Activation-password submission remains a **human-only pending acceptance step** because automatic approval review rejected the browser credential action. Do not bypass or count that step as passed. Follow the linked manual QA guide. Readiness scores and real-member NO-GO gates above remain unchanged.
