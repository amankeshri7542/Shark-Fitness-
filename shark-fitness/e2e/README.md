# End-to-end tests (`@shark/e2e`)

Playwright, pinned in `package.json`, against the real production build: one Node process serving the API, the member app at `/app/` and the console at `/admin/`, exactly as `pnpm start` runs in production.

```bash
pnpm build            # the specs test the built apps; setup refuses to start without dist/
pnpm e2e              # headless Chromium, all specs
pnpm e2e:ui           # Playwright's UI mode, for writing and debugging specs
```

First time on a machine: `pnpm -F @shark/e2e exec playwright install chromium`.

## What a run does

`global-setup.ts` creates a temporary directory, migrates and seeds a new SQLite database there (the demo gyms from `apps/api/src/db/seed.ts`), and starts the API with `NODE_ENV=production` on a free port (or `SHARK_E2E_PORT`, when the machine reserves a port range) with a pass secret and an MFA encryption key generated for that run, scheduled jobs off and errors reported to the server log. It never reads or writes `apps/api/data/shark.db`, and it passes the server only the variables it sets, so nothing in your shell can point it elsewhere. `global-teardown.ts` stops the server and deletes the directory. The server's process id is recorded in `e2e/.state/run.json` (git-ignored) while a run is in progress.

Specs read the base URL from Playwright's `baseURL` and the server log from `SHARK_E2E_SERVER_LOG`. Shared sign-in steps live in `support/demo.ts`.

**Two-step sign-in.** Owners must use TOTP. Global setup enrols the demo owner (`owner@sharkfitness.in`) with a secret generated for the run (`apps/api/src/db/mfa-fixture.ts`) and passes it to the workers as `SHARK_E2E_OWNER_TOTP_SECRET`; `support/totp.ts` generates the owner's codes. The server accepts each 30-second code once, so the helper waits for a fresh step when a spec signs the owner in twice inside one (specs that do that get a 120 s timeout). Reef Athletic's owner is left unenrolled, which is how `console-two-step` meets the enrolment gate.

**Content-Security-Policy.** Every spec imports `test` from `support/fixtures.ts`, which listens for `securitypolicyviolation` (and Chromium's "Refused to …" console errors) on every page and fails the spec on any violation.

## Specs

| Spec | Proves |
| --- | --- |
| `console-sign-in` | The owner signs in at `/admin/` and lands on Command Center with live data |
| `member-sign-in` | A member signs in at `/app/` and lands on Home |
| `console-two-step` | Reef's owner meets the enrolment gate, enrols from the setup key, keeps recovery codes, and next time signs in with a recovery code |
| `console-session` | "Your devices" signs another session out; that session gets 401 `revoked`, shows "Session expired" and returns to the same URL after signing in |
| `console-step-up` | An export five minutes after sign-in opens "Confirm it's you" and completes with the same request; an owner adds a webhook endpoint (secret shown once) and a metadata address is refused |
| `security-headers` | Per-surface enforced CSP and Permissions-Policy on `/admin/`, `/` and `/v1` |
| `client-error` | A screen whose code chunk fails to load becomes the "Something went wrong." recovery screen with a reference, the report reaches `POST /v1/client-errors` once (checked in the server's own log), and a reload does not report it again |
| `member-pass` (@mobile) | On a phone, the pass QR is replaced by a new token before its countdown ends (page clock driven by the test), and offline the pass shows the member number with "Reception can check you in with this number." |
| `reception-scan` | Reception types a member's code into Floor → Scan pass (as a USB scanner does) and sees Admitted, then "Already checked in"; a blocked camera falls back to the code box; `camera=(self)` only on `/admin/` |
| `freestyle-offline` (@mobile) | With the service worker allowed, a member builds a workout from the library, logs 2 exercises × 3 sets offline, reloads offline into the same session, and on reconnect exactly 6 sets reach the server once |

Ports: the API takes a free port unless `SHARK_E2E_PORT` pins it (and `SHARK_E2E_RAZORPAY_PORT` the fake Razorpay), for machines where parallel runs keep to their own range. Specs tagged `@payments` or `@mobile` run on the Pixel 7 project.

| `responsive` | No sideways scroll or clipped content on any member screen at 360×800, 390×844, 768×1024 and 1024×768; screenshots to `SHARK_E2E_SCREENSHOT_DIR` |
| `pwa/apps-and-scopes` | Built manifests, icons and screenshots at their sizes; asset links; the console's offline page; member (`/app/`) and console (`/admin/`) workers never control each other; an old root worker retires itself; `/` keeps activation fragments |
| `mobile/offline-and-updates` | The member worker controls `/app/`; an offline reload renders Home from the saved snapshot with the offline banner; a new build never takes over mid-workout |
| `mobile/session` | Sign-out warns about unsynced work and wipes the device and the server push device; a revoked session says "Your session ended" and sign-in returns to the same screen with the outbox intact |
| `mobile/preferences` | Theme paints before the app starts, reduce motion, pounds, haptics on a real desk check-in |
| `mobile/reachability` | Notifications in one tap, Billing/Library/Messages/Help in two, Summary's Done |
| `mobile/push` | Push switched on in the UI, a staff message encrypted to the fake push service, decrypted, delivered to the worker and shown; switched off again |

## Projects

- `chromium`: desktop, service workers blocked (console and cross-app specs).
- `pwa-desktop`, `member-pixel7`, `member-iphone13`: service workers live, full Chromium in new headless mode (`channel: 'chromium'`; the headless shell refuses notification permission). The iPhone project is Chromium with iPhone 13 metrics and user agent: it proves layout and flows, not iOS Safari behaviour.

Global setup also starts a local fake push service (`support/fake-push.ts`) and gives the server real VAPID keys and that origin as its only extra push endpoint, so nothing reaches a real push service. The server trusts one proxy hop and every test sends its own `X-Forwarded-For` (`support/fixtures.ts`), so the per-IP sign-in limit does not throttle the suite. Set `SHARK_E2E_PORT` to pin the server port.

`pnpm -F @shark/e2e store-screenshots` (not part of `pnpm e2e`) recaptures the store screenshots the member manifest lists.

## Notes for new specs

- Words in the member app follow the member's copy tone (predator or plain), so select by role, destination (`a[href="/train"]`) or structure rather than nav labels.
- Import `test` from `support/fixtures`. In the `chromium` project service workers are blocked so the build under test is what loads; the other projects run them for real.
- `page.route` turns on request interception, which also swallows the `keepalive` fetch the apps use for error reports. To break a request in a spec that checks reporting, block it with CDP `Network.setBlockedURLs` (see `client-error.spec.ts`).
- On failure, traces and screenshots land in `test-results/`; CI uploads them with the HTML report.
