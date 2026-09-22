# Money and membership stabilization — 20 September 2026

Scope: existing money and membership correctness for one staffed gym. Cash and independently verified UPI are ledger records; no automatic renewal or integrated collection is claimed. Investigate-first and surgical-patch skills guided reproduction before changes; existing integer money, append-only refunds, transactions, authorization and idempotency infrastructure were retained.

## Reproduced failures and fixes

- Scheduled cancellation was not entitled even before the promised effective date, and the scheduler only processed active/grace rows. A domain regression failed before fixing entitlement and effective-date derivation. Cancellation becomes terminal on its branch-local effective date. Reads used by reception attendance, member home/pass/billing, class eligibility, profile and manual renewal reconcile dates, so an absent scheduler cannot preserve expired access. Immediate staff cancellation was also rejected by the old state transition table; it now accepts a reason.
- A timed freeze stored its start and cumulative usage but no end. New migration `0014_membership_freeze_end` persists an end date. The shared reconciliation resumes on that date, evaluates term expiry, updates lifecycle and records a single transition. Repeated reconciliation is a no-op. Existing freezes without an end remain frozen for explicit staff review: their remaining duration cannot be safely inferred. Scheduling cancellation while frozen is explicitly unavailable; staff must unfreeze first or cancel immediately.
- A partially paid invoice with a refund disappeared from debt lists because its state changed to refunded. Other services subtracted refunds again from unpaid principal. Outstanding principal now means `max(total - gross payments, 0)` on nonvoid invoices, independent of display state. A refund is money returned, not a second payment or a credit note cancelling unpaid principal. This consistent rule covers billing, directory/profile, dashboard, member home/pass, attendance/access, support, platform offboarding and dunning. Net revenue remains payments minus refunds. Staff must explicitly reverse entitlement where appropriate; refund alone does not do that.
- Profile balance summed only the latest 12 invoices. Member Billing displayed the first invoice label despite computing a total, and its capped 24-row list could omit old debt. Both now return/use aggregate totals across all invoices; void invoices show zero due. Regression creates 27 synthetic invoices and verifies equal admin/member totals while member history remains capped at 24.
- Retrying a partial refund created a second refund. Reproduced with two identical requests receiving different refund IDs. The existing idempotency helper now replays the first response and rejects a changed payload with the same key. The UI retains the attempt key across retries. Branch authorization is rechecked before serving cached results. API clients must supply `idempotency-key` to obtain retry protection, matching existing optional-key APIs.
- New manual purchases no longer claim auto-renewal; member and staff copy state reception renewal. Existing historical autoRenew values are retained, but no UI promises automatic collection. Manual renewal reconciles effective dates first and creates a new linked membership; its new invoice must be paid.

## Waitlist safety boundary

Confirmed by tracing both promotion functions: they mark entries offered and tell the member a seat is held without reserving capacity. The expiry scheduler expired an offer without advancing the queue. Full reservation accounting is deferred. New joins and both promotion paths are disabled globally, and member booking eligibility no longer offers joining. The Book screen explains this limitation. Existing queue records are retained for staff review, not deleted. A release regression verifies a freed seat does not generate a false offer. Ordinary class booking remains available but is optional and outside the recommended staffed-gym demonstration.

## Evidence actually run

Commands use Node 22.23.2; API tests used `/tmp/shark-money-tests.db`, created by migrations and synthetic demo seeding, never the application database. These fixtures are not evidence of new-account onboarding (the root audit separately tests that journey).

- BEFORE: 3 new domain regressions failed (notice-period entitlement, timed freeze completion, immediate cancellation); 2 financial integration regressions failed (refund debt disappeared, history cap understated balance); repeated-refund regression failed with distinct refund IDs.
- AFTER: full domain suite: **255 passed, 11 files**.
- AFTER: phase3 stabilization suite including money/date/retry cases and the receipt check added by deployment work: **12 passed**.
- AFTER: billing + dunning + reception attendance: **54 passed, 3 files**.
- AFTER: schedule suite with waitlist safety expectation: **23 passed**.
- API, member and admin TypeScript checks passed at component checkpoints. Focused ESLint passed across changed billing/membership/booking source and UI files. `git diff --check` passed. Root agent owns the final whole-workspace gates; later parallel changes may require rerunning them.
- No browser execution was performed by this subtask. No hosted or real bank payment was tested. No production rollout was performed.

Reproduce API checks after creating a separate migrated/seeded DB: set `SHARK_DB`, `SHARK_PASS_SECRET`, and `SHARK_DEMO_READER_KEY`, then run Vitest against `src/__tests__/phase3-stabilization.integration.test.ts`, `billing.integration.test.ts`, `dunning.integration.test.ts`, `phase4-attendance.integration.test.ts`, and `phase5-schedule.integration.test.ts` from `apps/api`. Domain check runs Vitest from `packages/domain`.

## Manual verification additions

1. In an isolated synthetic gym, reception enrolls a member and assigns a plan. Record a partial cash payment actually tendered in the demonstration, then compare invoice due, member profile, member Billing and dashboard totals. Expected saved result: one succeeded payment and matching integer unpaid principal.
2. With an owner/accountant, refund part of that payment; keep the entitlement-reversal choice explicit. Retry the same request with the same key. Expected: one refund row, one refund identifier, unchanged unpaid principal; a changed amount with that key returns conflict. Net receipt reflects the return of money.
3. Add more than 24 synthetic invoices through an isolated fixture, not production SQL. Admin profile and member Billing must agree with the complete ledger, even though their recent-history lists are shorter. Void one invoice; its due and aggregate contribution become zero.
4. Freeze an active membership for the supported minimum. Before its end, attendance/class eligibility deny ordinary access; at the branch-local end date, reconciliation resumes it only if term rules permit. A second reconciliation must not add another transition.
5. Schedule cancellation of an active membership with a positive notice. Access continues until the effective date; then ordinary attendance denies. Immediate cancellation denies immediately. Renew manually only after expiry/cancellation and collect the new invoice before activation.
6. Try a full class: no join-waitlist promise appears; a direct join request explains unavailability. Releasing a seat must not send a message claiming it is reserved for a waiting member.

Reset only by discarding the dedicated test database or synthetic rehearsal environment; never run reset against real member records. Old undated freezes require staff review before any pilot migration. Automatic renewal, invoice credit notes/write-down policy, live payment providers and complete waitlist reservation/expiry accounting remain separate follow-up work.

## Final mutation review

Confirmed active routes reconcile before freeze, unfreeze, cancellation and plan assignment/renewal. Added a regression proving stale active membership cannot be frozen to extend an expired term and does not block reassignment. Found manual unfreeze could persist `active` for an already expired term until a later read: regression failed, then the transaction now reconciles immediately and returns truthful expired/grace copy. Platform archive fixture expected 7,000 from total 10,000, gross paid 2,500 and refund 500; corrected expectation to 7,500 with the same unpaid-principal contract. The synthetic refund list test now filters its own member to avoid interference from accumulated fixtures.

## Independent follow-up review — 22 September 2026

The archive assertion correction was rechecked against actual records: invoice principal 10,000 less succeeded gross payments 2,500 leaves 7,500 unpaid; returning 500 of those payments neither pays another 500 of debt nor silently creates an invoice credit note. Refund revenue and receipt net remain separate. This test retains all archive blockers and checks the exact amount; it was not weakened.

Found and reproduced two missed consumers of this rule. Admin invoice detail hid “Record payment” solely because an invoice displayed `refunded`, despite positive unpaid principal. It now exposes numeric `dueMinor` and uses that for the action. Completing the remaining payment kept a pending membership inactive because activation/dunning termination checked the display state `paid`, which remains `partially_refunded` after a refund. These decisions now use settled principal; explicit entitlement-reversing refunds still leave suspended/cancelled memberships untouched. The regression failed first at the missing amount and then at `pending_payment`, before both fixes.

Also reproduced first profile read returning stale lifecycle after date reconciliation and immediate cancellation leaving member lifecycle active. The profile reloads only when reconciliation changed state; immediate cancellation persists `former` with its membership transition. Assigned-member authorization now precedes reconciliation in the affected handlers.

Isolated database `/tmp/shark-review-sep22-money.db` was freshly migrated/seeded for this review. Financial/date/billing/dunning/platform focused run: **95 passed across 4 files** before the lifecycle addition; phase3 then **14 passed** with the lifecycle regression. API and admin TypeScript, focused ESLint and `git diff --check` passed. No production data or hosted environment was changed.

Confirmed an additional access edge: scheduling cancellation from grace could replace a debt-denied grace state with entitled `cancel_scheduled`. A regression reproduced HTTP 200 where a safe refusal was expected. Scheduled cancellation from grace now returns HTTP 412 with an explicit reception/settlement or immediate-cancellation instruction; immediate cancellation remains available. This deliberately limited pilot path avoids altering notice policy or granting new access. Latest phase3 focused run: **15 passed**. Source mutations stopped for the root final gates.
