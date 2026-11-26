import { expect, test as base, type Page } from '@playwright/test';

export { expect };

/** A private-range address unique to this test, sent as X-Forwarded-For. */
export function clientAddress(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `10.${(hash >>> 16) & 0xff}.${(hash >>> 8) & 0xff}.${(hash & 0xfe) + 1}`;
}

/**
 * Every spec imports `test` from here. It adds two things:
 *
 * - Every test is its own client as far as the API's per-IP limits go: the
 *   E2E server trusts one proxy hop (global-setup.ts), and each test's browser
 *   context presents its own address. Production limits stay as they are (P04).
 * - An automatic Content-Security-Policy violation listener on every page the
 *   spec opens. The browser fires `securitypolicyviolation` for anything the
 *   policy blocks (or would block, in report-only mode), and Chromium also
 *   logs "Refused to …" to the console. Either fails the spec: a clean run is
 *   the proof that the enforced CSP does not break the product (P06
 *   acceptance 4).
 */
export const test = base.extend<{ cspViolations: string[] }>({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    await use({ ...extraHTTPHeaders, 'x-forwarded-for': clientAddress(`${testInfo.project.name}:${testInfo.titlePath.join('/')}:${testInfo.retry}`) });
  },
  cspViolations: [
    async ({ context }, use) => {
      const violations: string[] = [];
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(`[csp-violation] ${event.effectiveDirective} blocked ${event.blockedURI || 'inline'} at ${event.sourceFile}:${event.lineNumber}`);
        });
      });
      const watch = (page: Page) =>
        page.on('console', (message) => {
          const text = message.text();
          if (text.startsWith('[csp-violation]') || /Content Security Policy/i.test(text)) violations.push(`${page.url()} — ${text}`);
        });
      context.pages().forEach(watch);
      context.on('page', watch);
      await use(violations);
      expect(violations, 'Content-Security-Policy violations on this spec’s pages').toEqual([]);
    },
    { auto: true },
  ],
});
