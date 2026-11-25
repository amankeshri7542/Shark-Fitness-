import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clientAddress, expect, test } from '../support/fixtures';
import { signInToMemberApp } from '../support/demo';

/**
 * PHASE-PLAN P04 criterion 7: every member screen fits phones and tablets in
 * both orientations: nothing scrolls sideways and nothing is cut off at the
 * right edge. Screenshots go to SHARK_E2E_SCREENSHOT_DIR when it is set (the
 * phase evidence folder), otherwise into the test output.
 */
const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
] as const;

const ROUTES = [
  'sign-in',
  '',
  'pass',
  'train',
  'workout',
  'book',
  'progress',
  'habits',
  'pack',
  'messages',
  'billing',
  'library',
  'notifications',
  'profile',
  'help',
] as const;

for (const viewport of VIEWPORTS) {
  test(`no sideways scroll or clipped content at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      isMobile: viewport.width < 700,
      hasTouch: true,
      serviceWorkers: 'block',
      extraHTTPHeaders: { 'x-forwarded-for': clientAddress(`responsive:${viewport.width}:${test.info().retry}`) },
    });
    const page = await context.newPage();
    const dir = process.env.SHARK_E2E_SCREENSHOT_DIR ?? test.info().outputPath('screens');
    mkdirSync(dir, { recursive: true });
    const tag = `${viewport.width}x${viewport.height}`;

    await page.goto('/app/sign-in');
    await expect(page.getByLabel('Gym code')).toBeVisible();
    await page.screenshot({ path: join(dir, `${tag}-sign-in.png`) });
    await signInToMemberApp(page);

    const problems: string[] = [];
    for (const route of ROUTES.filter((r) => r !== 'sign-in')) {
      await page.goto(`/app/${route}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const scrollers = [document.documentElement, document.body, ...document.querySelectorAll('main')];
        const sideways = scrollers.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.tagName.toLowerCase());
        // Anything visible whose box runs past the right edge of the screen.
        const clipped = [...document.querySelectorAll<HTMLElement>('main *, header *, nav *')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && rect.right > width + 1 && rect.left < width;
          })
          // Horizontal strips that scroll on purpose (date strips, filters).
          .filter((el) => !el.closest('[data-scroll-x], .overflow-x-auto, .sf-hide-scroll'))
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
        return { sideways, clipped };
      });
      if (overflow.sideways.length || overflow.clipped.length) {
        problems.push(`/${route}: scrolls sideways in [${overflow.sideways.join(', ')}], clipped: ${overflow.clipped.join(' | ')}`);
      }
      await page.screenshot({ path: join(dir, `${tag}-${route || 'home'}.png`) });
    }
    expect(problems).toEqual([]);
    await context.close();
  });
}
