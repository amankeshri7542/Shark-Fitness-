# P03 independent review

Branch `phase/P03-public-website` (stacked on `phase/P01-prod-readiness`), reviewed at head `41af417`.
Reviewer: independent senior review. I read the code and tests and re-ran every check myself; I did not rely on the implementer's checklist.

## Verdict

**Ready for PR, with known minor issues.** Every acceptance criterion holds when the checks are re-run. Six real defects were found and fixed with tests. None was a blocker; two were major. The remaining items are minor, or are integration work already listed for P02, P04 and P06.

## Findings and fixes

| # | Severity | Finding | Fix (commit) |
|---|---|---|---|
| 1 | major | **A repeat enquiry lost the new contact details.** A website submission that matches an existing lead or member by phone *or* email is filed on that record, which keeps its stored name, phone and email. A person who came back with a new phone number (matched by email) left no trace of it anywhere: not on the lead, not in the activity note. Staff would call the old number. | The activity note now starts with "Details given on the form: name, phone, email" whenever these differ from the record, on both the existing-lead and existing-member paths. New integration test; it fails without the fix (`41af417`). |
| 2 | major | **The legacy service-worker e2e spec never tested `/sw.js`.** Its stand-in worker passed every request through to the network, so the website's inline boot script removed it and `/sw.js` never ran. The spec still passed when `/sw.js` was replaced by a no-op. This was the only automated proof of the riskiest change in the plan: an old install at `/` that keeps serving its cached shell. | New spec: the stand-in worker serves a cached shell at `/` (so no website script can run). Only the browser's update check, which fetches the website's `/sw.js`, can retire it. It passes on desktop and mobile and fails with a no-op `/sw.js` (`bb8ec28`). |
| 3 | minor | **`GET /v1/public/:tenant/classes?from=2026-13-45` returned 500.** The query accepted any string shaped like `YYYY-MM-DD`, so impossible dates (or `9999-12-31`) reached the date arithmetic and threw a RangeError. This is an unauthenticated endpoint. | The contract now accepts only real calendar days in a sane range, so these dates get 422 with a field path. Test added (`9c428c6`). |
| 4 | minor | **The built-site checks (SEO, JSON-LD, sitemap, robots, JS budgets) skipped silently in CI.** `pnpm test` runs before `pnpm build`, and the suite is `skipIf(!built)`. In CI, criteria 4 and 5 were therefore never enforced, although the PR said they ran "on every `pnpm test`". | CI runs `pnpm -F @shark/website budgets` after the build. In that mode a missing build is a failure, not a skip. Docs corrected (`3ca642d`). |
| 5 | minor | **`/app/manifest.webmanifest` was served as `application/octet-stream`.** The static middleware had no MIME type for `.webmanifest`, which hurts install prompts for the moved app. | Served as `application/manifest+json`, with a test (`75348e0`). |
| 6 | minor | **The home page said "Open 5 am–11 pm".** Weekend hours at every branch are 6 am–10 pm, so the page's copy and meta description were wrong at weekends. | Changed to "Open weekdays 5 am–11 pm" (`4fee7c8`). |

### Remaining (not fixed, minor)

- **Idempotency key after a lost response.** The form keeps its `Idempotency-Key` across retries and only regenerates it after a 422. Suppose a submission succeeds on the server, the response is lost, and the visitor then edits the form and resends. The API answers 409 (same key, different body) on every retry until the page is reloaded. The data is safe, since the first enquiry was stored, but the visitor sees an error. Suggested fix: also regenerate the key on a 409 (dedupe would merge the second enquiry into the same lead).
- **Audit actor for website submissions.** Audit rows for website submissions record the actor role as `platform_admin` (name "Website form"). This copies the existing system-context pattern in `services/dunning.ts`. A dedicated `system` role would read better in the audit viewer. That is cross-cutting, so I left it.
- **An unverified email can be attached to an existing lead.** A visitor who knows only a lead's phone number can add an email to that lead if it has none (`existing.email ?? input.email`). The impact is low: staff-only data, and the gym never messages leads automatically. Worth revisiting when lead messaging arrives.
- **The phase's test filter does not filter.** `pnpm -F @shark/api test -- public` (in the phase's How-to-verify and the PR) runs all 69 API files, because the package script ends in `vitest run` and the argument is not applied as a filter. It is harmless but misleading. Use `pnpm -F @shark/api exec vitest run public` after the package's DB setup, or run the whole suite.
- **Hosted checks not run.** Nothing has run on a real domain, through Caddy, or on real phones with an old home-screen install. The legacy-worker retirement is proven in headless Chromium only (now with a non-vacuous spec).

### Checked and found sound

- Public API: tenant resolution 404s the same way for unknown, suspended, archived and platform tenants. Writes need a known Origin, no cookie is read or set, and the CSRF exemption is limited to `/v1/public/`. Per-IP (5 per 10 min per form) and per-tenant (300 per hour) limits apply, plus a 16 KB body cap. Honeypot and too-fast submissions get the same 202 as real ones (no match is revealed) and a security log entry. Lead, consent, activity and audit rows are written in one transaction. Idempotency keys are scoped per tenant and per form.
- `GET /classes` exposes only class facts, the coach's first name and a coarse availability word, never member identifiers. The range is clamped to 14 days, past days are excluded, and another tenant's branch is refused.
- Dedupe (phone last-10 and email), first-touch attribution, reopening lost leads, and linking converted members, with no duplicate member or open lead. Consent is stored append-only with the notice version. Nothing is booked and no message is sent: no notification, delivery or OTP rows, and no outbound fetch.
- Admin: Website filter, campaign and trial chips, Confirm trial (permission-checked, branch-scoped through `loadLeadInScope`, upcoming sessions at the lead's branch only, audited), and "Show on website" (audited).
- Routing: member app `base`/router basepath/manifest scope/SW scope and fallback at `/app/`. Old member paths 302 to `/app/…` with the fragment kept by the browser. `/` forwards activation and recovery fragments and standalone launches. Activation and recovery links in the console use `/app/sign-in#…`.
- Plan buy link: `/app/billing?plan=<productId>`, recorded under Integration notes for P02.

## Verification (final, on the final tree)

Node 22.23.5, pnpm 10.28.0, from `shark-fitness/`. Ports 18410–18430, own temp DBs.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | **pass: 1,610 tests in 136 files.** contracts 28 (2 files), domain 271 (12), website 24 + 1 skipped (2; the skipped test is "has a build to check", which only runs in `budgets` mode), member-pwa 40 (11), admin-web 302 (40), api 943 (69) |
| `pnpm build` | pass |
| `pnpm -F @shark/website budgets` (built-site SEO/JSON-LD/sitemap/robots/JS budgets, build required) | pass, 9 tests |
| `SHARK_E2E_PORT=18430 pnpm e2e` | **17 passed** (chromium 10, website-mobile 7), 0 failed, 0 flaky |
| Production single-origin smoke (port 18420, temp DB) | `/`, `/plans`: 200 HTML `no-cache` br. `/app/`, `/admin/`: 200 HTML. Hashed assets `immutable` with correct MIME types. Missing assets: 404 `no-store`. `/sign-in`: 302 to `/app/sign-in`. Manifest: `application/manifest+json`. Public API: `/site` (3 branches, GST-inclusive prices), `/classes` (7 days, first names, availability words), five submissions 202 then the 6th 429, foreign Origin 403, invalid phone 422 with `path: phone`, unknown/suspended tenant 404, no `Set-Cookie`. |
| Lighthouse 13.6.0, mobile, simulated, 3 runs each (`phases/P03-lighthouse/review/`) | Home 100/100/100/100 ×3. Plans 100, 100, 99 (median 100) on Performance, 100 on the rest. Free trial 100, 98, 100 (median 100) on Performance, 100 on the rest. CLS ≤ 0.0009. |
| JS shipped (gzip, scripts on the built pages) | Home 0.66 KB, Plans 0.50 KB, Classes 1.18 KB; Free trial and Contact 3.44 KB (budgets 20/35 KB) |

The fix-before/fix-after runs that prove each new test bites are recorded in the commit messages.
