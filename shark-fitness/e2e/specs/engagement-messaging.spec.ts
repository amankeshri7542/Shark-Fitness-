import { expect, test } from '../support/fixtures';
import { STAFF, signInToConsoleAs, signInToMemberApp } from '../support/demo';

/**
 * Member-started conversation answered from the staff Inbox (P07 AC2/AC9).
 * One browser context, one person at a time, so every page is under the CSP
 * listener.
 */
test('a member writes to the front desk, reception replies from the Inbox, the member reads it', async ({ page, context }) => {
  const words = `Is the steam room open on Sunday? (${Date.now()})`;

  await signInToMemberApp(page);
  await page.goto('/messages/new');
  await page.getByRole('radio', { name: /front desk/i }).check();
  await page.getByLabel('About').selectOption('facilities');
  await page.getByLabel('Message').fill(words);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page).toHaveURL(/\/messages\/cnv_/);
  await expect(page.getByText(words)).toBeVisible();
  const threadUrl = page.url();

  await context.clearCookies();
  await signInToConsoleAs(page, STAFF.reception, '/admin/inbox');
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await page.getByRole('region', { name: 'Conversations' }).getByRole('button', { name: /Aman Mehra/ }).first().click();
  await expect(page.getByRole('list', { name: 'Messages' }).getByText(words)).toBeVisible();
  await page.getByLabel('Add a note').fill('Regular Sunday visitor');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByRole('complementary', { name: 'Internal notes' }).getByText('Regular Sunday visitor')).toBeVisible();
  await page.getByLabel('Reply to the member').fill('Yes — 7am to 1pm on Sundays.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByRole('list', { name: 'Messages' }).getByText('Yes — 7am to 1pm on Sundays.')).toBeVisible();

  await context.clearCookies();
  await signInToMemberApp(page);
  await page.goto(threadUrl);
  await expect(page.getByText('Yes — 7am to 1pm on Sundays.')).toBeVisible();
  await expect(page.getByText('Regular Sunday visitor')).toHaveCount(0);
});
