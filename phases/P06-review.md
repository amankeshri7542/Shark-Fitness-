# P06 independent review (in progress)

## Fixes committed so far
- a441ced fix(api): 12-hour staff absolute limit measured from sign-in (also for pre-existing sessions; completeMfa no longer extends) — major
- 360f45c fix(api): member session cookie renewed when the session slides — major
- 9c14c5f test(api): webhook suites isolated (step-up suite left active endpoints pointing at hooks.example.com → real outbound requests, order-dependent failure); real 64 KB read-cap test — major (test)

## Reviewed so far
- services/auth.ts session policy, member sliding, webhook tests isolation

## Still to review
- mfa.ts, step-up.ts, safe-http.ts, webhooks.ts, csp.ts, csp-reports.ts, admin UI, e2e, docs
