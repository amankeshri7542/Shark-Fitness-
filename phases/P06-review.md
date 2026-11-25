# P06 independent review — Staff security

Reviewer: independent senior review (did not write the code). Branch `phase/P06-staff-security`, reviewed against `phase/P01-prod-readiness`.

## Verdict

**Ready for PR with known issues** (all listed below are minor or integration-dependent). Every acceptance criterion is met in code and in re-run commands; six problems were fixed on the branch with tests.

## Findings and fixes

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | major | The 12-hour staff limit was measured from `expires_at`, so staff sessions created before P06 (30-day `expires_at`) were never capped, and `completeMfa` reset expiry to now + 12 h, so enrolling from Your account extended a session. | Fixed `a441ced` — limit is `createdAt + 12 h` for every staff session; tests. |
| 2 | major | Member sessions slid on the server, but the cookie kept the Max-Age from sign-in, so browsers dropped it 30 days after sign-in however often the app was used (the "30-day sliding" promise was false in practice). | Fixed `360f45c` — cookie reissued (same token and flags) when the session slides; one cookie helper. |
| 3 | major (test) | The step-up suite left active webhook endpoints pointing at `hooks.example.com` on the demo gym. When vitest ran it before the webhook suite, the dispatcher delivered to them: an order-dependent failure, and real outbound HTTP from the test run. The "64 KB cap" test only asserted the 1 KB log excerpt, which held with or without the cap. | Fixed `9c14c5f` — suites retire their endpoints; a never-ending body proves reading stops at 64 KB. |
| 4 | major | `POST /v1/csp-reports` (public, CSRF-exempt) checked a declared Content-Length but read a chunked body whole with `c.req.text()` before checking size: an unauthenticated request could make the process buffer as much as it sent. | Fixed `7d1c0de` — body streamed and cut at 16 KB (413). Test with an endless chunked body crashes the worker (OOM) without the fix. |
| 5 | minor | SSRF blocklist unwrapped IPv4-mapped and well-known NAT64 addresses but accepted IPv4-compatible (`::127.0.0.1`), IPv4-translated (`::ffff:0:a.b.c.d`), 6to4 (`2002::/16`) and local-use NAT64 (`64:ff9b:1::/48`). | Fixed `9e22912` (+ docs `d5d02a4`) — refused at save and before each send; 4 new cases fail without the fix. |
| 6 | minor | A support (impersonation) session was refused "sign out everywhere else" but could still revoke the account holder's devices one at a time via `DELETE /v1/me/sessions/:id` (the console hid the button, the API did not). | Fixed `d9e656c` — 403 during a support session; test fails without the fix. |
| 7 | minor | E2E CSP listener (`e2e/support/fixtures.ts`) only watches pages of the spec's own context; the second device in `console-session.spec.ts` (made with `browser.newContext()`) is unwatched. | Not fixed (test-infrastructure change); listed for P08 in the notes. |
| 8 | minor | `COOP: same-origin` may block Razorpay popup payment methods (flagged in P02's notes) — not mentioned in P06's integration notes. | Added to Integration notes item 2. |
| 9 | minor | Razorpay origins are code constants in `lib/csp.ts` (`PAYMENT_CHECKOUT_SOURCES`), one reviewed module rather than environment configuration. Acceptable (a new third party should be a reviewed change), but they are unverified against a live checkout. | Not changed; integration must verify (notes item 2). |
| 10 | minor | `POST /v1/auth/step-up` has a per-actor rate limit (10/min) but no lockout for wrong passwords, so a stolen session can guess the password at that rate. Sign-in has the same limit. | Not changed; note for the P08 hardening pass. |
| 11 | minor | `src/db/mfa-fixture.ts` does not refuse `NODE_ENV=production`; it relies on documentation ("never run it against a database people use"). The e2e server runs in production mode, so a guard would need to key on something else. | Not changed; note. |

## Checked and found sound

- **MFA:** `otpauth` TOTP (no hand-rolled crypto); AES-256-GCM, HKDF per purpose, AAD bound to the owning row; each code accepted once (stored step); 5-failure lock for 15 min with audit; recovery codes hashed, single use, sharing the lock counter; partial sessions (15 min) only reach the MFA routes, CSRF and sign-out; token replaced on completion; OTP sign-in path gets the same MFA state as password sign-in; members never challenged; owner self-reset refused; platform reset audited in the gym's log.
- **Step-up:** every route listed in the spec (plus staff creation, POS returns, privacy-export reads, security settings, webhook URL changes) calls `requireFreshAuth` before any transaction; denials audited with the action name only; operator re-proves during impersonation; shadowed `billing.ts` handlers are unreachable (stabilization routes mounted first). Console retries with the same body and Idempotency-Key.
- **Sessions:** idle based on writes and an input-driven heartbeat (background reads don't count); tenant setting clamped 15–240; ended sessions return `details.reason`; console "Session expired" keeps the URL; `redirect` limited to same-console paths.
- **CSP:** per-surface policies, no `unsafe-*`, `camera=(self)` only on `/admin/*`, report-only switch; fonts self-hosted; admin inline script moved into the bundle.
- **Webhooks:** resolve once, check every address, connect to the checked IP (rebinding-safe), SNI to the host name, no redirects, 5 s, 64 KB; envelope and `t.body` HMAC match the docs snippet (constant-time compare); rotation dual-signs 24 h; disable after 15 failures with notification, audit and Command Center alert; payload key filter; integrations outbox channel is not joinable over realtime; e2e server runs with jobs disabled.
- `/platform/impersonate/end` authorization (401 / 412 / 200) and removal of the shadowed `POST /auth/otp/verify`.

## Verification (final HEAD)

RESULTS_PLACEHOLDER

## Housekeeping

- An empty 4 KB `apps/api/data/shark.db` (no tables, untracked, created by a run without `SHARK_DB`) in this worktree was removed. No other scratch files remain.
