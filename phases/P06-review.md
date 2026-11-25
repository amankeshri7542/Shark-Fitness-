# P06 independent review (in progress)

## Fixes committed so far
- a441ced fix(api): 12-hour staff absolute limit measured from sign-in (also for pre-existing sessions; completeMfa no longer extends) — major
- 360f45c fix(api): member session cookie renewed when the session slides — major
- 9c14c5f test(api): webhook suites isolated (step-up suite left active endpoints pointing at hooks.example.com → real outbound requests, order-dependent failure); real 64 KB read-cap test — major (test)
- 7d1c0de fix(api): CSP report body capped while streaming (chunked body was buffered whole: unauthenticated memory DoS) — major
- 9e22912 fix(api): SSRF blocklist covers IPv4-compatible, IPv4-translated, 6to4, local-use NAT64 — minor
- d5d02a4 docs: SECURITY.md SSRF ranges
- d9e656c fix(api): support session cannot revoke account holder's devices one by one (DELETE /me/sessions/:id) — minor

## Reviewed, no issue
- step-up coverage of routes (refund, write-off, staff access, exports, privacy, impersonation, webhook secrets/URL, MFA disable/regenerate, platform reset)
- mfa.ts (replay refusal, lockout, recovery once), routes/mfa.ts, auth routes, OTP path gets MFA state too
- safe-http (rebinding, redirects, timeout), webhooks.ts (retry, disable, rotation), integration-events minimal data, realtime cannot join integrations channel
- csp.ts per-surface policies

## Still to review
- (done: SessionGuard, api.ts handlers, store, SignIn, e2e fixtures, SECURITY.md) remaining: Integrations/Security UI glance, field-encryption/config, seed demo gate, PR description
## Notes for later
- COOP same-origin vs Razorpay popup methods (P02 notes) not in P06 integration notes → add
- apps/api/data/shark.db in worktree is an empty 4 KB file (no tables) from an earlier run without SHARK_DB → remove at end if still empty
- e2e CSP listener does not watch contexts made with browser.newContext() (console-session 'laptop') — minor, note
- full gate run started 00:49 → /tmp/p06rev-logs (install/typecheck/lint ok)
