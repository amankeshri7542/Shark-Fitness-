import { expect, test } from '../../support/fixtures';
import { DEMO, signInToMemberApp } from '../../support/demo';
import { apiAs, idbAll, ownerKey, parkOutboxEntries, waitForMemberWorker } from '../../support/member';
import { fakeSubscription } from '../../support/fake-push';
import { stubPushManager } from '../../support/push-stub';

/** PHASE-PLAN P04 criterion 4: leaving a shared phone, and a session that ends under you. */

test('sign-out warns about unsynced work, then leaves nothing of the member behind', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  const subscription = fakeSubscription(`${process.env.SHARK_E2E_PUSH_ORIGIN}/push/ok-signout-${test.info().project.name}`);
  await stubPushManager(page, subscription);
  await signInToMemberApp(page);
  await waitForMemberWorker(page);
  const owner = await ownerKey(page);

  // Push on for this phone, so sign-out has a subscription to remove.
  await page.goto('/app/profile');
  await page.getByRole('button', { name: 'Turn on notifications' }).click();
  await page.getByRole('button', { name: 'Allow notifications' }).click();
  await expect(page.getByText('On for this phone')).toBeVisible();
  const deviceId = await page.evaluate(() => (JSON.parse(localStorage.getItem('shark.member.push-device') ?? '{}') as { id?: string }).id);
  expect(deviceId).toBeTruthy();

  await parkOutboxEntries(page, owner, 3);
  await page.evaluate(() => {
    localStorage.setItem('shark.workout.plan', '{}');
    localStorage.setItem('shark.workout.done.e2e', '{}');
  });
  await expect.poll(async () => (await idbAll<{ owner: string }>(page, 'shark-query-cache', 'snapshots')).map((s) => s.owner)).toContain(owner);

  const signOut = page.getByTestId('sign-out');
  await signOut.getByRole('button', { name: 'Sign out', exact: true }).click();
  const warning = page.getByRole('alertdialog');
  await expect(warning).toContainText("3 workout sets haven't synced yet");
  await warning.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await idbAll<{ ownerKey: string }>(page, 'shark-outbox-v2', 'entries')).filter((e) => e.ownerKey === owner)).toHaveLength(3);

  await signOut.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signOut.getByRole('button', { name: 'Sign out anyway' }).click();
  await expect(page).toHaveURL(/\/app\/sign-in$/);

  expect((await idbAll<{ owner: string }>(page, 'shark-query-cache', 'snapshots')).filter((s) => s.owner === owner)).toEqual([]);
  expect((await idbAll<{ ownerKey: string }>(page, 'shark-outbox-v2', 'entries')).filter((e) => e.ownerKey === owner)).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('shark.workout')))).toEqual([]);

  // And the server no longer has this phone.
  const { api } = await apiAs(DEMO.member.email);
  const devices = (await (await api.get('/v1/me/push-subscriptions')).json()) as { items: Array<{ id: string }> };
  expect(devices.items.map((d) => d.id)).not.toContain(deviceId);
  await api.dispose();
});

test('a session that ends mid-use says so, and sign-in returns to the same screen with the queue intact', async ({ page }) => {
  await signInToMemberApp(page);
  const owner = await ownerKey(page);
  await parkOutboxEntries(page, owner, 2);

  // Another device signs this member out everywhere else.
  const { api, csrf } = await apiAs(DEMO.member.email);
  const sessions = (await (await api.get('/v1/me/sessions')).json()) as { items: Array<{ id: string; current: boolean }> };
  for (const session of sessions.items.filter((s) => !s.current)) {
    const revoked = await api.delete(`/v1/me/sessions/${session.id}`, { headers: { 'x-csrf-token': csrf } });
    expect(revoked.ok()).toBe(true);
  }
  await api.dispose();

  await page.getByRole('navigation', { name: 'Main' }).locator('a[href="/app/progress"]').click();
  await expect(page.getByText('Your session ended')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/sign-in$/);
  expect((await idbAll<{ ownerKey: string }>(page, 'shark-outbox-v2', 'entries')).filter((e) => e.ownerKey === owner)).toHaveLength(2);

  await page.getByLabel('Gym code').fill(DEMO.gym);
  await page.getByLabel('Email').fill(DEMO.member.email);
  await page.getByLabel('Password').fill(DEMO.member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/progress$/);
  await expect(page.getByText('Your session ended')).toHaveCount(0);
  expect((await idbAll<{ ownerKey: string }>(page, 'shark-outbox-v2', 'entries')).filter((e) => e.ownerKey === owner)).toHaveLength(2);
});
