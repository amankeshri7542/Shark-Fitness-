# Phase 4/5 local browser rehearsal — 2026-09-23

This is synthetic preparation for one staffed gym. It does not establish fresh onboarding, a real-member pilot, hosted readiness, physical-phone acceptance or uncoached staff acceptance. Prepared owner, reception and member accounts used separate Chrome profiles. No private activation or recovery password was submitted.

## Artifact and execution identity

- Final implementation/runtime: `b9da05ce7c6290ecac07b3f6437b1d3d64eb9a37`, branch `codex/phase-4-5-gym-operations`.
- Production static assets and API served locally at `http://localhost:8898`; Node `22.23.2`. Jobs disabled, automatic demo seeding disabled after explicit fixture preparation. Earlier Phase 2/3 databases/ports were untouched.
- After restarting with the exact commit label, `/ready` reported database, schema and configuration ready and the same release SHA. Corrected details, 55 imported contacts and the pending renewal remained present. Served JS/CSS hashes matched the final build.
- Sanitized evidence: [phase45-browser-2026-09-23.json](evidence/phase45-browser-2026-09-23.json). Full local artifacts are in `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-phase45-browser-6mmov1gd`: `shark.db`, `final-dist-hashes.json`, `production-smoke.log`, `roster-results.csv`, `phone-billing-fixed.png`, `printable-receipt.png` and `payment-receipt.pdf`. Credentials and browser profiles remain private and untracked.

Admin workflows first ran on `c3d26f6318529deff99608331f936130589050dc`. The final commit changes the member realtime subscription lifecycle; admin/API behavior is unchanged. Final production smoke, served-asset identity and persisted-state checks ran after the final restart.

## Observed acceptance

| Workflow | Observed result |
| --- | --- |
| Reception correction and lookup | Corrected a synthetic member's name through **Correct details**. Stored version advanced; email/phone stayed unchanged. Member-number and corrected full-name searches found the profile. An injected HTTP 409 displayed a stale-profile error and made no write; successful submission then saved. Real stale-version/authorization cases are covered by integration tests, not represented as browser concurrency here. |
| Role separation | Reception had ordinary correction but no owner login-identity or recovery controls. Owner saw the recovery form, and **Create recovery link** remained disabled with its private inputs incomplete. No sensitive reauthentication was submitted. |
| Roster preview and retry | A 57-row CSV produced **55 ready, 1 skipped, 1 rejected**. Preview left the branch count at 23; confirmation required its checkbox. The first commit reached the server but its response was deliberately dropped. Retrying unchanged used the same key/body and returned the same import ID. Final count was 78, with no duplicate members. |
| Imported contacts | Downloaded the 57-row result report, opened the directory beyond row 50 and found an imported member by full name. Its profile explicitly disclosed that historical balances/memberships were not imported; no membership existed. Private activation remains pending. |
| Manual renewal | Owner cancelled a separate synthetic active term through **Cancel plan**. Reception reviewed the supported renewal and explicitly confirmed it. A lost-response retry used the same key/body and returned the same result. Read-only persisted verification found the original cancelled term, one linked pending-payment term and exactly one new invoice (`SF-2026-00108`, ₹3,538.82 unpaid principal). No automatic collection or paid access was implied. Active renewal separately showed **Renewal unavailable** with confirmation disabled. |
| Printable acknowledgement | Downloaded a succeeded payment record and opened **Print / PDF**. Generated and visually inspected the readable local receipt/PDF. It included stable receipt/invoice IDs, INR, payment date, amount, method/reference, gross payments, refunds, net retained and unpaid principal. Invoice/payment API data was unchanged afterward. The legacy receipt honestly identified missing issuance-identity capture and did not claim tax-invoice certification. |
| Member phone viewport | At 390×844, reception's correction appeared live in the member profile. Billing matched the admin's ₹0 outstanding balance and showed credit balances/history access, PT consumption unavailability and the pending credit-sale policy boundary. This was viewport emulation, not a physical phone. |
| Production smoke | The repository smoke passed: fresh member sign-in route, display-only activation-fragment navigation, active member service worker, admin runtime under that worker and phone directory layout. No private password activation was submitted. |

The rehearsal found and fixed a real PWA defect. On `c3d26f6`, a profile event replaced the viewer object, restarted realtime and replayed the same event. A three-second probe observed 213 `/me` responses, 212 realtime-ticket responses and 174 Billing responses before rate limiting. On `b9da05c`, the correction → live profile → Billing journey completed with 7 `/me`, 3 ticket and 1 Billing response in total, and no 429. The earlier failure is retained as before-fix evidence and is superseded by the passing journey.

## Exact human handoff

Use the [pilot operating pack](PILOT-OPERATING-PACK.md), [existing-account recovery procedure](account-recovery.md) and [fresh-gym test guide](PILOT-TEST-AND-DEMO.md). Keep the prepared-account rehearsal separate from these unfinished gates.

1. In a fresh empty gym, privately create the initial owner and walk through enrollment, correction, plan assignment, unpaid access denial, independently acknowledged manual payment, receipt and attendance. A human must perform previously blocked private password submissions.
2. Import a synthetic roster using **Members → Import contacts**, inspect ready/skipped/rejected rows and branch, then confirm. For an eligible imported account, verify identity, issue first-time activation and let its intended recipient privately activate. A contact without activation identity must remain clearly unactivated.
3. For an eligible existing account, the owner verifies the person in person, enters a recovery reason and verification acknowledgement, then privately reauthenticates. Privately hand the short-lived link to the recipient; the recipient alone sets the new password. Verify old sessions are revoked and role, membership and balance are unchanged. Both private submissions remain human-only under the prior approval-review denial; the display-only rehearsal made zero recovery submissions.
4. Run payment/repeated-request/partial-refund reconciliation using the operating pack, comparing ledger gross payments, refunds, retained cash and unpaid principal with human bank/cash confirmation. This new browser rehearsal did not repeat the earlier payment/refund browser scenario; current integration evidence and historical Phase 2/3 browser evidence remain separately identified.
5. Repeat correction, supported renewal, receipt and member Billing on an actual phone with the assigned owner/reception operating without coaching. Record real failures and decisions; do not invent signatures, participants or elapsed observation.

Hosted persistence/redeploy, off-instance recovery and delivered alerts remain Phase 3 gates. Hosting/spend and a real pilot remain unauthorized. Credit sales and unsupported PT/refund policy decisions remain deferred. The operating pack is prepared; an actual 10–25-member pilot over 1–2 weeks has not begun.
