import { expect, type Page } from '@playwright/test';

/** The seeded demo gym (apps/api/src/db/seed.ts). */
export const DEMO = {
  gym: 'shark',
  owner: { email: 'owner@sharkfitness.in', password: 'shark1234' },
  member: { email: 'aman@sharkfitness.in', password: 'shark1234' },
} as const;

export async function signInToConsole(page: Page): Promise<void> {
  await page.goto('/admin/');
  await page.getByLabel('Gym code').fill(DEMO.gym);
  await page.getByLabel('Work email').fill(DEMO.owner.email);
  await page.getByLabel('Password').fill(DEMO.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Command' })).toBeVisible();
}

export async function signInToMemberApp(page: Page): Promise<void> {
  await page.goto('/app/');
  await page.getByLabel('Gym code').fill(DEMO.gym);
  await page.getByLabel('Email').fill(DEMO.member.email);
  await page.getByLabel('Password').fill(DEMO.member.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}
