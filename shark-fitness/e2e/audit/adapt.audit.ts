import { test, type Browser, type BrowserContextOptions } from '@playwright/test';
import { ADMIN_ROUTES, MEMBER_ROUTES, PRIMARY_VIEWPORT, WEBSITE_ROUTES, type App, type AuditRoute } from './routes';
import { citeScreenshot, screenshotPath, writeData } from './lib/out';
import { applyTheme, readIds, resolvePath, settle, storageStateFor } from './lib/session';
import { applyTextSpacing, measureAnimations, measureOverflow, type AnimationMeasurement, type OverflowMeasurement } from './lib/measure';

/**
 * How each screen adapts to the user, route by route (dark theme):
 * - 320 px wide (WCAG 1.4.10 reflow: 320 CSS px with no sideways scrolling);
 * - 200 % zoom (WCAG 1.4.4): a 1440×900 window zoomed to 200 % is a 720×450
 *   CSS viewport at device scale 2, which is what is emulated;
 * - the WCAG 1.4.12 text-spacing override at the app's primary width;
 * - motion: what animates normally, and what still runs with the system's
 *   reduced-motion setting on (PRD 03 "Motion must respect system
 *   reduced-motion settings"). The member app also has its own preference
 *   (`data-motion="reduce"`), checked the same way.
 */

export interface AdaptRouteResult {
  app: App;
  slug: string;
  reflow320?: OverflowMeasurement & { screenshot: string };
  zoom200?: OverflowMeasurement & { screenshot: string };
  textSpacing?: OverflowMeasurement & { screenshot: string };
  motion?: { normal: AnimationMeasurement; reduced: AnimationMeasurement; memberPreference?: AnimationMeasurement };
  errors: string[];
}

type Pass = 'reflow320' | 'zoom200' | 'textSpacing' | 'motionNormal' | 'motionReduced' | 'motionPreference';

async function pass(browser: Browser, app: App, routes: AuditRoute[], kind: Pass, results: Map<string, AdaptRouteResult>): Promise<void> {
  const ids = readIds();
  const base: BrowserContextOptions = { baseURL: process.env.SHARK_E2E_BASE_URL, colorScheme: 'dark', serviceWorkers: 'block' };
  const shape: BrowserContextOptions =
    kind === 'reflow320'
      ? { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }
      : kind === 'zoom200'
        ? { viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 }
        : { viewport: { width: PRIMARY_VIEWPORT[app].width, height: PRIMARY_VIEWPORT[app].height } };
  const reduced = kind === 'motionReduced';
  for (const signedIn of [false, true]) {
    const group = routes.filter((r) => Boolean(storageStateFor(r)) === signedIn);
    if (group.length === 0) continue;
    const context = await browser.newContext({
      ...base,
      ...shape,
      reducedMotion: reduced ? 'reduce' : 'no-preference',
      storageState: signedIn ? storageStateFor(group[0]!) : undefined,
    });
    await applyTheme(context, app, 'dark');
    if (kind === 'motionPreference') {
      // The member's own "Reduce motion" setting, with the system setting off.
      await context.addInitScript(() => localStorage.setItem('shark.member.motion', 'reduce'));
      await context.route(/\/v1\/me$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        if (!response.ok()) return route.fulfill({ response });
        const body = (await response.json()) as { viewer?: { preferences?: { reducedMotion?: boolean } } };
        if (body.viewer?.preferences) body.viewer.preferences.reducedMotion = true;
        return route.fulfill({ response, json: body });
      });
    }
    const page = await context.newPage();
    for (const route of group) {
      const key = `${app}/${route.slug}`;
      const result = results.get(key) ?? { app, slug: route.slug, errors: [] };
      results.set(key, result);
      try {
        await page.goto(resolvePath(route, ids));
        await settle(page, 300);
        if (kind === 'reflow320' || kind === 'zoom200' || kind === 'textSpacing') {
          if (kind === 'textSpacing') {
            await applyTextSpacing(page);
            await page.waitForTimeout(200);
          }
          const measured = await measureOverflow(page);
          const file = screenshotPath(app, route.slug, `${kind === 'reflow320' ? 'reflow-320' : kind === 'zoom200' ? 'zoom-200' : 'text-spacing'}.png`);
          await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
          result[kind] = { ...measured, screenshot: citeScreenshot(file) };
        } else {
          // Let entrance animations finish so only what keeps moving is left.
          await page.waitForTimeout(800);
          const measured = await measureAnimations(page);
          result.motion ??= { normal: { running: [] }, reduced: { running: [] } };
          if (kind === 'motionNormal') result.motion.normal = measured;
          else if (kind === 'motionReduced') result.motion.reduced = measured;
          else result.motion.memberPreference = measured;
        }
      } catch (error) {
        result.errors.push(`${kind}: ${String(error).slice(0, 200)}`);
      }
    }
    await context.close();
  }
}

test.describe.configure({ mode: 'serial' });

const APPS: Array<[App, AuditRoute[]]> = [
  ['website', WEBSITE_ROUTES],
  ['member', MEMBER_ROUTES],
  ['admin', ADMIN_ROUTES],
];

for (const [app, routes] of APPS) {
  test(`${app}: reflow at 320 px, 200 % zoom, text spacing, motion`, async ({ browser }) => {
    const results = new Map<string, AdaptRouteResult>();
    const kinds: Pass[] = ['reflow320', 'zoom200', 'textSpacing', 'motionNormal', 'motionReduced'];
    if (app === 'member') kinds.push('motionPreference');
    for (const kind of kinds) await pass(browser, app, routes, kind, results);
    writeData(`adapt-${app}`, [...results.values()]);
  });
}
