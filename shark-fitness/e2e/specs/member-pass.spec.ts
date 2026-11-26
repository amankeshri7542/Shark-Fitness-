import { expect, test } from '../support/fixtures';
import { DEMO, signInToMemberApp } from '../support/demo';

/**
 * The rotating entry pass on a phone (P05 acceptance 1; PF-ATT-005).
 *
 * The page clock is driven by the test, so "before the countdown ends" is an
 * exact statement rather than a race with the wall clock.
 */

test('the QR code changes to a new token before its countdown runs out; offline it shows the member number @mobile', async ({ page, context }) => {
  await page.clock.install();
  await signInToMemberApp(page, DEMO.member);
  await page.goto('/app/pass');

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
  expect(Number(await countdown.textContent())).toBeGreaterThan(20);

  // No signal: no code to scan, the member number and what to do with it.
  await context.setOffline(true);
  await expect(page.getByText('Reception can check you in with this number.')).toBeVisible();
  await expect(qr).toHaveCount(0);
  await expect(page.getByText(/SF-\d+/).first()).toBeVisible();
  await context.setOffline(false);
});
