import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { E2E_ROOT } from '../../support/paths';
import type { App, AuditRoute, Theme } from '../routes';

/** Signed-in browser state saved by auth.setup.ts, reused by every audit spec. */
export const OWNER_STATE = resolve(E2E_ROOT, '.state/audit-owner.json');
export const MEMBER_STATE = resolve(E2E_ROOT, '.state/audit-member.json');
/** Real record ids for the `:name` placeholders in routes.ts. */
export const IDS_FILE = resolve(E2E_ROOT, '.state/audit-ids.json');

export type Ids = Record<string, string>;

export function readIds(): Ids {
  return existsSync(IDS_FILE) ? (JSON.parse(readFileSync(IDS_FILE, 'utf8')) as Ids) : {};
}

export function resolvePath(route: AuditRoute, ids: Ids = readIds()): string {
  return route.path.replace(/:([a-z]+)/g, (_, name: string) => {
    const id = ids[name];
    if (!id) throw new Error(`No ${name} id for ${route.app}/${route.slug}; did auth.setup.ts run?`);
    return id;
  });
}

export function storageStateFor(route: AuditRoute): string | undefined {
  if (route.public) return undefined;
  return route.app === 'admin' ? OWNER_STATE : route.app === 'member' ? MEMBER_STATE : undefined;
}

export type Density = 'comfortable' | 'compact';

/**
 * Puts a context in a theme the way each app chooses one:
 * - website: follows the system (`prefers-color-scheme`);
 * - console: `shark.theme` / `shark.density` in localStorage;
 * - member app: the member's saved preference from `/v1/me` wins over the
 *   device copy, so the preference in that response is rewritten. Nothing is
 *   written to the database, so specs never disturb each other.
 */
export async function applyTheme(context: BrowserContext, app: App, theme: Theme, density: Density = 'comfortable'): Promise<void> {
  await context.addInitScript(
    ({ theme, density }) => {
      try {
        localStorage.setItem('shark.theme', theme);
        localStorage.setItem('shark.density', density);
        localStorage.setItem('shark.member.theme', theme);
      } catch {
        /* storage unavailable: theme falls back to the default */
      }
    },
    { theme, density },
  );
  if (app === 'member') {
    await context.route(/\/v1\/me$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const body = (await response.json()) as { viewer?: { preferences?: { theme?: string } } };
      if (body.viewer?.preferences) body.viewer.preferences.theme = theme;
      return route.fulfill({ response, json: body });
    });
  }
}

/** Theme for a page that already exists (website: media emulation). */
export async function emulateTheme(page: Page, theme: Theme, reducedMotion: 'reduce' | 'no-preference' = 'no-preference'): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
}

/**
 * Waits until a screen has finished loading: network quiet, no skeletons or
 * busy regions left, fonts in. Every check bounds its own wait, so a screen
 * that never settles (a live feed) is still captured, in its real state.
 */
export async function settle(page: Page, extraMs = 250): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page
    .waitForFunction(
      () => {
        const busy = [...document.querySelectorAll('.sf-skeleton, [aria-busy="true"]')].filter((el) => {
          const box = (el as HTMLElement).getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
        return busy.length === 0;
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.waitForTimeout(extraMs);
}

/** Opens a route in its theme and waits for it to settle. */
export async function openRoute(page: Page, route: AuditRoute, theme: Theme, ids?: Ids): Promise<void> {
  await emulateTheme(page, theme);
  await page.goto(resolvePath(route, ids));
  await settle(page);
}
