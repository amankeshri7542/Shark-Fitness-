import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { ALL_ROUTES, PRIMARY_VIEWPORT } from './routes';
import { DOCS_DIR } from './lib/paths.mjs';
import { applyTheme, readIds, resolvePath, settle, storageStateFor } from './lib/session';
import { measureStructure } from './lib/measure';
import { writeData } from './lib/out';

/**
 * The accessibility tree of the key screens, as a screen reader is given it
 * (Playwright's ARIA snapshot: roles, accessible names, states, levels). The
 * snapshots are committed under docs/ux-audit/aria/ so the screen-reader
 * review in UX-AUDIT.md cites them and P11 can diff its fixes against them.
 */

test('key screens: accessibility-tree snapshots and page structure', async ({ browser }) => {
  const ids = readIds();
  const dir = resolve(DOCS_DIR, 'aria');
  mkdirSync(dir, { recursive: true });
  const structure: Array<Record<string, unknown>> = [];
  for (const route of ALL_ROUTES) {
    const viewport = PRIMARY_VIEWPORT[route.app];
    const context = await browser.newContext({
      baseURL: process.env.SHARK_E2E_BASE_URL,
      storageState: storageStateFor(route),
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.width < 768,
      hasTouch: viewport.width < 1024,
      colorScheme: 'dark',
      serviceWorkers: 'block',
    });
    await applyTheme(context, route.app, 'dark');
    const page = await context.newPage();
    try {
      await page.goto(resolvePath(route, ids));
      await settle(page, 300);
      // Page structure for every route; the full tree for key screens only.
      structure.push({ app: route.app, slug: route.slug, screen: route.screen, ...(await measureStructure(page)) });
      if (route.key) {
        const snapshot = await page.locator('body').ariaSnapshot({ timeout: 15_000 });
        writeFileSync(resolve(dir, `${route.app}-${route.slug}.yml`), `# ${route.app} ${route.path} (${route.screen}) at ${viewport.name}, dark theme\n${snapshot}\n`);
      }
    } catch (error) {
      structure.push({ app: route.app, slug: route.slug, error: String(error).slice(0, 200) });
    }
    await context.close();
  }
  writeData('structure', structure);
});
