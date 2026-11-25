# P04 independent review

Branch `phase/P04-member-mobile-app`, reviewed against `phase/P01-prod-readiness` (17 implementation commits, 161 files).
Reviewer: independent session. The review ran across several sessions because of usage-limit interruptions; the earlier fixes are listed with the later ones.

**Verdict: ready for PR, with known issues.** No blockers remain. Six fixes are committed: four major, two minor. The remaining items are minor or are already declared limitations.

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | major | **An unfinished workout carried over to the next person on the phone.** A 401 deliberately keeps `shark.workout*` so the same member can carry on, but the keys were not tied to anyone. The next person to sign in saw the workout and could finish it under their own account. | `e6d39db`: bootstrap clears the workout when the signed-in person differs from the last one on this device. Unit test added. |
| 2 | major | **Offline sign-out left the browser push subscription alive.** The server DELETE and the server sign-out both fail offline, so the push row stayed bound to a still-live session. The previous member's notifications kept arriving on a shared phone. | `421ddb5`: when the server call fails, sign-out unsubscribes the browser locally. The push service then answers 410 and the server deletes its row. Unit test added. |
| 3 | major | **A member's pushes could reach a support operator's browser.** A platform operator impersonating a member could turn push on, and the row was bound to the impersonation session. Delivery checked `revokedAt` and `expiresAt` but not the 60-minute `impersonationExpiresAt`. The operator's browser would then get the member's class, booking, message and payment pushes for the whole session lifetime. | `1398e88`: impersonated sessions get 403 on subscribe, and delivery skips devices registered by an impersonation session. API integration test added; it failed (201) before the fix. |
| 4 | major | **The E2E gate failed at night.** The push spec failed inside the branch's default quiet hours (21:00–08:00 IST, about half of every UTC day in CI): the push was correctly deferred, so it never reached the fake push service. The haptics spec failed outside branch opening hours because the desk refused the check-in. Reproduced: 4 failures in a full `pnpm e2e` at 00:50 IST. | `3f01e21`: each spec sets the branch policy or hours it needs through the owner's settings API and restores them afterwards. Quiet-hours behaviour stays covered by the API push integration tests. The full suite then passed at about 01:15 IST. |
| 5 | minor | The app-icon badge (Badging API) kept the previous member's unread count after sign-out or session end. | `3bbadca`: cleared on sign-out and on session end. Test added. |
| 6 | minor | **The deletion request could skip the wipe.** It revokes every session. A background request that got its 401 before the wipe started ran the session-ended path, which cleared the viewer, so `signOutAndWipe` returned early. The outbox, the workout and the last-owner marker stayed on the phone, and the member saw "Your session ended" instead of the deletion notice. | `ff4acad`: the session counts as leaving from the request on. The flow moved to `lib/session.ts` so it can be tested. Two tests added; the main one was mutation-checked (it fails without the fix). |

## Remaining (not fixed; minor or already declared)
- **Deletion request when it fails.** It turns push off first, while the session can still remove it. If the request itself then fails, the member stays signed in but push is off for this phone (they can turn it back on).
- **Turning push off after the device was already pruned.** If the server already deleted the device (after a 410), "Turn off on this phone" shows an error and leaves the browser subscription in place.
- **Updates with two tabs open.** An update applied in one tab activates the new worker under a second tab, even one with an active workout. That tab does not reload. After a deploy, a lazily loaded screen chunk in it could 404. Rare on phones.
- **Theme on a shared phone.** The device-local theme copy (`shark.member.theme`) belongs to the device, not the person, so the next person's first paint uses the previous person's theme. Cosmetic.
- **`SHARK_PUSH_EXTRA_ENDPOINT_ORIGINS` is not refused in production.** It is an operator-set allow-list, used by the E2E production build for the fake push service. The docs say to leave it empty in production. A production guard would need E2E to opt out explicitly.
- **Already declared in the PR:**
  - `push_deliveries` is not pruned;
  - the APK/AAB was never built (no Android SDK);
  - iOS is untested (the iPhone 13 project is Chromium);
  - no push was sent to a real push service;
  - notification click is unit-tested only;
  - Landscape Workout with an active session has no screenshot.

## Acceptance criteria (re-checked)
1. **ADR-002:** present, with the decision, citations, reasons, revisit triggers and migration path.
2. **Manifest test:** `app-manifests.test.ts` (member-pwa) passes. It checks required fields, icon pixel sizes, maskable, ≥ 2 narrow and ≥ 1 wide screenshots, and the apple-touch-icon.
3. **Service worker on phones:** Pixel 7 and iPhone 13 projects pass. The worker controls `/app/`, an offline reload shows Home with the offline banner, and an update is held during a workout and applied after it.
4. **Sign-out and 401:** the E2E specs pass, plus unit tests, including fixes 1, 2, 5 and 6.
5. **Preferences:** theme with no flash, reduce motion, kg/lb (domain unit tests) and haptics all pass. Haptics is now independent of the time of day.
6. **Reachability:** E2E passes. Notifications is 1 tap from Home; Billing, Library, Messages and Help are 2 taps; Summary has Done.
7. **Responsive:** no sideways scroll or clipped content at 360×800, 390×844, 768×1024 and 1024×768 on every route. Screenshots are in `phases/P04-screens/` (60). I looked at a sample (360 Profile, 1024 Book).
8. **Push:** API integration tests pass:
   - subscribe and unsubscribe;
   - encrypted payload and VAPID headers;
   - 410 removes the device;
   - quiet hours defer;
   - no consent, no send;
   - network guard.

   The E2E UI subscription round trip and fake-service delivery also pass. The new impersonation test is included.
9. **Android:**
   - `assetlinks` returns 404 when unset and correct JSON when set; a malformed fingerprint is refused at boot (`config.test.ts`);
   - the TWA manifest schema test passes;
   - `actionlint` 1.7.7 is clean on `android-twa.yml` and `ci.yml`;
   - the APK was not built locally.
10. **Admin PWA:** the manifest test passes; the console's offline page and the scope separation pass in E2E (`pwa-desktop`).
11. **Budgets:** met.
    - Member precache: 23 entries, 657.80 KiB (budget 700).
    - Initial member JS: 47.94 + 58.39 + 33.90 = 140.23 KB gzip (budget 145.2).
    - Console precache: 566.99 KiB.
12. **Gates:** all green (below).

## Final verification (Node 22.23.5, from `shark-fitness/`, after all fixes)
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm build`: all exit 0.
- `pnpm test`: **1,570 passed, 0 failed**.

  | Package | Tests | Files |
  |---|---|---|
  | contracts | 6 | 1 |
  | domain | 276 | 13 |
  | member-pwa | 79 | 17 |
  | admin-web | 295 | 38 |
  | api | 914 | 67 |

- `pnpm e2e` (all projects): **46 passed, 0 failed** (2.9 min, run at about 01:15 IST, inside quiet hours and outside branch hours).
- Targeted: `playwright test --project=member-pixel7 --project=member-iphone13` on the push and preferences specs: 10/10. `pnpm -F @shark/api test` (push, assetlinks): 914/914.
- `/tmp/actionlint` (v1.7.7) on `android-twa.yml` and `ci.yml`: clean.
