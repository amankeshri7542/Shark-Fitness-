import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '../../support/fixtures';
import { signInToMemberApp } from '../../support/demo';
import { idbAll, ownerKey, waitForMemberWorker } from '../../support/member';
import { WORKSPACE_ROOT } from '../../support/paths';

/** PHASE-PLAN P04 criterion 3, on a phone. */

test('the member app is controlled by its own worker, scoped to /app/', async ({ page }) => {
  await signInToMemberApp(page);
  const script = await waitForMemberWorker(page);
  expect(new URL(script).pathname).toBe('/app/sw.js');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
  expect(new URL(scope!).pathname).toBe('/app/');
});

test('offline, a reload opens Home from the saved snapshot with the offline banner', async ({ page, context }) => {
  await signInToMemberApp(page);
  await waitForMemberWorker(page);
  const owner = await ownerKey(page);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  // The snapshot is written shortly after Home's data lands.
  await expect.poll(async () => (await idbAll<{ owner: string }>(page, 'shark-query-cache', 'snapshots')).map((s) => s.owner)).toContain(owner);
  const heading = (await page.getByRole('main').getByRole('heading', { level: 1 }).textContent()) ?? '';

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText(heading);
    // The leading "!" is a decorative glyph, hidden from assistive tech.
    await expect(page.getByTestId('offline-banner')).toHaveText(/^!?Offline — showing what was saved at \d{2}:\d{2}$/);
    await page.screenshot({ path: test.info().outputPath('offline-home.png') });
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
});

test('a new build never takes over during a workout, and does once it is over', async ({ page }) => {
  // A second build, simulated by changing the deployed worker script on disk:
  // the browser sees a byte-different /app/sw.js and installs it as waiting.
  const swFile = resolve(WORKSPACE_ROOT, 'apps/member-pwa/dist/sw.js');
  const original = readFileSync(swFile, 'utf8');
  const marker = `e2e-build-${Date.now()}`;
  try {
    await signInToMemberApp(page);
    await waitForMemberWorker(page);

    // A workout in progress, exactly as the logger persists it.
    await page.evaluate(() =>
      localStorage.setItem(
        'shark.workout',
        JSON.stringify({ clientId: 'e2e-workout', title: 'Push day', startedAt: Date.now(), exerciseIndex: 0, sets: [], restEndsAt: null }),
      ),
    );
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    appendFileSync(
      swFile,
      `\nself.addEventListener('message', (e) => { if (e.data === 'build?') e.source.postMessage(${JSON.stringify(marker)}); });\n`,
    );
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/app/'))!.update());
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration('/app/'))?.waiting));

    // Waiting, not applied: no bar, and the page is still on the old worker.
    await page.waitForTimeout(500);
    await expect(page.getByTestId('update-bar')).toHaveCount(0);
    const askBuild = () =>
      page.evaluate(
        () =>
          new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), 1_000);
            navigator.serviceWorker.addEventListener('message', (event) => {
              clearTimeout(timer);
              resolve(String(event.data));
            }, { once: true });
            navigator.serviceWorker.controller?.postMessage('build?');
          }),
      );
    expect(await askBuild()).toBeNull();
    // Even a reload mid-workout keeps the old build.
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByTestId('update-bar')).toHaveCount(0);
    expect(await askBuild()).toBeNull();

    // Workout over: the bar appears, and Reload switches builds.
    await page.evaluate(() => localStorage.removeItem('shark.workout'));
    await page.reload();
    const bar = page.getByTestId('update-bar');
    await expect(bar).toContainText('Update ready');
    await Promise.all([page.waitForEvent('load'), bar.getByRole('button', { name: 'Reload' }).click()]);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await expect.poll(askBuild).toBe(marker);
  } finally {
    writeFileSync(swFile, original);
  }
});
