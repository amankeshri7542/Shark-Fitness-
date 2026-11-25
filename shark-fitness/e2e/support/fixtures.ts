import { expect, test as base } from '@playwright/test';

/**
 * Every spec imports `test` from here. It adds one automatic fixture: a
 * Content-Security-Policy violation listener on every page the spec opens.
 * The browser fires `securitypolicyviolation` for anything the policy blocks
 * (or would block, in report-only mode), and Chromium also logs "Refused to …"
 * to the console. Either fails the spec: a clean run is the proof that the
 * enforced CSP does not break the product (P06 acceptance 4).
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ context }, use) => {
      const violations: string[] = [];
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(`[csp-violation] ${event.effectiveDirective} blocked ${event.blockedURI || 'inline'} at ${event.sourceFile}:${event.lineNumber}`);
        });
      });
      const watch = (page: import('@playwright/test').Page) =>
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

export { expect };
