import { expect, test } from '@playwright/test';
import { DEMO, signInToMemberApp } from '../support/demo';

/**
 * Logging a workout of your own with no signal (P05 acceptance 7; PF-WORK-004/005).
 *
 * The service worker is allowed here, as on a member's phone: it is what lets
 * the app reload with no connection. Six sets logged offline survive the
 * reload and reach the server exactly once when the connection returns.
 */
test.use({ serviceWorkers: 'allow' });

test('2 exercises × 3 sets logged offline, reloaded, then synced once @mobile', async ({ page, context }) => {
  await signInToMemberApp(page, DEMO.member);
  // Let the service worker take control so the app shell loads offline.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await page.goto('/workout?mode=freestyle');
  await expect(page.getByRole('heading', { name: 'Build your session' })).toBeVisible();
  const library = page.getByRole('list', { name: 'Exercise library' }).getByRole('button');
  await expect(library.first()).toBeVisible();
  await library.nth(0).click();
  await library.nth(1).click();
  await page.getByRole('button', { name: 'Start · 2 exercises' }).click();

  const clientId = await page.evaluate(() => (JSON.parse(localStorage.getItem('shark.workout.plan') ?? '{}') as { clientId?: string }).clientId);
  expect(clientId).toBeTruthy();

  await context.setOffline(true);
  // Log every set: three of the first exercise, then (the screen moves on by
  // itself) three of the second.
  const loggedOnPhone = () =>
    page.evaluate(() => (JSON.parse(localStorage.getItem('shark.workout') ?? '{}') as { sets?: Array<{ done: boolean }> }).sets?.filter((s) => s.done).length ?? 0);
  for (let i = 0; i < 6; i += 1) {
    await page.getByRole('button', { name: /^Log set \d+$/ }).first().click();
    // Each set is on the phone before the next tap, as a member would see it tick.
    await expect.poll(loggedOnPhone).toBe(i + 1);
  }
  await page.reload();
  await expect(page.getByRole('button', { name: 'Finish this session' })).toBeVisible();

  await context.setOffline(false);
  interface Stored {
    workout: { clientId: string; assignmentId: string | null; sets: Array<{ clientId: string; exerciseId: string }> };
  }
  const read = async (): Promise<Stored | null> => {
    const response = await page.request.get(`/v1/member/training/workouts/${clientId}`);
    return response.status() === 200 ? ((await response.json()) as Stored) : null;
  };
  await expect.poll(async () => (await read())?.workout.sets.length ?? -1, { timeout: 30_000 }).toBe(6);

  // Exactly once: one session, six distinct sets across the two exercises,
  // and still six after the outbox has had time to run again.
  await page.waitForTimeout(1_000);
  const stored = (await read())!;
  expect(stored.workout.clientId).toBe(clientId);
  expect(stored.workout.assignmentId).toBeNull();
  expect(new Set(stored.workout.sets.map((set) => set.clientId)).size).toBe(6);
  expect(new Set(stored.workout.sets.map((set) => set.exerciseId)).size).toBe(2);
});
