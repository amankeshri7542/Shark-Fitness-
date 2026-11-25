import { expect, test } from '@playwright/test';
import { signInToConsole } from '../support/demo';

test('the owner signs in to the console and lands on Command Center', async ({ page }) => {
  await signInToConsole(page);

  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Command' })).toBeVisible();
  // Real data from the seeded gym, not an error or empty state.
  await expect(page.getByText('Could not load the console')).toHaveCount(0);
  await expect(page.getByText("Today's classes")).toBeVisible();
});
