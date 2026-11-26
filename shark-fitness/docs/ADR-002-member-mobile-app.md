# ADR-002: The member mobile app is an installable PWA, shipped to Android as a Trusted Web Activity

- **Status:** Accepted for this engagement
- **Date:** 2026-11-25
- **Decision owners:** Shark Fitness engineering
- **Supersedes:** the Expo mandate in PRD 02 for the duration of this engagement (see "Revisit triggers")
- **Related:** [ADR-001](ADR-001-runtime.md) (single-process runtime), [MOBILE-APP.md](MOBILE-APP.md) (store and install runbook)

## Context

The client asked for "the mobile app". The requirements describe one:

- PRD 02 "Approved baseline stack" lists *Mobile: React Native + Expo, New
  Architecture*, and PRD 02 §7.3 "Member Mobile Stack" names Expo Router, Expo
  SQLite for the offline outbox, Expo Notifications, SecureStore, Camera,
  Haptics and Video.
- PRD 04's "Architecture and product trade-off register" records the same
  choice (*Mobile framework: React Native + Expo*) with its revisit trigger:
  *"Required capability is blocked or measurable performance fails."*
- PRD 01 §0 and §3.2 describe an installable, offline-capable member app with
  push (PF-COMM-002) and deep links (PRD 03 §5.6), and PRD 04 §18 has a mobile
  launch checklist (device matrix, offline workout, push deep links, permission
  rationale, store disclosures).

What exists is different, and ADR-001 already records why: the product runs as
one Node process serving two Vite single-page apps. The member app is a React 19
PWA with 18 API-backed screens, a 1,300-line offline-first workout logger and an
IndexedDB mutation outbox with idempotent replay. There is no Expo project.

## Decision

The member app is the existing PWA, hardened to app quality and served at
`/app/`:

1. **Installable PWA** with a complete manifest (PNG and maskable icons,
   shortcuts, screenshots), a service worker that keeps the shell and the
   member's last-seen data available offline, Web Push with deep links, and
   install prompts that respect the user.
2. **Android: a Trusted Web Activity** built with Bubblewrap
   (`apps/member-pwa/android/twa-manifest.json`, `.github/workflows/android-twa.yml`)
   and verified by Digital Asset Links (`/.well-known/assetlinks.json`). The TWA
   is a thin native shell around the same `/app/` URL; Play Store listing is
   possible without a second codebase.
3. **iOS: installed from Safari** ("Add to Home Screen"). Web Push works for
   home-screen web apps on iOS 16.4 and later. There is no App Store listing.
4. **Expo is deferred.** No React Native project is created in this engagement.

## Reasons

- **One codebase.** Eighteen working screens and their tests already exist.
  Rebuilding them in Expo would create a second member client that every later
  phase (QR pass, waitlist, payments, messaging) would have to implement twice,
  and would halve the care each client gets.
- **The offline outbox already exists.** PRD 02 §7.3 asks for "persistent
  offline data and mutation outbox"; the PWA has an IndexedDB outbox with
  owner-scoped, idempotent replay, and this ADR's phase adds a persisted
  per-user read cache. Expo SQLite would re-implement both.
- **No device SDK to verify native work here.** The build machine has no
  Android SDK, no Xcode and no devices. An Expo app could only be checked by
  `tsc` and `expo export`, never run. Shipping a native client nobody could run
  is worse than shipping a web client everybody can.
- **Capabilities the product needs today are web-reachable:** offline shell and
  data, push (Android, desktop, iOS 16.4+ installed), haptics through
  `navigator.vibrate` (Android), camera for QR scanning (P05), share sheet,
  app badge, install prompts. The TWA gives a Play Store presence and
  notification delegation to the native layer.

## Consequences

- iOS users install from Safari; there is no App Store presence. iOS has no
  `beforeinstallprompt` and no vibration API, so haptics are Android-only and
  the app shows an instruction sheet instead of an install button.
- Push on iOS requires the app to be installed to the home screen first.
- Background work is limited to what service workers allow: no background
  location, no Bluetooth, no NFC, no HealthKit or Health Connect.
- The Play listing is a TWA. Google Play accepts TWAs that meet its quality
  criteria (Digital Asset Links verified, Lighthouse PWA checks, no broken
  offline launch); see [MOBILE-APP.md](MOBILE-APP.md).
- PRD 04 §18's "real device test matrix" remains a manual acceptance step for
  the client: emulation in CI covers layout, not iOS behaviour.

## Revisit triggers

Move to a native shell when any of these becomes a real requirement:

- **Apple HealthKit or Android Health Connect** import (PRD 02 §7.3 consent
  purpose `health_data`).
- **NFC or wallet passes** for entry (Apple Wallet / Google Wallet).
- **Background location or BLE door hardware** (unstaffed access).
- **App Store listing** demanded by the client or the market.
- PRD 04's own trigger: a required capability is blocked, or measured cold
  start / frame rate on the target mid-range Android fails PRD 04 §11.1 "Mobile".

## Migration path

The UI-free packages are already platform-neutral and would be reused as-is:

- `@shark/contracts` — Zod request/response schemas and enums.
- `@shark/domain` — pure business rules (training maths, unit conversion,
  booking, gamification, money).
- `@shark/design-tokens` — Sonar colour, type and spacing tokens, platform-
  neutral custom properties plus the copy registers.

Two routes, in order of cost:

1. **Capacitor** around the existing PWA build: keeps every screen, adds native
   plugins (HealthKit/Health Connect, NFC, background geolocation, native push)
   behind feature checks. Lowest cost; appropriate for the first two triggers.
2. **Expo / React Native** per PRD 02 §7.3: new screens over the same three
   packages and the same `/v1` API. Appropriate if native performance or the
   App Store review experience becomes the deciding factor.

Either route keeps the API, the outbox contract (idempotency keys) and the push
payload shape (title, body, deep-link path) unchanged.
