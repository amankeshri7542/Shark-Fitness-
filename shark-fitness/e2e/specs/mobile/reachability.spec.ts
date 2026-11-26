import { expect, test } from '../../support/fixtures';
import { signInToMemberApp } from '../../support/demo';

/** PHASE-PLAN P04 criterion 6: nothing is a dead end, nothing is out of reach. */

test('Notifications is one tap from Home', async ({ page }) => {
  await signInToMemberApp(page);
  await page.getByRole('link', { name: /^Notifications/ }).click();
  await expect(page).toHaveURL(/\/app\/notifications$/);
});

for (const [name, path] of [
  ['Billing', '/app/billing'],
  ['Library', '/app/library'],
  ['Messages', '/app/messages'],
  ['Help', '/app/help'],
] as const) {
  test(`${name} is two taps from Home`, async ({ page }) => {
    await signInToMemberApp(page);
    await page.getByRole('link', { name: 'Your profile and settings' }).click();
    await page.getByRole('navigation', { name: 'More' }).getByRole('link', { name: new RegExp(`^${name}`) }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByText('Something went wrong.')).toHaveCount(0);
  });
}

test('the workout summary has a way out: Done returns Home', async ({ page }) => {
  await signInToMemberApp(page);
  // A session finished on this phone that the server has not seen yet.
  await page.evaluate(() =>
    localStorage.setItem(
      'shark.workout.done.e2e-summary',
      JSON.stringify({
        clientId: 'e2e-summary',
        title: 'Upper body',
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        finishedAt: new Date().toISOString(),
        durationSec: 3_300,
        volumeKg: 6_250,
        totalSets: 18,
        completedSets: 18,
        exerciseCount: 5,
        sessionRpe: 8,
        muscleVolume: [],
      }),
    ),
  );
  await page.goto('/app/workout/summary/e2e-summary');
  await expect(page.getByText('Upper body')).toBeVisible();
  await page.getByRole('link', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});
