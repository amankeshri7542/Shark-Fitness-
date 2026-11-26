import { expect, test } from '../../support/fixtures';
import { DEMO, E2E_ANDROID, signInToConsole } from '../../support/demo';

/** PHASE-PLAN P04 criteria 2, 9 and 10, against the production build. */

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('the built member manifest is complete and every icon and screenshot resolves at its size', async ({ request }) => {
  const response = await request.get('/app/manifest.webmanifest');
  expect(response.headers()['content-type']).toContain('application/manifest+json');
  const manifest = (await response.json()) as Record<string, unknown> & {
    icons: Array<{ src: string; sizes: string; purpose: string }>;
    screenshots: Array<{ src: string; sizes: string; form_factor: string }>;
    shortcuts: Array<{ url: string }>;
  };
  expect(manifest).toMatchObject({
    id: '/app/',
    scope: '/app/',
    start_url: '/app/?source=pwa',
    name: 'Shark Fitness',
    short_name: 'Shark',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#04080b',
    background_color: '#04080b',
  });
  expect(manifest.description).toBeTruthy();
  expect(manifest.display_override).toBeTruthy();
  expect(manifest.categories).toContain('fitness');
  expect(manifest.icons.map((icon) => icon.purpose)).toEqual(expect.arrayContaining(['any', 'maskable', 'monochrome']));
  for (const icon of manifest.icons) {
    const file = await request.get(`/app/${icon.src}`);
    expect(file.status(), icon.src).toBe(200);
    const [width, height] = icon.sizes.split('x').map(Number);
    expect(pngSize(await file.body())).toEqual({ width, height });
  }
  expect(manifest.screenshots.filter((s) => s.form_factor === 'narrow').length).toBeGreaterThanOrEqual(2);
  expect(manifest.screenshots.filter((s) => s.form_factor === 'wide').length).toBeGreaterThanOrEqual(1);
  for (const shot of manifest.screenshots) expect((await request.get(`/app/${shot.src}`)).status(), shot.src).toBe(200);
  expect(manifest.shortcuts).toHaveLength(3);

  const html = await (await request.get('/app/')).text();
  const touchIcon = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
  expect(touchIcon).toBe('/app/icons/apple-touch-icon-180.png');
  expect(pngSize(await (await request.get(touchIcon!)).body())).toEqual({ width: 180, height: 180 });
  expect(html).toContain('name="apple-mobile-web-app-capable"');
  expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
  expect(html).not.toContain('fonts.googleapis.com');
});

test('Digital Asset Links are served for the configured Android app', async ({ request }) => {
  const response = await request.get('/.well-known/assetlinks.json');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: E2E_ANDROID.packageName, sha256_cert_fingerprints: [E2E_ANDROID.fingerprint] },
    },
  ]);
});

test('the console is installable: manifest scoped to /admin/', async ({ request }) => {
  const manifest = (await (await request.get('/admin/manifest.webmanifest')).json()) as Record<string, unknown> & {
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  expect(manifest).toMatchObject({ id: '/admin/', scope: '/admin/', start_url: '/admin/?source=pwa', display: 'standalone', orientation: 'any' });
  expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    const [width, height] = icon.sizes.split('x').map(Number);
    expect(pngSize(await (await request.get(`/admin/${icon.src}`)).body())).toEqual({ width, height });
  }
});

test('the console works offline only as far as saying it is offline', async ({ page, context }) => {
  await signInToConsole(page);
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration('/admin/'))?.active?.state === 'activated');
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/admin/sw.js'));

  // Offline, including the worker's own fetches (which setOffline alone
  // does not reach): every request to the server fails like a dead network.
  const dead = (route: import('@playwright/test').Route) => route.abort('internetdisconnected');
  await context.route('**/*', dead);
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByText("You're offline. The console needs a connection to show live data")).toBeVisible();
  } finally {
    await context.setOffline(false);
    await context.unroute('**/*', dead);
  }
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Command' })).toBeVisible();
});

test('the member and console workers never control each other’s pages', async ({ page }) => {
  await page.goto('/app/');
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration('/app/'))?.active?.state === 'activated');
  await page.goto('/admin/');
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration('/admin/'))?.active?.state === 'activated');

  const scopes = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort(),
  );
  expect(scopes).toEqual(['/admin/', '/app/']);

  // Which worker controls a page once one does (a navigation can race a
  // worker that has only just activated, so reload until it is controlled).
  const controllerOf = async (): Promise<string> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.reload();
      const script = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
      if (script) return new URL(script).pathname;
    }
    throw new Error('No service worker took control of the page');
  };
  expect(await controllerOf()).toBe('/admin/sw.js');
  await page.goto('/app/');
  expect(await controllerOf()).toBe('/app/sw.js');
  // The API is never under either scope.
  const apiControlled = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration('/v1/me')));
  expect(apiControlled).toBe(false);
});

test('a member worker left at scope / by an older release retires itself', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  });
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname)))
    .not.toContain('/');
});

test('the website at / forwards an activation link to the member app, keeping its fragment', async ({ page }) => {
  await page.goto('/#activationId=probe&activationToken=probe&gym=shark');
  await expect(page).toHaveURL(/\/app\/.*#activationId=probe&activationToken=probe&gym=shark$/);
  await expect(page.getByText(/Create your password/)).toBeVisible();
  expect(DEMO.gym).toBe('shark');
});
