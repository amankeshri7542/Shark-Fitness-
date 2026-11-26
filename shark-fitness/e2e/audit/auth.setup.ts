import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { test } from '../support/fixtures';
import { API_ROOT } from '../support/paths';
import { signInToConsole, signInToMemberApp } from '../support/demo';
import { IDS_FILE, MEMBER_STATE, OWNER_STATE, type Ids } from './lib/session';

/**
 * Signs the demo owner (with two-step sign-in) and the demo member in once and
 * saves both browser states, so the audit walks hundreds of screens without
 * signing in hundreds of times. Then finds a real record for every `:name`
 * placeholder in routes.ts from the seeded data.
 */

test('owner signs in to the console', async ({ page }) => {
  await signInToConsole(page);
  mkdirSync(dirname(OWNER_STATE), { recursive: true });
  await page.context().storageState({ path: OWNER_STATE });
});

test('member signs in to the app', async ({ page }) => {
  await signInToMemberApp(page);
  await page.context().storageState({ path: MEMBER_STATE });
});

test('resolve record ids for detail routes', async ({ browser }) => {
  const ids: Ids = {};
  const owner = await browser.newContext({ storageState: OWNER_STATE, baseURL: process.env.SHARK_E2E_BASE_URL });
  const member = await browser.newContext({ storageState: MEMBER_STATE, baseURL: process.env.SHARK_E2E_BASE_URL });
  const get = async <T>(context: typeof owner, path: string): Promise<T> => {
    const response = await context.request.get(`/v1${path}`);
    expect(response.status(), `GET ${path}`).toBe(200);
    return (await response.json()) as T;
  };

  type Items = { items: Array<{ id: string; name?: string; stage?: string; role?: string }> };
  // A lead with a trial booked: the detail screen with the most to show.
  const leads = await get<Items>(owner, '/admin/leads');
  ids.lead = (leads.items.find((l) => l.stage === 'trial_booked') ?? leads.items[0])!.id;
  // Aman, the demo member: the richest Member 360.
  const members = await get<Items>(owner, '/admin/members?q=Aman');
  ids.member = members.items[0]!.id;
  const programs = await get<Items>(owner, '/admin/training/programs');
  ids.program = programs.items[0]!.id;
  const staff = await get<Items>(owner, '/admin/staff');
  ids.staff = (staff.items.find((s) => s.role === 'trainer') ?? staff.items[0])!.id;

  const plan = JSON.stringify(await get<unknown>(member, '/member/training/plan'));
  ids.exercise = /"(exr_[a-z0-9_]+)"/.exec(plan)![1]!;
  const engagement = JSON.stringify(await get<unknown>(member, '/member/engagement'));
  ids.challenge = /"(chl_[a-z0-9_]+)"/.exec(engagement)![1]!;
  const messages = await get<Items>(member, '/member/messages');
  ids.conversation = messages.items[0]!.id;

  // The member's latest finished session. There is no list endpoint for it, so
  // it is read from this run's temporary database (never apps/api/data).
  type Database = { prepare: (sql: string) => { get: (...p: unknown[]) => unknown }; close: () => void };
  const open = createRequire(resolve(API_ROOT, 'package.json'))('better-sqlite3') as new (path: string, options: { readonly: boolean }) => Database;
  const db = new open(process.env.SHARK_E2E_DATABASE!, { readonly: true });
  try {
    const row = db
      .prepare(
        `select w.client_id as id from workouts w join members m on m.id = w.member_id join users u on u.id = m.user_id
         where u.email = ? and w.state = 'completed' order by w.finished_at desc limit 1`,
      )
      .get('aman@sharkfitness.in') as { id: string } | undefined;
    ids.workout = row!.id;
  } finally {
    db.close();
  }

  writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2));
  await owner.close();
  await member.close();
});
