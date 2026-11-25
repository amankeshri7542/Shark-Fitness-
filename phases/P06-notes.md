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
(filled in as work proceeds)

## Integration notes
(filled in as work proceeds)
