import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { bootstrapGym } from '../db/bootstrap.js';

const origin = 'http://localhost:5173';
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`/v1${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
async function login(email: string, password = 'shark1234', tenantSlug = 'shark') {
  const response = await post('/auth/password', { tenantSlug, email, password });
  expect(response.status).toBe(200);
  const { csrfToken } = await response.json() as { csrfToken: string };
  const raw = response.headers.get('set-cookie')!.match(/shark_session=([^;,]+)/)![1];
  return { cookie: `shark_session=${raw}; shark_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
}
type Activation = { activationId: string; token: string; tenantSlug: string };

it('enrolls a fresh member in an empty gym, activates once, and permits password login without OTP delivery', async () => {
  const slug = id('activation-gym').replaceAll('_', '-');
  const ownerEmail = `${slug}@owner.test`;
  const passwordOwner = 'fresh-owner-password';
  const gym = bootstrapGym({ slug, legalName: 'Fresh Gym', displayName: 'Fresh Gym', timezone: 'Asia/Kolkata', owner: { name: 'Fresh Owner', email: ownerEmail, password: passwordOwner }, branch: { name: 'Main', slug: 'main', addressLine: 'Test Road', city: 'Test City', capacity: 100, opensMinutes: 360, closesMinutes: 1320 } });
  const owner = await login(ownerEmail, passwordOwner, slug);
  const email = `${id('fresh')}@activation.test`;
  const created = await post('/admin/leads', { name: 'Fresh Activation', email, source: 'walk_in', branchId: gym.branchId }, owner);
  expect(created.status).toBe(201);
  const { id: leadId } = await created.json() as { id: string };
  for (const stage of ['contacted', 'qualified', 'trial_booked', 'trial_completed']) {
    expect((await post(`/admin/leads/${leadId}/stage`, { to: stage }, owner)).status).toBe(200);
  }
  const converted = await post(`/admin/leads/${leadId}/convert`, {}, owner);
  expect(converted.status).toBe(200);
  const { memberId } = await converted.json() as { memberId: string };
  expect((await post('/auth/activation/issue', { memberId })).status).toBe(401);
  const outsider = await login('owner@reefathletic.in', 'shark1234', 'reef');
  expect((await post('/auth/activation/issue', { memberId }, outsider)).status).toBe(404);
  const issued = await post('/auth/activation/issue', { memberId }, owner);
  expect(issued.status).toBe(200);
  const activation = await issued.json() as Activation;
  const password = 'new-member-secure-password';
  expect((await post('/auth/activation/redeem', { ...activation, password: 'short' })).status).toBe(422);
  expect((await post('/auth/activation/redeem', { ...activation, password, token: 'wrong'.repeat(10) })).status).toBe(422);
  const redeemed = await post('/auth/activation/redeem', { ...activation, password });
  expect(redeemed.status).toBe(200);
  expect(await redeemed.json()).toMatchObject({ viewer: { email, accountState: 'active', memberId } });
  expect((await post('/auth/activation/redeem', { ...activation, password })).status).toBe(422);
  expect((await post('/auth/activation/issue', { memberId }, owner)).status).toBe(422);
  const member = await login(email, password, slug);
  expect((await post('/auth/activation/issue', { memberId }, member)).status).toBe(403);
});

it('restricts staff activation to the owner and rejects replaced, expired, and disabled-account links', async () => {
  const owner = await login('owner@sharkfitness.in');
  const manager = await login('manager@sharkfitness.in');
  const email = `${id('staff')}@activation.test`;
  const created = await post('/admin/staff', { name: 'Fresh Staff', email, role: 'trainer', branchIds: ['br_kor'] }, owner);
  expect(created.status).toBe(201);
  const { staff } = await created.json() as { staff: { id: string } };
  expect((await post('/auth/activation/issue', { staffId: staff.id }, manager)).status).toBe(403);
  const issue = async () => {
    const response = await post('/auth/activation/issue', { staffId: staff.id }, owner);
    expect(response.status).toBe(200);
    return await response.json() as Activation;
  };
  const first = await issue();
  const second = await issue();
  const password = 'new-staff-secure-password';
  expect((await post('/auth/activation/redeem', { ...first, password })).status).toBe(422);
  db.update(schema.otpChallenges).set({ expiresAt: 1 }).where(eq(schema.otpChallenges.id, second.activationId)).run();
  expect((await post('/auth/activation/redeem', { ...second, password })).status).toBe(422);
  const third = await issue();
  const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get()!;
  db.update(schema.users).set({ accountState: 'disabled' }).where(eq(schema.users.id, user.id)).run();
  expect((await post('/auth/activation/redeem', { ...third, password })).status).toBe(422);
  db.update(schema.users).set({ accountState: 'invited' }).where(eq(schema.users.id, user.id)).run();
  expect((await post('/auth/activation/redeem', { ...third, password })).status).toBe(200);
  await login(email, password);
});
