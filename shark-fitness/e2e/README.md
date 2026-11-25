# End-to-end tests (`@shark/e2e`)

Playwright, pinned in `package.json`, against the real production build: one Node process serving the API, the member app at `/` and the console at `/admin/`, exactly as `pnpm start` runs in production.

```bash
pnpm build            # the specs test the built apps; setup refuses to start without dist/
pnpm e2e              # headless Chromium, all specs
pnpm e2e:ui           # Playwright's UI mode, for writing and debugging specs
```

First time on a machine: `pnpm -F @shark/e2e exec playwright install chromium`.

## What a run does

`global-setup.ts` creates a temporary directory, migrates and seeds a new SQLite database there (the demo gyms from `apps/api/src/db/seed.ts`), and starts the API with `NODE_ENV=production` on a free port (or `SHARK_E2E_PORT`, when the machine reserves a port range) with a pass secret generated for that run, scheduled jobs off and errors reported to the server log. It never reads or writes `apps/api/data/shark.db`, and it passes the server only the variables it sets, so nothing in your shell can point it elsewhere. `global-teardown.ts` stops the server and deletes the directory. The server's process id is recorded in `e2e/.state/run.json` (git-ignored) while a run is in progress.

Specs read the base URL from Playwright's `baseURL` and the server log from `SHARK_E2E_SERVER_LOG`. Shared sign-in steps live in `support/demo.ts`.

## Specs

| Spec | Proves |
| --- | --- |
| `console-sign-in` | The owner signs in at `/admin/` and lands on Command Center with live data |
| `member-sign-in` | A member signs in at `/` and lands on Home |
| `client-error` | A screen whose code chunk fails to load becomes the "Something went wrong." recovery screen with a reference, the report reaches `POST /v1/client-errors` once (checked in the server's own log), and a reload does not report it again |

## Notes for new specs

- Words in the member app follow the member's copy tone (predator or plain), so select by role, destination (`a[href="/train"]`) or structure rather than nav labels.
- The member app's service worker is blocked so the build under test is what loads.
- `page.route` turns on request interception, which also swallows the `keepalive` fetch the apps use for error reports. To break a request in a spec that checks reporting, block it with CDP `Network.setBlockedURLs` (see `client-error.spec.ts`).
- On failure, traces and screenshots land in `test-results/`; CI uploads them with the HTML report.
