# Shark Fitness — build plan (discovery pass, 23 Nov 2026)

Lead engineer's plan for taking Shark Fitness from "beta-ready staffed-gym demo" to a complete, tested, audited product for the client (Aman). Written after reading all five PRDs, `shark-fitness/docs/PRODUCTION-READINESS.md`, `shark-fitness/docs/STABILIZATION-2026-09-20.md`, `PHASE-4-5-PROGRESS.md`, `ADR-001-runtime.md`, `DESIGN.md`, `context.md`, the prototype folder and the PR #27 diff. Everything under "Current state" was checked in code or by running commands on this box. Nothing in the repository was modified by this pass.

Each `## Phase Pxx` section below is written to be handed, on its own, to a fresh Claude Code session working on branch `phase/<id>-<slug>` stacked on the previous phase (P01 stacks on PR #27's branch `claude/musing-wilbur-d67503`). Inside phase sections only `###` and smaller headings are used.

| ID | Slug | Title | Depends on |
|---|---|---|---|
| P01 | prod-readiness | Finish pilot hosting (PR #27) and production readiness | PR #27 branch |
| P02 | payments-razorpay | Razorpay payments in test mode | P01 |
| P03 | public-website | Public website, public API and lead capture | P02 |
| P04 | member-mobile-app | Installable member app (PWA + Android TWA) and staff console PWA | P03 |
| P05 | member-core-gaps | QR check-in, safe waitlist, credit packs, private media and progress photos | P02, P04 |
| P06 | staff-security | Staff security: MFA, step-up auth, sessions, CSP, outbound webhooks | P05 |
| P07 | engagement-ops-modules | Messaging channels, member messaging, community moderation, tasks, coaching, broadcasts | P06 |
| P08 | test-suite | Full test pass: route coverage, critical scenarios, Playwright E2E for every app | P07 |
| P09 | code-review | Code review and fixes: security, correctness, performance, consistency | P08 |
| P10 | ux-audit | UI/UX and accessibility audit of every app (findings report) | P09 |
| P11 | ux-fixes | Implement the UI/UX audit fixes and gate accessibility in CI | P10 |
| P12 | release-handover | Release candidate verification and client handover | P11 |

## Current state

### Repository and history

- Monorepo `shark-fitness/` (pnpm 10.28 workspaces, TypeScript 5.7 strict, ESLint 10, Vitest 3): `apps/api`, `apps/admin-web`, `apps/member-pwa`, `packages/contracts`, `packages/domain`, `packages/design-tokens`, `scripts/`, `infrastructure/migrations/` (0000–0017). 120 commits on `main`; HEAD `386daaa` (PR #26). Root: Dockerfile (non-root, ships pnpm), `docker-entrypoint.sh` (migrate on start, seed only when `SHARK_SEED_DEMO=true` and the DB is new), `render.yaml` (free disposable demo, DB in `/tmp`), `.github/workflows/ci.yml`.
- Release posture recorded in the repo (README, STABILIZATION report, PRD 05 header): **supervised one-staffed-gym demo; real-member pilot NO-GO** until hosted persistence/off-instance restore and human acceptance are proven. Several features were deliberately switched off during stabilization: online payment, waitlist joins/offers, the QR pass, credit-pack sales.
- Runtime per ADR-001: single Node 22 process, Hono 4.6 on `@hono/node-server` run with `tsx`, SQLite via `better-sqlite3` 11.8 + Drizzle 0.38 (WAL, FK on, busy_timeout), in-process WebSocket hub with a durable SQLite outbox (7-day replay), 10 in-process `setInterval` jobs with durable `job_runs`. The PRD's Cloudflare Workers/D1/Durable Objects/Expo stack is **not** used; ADR-001 records that deviation.
- **Node version:** the repo pins Node 22 (`.node-version`, `engines`, `.npmrc engine-strict=true`). On this box's default Node 24.22.1, `pnpm install` fails with `ERR_PNPM_UNSUPPORTED_ENGINE`. With engine-strict overridden it still fails, because `better-sqlite3@11.8.1` has no Node 24 prebuild and node-gyp cannot build it here. All results below were produced with Node 22.23.5 downloaded to `/home/box/opt/node22` (see "Environment bootstrap").

### Baseline results (commands run in `shark-fitness/`, Node 22.23.5, pnpm 10.28.0)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm typecheck` | pass, all 6 packages, 0 errors |
| `pnpm lint` | pass (`eslint . --max-warnings=0`) |
| `pnpm test` | pass, **1,427 tests in 119 files**: domain 271/12 files, API 829/60 files (real SQLite file `apps/api/data/test/shark.db`, migrated + seeded per run), admin-web 291/37 files, member-pwa 36/10 files |
| `pnpm build` | pass. Member PWA: initial JS ≈ 132 KB gzip (index 40.5 + react-vendor 58.4 + tanstack-vendor 33.4), precache 26 entries / 589 KiB. Admin: initial JS ≈ 134 KB gzip, largest route chunk Store 16.4 KB gzip. API "build" is `tsc --noEmit` |

PR #27 CI on GitHub: `verify` pass, `image` pass, `stack` pass (real Docker, Caddy, systemd on an Ubuntu runner).

### API (`apps/api`): real, broad, deliberately fail-closed where unfinished

- 35 route files, about 291 unique method+path pairs under `/v1` plus `/health` and `/ready`. Areas: auth (password, OTP via MSG91/Twilio/Resend/log, activation, recovery), door scan, me (profile, preferences, consents, sessions, notifications, data export, deletion request), platform (tenants, health, impersonation), member (home, pass, schedule, training, progress, habits, engagement, messages, billing, media), admin (dashboard, members + operations + bulk + CSV roster import, leads, billing + stabilization, attendance, schedule + series, training, staff + commission, store/POS, facility, reports, settings, support, automations, engagement, privacy).
- Conventions that later phases must keep (PRD 05 §3): handlers are thin adapters over `services/*` and `@shark/domain`; `validate()`; `requirePermission`; `branchScope(ctx)`; detail reads go through `load*InScope` and return 404 rather than 403; mutations run in `transact()` with `audit()` and `emit()`; `runIdempotently` with `Idempotency-Key`; integer minor-unit money; append-only ledgers enforced by triggers; branch-timezone dates via `lib/branch-time.ts`.
- 105 tables across 8 schema files. Two seeded tenants: Shark Fitness (gym code `shark`; branches `br_kor`, `br_ind`, `br_hsr`; demo password `shark1234` for owner@/manager@/reception@/rehan@/nikhil@/priya@/accounts@sharkfitness.in, members aman@ and rohit@) and Reef Athletic (`owner@reefathletic.in`, trial) for isolation tests.
- Security: opaque hashed session cookie (`shark_session`, HttpOnly), CSRF double-submit + Origin check, CORS allowlist, scrypt passwords, in-memory rate limits (IP/tenant/actor/route), headers nosniff/XFO DENY/Referrer/Permissions-Policy (`camera=()`)/COOP/CORP/HSTS-in-prod. **No Content-Security-Policy.** No MFA, no passkeys, no step-up auth.
- Boot-time config: `lib/config.ts` Zod schema validates about 30 vars with production rules: DB path required, pass secret ≥48 bytes, HTTPS origins, OTP echo and bearer auth refused. **Not validated:** the 12 OTP-provider vars read in `services/otp-delivery.ts` and the 3 OTP-limit vars in `lib/otp-limits.ts`.
- Error reporting: `lib/error-reporting.ts` POSTs `{name, message}` (redacted, **no stack**) to `SHARK_ERROR_REPORTING_ENDPOINT`, otherwise no-op. There are no `unhandledRejection`/`uncaughtException` handlers and no front-end error capture. No metrics.
- Payments: `lib/payment-provider.ts` is a **synchronous** port whose resolver always returns null. Member `checkout-intent` endpoints and admin `webhooks/demo` throw (412) by design. Staff record cash/card/UPI manually with idempotency, GST tax invoices and receipts. Dunning only sends in-app messages and records `no_payment_provider_configured`. `provider_events` exists and is unused. `verifySignature` (HMAC) exists and is unused.
- Notifications: only OTP reaches real channels. Automations and dunning suppress every non-in-app channel ("No … delivery provider is configured"). No web push. No object storage: `SHARK_MEDIA_BUCKET` is rejected and the progress-photo table has no upload path. Media is a catalogue with `playbackUrl: null`.
- Waitlist: `WAITLIST_AVAILABLE = false` (`services/booking.ts:2`). Credit products: balances and history only; sales, allocation and refunds unavailable pending a policy decision.
- Defects found: `routes/admin/billing-stabilization.ts` (mounted first) shadows four handlers in `routes/admin/billing.ts`, and `auth-stabilization.ts` shadows `POST /auth/otp/verify` in `auth.ts`, so those handlers are dead. Service functions are duplicated (`billing-membership.ts` vs `billing-stabilization.ts`). **Migration metadata drift:** `drizzle.config.ts` lists 5 of 8 schema files and snapshots stop at 0013 while the journal reaches 0017, so the next `drizzle-kit generate` would produce a wrong diff.
- Tests: 60 integration files run through `app.request` against a real migrated and seeded SQLite file. They cover isolation, scope, auth, CSRF, rate limits, billing, dunning, tax invoices, staffed-gym journey, phases 4–13, timezones, privacy, scheduler and health.

### Admin console (`apps/admin-web`, served at `/admin/`)

- React 19, TanStack Router 1.97 (code routes, lazy screens, URL-validated search params), TanStack Query 5, Zustand, Tailwind v4 + `@shark/design-tokens` (Sonar: dark default, light theme, comfortable/compact density). 21 screens, all wired to the API, none stubbed: Sign-in (incl. activation/recovery fragments), Command Center (occupancy trace), Leads + Lead detail, Members (URL filters, paging, bulk tag/trainer/message/export, CSV roster import) + Member detail, Plans, Billing, Floor (desk check-in), Schedule (day grid + series), Training + builder, Staff + detail + commission, Store (register/inventory/orders/transfers/insights), Equipment, Automations, Reports (5), Support (queue/feedback/retention), Settings (business/branches/privacy/setup), Platform (tenants/health, impersonation banner).
- Gaps vs PRD navigation (PRD 01 §3.1): no Nutrition & Habits, Community, Marketing or Tasks modules. No single "add member" form; members arrive by lead conversion or import. The command palette only jumps between modules (no member/invoice/command search, no listbox semantics). `StatusStrip`'s `alertCount` is never passed. No toasts.
- UX/a11y issues seen in code: `foam-35` text (≈2.7–2.9:1) and `foam-25` (≈2.0:1) used widely at 9–10 px; no skip link and no `<main>` landmark; some unlabeled checkboxes/inputs; only two `<form>` elements, so Enter rarely submits; Floor "Close all visits" uses `window.prompt`; four disagreeing `money()` helpers and mixed date locales; no global 401/session-expiry handling and no idle timeout; no route-level role guard (screens render `PermissionState` instead); dev-only copy ("Is it running on :8787?") in the sign-in offline error. Not installable (no manifest or service worker).
- Tests: 37 files / 291 tests, heavy on Store, Support and Reports. No tests for Command Center, Leads list, Plans, Billing, Schedule/Series, Staff/StaffDetail/Commission, Equipment, TrainingBuilder, Platform, Settings Branches/Privacy/Setup, or Automations Templates/Runs. **No end-to-end tests anywhere in the monorepo.** `scripts/admin-browser-smoke.mjs` is a CDP smoke used in CI.

### Member app (`apps/member-pwa`, served at `/`)

- React 19 PWA (Vite 6 + vite-plugin-pwa 0.21, Workbox generateSW `autoUpdate`), TanStack Router/Query, Zustand, idb outbox. 18 screens, all API-backed: Sign-in (password/OTP/activation/recovery), Home, Pass, Train, Exercise, Workout (1,326-line offline-first set logger), Summary, Book, Progress, Habits, Pack (community/challenges), Challenge, Messages, Conversation, Billing, Library, Profile, Notifications.
- PWA readiness is weak. The manifest has one SVG icon (`any maskable`), no PNG 192/512, no apple-touch-icon, no `id`/`scope`/shortcuts/screenshots. API data is never cached, so after an offline reload only an in-progress Workout and Summary work. No web push. No TWA/Capacitor/Expo artifacts.
- Functional gaps and bugs: **no sign-out button**, and `signOut` would not clear `shark.workout*` storage. Saved preferences are not applied: theme is hard-coded dark in `index.html`, haptics/reduce-motion/units are ignored. Notifications and Library are unreachable, and Billing is only reachable from a server card. Summary is a dead end in standalone mode. Members cannot start a message thread or log a workout without a plan. Conflicting query keys for the plan (`['plan']`, `['training','plan']`, invalidating `['train']`). Book's drop-in "Pay ₹X" and cancel have no confirmation. Outbox `conflict` entries count in the badge and cannot be cleared. The app renders inside a fixed 428×908 phone frame at ≥520 px, including tablets. The Pass is a reception ID card (the fake QR was removed in stabilization) and uses predator copy on an access surface, against `PLAIN_ONLY_SURFACES` policy.
- Accessibility: `<Link><Button>` nesting; `Segmented` uses `role="tablist"` for radio choices; Book waitlist dialog has no focus trap; route changes do not move focus; several controls are under 44 px (36 px small buttons, 32 px avatar, body-map hit areas of 12–17 px).
- Tests: 10 files / 36 tests (api, outbox, realtime, session hint, store, SignIn, Book, Billing, Pack, Pass). Workout, Home, Habits, Conversation, Profile, Train and Progress are untested.

### Prototype (`Shark-inspired member app prototype/`)

v1 and v2 `.dc.html` and `android-frame.jsx` (device chrome only). v2 defines the Sonar direction already extracted into `docs/DESIGN.md`: abyss `#04080b`, cyan `#46c8dd`, Anton/Archivo, zero radius, zero shadow, hairline seams. Every prototype screen has a code equivalent, except the **rotating QR pass with scan accepted/denied feedback** (removed during stabilization) and the PR celebration moment (reduced to a list). `uploads/` holds copies of PRDs 01–04 only.

### Public website and native mobile

- **No public/marketing website and no public API.** Every route is authenticated except auth, door (reader keys), health and readiness. There is no public lead form or trial booking endpoint.
- **No native mobile app** of any kind.

### PR #27 (open, branch `claude/musing-wilbur-d67503`, one commit `654e2ac` on top of current `main`)

Adds `deploy/pilot/`, which runs the existing Dockerfile on one DigitalOcean droplet (BLR1) behind Caddy (HTTPS), with SQLite on the host disk. It includes `provision.sh`, `deploy.sh` (pre-deploy backup and `/ready` release check), `bootstrap.sh`, `backup.sh` with a systemd nightly timer (`pnpm db:backup`, restore probe, prune after success, healthchecks.io ping), `restore-drill.sh` (synthetic proof, then restore into a network-less container, `/ready`, owner sign-in), `pull-backup.sh` (manual off-server copy to the owner's Mac) and `shark.env.example`. It also adds `docs/PILOT-HOSTING.md` (alerts via UptimeRobot/healthchecks.io/ntfy) and `.github/workflows/pilot-stack.yml`. Known gaps the PR itself names: no automated off-server/off-site backup (losing the droplet loses everything since the last manual pull), and hosted checks are pending because no server exists. Backups are unencrypted copies, and only SQLite is backed up (there is no media yet).

### Orchestration notes found on this box

`/workspace/shark-fitness-orchestration/runner.py` starts P01 from `claude/musing-wilbur-d67503` and stacks each phase on the previous branch. The implementation template tells sessions the box is Node 24, so every phase below begins with the Node 22 bootstrap. The runner's own `checks()` runs `pnpm` with the box default Node and will report FAIL unless `/home/box/opt/node22/bin` is first on its PATH.

## Gaps vs PRDs

Production and operations
- Off-site backup is a manual pull; there is no encryption at rest for backup copies; PR #27 is unmerged; no restore drill has run on a real host (PRD 02 §11.2 "Disaster recovery exercise", "Data retention implementation"; PRD 04 ENT-BCP-004, ENT-DATA-004; PRODUCTION-READINESS §1–2).
- Boot-time validation misses the OTP provider and limit variables, and nothing enforces that every env var is declared (PRD 02 Phase 0 prompt "environment validation"; PRODUCTION-READINESS §12).
- Error reporting has no stack traces, no process-level crash handlers, no front-end capture and no standard DSN-based provider (PRD 02 §11.4 "Error monitoring"; PRD 04 §11.4; PRODUCTION-READINESS §9).
- No metrics or alert definitions (PRD 02 §11.4 "Latency and failure metrics by route", "Queue depth"; PRD 04 "Service levels").
- No Content-Security-Policy (PRD 04 §10.1).
- Drizzle config and snapshot drift will break the next generated migration (PRD 02 "Migration rules").

Payments
- No payment provider: no checkout, webhooks, provider refunds, payment links or reconciliation (PRD 01 PF-BILL-002/003/004/006, §4.6 "India-ready requirements: Razorpay adapter … UPI payment-link support"; PRD 02 "Payments" and Phase 3; PRD 04 §10.4, PCI DSS row). Recurring mandates and UPI Autopay are also absent (PF-BILL-005, §4.6). Stripe adapter absent (PRD 01 §4.6 "Global-ready").

Public website and acquisition
- No public website, no public lead form, no QR campaign links, no trial booking (PRD 01 PF-CRM-001, §4.3 "Lead capture"; PRD 02 §7.2 "public marketing site is separate"; PRD 04 trade-off register "Admin framework" revisit trigger).

Member mobile app
- PRD mandates React Native + Expo (PRD 02 "Approved baseline stack", §7.3; PRD 01 §0.1). The repo ships a PWA under ADR-001 without a store-distributable package (PRD 04 §18 "Mobile" checklist).
- No push notifications (PRD 01 PF-COMM-002, §4.15; PRD 03 §5.6 "Notifications deep-link to the exact object").
- No offline read state for Home/Pass (PRD 01 §1.4 principle 4, §6.4; PRD 03 UX-M02 "offline cached" state).
- No sign-out; preferences not applied (PRD 03 "Haptics … allow preference control", "Reduced-motion support", "Dynamic type").
- Fixed phone frame on tablets (PRD 03 "Mobile test matrix", "Responsive").
- Admin console not installable (PRD 02 §7.2 "PWA support for installability and offline shell").

Member features switched off or missing
- Dynamic rotating QR pass and reception scanning (PRD 01 PF-ATT-001/005, §4.7 "Dynamic QR requirements", §6.2; PRD 03 UX-M03, UX-A08; scenario 2).
- Waitlist joins/offers disabled (PF-SCH-002/003, §6.3, Booking/Waitlist state machines; scenario 3; PRD 02 §14.2 "Concurrent last-seat booking").
- Credit/class-pack sales, allocation and refunds unavailable (PF-CAT-001/004/005; PRD 02 §14.2 "Refund with partial membership consumption").
- No private media storage and no progress-photo upload (PF-PROG-004/006; PRD 02 "Media"; PRD 04 ENT-PRIV-005, "Progress photo metadata reveals location" edge case).
- No freestyle workout without a plan (PF-WORK-004, §4.10 "Member workout execution").
- Members cannot start a conversation; no attachments (PF-COMM-001; PRD 03 UX-M12).
- Community: comments are count-only; no moderation console (PF-GAME-005; PRD 03 UX-M11; PRD 04 "Community and communication" edge cases).
- Video playback not provided (PF-MEDIA-001…006): deferred, see Decisions.

Staff security and integrations
- No MFA for owners/platform admins (PRD 04 ENT-IAM-001, §10.1; PRD 02 "Authentication", "Identity rules").
- No step-up authentication for refunds, exports, role changes, deletion or impersonation (PRD 01 §2.4; PRD 02 "Authorization sequence" step 6).
- No session idle/expiry handling in either SPA (PRD 02 "Identity rules"; PRD 03 "Feedback and status").
- No outbound webhooks (PF-INT-003; PRD 01 §4.23 "Webhook events"). No public API credentials (PF-INT-002).
- Non-in-app notification channels suppressed for automations/dunning; delivery attempts not recorded per channel (PF-COMM-002/005).
- Passkeys, SSO/SCIM and the custom role editor are absent (PRD 02 "Authentication"; ENT-IAM-002; PRD 01 §2.2 "Custom Role"): deferred, see Decisions.

Admin operations modules
- PRD navigation modules missing: Tasks, Nutrition & Habits (coach view), Community (moderation), Marketing (broadcast with cost preview) (PRD 01 §3.1, PF-DASH-005 "member-risk tasks", PF-SUP-004, PF-NUTR-002/003, PF-COMM-006; PRD 03 §3.1).
- Global search and command palette do not find members, leads, invoices, classes or staff, and offer no actions (PRD 01 §4.2 "Command palette supports actions…"; PRD 03 "Navigation — Global search").
- No quick "add member" for walk-ins (PRD 01 §4.4 "Member operations: Add"; PRD 03 UX-A04).

Testing
- No Playwright/E2E (PRD 02 §7.2, §14.1, CI step 10). No automated accessibility tests (PRD 02 Phase 0 acceptance "Accessibility baseline tests run in CI"). No load test for check-in/booking concurrency (PRD 02 §14.1). Many screens untested. PRD 01 "Product-level acceptance scenarios" are not mapped to tests.

UI/UX and accessibility (to be confirmed and extended by P10)
- Text contrast below WCAG AA in both themes (PRD 03 "Accessibility and inclusive design"; WCAG 1.4.3). Missing landmarks and skip link (2.4.1). Palette without combobox semantics (4.1.2). Unlabeled controls (1.3.1). Targets under 44 px on the member app (PRD 03 "Spacing and density"; WCAG 2.5.8). Inconsistent money/date formatting (PRD 02 §11.5). Predator copy on the Pass (PRD 03 "Content design"; DESIGN.md "Voice"). Dead ends and unreachable screens (PRD 03 §5.6). Nested interactive elements. No focus management on route change.

## Decisions and assumptions

Technology
1. **Keep the ADR-001 runtime** (single Node 22 process, Hono, SQLite, in-process realtime and jobs). Migrating to Cloudflare Workers/D1/Durable Objects is a rewrite with no benefit at one-gym scale and would invalidate 1,400 tests. ADR-001 already documents this exit path. Multi-instance scaling stays out of scope.
2. **Member mobile app = the existing PWA, hardened to app quality, served at `/app/`, distributed on Android through a Trusted Web Activity (Bubblewrap), and installable on iOS from Safari (web push works for home-screen apps on iOS 16.4+).** This is recorded as ADR-002 in P04, superseding the Expo mandate for this engagement. Why: 18 working screens with an offline outbox already exist; rebuilding them in Expo would create a second member client to maintain and halve the quality of both; this box has no Android/iOS SDK, so an Expo app could only be verified by typecheck and `expo export` and never on a device. Revisit triggers (named in ADR-002): HealthKit/Health Connect, NFC/wallet passes, background location or BLE door hardware, or App Store distribution. At that point use Capacitor or Expo on top of the same `@shark/contracts`/`@shark/domain`/`@shark/design-tokens`.
3. **Staff use the responsive admin console made installable as a PWA** (PRD 01 §3.3: trainers use the dashboard; there is no third app).
4. **Public website = Astro (static output) in `apps/website`, served by the same API process at `/`.** The member app moves to `/app/` and the admin stays at `/admin/` (single origin, so PR #27's Caddy setup is unchanged). Astro was chosen over Next.js: PRD 02 §7.2 only says a marketing site "can use Next.js later", and a static, near-zero-JS content site gives the best Lighthouse/SEO results with no extra server.
5. **Payments = Razorpay (PRD 01 §4.6, PRD 02 stack table), test mode only.** Live `rzp_live_` keys are refused by config in every environment for this engagement. There is one Razorpay account per deployment, read from env (the pilot is one gym); per-tenant encrypted credentials are a later enterprise item. Stripe gets an interface/ADR only. The manual cash/UPI recording path stays. Recurring mandates (UPI Autopay/eMandate) are deferred.
6. **Error reporting is provider-agnostic.** It offers `console` (development default), `none` (test default, and production without config), the existing JSON `http` endpoint, and a Sentry-protocol provider configured by `SHARK_ERROR_DSN`, implemented with `fetch` and no vendor SDK. Any Sentry-compatible collector (Sentry, GlitchTip, self-hosted) works.
7. **Off-site backups are optional and encrypted:** `rclone` remote plus `age` recipient, both via env, disabled by default. No bucket or credentials are created. CI exercises it against an rclone `local` remote.
8. **"Integration tests against a real database" means the product's real database:** a migrated, seeded SQLite file per run (already the pattern). PostgreSQL is not used by the product and is not introduced.
9. **E2E = Playwright** in a new `shark-fitness/e2e` workspace package (created in P01, expanded in P08). It runs against the production single-origin build and a temporary SQLite database, never `apps/api/data/shark.db`, which PHASE-4-5-PROGRESS notes is polluted.
10. **Notifications:** every channel (email, SMS, WhatsApp, push) defaults to a `log` driver that records what would have been sent and reports it truthfully as "logged, not delivered". Real drivers exist behind env vars and are tested only against local fake servers. Nothing in this plan sends a real message.

Product policies decided without the client (each must also be recorded in code comments/docs by the phase that implements it)
11. **Credit packs:** credits are allocated only when the pack's invoice is fully paid (verified provider payment or acknowledged manual payment), in the settlement transaction. Consumption is earliest-expiry first. A cancellation inside the policy window restores the credit with its original expiry; late cancellation or no-show forfeits per product policy. Refunds: a wholly unused, unexpired pack is refunded in full and its credits revoked atomically; a partially used pack refunds unused credits × unit price only, with `billing.refund` permission and a reason; expired credits are not refundable. This resolves the question PHASE-4-5-PROGRESS left open.
12. **Waitlist:** FIFO. A cancellation offers the seat to the first eligible WAITING member and holds it until the earlier of 30 minutes or 60 minutes before class start (tenant default, configurable). Accepting re-checks membership, branch entitlement and credits. Expiry or decline moves to the next member. Holds count against capacity; capacity is never exceeded.
13. **QR pass:** the existing HMAC rotating token (`lib/pass-token.ts`, single-use windows) is rendered as a real QR code. Reception scans it with the console camera or a USB keyboard-wedge scanner. Offline fallback: the member number, with reception manual check-in. No physical door hardware; the offline door eligibility cache stays deferred, as PRODUCTION-READINESS §8 requires for unstaffed sites.
14. **Website content:** the seeded gym (Shark Fitness, Bengaluru: Koramangala, Indiranagar, HSR) is the default tenant via `SHARK_SITE_TENANT=shark`. Copy is written by us in the brand voice. There is no real photography, so the design relies on the Sonar graphic language and placeholder image slots are documented. Privacy notice and terms are marked **draft, requires counsel review** (PRD 04 "Compliance posture").
15. **MFA:** TOTP plus hashed recovery codes, mandatory for owner, regional manager and platform roles, optional per tenant for other staff, off for members. Passkeys are deferred (a library-backed WebAuthn rollout and its recovery UX deserve their own phase).
16. **Minors (PRD 04 ENT-CHILD-001/003):** direct staff↔minor message threads are refused unless the tenant enables them; no public community profile for minors.
17. **Language:** English only. Formatting is centralized (INR, `en-IN` grouping, branch timezone) so i18n stays structurally possible (PRD 02 §11.5).
18. **Release posture stays honest.** No phase may claim hosted, human or device acceptance it did not perform. PR #27's hosted checks and the real-member pilot remain operator actions outside this plan (no deploys, no spending).

Deferred PRD scope (not planned in this engagement; P12 records each in the traceability matrix with a reason)
- Cloudflare Workers/D1/Durable Objects runtime and multi-instance scaling (ADR-001).
- Expo/React Native native app, Apple HealthKit/Android Health Connect, NFC/wallet passes (ADR-002 triggers).
- Live streaming and on-demand video playback through a managed provider (PF-MEDIA): needs a paid provider account.
- Generative AI assistance (PF-AI-002…006): needs a provider, keys, quotas and an evaluation set. The deterministic adaptive engine already exists.
- SSO/SCIM (ENT-IAM-002), passkeys, the custom role/permission editor, public API credentials/OAuth (PF-INT-002), franchise royalty exports, Stripe implementation, recurring mandates/UPI Autopay, access-control hardware adapters.
- Legal/compliance programs (DPDP counsel review, SOC 2/ISO 27001, penetration test by an independent firm): organizational, not code.

## Environment bootstrap and conventions (every phase)

```bash
# Node 22 is mandatory: better-sqlite3 11.8 has no Node 24 build and shark-fitness/.npmrc sets engine-strict=true.
test -x /home/box/opt/node22/bin/node || { V=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys;print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v22.")))'); mkdir -p /home/box/opt/node22 && curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz | tar -xJ -C /home/box/opt/node22 --strip-components=1; }
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack && corepack enable --install-directory /home/box/opt/node22/bin pnpm
node -v   # must print v22.x; shell state does not persist, so repeat the export line in every new shell command
```

- Standard gates, from `shark-fitness/`: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` (after adding a dependency, run `pnpm install` once to update the lockfile). From P01 on, also `pnpm e2e`.
- Never pipe `pnpm test` through `tail`. Redirect to a file and read every package's "Test Files" line (PRD 05 §5).
- Always run the API against an explicit temporary `SHARK_DB`. Never use or reset `apps/api/data/shark.db`.
- Production single-origin smoke (PRD 05 §5): `pnpm build`, then from `apps/api`: `NODE_ENV=production PORT=8788 SHARK_SERVE_STATIC=true SHARK_DB=$TMP/shark.db SHARK_ALLOWED_ORIGINS=http://localhost:8788 SHARK_PUBLIC_ORIGIN=http://localhost:8788 SHARK_PASS_SECRET=$(openssl rand -base64 48) pnpm start` after `SHARK_DB=$TMP/shark.db pnpm -F @shark/api migrate && SHARK_DB=$TMP/shark.db pnpm -F @shark/api seed`.
- Demo sign-in: gym code `shark`, `owner@sharkfitness.in` / `shark1234` (staff), `aman@sharkfitness.in` / `shark1234` (member). Second tenant: `owner@reefathletic.in`.
- Follow PRD 05 §3 conventions (thin handlers, `validate`, `requirePermission`, `branchScope`, `load*InScope` → 404, `transact` + `audit` + `emit`, idempotency keys, integer money, additive forward-only migrations generated with drizzle-kit, never editing an applied migration). Follow Design PRD 03 and `docs/DESIGN.md` (Sonar) for every pixel, and the plain copy register on payment, access, injury, support, safety and privacy surfaces (`PLAIN_ONLY_SURFACES`).
- Playwright's Chromium may already be cached in `~/.cache/ms-playwright` and `/usr/bin/google-chrome` exists. Otherwise run `pnpm -F @shark/e2e exec playwright install chromium`.

## Phase P01: Finish pilot hosting (PR #27) and production readiness

### Goal
Turn PR #27 into a merge-ready pilot hosting package with automated, encrypted off-site backups. Close the remaining production-readiness items: complete boot-time env validation, real error reporting (server and both front ends), metrics and alert definitions, and the migration-metadata drift that would break the next migration. Lay the Playwright E2E foundation every later phase uses.

### Why
PRODUCTION-READINESS.md names backups, env validation and error reporting as blockers. PR #27 solved hosting and nightly backups but leaves off-site copies manual and unencrypted. Every later phase adds migrations (P02, P04, P05, P06, P07), and the current drizzle snapshot drift would make the first of them generate a wrong diff. Every later UI phase needs an E2E harness to prove its flows.

### Scope
In:
- Branch starts from `claude/musing-wilbur-d67503` (PR #27; `main` is its ancestor). Review its scripts and docs; fix any defects found.
- `deploy/pilot/backup.sh`: optional off-site step. When `SHARK_BACKUP_OFFSITE_REMOTE` (an rclone `remote:path`) and `SHARK_BACKUP_AGE_RECIPIENT` (an `age` public key) are both set, encrypt the `.db` and `.manifest.json` with `age` and upload them with `rclone copy`. Off-site retention (`SHARK_BACKUP_OFFSITE_KEEP_DAYS`) is pruned only after a successful upload. Upload failure pings `/fail` and keeps local copies. When unset it prints `offsite=skipped`. `provision.sh` installs `rclone` and `age` (Ubuntu 24.04 packages). `restore-drill.sh` gains `--from-offsite <object>`, which downloads, decrypts with an identity file given by path (`--age-identity`), verifies the manifest and runs the normal drill. `pilot-stack.yml` exercises upload and drill against an rclone `local` remote with a throwaway key generated in the job and adds the new paths to its triggers. `docs/PILOT-HOSTING.md` documents setup, key custody (private key never on the server), and the retention consequence for anonymized data (PRD 02 "Backups and logs must follow the same deletion/retention commitments").
- `lib/config.ts`: declare and validate every env var the API reads, including `SHARK_OTP_*`, `SHARK_MSG91_*`, `SHARK_TWILIO_*`, `SHARK_RESEND_API_KEY`, `SHARK_OTP_EMAIL_FROM`, the OTP limit vars and the new vars below. Providers selected without credentials are refused at boot. `services/otp-delivery.ts` and `lib/otp-limits.ts` read from `runtimeConfig` only.
- Error reporting: providers `console`, `none`, `http` (existing) and `sentry` (`SHARK_ERROR_DSN`, Sentry envelope protocol over `fetch`, no SDK; release from `SHARK_RELEASE`, environment, request id, route, tenant/actor ids only; redacted message and stack frames). Selection: `SHARK_ERROR_REPORTER` = `auto|none|console|http|sentry`, where `auto` means DSN, then endpoint, then console in development, otherwise none. Add `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers (capture, flush with a 2 s cap, exit non-zero for uncaught). Capture scheduler job failures with the job name. The boot log names the active reporter.
- Client errors: `POST /v1/client-errors` (no auth required; Origin must be an allowed origin; JSON ≤ 8 KB validated by Zod; rate-limited 30/min/IP and 300/min/tenant; redacted; forwarded with `source: admin|member`). Both SPAs register `error`/`unhandledrejection` listeners and a top-level React error boundary. The boundary shows a recovery screen in the plain register ("Something went wrong. Reload" plus a reference id) and reports once per error fingerprint per session.
- Metrics: `GET /metrics` in Prometheus text format, enabled only when `SHARK_METRICS_TOKEN` is set (bearer; 404 otherwise). Expose `http_requests_total{method,route,status}` with normalized route templates, `http_request_duration_seconds` histogram, `job_runs_total{job,outcome}`, `job_last_success_timestamp_seconds{job}`, `outbox_undelivered_events`, `sqlite_db_size_bytes`, and process CPU/memory. No ids or PII in labels. New `docs/OPERATIONS-ALERTS.md`: concrete alert rules (5xx rate, `/ready` failing, job stale/failing, backup missed, disk > 80 %) mapped to PR #27's UptimeRobot/healthchecks.io/ntfy setup.
- Migration metadata: add the three missing schema files to `apps/api/drizzle.config.ts`, then produce a correct latest snapshot so `drizzle-kit generate` reports no changes. Never edit applied SQL. Add a CI step that fails if `drizzle-kit generate` against a temp DB would create a migration.
- E2E foundation: new workspace package `shark-fitness/e2e` (`@shark/e2e`, Playwright pinned) with root scripts `pnpm e2e` and `pnpm e2e:ui`. Global setup creates a temp dir and SQLite DB, migrates and seeds the demo, and starts the API in production single-origin mode on a free port with test-only secrets (requires a prior `pnpm build`; fail with a clear message if dist is missing). Teardown stops it and deletes the temp dir. First specs: owner signs in to the console and sees Command Center; member signs in and sees Home; a forced client error renders the recovery screen and reaches `/v1/client-errors`. Add a CI job `e2e` in `ci.yml` after build (cache browsers, upload the report and traces on failure).
- Update `.env.example` (placeholders only), `PRODUCTION-READINESS.md` (§1–2 backups, §9 observability, §12 config) and `README.md`.

Out: creating any server, bucket, DSN project or alert account; running `deploy.sh`/`provision.sh` against real hosts; CSP (P06); payments (P02); media backup (P05 extends the backup script when media exists).

### Acceptance criteria
1. The phase branch contains PR #27's commit `654e2ac` and all PR #27 files. `shellcheck -S warning deploy/pilot/*.sh` reports nothing (use a pinned shellcheck binary from GitHub releases into `/tmp` if not installed). `bash -n` passes for every script.
2. With both off-site vars unset, `backup.sh` output contains `offsite=skipped` and behaves exactly as before. With them set (CI: rclone `local` remote and a generated age key), the remote holds `*.db.age` and `*.manifest.json.age`, and `restore-drill.sh --from-offsite … --age-identity …` prints `drill=passed`. A forced upload failure (unreachable remote) keeps the local copy and calls the `/fail` ping. These flows are scripted as steps in `pilot-stack.yml`.
3. A unit test fails if any file under `apps/api/src` (excluding tests) reads `process.env` outside `lib/config.ts`, and if any schema key is missing from `shark-fitness/.env.example`. Config tests cover: OTP provider selected without credentials refused; non-numeric OTP limits refused; unknown reporter name refused; `SHARK_ERROR_DSN` malformed or non-HTTPS in production refused; `SHARK_METRICS_TOKEN` shorter than 32 chars refused in production.
4. Sentry provider test: a local HTTP server receives one envelope per captured error with the correct DSN-derived URL and auth header, a stack with ≥ 1 frame, `release`, `environment`, and `request_id`. A test asserts that no email, phone number, cookie, password or request body appears in the payload, using the existing redaction fixtures. Console and none providers are tested.
5. Throwing inside a scheduler job results in exactly one capture tagged with that job and a `job_runs` row with outcome failure. An unhandled rejection in a test child process is captured and logged.
6. `POST /v1/client-errors` accepts a valid payload (204) and rejects oversize (413), invalid (422), disallowed Origin (403) and rate-exceeded (429) requests, each covered by an integration test. In both SPAs a component test proves the error boundary renders the recovery screen and posts once per fingerprint.
7. `GET /metrics` returns 404 without the token, 401 with a wrong token, and 200 text/plain with the listed metric families with it. A test asserts that no `ten_`, `usr_`, `mem_` or `br_` ids appear as label values on HTTP metrics.
8. `apps/api/drizzle.config.ts` lists all 8 schema files. `pnpm -F @shark/api exec drizzle-kit generate` against a temp DB writes no migration ("No schema changes"). `git diff <base> -- shark-fitness/infrastructure/migrations/*.sql` is empty. The new CI step exists.
9. `pnpm e2e` (after `pnpm build`) runs 3 specs green, twice in a row, leaves no server process or temp DB behind, and never touches `apps/api/data/shark.db`.
10. Docs updated as listed, with placeholders only. The standard gates pass.

### How to verify
```bash
# Node 22 bootstrap (see "Environment bootstrap" in PHASE-PLAN.md), then in every shell:
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p01-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p01-test.log
pnpm build && pnpm e2e && pnpm e2e        # two consecutive green runs
pnpm -F @shark/api test -- config error-reporting client-errors metrics   # focused suites
cd .. && /tmp/shellcheck -S warning deploy/pilot/*.sh && for f in deploy/pilot/*.sh; do bash -n "$f"; done
cd shark-fitness/apps/api && SHARK_DB=$(mktemp -d)/s.db pnpm exec drizzle-kit generate   # expect "No schema changes"
git -C /workspace/shark-fitness-repo diff origin/claude/musing-wilbur-d67503 -- shark-fitness/infrastructure/migrations/ --stat   # only meta/ snapshot files
```
Passing looks like: all gates green with counts ≥ the baseline (1,427 tests), e2e 3/3 twice, shellcheck silent, drizzle "No schema changes". The off-site backup flow can only run in GitHub's `pilot-stack` job (no Docker here). State that in the PR and do not claim it ran.

### Dependencies
PR #27 branch (`claude/musing-wilbur-d67503`). No earlier phase.

### Risks
- Producing a correct drizzle snapshot for hand-written migrations 0014–0017 is fiddly. If `generate` wants to emit SQL, keep the snapshot it produces, discard the SQL, and re-check. Never hand-edit applied SQL.
- Scripts cannot be executed end to end without Docker. Rely on shellcheck, `bash -n` and the GitHub `pilot-stack` workflow, and be explicit about what was not run locally.
- `uncaughtException` exit behaviour must not break `tsx watch` dev ergonomics: exit only in production, log loudly in development.

## Phase P02: Razorpay payments in test mode

### Goal
Members can pay an open invoice, renew or buy a plan, and staff can issue Razorpay payment links and provider refunds. All of it runs through Razorpay **test mode**, with verified idempotent webhooks, reconciliation, and settlement through the existing invoice, membership, dunning, receipt and audit machinery.

### Why
PRD 01 PF-BILL-002/003/004/006 and §4.6 ("Razorpay adapter for cards, UPI …, UPI payment-link support"), PRD 02 "Payments" and Phase 3, and PRD 04 §10.4 all require a hosted provider. PRODUCTION-READINESS §7 calls "no payment provider" a blocker. The domain (invoices, per-line GST, idempotent settlement, dunning, grace) is built. The provider port exists but is synchronous and always null.

### Scope
In:
- Make the port in `lib/payment-provider.ts` async: `createOrder`, `verifyCheckoutSignature`, `verifyWebhookSignature`, `fetchPayment`, `capturePayment`, `refundPayment`, `createPaymentLink`, `fetchPaymentsForReconciliation`. `resolvePaymentProvider()` returns the Razorpay adapter only when `SHARK_PAYMENT_PROVIDER=razorpay` and `SHARK_RAZORPAY_KEY_ID`, `SHARK_RAZORPAY_KEY_SECRET` and `SHARK_RAZORPAY_WEBHOOK_SECRET` are set; otherwise null, with today's refusals unchanged. Config refuses any key id not starting `rzp_test_` in every environment, with a message saying live mode is out of scope.
- Adapter in `services/payments/razorpay.ts` using `fetch` against `https://api.razorpay.com/v1` with Basic auth: Orders, Payments (fetch/capture), Refunds, Payment Links (`notify.sms=false`, `notify.email=false`, `reminder_enable=false`, so Razorpay never messages anyone). Timeouts, and no provider HTTP inside `transact()`. Pattern: commit a `payment_intents` row (CREATED), call the provider, record the outcome. Reuse existing intent/provider_events tables where they fit; otherwise add an additive migration.
- Member API: `POST /v1/member/billing/invoices/:invoiceId/checkout` (Idempotency-Key required) returns `{intentId, orderId, keyId, amountMinor, currency, name, description}` for an open, non-void invoice in the caller's tenant owned by the caller (404 otherwise). `POST /v1/member/billing/checkout/:intentId/confirm` verifies `razorpay_signature = HMAC_SHA256(order_id|payment_id, key_secret)` and then fetches the payment server-to-server. Only a server-confirmed `captured` payment settles. An `authorized` payment is captured by the server; otherwise the intent stays PROCESSING for the webhook. Replace the retired checkout-intent routes rather than reviving them; keep their 412 behaviour when no provider is configured.
- Member plan purchase/renewal: reuse the existing renewal/purchase quote services to create the invoice, then the same checkout. Respect eligibility and the existing "expired/cancelled-only renewal" rule. Credit packs are P05.
- Webhook `POST /v1/webhooks/razorpay`: raw-body HMAC check of `X-Razorpay-Signature` with constant-time compare. Persist to `provider_events` (unique on provider + `x-razorpay-event-id`) before processing. Duplicates return 200 as no-ops. Handle `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`, `payment_link.paid`; store and acknowledge unknown events. Out-of-order delivery (failed after captured, captured before the local confirm, refund before capture is known) must reach the same final state. CSRF/session-exempt, rate-limited, and the bad-signature path logs a security event without storing the body.
- Settlement goes through the single existing settlement path: principal, pending-membership activation, dunning stop, receipt issuance, `audit()` with actor `system:razorpay`, realtime `payment.succeeded`/`payment.failed`. An amount or currency mismatch never settles; it creates a reconciliation exception.
- Refunds: a staff refund of a Razorpay payment calls the provider (idempotent) and stays `PENDING` until `refund.processed`. Partial refunds are bounded by captured minus refunded. Manual payments keep the manual refund path.
- Payment links: admin "Create payment link" on an open invoice shows a copyable link and its expiry (nothing is sent). `payment_link.paid` settles.
- Reconciliation job `reconcile-payments` (scheduler, every 6 h, durable `job_runs`): re-fetches intents stuck in PROCESSING > 15 min and provider payments from the last 48 h, settles missed ones idempotently, and records mismatches. Admin Billing gets a "Reconciliation" panel listing open exceptions with resolve/ignore (reason, audited) (PRD 03 UX-A07).
- Member PWA Billing: "Pay now" on open invoices and "Renew"/"Choose a plan" when a provider is available; otherwise today's reception instructions. Checkout.js is loaded on demand only from `https://checkout.razorpay.com/v1/checkout.js`. States: opening, dismissed, failed (reason in plain words plus retry), confirming (waiting for server truth via realtime with polling fallback), paid (receipt link). Retry reuses the same idempotency key. Book's drop-in "Pay" gains a confirmation step showing amount and terms.
- Admin Billing invoice drawer: provider, provider payment id, attempt/event timeline, refund state. Dunning keeps `automaticCollection.available=false` (no stored mandates) with honest copy.
- Remove the dead, shadowed handlers in `routes/admin/billing.ts` (overridden by `billing-stabilization.ts`) and the duplicated service functions (`billing-membership.ts` vs `billing-stabilization.ts`), keeping behaviour identical (existing tests stay green).
- `docs/PAYMENTS-RAZORPAY.md` (test keys setup, webhook URL and events to enable in the Razorpay dashboard, local testing, test cards/UPI ids from Razorpay docs by reference, reconciliation, going-live checklist for the client), ADR-003 (provider port, Razorpay first, Stripe contract only, no mandates), `.env.example` placeholders, PRODUCTION-READINESS §7.
- Dev tool: `pnpm -F @shark/api razorpay:webhook -- <fixture> [--url]` signs a fixture with `SHARK_RAZORPAY_WEBHOOK_SECRET` and posts it locally.

Out: live mode; subscriptions/UPI Autopay/eMandate; stored instruments; Stripe code; per-tenant credentials; credit-pack sales (P05); sending payment links by SMS/email.

### Acceptance criteria
1. With no provider env, every existing billing/provider-truthfulness test passes unchanged, and member checkout returns the same 412 code as today.
2. A config test proves `rzp_live_…` is refused in development, test and production, and that `SHARK_PAYMENT_PROVIDER=razorpay` with any missing secret is refused at boot.
3. Integration tests run with a fake Razorpay HTTP server (any unexpected outbound request fails the test). They cover: (a) checkout → confirm → captured: invoice paid once, membership activated, receipt issued, audit and realtime emitted; (b) confirm with a bad signature: 400, nothing settled; (c) confirm while the payment is only authorized: server captures, then settles; (d) provider timeout on createOrder: no payment row, intent FAILED, a retry with the same key works; (e) another member's invoice: 404; (f) void/paid invoice: 409.
4. Webhook tests with correctly signed fixtures for each handled event, plus duplicate event id (one settlement), tampered body (400), missing signature (400), out-of-order failed-after-captured (stays paid), captured-before-confirm (settles once and the later confirm is a no-op), amount mismatch (no settlement, a reconciliation exception exists), unknown event (stored, 200).
5. Refund tests: full and partial provider refund (PENDING, then REFUNDED on `refund.processed`); over-refund refused; `refund.failed` returns the state to refundable; manual refund path unchanged.
6. Payment link test: create (request body asserts notify flags false), `payment_link.paid` settles the invoice.
7. Reconciliation test: a PROCESSING intent whose payment is captured at the provider is settled by the job exactly once even when run twice concurrently; a mismatch appears in `GET /v1/admin/billing/reconciliation` and resolving it requires a reason and writes an audit entry.
8. A test or source check proves no provider call happens inside `transact()`, for example by wrapping `transact` to assert the provider stub is not invoked while a transaction is open.
9. Member PWA component tests cover all checkout states. A Playwright spec on a mobile viewport (Checkout.js intercepted by a stub that calls the handler, then the test posts a signed `payment.captured` webhook to the server) shows "Paid" and a receipt, and a reload does not offer to pay again.
10. Admin component tests for the payment-link action and the reconciliation panel (loading, empty, error, permission states).
11. The shadowed billing handlers and duplicate services are gone. `git grep` shows one definition of `createMembershipPurchase`. Test count does not drop except for tests of deleted dead code, each listed in the PR.
12. Docs, ADR-003 and `.env.example` updated. Standard gates and `pnpm e2e` pass.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap in PHASE-PLAN.md
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p02-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p02-test.log
pnpm -F @shark/api test -- razorpay payment webhook reconciliation refund
pnpm build && pnpm e2e -- --grep "@payments"
git grep -n "rzp_live_" -- ':!docs' ':!**/__tests__/**'    # only the config refusal
```
Passing: all green. Payment specs pass on a mobile project. Zero unexpected outbound requests. The member flow shows Paid and the admin drawer shows the provider payment id.

### Dependencies
P01 (config schema conventions, error reporting, migration snapshot fix, E2E harness).

### Risks
- Razorpay payload details must be taken from Razorpay's current docs (fixtures should mirror documented shapes), not memory. Cite the doc pages used in `docs/PAYMENTS-RAZORPAY.md`.
- Moving the port from sync to async touches the dunning worker. Keep its "no provider" path byte-for-byte equivalent in outcome codes.
- Checkout.js inside the PWA needs CSP allowances later (P06). Record the exact origins in the doc.

## Phase P03: Public website, public API and lead capture

### Goal
Ship a fast, SEO-complete public website for the gym at `/` (Astro, static) with plans, timetable, coaches, locations and a free-trial and contact flow that creates real, deduplicated leads in the CRM through a new rate-limited public API. Move the member app to `/app/` without breaking existing installs, activation links or the admin console.

### Why
The client asked for "the website". PRD 01 PF-CRM-001 and §4.3 require self-service lead forms, QR campaign links and trial requests. PRD 02 §7.2 and PRD 04's trade-off register reserve a separate public site. Nothing public exists today; every API route except auth, door, health and readiness requires a session.

### Scope
In:
- New `apps/website` (`@shark/website`, Astro pinned, `output: 'static'`, TypeScript strict, ESLint covered). Pages: Home, Plans & pricing, Classes & timetable, Coaches, Locations (index plus one page per branch), About, Free trial, Contact, FAQ, Privacy notice (draft, counsel review), Terms (draft), 404. Content in typed content files (`src/content/`) seeded from the demo tenant (Shark Fitness, Bengaluru; branches Koramangala, Indiranagar, HSR) so the build needs no running API. Plans and timetable are re-fetched at runtime from the public API as progressive enhancement and fall back to the built content. `pnpm -F @shark/website sync-content -- --api <url>` refreshes the content file from a running API.
- Visual design follows `docs/DESIGN.md` (Sonar: abyss canvas, one cyan accent, Anton display / Archivo body, zero radius, hairline seams, light theme via `prefers-color-scheme`) and the anti-patterns list in the implementation brief. Self-hosted subset WOFF2 fonts with preload and `font-display: swap`. No third-party trackers. Optional analytics placeholder off by default.
- SEO: unique title and description per page; canonical URLs from `SITE_URL` (placeholder `https://www.sharkfitness.example`); Open Graph/Twitter tags with a generated 1200×630 PNG; JSON-LD `ExerciseGym` per branch (address, geo, `openingHoursSpecification`, telephone), `Offer` for plans, `FAQPage`, `BreadcrumbList`; `sitemap.xml` and `robots.txt`; 404 is `noindex`; whole-site `noindex` unless `SITE_INDEXABLE=true`.
- Public API `routes/public.ts`, mounted at `/v1/public/:tenantSlug`, with services in `services/public-site.ts`:
  - `GET /site`: display name, branches (address, hours, holidays, amenities, public contact), public plans. Only active, public, branch-eligible products, with a price label including the GST label. Add a `public` flag to products via additive migration if none exists, plus an admin Plans toggle "Show on website".
  - `GET /classes?branchId&from&to`: ≤ 14 days; type, coach first name, start/end in branch tz, level, and spots shown as `available`/`few left`/`full`; no member data.
  - `POST /leads` and `POST /trial-requests`: name, phone (normalized E.164, default +91), optional email, branch, goal, preferred time or `classSessionId`, message ≤ 1,000 chars, `consent.processing` (required, with notice version), `consent.marketing` (optional, unticked by default; ENT-PRIV-002/003), UTM fields, referral code, honeypot field, and a form-start timestamp.
  - Behaviour: dedupe via the existing leads service by normalized phone/email (PF-CRM-002); source `website` plus campaign attribution (PF-CRM-005); lead activity entry; trial requests record the requested session/time on the lead and raise the existing lead-SLA alert. No booking is created and no capacity consumed; staff confirm. A converted member submitting again links to the existing member with a note and creates no duplicate (PF-CRM edge case). Honeypot filled or submitted under 3 s: 202 with no lead and a security log. Unknown or suspended tenant: generic 404. Rate limits per IP (5 per 10 min per endpoint) and per tenant. `Idempotency-Key` supported. No cookies; Origin must match the allowed origins. No message is sent to the visitor; the response page says the team will call.
  - QR campaign links: `/?utm_source=qr&utm_campaign=…` attribution works, and the admin Leads screen shows the campaign.
- Admin: Leads list and detail show source, UTM, trial request (session/time) and a "Website" filter. Lead detail "Confirm trial" moves the stage to TRIAL_BOOKED with the chosen session recorded.
- Routing change, all in this phase:
  - Member PWA built with `base: '/app/'`; router basepath `/app`; manifest `scope`/`start_url`/`id` under `/app/`; service worker scope `/app/` with `navigateFallback` adjusted and denylist kept.
  - API static serving: `/` serves the website, `/app/*` the member app, `/admin/*` the console. Correct content types and cache headers (immutable hashed assets, no-cache HTML).
  - Activation and recovery links generated by the API point to `/app/#…`. The website's `/` forwards legacy `#activationId=`/`#recoveryId=` fragments to `/app/` preserving the hash.
  - The website ships a self-unregistering `/sw.js` so a previously installed member worker scoped to `/` cannot keep serving the old shell.
  - When opened in `display-mode: standalone` (an old home-screen install), `/` redirects to `/app/`.
  - The Dockerfile copies `apps/website/dist`. CI production smoke and `scripts/admin-browser-smoke.mjs` updated. Dev: `pnpm dev` adds the website dev server (port 5175) with `/v1` proxy.
- Docs: `docs/WEBSITE.md` (editing content, env vars, SEO switches, Lighthouse budgets), README and `docs/PILOT-HOSTING.md` path notes.

Out: blog/CMS, online purchase on the website (it links to the app's plan purchase from P02), multi-tenant website hosting, real photography, sending confirmations by SMS/email.

### Acceptance criteria
1. `pnpm build` builds `apps/website`. Production single-origin serving returns the website at `/`, the member app at `/app/` and the console at `/admin/`. Hashed assets are served with correct MIME types and `immutable`; HTML with `no-cache`. The CI smoke checks all three.
2. Public API integration tests: dedupe by phone and by email; converted-member resubmission links instead of duplicating; honeypot and too-fast submissions create nothing and return 202; another tenant's slug cannot see or write this tenant's data; suspended tenant → 404; rate limit → 429; invalid phone → 422 with a field path; consent stored with its version; `GET /classes` contains no member identifiers and caps the range at 14 days; non-public products never appear.
3. Lighthouse CLI (mobile, simulated throttling) against the production-served build: Home, Plans and Free trial score Performance ≥ 95, Accessibility ≥ 95, Best Practices ≥ 95, SEO = 100. Reports saved under `/workspace/shark-fitness-orchestration/phases/P03-lighthouse/`.
4. JavaScript shipped on content pages ≤ 20 KB gzip; Free trial and Contact pages ≤ 35 KB gzip; CLS < 0.05 (measured by a script or Lighthouse).
5. Every page has a unique title and description, a canonical tag, OG tags, and valid JSON-LD (parsed in a test). `sitemap.xml` lists every indexable page. `robots.txt` honours `SITE_INDEXABLE`.
6. Playwright: on desktop and mobile projects a visitor completes the Free trial form with keyboard only; validation errors are announced (aria-live) and focus moves to the first invalid field; the lead then appears in the admin Leads list with source Website and the trial chip. A legacy `/#activationId=x&tenant=y` URL lands on `/app/` with the same hash. A pre-registered service worker at scope `/` is gone after visiting `/`. The admin console still loads at `/admin/`.
7. Member app tests and E2E specs pass with the new base path. Activation/recovery link tests assert the `/app/` prefix.
8. No outbound message is attempted for leads (asserted through the notification log driver or absence of delivery rows).
9. Docs updated. Standard gates and `pnpm e2e` pass.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p03-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p03-test.log
pnpm build && pnpm e2e
pnpm -F @shark/api test -- public
# Lighthouse against the production server started per the conventions section (port 8788):
pnpm dlx lighthouse http://localhost:8788/ --preset=perf --form-factor=mobile --output=json --output-path=/workspace/shark-fitness-orchestration/phases/P03-lighthouse/home.json --chrome-flags="--headless=new"
```
Passing: gates green, e2e green on desktop and mobile, Lighthouse thresholds met for the three pages, JS budgets met.

### Dependencies
P02 (the website links to plan purchase; products and prices come from the same catalogue). P01 (E2E harness, config conventions).

### Risks
- The base-path move is the riskiest change in the plan: service-worker scope, cached shells, activation links and CI smoke all depend on it. Test the legacy paths explicitly.
- Lighthouse scores vary run to run. Use the median of 3 runs and record all three.
- Copy quality decides whether the site feels premium. Write real, specific copy for an Indian gym (INR, GST-inclusive labels, local branch details) in the plain register for pricing and policies.

## Phase P04: Installable member app (PWA + Android TWA) and staff console PWA

### Goal
Make the member app a store-quality mobile app on the Sonar design. It should install and launch like a native app, work offline for what matters, receive deep-linked push notifications, sign out safely, respect preferences, and lay out properly on phones and tablets. Package it for Google Play as a Trusted Web Activity built in CI. Make the admin console installable for reception tablets.

### Why
The client asked for "the mobile app". PRD 01 §0 and §3.2 describe an installable, offline-capable member app with push (PF-COMM-002) and deep links (PRD 03 §5.6). PRD 04 §18 has a mobile launch checklist. Today the manifest has one SVG icon, there is no push, no sign-out, preferences are ignored, and tablets see a phone frame. The technology decision is recorded below as ADR-002.

### Scope
In:
- `docs/ADR-002-member-mobile-app.md`. Decision: installable PWA plus Android TWA, iOS via Safari install; Expo deferred. It must cite PRD 02 "Approved baseline stack"/§7.3, PRD 04's trade-off register and ADR-001, give the reasons (one codebase, offline outbox exists, no device SDK to verify native here), and list the revisit triggers (HealthKit/Health Connect, NFC/wallet, background location/BLE doors, App Store listing). It also notes the migration path: Capacitor or Expo reusing `@shark/contracts`, `@shark/domain` and `@shark/design-tokens`.
- Manifest under `/app/`:
  - Fields: `id`, `scope`, `start_url` `/app/?source=pwa`, `name`, `short_name`, `description`, `display: standalone` with `display_override`, portrait, theme and background colours for both themes, `categories`.
  - Icons: PNG 192 and 512 (`any`), 512 `maskable` with safe zone, 96 monochrome, plus a 180 `apple-touch-icon`. iOS meta tags (`apple-mobile-web-app-capable`, status bar style, title).
  - Shortcuts: Pass, Today's workout, Book a class.
  - Screenshots: ≥ 2 narrow, ≥ 1 wide.
  - All generated from one SVG source by a committed script (`pnpm -F @shark/member-pwa icons`) using a pure-JS/WASM renderer such as `@resvg/resvg-js` (dev dependency). Outputs are committed under `public/icons/`, which `.gitignore` allows.
- Service worker:
  - `registerType: 'prompt'`. An "Update ready — Reload" bar appears, but never while a workout is active; the update applies after the workout finishes.
  - Offline fallback page for navigations. Precache ≤ 700 KiB. Self-hosted fonts instead of Google Fonts.
  - The API stays network-only in the worker.
- Offline read state: persist the TanStack Query cache in IndexedDB (partitioned per user, 24 h max age, versioned buster) for Home, the training plan, Book's list and Profile. Show an offline banner "Offline — showing what was saved at HH:MM". Never persist the Pass token or billing secrets.
- Session safety:
  - Profile gains "Sign out". It warns when the outbox holds unsynced items for this user ("3 workout sets haven't synced yet …" with Sign out anyway / Stay) and clears the query cache, the persisted cache, that user's outbox, `shark.workout*` keys and push registration.
  - A global 401 handler shows "Your session ended", routes to sign-in, keeps unsynced outbox entries for the same user, and returns to the original route after sign-in.
  - Deletion-request copy matches behaviour (signs out if it says so).
- Preferences actually applied:
  - Theme `system|dark|light` via `data-theme`; remove the hard-coded dark from `index.html` without a flash of the wrong theme.
  - The in-app reduce-motion preference and the system setting.
  - Haptics via `navigator.vibrate` for set complete, check-in success, timer done and PR, gated by preference and support.
  - Units kg/lb: domain conversion helper; storage stays kg; Workout, Progress and Summary display the chosen unit.
  - Fix the `['viewer']` invalidation and the plan query-key mismatch.
- Navigation: a header bell with unread badge links to Notifications. Profile gains a "More" area with Billing, Library, Messages, Install app and Help. Summary gets Done (to Home) and, where `navigator.share` exists, Share. Badging API (`navigator.setAppBadge`) reflects unread count where supported.
- Responsive: remove the fixed 428×908 frame. Phones are full-bleed with safe areas, including the Pass header and sheets. Tablets (≥ 768 px) get a centred content column (max ~720 px) with two-column Book and Progress where it helps. Landscape Workout stays usable. Touch targets are ≥ 44 px for every control touched in this phase.
- Web Push:
  - Config and storage: VAPID config (`SHARK_VAPID_PUBLIC_KEY`, `SHARK_VAPID_PRIVATE_KEY`, `SHARK_VAPID_SUBJECT`) validated in `lib/config.ts`. `push_subscriptions` table (additive migration; tenant, user, endpoint hash, keys, user agent, created/last-success). `POST /v1/me/push-subscriptions` and `DELETE /v1/me/push-subscriptions/:id`.
  - Sending: a `push` channel in the notification service using the `web-push` library. It honours purpose consent, quiet hours in branch timezone and dedupe keys, and removes subscriptions on 404/410. The payload carries only title, body and a deep-link path, with no PII beyond what the notification text needs.
  - Service worker `push` and `notificationclick` handlers focus or open the exact deep link.
  - Permission is requested only after a user action, behind a rationale screen. All push UI is hidden when VAPID is not configured.
  - First notifications wired: class reminder, booking/waitlist change, coach message, payment failed or succeeded.
- Install UX: capture `beforeinstallprompt` and offer "Install app" in Profile/More, plus a one-time dismissible banner after the 2nd session. On iOS Safari show an instruction sheet. Never prompt on first visit.
- Android TWA:
  - `apps/member-pwa/android/twa-manifest.json`: package id placeholder `in.sharkfitness.member`, host from `SITE_HOST`, start URL `/app/?source=twa`, colours, icons, shortcuts, notification delegation, fallback `customtabs`.
  - `/.well-known/assetlinks.json` served by the API from `SHARK_ANDROID_PACKAGE` and `SHARK_ANDROID_CERT_SHA256` (comma list, fingerprint format validated); 404 when unset.
  - `.github/workflows/android-twa.yml` (`workflow_dispatch` only) builds a signed APK and AAB with `@bubblewrap/cli` on an Ubuntu runner, using a keystore generated inside the job (never committed), and uploads them as artifacts.
  - `docs/MOBILE-APP.md`: Play Console steps, Play App Signing, getting the SHA-256 into env, a draft Data safety form, privacy disclosures, permission rationales, iOS install guidance and limits.
- Staff console PWA: admin manifest (scope `/admin/`, icons, any orientation) and a service worker that precaches only the shell. The offline page reads "You're offline. The console needs a connection to show live data". No API caching, and its scope is proven not to overlap the member worker.

Out: Expo/Capacitor projects, Play/App Store submission, real push sends, health integrations, the QR pass (P05).

### Acceptance criteria
1. ADR-002 exists with the content above.
2. A test validates the built `/app/manifest.webmanifest`: required fields, icon files exist with matching pixel sizes, maskable icon present, ≥ 2 narrow and ≥ 1 wide screenshot. `apple-touch-icon` resolves.
3. Playwright (Pixel 7 and iPhone 13 projects): the service worker controls `/app/`. After `context.setOffline(true)` and a reload, Home renders from the persisted cache with the offline banner. An update is never applied during an active workout (simulated with a second build or a mocked `waiting` worker).
4. Sign-out tests: unsynced-items warning shown; after sign-out IndexedDB holds no entries for that user, `localStorage` has no `shark.workout*` keys, and the push subscription is deleted server-side. 401 mid-session shows "Your session ended" and, after sign-in, returns to the same route with the outbox intact.
5. Preference tests: theme switches without a reload and persists across reload with no flash (initial paint uses the stored theme); reduce-motion removes animations (computed style check); unit change shows lb values with correct conversion (domain unit tests); haptics call `navigator.vibrate` only when enabled.
6. Reachability: Notifications, Library, Billing and Messages are reachable within 2 taps from Home. Summary has Done. Asserted in E2E.
7. Responsive: no horizontal scroll and no clipped content at 360×800, 390×844, 768×1024 and 1024×768, asserted by an E2E script that checks `scrollWidth <= clientWidth` on every route. Screenshots saved to `phases/P04-screens/`.
8. Push integration tests: subscribe/unsubscribe; send to a local fake push endpoint verifies an encrypted payload and VAPID headers; 410 removes the subscription; quiet hours defer; no consent means no send; no requests to real push services (network guard). An E2E test with a granted notification permission subscribes via the UI and receives a push from the fake service (or verifies the subscription round-trip if Chromium headless cannot display notifications).
9. `/.well-known/assetlinks.json`: 404 when unset; correct JSON when set; malformed fingerprint refused at boot. `twa-manifest.json` validates against a schema test. `android-twa.yml` passes `actionlint` (pinned binary in `/tmp`). The PR states the APK build was not run locally.
10. Admin manifest and service worker: the console is installable (manifest test), its offline page shows when offline, and the member and admin workers never control each other's scope (E2E).
11. Precache ≤ 700 KiB; initial member JS within +10 % of the baseline 132 KB gzip.
12. Standard gates and `pnpm e2e` pass.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p04-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p04-test.log
pnpm build && pnpm e2e -- --project="member-pixel7" --project="member-iphone13" && pnpm e2e
pnpm -F @shark/api test -- push assetlinks
/tmp/actionlint ../.github/workflows/android-twa.yml
```
Passing: all green; screenshots for the four viewports exist and were looked at; budgets met.

### Dependencies
P03 (member app at `/app/`, website at `/`). P02 (payment notifications). P01 (config/E2E).

### Risks
- Headless Chromium push support is limited. Prove the server half against a fake push service and the client subscription round-trip; do not claim delivery to a real device.
- Persisting the query cache can leak data between accounts on shared phones. Partition by user, wipe on sign-out, and test it.
- iOS PWA behaviour cannot be tested here. Emulation covers layout only; state that in the PR.

## Phase P05: QR check-in, safe waitlist, credit packs, private media and progress photos

### Goal
Re-enable, safely and completely, the member features that stabilization switched off: a real rotating QR pass with reception camera scanning, waitlists whose offers hold seats, and sellable credit packs with a defined refund policy. Add the missing private media path for progress photos and a freestyle workout logger.

### Why
These are SHALL requirements and PRD 01 acceptance scenarios: PF-ATT-001/005 and scenario 2 (rotating QR), PF-SCH-002/003 and scenario 3 (last seat/waitlist), PF-CAT-001/004/005 and PRD 02 §14.2 "Refund with partial … consumption" (packs), PF-PROG-004/006 (private photos), PF-WORK-004 (fast logging). They were disabled only because they were unsafe at the time (STABILIZATION report). The prototype's signature moment is the sonar-swept rotating QR (DESIGN.md "Signature").

### Scope
In:
- **Pass (member):**
  - Content: render the token from `/v1/member/pass` as a real QR code (small pinned encoder library, error correction M, quiet zone, ≥ 240 px). Dark modules on a light panel in both themes. Countdown synced to the server window, auto-refresh before expiry, and the sonar sweep only while acquiring (DESIGN.md), disabled under reduced motion. Screen Wake Lock while visible, and a "turn up brightness" tip.
  - States: active, grace (allowed, with plain notice), frozen/expired/suspended/cancelled (no QR; reason and what to do, with a Billing link), refresh failure or offline (member number plus "Reception can check you in with this number"). Branch selector when entitled to several (PF-ATT-002).
  - Copy and tone: plain register only. Add the pass/access surface to `PLAIN_ONLY_SURFACES` and make `useCopy(surface)` enforce it, with a test that plain surfaces never render predator strings.
- **Reception scanning (admin Floor):** "Scan pass" opens the camera (BarcodeDetector where available, else a pinned JS decoder). A text input accepts USB keyboard-wedge scanners and pasted codes. `POST /v1/admin/attendance/scan` reuses the door/access decision service (signature, single-use window, tenant, branch entitlement, hours, capacity, anti-passback, outstanding policy) and is audited, idempotent and emits occupancy. The result panel shows the member's name and initials, the decision with reason, and the existing override path for denials. A duplicate within the window shows "Already checked in". Camera denied → typed-code fallback (UX-A08). Permissions-Policy `camera=(self)` on `/admin/*` only; the member app and website keep `camera=()`.
- **Waitlist** (`services/booking.ts`; remove `WAITLIST_AVAILABLE=false`):
  - Flow: join when full, with position shown. A cancellation, capacity increase or no-show release creates an OFFER for the first eligible WAITING member with a seat **hold** that counts against capacity until `offerExpiresAt` (decision 12; tenant default in settings). Accepting re-checks membership, branch, booking window and credits, then CONFIRMs; decline or expiry advances the queue (scheduler job `expire-waitlist-offers` already exists). Waitlist order is stable and auditable.
  - Capacity: the DB guard counts confirmed bookings plus live holds. Reducing capacity below bookings never auto-cancels; it raises a staff alert.
  - Notifications: in-app always; push when P04's push is configured.
  - UI: member Book shows the offer with a countdown and Accept/Decline (focus-trapped dialog, Escape works). The admin roster shows the waitlist and live offers.
- **Credit packs** (decision 11):
  - Sales: sellable `class_pack`/`pt_pack` products via staff assignment and member self-purchase (P02 checkout; without a provider, an unpaid invoice for reception).
  - Allocation and consumption: allocated in the settlement transaction only when fully paid; consumed earliest-expiry first by bookings and PT sessions; restored with the original expiry inside the cancellation window; forfeited per product policy for late cancellation or no-show.
  - Refunds: the decided policy, with the append-only credit ledger and audit.
  - Visibility: member Billing shows balance, expiry and history; Book shows "Uses 1 credit"; admin Member detail shows the ledger.
- **Private media storage:**
  - Storage: a `MediaStorage` port with a local-disk adapter (`SHARK_MEDIA_DIR`, outside any static root; required in production when uploads are enabled; `SHARK_MEDIA_BUCKET` stays rejected).
  - Uploads: `POST /v1/member/media/uploads` (multipart, ≤ 10 MB, JPEG/PNG/WebP by magic bytes, re-encode or strip all metadata including EXIF GPS, max 4096 px, per-tenant quota).
  - Downloads: HMAC-signed URLs valid ≤ 5 min that re-check authorization when served. Deletion removes the file and leaves a tombstone row.
  - Backups: `pnpm db:backup`/`restore` and `deploy/pilot/backup.sh`/`restore-drill.sh` include the media directory as a checksummed tar beside the DB (and off-site when P01's off-site upload is configured); `pnpm db:backup:verify` covers media.
- **Progress photos (member Progress):** upload requires explicit photo consent (consent record with version); visibility private (default) or "my coach"; side-by-side compare of two dates with a slider and textual date labels; delete. Revoking consent hides photos from coaches immediately and schedules deletion per the retention setting. Trainers see photos only when visibility is coach and they are assigned. The privacy export lists photos.
- **Freestyle workout:** "Log a workout" on Train (and when there is no plan) picks exercises from the library and uses the same logger, outbox, PR detection, XP rules and Summary. Remove the copy that promised this before it existed, or make it true.

Out: physical door controllers, an offline kiosk eligibility cache, NFC/wallet passes, video hosting, community features (P07).

### Acceptance criteria
1. Pass component tests cover every state. The tone test fails if any plain-only surface renders a predator variant. A Playwright test on a mobile project proves the QR re-renders with a new token before the countdown ends and that offline shows the member number.
2. Scan integration tests: valid token admits once and a second scan returns "Already checked in" with one check-in row; replayed (used window), expired, other-tenant, other-branch-only, suspended and capacity-full tokens each return their specific denial code; every decision is audited.
3. Admin E2E: reception scans via the text input with a token fetched for a member and sees Admitted. A camera-denied simulation shows the fallback. Response headers show `camera=(self)` only under `/admin/`.
4. Waitlist concurrency tests (PRD 01 scenario 3, PRD 02 §14.2): 20 parallel requests for the last seat produce exactly one CONFIRMED and the rest WAITING. Accept racing expiry produces exactly one outcome. Holds never let confirmed plus held exceed capacity. Capacity reduced below bookings cancels nothing and raises an alert. Promotion of a member whose membership expired skips to the next member.
5. Credit-pack tests: no credits before full payment; credits appear in the same transaction as settlement (manual and Razorpay webhook paths); FIFO consumption; restoration keeps the original expiry; refund matrix (unused = full; partial = unused × unit price with a reason; expired = refused); the ledger is append-only (trigger test).
6. Media tests: oversize → 413; spoofed MIME (a script with a .jpg name) → 422; uploaded JPEG with GPS EXIF is stored without it; signed URL expired → 403; another member's URL → 404; trainer access matrix (private vs coach, assigned vs not); consent revoke hides photos immediately; backup and restore round-trip includes media with matching checksums.
7. Freestyle workout E2E: offline, log 2 exercises × 3 sets, reload, go online; exactly 6 sets are stored server-side once.
8. Member and admin component tests for new UI states (loading, empty, error, permission, offline). The plain register holds on Pass, Billing and refund surfaces.
9. PRODUCTION-READINESS (waitlist, QR, media, backups) and README "offering" text updated truthfully. Standard gates and `pnpm e2e` pass.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p05-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p05-test.log
pnpm -F @shark/api test -- scan waitlist credit media progress-photo
pnpm db:backup:verify
pnpm build && pnpm e2e
```
Passing: all green, including the 20-way race test; backup verify reports media restored with checksums.

### Dependencies
P02 (checkout for packs), P04 (push, `/app/` paths, responsive shell), P01 (backup scripts and E2E).

### Risks
- Seat holds touch the capacity trigger that guards money and seats. Write the race tests first, and keep the guard in the database, not only in code.
- QR decoding libraries vary in size. Lazy-load the decoder only on the scan screen and record its gzip size in the PR.
- Image re-encoding without a native dependency is limited. Prefer client-side canvas re-encode plus server-side metadata stripping and magic-byte checks. Avoid adding `sharp` unless justified in notes.

## Phase P06: Staff security: MFA, step-up auth, sessions, CSP, outbound webhooks

### Goal
Bring staff and admin security to the PRD 04 baseline: TOTP MFA mandatory for owners and platform roles, step-up re-authentication on high-risk actions, server-enforced session lifetimes with graceful expiry in both SPAs, an enforced Content-Security-Policy on every surface, and signed, retried, SSRF-safe outbound webhooks.

### Why
PRD 04 ENT-IAM-001 (MFA for platform admins and tenant owners), ENT-IAM-003 and PRD 01 §2.4 / PRD 02 "Authorization sequence" step 6 (step-up for refunds, role changes, exports, deletion, impersonation), PRD 04 §10.1 (CSP, session controls), PF-INT-003 (signed, retryable webhooks). None of these exist. The PRD 04 enterprise gates list MFA and privileged-access controls first.

### Scope
In:
- **MFA:**
  - Mechanics: TOTP via a vetted library (`otpauth` or equivalent; no hand-rolled TOTP). Secrets encrypted at rest with AES-256-GCM using `SHARK_MFA_ENCRYPTION_KEY` (32 bytes, base64, validated in config, required in production). 10 single-use recovery codes, stored hashed.
  - Lifecycle: enrol (QR plus manual key, confirm with a code), challenge at sign-in after password, regenerate recovery codes, disable (requires step-up). Mandatory enrolment gate at next sign-in for `owner`, `regional_manager`, `platform_admin` and `platform_support`; tenant setting "Require MFA for all staff"; members unaffected.
  - Protection: rate-limited challenge with lockout and audit (enrol, disable, failure bursts). Owner-assisted reset for a staff member who lost their device, with reason and audit; owner self-reset goes through platform support only.
- **Step-up:**
  - Server: `requireFreshAuth(ctx, 300 s)` on refunds and write-offs, staff role/permission/branch changes, report/member/privacy exports, privacy erasure/deletion approvals, impersonation start, webhook endpoint secrets, and MFA disable. The API returns 401 with code `STEP_UP_REQUIRED` (or `MFA_REQUIRED`).
  - Console: one re-auth dialog (password, plus TOTP when enrolled) that retries the original request with the same idempotency key.
  - Audit: denied high-risk attempts recorded with redacted metadata.
- **Sessions:** server-enforced staff idle timeout (default 30 min; tenant setting 15–240) and absolute lifetime (12 h); member sessions 30-day sliding. The admin console gains a global 401 handler with a "Session expired" dialog that preserves the current URL and returns after sign-in, a light idle warning 2 minutes before expiry, and "Your devices" (list and revoke sessions, sign out everywhere). The member app keeps P04's handler.
- **Headers:**
  - CSP for website, member app and console, served by the API with per-surface policies: `default-src 'self'`; `script-src 'self' https://checkout.razorpay.com`; `frame-src https://api.razorpay.com https://checkout.razorpay.com`; `connect-src 'self'` plus the exact Razorpay origins Checkout needs (verify against Razorpay docs and the P02 E2E); `img-src 'self' data: blob:`; `font-src 'self'`; `style-src 'self'` (add `'unsafe-inline'` only if React inline style attributes require it, and document why); `object-src 'none'`; `base-uri 'none'`; `frame-ancestors 'none'`; `form-action 'self'`.
  - Reporting: CSP reports to `/v1/csp-reports` (rate-limited, forwarded to the error reporter).
  - Keep `camera=(self)` only on `/admin/*`.
- **Outbound webhooks (Settings → Integrations, owner only):**
  - Endpoints: CRUD of HTTPS endpoints with a chosen event subset (member.created/updated, membership.activated/cancelled, payment.succeeded/failed, attendance.checked_in/checked_out, class.booked/cancelled/waitlist_promoted, workout.completed, lead.created/converted).
  - Payload and signing: versioned envelope (id, type, version, tenant, occurredAt, data) with minimal non-sensitive data (no health, photos or free text); `Shark-Signature: t=<unix>,v1=<hex HMAC-SHA256 of t.body>`.
  - Delivery: driven from the outbox by a scheduler job with exponential backoff up to 24 h, then disabled with a tenant-visible alert after N consecutive failures. Durable delivery log (attempt, status, latency, truncated response); manual replay; secret rotation with 24 h dual-signing; test-send button.
  - SSRF defence: https only in production; DNS-resolved IPs checked against private, loopback, link-local and metadata ranges (loopback allowed only when not production, for tests); 5 s timeout; no redirects; ≤ 64 KB response read.
- Remove the shadowed `POST /auth/otp/verify` in `auth.ts` (keeping `auth-stabilization.ts` behaviour) and verify `/platform/impersonate/end` authorization.
- Docs: `docs/SECURITY.md` (threat model summary, MFA, step-up matrix, session policy, CSP, webhook verification snippet for consumers) and ADR-004 (MFA/TOTP now, passkeys deferred with reasons).

Out: passkeys/WebAuthn, SSO/SCIM, a custom role editor, public API keys/OAuth, IP allowlists.

### Acceptance criteria
1. MFA integration tests: an owner without MFA is gated to enrolment after sign-in; enrol, sign out and sign in requires a code; wrong codes rate-limit and lock; a recovery code works once; disable requires step-up; secrets are not readable in plain form in the DB (assert the column is ciphertext); the tenant "require MFA for all staff" setting gates reception; members are never challenged.
2. Step-up: a data-driven test over the listed routes returns `STEP_UP_REQUIRED` without fresh auth and succeeds within 5 minutes of re-auth. An admin component test shows the dialog retrying the original request with the same idempotency key.
3. Session tests: idle expiry and absolute expiry are enforced server-side (time mocked); member sliding expiry. Admin E2E: an expired session shows the dialog and returns to the same URL after sign-in; the device list revokes another session, which then gets 401.
4. CSP: every E2E spec (website, member including Razorpay checkout stub, admin) runs with a `securitypolicyviolation` listener and asserts zero violations. A header test asserts the per-surface policies.
5. Webhook tests with a local receiver: signature verifies with the documented algorithm; retry schedule on 500s; disable after N failures plus alert; replay; rotation dual-signs for 24 h; SSRF attempts (`http://169.254.169.254`, `10.x`, `localhost` in production mode, a DNS name resolving to a private IP, a redirect) are refused; payloads contain no excluded fields.
6. Admin UI for MFA enrolment, device list and integrations has loading, empty, error and permission states and component tests.
7. Audit entries exist for MFA events, step-up successes and failures, and webhook endpoint and secret changes. Secrets never appear in logs (redaction test).
8. Docs and ADR-004 written. Standard gates and `pnpm e2e` pass. Seeded demo owners have MFA disabled but flagged so the demo still signs in, with the enrolment gate shown on first sign-in; document how E2E handles it (a TOTP generated from a seeded test secret).

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p06-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p06-test.log
pnpm -F @shark/api test -- mfa step-up session csp webhook
pnpm build && pnpm e2e
```
Passing: all green and zero CSP violations reported by the E2E listener.

### Dependencies
P05 (all surfaces whose CSP and step-up must be covered exist). P02 (Razorpay origins), P03 (website), P04 (member 401 handling).

### Risks
- Enforced CSP can silently break Razorpay Checkout or Vite assets. Roll out as report-only during development, turn enforcement on only when the E2E listener is clean, and test checkout under CSP.
- The MFA gate could lock the client out of the demo. Keep a documented, audited platform-support reset and keep demo credentials working in development.

## Phase P07: Messaging channels, member messaging, community moderation, tasks, coaching, broadcasts

### Goal
Complete the engagement and operations modules the PRD navigation lists but the product lacks: real (log-by-default) notification channels with delivery records, member-started conversations with attachments, community comments with moderation, a staff Tasks inbox, a coach Nutrition & Habits view with weekly check-ins, one-off broadcasts with cost preview, quick walk-in member creation, and a command palette that searches and acts.

### Why
PRD 01 §3.1 navigation (Tasks, Nutrition & Habits, Community, Marketing), PF-COMM-001/002/005/006, PF-GAME-005, PF-NUTR-002/003, PF-SUP-004, PF-DASH-005, PRD 01 §4.2 command palette, PRD 03 UX-A04, UX-M11 and UX-M12. Today non-in-app channels are suppressed, members cannot start threads, comments are count-only, and the palette only switches modules.

### Scope
In:
- **Notification channels:**
  - Service: one `NotificationService` with `in_app`, `push` (P04), `email`, `sms` and `whatsapp` channels. Drivers: `log` (default everywhere; records "logged, not delivered") and real drivers enabled by env, reusing the OTP providers' HTTP code (Resend/SMTP email, MSG91/Twilio SMS, WhatsApp Cloud API with template names).
  - Delivery: every attempt is recorded in `notification_deliveries` (status, provider id, error, retries). Consent is checked per purpose (transactional, operational, coaching, promotional), with quiet hours in branch timezone, dedupe keys, and an opt-out re-check at send time.
  - Consumers: automations, dunning and broadcasts use the service. The Automations UI shows each channel's real availability.
- **Member messaging:** start a thread with my coach or my branch's front desk (topic picker); outside-hours expectation copy from branch hours (UX-M12); image/PDF attachments via P05 media storage with signed URLs. Minors: staff↔minor direct threads refused unless the tenant enables them (decision 16). The admin "Inbox" (in Support, or its own module per `navFor`) adds assignment, read state, reply and internal notes stored in a separate table, never serialized to members. Queued messages stay visible in the member thread after navigation (fixing the current component-state loss).
- **Community:**
  - Members: comments on posts, report, block and mute; blocked users' content hidden both ways; rate limits on posts and comments; tenant "approval mode" (posts wait for approval); minors have no public profile.
  - Admin "Community" module: reports queue with context, hide/remove with reason (audited; author notified in-app), restore, block member from community, and approval queue.
- **Tasks (admin module):**
  - Sources: generated from operational alerts (lead SLA breach, failed payment, at-risk member, safety work order, overdue waitlist offer) with idempotent generation keys; manual tasks.
  - Fields: assignee, due date, priority, status, link to source, outcome. Actions: "Create task" from Command Center alerts and member/lead detail.
  - Status strip: wire the unused `alertCount` and show "My tasks" in the strip.
- **Nutrition & Habits (coach view):** trainers see assigned members' habit adherence and weekly check-ins, assign habit templates, and leave feedback. Members submit a weekly check-in (adherence, energy, hunger, sleep, soreness, mood, notes) if none exists. Free text passes through the existing safety scanning, which routes concerning content (injury, disordered eating, medical symptoms) to the coach with plain copy and never to analytics. Module opt-out respected (PF-NUTR-006).
- **Broadcasts (Marketing, within Automations or its own module per `navFor`):**
  - Targeting: a one-off message to a segment (status, branch, tags, last visit, membership end window). Recipient preview shows counts excluded by consent, quiet hours and opt-out, plus estimated metered cost per channel from a configurable rate table.
  - Controls: owner approval required above a configurable recipient threshold; dry run; send through the service; delivery outcome report.
- **Quick add member (walk-in):** in Members, a short form (name, phone, optional email, branch, optional plan) with duplicate detection, reusing the enrollment service and activation issuance.
- **Command palette:** search members, leads, invoices, classes and staff (permission-aware, debounced, server-backed) plus actions (Add member, Record payment, Check in member, Create class, New task). ARIA combobox/listbox semantics, arrow/Enter/Escape keyboard handling, recent items.
- `navFor` updated so new modules are permission-aware. Reception still sees ≤ 7 modules (test).

Out: AI drafting, campaign attribution beyond delivery counts, group chats beyond the existing announcement model, live video chat.

### Acceptance criteria
1. Channel tests: the `log` driver records a delivery with status `logged`; real drivers (configured against local fake servers) record provider ids and handle 4xx/5xx with bounded retries; an opt-out after queueing prevents the send (PRD 01 PF-COMM edge case); a missing template variable prevents the send and records why; quiet hours defer; a network guard proves no real provider host is contacted.
2. Messaging tests: a member starts a coach thread and a front-desk thread; the minor rule refuses by default; internal notes never appear in any member-facing payload (a test scans member responses for the note text); attachments use signed URLs and enforce authorization.
3. Community tests: report → queue → remove → hidden for all and author notified; block hides content both ways including in shared groups (PRD 04 edge case "Blocked users remain in a group"); rate limit → 429; approval mode holds posts.
4. Task tests: alert-generated tasks are not duplicated across scheduler runs; assignment respects branch scope (404 outside scope); completing records an outcome; the status-strip count matches.
5. Coach view tests: a trainer sees only assigned members (PF-STAFF-005); a check-in with a safety phrase creates a coach flag and no analytics event; members who opted out are excluded.
6. Broadcast tests: preview counts equal the actual recipients after exclusions; above the threshold, sending is blocked until an owner approves; a dry run creates no deliveries; the cost estimate equals recipients × rate per channel.
7. Quick add: duplicate phone/email is detected with a link to the existing member; the created member can be activated.
8. Palette: E2E keyboard-only test opens it with Ctrl/Cmd+K, types a member name, arrows to the result, presses Enter and lands on the member detail. The "Record payment" action opens the payment flow. Axe shows no violations on the palette.
9. Every new screen has loading, empty, error, permission and offline states with component tests, and E2E covers each module's primary flow. Standard gates and `pnpm e2e` pass.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p07-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p07-test.log
pnpm -F @shark/api test -- notification messaging community task coach broadcast palette
pnpm build && pnpm e2e
```
Passing: all green; no outbound request to real provider hosts in any test.

### Dependencies
P06 (step-up for broadcast approval and exports, CSP for new UI), P05 (media for attachments), P04 (push channel).

### Risks
- This is the widest phase. Build in the order channels → messaging → community → tasks → coach view → broadcast → palette → quick add, commit after each, and if time runs short mark the tail items blocked with reasons rather than shipping half-states.
- Real-driver code paths can only be tested against fakes. Never put real credentials in tests and never call real hosts.

## Phase P08: Full test pass: route coverage, critical scenarios, Playwright E2E for every app

### Goal
Prove the whole product with tests: every API route exercised by an integration test against a real migrated database, every PRD-mandated critical scenario mapped to a named test, unit/component tests for every screen, and a Playwright suite covering the main flows of the website, member app and admin console on desktop, tablet and phone. Fix the bugs these tests reveal.

### Why
PRD 02 §14 (test layers, mandatory critical scenarios, deterministic fixtures, CI steps 7–10), PRD 01 "Product-level acceptance scenarios" and "Functional Definition of Done", PRD 04 "Enterprise edge-case … catalog" ("Each item must map to an automated test …"). Before this plan there was no E2E at all, and many screens have no tests.

### Scope
In:
- **Route coverage:** `pnpm -F @shark/api test:route-coverage` enumerates registered routes (reuse `scripts/postman/list-routes.ts` logic) and the routes hit during the integration run (request-log or `app.request` instrumentation). It writes `apps/api/route-coverage.json`, fails on any uncovered route not in a justified exceptions list (≤ 5 entries, each with a reason), and runs in CI.
- **Authorization matrix:** a data-driven test proves, for every admin route, that a role without the permission is refused and that another tenant's ids return 404 (PRD 05 §3.7 items 3–4).
- **Critical scenarios:** every PRD 02 §14.2 scenario and every feasible PRD 01 acceptance scenario (1–4, 6, 8, 10–14, 17, 18, plus 5, 9, 16, 19, 20 at integration level) has a test whose name carries the id (e.g. `[PRD01-S3]`, `[PRD02-14.2-QR-replay]`). `docs/TEST-STRATEGY.md` maps scenario → test file → layer, and lists any infeasible scenario with the reason (e.g. S15 video quota: video deferred).
- **Front-end tests:** component tests for the previously untested screens.
  - Admin: Command Center, Leads list, Plans, Billing, Schedule/Series, Staff/StaffDetail/Commission, Equipment, TrainingBuilder, Platform, Settings Branches/Privacy/Setup, Automations Templates/Runs, plus the screens added in P02–P07.
  - Member: Workout, Home, Habits, Conversation, Profile, Train, Progress.
  - Each asserts loading, empty, error and permission (and offline where relevant).
- **Playwright suite (`shark-fitness/e2e`):**
  - Projects: `desktop-1440`, `tablet-768` (admin), `pixel7` and `iphone13` (member, website).
  - Specs by app, tagged `@website`, `@member`, `@admin`:
    - Website: browse pages, trial lead appears in admin, SEO tags present.
    - Member: sign-in, Home, Pass QR, book/cancel, waitlist offer accept, workout offline sync, freestyle workout, Billing pay (Razorpay stub plus signed webhook), credit pack purchase and use, progress photo, messages, notifications, preferences, sign-out.
    - Admin: owner sign-in with MFA, member search via palette, Member 360, quick add, record manual payment, refund with step-up, payment link, reconciliation, Floor scan and desk check-in, schedule booking, leads pipeline and convert, plans edit, store sale, equipment work order, support reply, reports export with step-up, settings, automations dry run, broadcast approval, tasks, community moderation, platform impersonation banner, reception role nav (≤ 7 modules), cross-tenant URL shows not-found.
  - Isolation: specs that mutate data use their own seeded entities or run serially so the suite is parallel-safe.
  - Accessibility: `@axe-core/playwright` scans every page visited, written to `e2e/reports/a11y.json`. Reported, not gating; P11 makes it gating.
- **Concurrency/load:** `pnpm perf:concurrency` (new script; reuse `scripts/performance-baseline.mjs` patterns) runs 50 concurrent check-ins and 50 concurrent last-seat bookings against a production build: no overbooking, no duplicate check-ins, p95 < 500 ms locally (PRD 04 SLO). `pnpm perf:baseline` still passes.
- **Coverage:** Vitest v8 coverage per package. Thresholds are set to the measured values rounded down (a ratchet, not invented numbers) and enforced in CI.
- **CI:** the `e2e` job runs the full suite with retries=1, uploads HTML report, traces and the a11y JSON; a route-coverage step; a coverage step.
- **Bugs:** every product bug found is fixed with a regression test. Anything that needs design work goes to `docs/KNOWN-ISSUES.md` for P09/P10, with severity.

Out: native device farms, visual-regression baselines (font rendering differs across machines; P10 uses screenshots for audit evidence instead).

### Acceptance criteria
1. `route-coverage.json` shows 100 % of routes covered except the documented exceptions (≤ 5).
2. The authorization matrix test covers every admin route for at least reception, trainer and accountant plus a cross-tenant owner.
3. `docs/TEST-STRATEGY.md` maps every PRD 02 §14.2 scenario and PRD 01 scenarios 1–20 to a test or a stated reason. `git grep "\[PRD0"` finds the named tests.
4. Every admin and member screen file has at least one component test file asserting its states (a script lists screens without tests and must print none).
5. The Playwright suite covers the flows listed above (≥ 45 specs). `pnpm e2e` passes 3 consecutive full runs with zero flaky retries recorded.
6. `pnpm perf:concurrency` reports zero overbooking and zero duplicate check-ins, with p95 values written to `docs/PERFORMANCE-BASELINE.md`.
7. Coverage thresholds are configured and pass. CI workflow updated (validated with `actionlint`).
8. Standard gates pass. The test count is reported per package in the PR.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p08-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p08-test.log
pnpm -F @shark/api test:route-coverage
pnpm build && for i in 1 2 3; do pnpm e2e || break; done
pnpm perf:baseline && pnpm perf:concurrency
/tmp/actionlint ../.github/workflows/*.yml
```
Passing: route coverage complete; 3/3 green E2E runs; concurrency invariants hold.

### Dependencies
P07 (all features exist). P01 E2E harness.

### Risks
- Flaky E2E erodes trust fast. Use role/label locators, no fixed sleeps, explicit waits on network or realtime events, and per-spec data.
- The suite runtime may grow large. Shard by project in CI and keep the local run under ~10 minutes with parallel workers.

## Phase P09: Code review and fixes: security, correctness, performance, consistency

### Goal
An independent, whole-codebase review with every Critical and High finding fixed, and the rest either fixed or explicitly scheduled, recorded in a review report the client can read.

### Why
PRD 02 "Engineering review checklist" and Phase 12 ("Full threat model … dependency and secret review … Fix discovered issues rather than only documenting them"), PRD 04 ENT-SEC-001/002 (secure SDLC, input validation, SSRF, mass assignment, webhook forgery), and OWASP ASVS L2 as the stated web/API baseline. Seven phases of new code landed since the last full review.

### Scope
In:
- **Report:** `docs/reviews/CODE-REVIEW-2026-11.md` with a findings table (id, area, severity Critical/High/Medium/Low, file:line, description, evidence, fix commit or rationale) and an ASVS L2-oriented checklist with pass/fail per control family.
- **Security review:**
  - Session, auth and CSRF: session/cookie flags, CSRF and Origin checks on every state-changing route (an automated test enumerates mutating routes without CSRF coverage).
  - Rate limits on every unauthenticated endpoint.
  - Access control: IDOR (a test enumerates every `:id` route and asserts 404 with another tenant's id), mass assignment (every body schema `.strict()` or explicitly picked).
  - Inputs and outbound calls: file upload paths, SSRF (webhooks, any URL input), webhook verification paths (Razorpay, outbound), redirect/open-redirect checks on sign-in "return to" parameters.
  - Secrets and logging: secrets in logs (redaction tests over new log sites), error messages leaking internals.
  - Supply chain and image: `pnpm audit --prod` (no High/Critical left unaddressed; document any unfixable with mitigation), secret scan over full git history with a pinned `gitleaks` binary (no real secrets; demo/test fixtures allowlisted with justification), Docker image review (non-root, no build tools, minimal env).
- **Correctness review:** dead and duplicate code (remaining stabilization shadows, unused exports such as `ImpersonationBanner`, the dead JSX line in `shell.tsx`); query-key consistency across both SPAs (one key factory per resource); the contradictory Platform comment; transaction boundaries around money and seats; timezone use (`lib/branch-time.ts` everywhere instead of inline zone lookups); error codes match the PRD 02 canonical list; contracts are canonical (no client-side forks of server shapes added in P02–P07).
- **Formatting consistency:** one shared money/date/number formatting module (in `@shark/domain` or `@shark/design-tokens`; pick one and justify) replacing the four admin `money()` helpers, the member `rupees()` copies and mixed date locales. Negative amounts are rendered one way (`−₹1,234.00`), en-IN grouping, branch timezone for business dates.
- **Performance review:**
  - API: N+1 queries on hot endpoints; `EXPLAIN QUERY PLAN` tests for new P02–P07 queries (each uses an index beginning with `tenant_id`); `pnpm perf:baseline` and `perf:concurrency` within targets.
  - Front end: bundle budgets enforced in CI by a small script (member and admin initial JS ≤ 150 KB gzip each; website per P03; lazy chunks ≤ 60 KB gzip unless justified); React render hot spots in Workout and Store register (profiling notes).
- **Docs and code health:** reformat the 300–400-character single-line JSX blocks in the files listed in "Current state" when touched; update `docs/KNOWN-ISSUES.md`.

Out: new features, visual redesign (P10/P11), dependency major upgrades unless they fix a High/Critical vulnerability.

### Acceptance criteria
1. The review report exists with ≥ the checklist sections above. Every Critical and High finding has a fix commit and a regression test; every Medium is fixed or has a written rationale plus a follow-up in KNOWN-ISSUES.
2. The IDOR enumeration test, mutating-route CSRF test and strict-schema check pass and run in CI.
3. `pnpm audit --prod` shows no unaddressed High/Critical, and the gitleaks report shows no unallowlisted findings. Both outputs are summarized in the report.
4. Exactly one money formatter and one date-formatting module are used across website, member and admin (a lint rule or test forbids `toLocaleString('en-IN'` outside the module). Unit tests cover negative, zero, lakh/crore grouping and timezone edges.
5. The bundle budget script runs in CI and passes. Budgets are recorded in the report.
6. Query-plan tests pass for new hot queries. Perf scripts are within targets.
7. Standard gates, `pnpm e2e` and route coverage pass, with test counts not lower than P08's.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p09-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p09-test.log
pnpm audit --prod; /tmp/gitleaks detect --source /workspace/shark-fitness-repo --report-path /tmp/gitleaks.json
pnpm build && node scripts/check-bundle-budgets.mjs && pnpm e2e
pnpm -F @shark/api test:route-coverage && pnpm perf:baseline && pnpm perf:concurrency
```
Passing: all green and the report's Critical/High list fully resolved.

### Dependencies
P08 (the test net that makes refactors safe).

### Risks
- Review phases tend to sprawl into refactors. Fix what is wrong, not what is merely different, and keep each fix small with its test.
- `pnpm audit` may flag transitive dev-only issues. Separate production from dev exposure in the report.

## Phase P10: UI/UX and accessibility audit of every app (findings report)

### Goal
Produce a rigorous, evidence-backed UI/UX and accessibility audit of the website, member app and admin console against Design PRD 03, WCAG 2.2 AA and good practice. Deliver a severity-ranked findings report and a machine-readable findings file that P11 implements. This phase changes audit tooling and documentation only, not product code.

### Why
The client's top priority: "most importantly an audit of the UI/UX and user experience of all the apps". PRD 03 defines screen contracts (UX-A01…A15, UX-M01…M14), mandatory states, accessibility, responsive and performance-perception requirements and "Design QA gates". PRD 02 Phase 12 and PRD 04 enterprise gate 8 require an accessibility audit of critical web and mobile flows.

### Scope
In:
- **Audit tooling** under `shark-fitness/e2e/audit/`, run by `pnpm -F @shark/e2e audit` and not part of `pnpm test` or the gating `pnpm e2e`. It produces:
  - Screenshots of every route of the three apps at 1440×900, 1024×768, 768×1024, 390×844 and 360×800, in dark and light themes, plus compact density for the admin, into `/workspace/shark-fitness-orchestration/phases/P10-screens/` (PNG is git-ignored; reference paths).
  - Axe (WCAG 2.0/2.1/2.2 A and AA tags) per route per theme.
  - Computed contrast for every text and non-text token on every surface token, both themes, as a table.
  - Target-size measurement of all interactive elements (WCAG 2.5.8, and the PRD 03 44 px mobile minimum).
  - 320 px reflow and 200 % zoom checks (WCAG 1.4.10/1.4.4) and text-spacing override (1.4.12).
  - A reduced-motion run.
  - Forced states via route interception: loading (delayed), empty, error (500), permission (403), offline.
  - Accessibility-tree snapshots of key screens.
  - Lighthouse for website pages, member Home/Book/Workout and admin sign-in/Command Center.
- **Manual and expert review:**
  - Keyboard-only walkthroughs of PRD 01 scenario 17 (find member, record payment, book class, export report) and the member check-in, booking and workout flows (scenario 18 with reduced motion).
  - Screen-reader semantics review from the accessibility tree.
  - Nielsen heuristics per app.
  - Copy and microcopy review against PRD 03 "Content design" and the tone rules (`tone.ts`, `PLAIN_ONLY_SURFACES`).
  - Form validation review (labels above fields, errors linked, summaries on long forms, input preserved).
  - Navigation/IA review against PRD 03 §3. Member bottom nav vs the PRD's "Home, Train, Book, Progress, More/Community": recommend with evidence.
  - Performance-perception review: skeletons match layout, CLS, tap feedback within 100 ms, route transitions.
  - Visual consistency with `docs/DESIGN.md` (seams, zero radius, type roles, one accent).
- **Per-screen contract review:** for each UX-A and UX-M spec and each website page, a section covering the dominant user job, information hierarchy, primary actions, every mandatory state (present / missing / partial with evidence), and acceptance requirements.
- **Deliverables:**
  - `shark-fitness/docs/ux-audit/UX-AUDIT.md`: method, coverage table, executive summary, top 10 issues, a score per app per dimension, per-screen sections, and the full findings table.
  - `shark-fitness/docs/ux-audit/findings.json`: array of `{id: "UX-ADM-001" | "UX-MEM-001" | "UX-WEB-001", app, route, screen, prdRef, wcag: ["1.4.3"], severity: "blocker|major|minor|polish", title, evidence: {screenshot, selector, measurement}, recommendation, effort: "S|M|L", status: "open"}`.
  - `docs/ux-audit/contrast.md` and `docs/ux-audit/axe-summary.md`.
- **Severity definitions** (write them into the report):
  - Blocker: prevents completing a critical task, or fails WCAG A/AA on a critical flow.
  - Major: significant friction, a missing mandatory state, or WCAG AA failure off critical flows.
  - Minor: inconsistency or polish affecting comprehension.
  - Polish: aesthetic.
- **Known starting points to verify, not assume:** foam-35/25 contrast; missing skip link and `<main>`; palette semantics (if P07 did not fully fix them); unlabeled controls; `window.prompt` on Floor; no toast or persistent feedback pattern; nested interactive elements in member Home/Train; `Segmented` roles; dialog focus traps; route-change focus; targets under 44 px; the dev-only sign-in error copy.

Out: fixing anything (P11), redesigning the brand direction (Sonar is fixed by DESIGN.md).

### Acceptance criteria
1. The audit tool runs end to end with one command and exits 0. Its outputs exist at the stated paths, and every route of the three apps appears in the coverage table with its screenshot set.
2. UX-AUDIT.md has a section for each of UX-A01…A15 and UX-M01…M14 (stating "not applicable" with a reason where a screen does not exist) and for each website page, with every mandatory state from PRD 03 evaluated.
3. Every finding in findings.json has evidence (a screenshot path and selector or measurement) and a PRD 03 or WCAG reference. Severity counts in the summary match the JSON (a small script validates the schema and counts).
4. The contrast table covers all text tokens on all surfaces in both themes and flags every pair below 4.5:1 (3:1 for large text and non-text).
5. Keyboard walkthroughs of scenario 17 and the member flows are documented step by step with pass/fail per step.
6. No product source files changed (`git diff <base> --stat` shows only `e2e/audit/**`, `docs/ux-audit/**`, and package.json script lines).
7. Standard gates and `pnpm e2e` still pass.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm build && pnpm -F @shark/e2e audit
node e2e/audit/validate-findings.mjs docs/ux-audit/findings.json   # schema + counts
git diff phase/P09-code-review --stat
pnpm typecheck && pnpm lint && pnpm test > /tmp/p10-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p10-test.log; pnpm e2e
```
Passing: the audit completes, the validation script prints counts matching the report, and the diff is limited to audit tooling and docs.

### Dependencies
P09 (the reviewed, stable product).

### Risks
- Automated tools find perhaps 30–40 % of accessibility issues. The manual keyboard and semantics review is mandatory, not optional.
- An audit that lists everything as "minor" is useless to P11. Apply the severity definitions strictly and lead with the top 10.

## Phase P11: Implement the UI/UX audit fixes and gate accessibility in CI

### Goal
Fix the audit's findings across all three apps, with every Blocker and Major resolved, and make accessibility and contrast regressions impossible to merge silently.

### Why
The audit (P10) is only valuable if acted on. PRD 03 "Design QA gates" and "Accessibility" (WCAG 2.2 AA target), PRD 01 scenarios 17–18, and PRD 04 enterprise gate 8 ("Accessibility audit for critical web and mobile flows") require the fixes plus ongoing checks.

### Scope
In:
- **Fixes:** work `shark-fitness/docs/ux-audit/findings.json` in severity order: all `blocker` and `major`, then `minor`, then `polish` as time allows. Update each finding's `status` (`fixed` with commit sha, or `wontfix` with a reason; `wontfix` ≤ 10 % of minor findings and never for blocker/major).
- **Design tokens:** where contrast fails, adjust tokens in `packages/design-tokens` (both themes) without breaking the Sonar direction (e.g. raise the foam alpha steps used for text, reserve low alphas for hairlines and decoration). Update `docs/DESIGN.md`. Add a token contrast unit test that computes the ratios.
- **Shared primitives:** fix issues at the primitive level where possible (Field, Button, Segmented → radio group semantics, Dialog/Sheet focus trap, Toast/live region, PermissionState, EmptyState, Skeleton, the shell's skip link and `<main>`, route-change focus and title updates) so every screen benefits. Add a consistent toast/status pattern for non-critical confirmations; critical results stay in page state (PRD 03 "Feedback and status").
- **Accessibility gating:** turn on gating in the E2E suite — any `serious` or `critical` axe violation on any visited page in either theme fails the run. Add keyboard E2E for PRD 01 scenario 17 and reduced-motion E2E for scenario 18. Add a target-size check in the E2E suite (member primary controls ≥ 44 px; everything ≥ 24 px per WCAG 2.5.8).
- **Evidence:** re-run `pnpm -F @shark/e2e audit` and add a "Resolution" section to UX-AUDIT.md with before/after counts per severity and per app, plus before/after screenshots for every blocker/major in `/workspace/shark-fitness-orchestration/phases/P11-screens/`.

Out: new features, brand redesign.

### Acceptance criteria
1. findings.json has zero `open` blocker or major findings, and minor `wontfix` ≤ 10 % with reasons. The validation script prints the final counts.
2. The token contrast test passes: all text tokens ≥ 4.5:1 on their surfaces (≥ 3:1 for large text and non-text UI) in both themes.
3. The E2E suite fails on serious/critical axe violations and passes as delivered. Scenario 17 keyboard and scenario 18 reduced-motion specs pass.
4. The target-size check passes on member and admin routes.
5. A re-run of the audit shows the before/after reduction recorded in UX-AUDIT.md "Resolution".
6. No functional regressions: standard gates, `pnpm e2e` (3 consecutive green runs) and route coverage pass, and bundle budgets still pass.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
cd /workspace/shark-fitness-repo/shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p11-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p11-test.log
pnpm build && node scripts/check-bundle-budgets.mjs && for i in 1 2 3; do pnpm e2e || break; done
pnpm -F @shark/e2e audit && node e2e/audit/validate-findings.mjs docs/ux-audit/findings.json
```
Passing: zero open blocker/major findings, accessibility-gated E2E green 3×, and the audit re-run recorded.

### Dependencies
P10 (findings.json and audit tooling).

### Risks
- Token changes ripple across every screen. Change tokens first, re-screenshot everything, then fix per-screen leftovers.
- Gating on axe can be noisy with third-party iframes (Razorpay). Scope the scans to our own DOM and document the exclusion.

## Phase P12: Release candidate verification and client handover

### Goal
Deliver a verified release candidate and a handover pack the client can act on while travelling: everything proven from a clean checkout, honest documentation of what is done, partial and deferred against every PRD requirement ID, runbooks, and a precise list of what the client must provide or decide.

### Why
PRD 02 "Definition of verified completion" and Phase 12 deliverables (release candidate, runbooks, backup/restore evidence, customer onboarding guide); PRD 04 ENT-BCP-002 (runbooks), §18 "Commercial Launch Checklist"; PRD 01 "Never claim compliance, performance, or completion without evidence".

### Scope
In:
- **Clean-checkout verification:** fresh clone of the final branch into a temp dir, then the Node 22 bootstrap, `pnpm install --frozen-lockfile`, typecheck, lint, test, build, `pnpm e2e`, route coverage, `pnpm db:backup:verify`, perf scripts, bundle budgets and Lighthouse on the website. Results are recorded in `docs/RELEASE-CANDIDATE.md` with exact counts, durations, the commit sha and the Node/pnpm versions.
- **`docs/PRD-TRACEABILITY.md`:** every requirement ID in PRD 01 (PF-*), PRD 04 (ENT-*) and the PRD 03 screen IDs (UX-A*, UX-M*), each with status Done/Partial/Deferred, evidence (test names, files, docs) and the reason for Partial/Deferred. Cross-check against "Deferred PRD scope" in PHASE-PLAN.md.
- **`docs/HANDOVER.md`** (written for Aman):
  - What was built, by app, with screenshots referenced.
  - How to run locally and how the pilot host works (PR #27 scripts).
  - The demo script (update `PILOT-TEST-AND-DEMO.md`).
  - Every environment variable, with required/optional, default and where to obtain it.
  - What the client must provide: domain and DNS; Razorpay KYC and live keys (and the code change that allows live mode); VAPID keys; Play Console account and app signing; SMTP/SMS/WhatsApp provider accounts and templates; backup bucket and age key custody; error-reporting DSN; uptime and alert accounts; real photography and copy approval; counsel review of privacy/terms/DPDP notices; GST invoice wording review by an accountant.
  - Decisions taken on their behalf (link to PHASE-PLAN decisions and ADRs).
  - Known limitations and deferred scope; recommended next phases with rough effort.
- **Runbooks** in `docs/runbooks/`: incident severity and roles (PRD 04 SEV model), auth outage, database corruption and restore (from local and off-site), payment webhook failures and reconciliation, notification provider outage, realtime degradation, disk full/media storage, lost server (rebuild from PR #27 scripts and off-site backup), secret rotation (pass secret, MFA key, Razorpay, VAPID, webhook secrets).
- **Truthful status updates:** README (offering, URLs `/`, `/app/`, `/admin/`), `PRODUCTION-READINESS.md`, PRD 05's status header, `context.md`, and a CHANGELOG for this engagement. Remove or correct any statement that is no longer true.
- **Demo data:** the seed exercises the new features (website leads, waitlist offer, credit packs, test-mode Razorpay payments clearly labelled TEST, tasks, community report, MFA-enrolled demo owner per P06's approach). `pnpm db:reset` docs warn about the default DB.
- **Final screenshot set** for the client at the four key viewports in `/workspace/shark-fitness-orchestration/phases/P12-screens/`.

Out: deploying, creating accounts, merging PRs, real-device or human acceptance claims.

### Acceptance criteria
1. `docs/RELEASE-CANDIDATE.md` records a clean-clone run of every command listed above, all passing, with counts.
2. `docs/PRD-TRACEABILITY.md` lists every PF-* and ENT-* id from PRDs 01 and 04 (a script extracts the ids from the PRDs and verifies none are missing) and every UX-A/UX-M id.
3. HANDOVER.md contains every section listed, and every env var in `.env.example` appears in its table (script-checked).
4. All runbooks exist, each with detection, immediate actions, recovery steps, verification and communication sections.
5. README, PRODUCTION-READINESS, PRD 05 header, context.md and CHANGELOG are updated, and `git grep -n "TODO\|FIXME"` shows nothing introduced by this engagement.
6. Standard gates, `pnpm e2e` and `git diff --check` pass on the final commit.

### How to verify
```bash
export PATH=/home/box/opt/node22/bin:$PATH COREPACK_HOME=/home/box/.corepack   # after the Node 22 bootstrap
RC=$(mktemp -d) && git clone /workspace/shark-fitness-repo "$RC/repo" && cd "$RC/repo" && git checkout phase/P12-release-handover && cd shark-fitness
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test > /tmp/p12-test.log 2>&1; grep -E "Test Files|Tests " /tmp/p12-test.log
pnpm build && pnpm e2e && pnpm -F @shark/api test:route-coverage && pnpm db:backup:verify && pnpm perf:concurrency && node scripts/check-bundle-budgets.mjs
node scripts/check-traceability.mjs && node scripts/check-handover-env.mjs
git diff --check
rm -rf "$RC"
```
Passing: everything green from a clean clone; traceability and handover checks print no missing ids or vars.

### Dependencies
P11 (the final product state).

### Risks
- The temptation at the end is to round "partial" up to "done". The traceability matrix must be evidence-based. PRD 01's governance forbids claiming completion without evidence, and the client will rely on it.
