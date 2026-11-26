import { expect, test } from '../support/fixtures';
import { DEMO, signInToConsole } from '../support/demo';
import { ageReauthentication } from '../support/db';
import { nextOwnerCode } from '../support/totp';

/**
 * Step-up (PRD 01 §2.4): five minutes after the last password check, an
 * export asks for the password and code again in one dialog, and the export
 * then completes without the person pressing anything else.
 */
// Each test signs the owner in and may wait for a fresh 30-second code.
test.describe.configure({ timeout: 120_000 });

test('an export after five minutes asks to confirm it’s you, then completes', async ({ page }) => {
  await signInToConsole(page);
  await page.goto('/admin/reports?tab=attendance');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  ageReauthentication(DEMO.owner.email);

  const exportRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/v1/admin/reports/export')) exportRequests.push(request.postData() ?? '');
  });
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill(DEMO.owner.password);
  await dialog.getByLabel('Authenticator code').fill(await nextOwnerCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /^Save shark-attendance-/ })).toBeVisible();
  // The same request, sent again after the check.
  expect(exportRequests).toHaveLength(2);
  expect(exportRequests[1]).toBe(exportRequests[0]);
});

test('an owner adds a webhook endpoint and sees its signing secret once', async ({ page }) => {
  await signInToConsole(page);
  await page.goto('/admin/settings?tab=integrations');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Add endpoint' }).first().click();
  const form = page.getByRole('dialog', { name: 'Add endpoint' });
  await form.getByLabel('Endpoint URL').fill('https://crm.example.com/hooks/shark');
  await form.getByLabel(/Lead created/).check();
  await form.getByLabel(/Payment received/).check();
  await form.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByTestId('webhook-secret')).toHaveText(/^whsec_/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('https://crm.example.com/hooks/shark')).toBeVisible();

  // A private address is refused with a plain reason.
  await page.getByRole('button', { name: 'Add endpoint' }).first().click();
  const second = page.getByRole('dialog', { name: 'Add endpoint' });
  await second.getByLabel('Endpoint URL').fill('https://169.254.169.254/latest/meta-data');
  await second.getByRole('button', { name: 'Select all' }).click();
  await second.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(second.getByRole('alert')).toContainText('private, link-local or reserved');
});
