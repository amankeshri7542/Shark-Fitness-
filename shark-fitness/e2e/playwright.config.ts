import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the production single-origin build
 * (docs/PRODUCTION-READINESS.md; PRD 05 §5). `pnpm build` first, then
 * `pnpm e2e`. Global setup starts the API on a free port with a temporary,
 * seeded database and sets SHARK_E2E_BASE_URL for the workers.
 */
// Lets offline emulation and request routing reach service workers' own
// fetches (Chromium). Without it, a worker's network calls ignore
// context.setOffline() and the console's offline page could not be proven.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1';

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // One server and one database for the run: specs that sign in share them.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // An owner sign-in may wait up to one 30-second TOTP step for a code the
  // server has not seen yet (support/totp.ts), so a spec gets 60 s.
  timeout: 60_000,
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
    // Console, website and cross-app specs on a desktop browser, service
    // workers off. Payment specs (tagged @payments) run on a phone instead.
    { name: 'chromium', testIgnore: ['mobile/**', 'pwa/**'], grepInvert: /@payments/, use: { ...devices['Desktop Chrome'] } },
    // Payment specs (tagged @payments) run on a phone, where members pay.
    { name: 'mobile-chromium', testIgnore: ['mobile/**', 'pwa/**'], grep: /@payments/, use: { ...devices['Pixel 7'] } },
    // The public website's flows again on a phone (P03): same server, mobile viewport and touch.
    { name: 'website-mobile', use: { ...devices['Pixel 7'] }, testMatch: /website-.*\.spec\.ts$/ },
    // The installable apps with their service workers live (PWA, offline,
    // updates, push, scope separation) on a desktop browser.
    // Full Chromium in new headless mode (`channel: 'chromium'`): the
    // headless shell refuses notification permission, which push needs.
    { name: 'pwa-desktop', testMatch: 'pwa/**/*.spec.ts', use: { ...devices['Desktop Chrome'], channel: 'chromium', serviceWorkers: 'allow' } },
    // The member app as a phone app (PHASE-PLAN P04 criterion 3). Both run
    // Chromium: WebKit cannot be installed on this build machine, and iOS
    // PWA behaviour cannot be emulated anyway, so the iPhone project proves
    // layout and flows at iPhone size with an iOS user agent, nothing more.
    { name: 'member-pixel7', testMatch: 'mobile/**/*.spec.ts', use: { ...devices['Pixel 7'], channel: 'chromium', serviceWorkers: 'allow' } },
    {
      name: 'member-iphone13',
      testMatch: 'mobile/**/*.spec.ts',
      use: { ...devices['iPhone 13'], browserName: 'chromium', channel: 'chromium', serviceWorkers: 'allow' },
    },
  ],
});
