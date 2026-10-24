# Pilot operating pack — preparation only

Status: **local synthetic rehearsal only; real-member pilot NOT RUN**. The proposed later pilot is 10–25 consenting members for 1–2 weeks. No participants, dates, staff signatures, feedback or observation period have been supplied. Use the [Phase 5 acceptance matrix](PHASE-4-5-PROGRESS.md), [browser evidence](phase45-browser-rehearsal.md) and [migration/recovery proof](phase45-migration-recovery.md) alongside this pack. The existing strict demo and pilot scores remain **45/100**; this is not a source-completion percentage.

## Responsibilities before a pilot can begin

| Role | Actual person | Responsibility |
|---|---|---|
| Gym owner | Unassigned | Verify sensitive identities, authorize recovery/contact changes and refunds, reconcile discrepancies, decide stop/resume, approve credit and fiscal policy |
| Reception operator | Unassigned | Opening/closing checks, ordinary corrections, import preview, plan/payment/receipt and attendance workflow, incident capture |
| Technical custodian | Unassigned | Exact release identity, approved hosting, persistent storage, off-instance backups/restore, alerts, access suspension and rollback |
| Pilot member tester | Unassigned | Private activation/recovery, own-device usability and balance/access confirmation |
| Owner's fiscal adviser | Unassigned | Decide whether acknowledgements satisfy the gym's fiscal needs; no GST/legal-invoice certification is claimed |

Hosted environment, backup destination, alert destination and operating budget remain unapproved. Do not create them under this local-only authorization. First complete Phase 3's hosted restart/redeploy, off-instance recovery, delivered-alert, private fresh-browser onboarding, physical-phone and uncoached staff gates. New features must pass their own acceptance before inclusion. Credit sales/PT allocation and credit-linked refunds are excluded while policy is undecided.

## Opening the staffed day

1. Reception signs in with their own account in the correct gym and branch. Confirm the branch's business date/time zone, release identity and connectivity. Record operator, branch, date and release below.
2. Technical custodian checks the approved environment's health/readiness and latest retained backup timestamp/checksum, restore proof and alert delivery. A local archive on the same machine is not off-instance protection. Until hosted checks exist, this remains rehearsal.
3. Owner records opening cash float and separately checks the bank/UPI source. Open Billing and Reports for the same branch/date/currency; do not treat an empty result or a permission error as zero money.
4. Check unresolved incidents, unpaid balances and attendance overrides. If an incident meets a stop condition, do not continue affected money/access operations until the owner and custodian resolve it.

## Enrollment, corrections and roster import

1. Search Members by full name, phone/email or member number before creating anything. A duplicate warning is a review task; never change identity simply to evade it or merge records manually.
2. Walk-ins use Leads → contacted → qualified → convert. Ordinary mistakes use Member profile → **Correct details**: name, address, birth date and complete emergency contact. Enter a reason. If another operator changed the profile, reload and compare before resubmitting.
3. Login email/phone changes use **Correct login identity**, performed by the owner after verifying the person and new contact in person and privately re-entering the owner password. This signs the member out and invalidates old credential handoffs. An activated account must retain a login email. Reception cannot perform this action.
4. For a roster, open Members → **Import contacts** and download the template. Work on a copy of the source CSV, maximum 200 contacts and 256 KB per file. Choose the branch, upload, validate, map columns where needed, then validate again. Review every ready/skipped/rejected row and download the row results. Spreadsheet formulas in result cells are neutralized.
5. Correct errors in the source and re-preview. Confirm only the ready rows after checking the branch and mappings. If the connection fails, retry the **same confirmation** until its outcome is known. Repeated confirmation returns the same result; a stale/changed preview must be validated again. Retain import ID, row result and resulting member numbers in the private operator record.
6. Imports create invited contacts only: no paid plan, payment, verified identity, migrated debt or historical balances. The imported-contact notice remains a provenance warning. Reconcile old obligations separately before assigning a plan; do not read the new account's empty ledger as proof of zero historical debt. No-email contacts require an owner-verified email correction before private password activation. No bulk invitations are sent.

## Private activation and existing-account recovery

Use **Account activation** only for a new account without a password. Verify the intended recipient, issue a link, and have that person privately choose a password in a separate browser profile. Sign out and sign in normally afterward using the gym code and email.

For existing accounts use the [owner-supervised recovery procedure](account-recovery.md). The owner verifies identity/reason and privately reauthenticates; the recipient privately chooses the replacement password using the 15-minute single-use link. Owners/platform accounts are outside this recovery path. Confirm old sessions no longer work and the same role, membership and debt remain. Never put passwords, tokens, identity-document numbers or private links in tickets, screenshots, recordings or this pack.

**Human handoff:** automatic approval review previously rejected private browser password submission. The owner and recipient perform these private steps themselves; API/component tests and prepared browser accounts do not complete fresh human onboarding acceptance.

## Plans, payment, receipt and attendance

1. Reception reviews the member's existing term and all unpaid invoices. Assign only the intended published membership. An unpaid term must remain pending and deny ordinary access.
2. For renewal, select **Review renewal**. Review start/end dates, purchased terms, price/fees, branch access, freeze/cancellation terms and existing debt, then explicitly confirm. Only expired/cancelled terms are supported. Pending, active, frozen, grace, suspended and cancellation-scheduled terms show a refusal; do not force them into eligibility. Renewal creates a new invoice and does not collect recurring money.
3. Independently confirm cash/UPI funds, then record that exact amount/method/reference. If a response is lost, retry the same operation and inspect the invoice/payment ID before making another entry. A UI acknowledgement is not independent proof of bank settlement.
4. Open/download the payment acknowledgement; use **Print / PDF** and the browser's print dialog. Verify payment/invoice/member identifiers, currency, amount, method/reference and date. New payment identity is frozen at issuance; older records explicitly say when original identity was not captured. Downloading/printing creates no transaction.
5. Owner-authorized partial refunds record money returned, reason and any separately supported membership consequence. Gross payments remain gross. **Unpaid principal = max(nonvoid invoice total − gross payments, 0)**. Refunds reduce net retained money; they do not pay unpaid principal, recreate consumed credits or serve as a credit note/write-off. Credit-linked refunds are unavailable pending policy.
6. Check in at Reception after access becomes eligible, verify the decision and member number, then check out. Repeated check-in must not create a second open visit. Record any authorized override reason; never bypass a refusal by editing the database.

## Closing and reconciliation

Use existing Reports → Revenue/Attendance, Billing invoices/payment histories, downloaded acknowledgements and Audit. Apply one branch and the same branch-local date range; compare each currency separately and note the report's period/freshness. Revenue invoice-date totals and payment-date method totals may have different populations: use individual transaction identifiers to explain the difference, not an invented balancing entry.

1. Reconcile successful payments by method against independently counted cash and bank/UPI records. Sum gross payments, then list successful refunds separately to reach retained cash. Match payment/refund IDs and references, including refunds of earlier-day payments.
2. Review nonvoid outstanding invoices and the member's aggregate balance. Preserve partial-payment/refund differences. Do not infer debt from a truncated recent-history list or from retained cash.
3. Compare granted/denied attendance, open visits, check-outs and overrides with the desk record. Review duplicate retries and their original IDs.
4. Record every unexplained difference as an open Support ticket/incident with branch, business date, role, release, member/invoice/payment/attendance IDs, expected/actual amount or access decision, safe reproduction steps and request ID. Never hide it with SQL, fabricated payments, automatic refunds or guessed credit adjustments.
5. Owner reviews and signs the private daily record only after real checks. Confirm the closing backup and next custodian handoff. Sign out shared devices.

| Daily record | Value |
|---|---|
| Date / time zone / branch / release | Pending |
| Opening and closing operators / owner review | Pending |
| Opening float / cash received / cash refunded / closing cash / difference | Pending human counts |
| Bank/UPI references / received / refunded / difference | Pending independent bank check |
| Outstanding invoice IDs/total and unexplained differences | Pending |
| Attendance totals / open visits / overrides | Pending |
| Backup identity / custodian / incident IDs / owner sign-off | Pending |

## Stop, support and rollback

Stop affected operations immediately for duplicated/lost money, unexplained balances, unauthorized identity recovery/access, another member's private data, corrupt/missing records, or absent/unrecoverable backups. Record the incident before retrying writes. Owner contains affected accounts/operations; custodian preserves logs and a private snapshot, determines scope and verifies the last known good artifact. No pilot resumes merely because the UI loads.

Rollback is a custodian action under the approved incident procedure: stop writers/jobs, retain the current database and artifacts, restore a verified backup into a separate destination, apply compatible migrations and check financial/audit/history fingerprints before any service switch. Never overwrite newer financial history or run demo seed/reset. Migrations 0015/0016 are additive; an older runtime does not enforce the new recovery/receipt behavior, so do not resume ordinary writes on it without explicit compatibility review. See [migration/recovery evidence](phase45-migration-recovery.md).

## Required acceptance before real participants

The owner/reception tester must repeat the complete demo **without coaching**, including a new receptionist and member privately activating, normal login, typo correction, lost-access recovery, supported renewal, repeated payment, partial refund, receipt and import-error/retry. Test owner, reception and member in separate profiles; on a physical phone record model/OS/browser, PWA installation, login, Billing/Pass, offline notice and return online. Viewport emulation proves layout only. Record observed friction and follow-up owners; do not prefill results or signatures.
