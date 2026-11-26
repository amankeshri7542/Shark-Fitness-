import { defineConfig, devices } from '@playwright/test';

/**
 * The UI/UX and accessibility audit (P10): `pnpm -F @shark/e2e audit`.
 *
 * Same production single-origin server as `pnpm e2e` (global setup builds a
 * temporary seeded database and enrols the owner's two-step sign-in), but its
 * own specs (`*.audit.ts`), which record measurements instead of asserting.
 * It is deliberately not part of `pnpm e2e` or `pnpm test`: a run takes tens
 * of minutes and produces evidence, not a verdict. See audit/README.md.
 */
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.(audit|setup)\.ts$/,
  globalSetup: '../global-setup.ts',
  globalTeardown: '../global-teardown.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // A spec walks every route of an app; each test bounds its own steps.
  timeout: 45 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './.out/test-results',
  use: {
    baseURL: process.env.SHARK_E2E_BASE_URL,
    ...devices['Desktop Chrome'],
    // The build under test, not a cached shell (same reason as playwright.config.ts).
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    { name: 'audit-auth', testMatch: /auth\.setup\.ts$/ },
    { name: 'audit', testMatch: /.*\.audit\.ts$/, dependencies: ['audit-auth'] },
  ],
});
