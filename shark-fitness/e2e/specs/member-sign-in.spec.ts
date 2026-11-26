import { expect, test } from '../support/fixtures';
import { signInToMemberApp } from '../support/demo';

test('a member signs in to the app and lands on Home', async ({ page }) => {
  await signInToMemberApp(page);

  await expect(page).toHaveURL(/\/app\/$/);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', '/app/');
  // Home's hero and today's plan, rendered from the member's own data. The
  // words follow the member's copy tone, so check structure, not wording.
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Your profile and settings' })).toBeVisible();
  await expect(page.getByText('Something went wrong.')).toHaveCount(0);
});
