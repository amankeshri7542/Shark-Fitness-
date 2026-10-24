import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { app } from '../app.js';
import { bootstrapGym } from '../db/bootstrap.js';
import { db, schema, sqlite } from '../db/client.js';

type Session = Record<string, string>;
const origin = 'http://localhost:5173';
async function request(path: string, session: Session = {}, body?: unknown, method = body ? 'POST' : 'GET') {
  return app.request(`/v1${path}`, { method, headers: { origin, 'content-type': 'application/json', ...session },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function sessionFrom(response: Response): Promise<Session> {
  expect(response.status, await response.clone().text()).toBe(200);
  const { csrfToken } = await response.json() as { csrfToken: string };
  const token = response.headers.get('set-cookie')!.match(/shark_session=([^;,]+)/)![1];
  return { cookie: `shark_session=${token}; shark_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
}
async function success(response: Response, status = 200) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body as Record<string, unknown>;
}

it('an empty gym completes reception enrollment, activation, payment, receipt and attendance without fixture accounts or DB edits', async () => {
  const slug = `pilot-${randomUUID()}`;
  const password = 'isolated-pilot-password';
  const gym = bootstrapGym({ slug, legalName: 'Pilot Test Gym', displayName: 'Pilot Test Gym', timezone: 'UTC',
    owner: { name: 'Test Owner', email: 'owner@pilot.test', password },
    branch: { name: 'Main', slug: 'main', addressLine: '1 Test Street', city: 'Test', capacity: 50, opensMinutes: 0, closesMinutes: 1440 },
  });
  expect(sqlite.prepare('select count(*) as n from members where tenant_id = ?').get(gym.tenantId)).toEqual({ n: 0 });
  const owner = await sessionFrom(await request('/auth/password', {}, { tenantSlug: slug, email: 'owner@pilot.test', password }));
  const createdStaff = await success(await request('/admin/staff', owner, {
    name: 'Test Reception', email: 'desk@pilot.test', role: 'reception', branchIds: [gym.branchId],
  }), 201);
  const staffId = (createdStaff.staff as { id: string }).id;
  const activate = async (actor: Session, target: { staffId: string } | { memberId: string }) => {
    const issued = await success(await request('/auth/activation/issue', actor, target));
    return sessionFrom(await request('/auth/activation/redeem', {}, {
      activationId: issued.activationId, token: issued.token, password,
    }));
  };
  const reception = await activate(owner, { staffId });
  const lead = await success(await request('/admin/leads', reception, {
    name: 'Fresh Walkin', phone: '+919870001111', email: 'member@pilot.test', source: 'walk_in', branchId: gym.branchId,
  }), 201);
  for (const to of ['contacted', 'qualified']) await success(await request(`/admin/leads/${lead.id}/stage`, reception, { to }));
  const enrolled = await success(await request(`/admin/leads/${lead.id}/convert`, reception, {}));
  const memberId = enrolled.memberId as string;
  expect((await request(`/admin/leads/${lead.id}/convert`, reception, {})).status).toBe(409);
  const member = await activate(reception, { memberId });
  expect((await request('/admin/members', member)).status).toBe(403);
  const product = await success(await request('/admin/billing/products', owner, {
    kind: 'membership', name: 'Monthly manual renewal', priceMinor: 10000, currency: 'INR', taxRateBp: 0,
    cadence: 'one_time', durationDays: 30,
    access: { allBranches: false, branchIds: [gym.branchId], windowStartMin: null, windowEndMin: null, visitsPerWeek: null,
      guestPassesPerMonth: 0, classPriorityTier: 0, bookingWindowHours: 48 },
    freeze: { allowed: true, maxDaysPerTerm: 14, minDaysPerFreeze: 1, extendsExpiry: true, feeMinor: 0 },
    cancellation: { noticeDays: 7, commitmentMonths: 0, earlyExitFeeMinor: 0, refundable: true, description: 'Seven days notice' },
  }), 201);
  await success(await request(`/admin/billing/products/${product.id}`, owner, { status: 'active' }, 'PATCH'));
  const assigned = await success(await request(`/admin/billing/members/${memberId}/assign-plan`, reception, { productId: product.id }), 201);
  const invoiceId = assigned.invoiceId as string;
  const denied = await success(await request('/admin/attendance/check-in', reception, { memberId, branchId: gym.branchId }));
  expect(denied.decision).not.toBe('granted');
  const paymentInput = { amountMinor: 10000, method: 'cash', idempotencyKey: randomUUID() };
  await success(await request(`/admin/billing/invoices/${invoiceId}/payments`, reception, paymentInput));
  await success(await request(`/admin/billing/invoices/${invoiceId}/payments`, reception, paymentInput));
  const payments = sqlite.prepare('select id, amount_minor from payments where invoice_id = ?').all(invoiceId) as { id: string; amount_minor: number }[];
  expect(payments).toHaveLength(1);
  expect(payments[0]!.amount_minor).toBe(10000);
  const receipt = await request(`/admin/billing/payments/${payments[0]!.id}/receipt`, reception);
  expect(receipt.status).toBe(200);
  expect(receipt.headers.get('content-disposition')).toContain('attachment');
  const receiptText = await receipt.text();
  expect(receiptText).toContain(payments[0]!.id);
  expect(receiptText).toContain('Fresh Walkin');
  expect((await request(`/admin/billing/payments/${payments[0]!.id}/receipt`, member)).status).toBe(403);
  const invoice = await success(await request(`/admin/billing/invoices/${invoiceId}`, reception));
  expect(invoice.invoice).toMatchObject({ state: 'paid' });
  const checkedIn = await success(await request('/admin/attendance/check-in', reception, { memberId, branchId: gym.branchId }));
  expect(checkedIn.decision).toBe('granted');
  await success(await request('/admin/attendance/check-in', reception, { memberId, branchId: gym.branchId }));
  expect(sqlite.prepare("select count(*) as n from check_ins where member_id = ? and decision = 'granted' and exited_at is null").get(memberId)).toEqual({ n: 1 });
  expect((await request('/member/home', member)).status).toBe(200);
  expect((await request(`/admin/billing/invoices/${invoiceId}`, member)).status).toBe(403);
});

it('browses a synthetic 51-member directory without missing or repeating tied records', async () => {
  const slug = `directory-${randomUUID()}`;
  const password = 'directory-test-password';
  const gym = bootstrapGym({ slug, legalName: 'Directory Fixture', displayName: 'Directory Fixture', timezone: 'UTC',
    owner: { name: 'Directory Owner', email: 'owner@directory.test', password },
    branch: { name: 'Main', slug: 'main', addressLine: '1 Test Street', city: 'Test', capacity: 60, opensMinutes: 0, closesMinutes: 1440 },
  });
  // Bulk synthetic fixtures exercise pagination only; the journey above proves
  // real enrollment through public endpoints without member-table inserts.
  for (let index = 0; index < 51; index++) db.insert(schema.members).values({
    id: randomUUID(), tenantId: gym.tenantId, homeBranchId: gym.branchId, memberNo: `M-${index}`,
    firstName: 'Directory', lastName: String(index), initials: 'DF', tags: [],
    joinedOn: '2026-09-20', createdAt: Date.now(), updatedAt: Date.now(),
  }).run();
  const owner = await sessionFrom(await request('/auth/password', {}, { tenantSlug: slug, email: 'owner@directory.test', password }));
  const first = await success(await request('/admin/members?offset=0', owner));
  const second = await success(await request('/admin/members?offset=50', owner));
  expect(first.total).toBe(51);
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(1);
  const ids = [...first.items as { id: string }[], ...second.items as { id: string }[]].map((row) => row.id);
  expect(new Set(ids).size).toBe(51);
  expect((await success(await request('/admin/members?offset=50', owner))).items).toEqual(second.items);
});
