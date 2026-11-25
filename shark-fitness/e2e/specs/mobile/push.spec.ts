import { expect, test } from '../../support/fixtures';
import { DEMO, signInToMemberApp } from '../../support/demo';
import { apiAs, waitForMemberWorker } from '../../support/member';
import { fakeSubscription, type Received } from '../../support/fake-push';
import { stubPushManager } from '../../support/push-stub';

/**
 * PHASE-PLAN P04 criterion 8, end to end: the member switches push on in the
 * app, staff write to them, the server encrypts and sends to the (local, fake)
 * push service, and the service worker shows that payload as a notification.
 * Headless Chromium cannot reach a real push service, so the subscription
 * comes from a stubbed PushManager and the delivery into the worker goes
 * through the DevTools protocol, carrying exactly the bytes the server sent.
 */
test('switching push on, receiving a staff message, and switching it off', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  const push = process.env.SHARK_E2E_PUSH_ORIGIN!;
  const subscription = fakeSubscription(`${push}/push/ok-${test.info().project.name}-${Date.now()}`);
  await stubPushManager(page, subscription);
  await signInToMemberApp(page);
  await waitForMemberWorker(page);

  await page.goto('/app/profile');
  const settings = page.getByTestId('push-settings');
  await settings.getByRole('button', { name: 'Turn on notifications' }).click();
  // The rationale comes before any permission prompt.
  await expect(settings).toContainText('No offers or marketing');
  await settings.getByRole('button', { name: 'Allow notifications' }).click();
  await expect(settings.getByText('On for this phone')).toBeVisible();
  const deviceId = await page.evaluate(() => (JSON.parse(localStorage.getItem('shark.member.push-device') ?? '{}') as { id?: string }).id);
  expect(deviceId).toBeTruthy();

  // Staff write to the member.
  const desk = await apiAs('reception@sharkfitness.in');
  const memberId = await page.evaluate(async () => ((await (await fetch('/v1/me')).json()) as { viewer: { memberId: string } }).viewer.memberId);
  const sent = await desk.api.post('/v1/admin/members/bulk/message', {
    headers: { 'x-csrf-token': desk.csrf },
    data: { memberIds: [memberId], body: 'Your physio note about the left knee is ready.' },
  });
  expect(sent.ok()).toBe(true);
  await desk.api.dispose();

  // The fake push service received one encrypted, VAPID-signed request.
  const endpointPath = new URL(subscription.endpoint).pathname;
  let delivery: Received | undefined;
  await expect
    .poll(async () => {
      const received = (await (await fetch(`${push}/__received`)).json()) as Received[];
      delivery = received.find((r) => r.path === endpointPath);
      return Boolean(delivery);
    })
    .toBe(true);
  expect(delivery!.headers['content-encoding']).toBe('aes128gcm');
  expect(String(delivery!.headers.authorization)).toMatch(new RegExp(`^vapid t=[^,]+, k=${process.env.SHARK_E2E_VAPID_PUBLIC_KEY}$`));
  const payload = JSON.parse(subscription.decrypt(delivery!.body)) as { title: string; body: string; path: string };
  expect(payload.title).toMatch(/^New message from /);
  expect(payload.path).toMatch(/^\/messages\/cnv_/);
  expect(JSON.stringify(payload)).not.toContain('knee');

  // Hand those bytes' plaintext to the service worker as a push event.
  const cdp = await context.newCDPSession(page);
  const registrationId = await new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const registration = registrations.find((r: { scopeURL: string; isDeleted: boolean }) => r.scopeURL.endsWith('/app/') && !r.isDeleted);
      if (registration) resolve(registration.registrationId as string);
    });
    void cdp.send('ServiceWorker.enable');
  });
  const titles = () =>
    page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration('/app/'))!.getNotifications()).map((n) => n.title));
  // A push to a worker that is just waking can be dropped by the protocol;
  // deliver again until the worker has shown it (the tag collapses repeats).
  await expect
    .poll(
      async () => {
        if (!(await titles()).includes(payload.title)) {
          await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(page.url()).origin, registrationId, data: JSON.stringify(payload) });
          await page.waitForTimeout(300);
        }
        return titles();
      },
      { timeout: 15_000 },
    )
    .toContain(payload.title);
  const shown = await page.evaluate(async () => {
    const [notification] = await (await navigator.serviceWorker.getRegistration('/app/'))!.getNotifications();
    return { body: notification!.body, data: notification!.data as { path: string } };
  });
  expect(shown).toEqual({ body: payload.body, data: { path: payload.path } });

  // Off again: the server forgets this phone.
  await settings.getByRole('button', { name: 'Turn off on this phone' }).click();
  await expect(settings.getByRole('button', { name: 'Turn on notifications' })).toBeVisible();
  const member = await apiAs(DEMO.member.email);
  const left = ((await (await member.api.get('/v1/me/push-subscriptions')).json()) as { items: Array<{ id: string }> }).items;
  expect(left.map((d) => d.id)).not.toContain(deviceId);
  await member.api.dispose();
});
