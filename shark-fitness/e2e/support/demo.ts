import { expect, type Page } from '@playwright/test';
import { nextOwnerCode } from './totp';

/** The seeded demo gym (apps/api/src/db/seed.ts). */
export const DEMO = {
  gym: 'shark',
  owner: { email: 'owner@sharkfitness.in', password: 'shark1234' },
  member: { email: 'aman@sharkfitness.in', password: 'shark1234' },
} as const;

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
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
  await page.getByLabel('Authenticator code').fill(await nextOwnerCode());
  await page.getByRole('button', { name: 'Verify' }).click();
}

export async function signInToMemberApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Gym code').fill(DEMO.gym);
  await page.getByLabel('Email').fill(DEMO.member.email);
  await page.getByLabel('Password').fill(DEMO.member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}
