import { expect, test } from '../support/fixtures';

/**
 * The member app moved from / to /app/ when the website took /. Links and
 * installs made before the move must still land in the app.
 */

test('a legacy activation link on / lands on /app/ with the same fragment', async ({ page }) => {
  await page.goto('/#activationId=x&tenant=y');
  await expect(page).toHaveURL(/\/app\/(sign-in)?#activationId=x&tenant=y$/);
  await expect(page.getByLabel('Gym code')).toBeVisible();
});

test('a legacy recovery link on /sign-in reaches the member sign-in under /app/', async ({ page }) => {
  await page.goto('/sign-in#recoveryId=r1&recoveryToken=t1&gym=shark');
  await expect(page).toHaveURL(/\/app\/sign-in#recoveryId=r1&recoveryToken=t1&gym=shark$/);
});

test('the website, the member app and the console each load at their own path', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Book a free trial' }).first()).toBeVisible();
  await page.goto('/app/');
  await expect(page.getByLabel('Gym code')).toBeVisible();
  await page.goto('/admin/');
  await expect(page.getByLabel('Work email')).toBeVisible();
});

test.describe('service worker left behind by the old member app', () => {
  test.use({ serviceWorkers: 'allow' });

  test('a worker registered at scope / is gone after visiting /', async ({ context, page }) => {
    // Stand in for the old member worker: same URL (/sw.js), same scope (/).
    await context.route('**/sw.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>e.respondWith(fetch(e.request)));",
      }),
    );
    await page.goto('/about');
    const registered = await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      return (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname);
    });
    expect(registered).toContain('/');
    await context.unroute('**/sw.js');

    await page.goto('/');
    await expect
      .poll(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname)), {
        timeout: 15_000,
      })
      .not.toContain('/');
  });

  test('a worker that answers / with its cached shell is replaced by /sw.js and the website loads', async ({ context, page }) => {
    // The real legacy case: the old worker controls / and serves its own cached
    // shell, so no website script ever runs. Only the browser's update check
    // of /sw.js (the website's self-unregistering worker) can retire it.
    await context.route('**/sw.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: [
          "self.addEventListener('install',()=>self.skipWaiting());",
          "self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));",
          "self.addEventListener('fetch',e=>{if(e.request.mode==='navigate'){e.respondWith(new Response('<!doctype html><title>old</title><p id=\"old-shell\">Old member shell</p>',{headers:{'content-type':'text/html'}}))}});",
        ].join(''),
      }),
    );
    await page.goto('/about');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    });
    await context.unroute('**/sw.js');

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#old-shell')).toHaveCount(0);
    await expect
      .poll(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname)), {
        timeout: 15_000,
      })
      .not.toContain('/');
  });
});
