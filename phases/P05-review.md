# P05 independent review

Branch `phase/P05-member-core-gaps` (stacked on `phase/P02-payments-razorpay`), reviewed at `b4e0ca2` and fixed through the commits listed below. Reviewer had no part in writing the code.

## Method

- Read the phase spec, PHASE-PLAN, the implementer's notes/progress/PR draft, and the full diff (128 files, ~23k lines, 12.7k of which is the drizzle snapshot).
- Read in full: `services/waitlist.ts`, the booking/claim and capacity-trigger changes, `services/access.ts` (scan path), the scan route, the member pass route/service, and the upload route.
- Three parallel read-only sub-reviews: media + photos + backups (security), credit packs + ledger + refunds (money), and member/admin UI (states, a11y, leaks). Every finding from them that I acted on was re-checked in the code and confirmed with a failing test first.
- Re-ran every gate myself (results at the end). I did not trust the checklist.

## Verdict

**Ready for PR with known issues.** No blockers. Each spec acceptance criterion is implemented and has a real test behind it. The 20-way last-seat race, accept-versus-expiry, DB-level seat guards, the scan denial matrix, the refund matrix, the append-only trigger, media 413/422/GPS/403/404, the trainer matrix and the backup round trip all hold. I found and fixed 8 major and 9 minor issues. The remaining items are minor and listed below.

## Findings and fixes

Severity: **blocker** (must not merge), **major** (a real user, money, privacy or data-integrity failure in a plausible scenario), **minor**.

### Fixed

| # | Sev | Area | Finding | Fix (commit) |
|---|---|---|---|---|
| 1 | major | Waitlist | **Seat counter leak.** A member's offer expired, but the expiry job had not run yet, and they booked a different open seat directly. `claimSeat` then marked the still-`offered` entry `confirmed` without releasing its hold. `class_sessions.booked` stayed one too high for good: the class showed full with a seat free, and the counter no longer matched the trigger's row count. | Only a `waiting` entry converts on a direct booking. A lapsed offer is left for expiry, which releases the seat and passes it on. Regression test added to `waitlist.integration.test.ts`. (`530ec77`) |
| 2 | major | Media / privacy | **EXIF/GPS kept after the scan.** The JPEG cleaner copied everything after the first start-of-scan through to end of file. Anything after end-of-image was therefore stored and served unchanged: a multi-picture JPEG's second EXIF/GPS block, a motion-photo video, or appended data. APPn/COM segments between progressive scans and JFXX thumbnails in APP0 also survived. Direct API uploads bypass the app's canvas re-encode, so the server must guarantee this itself. | The cleaner now parses past the entropy-coded data and drops everything after end-of-image. APP0 is kept only when it is JFIF, and only the first frame header is used. PNG requires IHDR first; WebP uses an allowlist and pads odd chunks. Short headers now give 422 instead of 500. Three new tests. (`d52d428`) |
| 3 | major | Media / DoS | **No streaming body limit.** The 10 MB limit relied on `Content-Length`. A chunked upload has none, so `parseBody()` buffered an unbounded body before the size check. Any member could exhaust the API's memory. | Hono `bodyLimit` on the upload route counts streamed bytes and returns 413. A malformed multipart body is now 422, not 500. Tests for both. (`d52d428`) |
| 4 | major | Backups | **Scratch restore hit the live photos.** `db:restore` used `SHARK_MEDIA_DIR` for any target. Inside the app container, restoring a copy to a scratch path was refused. With `--replace --yes-replace` it deleted and replaced the live photos. | `SHARK_MEDIA_DIR` now applies only when the target is `SHARK_DB`; other targets restore media beside themselves. Asserted in `verify-backup-restore.mjs`. (`4ca1955`) |
| 5 | major | Backups | **Backups broke above 2 GiB.** Archive checksumming and extraction called `readFileSync` on the whole tar. Above 2 GiB that throws, and the catch block then deletes the database backup too. Below that, a restore held the archive in memory twice. | The tar is hashed, verified and extracted in 1 MiB pieces. (`4ca1955`) |
| 6 | major | Credit packs | **Pack eligibility not checked.** Pack sales and the offers list ignored `products.eligibility`, so a member could self-buy a corporate-only, approval-only or age-limited pack. | Membership rules now apply. Corporate and age rules bind everyone. An approval-only pack can be sold at the desk (staff are the approval) but not self-bought. Offers are filtered the same way. Test added. (`6465651`) |
| 7 | major | Reception scan | **Camera left on.** The scan panel never checked, after `getUserMedia` resolved, whether it had been stopped or unmounted. Leaving the Floor, or pressing Stop while the camera started, left the camera on. After Stop the detection loop also ran forever on a hidden element. | A generation counter makes a late start release its stream. The loop submits through a ref, so it uses the current branch. Two tests, both failing on the old code. (`fd71809`, `3c670ab`) |
| 8 | major | Progress photos | **Photos hidden after withdrawal.** After consent was withdrawn, the gallery was replaced by the consent card. The member could not see their photos, the "will be deleted on" notice, or the Delete button the withdrawal dialog promised. The only way back was to agree again, which cancels the deletion. The existing test used a consent state the server never sends. | The gallery stays visible, read-only apart from Delete, under the consent card. Adding and sharing need current consent. The test now uses the real server state. (`0146347`) |
| 9 | minor | Credit packs | A refund `Idempotency-Key` reused on a different pack replayed the first pack's refund. | Now a 409 `IDEMPOTENCY_MISMATCH`. Test added. (`6465651`) |
| 10 | minor | Member app / privacy | The offline exercise library holds the member's own last weights and reps, and survived sign-out, so the next person on the phone saw them. Separately, an offline boot could restore a remembered session for a different user than `/me` had just named. | Both are cleared or checked now. Two store tests. (`b5a1762`) |
| 11 | minor | Train | There was no "Log a workout" on a rest day. | Added. (`b5a1762`) |
| 12 | minor | Book / a11y | The waitlist offer card was an `aria-live` region whose countdown changes every second. | It is no longer a live region. (`b5a1762`) |
| 13 | minor | Media | Files were unlinked inside the caller's transaction. A later failure rolled the row back to live with its bytes already gone. | The unlink waits until the tombstone commits. Rollback test added. (`f5429a4`) |
| 14 | minor | Photos | Sharing with the coach checked only that consent had once been granted, not that it is the current version (upload already did). | Sharing now needs current consent. Test added. (`6323c4d`) |
| 15 | minor | Tests | Wake Lock and the reduced-motion sonar sweep had no tests. | Pass tests added for both. (`97ccd6f`) |
| 16 | minor | Docs | PRODUCTION-READINESS said a restore puts media into `SHARK_MEDIA_DIR`, and that "a row without its file cannot happen". The second is untrue: a deletion between the database snapshot and the media archive leaves exactly that. | Corrected. (`25c097f`) |
| 17 | minor | Tests | **Full API suite failed on a timeout.** `scheduler-observability > marks the automation job failed…` hit vitest's 5 s default in 2 of 4 full runs (5.2–6.5 s). Without P05's test files it takes 0.68 s. Profiling showed `run-automations` working through about 200 expiring-membership recipients across six copies of that automation, at about 3 ms per recipient. The cost depends on how much data earlier suites leave in the shared test database, not on a product defect: about 0.6 s per run is fine for an hourly job. The implementer's "all green" was therefore not reliably reproducible. | Same assertions; the test now has an explicit 30 s timeout with the reason recorded. (`aed39cb`) |

### Remaining (not fixed; recommended follow-ups)

All are minor. None blocks the PR.

- **Credit expiry on a cancelled class (credits).** A booking may spend a credit whose lot expires before the class date. If the gym then cancels the class, the credit is restored to the expired lot, so the member loses it through no fault of their own. Suggested fix: restore gym cancellations as a fresh lot, or spend only lots valid on the class date.
- **Failed then processed refund (credits).** A refund marked `failed` (credits reinstated) that later receives `refund.processed` leaves the member with both the money and the credits. This is a rare provider sequence. `reinstateRevokedCredits` also always sets the pack back to `active`.
- **Voided pack invoice (credits).** The pack stays `pending_payment`.
- **Abandoned purchases (credits).** Abandoned self-purchases leave open invoices. Each tap with a new key makes one. Consider reusing a pending pack for the same product.
- **PT session recording (credits).** The idempotency id is built from the key without a tenant prefix: a cross-tenant collision gives a 500, and a replay with a different member is not checked. The `trainerId` in the body is not validated against the tenant's staff.
- **Legacy shortfall (credits).** A legacy unallocated debit is not subtracted from a pack's refund quote.
- **Restore drill false failure (backups).** A photo deleted between the database snapshot and the media archive makes the restore drill report a missing file. This is now documented; a fix would delay unlinks until after the backup.
- **Re-consent re-shares (photos).** Agreeing again re-shares photos previously marked "coach" without a fresh opt-in. This is a design choice; it should be confirmed with the client.
- **No confirmation for PT session (admin).** "Record a PT session" spends a paid credit in one click, with no confirmation step.
- **PR "How to test" command.** `pnpm -F @shark/api test -- scan waitlist …` runs the whole API suite: the `--` makes vitest ignore the filters. It is a superset, so still valid.

## Acceptance criteria, re-checked

1. **Pass.**
   - Component tests cover every state; the tone test fails on any predator string.
   - The `@mobile` e2e checks that the token rotates before the countdown ends and that offline shows the member number.
   - Wake Lock and reduced-motion tests added in review.
2. **Scan.**
   - Admit once, then "Already checked in" with one row.
   - Each specific denial is tested: replayed, expired, wrong tenant, other branch, suspended, capacity.
   - Every decision is audited, including forged and wrong-tenant codes.
3. **Admin scan.**
   - The e2e admits by text input and shows the camera-denied fallback.
   - Header tests show `camera=(self)` only under `/admin/`.
4. **Waitlist.**
   - Race tests: 20-way race, accept versus expiry ×8.
   - Seat guards: holds never exceed capacity, and DB triggers refuse a bypass.
   - Capacity reduction cancels nobody and raises an alert.
   - A lapsed member is skipped. The stale-offer leak was found and fixed (#1).
5. **Credit packs.**
   - No credits before full payment; allocation in the same transaction on both the desk and webhook paths.
   - FIFO; restore keeps expiry; refund matrix; append-only trigger.
   - Eligibility (#6) added in review.
6. **Media.**
   - 413 (now also for chunked bodies), 422 for spoofed files, GPS stripped (now also after end-of-image).
   - Expired link 403; another member's link 404; trainer matrix.
   - Revoke hides at once; backup round trip with per-file checksums.
7. **Freestyle.** The offline e2e checks exactly 6 sets stored once.
8. **Component states.** Loading, empty, error, permission and offline states are present and tested. The plain register holds on Pass, Billing and refund.
9. **Docs.** Updated, with two inaccuracies corrected (#16). Gates and e2e results: see the final verification below.

## Final verification

Run on branch head `aed39cb` (Node 22.23.5), from `shark-fitness/`.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | **1,801 tests in 151 files, all passing** (contracts 6/1, domain 284/13, member-pwa 131/18, admin-web 328/42, api 1,052/77) |
| `pnpm -F @shark/api db:check-drift` | `migration_drift=none` |
| `pnpm db:backup:verify` | `recoveryProof: passed`; media 2 of 2 files verified against the manifest and against the `media_objects` checksums; tampered archive refused; new scratch-restore media-dir assertions pass |
| `pnpm build` | pass |
| `SHARK_E2E_PORT=18520 SHARK_E2E_RAZORPAY_PORT=18521 pnpm e2e` | **8 of 8 passed**: client-error, console sign-in, member sign-in, reception-scan ×2, freestyle-offline @mobile, member-pass @mobile, member-payments @mobile |
| Production single-origin smoke (port 18530, temp `SHARK_DB` and `SHARK_MEDIA_DIR`) | `/ready` ok; `permissions-policy` is `camera=(self)` on `/admin/` and `/admin/floor`, and `camera=()` on `/`, `/app/` and `/v1/health` |

Before the review the same suite gave 1,783 passed and 1 failed (the scheduler timeout, #17), in 2 of 4 full runs. The 17 new tests (API +10, member +5, admin +2) are regression tests for the fixes above.
