# Security baseline

This document describes the production security boundaries: the Phase 1 baseline below, and the staff-security layer added in P06 (two-step sign-in, step-up, session lifetimes, Content-Security-Policy, outbound webhooks). It is not a claim of certification or a substitute for a deployment security review or an independent penetration test.

## Threat model summary (P06)

| Threat | Most exposed asset | Control |
| --- | --- | --- |
| Stolen or reused staff password (phishing, reuse from another breach) | Owner and manager consoles: money, staff, member data | TOTP two-step sign-in, mandatory for owners, regional managers and platform staff; optional per gym for all staff ([ADR-004](ADR-004-mfa-totp.md)) |
| A console left signed in on a shared desk | Whatever that role can do | Staff idle timeout (gym-set, 15–240 min, default 30) measured on real activity; 12-hour absolute limit; "Your devices" with remote sign-out |
| A hijacked or unattended session used for a high-impact act | Refunds, write-offs, exports, erasure, role changes, impersonation, integration secrets | Step-up: password (and TOTP) again within the last 5 minutes |
| Guessing TOTP codes | Second factor | Each code accepted once; 5 wrong codes lock the factor for 15 minutes (audited); per-IP rate limit |
| Database or backup copy leaked | TOTP seeds, webhook secrets | AES-256-GCM with `SHARK_MFA_ENCRYPTION_KEY`, bound to the owning row; recovery codes stored as SHA-256 hashes |
| Script injection or a compromised third-party script | Every surface | Enforced per-surface CSP with no `'unsafe-inline'`/`'unsafe-eval'`, self-hosted fonts, violation reports |
| Webhooks used to reach internal services (SSRF) | Cloud metadata, internal network | https only; every resolved address checked and pinned; no redirects; 5 s, 64 KB caps |
| Forged or replayed webhook deliveries at the gym's receiver | The receiving system | HMAC-SHA256 signature over timestamp and body; event ids for de-duplication |
| Webhook payloads leaking personal data | Members | Minimal payloads: ids, states, amounts, timestamps; no names, contacts, health, photos or free text |

## Browser sessions

- The raw session token exists only in the `shark_session` HttpOnly cookie.
- Frontend JavaScript does not persist bearer tokens in `localStorage`.
- Unsafe cookie-authenticated requests require a double-submit CSRF token in both the `shark_csrf` cookie and `x-csrf-token` header.
- Unsafe requests with an `Origin` outside `SHARK_ALLOWED_ORIGINS` are rejected.
- Sign-out revokes the exact current session before clearing cookies.
- Bearer authentication is disabled in production unless `SHARK_ALLOW_BEARER_AUTH=true` is deliberately set for a controlled non-browser client.

## Tenant-scoped authentication

Password sign-in requires `tenantSlug`, and user lookup is constrained by both tenant and normalized email. OTP challenges are also created and verified within one tenant. This prevents the same email in another gym from being selected accidentally.

## OTP handling

OTP echo is disabled by default. It is available only outside production when `SHARK_ECHO_OTP=true` is explicitly configured. Production must connect an email/SMS provider before OTP login is enabled for real users.

## Entry passes and door readers

The member app receives a short offline batch of 30-second HMAC-signed pass tokens. It never receives the signing secret and cannot record its own check-in.

A physical reader calls `POST /v1/door/scan` with:

- `x-reader-id`
- `x-reader-key`
- the signed member pass token
- the reader's branch ID

Reader keys are configured in `SHARK_READER_KEYS_JSON` and are bound to one tenant plus an allowlist of branch slugs. A successful token window is burned transactionally; a replay is denied even when two readers race.

The current browser component is a token-derived visual transport, not a standards-compliant QR encoder. Before installing physical scanners, replace that view with a reviewed QR/Data Matrix encoder and provision reader credentials through a device-management process.

## Realtime

The browser exchanges its cookie session and CSRF token for a random, one-use WebSocket ticket that expires after 30 seconds. The long-lived session token never appears in the WebSocket URL. Channel authorization is still derived from the server-side session context.

The current realtime hub is single-process. Horizontal production deployment requires a shared event transport such as Durable Objects, Redis Streams, NATS, or an equivalent system.

## Offline writes

IndexedDB entries are keyed and queried by `tenantId:userId`. The processor stops on logout and refuses to continue a queue if the active owner changes during a flush. This prevents one person's offline workout writes from replaying under another person's cookie session on a shared device.

## Two-step sign-in (MFA)

Decision record: [ADR-004](ADR-004-mfa-totp.md).

- **Who.** Owners, regional managers, platform admins and platform support must use it (PRD 04 ENT-IAM-001). A gym can require it for all staff (Settings → Security → "Require two-step sign-in for all staff"). Members are never asked.
- **How.** TOTP (RFC 6238, SHA-1, 6 digits, 30 s) through the `otpauth` library. Enrolment shows a QR code and the setup key, and is confirmed with a first code. Ten single-use recovery codes are issued, shown once, and stored as SHA-256 hashes.
- **Sign-in.** A correct password gives staff who owe MFA a *partial* session: `challenge` (enter a code) or `enrol` (set it up; cannot be skipped). A partial session reaches only `/v1/auth/mfa/*`, `/v1/auth/csrf` and sign-out; everything else answers `401 MFA_REQUIRED` with `details.state`. It lasts 15 minutes. Completing the second step replaces the session token.
- **Guessing.** A code is accepted once (the last accepted time step is stored). Five wrong codes in a row lock the factor for 15 minutes and write `auth.mfa_locked`. `/v1/auth/mfa/verify` is also limited to 10 requests a minute per IP.
- **Secrets at rest.** The TOTP seed is AES-256-GCM ciphertext (`v1:<iv>:<tag>:<ciphertext>`) under a key derived (HKDF) from `SHARK_MFA_ENCRYPTION_KEY` for this purpose only, with the user id as additional data, so a ciphertext copied onto another account does not decrypt.
- **Lost device.** A recovery code signs in once. An owner can reset a colleague's two-step sign-in (Settings → Security, with a reason, after a step-up); the colleague is signed out everywhere and enrols again. An owner cannot reset their own: platform support does that (`POST /v1/platform/tenants/:tenant/users/:user/mfa/reset`, reason required, step-up, audited in the gym's own log) after checking identity out of band.
- **Audit.** `auth.mfa_enrolled`, `auth.mfa_disabled`, `auth.mfa_locked`, `auth.mfa_recovery_code_used`, `auth.mfa_recovery_codes_regenerated`, `auth.mfa_reset`. Successful code sign-ins are logged (`mfa_challenge_passed`), not audited, as password sign-ins never were.

## Step-up re-authentication

High-risk routes call `requireFreshAuth(ctx, action)` (`apps/api/src/lib/step-up.ts`): the session must have proved the password — and a TOTP code when the person has one — within the last **5 minutes**. Signing in counts. Otherwise the API answers `401 STEP_UP_REQUIRED` with `details: { mfa, maxAgeSec, action }`, and writes `auth.step_up_required` to the audit log with the action name only (never the request body). `POST /v1/auth/step-up` re-proves; `auth.step_up_succeeded` / `auth.step_up_failed` are audited. During a support session it is the *operator* who re-proves.

| Action | Route(s) | `action` |
| --- | --- | --- |
| Refund a payment | `POST /v1/admin/billing/payments/:id/refund` | `billing.refund` |
| Refund a store sale | `POST /v1/admin/store/orders/:id/refund` | `store.refund` |
| Write off (void) an invoice | `POST /v1/admin/billing/invoices/:id/void` | `billing.write_off` |
| Create a staff account (a role grant) | `POST /v1/admin/staff` | `staff.create` |
| Change a colleague's role, branches or sign-in state | `PATCH /v1/admin/staff/:id` with `role`, `branchIds` or `accountState` | `staff.access_change` |
| Export a report | `POST /v1/admin/reports/export` | `report.export` |
| Export members | `POST /v1/admin/members/bulk/export` | `member.export` |
| Build or read a privacy export package | `POST`/`GET /v1/admin/privacy/requests/:id/export` | `privacy.export` |
| Approve a deletion request | `POST /v1/admin/privacy/requests/:id/review` (`accept` on a deletion) | `privacy.deletion_approve` |
| Erase a member | `POST /v1/admin/privacy/requests/:id/erase` | `privacy.erase` |
| Start a support session (impersonation) | `POST /v1/platform/impersonate` | `platform.impersonate` |
| Reset someone's two-step sign-in | `POST /v1/admin/security/staff/:id/mfa/reset`, `POST /v1/platform/tenants/:t/users/:u/mfa/reset` | `staff.mfa_reset`, `platform.mfa_reset` |
| Turn off two-step sign-in / new recovery codes | `DELETE /v1/auth/mfa`, `POST /v1/auth/mfa/recovery-codes` | `auth.mfa_disable`, `auth.mfa_recovery_codes` |
| Change sign-in security settings | `PATCH /v1/admin/security/settings` | `settings.security` |
| Webhook: create, change URL, show or rotate secret | `POST /v1/admin/integrations/webhooks`, `PATCH …/:id` with `url`, `GET …/:id/secret`, `POST …/:id/rotate-secret` | `webhook.create`, `webhook.change_url`, `webhook.reveal_secret`, `webhook.rotate_secret` |

The console shows one "Confirm it's you" dialog for any of these and then sends the original request again unchanged — same body, same `Idempotency-Key` — so a refund cannot be recorded twice.

## Session policy

| | Staff | Members |
| --- | --- | --- |
| Lifetime | 12 hours from sign-in, absolute | 30 days, sliding (each use extends it) |
| Idle timeout | Gym setting, 15–240 min (default 30) | None |
| What counts as activity | Writes and the console's activity heartbeat (real key, pointer, wheel or touch input, at most once a minute). Background reads and realtime tickets do not | — |
| Partial (MFA owed) | 15 minutes | — |

An ended session answers `401 UNAUTHENTICATED` with `details.reason` = `idle`, `expired` or `revoked`. The console shows a non-dismissible "Session expired" dialog and returns to the same URL after signing in again; two minutes before an idle sign-out it shows a quiet warning with "Stay signed in". "Your account" (`/admin/account`, every role) lists live sessions with a device label, signs one out, or signs out everywhere else. The member app keeps its own 401 handling (P04).

## Content-Security-Policy

Served by the API on every response, per surface (`apps/api/src/lib/csp.ts` holds every allowed origin):

| Directive | Console `/admin/*` | Member app | Website | API `/v1/*` |
| --- | --- | --- | --- | --- |
| `default-src` | `'self'` | `'self'` | `'self'` | `'none'` |
| `script-src` | `'self'` | `'self' https://checkout.razorpay.com` | `'self'` | — |
| `frame-src` | `'none'` | `https://api.razorpay.com https://checkout.razorpay.com` | `'none'` | — |
| `connect-src` | `'self'` + `ws(s)://` of the configured origins | as console + `https://api.razorpay.com https://lumberjack.razorpay.com` | `'self'` | — |
| `style-src` / `font-src` | `'self'` | `'self'` | `'self'` | — |
| `img-src` | `'self' data: blob:` | `'self' data: blob:` | `'self' data: blob:` | — |
| always | `object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; manifest-src 'self'; report-uri /v1/csp-reports; report-to csp` | | | `frame-ancestors 'none'; base-uri 'none'; form-action 'none'` |

- **No `'unsafe-inline'`.** React's `style={{…}}` sets styles through the CSSOM, which CSP does not govern, so `style-src 'self'` holds. The console's one inline script moved into the bundle, and fonts are self-hosted (`@shark/design-tokens/fonts.css`), so no page talks to Google Fonts.
- **Razorpay.** Razorpay publishes no CSP allowlist. The origins above are what Standard Checkout loads and calls; the P02 sandbox E2E must confirm them against the live modal (Razorpay is known to serve some traffic from regional hosts such as `api-sg.razorpay.com`). Changing them is a one-line edit in `PAYMENT_CHECKOUT_SOURCES`.
- **`/` is the member app on this branch**; when the public website moves to `/` (P03) `ROOT_SURFACE` becomes `'website'`.
- **Reports.** `POST /v1/csp-reports` accepts the legacy and Reporting API formats (16 KB, 60/min per IP), logs `csp_violation` with the directive and the *origin* of what was blocked, and forwards it to the error reporter.
- **Rollout switch.** `SHARK_CSP_REPORT_ONLY=true` sends the same policy as `Content-Security-Policy-Report-Only`. The default is to enforce; every E2E spec fails on any violation.
- `Permissions-Policy`: `camera=(self)` only on `/admin/*` (the member-pass scanner); `camera=()` elsewhere.

## Outbound webhooks

Settings → Integrations (owners). An endpoint is an HTTPS URL plus a set of events: `member.created`, `member.updated`, `membership.activated`, `membership.cancelled`, `payment.succeeded`, `payment.failed`, `attendance.checked_in`, `attendance.checked_out`, `class.booked`, `class.cancelled`, `class.waitlist_promoted`, `workout.completed`, `lead.created`, `lead.converted` (and `webhook.test` from the test button).

- **Envelope** (`version` 1): `{ "id", "type", "version", "tenant": { "id", "slug" }, "occurredAt", "data" }`. `data` holds ids, states, amounts and timestamps only — never names, contact details, health or injury data, photos, notes or other free text (enforced by a key filter in `services/integration-events.ts`).
- **Headers:** `Shark-Signature`, `Shark-Event-Id`, `Shark-Event-Type`, `Shark-Delivery-Id`, `User-Agent: SharkFitness-Webhooks/1`.
- **Signature:** `Shark-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. For 24 hours after a secret rotation a second `v1=` carries the old secret's signature.
- **Delivery:** from the outbox by the `deliver-webhooks` job (every 30 s). Retries after 1 min, 5 min, 30 min, 2 h, 6 h and 12 h; a delivery still failing 24 h after it was created is given up. Fifteen failed attempts in a row turn the endpoint off, notify the owners in the app, write `webhook.endpoint_disabled` and raise a Command Center alert. Each attempt is logged (status, latency, first 1 KB of the answer); any delivery can be replayed with the same event id.
- **SSRF:** https only in production (http and loopback are allowed only outside production, for tests); the host is resolved and *every* address is checked against private, loopback, link-local (including `169.254.169.254`), carrier-grade NAT, documentation, multicast, reserved and unique-local ranges, and IPv6 forms that carry an IPv4 address (mapped, compatible, translated, 6to4, NAT64) are judged by that address or refused, and the connection is made to the checked address; redirects are not followed; 5-second timeout; at most 64 KB of the answer is read.
- **Secrets** are `whsec_…`, AES-256-GCM encrypted at rest (its own HKDF purpose), shown once on creation, and shown again or rotated only after a step-up (`webhook.secret_revealed`, `webhook.secret_rotated` audited).

Verifying a delivery (Node.js):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

/** rawBody: the request body exactly as received (a string or Buffer), before JSON parsing. */
export function verifySharkWebhook(rawBody, signatureHeader, secret, toleranceSec = 300) {
  const parts = signatureHeader.split(',').map((part) => part.split('='));
  const t = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return signatures.some((hex) => {
    const given = Buffer.from(hex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

Reject anything that fails, and de-duplicate on `Shark-Event-Id` (a replay or a retry carries the same id).

## Key custody

`SHARK_MFA_ENCRYPTION_KEY` (32 random bytes, base64; `openssl rand -base64 32`) is required in production and refused at boot if missing or the wrong length. Store it with the backup encryption key, offline as well as on the server. A restored backup needs the same key to read its TOTP and webhook secrets; without it every member of staff must set up two-step sign-in again (an owner via platform support) and every webhook secret must be rotated. Changing the key on purpose has the same effect; there is no re-encryption tool yet.

## Tests and the demo

- The seeded demo owners have no two-step sign-in, so a fresh demo signs in and shows the enrolment gate on first use (the owner sets it up with any authenticator app).
- `pnpm test` (API) enrols every always-MFA seeded account with a fixed test-only secret (`src/__tests__/helpers/seed-mfa.ts`) and its helper answers the challenge; replay and lockout are proved in `mfa.integration.test.ts`.
- `pnpm e2e` enrols the demo owner with a secret generated for each run (`apps/api/src/db/mfa-fixture.ts`) and generates its codes in `e2e/support/totp.ts`. The fixture writes only to the database `SHARK_DB` names and is not reachable over HTTP; never run it against a database people use.
- Operational scripts that sign in as the owner (`pnpm db:backup:verify`, `pnpm perf:baseline`) enrol through the API on their fresh databases (`scripts/lib/console-session.mjs`). The CDP smoke (`scripts/admin-browser-smoke.mjs`) signs in as the branch manager. The restore drill reports `owner_mfa=` and probes a partial session when the owner has two-step sign-in.

## Required production configuration

- HTTPS only
- exact `SHARK_PUBLIC_ORIGIN` and `SHARK_ALLOWED_ORIGINS`
- unique high-entropy `SHARK_PASS_SECRET`
- unique `SHARK_MFA_ENCRYPTION_KEY`, stored with the backup key
- `SHARK_CSP_REPORT_ONLY` unset or `false`
- unique reader keys in `SHARK_READER_KEYS_JSON`
- `SHARK_ECHO_OTP=false`
- `SHARK_ALLOW_BEARER_AUTH=false`
- persistent encrypted database storage and backups
- external secret manager rather than committed `.env` files
- log redaction and retention controls
- dependency and container scanning
