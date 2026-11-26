import { expect, test, type Page } from '@playwright/test';
import { nextOwnerCode } from './totp';

/** The seeded demo gym (apps/api/src/db/seed.ts). */
export const DEMO = {
  gym: 'shark',
  owner: { email: 'owner@sharkfitness.in', password: 'shark1234' },
  member: { email: 'aman@sharkfitness.in', password: 'shark1234' },
  /** In grace with an unpaid renewal invoice (the seed's "failed payment"). */
  graceMember: { email: 'rohit@sharkfitness.in', password: 'shark1234' },
} as const;

/** Test-only Android app link the E2E server is configured with. */
export const E2E_ANDROID = {
  packageName: 'in.sharkfitness.member',
  fingerprint: '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5',
} as const;

/**
 * Clicks "Sign in". The API allows ten password sign-ins a minute from one
 * address, and a full run signs in more often than that, so a 429 is waited
 * out (for the `retryAfterSec` the API sends) and the click repeated, rather
 * than letting one spec fail because of another's sign-ins.
 */
export async function submitSignIn(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = page.waitForResponse((r) => r.url().endsWith('/v1/auth/password') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const response = await answer;
    if (response.status() !== 429) return;
    const body = (await response.json().catch(() => ({}))) as { error?: { retryAfterSec?: number } };
    const waitMs = ((body.error?.retryAfterSec ?? 60) + 1) * 1000;
    // The wait is the limiter's, not the product's: give the spec that time back.
    test.info().setTimeout(test.info().timeout + waitMs);
    await page.waitForTimeout(waitMs);
  }
}

/** Password, then the owner's authenticator code (two-step sign-in is mandatory for owners). */
export async function signInToConsole(page: Page, path = '/admin/'): Promise<void> {
  await page.goto(path);
  await completeConsoleSignIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Command' })).toBeVisible();
}

/** Fills the sign-in screen already on the page and answers the code prompt. */
export async function completeConsoleSignIn(page: Page): Promise<void> {
  await page.getByLabel('Gym code').fill(DEMO.gym);
  await page.getByLabel('Work email').fill(DEMO.owner.email);
  await page.getByLabel('Password').fill(DEMO.owner.password);
  await submitSignIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
  await page.getByLabel('Authenticator code').fill(await nextOwnerCode());
  await page.getByRole('button', { name: 'Verify' }).click();
}

export async function signInToMemberApp(page: Page, account: { email: string; password: string } = DEMO.member): Promise<void> {
  await page.goto('/app/');
  await page.getByLabel('Gym code').fill(DEMO.gym);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await submitSignIn(page);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Staff who do not owe two-step sign-in (branch manager, reception, coaches). */
export const STAFF = {
  manager: 'manager@sharkfitness.in',
  reception: 'reception@sharkfitness.in',
  coach: 'rehan@sharkfitness.in',
} as const;

export async function signInToConsoleAs(page: Page, email: string, path = '/admin/'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('Gym code').fill(DEMO.gym);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(DEMO.owner.password);
  await submitSignIn(page);
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
}
