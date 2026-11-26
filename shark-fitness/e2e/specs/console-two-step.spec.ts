import { expect, test } from '../support/fixtures';
import { totpFor } from '../support/totp';
import { submitSignIn } from '../support/demo';

/**
 * PRD 04 ENT-IAM-001: an owner without two-step sign-in meets the enrolment
 * gate after their password, cannot reach the console until it is done, and
 * signs in with a code from then on. Reef Athletic's owner is seeded without
 * it — exactly the state the demo owners are in on a fresh deployment.
 */
test('an owner without MFA is gated to enrolment, enrols, and is asked for a code next time', async ({ page }) => {
  await page.goto('/admin/');
  await page.getByLabel('Gym code').fill('reef');
  await page.getByLabel('Work email').fill('owner@reefathletic.in');
  await page.getByLabel('Password').fill('shark1234');
  await submitSignIn(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Set up two-step sign-in' })).toBeVisible();
  await expect(page.getByText(/Owners, regional managers and platform staff must use two-step sign-in/)).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code to add owner@reefathletic.in/ })).toBeVisible();
  // Nothing else works while the gate is up.
  expect((await page.request.get('/v1/admin/dashboard')).status()).toBe(401);

  const secret = (await page.getByTestId('mfa-setup-key').innerText()).replace(/\s/g, '');
  await page.getByLabel('6-digit code').fill(totpFor(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();

  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  const recovery = await codes.first().innerText();
  await page.getByLabel('I have stored these codes somewhere safe').check();
  await page.getByRole('button', { name: 'Continue to the console' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Command' })).toBeVisible();

  // Next time: password, then a code. A recovery code works once.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Gym code').fill('reef');
  await page.getByLabel('Work email').fill('owner@reefathletic.in');
  await page.getByLabel('Password').fill('shark1234');
  await submitSignIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(recovery);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Command' })).toBeVisible();
});
