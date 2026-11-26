import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';
import { STAFF, signInToConsoleAs } from '../support/demo';

/**
 * The command palette (P07 AC8), as reception at the desk, with one sign-in:
 * axe finds no violations in the open palette; keyboard only from Ctrl+K to
 * a member's page; Record payment reaches the payment form; Add member adds
 * a walk-in.
 */
test('the command palette searches and acts, by keyboard', async ({ page }) => {
  await signInToConsoleAs(page, STAFF.reception);

  // Accessibility of the open palette with results showing.
  await page.keyboard.press('Control+k');
  const combo = page.getByRole('combobox', { name: 'Search and commands' });
  await expect(combo).toBeFocused();
  await page.keyboard.type('am');
  await expect(page.getByRole('option').first()).toBeVisible();
  const scan = await new AxeBuilder({ page }).include('[role="dialog"][aria-label="Search and commands"]').analyze();
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  await page.keyboard.press('Escape');

  // Keyboard only: Ctrl+K, type a name, arrow to the member, Enter.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Aman Meh');
  const member = page.getByRole('option', { name: /^Aman Mehra/ });
  await expect(member).toBeVisible();
  for (let i = 0; i < 10 && (await member.getAttribute('aria-selected')) !== 'true'; i++) await page.keyboard.press('ArrowDown');
  await expect(member).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/members\/mbr_/);
  await expect(page.getByRole('heading', { level: 1, name: 'Aman Mehra' })).toBeVisible();

  // Record payment: find the invoice, land on its payment form.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Record payment');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Find the invoice' })).toBeFocused();
  await page.keyboard.type('SF-2026');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/billing\?.*invoice=/);
  await expect(page.getByRole('dialog', { name: 'Record payment' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Add member from the palette.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Add member');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add a member' });
  await dialog.getByLabel('Full name').fill('Esha Walkin');
  await dialog.getByLabel('Phone').fill(`98${String(Date.now()).slice(-8)}`);
  await dialog.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByRole('dialog', { name: 'Member added' })).toContainText('Esha Walkin is SF-');
  await page.getByRole('button', { name: 'Open member' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Esha Walkin' })).toBeVisible();
});
