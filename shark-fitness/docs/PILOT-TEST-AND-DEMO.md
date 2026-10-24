# Staffed-gym testing and demonstration

## Phase 4/5 continuation — 23 September 2026

Everyday corrections, contact import, owner-supervised recovery, supported renewal and printable acknowledgements now have a separate [acceptance matrix](PHASE-4-5-PROGRESS.md), [operator pack](PILOT-OPERATING-PACK.md) and [local browser rehearsal](phase45-browser-rehearsal.md). Credit sales/allocations and credit-linked refunds remain unavailable pending policy. Use the new artifact identities for new-feature demonstrations; the historical runs below keep their original SHA and limits. Private human activation/recovery, physical-phone and uncoached staff checks remain pending. Phase 3 is not complete and no real-member pilot was run.

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
| Reception → Leads → new walk-in with unique phone **and email** → **Create lead** → open the new lead card → **Move to contacted** → **Move to qualified** → **Convert to member** → **Open … profile** | Member profile and number; no trial needs to be fabricated | One user/member, lead becomes won. Repeated conversion refuses a duplicate. Missing/duplicate contacts must be corrected before enrollment. Email is required for password activation. |
| Reception → member detail → **Create activation link** → give to member in person | Member activation link, never “email sent” | Member can activate/sign in to the PWA; cannot open admin Members/Billing or another member's data. Existing password accounts cannot use activation as a reset. |
| Reception → member detail → **Assign plan** | Plan and unpaid invoice visible | Before assignment, status says **Awaiting plan**; after a priced assignment, **Pending payment**. If the catalogue cannot load, read **Could not load plans** and use **Try again**, rather than assuming no plans exist. Floor check-in before payment is denied; no granted visit is written. Free plans are intentionally different and not this test. |
| Reception → Billing → invoice → **Record payment** → enter actual received amount, cash or externally verified UPI, UPI transaction reference, check verification acknowledgement → record | Payment and balance update; acknowledgement required | One ledger payment. UPI without reference fails; this screen does not query a bank or collect money. Retrying the same logical request does not record twice. A screenshot from a payer is not independent bank verification. |
| Reception → invoice payment → **Download receipt** | Downloaded readable `.txt` acknowledgement with payment ID, member, gym, invoice, method, amount/date and refunds | Stable receipt ID is the payment ID; no new payment created by downloading. This is not a certified GST tax invoice. Member/anonymous/out-of-branch requests are denied. |
| Reception → Floor → search member name/number → check in → retry immediately → check out | One inside member, then removed after checkout | Exactly one open granted visit; retry returns existing visit. Frozen/cancelled/unpaid members are denied; reception cannot use manager override. |
| Owner/accountant → invoice → partial refund with reason; deliberately retry the same action | One refund, unchanged gross payment, lower net retained amount | Same idempotency key replays; same key with changed amount fails. Example ₹100 invoice, ₹40 paid, ₹10 refunded: ₹60 remains unpaid, ₹30 retained. A refund does not also forgive debt; select entitlement reversal deliberately. |
| Compare directory, member profile, Billing and member PWA with multiple unpaid invoices | Totals agree, including debt older than the displayed 12/24-item histories | Automated fixture verifies 27 invoices. Do not alter a live database to manufacture this case. |
| Owner → member → freeze for allowed days; test early unfreeze and branch-local end date | Frozen before end; eligible state after date only if term permits | A missed scheduler cannot grant expired access; early unfreeze of an expired term stays expired/grace as policy permits. Legacy freezes without end dates require staff review. |
| Owner → member → schedule cancellation with notice; compare before/on effective date, then test immediate cancellation separately | Exact effective date and matching access result | Access lasts through the promised notice boundary and then ends. Immediate cancellation ends now. For date travel use isolated automated tests; do not change production clocks. |
| Reception → Members with 51+ synthetic members → **Next page** / **Previous page** → search by member number or a first/last-name part | Member 51 reachable; changing filters starts at page one; page metrics labelled | No repeated/missing IDs when last-visit values tie. API fixture and component test cover this; create bulk fixtures only in rehearsal. |
| Member → Billing | Outstanding principal agrees with reception. Pay at reception instructions replace simulated checkout. | Member cannot create a successful payment; reception records independently received cash or verified external UPI. Refunds lower retained money without writing off principal. |
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

## Private activation and account recovery

Create or replace first-time activation links only after the staff member verifies identity in person. Issuing a replacement invalidates the previous link. The recipient chooses a private password, activates once, then signs out and signs in normally with gym code/email/password in their own browser profile. Test expired/replaced/reused links without exposing their fragments in screen recordings. The previous automatic approval denial of browser password submission remains respected: a human must perform that private step. Prepared synthetic accounts do not satisfy fresh-activation acceptance.

An account that already has a password cannot use first-time activation as password recovery. There is no supported self-service forgotten-password/reset delivery flow in this demo. Do not clear password hashes, directly edit credentials or repurpose activation links to recover such an account. Before a real-member pilot, agree the verified-identity recovery owner and a reviewed recovery procedure; this remains a pre-pilot decision.

## Local browser evidence — 23 September 2026 (Asia/Kolkata)

Two disposable databases were used. The fresh-gym run at `http://localhost:8896` was migrated and bootstrapped without demo seed. A separate, explicitly prepared synthetic fixture at `http://localhost:8897` supplied existing receptionist/member passwords for independent workflow checks. Both servers used production mode with static builds, jobs disabled and separate database paths/secrets. Neither is a hosted deployment, physical-device check, human acceptance or real payment.

| Check | Executed result |
| --- | --- |
| Fresh empty gym and owner | PASS: operator migration/bootstrap, ordinary owner browser login and empty Members directory. No demo members/accounts seeded. |
| Fresh receptionist | PARTIAL: owner invited Synthetic Reception; a separate desktop browser context opened the activation form. Private password submission and subsequent receptionist login await the human tester. |
| Fresh walk-in member | PARTIAL: owner created Synthetic Walkin, moved contacted → qualified, converted once without a trial membership, and opened the member activation form in a separate 390×844 context. Form fit the viewport. Private activation/login await the human tester. |
| Reused/expired/replaced links and forbidden roles | Automated API regression evidence is reported in the stabilization report; fresh human browser rejection/reuse checks remain pending. |
| Shared staff Role field | Found duplicate IDs between directory filter and invitation form. Shared input/select/textarea fallback IDs now use stable unique React IDs; regression failed before (4 unique IDs for 7 controls), then all 10 shared-control tests passed. |
| Reception plan assignment | Found catalogue GET refused reception while assignment was permitted; UI incorrectly called the failed request an empty catalogue. API read permission and visible retry/error handling corrected. PASS after rebuild/restart: reception selected Depot Monthly, created a ₹3,538.82 unpaid invoice and saw Pending payment; unpaid entry was refused. |
| Prepared reception directory and errors | PASS: 55 branch members, 50 rows then 5, member-number search resets to page one. Direct Staff navigation is refused to reception. Network-offline emulation shows the global OFFLINE badge while retaining the last loaded directory; reconnect before trusting a new lookup. Full-name search currently matches separate name columns, so use a name part or member number. |
| New member status | Corrected the misleading Trial label for no-plan walk-ins to Awaiting plan, and unpaid membership status to Pending payment. No stored lifecycle/schema or financial rules changed. Component regression covers both labels and catalogue failure; rebuilt browser verified both statuses. |
| Prepared reception payment / receipt | PASS: Synthetic Desk (`SF-40258`) invoice `inv_0mud261mxqm8c2s`, ₹3,538.82. Required acknowledgement and missing UPI reference disabled submission. Synthetic cash recorded once as `pay_0mud2ajf5q2exna`; exact request retry returned alreadyProcessed, one payment persisted, due ₹0 and membership active. Receipt downloaded and read: ledger receipt, not tax invoice, no independent bank verification. |
| Prepared reception attendance | PASS: unpaid entry denied. Paid entry was also correctly refused outside the seeded branch's daily hours; the disposable rehearsal branch was then explicitly configured for full-day opening. Check-in `chk_0mud2g2d77v6qb3` replay returned the same ID; checkout closed it. Database: one granted visit, one closed granted visit; the separate denial rows remain. No manager override was used. |
| Separate prepared phone member | PASS at 390×844 emulation: existing synthetic **Aman Mehra / SF-40219**, not the newly enrolled Synthetic Desk. Two additional invoice fixtures were ₹100 + ₹250 = ₹350; reception's member detail and member Billing agreed. Billing shows reception settlement instructions and no Pay button. Membership and reception ID rendered correctly; Billing/Pass had no horizontal overflow. Member requests to admin directory and staff receipt returned 403. Offline card explicitly says it may be stale and reception must verify access. |
| Source / restart / production smoke | PASS: both local APIs' `/ready` identify `54877acf08ad99e966e8a17c18b9309d0acdf124`, database/schema/configuration ready, scheduler deliberately disabled. Authenticated reads after restart retained the paid walk-in invoice/member and the separate phone member's ₹350. Fresh-owner production browser smoke passed with a new Chrome profile, member-worker-controlled admin navigation, correct admin asset and no fatal runtime error. |


Local evidence is retained only in disposable operator directories `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-browser-20260923-fh0scuro` and `/var/folders/y1/5qgpl44s7w5_6cx9hmsh969h0000gn/T/shark-prepared-browser-20260923-r53gttl7`. These contain private bootstrap credentials/browser profiles as well as synthetic data; do not commit, upload or screen-share the directories. Activation links are deliberately excluded from this guide. Committed, secret-free details are in [browser evidence](evidence/browser-2026-09-23.json) and the [production smoke log](evidence/browser-smoke-2026-09-23.log). The tested runtime source is `54877acf08ad99e966e8a17c18b9309d0acdf124`; later guide-only commits do not replace this runtime identity. Full integration checks and recovery evidence belong to the dated stabilization report.

## Human repeat and acceptance record

After private activation, ask the receptionist to repeat the core journey without coaching: enroll a different synthetic walk-in, open its profile, assign the plan, recognize unpaid denial, record the acknowledged test payment, download the receipt, check in/out, and compare the member phone view. Give them this guide, then observe rather than explain each button.

| Tester / date / release / browser or physical device | Result | Friction / follow-up owner |
| --- | --- | --- |
| Owner: pending | Private staff/member activation and normal login not yet accepted | Complete privately before screen sharing. |
| Receptionist: pending | Uncoached journey not yet accepted | Record where the tester hesitates or needs help; no sign-off inferred. |
| Member physical phone: pending | No actual-device acceptance | Record device/OS/browser, login, Billing, membership, reception ID and offline notice. |

## Smallest follow-up

Phase 3 is a deployment and operator rehearsal, not another feature sprint: pass updated remote CI, deploy the exact reviewed artifact to an isolated persistent-volume environment, finish human fresh-account browser checks, run the script above, prove restart/redeploy plus off-instance restore, and agree the fiscal receipt/password-recovery process. Only then consider phase 4's tightly limited real-member pilot.
