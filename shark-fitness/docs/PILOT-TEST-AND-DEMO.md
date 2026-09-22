# Staffed-gym testing and demonstration

This guide uses synthetic people and test money. It does not authorize a live deployment or real-member launch. The offering is reception-led enrollment, independently verified manual payments, receipts, membership rules and attendance. Physical doors, integrated collection, automated messaging, automatic renewal, waitlists, workouts/offline logging and advanced modules are not part of this demonstration.

## Setup and safe reset

1. Use Node 22 and pnpm 10.28.0. From `shark-fitness/`, install with `pnpm install --frozen-lockfile` if necessary; run `pnpm build`.
2. Set `SHARK_DB` to a new absolute path in a disposable rehearsal directory, for example `/tmp/shark-gym-rehearsal/shark.db`. Keep this variable identical for migration, bootstrap, server and backup commands. Never point test commands at a customer's database. Do **not** run `db:seed` or `db:reset` for the fresh-account rehearsal.
3. Run `pnpm db:migrate`. Prepare the bootstrap JSON described in [deployment-stabilization.md](deployment-stabilization.md), with a new gym slug, owner email and unique password. Run `pnpm db:bootstrap < /secure/path/gym-bootstrap.json`. This is an operator installation step; reception needs no database access afterwards. Protect/remove the JSON after handoff.
4. Start the API with `NODE_ENV=production`, `SHARK_SERVE_STATIC=true`, `SHARK_SEED_DEMO=false`, a random `SHARK_PASS_SECRET` of at least 48 bytes, and `SHARK_ALLOWED_ORIGINS` matching the exact app origin. `pnpm -F @shark/api start` normally listens on 8787. If occupied, set `PORT=8797` and allow that origin. Open `/admin/sign-in` for staff and `/sign-in` for members. `/health` and `/ready` must return success; `/ready` must name the expected release.
5. Sign in as the new owner using the chosen **Gym code**, email and password. Confirm Members and Billing start empty. Configure the branch's real timezone, opening hours, capacity and payment policy before a pilot. The bootstrap defaults to India/INR/metric; this session does not certify other currencies or overnight hours.
6. For a reset, stop only this rehearsal server, close its browser tabs, clear this origin's cookies/site data (including the member service worker and offline queue), and replace only the explicitly disposable rehearsal directory. Create another unique gym or database and bootstrap again. Never delete the normal API `data/` directory, run demo reset on a live database, or reuse real member details. Preserve recovery artifacts you still need to assess.

## Operator checklist

Use a desktop viewport around 1440×900 and a phone viewport around 390×844. Keep staff and member in separate browser profiles to avoid replacing the shared login cookie. Record the exact release, date, role and result for each row.

| Role / navigation / action | Expected screen | Expected saved result / failure case |
| --- | --- | --- |
| Owner → Staff → create receptionist with email and correct branch → staff detail → **Create activation link** | Private one-time link and expiry; expressly says no email/SMS was sent | Invited account and hashed token; no demo password. Non-owner cannot issue a staff link. Privately hand link to the verified person. |
| New receptionist opens link in a separate profile → choose ≥12-character password → **Activate account** | Console opens; later ordinary Gym code/email/password sign-in works | One active account; token used once. Reuse, expired/replaced link, disabled account and wrong token fail. Browser password submission must be completed by the human tester; automatic approval review blocked the agent's browser credential-change step. |
| Owner → Plans → **New product** → create a priced membership with a finite term, explicit freeze/notice rules → **Publish** | Active product, correct tax-inclusive invoice amount shown when assigned | Versioned product exists. Use a supported INR test price, e.g. ₹100 plus configured tax; do not claim automatic recurring collection. |
| Reception → Leads → new walk-in with unique phone **and email** → detail → **Move to contacted** → **Move to qualified** → **Convert to member** | Member profile and number; no trial needs to be fabricated | One user/member, lead becomes won. Repeated conversion refuses a duplicate. Missing/duplicate contacts must be corrected before enrollment. Email is required for password activation. |
| Reception → member detail → **Create activation link** → give to member in person | Member activation link, never “email sent” | Member can activate/sign in to the PWA; cannot open admin Members/Billing or another member's data. Existing password accounts cannot use activation as a reset. |
| Reception → member detail → **Assign plan** | Plan and unpaid invoice visible | Membership stays pending payment. Floor check-in before payment is denied; no granted visit is written. Free plans are intentionally different and not this test. |
| Reception → Billing → invoice → **Record payment** → enter actual received amount, cash or externally verified UPI, UPI transaction reference, check verification acknowledgement → record | Payment and balance update; acknowledgement required | One ledger payment. UPI without reference fails; this screen does not query a bank or collect money. Retrying the same logical request does not record twice. A screenshot from a payer is not independent bank verification. |
| Reception → invoice payment → **Download receipt** | Downloaded readable `.txt` acknowledgement with payment ID, member, gym, invoice, method, amount/date and refunds | Stable receipt ID is the payment ID; no new payment created by downloading. This is not a certified GST tax invoice. Member/anonymous/out-of-branch requests are denied. |
| Reception → Floor → search member name/number → check in → retry immediately → check out | One inside member, then removed after checkout | Exactly one open granted visit; retry returns existing visit. Frozen/cancelled/unpaid members are denied; reception cannot use manager override. |
| Owner/accountant → invoice → partial refund with reason; deliberately retry the same action | One refund, unchanged gross payment, lower net retained amount | Same idempotency key replays; same key with changed amount fails. Example ₹100 invoice, ₹40 paid, ₹10 refunded: ₹60 remains unpaid, ₹30 retained. A refund does not also forgive debt; select entitlement reversal deliberately. |
| Compare directory, member profile, Billing and member PWA with multiple unpaid invoices | Totals agree, including debt older than the displayed 12/24-item histories | Automated fixture verifies 27 invoices. Do not alter a live database to manufacture this case. |
| Owner → member → freeze for allowed days; test early unfreeze and branch-local end date | Frozen before end; eligible state after date only if term permits | A missed scheduler cannot grant expired access; early unfreeze of an expired term stays expired/grace as policy permits. Legacy freezes without end dates require staff review. |
| Owner → member → schedule cancellation with notice; compare before/on effective date, then test immediate cancellation separately | Exact effective date and matching access result | Access lasts through the promised notice boundary and then ends. Immediate cancellation ends now. For date travel use isolated automated tests; do not change production clocks. |
| Reception → Members with 51+ synthetic members → **Next page** / **Previous page** → change search | Member 51 reachable; changing filters starts at page one; page metrics labelled | No repeated/missing IDs when last-visit values tie. API fixture and component test cover this; create bulk fixtures only in rehearsal. |
| Member → Pass | Name/number and **Reception check-in**, explicitly not a QR credential | No door scan is implied; staff still authorize attendance. Offline card says its information may be stale. |
| Full class / waitlist | Waitlists unavailable; contact reception | No new offer or “reserved seat” notification. Existing queue retained for staff review. Do not demonstrate waitlist fairness or automatic promotion. |
| Operator → backup configured database → restore to a different path → migrate/start separately | Restored `/ready`, owner login and representative records agree | Compare members, immutable payments/refunds, attendance and audit rows. Prove off-instance artifact retention and repeat after hosted restart/redeploy before real members. |

## 10–15 minute demonstration

Before the visitor arrives: use the isolated gym above, finish human activation/password checks, prepare owner/reception/member profiles, publish one plan and make a backup. Use only synthetic names and describe all amounts as test ledger records. Do not type secrets while screen sharing.

| Time | Demonstrate |
| --- | --- |
| 0:00–1:00 | State the scope: one staffed gym; reception records real-world money and attendance. Show gym/branch identity and empty/new-account origin. |
| 1:00–3:00 | Reception creates a walk-in lead, marks contacted/qualified, converts to member, opens member profile. Explain that a real trial is optional. |
| 3:00–4:00 | Create member activation link and show the fresh activation form. Human completes password privately, or use the already human-activated synthetic member and explicitly say this one step was prepared. |
| 4:00–6:00 | Assign plan. Show pending invoice and denied unpaid entry. Record synthetic cash once using acknowledgement; show paid state. |
| 6:00–7:00 | Download receipt, show member/invoice/payment identifier and amount; identify it as payment acknowledgement, not certified tax invoicing. |
| 7:00–9:00 | Floor search/check-in, one inside visit, checkout. Show member's accurate plan/balance and reception ID card at phone size. |
| 9:00–11:00 | Search directory; if 51-member fixture is prepared, browse page two. Demonstrate a member being refused an admin route. |
| 11:00–13:00 | Explain scheduled cancellation/freeze dates using a prepared synthetic record; show the audit trail. Optionally show a small refund and unchanged gross payment. |
| 13:00–15:00 | State limitations and recovery rehearsal remaining. Ask the receptionist to repeat the core journey and record friction for phase 3. |

Do not present integrated UPI/card collection, door hardware/QR scanning, waitlist reservation/promotion, automatic renewal, SMS/email delivery, existing-password recovery, imports/bulk editing, credit-pack purchase/expiry accounting, progress-entry, advanced trainer authoring, marketing or platform-wide operations as completed pilot features. Workout/offline replay has code/test evidence, but a full device interruption/resume rehearsal was not performed; omit it from this demo.

## Smallest follow-up

Phase 3 is a deployment and operator rehearsal, not another feature sprint: pass updated remote CI, deploy the exact reviewed artifact to an isolated persistent-volume environment, finish human fresh-account browser checks, run the script above, prove restart/redeploy plus off-instance restore, and agree the fiscal receipt/password-recovery process. Only then consider phase 4's tightly limited real-member pilot.
