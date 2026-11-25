# P04 — Installable member app (PWA + Android TWA) and staff console PWA

Branch `phase/P04-member-mobile-app` from `phase/P01-prod-readiness` (128aec1).
Working copy: `/workspace/sf-wt/P04`.

## Plan

Order is chosen so every step leaves the app working and committed.

1. **Base path `/app/`** (plan decision 2/4). Vite `base: '/app/'`, router `basepath: '/app'`, manifest/SW scope `/app/`.
   API static serving: `/app/*` member, `/admin/*` console. `/` on this branch is a **placeholder** (P03 owns the
   website): it redirects to `/app/` (the browser keeps `#activationId=…` fragments across the redirect) and
   `/sw.js` is a self-unregistering worker that retires any member worker installed at scope `/`.
2. **ADR-002** (`docs/ADR-002-member-mobile-app.md`).
3. **Icons, manifest, iOS meta**: one SVG source → PNGs via `@resvg/resvg-js` (`pnpm -F @shark/member-pwa icons`).
   Store screenshots captured from the real production build by a committed Playwright script.
4. **Service worker** (injectManifest, TypeScript): precache shell, navigation → precached shell, catch handler →
   `offline.html`, API untouched (network-only), `registerType: 'prompt'` with an update bar that waits for an
   active workout to finish, push + notificationclick handlers. Self-hosted fonts (OFL, latin subset) replace Google
   Fonts for both apps.
5. **Preferences applied**: theme (`data-theme`, inline boot script reads a cached copy so first paint is right),
   reduce motion (`data-motion="reduce"` + system query), haptics (`navigator.vibrate` behind preference + support),
   units (domain `kgToLb`/`lbToKg`/`formatLoad`; storage stays kg). Fix `['viewer']` invalidation (viewer lives in
   zustand) and the plan query-key mismatch.
6. **Offline read state**: TanStack Query persister on IndexedDB (`idb`), key per user, 24 h maxAge, buster =
   build id + schema version, allow-list of query keys (home, training plan, schedule list, profile). Pass, billing,
   realtime tickets never persisted. Offline banner "Offline — showing what was saved at HH:MM".
7. **Session safety**: Profile "Sign out" with unsynced-outbox warning; wipe = query cache + persisted cache +
   this user's outbox + `shark.workout*` + push subscription (server DELETE then `unsubscribe()`). Global 401
   handler: "Your session ended", keep outbox for the same user, return to the original route after sign-in.
   Deletion request signs out locally after the server revokes sessions (copy already says it signs out).
8. **Navigation**: header bell + unread badge → Notifications; Profile "More" (Billing, Library, Messages, Install
   app, Help); Summary Done + Share; `navigator.setAppBadge`.
9. **Responsive**: remove the 428×908 frame; safe areas; tablet column (max 720 px) with two-column Book and
   Progress; landscape Workout; ≥ 44 px touch targets for touched controls.
10. **Web Push (API)**: VAPID config in `lib/config.ts`; migration `push_subscriptions` + `push_deliveries`
    (one file); `GET/POST /v1/me/push-subscriptions`, `DELETE /v1/me/push-subscriptions/:id`; notification
    service `services/notifications.ts` (`notifyUser`: in-app row + push queue) with consent, quiet hours in branch
    timezone (defer), dedupe keys, 404/410 cleanup; sender built on `web-push` request details + `fetch`
    (timeouts, testable, network guard). Wired: class reminder (automation `class.tomorrow`), booking/waitlist
    changes, staff→member messages, payment failed (dunning) + payment succeeded/failed seam for P02.
11. **Push (client)**: rationale screen in Profile/More, permission only after a tap, subscribe/unsubscribe, hidden
    when the server reports push unavailable.
12. **Install UX**: `beforeinstallprompt` captured; "Install app" in More; one-time dismissible banner from the 2nd
    session; iOS Safari instruction sheet; never on first visit.
13. **Android TWA**: `android/twa-manifest.json`, `/.well-known/assetlinks.json` from `SHARK_ANDROID_PACKAGE` +
    `SHARK_ANDROID_CERT_SHA256`, `.github/workflows/android-twa.yml` (dispatch only), `docs/MOBILE-APP.md`.
14. **Admin PWA**: manifest scope `/admin/`, shell-only worker, offline page, scope separation proven in E2E.
15. **E2E**: projects `member-pixel7` and `member-iphone13` (Chromium with device emulation; WebKit not used —
    see decisions), specs for SW/offline, update gating, sign-out/401, preferences, reachability, responsive
    sweep with screenshots, push round-trip, admin PWA.
16. Docs, budgets, PR description.

## Checklist

See `P04-progress.json` (mirrors this list).

1. ADR-002 written.
2. Manifest test (fields, icons + pixel sizes, maskable, screenshots, apple-touch-icon).
3. SW controls `/app/`; offline reload renders Home from persisted cache with banner; update never applied mid-workout.
4. Sign-out wipe + push unsubscribe; 401 → "Your session ended" → same route, outbox intact.
5. Preferences: theme no-flash, reduce motion, units (domain tests), haptics.
6. Reachability ≤ 2 taps; Summary Done.
7. Responsive at 4 viewports, no horizontal scroll, screenshots.
8. Push API tests (subscribe/unsubscribe, fake push service, 410, quiet hours, consent, network guard) + E2E round-trip.
9. assetlinks (404/JSON/boot refusal), twa-manifest schema test, actionlint.
10. Admin manifest + offline page + scope separation.
11. Precache ≤ 700 KiB; initial JS ≤ 145 KB gzip.
12. Standard gates + `pnpm e2e`.

## Decisions and assumptions

(Filled in as work proceeds.)

## Integration notes

(Filled in as work proceeds.)
