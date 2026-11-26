import AxeBuilder from '@axe-core/playwright';
import { test, type Browser } from '@playwright/test';
import { ADMIN_ROUTES, MEMBER_ROUTES, PRIMARY_VIEWPORT, THEMES, VIEWPORTS, WEBSITE_ROUTES, type App, type AuditRoute, type Theme, type Viewport } from './routes';
import { writeData, writeRaw } from './lib/out';
import { applyTheme, readIds, resolvePath, settle, storageStateFor, type Density } from './lib/session';
import { measureTargets, type TargetMeasurement } from './lib/measure';

/**
 * Axe (WCAG 2.0, 2.1 and 2.2 A/AA rules) on every route in both themes, and
 * the size of every interactive element (WCAG 2.5.8 and PRD 03's 44 px touch
 * minimum). The website is scanned at phone and desktop width because its
 * navigation changes shape between them; the member app at phone width; the
 * console at desktop width, plus compact density, plus tablet width for the
 * touch-target rule PRD 03 sets for tablets ("touch-safe controls").
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export interface AxeRouteResult {
  app: App;
  slug: string;
  screen: string;
  theme: Theme;
  viewport: string;
  variant: string;
  violations: Array<{
    id: string;
    impact: string | null;
    help: string;
    helpUrl: string;
    wcag: string[];
    nodes: Array<{ target: string; html: string; summary: string }>;
  }>;
  incomplete: Array<{ id: string; count: number }>;
  passes: number;
  error?: string;
}

export interface TargetRouteResult {
  app: App;
  slug: string;
  viewport: string;
  variant: string;
  total: number;
  fails24: TargetMeasurement[];
  under44: TargetMeasurement[];
  exempt: number;
}

/** "wcag143" → "1.4.3" */
function criteria(tags: string[]): string[] {
  return tags
    .map((t) => /^wcag(\d)(\d)(\d+)$/.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]}.${m[2]}.${m[3]}`);
}

async function scan(
  browser: Browser,
  app: App,
  routes: AuditRoute[],
  theme: Theme,
  viewport: Viewport,
  density: Density,
  options: { axe: boolean; targets: boolean },
  out: { axe: AxeRouteResult[]; targets: TargetRouteResult[] },
): Promise<void> {
  const ids = readIds();
  const variant = density === 'compact' ? `${theme}-compact` : theme;
  for (const signedIn of [false, true]) {
    const group = routes.filter((r) => Boolean(storageStateFor(r)) === signedIn);
    if (group.length === 0) continue;
    const context = await browser.newContext({
      baseURL: process.env.SHARK_E2E_BASE_URL,
      storageState: signedIn ? storageStateFor(group[0]!) : undefined,
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.width < 1024,
      isMobile: viewport.width < 768,
      colorScheme: theme,
      serviceWorkers: 'block',
    });
    await applyTheme(context, app, theme, density);
    const page = await context.newPage();
    for (const route of group) {
      try {
        await page.goto(resolvePath(route, ids));
        await settle(page, 300);
        if (options.axe) {
          const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
          writeRaw(`axe/${app}/${route.slug}-${viewport.name}-${variant}.json`, result);
          out.axe.push({
            app,
            slug: route.slug,
            screen: route.screen,
            theme,
            viewport: viewport.name,
            variant,
            violations: result.violations.map((v) => ({
              id: v.id,
              impact: v.impact ?? null,
              help: v.help,
              helpUrl: v.helpUrl,
              wcag: criteria(v.tags),
              nodes: v.nodes.slice(0, 12).map((n) => ({
                target: n.target.join(' '),
                html: n.html.slice(0, 160),
                summary: (n.failureSummary ?? '').split('\n').slice(0, 3).join(' ').slice(0, 300),
              })),
            })),
            incomplete: result.incomplete.map((v) => ({ id: v.id, count: v.nodes.length })),
            passes: result.passes.length,
          });
        }
        if (options.targets) {
          const targets = await measureTargets(page);
          out.targets.push({
            app,
            slug: route.slug,
            viewport: viewport.name,
            variant,
            total: targets.length,
            fails24: targets.filter((t) => t.fails24),
            under44: targets.filter((t) => t.under44 && t.exempt !== 'inline'),
            exempt: targets.filter((t) => t.exempt !== null).length,
          });
        }
      } catch (error) {
        if (options.axe) {
          out.axe.push({ app, slug: route.slug, screen: route.screen, theme, viewport: viewport.name, variant, violations: [], incomplete: [], passes: 0, error: String(error).slice(0, 300) });
        }
      }
    }
    await context.close();
  }
}

test.describe.configure({ mode: 'serial' });

test('website: axe in both themes at phone and desktop width, target sizes', async ({ browser }) => {
  const out = { axe: [] as AxeRouteResult[], targets: [] as TargetRouteResult[] };
  for (const theme of THEMES) {
    await scan(browser, 'website', WEBSITE_ROUTES, theme, PRIMARY_VIEWPORT.website, 'comfortable', { axe: true, targets: theme === 'dark' }, out);
    await scan(browser, 'website', WEBSITE_ROUTES, theme, VIEWPORTS[0]!, 'comfortable', { axe: true, targets: false }, out);
  }
  writeData('axe-website', out.axe);
  writeData('targets-website', out.targets);
});

test('member app: axe in both themes, target sizes', async ({ browser }) => {
  const out = { axe: [] as AxeRouteResult[], targets: [] as TargetRouteResult[] };
  for (const theme of THEMES) {
    await scan(browser, 'member', MEMBER_ROUTES, theme, PRIMARY_VIEWPORT.member, 'comfortable', { axe: true, targets: theme === 'dark' }, out);
  }
  writeData('axe-member', out.axe);
  writeData('targets-member', out.targets);
});

test('console: axe in both themes and compact, target sizes at desktop, compact and tablet', async ({ browser }) => {
  const out = { axe: [] as AxeRouteResult[], targets: [] as TargetRouteResult[] };
  for (const theme of THEMES) {
    await scan(browser, 'admin', ADMIN_ROUTES, theme, PRIMARY_VIEWPORT.admin, 'comfortable', { axe: true, targets: theme === 'dark' }, out);
  }
  await scan(browser, 'admin', ADMIN_ROUTES, 'dark', PRIMARY_VIEWPORT.admin, 'compact', { axe: true, targets: true }, out);
  await scan(browser, 'admin', ADMIN_ROUTES, 'dark', VIEWPORTS[2]!, 'comfortable', { axe: false, targets: true }, out);
  writeData('axe-admin', out.axe);
  writeData('targets-admin', out.targets);
});
