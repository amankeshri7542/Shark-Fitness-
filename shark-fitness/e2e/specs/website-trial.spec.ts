import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInToConsole } from '../support/demo';

/**
 * A visitor books a free trial on the public website using only the keyboard,
 * on a desktop and a phone (website-mobile project). The lead then appears in
 * the console's Leads board as a Website lead with the trial chip and the QR
 * campaign it came from.
 */

/** Presses Tab until `target` has focus: keyboard only, no clicks. */
async function tabTo(page: Page, target: Locator, max = 60): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Could not reach ${target} with the Tab key`);
}

test('a visitor requests a free trial with the keyboard and it reaches the Leads board', async ({ page }, testInfo) => {
  const visitor = `Kavya ${testInfo.project.name === 'website-mobile' ? 'Mobile' : 'Desktop'} ${Date.now() % 100_000}`;
  const campaign = `e2e-qr-${testInfo.project.name}`;

  // A QR code on a poster lands on the home page with a campaign; the visitor
  // then goes to the free-trial page. Attribution must survive the hop.
  await page.goto(`/?utm_source=qr&utm_medium=poster&utm_campaign=${campaign}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/free-trial');

  const form = page.locator('form');
  const name = page.getByLabel('Your name');
  const status = page.locator('#form-status');
  await expect(status).toHaveAttribute('aria-live', 'assertive');

  // Send it empty: errors are announced and focus lands on the first field.
  const submit = page.getByRole('button', { name: 'Request my free trial' });
  await tabTo(page, submit);
  await page.keyboard.press('Enter');
  await expect(status).toContainText('fields need attention');
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#name-error')).toHaveText('Enter your name.');

  await page.keyboard.type(visitor);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Mobile number')).toBeFocused();
  await page.keyboard.type('12345');

  // A bad number is caught before sending, and focus returns to it.
  await tabTo(page, submit);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Mobile number')).toBeFocused();
  await expect(page.locator('#phone-error')).toContainText('10-digit');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(`98${String(Date.now()).slice(-8)}`);

  // Branch: a native select, changed with the arrow keys.
  const branch = page.getByRole('combobox', { name: 'Branch' });
  await tabTo(page, branch);
  await page.keyboard.press('ArrowDown');
  await expect(branch).not.toHaveValue('');

  // The class list loads for that branch; pick the first open class with the arrows.
  const none = page.getByRole('radio', { name: /No particular class/ });
  await expect(none).toBeChecked();
  await tabTo(page, none);
  await page.keyboard.press('ArrowDown');
  const chosen = page.locator('input[name="classSessionId"]:checked');
  await expect(chosen).not.toHaveValue('');

  const consent = page.getByRole('checkbox', { name: /may use these details/ });
  await tabTo(page, consent);
  await page.keyboard.press('Space');
  await expect(consent).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /offers and news/ })).not.toBeChecked();

  // A person takes longer than three seconds; the API drops faster submissions as bots.
  await page.waitForTimeout(3_200);
  await tabTo(page, submit);
  await page.keyboard.press('Enter');

  const done = page.getByRole('heading', { name: 'Request received' });
  await expect(done).toBeVisible();
  await expect(page.locator('[data-form-done]')).toBeFocused();
  await expect(form).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('trial-received.png'), fullPage: true });

  // Staff side.
  await signInToConsole(page);
  await page.goto('/admin/leads');
  await page.getByRole('button', { name: 'Website' }).click();
  const card = page.getByRole('link', { name: new RegExp(visitor) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Website');
  await expect(card).toContainText('trial requested');
  await expect(card).toContainText(campaign);
});

test('the contact form needs a question and reports it on the field', async ({ page }) => {
  await page.goto('/contact');
  await page.getByLabel('Your name').fill('Rohan');
  await page.getByLabel('Mobile number').fill('9845012345');
  await page.getByRole('combobox', { name: 'Branch' }).selectOption({ index: 1 });
  await page.getByRole('checkbox', { name: /may use these details/ }).check();
  await page.getByRole('button', { name: 'Send my question' }).click();
  await expect(page.getByLabel('Your question')).toBeFocused();
  await expect(page.locator('#message-error')).toHaveText('Tell us what you would like to know.');
});
