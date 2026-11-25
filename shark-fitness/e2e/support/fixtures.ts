import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/** A private-range address unique to this test, sent as X-Forwarded-For. */
export function clientAddress(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `10.${(hash >>> 16) & 0xff}.${(hash >>> 8) & 0xff}.${(hash & 0xfe) + 1}`;
}

/**
 * Every test is its own client as far as the API's per-IP limits go: the E2E
 * server trusts one proxy hop (global-setup.ts), and each test's browser
 * context presents its own address. Production limits stay as they are.
 */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    await use({ ...extraHTTPHeaders, 'x-forwarded-for': clientAddress(`${testInfo.project.name}:${testInfo.titlePath.join('/')}:${testInfo.retry}`) });
  },
});
