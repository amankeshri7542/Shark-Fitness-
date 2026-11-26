import { expect, test } from '../support/fixtures';
import { STAFF, signInToConsoleAs } from '../support/demo';

/** Compose, preview, save and send an in-app broadcast (P07 AC6/AC9). */
test('a manager previews who a broadcast reaches and what it costs, then sends it', async ({ page }) => {
  await signInToConsoleAs(page, STAFF.manager, '/admin/marketing');
  await expect(page.getByRole('heading', { level: 1, name: 'Marketing' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Message channels' })).toContainText('Logged only');

  const name = `Holiday hours ${Date.now()}`;
  await page.getByRole('button', { name: 'New broadcast' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New broadcast' });
  await dialog.getByLabel('Name (staff only)').fill(name);
  await dialog.getByLabel('Title').fill('Holiday hours');
  await dialog.getByLabel('Message').fill('Hi {{firstName}}, Koramangala opens at 8am on Monday.');
  await dialog.getByRole('button', { name: 'Check who it reaches' }).click();
  await expect(dialog.getByRole('region', { name: 'Who it reaches' })).toContainText(/will get it by in-app/);
  await expect(dialog.getByRole('table', { name: 'Estimated cost by channel' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save draft' }).click();

  const drawer = page.getByRole('dialog', { name });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Dry run' }).click();
  await expect(drawer.getByRole('status')).toContainText('Nothing was sent.');
  await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('dialog', { name: 'Send this broadcast?' }).getByRole('button', { name: 'Send now' }).click();
  // In-app is delivered at once: the report counts every recipient as sent.
  await expect(drawer.getByRole('region', { name: 'Delivery report' })).toContainText(/sent[1-9]\d*/);
});
