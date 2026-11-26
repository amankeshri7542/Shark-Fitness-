import { test, type Browser, type Route } from '@playwright/test';
import { ADMIN_ROUTES, MEMBER_ROUTES, PRIMARY_VIEWPORT, type App, type AuditRoute } from './routes';
import { citeScreenshot, screenshotPath, writeData } from './lib/out';
import { applyTheme, readIds, resolvePath, settle, storageStateFor } from './lib/session';

/**
 * PRD 03 "Mandatory states" and Design QA gate 1, forced by intercepting the
 * screen's own data requests (dark theme, the app's primary width):
 * - loaded: the real screen, with cumulative layout shift measured;
 * - loading: every data request held for 6 s, captured at 1.2 s;
 * - empty: every list in every data response emptied;
 * - error: every data request answers 500 in the API's own error envelope;
 * - permission: every data request answers 403 FORBIDDEN;
 * - offline: loaded, then the network drops and the app is asked to refetch.
 * The session probe (`/v1/me`), sign-in endpoints and the console's branch
 * list are left alone, so what is captured is the screen's state rather than
 * a signed-out shell.
 */

type StateName = 'loaded' | 'loading' | 'empty' | 'error' | 'permission' | 'offline';
const STATES: StateName[] = ['loaded', 'loading', 'empty', 'error', 'permission', 'offline'];

export interface StateObservation {
  state: StateName;
  screenshot: string;
  headings: string[];
  alerts: string[];
  statusTexts: string[];
  retry: boolean;
  skeletons: number;
  busy: boolean;
  mentionsPermission: boolean;
  mentionsOffline: boolean;
  bodyText: string;
  cls?: number;
  error?: string;
}

export interface StateRouteResult {
  app: App;
  slug: string;
  screen: string;
  states: StateObservation[];
}

function isScreenData(url: string, method: string): boolean {
  if (method !== 'GET') return false;
  const path = new URL(url).pathname;
  if (!path.startsWith('/v1/')) return false;
  return !/^\/v1\/(me$|auth\/|realtime|client-errors)/.test(path) && !/\/branches$/.test(path);
}

function emptyLists(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, emptyLists(v)]));
  }
  return value;
}

async function force(route: Route, state: StateName): Promise<void> {
  const request = route.request();
  if (!isScreenData(request.url(), request.method())) return route.fallback();
  if (state === 'loading') {
    await new Promise((done) => setTimeout(done, 6_000));
    return route.fallback().catch(() => undefined);
  }
  if (state === 'error') {
    return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'Something went wrong on our side.', requestId: 'req_audit' } } });
  }
  if (state === 'permission') {
    return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'You do not have access to this.', requestId: 'req_audit' } } });
  }
  if (state === 'empty') {
    const response = await route.fetch();
    const type = response.headers()['content-type'] ?? '';
    if (!response.ok() || !type.includes('json')) return route.fulfill({ response });
    return route.fulfill({ response, json: emptyLists(await response.json()) });
  }
  return route.fallback();
}

async function observe(page: import('@playwright/test').Page): Promise<Omit<StateObservation, 'state' | 'screenshot'>> {
  return page.evaluate(() => {
    const text = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const shown = (el: Element) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    };
    const body = text(document.body);
    return {
      headings: [...document.querySelectorAll('h1, h2, h3')].filter(shown).map(text).slice(0, 12),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(shown).map(text).filter(Boolean).slice(0, 6),
      statusTexts: [...document.querySelectorAll('[role="status"], [aria-live]')].filter(shown).map(text).filter(Boolean).slice(0, 6),
      retry: [...document.querySelectorAll('button, a')].some((b) => /try again|retry|reload/i.test(text(b))),
      skeletons: [...document.querySelectorAll('.sf-skeleton')].filter(shown).length,
      busy: document.querySelector('[aria-busy="true"]') !== null,
      mentionsPermission: /permission|access|not allowed|ask (an|your) (owner|admin|manager)/i.test(body),
      mentionsOffline: /offline|no connection|connection|reconnect/i.test(body),
      bodyText: body.slice(0, 600),
    };
  });
}

async function walk(browser: Browser, app: App, routes: AuditRoute[], results: StateRouteResult[]): Promise<void> {
  const ids = readIds();
  const viewport = PRIMARY_VIEWPORT[app];
  const signedIn = routes.filter((r) => storageStateFor(r));
  for (const route of signedIn) {
    const result: StateRouteResult = { app, slug: route.slug, screen: route.screen, states: [] };
    for (const state of STATES) {
      const context = await browser.newContext({
        baseURL: process.env.SHARK_E2E_BASE_URL,
        storageState: storageStateFor(route),
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.width < 768,
        hasTouch: viewport.width < 1024,
        colorScheme: 'dark',
        serviceWorkers: 'block',
      });
      await applyTheme(context, app, 'dark');
      if (state !== 'loaded' && state !== 'offline') await context.route(/\/v1\//, (r) => force(r, state));
      const page = await context.newPage();
      const file = screenshotPath(app, route.slug, `state-${state}.png`);
      const observation: StateObservation = {
        state,
        screenshot: citeScreenshot(file),
        headings: [],
        alerts: [],
        statusTexts: [],
        retry: false,
        skeletons: 0,
        busy: false,
        mentionsPermission: false,
        mentionsOffline: false,
        bodyText: '',
      };
      try {
        if (state === 'loaded') {
          await page.addInitScript(() => {
            (window as unknown as { __cls: number }).__cls = 0;
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
                if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
              }
            }).observe({ type: 'layout-shift', buffered: true });
          });
        }
        await page.goto(resolvePath(route, ids));
        if (state === 'loading') {
          await page.waitForTimeout(1_200);
        } else {
          await settle(page, 300);
        }
        if (state === 'offline') {
          await context.setOffline(true);
          await page.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
          });
          await page.waitForTimeout(2_500);
        }
        Object.assign(observation, await observe(page));
        if (state === 'loaded') observation.cls = Math.round(((await page.evaluate(() => (window as unknown as { __cls: number }).__cls)) ?? 0) * 10_000) / 10_000;
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      } catch (error) {
        observation.error = String(error).slice(0, 200);
      }
      result.states.push(observation);
      await context.close().catch(() => undefined);
    }
    results.push(result);
  }
}

test.describe.configure({ mode: 'serial' });

test('member app: forced loading, empty, error, permission and offline states', async ({ browser }) => {
  const results: StateRouteResult[] = [];
  await walk(browser, 'member', MEMBER_ROUTES, results);
  writeData('states-member', results);
});

test('console: forced loading, empty, error, permission and offline states', async ({ browser }) => {
  const results: StateRouteResult[] = [];
  await walk(browser, 'admin', ADMIN_ROUTES, results);
  writeData('states-admin', results);
});
