import { expect, test } from '../support/fixtures';
import { STAFF, signInToConsoleAs } from '../support/demo';

/** Create a task, see it in the strip, finish it with an outcome (P07 AC4/AC9). */
test('a manager creates a task, sees it under My tasks and finishes it with an outcome', async ({ page }) => {
  await signInToConsoleAs(page, STAFF.manager, '/admin/tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  const title = `Restock towels ${Date.now()}`;
  await page.getByRole('button', { name: 'New task' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('What needs doing').fill(title);
  await dialog.getByLabel('Priority').selectOption('high');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByRole('link', { name: /^My tasks:/ })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  const drawer = page.getByRole('dialog', { name: title });
  await drawer.getByLabel('What happened').fill('Two packs from the store room.');
  await drawer.getByRole('button', { name: 'Mark done' }).click();
  await expect(drawer.getByText('Two packs from the store room.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
});
