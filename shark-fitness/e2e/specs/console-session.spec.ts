import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { DEMO } from '../support/demo';

/** The Koramangala branch manager: no two-step sign-in required, so no code to wait for. */
const MANAGER = { email: 'manager@sharkfitness.in', password: DEMO.owner.password };

async function fillSignIn(page: Page): Promise<void> {
  await page.getByLabel('Gym code').fill(DEMO.gym);
  await page.getByLabel('Work email').fill(MANAGER.email);
  await page.getByLabel('Password').fill(MANAGER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/admin/');
  await fillSignIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Command' })).toBeVisible();
}

/**
 * Sessions (PRD 04 ENT-IAM-003): "Your devices" signs another session out,
 * that session's next request is refused, and its console shows "Session
 * expired" and comes back to the same page after signing in again.
 */
test('revoking a device ends that session, which returns to the same page after signing in', async ({ browser, page }) => {
  // The device that will be signed out: deep in the console, with filters in the URL.
  await signIn(page);
  await page.goto('/admin/reports?tab=attendance&from=2026-05-21&to=2026-06-18');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();

  // Another device signs the first one out from Your devices.
  const other = await browser.newContext();
  const laptop = await other.newPage();
  await signIn(laptop);
  await laptop.getByRole('link', { name: /Your account/ }).click();
  const devices = laptop.getByRole('table', { name: 'Devices signed in as you' });
  await expect(devices.getByText('This device')).toBeVisible();
  const signOutButtons = devices.getByRole('button', { name: /^Sign out / });
  await expect(signOutButtons.first()).toBeVisible();
  const before = await signOutButtons.count();
  await signOutButtons.first().click();
  await laptop.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(signOutButtons).toHaveCount(before - 1);
  await other.close();

  // The revoked session is refused by the server…
  const refused = await page.request.get('/v1/admin/members');
  expect(refused.status()).toBe(401);
  expect((await refused.json()).error.details.reason).toBe('revoked');

  // …and its console says so at the next action, keeping the URL it is on.
  await page.getByRole('tab', { name: 'Membership' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Session expired' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('signed out, from Your devices or by an administrator');
  const where = new URL(page.url());
  expect(where.pathname).toBe('/admin/reports');
  expect(where.searchParams.get('tab')).toBe('membership');
  await dialog.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in\?redirect=/);
  await expect(page.getByText('Your session ended. Sign in again to go back to where you were.')).toBeVisible();
  await fillSignIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  expect(page.url()).toBe(where.toString());
});
