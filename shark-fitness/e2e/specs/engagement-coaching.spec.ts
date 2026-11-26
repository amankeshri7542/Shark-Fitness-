import { expect, test } from '../support/fixtures';
import { STAFF, signInToConsoleAs } from '../support/demo';

/** A coach opens an assigned member and adds a habit from a template (P07 AC5/AC9). */
test('a coach sees their member and assigns a habit template', async ({ page }) => {
  await signInToConsoleAs(page, STAFF.coach, '/admin/coaching');
  await expect(page.getByRole('heading', { level: 1, name: 'Nutrition & Habits' })).toBeVisible();
  await page.getByRole('region', { name: 'Your members' }).getByRole('button', { name: /Aman Mehra/ }).click();
  await expect(page.getByRole('region', { name: 'Habits' })).toBeVisible();
  const add = page.getByRole('button', { name: '+ Mobility 10 minutes' });
  await add.click();
  await expect(add).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Habits' }).getByText('Mobility 10 minutes')).toBeVisible();
});
