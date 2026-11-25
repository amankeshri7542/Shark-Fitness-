# P06 notes — Staff security: MFA, step-up auth, sessions, CSP, outbound webhooks

Branch `phase/P06-staff-security` from `phase/P01-prod-readiness` (128aec1). Worktree `/workspace/sf-wt/P06`. Node 22.23.5, pnpm 10.28.0.
Baseline on this branch before any change: API 889 tests / 65 files, admin 295/38, member 40/11, domain 271/12, contracts 6/1 — all green.

## Plan

1. **Contracts + config.** Error codes `STEP_UP_REQUIRED` and `MFA_REQUIRED` (401). Event topic `integration.event`. MFA/session/security-settings/webhook schemas. Config: `SHARK_MFA_ENCRYPTION_KEY` (32 bytes base64, required in production; fixed development key otherwise), `SHARK_CSP_REPORT_ONLY`.
2. **One migration (0018)**, new schema file `security.ts`: `user_mfa`, `mfa_recovery_codes`, `webhook_endpoints`, `webhook_deliveries`, `webhook_attempts`; `sessions` gains `mfa_state`, `reauthenticated_at`, `last_active_at`.
3. **MFA**: `lib/field-encryption.ts` (AES-256-GCM, HKDF per purpose), `services/mfa.ts` on `otpauth`. Sign-in (password, OTP, activation) creates a *partial* session (`challenge` or `enrol`) for staff who must use MFA; `authenticate` refuses partial sessions with 401 `MFA_REQUIRED`; `/v1/auth/mfa/*` uses `authenticatePartial`. Token rotates when the session becomes full. Replay protection (a TOTP step is accepted once), per-user lockout after 5 failures (15 min) with audit, IP rate limit. Owner-assisted reset (`/admin/staff/:id/mfa/reset`), platform-support reset (`/platform/tenants/:t/users/:u/mfa/reset`), both with reason, step-up and audit.
4. **Step-up**: `requireFreshAuth(ctx, 300)` + `POST /v1/auth/step-up` (password + TOTP when enrolled; impersonated sessions re-prove the *operator*). Guarded: refunds (invoice payments, POS returns), write-offs (invoice void), staff create/role/branch/state changes, report export, member bulk export, privacy export package, privacy deletion acceptance and erasure, impersonation start, webhook secret reveal/rotate/create, MFA disable/recovery regeneration, MFA resets. Denials audited with redacted metadata.
5. **Sessions**: staff idle timeout from tenant policy `staffIdleTimeoutMinutes` (15–240, default 30) measured on *user activity* (`last_active_at`: unsafe requests + an activity heartbeat; background GETs and realtime tickets do not count), absolute 12 h; members 30-day sliding. Expiry answers 401 with `details.reason`. "Your devices": list, revoke one, sign out everywhere else.
6. **Console**: sign-in MFA step + enrolment gate; one step-up dialog wired into `api()` that retries the original request with the same idempotency key; global 401 handler with "Session expired" dialog that keeps the URL; idle warning 2 min before expiry; `/account` (two-step sign-in + devices); Settings → Security (staff MFA policy, idle timeout, staff MFA status + reset) and Settings → Integrations (webhooks).
7. **CSP**: per-surface policies (`admin`, `member`, `website`, `api`) from one config module, set by `securityHeaders` by path; `/v1/csp-reports` (rate-limited, forwarded to the error reporter). Self-host fonts (Google Fonts would violate `font-src 'self'`/`style-src 'self'`), move the console's inline service-worker script into the bundle. `camera=(self)` only on `/admin/*`.
8. **Webhooks**: business sites call `emitIntegrationEvent()` inside their transaction (outbox row on the `integrations:<tenant>` channel, never subscribable by sockets); job `deliver-webhooks` fans out per endpoint (cursor per endpoint) and delivers with backoff (1m, 5m, 30m, 2h, 6h, 12h, then 24h cap) via `node:https` with a validating `lookup` (pins the checked IP), no redirects, 5 s timeout, 64 KB read cap. HMAC `Shark-Signature: t=,v1=` with 24 h dual-signing on rotation. Endpoint disabled after 15 consecutive failed attempts with an owner notification + Command Center alert. Replay, test send, delivery log.
9. **Tests**: integration (mfa, step-up, session, csp, webhook), redaction, admin component tests, e2e specs with a CSP violation listener on every spec.
10. **Docs**: `docs/SECURITY.md`, `docs/ADR-004-mfa-totp.md`, `.env.example`, README.

## Checklist (mirrors P06-progress.json)

1. MFA integration tests (gate, enrol, challenge, rate-limit/lock, recovery once, disable needs step-up, ciphertext at rest, tenant require-all-staff gates reception, members never challenged).
2. Step-up data-driven route test + admin dialog component test (same idempotency key).
3. Session tests (idle, absolute, member sliding) + admin E2E (expired dialog returns to URL; device revoke → other session 401).
4. CSP: header test per surface; every E2E spec asserts zero violations.
5. Webhook tests (signature, retry schedule, disable + alert, replay, rotation dual-sign, SSRF refusals, payload exclusions).
6. Admin UI (MFA enrolment, devices, integrations) with loading/empty/error/permission states + component tests.
7. Audit entries for MFA/step-up/webhooks; secret redaction test.
8. Docs + ADR-004; standard gates + `pnpm e2e`; demo owners gated on first sign-in; E2E TOTP from a seeded test secret.
9. Remove shadowed `POST /auth/otp/verify` in `auth.ts`; verify `/platform/impersonate/end` authorization.
10. PR description `pr/P06.md`.

## Decisions and assumptions

**MFA**
- **TOTP via `otpauth` 9.6.0** (zero dependencies, widely used); no hand-written TOTP. SHA-1/6 digits/30 s for authenticator compatibility. ADR-004 records why passkeys are deferred.
- **Partial sessions** rather than a separate challenge token: a password sign-in for staff who owe MFA creates a session in state `challenge` or `enrol` that only `/v1/auth/mfa/*`, `/v1/auth/csrf` and sign-out accept (401 `MFA_REQUIRED`, `details.state`). It lasts 15 minutes and the token is replaced when MFA completes. Same cookie/CSRF machinery, no new token type.
- **Replay protection** (each code accepted once, NIST 800-63B 5.1.4.2) even though the spec did not ask; it forced test helpers to reset the marker (API tests) or wait for the next step (e2e), both documented.
- **Lockout:** 5 consecutive wrong codes (TOTP or recovery) lock the factor 15 minutes; audited as `auth.mfa_locked` (the "failure burst"). Plus 10/min per IP on verify.
- **Encryption:** one master key `SHARK_MFA_ENCRYPTION_KEY`, HKDF-split per purpose (`mfa-totp`, `webhook-secret`), AES-256-GCM with the owning row id as AAD. Development uses a published fixed key; production refuses to boot without a 32-byte key.
- **Disable:** allowed for anyone after step-up; for a role/gym that requires MFA the session drops straight back to the enrolment gate (the UI calls it "Move to a new phone").
- **Successful code sign-ins are logged, not audited** (password sign-ins never were; the backup/restore proof treats audit rows written by a read-only sign-in as drift). Enrol, disable, lockout, recovery-code use, regeneration and resets are audited.
- **"Flagged" demo owners:** no per-user column; the gate is derived from role (owner/regional manager/platform roles) or the gym setting, so seeded owners have MFA off and meet the gate on first sign-in, as required.
- Owner-assisted reset is owner-only (not regional managers) and never for oneself; platform support reset uses `platform.impersonate` permission plus step-up.

**Step-up**
- Signing in counts as a fresh authentication (5 minutes). During impersonation the *operator* re-proves.
- Guarded set (see docs/SECURITY.md matrix): refunds incl. POS returns, invoice void (= write-off), staff create (a role grant) and role/branch/account-state changes (not name/phone edits), report export, member bulk export, privacy export build **and read**, deletion-request acceptance, erasure, impersonation start, MFA disable/regenerate/resets, security-settings changes, webhook create/URL change/secret reveal/rotate. Guards were placed on the *mounted* handlers (`billing-stabilization.ts`), not the shadowed ones in `billing.ts` that P02 is deleting.
- A wrong step-up password is 422 (not 401) so the console does not mistake it for an ended session.

**Sessions**
- Idle = no *person* at the keyboard: only unsafe requests and a heartbeat driven by real input move `last_active_at`; background reads and realtime tickets do not. Otherwise the polling Command Center would never time out.
- Existing sessions get the 12 h absolute limit on deploy (older staff sessions end at next request). Members keep the old 30-day cookie, now sliding.
- "Sign out everywhere" keeps the current device (the usual meaning); sign-out itself ends this one.

**CSP**
- One config module (`lib/csp.ts`) with per-surface policies chosen by path; `/` is classified as the member app on this branch (`ROOT_SURFACE`). Razorpay only on the member surface. Razorpay does not publish an allowlist (checked their docs; a web search found regional hosts like `api-sg.razorpay.com` in captures) — P02's sandbox E2E must confirm.
- No `'unsafe-inline'` needed: React styles go through the CSSOM. To get there: **fonts self-hosted** (`@fontsource/*` 5.3.0, OFL, latin + latin-ext woff2 only) instead of Google Fonts, and the console's inline SW-recovery script moved into the bundle. Member precache grew 589 → 826 KiB (the fonts; they were runtime-cached from Google before).
- Explicit `ws(s)://` origins in `connect-src` for older Safari, which did not match WebSockets with `'self'`.
- `/v1/csp-reports` is exempt from Origin/CSRF checks (browsers send reports without them); it stores nothing, is capped and rate-limited.

**Webhooks**
- Driven from the outbox: business sites call `emitIntegrationEvent` in the same transaction (channel `integrations:<tenant>`, which no socket may join); each endpoint keeps an outbox cursor; the `deliver-webhooks` job fans out and delivers. A new endpoint receives events from its creation on.
- Backoff 0, 1 m, 5 m, 30 m, 2 h, 6 h, 12 h (7 attempts, ≈20.6 h), give up within 24 h. **N = 15** consecutive failed attempts disables the endpoint (owner in-app notification, audit, Command Center `integration_down` alert); turning it back on resets the counter and sends the backlog.
- Payloads carry ids/states/amounts only — no contact details either (DPDP minimisation; there is no public API yet for an integration to look a member up with the gym's permission). A key filter drops forbidden fields at emit time.
- SSRF: resolve once, check every address, connect to the checked IP (defeats DNS rebinding), `node:https` with SNI to the hostname, `agent: false`, no redirects. Loopback/http allowed outside production only (tests).
- Create/URL change/reveal/rotate need step-up (a new outbound channel is an exfiltration path). Test sends are one attempt, never retried, and do not count towards disabling.
- The scheduler gained async-job support (job may return a promise; no overlapping ticks); the existing sync jobs are unchanged.

**Other**
- Removed the unreachable `POST /auth/otp/verify` from `auth.ts`; the stabilization handler (mounted first) now returns the shared sign-in response including `mfa.state`.
- `/platform/impersonate/end` authorization verified and tested: 401 signed out, 412 for an ordinary session, ends only the caller's own support session.
- Dependencies added: `otpauth` (API, e2e dev), `uqr` 0.1.3 (admin; tiny zero-dependency QR encoder, rendered as SVG squares so no `data:` image or inline style is needed), `@fontsource/anton|archivo|archivo-narrow` (design-tokens).
- Ops: `render.yaml` generates the key (Render's generated value is exactly 32 bytes base64); pilot `shark.env`/`provision.sh` create it and add it to an older env file; the restore drill passes the live key and reports `owner_mfa`/`owner_session`; CI image smoke passes a key and asserts the demo gate; `db:backup:verify` and `perf:baseline` enrol the owner through the API (and the backup proof now also proves MFA secrets survive restore under the same key); the CDP browser smoke signs in as the branch manager. `perf:baseline` got `SHARK_PERF_PORT` and now stops its server's process group (it used to hang after printing results); e2e got `SHARK_E2E_PORT`.
- Test helpers changed, not weakened: 51 `/v1/auth/password` calls in API tests go through `signInRequest`, which completes the real MFA challenge/enrolment; `pnpm test` enrols always-MFA seeded accounts with a test-only secret.

## Integration notes

What the integration session must wire up or verify on surfaces that are not on this branch:

1. **P03 (website at `/`, member app at `/app/`)** — `apps/api/src/lib/csp.ts`: set `ROOT_SURFACE = 'website'`. Check the Astro build has no inline scripts/styles (Astro inlines small styles and hoisted scripts by default: set `build.inlineStylesheets: 'never'` and avoid `is:inline` scripts, or the website policy will block them). Re-run `security-headers.spec.ts` with `/` = website and `/app/` = member. The member service worker under `/app/` is covered by `worker-src 'self'`/`manifest-src 'self'`.
2. **P02 (Razorpay)** — confirm `PAYMENT_CHECKOUT_SOURCES` against the live sandbox modal in the P02 E2E with the CSP listener on (watch for `api-sg.razorpay.com`, `cdn.razorpay.com` images inside the parent page, `lumberjack-cx`). Add `step-up` to the provider refund route and to payment-link creation if P02 adds new refund handlers (call `requireFreshAuth(ctx, 'billing.refund')` before any provider call). Emit `payment.failed` with `emitIntegrationEvent` where P02 records a failed provider payment (nothing on this branch produces one), and `payment.succeeded` is already emitted in the shared `applyPaymentToInvoice`. P02 deletes the shadowed handlers in `billing.ts`; this branch did not touch them. Also check `Cross-Origin-Opener-Policy: same-origin` (set in `lib/security.ts`) against Razorpay's popup-based methods (UPI intent, some netbanking/wallet flows open a window): P02's notes flag that it may need `same-origin-allow-popups` on the member surface.
3. **P04 (member PWA)** — keeps its own 401 handling; the API now sends `details.reason` (`idle`/`expired`/`revoked`) it may use. Members never get `MFA_REQUIRED`. The member app imports `@shark/design-tokens/fonts.css` in `main.tsx` and Google Fonts links were removed from `index.html`; P04's `index.html`/SW changes will conflict lightly — keep the fonts import and drop the dead `fonts.googleapis.com` runtime-caching rule. The admin `index.html` inline script moved to `src/lib/sw-recovery.ts`; if P04 replaces it with the admin service worker, keep it out of `index.html`.
4. **P05 (QR check-in camera)** — `camera=(self)` is already sent on `/admin/*` only.
5. **P07** — use `requireFreshAuth(ctx, 'broadcast.approve')` for broadcast approval and `requireFreshAuth(ctx, '<x>.export')` for any new export; the console dialog needs nothing more. Messaging attachments loaded from object storage will need their origin added to `img-src`/`connect-src` in `lib/csp.ts`.
6. **Migrations** — this branch adds `0018_staff_security.sql` (+ snapshot); renumber if another phase merges a 0018 first, then run `pnpm -F @shark/api db:check-drift`.
7. **Shared files touched (additions):** `packages/contracts` (`envelope.ts` error codes + event topic, `schemas/security.ts`, index export), `app.ts` (route mounts), `router.tsx` (account route, settings tabs, sign-in `redirect`), `ui/shell.tsx` (account link), `ui/overlay.tsx` (`dismissible` prop), CI workflow lines, root lockfile.

### E2E specs P08 should add
- Member app: every spec already runs under the CSP listener; add the Razorpay checkout stub spec (P02) under it.
- Admin: refund with step-up from Billing; staff role change with step-up; owner-assisted MFA reset from Settings → Security and the colleague's next sign-in meeting the gate; idle warning → "Stay signed in" (needs a test hook or a 15-minute idle setting plus DB ageing, as the screenshot script did); webhook delivery log/replay against a local receiver (needs a non-production server, because production refuses loopback).
- Platform: support resets an owner's MFA; impersonation start asks for step-up.
- The CSP listener in `support/fixtures.ts` watches pages of the spec's own `context`; a context made with `browser.newContext()` (the second device in `console-session.spec.ts`) is not watched. Route extra contexts through a fixture so they get the listener too.
