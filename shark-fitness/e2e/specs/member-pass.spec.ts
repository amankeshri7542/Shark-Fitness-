import { expect, test } from '@playwright/test';
import { DEMO, signInToMemberApp } from '../support/demo';

/**
 * The rotating entry pass on a phone (P05 acceptance 1; PF-ATT-005).
 *
 * The page clock is driven by the test, so "before the countdown ends" is an
 * exact statement rather than a race with the wall clock.
 */

test('the QR code changes to a new token before its countdown runs out @mobile', async ({ page }) => {
  await page.clock.install();
  await signInToMemberApp(page, DEMO.member);
  await page.goto('/pass');

  const qr = page.locator('svg[data-qr-value]');
  await expect(qr).toBeVisible();
  const first = await qr.getAttribute('data-qr-value');
  const countdown = page.getByTestId('pass-countdown');
  const secondsLeft = Number(await countdown.textContent());
  expect(secondsLeft).toBeGreaterThan(0);

  // One second before the countdown would reach zero: still the same code.
  if (secondsLeft > 1) {
    await page.clock.runFor((secondsLeft - 1) * 1000);
    await expect(countdown).toHaveText('1');
    expect(await qr.getAttribute('data-qr-value')).toBe(first);
  }

  // The countdown ends: a different code is already on screen, with a full window.
  await page.clock.runFor(1200);
  await expect(qr).not.toHaveAttribute('data-qr-value', first!);
  const next = Number(await countdown.textContent());
  expect(next).toBeGreaterThan(20);
});

test('offline, the pass shows the member number and says reception can use it @mobile', async ({ page, context }) => {
  await signInToMemberApp(page, DEMO.member);
  await page.goto('/pass');
  await expect(page.locator('svg[data-qr-value]')).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByText('Reception can check you in with this number.')).toBeVisible();
  await expect(page.locator('svg[data-qr-value]')).toHaveCount(0);
  await expect(page.getByText(/SF-\d+/).first()).toBeVisible();
  await context.setOffline(false);
});
