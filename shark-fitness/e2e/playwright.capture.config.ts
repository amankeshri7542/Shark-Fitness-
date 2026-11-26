import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Captures the store screenshots the member web app manifest lists
 * (`pnpm -F @shark/e2e store-screenshots`). Same production server and seeded
 * demo data as the E2E run; writes into apps/member-pwa/public/screenshots/.
 * Not part of `pnpm e2e`.
 */
export default defineConfig({
  ...base,
  testDir: './capture',
  retries: 0,
  projects: [{ name: 'capture', use: { browserName: 'chromium' } }],
});
