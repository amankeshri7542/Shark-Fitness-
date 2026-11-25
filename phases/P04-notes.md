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

1. **Base path `/app/` done here, with a placeholder root.** The plan puts the member app at `/app/` (decision 4) and P03,
   which owns the move, runs in parallel. This branch makes the move itself (Vite base, router basepath, server routes,
   console-issued activation/recovery links → `/app/sign-in#…`) and serves a clearly marked placeholder at `/`
   (`apps/api/src/lib/root-placeholder.ts`): `/` 302 → `/app/` (fragments survive) and `/sw.js` is a retirement worker
   for the old root-scoped member worker.
2. **Own service worker (injectManifest) and hand-written registration**, not workbox-window: push handlers, offline
   page and the "never during a workout" rule need control, and it keeps the entry bundle small.
3. **Precache budget:** the member precache holds the shell and the offline-useful screens (Home, Train, Workout,
   Summary, Exercise, Book, Profile, Pass, Help, Sign-in); online-only screens (Pack, Challenge, Library, Billing,
   Progress, Notifications, Messages, Conversation, Habits) are cached on first open. 657 KiB of 700.
   Offline, a never-opened screen says it needs a connection instead of reporting a crash.
4. **Fonts:** Anton, Archivo (variable) and Archivo Narrow (variable), latin subsets from Fontsource 5.3.0 (OFL,
   licence in `packages/design-tokens/fonts/OFL.txt`), used by both apps. Glyphs outside latin (₹) fall back to the
   system face, as they would have for the Google latin subset.
5. **Theme without flash:** a tiny inline script in `index.html` reads a device-local copy of theme/motion. Inline is
   deliberate (an external file adds a request on the critical path); P06 must hash it for CSP.
6. **Persisted cache** is our own ~150-line module on `dehydrate`/`hydrate` + `idb` instead of
   `@tanstack/query-persist-client`: per-person partitioning, allow-list and wipe are the point and are simpler to
   guarantee directly. Allow-list: `['home']`, `['training','plan']`, `['schedule',…]`, `['consents']`. Never: pass,
   billing, sessions. 24 h, buster `member-cache-v1`. The viewer and branches are in the snapshot so the app can open
   offline. A 401 deletes the snapshot but keeps the outbox and any active workout.
7. **Units:** conversion on the client with `@shark/domain` helpers (exact pound, grams stored, 5 lb stepper snapping),
   including server-composed strings ("100 kg × 5") via `convertKgText`. The API is unchanged and stores kg.
8. **Push design:** durable `push_deliveries` (dedupe per person + key, quiet-hours deferral with expiry, 3 attempts),
   sending via `web-push`'s request builder + `fetch` with a 10 s timeout (testable, no hidden network). Endpoints must
   be on a browser push service host (SSRF guard); `SHARK_PUSH_EXTRA_ENDPOINT_ORIGINS` exists for local fake services
   only. One consent purpose `push_notifications`, granted by switching push on, withdrawable in Profile. Only devices
   registered by a still-live session receive pushes; re-registering an endpoint moves it to the new person. Message
   pushes say who wrote, never what. web-push pinned at 3.6.7 (typed, mature) rather than the brand-new 4.0.
9. **Categories wired:** class reminder = the existing `class.tomorrow` automation; booking = class cancelled/changed
   and waitlist offers; message = staff support replies and bulk messages; payment = dunning "payment due" and every
   settlement through `recordPayment` ("payment received"), plus `notifyPaymentOutcome` for P02.
10. **Member check-in event:** members never received check-ins (staff-only topic), so the check-in haptic could not
    work; the API now also emits `attendance.checked_in` on the member's own channel. Replayed events (before the hub's
    `subscribed` message) never buzz.
11. **E2E browser:** WebKit cannot be installed here; both phone projects run Chromium (`channel: 'chromium'`, new
    headless; the headless shell refuses notification permission). iOS behaviour is not tested, only iPhone-sized
    layout and an iOS user agent.
12. **E2E rate limits:** the E2E server trusts one proxy hop and each test sends its own `X-Forwarded-For`; production
    limits are unchanged.
13. **Store screenshots** are real captures of the seeded demo from the production build (JPEG, 780×1688 and 1280×800),
    regenerated by `pnpm -F @shark/e2e store-screenshots`.
14. **TWA:** package id placeholder `in.sharkfitness.member`, host placeholder `app.sharkfitness.example` replaced by the
    workflow input. Keystore generated in the job (spec); docs explain moving to a permanent upload key.
15. **Console worker:** precaches shell assets only (not `index.html`), pages always network-first with the offline
    page as fallback, `skipWaiting` but no `clients.claim`, and its inline legacy-worker script no longer reloads when
    the console's own worker takes over.
16. **Dependencies added:** `@resvg/resvg-js` (dev, icon rendering), `workbox-precaching/routing/core` (dev, worker
    build), `fake-indexeddb` (dev, real IndexedDB semantics in unit tests), `web-push` + `@types/web-push` (API),
    `vite-plugin-pwa` + workbox (admin, dev). Nothing else.
17. Tests changed (not weakened): the client-error E2E route moved to `/app/train` and the member sign-in E2E expects
    `/app/`; the admin recovery-link test now asserts the `/app/` prefix; partial `../api` mocks in two member unit
    tests now spread the real module (the store imports more of it).

## Integration notes

- **P03 (website, base path):** this branch already moved the member app to `/app/`. When merging, keep one version of
  the `server.ts` static block; delete `apps/api/src/lib/root-placeholder.ts` and its `mountRootPlaceholder` call once
  the website serves `/` and its own retiring `/sw.js`. Activation/recovery links built in the console
  (`AccountActivation.tsx`, `AccountRecovery.tsx`) already use `/app/sign-in#…`. `e2e/support/demo.ts`,
  `scripts/admin-browser-smoke.mjs` and `ci.yml` use `/app/` paths. The router now preserves the URL fragment when it
  redirects to sign-in, which P03's legacy-fragment forwarding relies on.
- **P02 (payments):** call `notifyPaymentOutcome({ tenantId, userId, branchId, invoiceId, invoiceNumber, amountMinor,
  currency, outcome: 'succeeded' | 'failed', attemptRef })` from `apps/api/src/services/notifications.ts` on
  `payment.failed` (attemptRef = provider payment id). Settlement through `recordPayment` in `services/billing.ts`
  already sends "Payment received" (dedupe per paymentId), so a provider settlement through the same path needs
  nothing more. It is safe inside `transact()`.
- **P06 (CSP):** the member `index.html` has one inline script (theme/motion boot) and the console `index.html` its
  existing legacy-worker script, edited here; both need hashes. Fonts are now same-origin (no Google Fonts in either
  app). Workers: `/app/sw.js` (scope `/app/`), `/admin/sw.js` (scope `/admin/`), retirement `/sw.js`; `worker-src
  'self'`. Push goes server → push service, nothing extra in the browser's `connect-src`. Manifests at
  `/app/manifest.webmanifest`, `/admin/manifest.webmanifest`. The member app's 401 handling (`lib/store.ts expire()`,
  `api.ts onSessionExpired`) is the one P06 keeps.
- **P05:** pushes for waitlist offers already go through `notifyUser` (category booking, expiresAt = offer expiry);
  new waitlist/credit notifications should do the same. The Pass header now has safe areas; its title copy is still
  predator register (P05/P11). The pass query is never persisted offline.
- **P07:** `services/notifications.ts` is the seam for the NotificationService: `notifyUser` writes in-app and push;
  add email/SMS/WhatsApp channels there. The `push` channel's consent purpose map is `CATEGORY_PURPOSE`.
- **Migration** `0018_push_notifications.sql` (push_subscriptions, push_deliveries) may need renumbering after P02/P03
  merges; regenerate the snapshot with drizzle-kit rather than editing SQL. `seed-tables.ts` lists both tables.
- **P08 E2E** already added for P04 flows (see `e2e/README.md`). Not covered: notification click → deep link in a real
  browser (unit-tested via `deepLinkUrl`), landscape Workout with an active session (layout checked at 1024×768 only on
  the rest-day screen).
- Pre-existing, not fixed here: `ci.yml` image-smoke step has a shellcheck SC2251 info (`! head … | grep`) that
  `actionlint -shellcheck` reports.
