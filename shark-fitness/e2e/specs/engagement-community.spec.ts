import { expect, test } from '../support/fixtures';
import { STAFF, signInToConsoleAs, signInToMemberApp } from '../support/demo';

/** Report in the member feed → staff removes it from the Community queue (P07 AC3/AC9). */
test('a reported post reaches the moderation queue and a manager removes it with a reason', async ({ page, context }) => {
  await signInToMemberApp(page);
  await page.goto('/app/pack');
  const post = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Report' }) }).first();
  await expect(post).toBeVisible();
  const body = (await post.locator('p').nth(0).textContent())?.trim() ?? '';
  await post.getByRole('button', { name: 'Report' }).first().click();
  await page.getByRole('group', { name: 'Confirm' }).getByRole('combobox').selectOption('spam');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Reported/ })).toBeVisible();

  await context.clearCookies();
  await signInToConsoleAs(page, STAFF.manager, '/admin/community');
  await expect(page.getByRole('heading', { level: 1, name: 'Community' })).toBeVisible();
  const item = page.getByRole('listitem').filter({ hasText: body.slice(0, 30) }).first();
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove this' });
  await dialog.getByLabel('Reason (the member is told this)').fill('Selling is not allowed in the feed.');
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: body.slice(0, 30) })).toHaveCount(0);
});
