import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the production single-origin build
 * (docs/PRODUCTION-READINESS.md; PRD 05 §5). `pnpm build` first, then
 * `pnpm e2e`. Global setup starts the API on a free port with a temporary,
 * seeded database and sets SHARK_E2E_BASE_URL for the workers.
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // One server and one database for the run: specs that sign in share them.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.SHARK_E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The member app's service worker would answer requests before page.route
    // sees them, and a cached shell would hide the build under test.
    serviceWorkers: 'block',
  },
  projects: [
    // Payment specs (tagged @payments) and member flows tagged @mobile (the
    // pass at the door, logging a workout on the floor) run on a phone.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@payments|@mobile/ },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, grep: /@payments|@mobile/ },
  ],
});
