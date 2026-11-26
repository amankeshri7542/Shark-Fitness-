import { test, type Browser } from '@playwright/test';
import { ADMIN_ROUTES, MEMBER_ROUTES, THEMES, VIEWPORTS, WEBSITE_ROUTES, type AuditRoute, type Theme } from './routes';
import { citeScreenshot, screenshotPath, writeData } from './lib/out';
import { applyTheme, readIds, resolvePath, settle, storageStateFor, type Density } from './lib/session';
import { measureStructure } from './lib/measure';

/**
 * Every route of the three apps at the five PRD 03 viewports, in both themes,
 * plus compact density for the console. One navigation per route and variant;
 * the viewport is then resized through the five sizes, which is what a
 * responsive layout has to survive anyway.
 */

export interface CoverageEntry {
  app: string;
  slug: string;
  title: string;
  screen: string;
  path: string;
  finalUrl: string;
  variant: string;
  screenshots: string[];
  h1: string[];
  documentTitle: string;
  mains: number;
  skipLink: boolean;
  consoleErrors: string[];
  error?: string;
}

async function capture(browser: Browser, routes: AuditRoute[], theme: Theme, density: Density, coverage: CoverageEntry[]): Promise<void> {
  const ids = readIds();
  const variant = density === 'compact' ? `${theme}-compact` : theme;
  for (const signedIn of [false, true]) {
    const group = routes.filter((r) => Boolean(storageStateFor(r)) === signedIn);
    if (group.length === 0) continue;
    const context = await browser.newContext({
      baseURL: process.env.SHARK_E2E_BASE_URL,
      storageState: signedIn ? storageStateFor(group[0]!) : undefined,
      viewport: { width: VIEWPORTS[0]!.width, height: VIEWPORTS[0]!.height },
      colorScheme: theme,
      serviceWorkers: 'block',
    });
    await applyTheme(context, group[0]!.app, theme, density);
    const page = await context.newPage();
    for (const route of group) {
      const consoleErrors: string[] = [];
      const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
      };
      page.on('console', onConsole);
      const entry: CoverageEntry = {
        app: route.app,
        slug: route.slug,
        title: route.title,
        screen: route.screen,
        path: route.path,
        finalUrl: '',
        variant,
        screenshots: [],
        h1: [],
        documentTitle: '',
        mains: 0,
        skipLink: false,
        consoleErrors,
      };
      try {
        await page.setViewportSize({ width: VIEWPORTS[0]!.width, height: VIEWPORTS[0]!.height });
        await page.goto(resolvePath(route, ids));
        await settle(page, 400);
        entry.finalUrl = new URL(page.url()).pathname + new URL(page.url()).search;
        const structure = await measureStructure(page);
        entry.h1 = structure.h1;
        entry.documentTitle = structure.title;
        entry.mains = structure.mains;
        entry.skipLink = structure.skipLink;
        for (const viewport of VIEWPORTS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.waitForTimeout(350);
          const file = screenshotPath(route.app, route.slug, `${viewport.name}-${variant}.png`);
          await page.screenshot({ path: file, fullPage: true, animations: 'disabled', timeout: 20_000 });
          entry.screenshots.push(citeScreenshot(file));
        }
      } catch (error) {
        entry.error = String(error).slice(0, 300);
      }
      page.off('console', onConsole);
      coverage.push(entry);
    }
    await context.close();
  }
}

test.describe.configure({ mode: 'serial' });

test('website: every page, five viewports, both themes', async ({ browser }) => {
  const coverage: CoverageEntry[] = [];
  for (const theme of THEMES) await capture(browser, WEBSITE_ROUTES, theme, 'comfortable', coverage);
  writeData('coverage-website', coverage);
});

test('member app: every route, five viewports, both themes', async ({ browser }) => {
  const coverage: CoverageEntry[] = [];
  for (const theme of THEMES) await capture(browser, MEMBER_ROUTES, theme, 'comfortable', coverage);
  writeData('coverage-member', coverage);
});

test('console: every route, five viewports, both themes and compact density', async ({ browser }) => {
  const coverage: CoverageEntry[] = [];
  for (const theme of THEMES) await capture(browser, ADMIN_ROUTES, theme, 'comfortable', coverage);
  await capture(browser, ADMIN_ROUTES, 'dark', 'compact', coverage);
  writeData('coverage-admin', coverage);
});
