import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { signInToMemberApp } from '../support/demo';
import { WORKSPACE_ROOT } from '../support/paths';

const OUT = resolve(WORKSPACE_ROOT, 'apps/member-pwa/public/screenshots');

async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  // Fonts in, enter animations finished: the shot shows the resting screen.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

test.describe('store screenshots', () => {
  test('narrow: Home, Train and Book on a phone', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await signInToMemberApp(page);
    for (const [route, name] of [['/app/', 'home'], ['/app/train', 'train'], ['/app/book', 'book']] as const) {
      await page.goto(route);
      await settle(page);
      await page.screenshot({ path: `${OUT}/${name}-narrow.jpg`, type: 'jpeg', quality: 82 });
    }
    await context.close();
  });

  test('wide: Book on a tablet in landscape', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: true });
    const page = await context.newPage();
    await signInToMemberApp(page);
    await page.goto('/app/book');
    await settle(page);
    await page.screenshot({ path: `${OUT}/book-wide.jpg`, type: 'jpeg', quality: 82 });
    await context.close();
  });
});
