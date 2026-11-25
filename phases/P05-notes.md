# P05 notes — QR check-in, safe waitlist, credit packs, private media, progress photos

Branch `phase/P05-member-core-gaps`, from `phase/P02-payments-razorpay` @ 2ffa570. Worktree `/workspace/sf-wt/P05`.

## What exists at the start (read in code)

- `lib/pass-token.ts`: HMAC rotating pass tokens, 30 s windows, batch of 20 issued by `GET /v1/member/pass`; `used_access_windows` burns a window. `services/access.ts#scanSignedPass` is the door decision (signature, tenant/branch reader limits, membership, hours, anti-passback, capacity, outstanding). Only the door route (`/v1/door/scan`, reader keys) calls it. The member Pass screen is a reception ID card and uses `useCopy()` without a surface.
- Waitlist: join/offer/promotion code exists twice (`routes/member/schedule.ts#promoteWaitlist`, `services/schedule.ts#promoteFromWaitlist`) but is gated by `WAITLIST_AVAILABLE=false`; offers do not hold seats; `expire-waitlist-offers` only marks offers expired (no advance). `updateSession` refuses capacity below live bookings. DB guard: trigger `class_sessions_capacity_guard` (`booked > capacity` on UPDATE OF booked) in `db/migrate.ts` extras.
- Credits: `credits` ledger rows (kind, delta, expiresOn), no lots, no FIFO, no sales; `assertRefundableProduct` refuses credit-product refunds; `readCreditAccount` says sales unavailable. Product kinds are `class_pack` and `pt_credits` (the spec's "pt_pack" is the existing `pt_credits`).
- Media: no storage; `progress_photos` table exists with `storage_key`, `visibility`, `consent_given`, `pending`. Consent catalogue already has `progress_photos`.
- E2E harness (`@shark/e2e`, Playwright) is on the branch, so flows get e2e specs.

## Plan (order of work)

1. **Pass + tone** — `useCopy(surface)` enforcement (pass/access surfaces in `PLAIN_ONLY_SURFACES`), QR encoder (pinned `uqr`), Pass states, countdown from server window, auto-rotate, wake lock, branch selector, offline fallback. API: pass accepts `?branchId`, returns per-branch entitlement and the state the UI needs.
2. **Reception scan** — `POST /v1/admin/attendance/scan` (Idempotency-Key, `attendance.check_in` permission, branch scope) through `scanSignedPass` with a staff actor and tenant binding. New decision codes `denied_token_expired`, `denied_wrong_tenant`; "already checked in" outcome for a duplicate scan of a token already admitted (no second row). Floor "Scan pass" panel: BarcodeDetector → lazy `jsqr` fallback, keyboard-wedge/paste input, result panel, override for overridable denials, camera-denied fallback. `Permissions-Policy: camera=(self)` only on `/admin/*`.
3. **Waitlist** — single `services/waitlist.ts` (join, offer with seat hold, accept, decline, expire/advance, capacity increase/no-show release), `WAITLIST_AVAILABLE` removed. Hold = offered entry counted in `class_sessions.booked`; new row-count DB triggers on `bookings` insert and `waitlist_entries` offer so confirmed + live offers can never exceed capacity; the `booked` guard only refuses increases (so a class shrunk below its bookings can still release seats). Capacity reduction below bookings needs `acknowledgeOverbooked` → cancels nothing, withdraws offers that no longer fit, raises a dashboard alert + audit. Settings: `waitlistOfferMinutes` default 30, new `waitlistOfferCutoffMinutes` 60. Member Book offer card with countdown + accept/decline dialog; admin roster shows waitlist + live offers.
4. **Credit packs** — lot-based ledger: grants are lots, debits/restores carry `lot_id`; pure `creditLots()` replay in `@shark/domain` (legacy rows without lot handled). FIFO by earliest expiry; restore with original expiry; append-only trigger on `credits`. Sales: staff assign (`POST /v1/admin/members/:id/credit-packs`), member self-purchase (P02 checkout, or unpaid invoice for reception without a provider). Allocation inside `settleInvoicePayment` when fully paid. Refund matrix in `services/credit-packs.ts`. UI: member Billing credits panel + buy, Book "Uses 1 credit", admin Member detail ledger + sell + refund.
5. **Media** — `MediaStorage` port + local disk adapter (`SHARK_MEDIA_DIR`), `media_objects` table with tombstones, upload route (multipart, 10 MB, magic bytes, metadata strip for JPEG/PNG/WebP in pure TS, 4096 px cap, tenant quota), HMAC signed URLs (≤ 5 min) that re-check authorization at serve time. Backups: tar of the media dir + checksum in the manifest; restore + verify cover it; pilot scripts include it.
6. **Progress photos** — consent (versioned) required; visibility private/coach; compare slider; delete; revoke hides from coaches and schedules deletion (`photoRetentionDaysAfterRevoke`, job); trainer access only when assigned + coach visibility; privacy export lists photos. Client canvas re-encode before upload.
7. **Freestyle workout** — "Log a workout" on Train → exercise picker → same Workout logger/outbox/PR/XP/Summary with no assignment.
8. Docs, e2e specs, PR text.

## Checklist

See `P05-progress.json` (same items).

1. Pass: QR states, tone enforcement, component tests, mobile e2e (rotation + offline member number).
2. Scan API: integration tests for admit-once/already-checked-in, replayed, expired, other-tenant, other-branch-only, suspended, capacity; audit on every decision.
3. Admin scan UI + e2e (text input admit, camera-denied fallback) + `camera=(self)` only under `/admin/`.
4. Waitlist: 20-way race, accept-vs-expiry race, holds never exceed capacity, capacity reduction alert, skip expired member; UI.
5. Credit packs: no credits before full payment; same-transaction allocation (manual + webhook); FIFO; restore keeps expiry; refund matrix; append-only trigger; UI.
6. Media: 413, 422 spoofed, EXIF GPS stripped, expired URL 403, other member 404, trainer matrix, consent revoke, backup/restore round-trip with checksums.
7. Freestyle workout e2e: offline 2 × 3 sets, reload, online → exactly 6 sets once.
8. Component tests for new UI states; plain register on Pass/Billing/refund.
9. Docs (PRODUCTION-READINESS, README offering, .env.example), gates + e2e green, PR text.

## Decisions

(Also copied to the PR.)

- **D1 Pass tokens.** `/v1/member/pass` returns a short run (6) of 30 s single-use codes with `no-store`; the client rotates early (before the window ends) and re-fetches the run. QR via pinned `uqr` (ECC M, 4-module quiet zone), dark on a light panel in both themes.
- **D2 Scan "already checked in".** A valid code from a member already inside (open visit) returns outcome `already_checked_in` with no second check-in row; the code window is still burned. Expired codes return `denied_token_expired` (separate from forged `denied_token_invalid`); a code minted by another tenant returns `denied_wrong_tenant` and names nobody.
- **D3 Decoder.** BarcodeDetector where available, else `jsqr@1.4.0` loaded by dynamic import only when the camera starts.
- **D4 Waitlist hold = seat.** An offer increments `class_sessions.booked`; accept converts without incrementing; decline/expiry/withdrawal decrements and re-offers. DB triggers count live bookings + live offers; the counter guard refuses only increases past capacity (so a shrunk class can still give seats back).
- **D5 Offer timing (decision 12).** Deadline = min(now + `waitlistOfferMinutes` (30), start − `waitlistOfferCutoffMinutes` (60)); both are branch-overridable policies. If less than a minute would remain, no offer is made and the freed seat is open to anyone (members waiting keep their place; first-come after the cut-off).
- **D6 No-show release.** No-shows are marked after class start, which is always past the offer cut-off, so marking a no-show does not create an offer (it would be unusable). Releasing a booking before class from the roster (`releaseBooking`) is the "release" path and does offer the seat. Recorded rather than building a dead path.
- **D7 Skipped members.** A member who is no longer eligible when their turn comes is moved to a new `skipped` state (added to `WaitlistState`), with the reason audited and an in-app note; they can rejoin (back of the line).
- **D8 Capacity reduction.** Allowed below bookings; cancels nobody. Live offers that no longer fit are withdrawn newest-first and those members return to `waiting` at their original position. Remaining excess → audit `session.overbooked`, realtime `alert.raised`, and a derived dashboard alert `overbooked_class` that stays until resolved. Two phase-5 tests that asserted the old refusal / "no offer" behaviour were rewritten to the decided behaviour (requirement change, not weakened).
- **D9 Leaving the line** marks the entry `declined` instead of deleting it (auditable history); rejoining reuses the row (`waitlist_uq`) at the back of the line.

## Integration notes

(What P04/P06/P07 integration must wire up.)
