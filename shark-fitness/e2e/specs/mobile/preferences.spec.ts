import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { DEMO, signInToMemberApp } from '../../support/demo';
import { apiAs } from '../../support/member';

/** PHASE-PLAN P04 criterion 5: saved preferences actually change the app. */

async function savePreference(page: Page, group: string, option: string): Promise<void> {
  const saved = page.waitForResponse((r) => r.url().endsWith('/v1/me/preferences') && r.request().method() === 'PATCH');
  await page.getByText(group, { exact: true }).locator('xpath=..').getByRole('tab', { name: option }).click();
  expect((await saved).ok()).toBe(true);
}

async function resetPreferences(): Promise<void> {
  const { api, csrf } = await apiAs(DEMO.member.email);
  await api.patch('/v1/me/preferences', {
    headers: { 'x-csrf-token': csrf },
    data: { theme: 'dark', unitSystem: 'metric', reducedMotion: false, haptics: true },
  });
  await api.dispose();
}

test.afterEach(resetPreferences);

test('theme switches at once and the next load paints it before the app starts', async ({ page }) => {
  await signInToMemberApp(page);
  await page.goto('/app/profile');
  await savePreference(page, 'Theme', 'Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(lightBackground).toBe('rgb(238, 242, 244)');

  // Record every theme the document ever has on the next load, and whether
  // the app had rendered anything yet when it got it.
  await page.addInitScript(() => {
    const seen: Array<{ theme: string | null; rendered: boolean }> = [];
    (window as unknown as { __themes: typeof seen }).__themes = seen;
    new MutationObserver(() => {
      seen.push({
        theme: document.documentElement.getAttribute('data-theme'),
        rendered: Boolean(document.getElementById('root')?.childElementCount),
      });
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-theme'] });
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const themes = await page.evaluate(() => (window as unknown as { __themes: Array<{ theme: string; rendered: boolean }> }).__themes);
  expect(themes[0]).toEqual({ theme: 'light', rendered: false });
  expect(themes.every((entry) => entry.theme === 'light')).toBe(true);

  await savePreference(page, 'Theme', 'Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('reduce motion stops animation', async ({ page }) => {
  await signInToMemberApp(page);
  await page.goto('/app/profile');
  const liveDot = page.locator('header .animate-breath').first();
  const duration = () => liveDot.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
  expect(await duration()).toBeGreaterThan(1);

  await page.getByText('Reduce motion', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  expect(await duration()).toBeLessThan(0.01);
});

test('pounds: Progress shows records converted from the stored kilograms', async ({ page }) => {
  await signInToMemberApp(page);
  await page.goto('/app/progress');
  // Seeded record: 182.5 kg deadlift.
  await expect(page.getByText('182.5 kg', { exact: true })).toBeVisible();

  await page.goto('/app/profile');
  await savePreference(page, 'Units', 'lb');
  await page.goto('/app/progress');
  // 182.5 / 0.45359237 = 402.34
  await expect(page.getByText('402.3 lb', { exact: true })).toBeVisible();
  await expect(page.getByText('182.5 kg', { exact: true })).toHaveCount(0);
});

test('haptics: a desk check-in buzzes the phone only while haptics are on', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as unknown as { __vibrations: unknown[] }).__vibrations = calls;
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern: unknown) => (calls.push(pattern), true) });
  });
  await signInToMemberApp(page);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const vibrations = () => page.evaluate(() => (window as unknown as { __vibrations: unknown[] }).__vibrations.length);

  const desk = await apiAs('reception@sharkfitness.in');
  // Two desk check-ins a minute apart would hit the branch's anti-passback
  // window (90 s); the owner sets it to 1 s for this test and restores it.
  const owner = await apiAs('owner@sharkfitness.in');
  const setAntiPassback = async (value: number | null) => {
    const response = await owner.api.patch('/v1/admin/settings/branches/br_kor', {
      headers: { 'x-csrf-token': owner.csrf },
      data: { policy: { antiPassbackSeconds: value } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await setAntiPassback(1);
  test.info().attach('anti-passback', { body: 'set to 1 s for this test' });
  const memberId = await page.evaluate(async () => ((await (await fetch('/v1/me')).json()) as { viewer: { memberId: string } }).viewer.memberId);
  // Out of the building first, if the seeded day left the member inside.
  const current = (await (await desk.api.get('/v1/admin/attendance/current')).json()) as { items: Array<{ checkInId: string; memberId: string }> };
  for (const open of current.items.filter((row) => row.memberId === memberId)) {
    const out = await desk.api.post('/v1/admin/attendance/check-out', { headers: { 'x-csrf-token': desk.csrf }, data: { checkInId: open.checkInId } });
    expect(out.ok(), await out.text()).toBe(true);
  }
  const visit = async (): Promise<void> => {
    const checkIn = await desk.api.post('/v1/admin/attendance/check-in', {
      headers: { 'x-csrf-token': desk.csrf },
      data: { memberId, branchId: 'br_kor' },
    });
    expect(checkIn.ok(), await checkIn.text()).toBe(true);
    const result = (await checkIn.json()) as { checkInId: string; granted: boolean; message: string };
    expect(result.granted, result.message).toBe(true);
    const { checkInId } = result;
    await page.waitForTimeout(1_000);
    const out = await desk.api.post('/v1/admin/attendance/check-out', { headers: { 'x-csrf-token': desk.csrf }, data: { checkInId } });
    expect(out.ok(), await out.text()).toBe(true);
  };

  await page.waitForTimeout(1_100);
  await visit();
  await expect.poll(vibrations).toBe(1);

  // In-app navigation, not a reload: the vibration log lives in this page.
  await page.getByRole('link', { name: 'Your profile and settings' }).click();
  await page.getByText('Haptics', { exact: true }).click();
  await expect.poll(async () => (await (await page.request.get('/v1/me')).json()).viewer.preferences.haptics).toBe(false);
  try {
    await visit();
    await page.waitForTimeout(1_000);
    expect(await vibrations()).toBe(1);
  } finally {
    await setAntiPassback(null);
    await owner.api.dispose();
    await desk.api.dispose();
  }
});
