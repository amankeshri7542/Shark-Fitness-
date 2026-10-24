import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema, sqlite, transact } from '../db/client.js';
import { resolveSession } from '../services/auth.js';
import { applyPaymentToInvoice } from '../services/billing.js';

const origin = 'http://localhost:5173';
type Session = { cookie: string; 'x-csrf-token': string };
let member: Session;
let owner: Session;
let memberId: string;
let tenantId: string;
let invoiceTemplate: typeof schema.invoices.$inferSelect;
let membershipTemplate: typeof schema.memberships.$inferSelect;

async function signIn(email: string): Promise<Session> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const { csrfToken } = await response.json() as { csrfToken: string };
  const token = response.headers.get('set-cookie')!.match(/shark_session=([^;,]+)/)![1];
  return { cookie: `shark_session=${token}; shark_csrf=${csrfToken}`, 'x-csrf-token': csrfToken };
}

function post(path: string, session: Session, body: unknown = {}) {
  return app.request(`/v1${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...session, 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  member = await signIn('rohit@sharkfitness.in');
  owner = await signIn('owner@sharkfitness.in');
  memberId = db.select().from(schema.members).where(eq(schema.members.email, 'rohit@sharkfitness.in')).get()!.id;
  invoiceTemplate = db.select().from(schema.invoices).where(eq(schema.invoices.memberId, memberId)).get()!;
  membershipTemplate = db.select().from(schema.memberships).where(eq(schema.memberships.memberId, memberId)).get()!;
  tenantId = invoiceTemplate.tenantId;
});

function fixture() {
  const invoiceId = randomUUID();
  const membershipId = randomUUID();
  db.insert(schema.memberships).values({ ...membershipTemplate, id: membershipId, state: 'pending_payment' }).run();
  db.insert(schema.invoices).values({
    ...invoiceTemplate, id: invoiceId, number: `BOUNDARY-${invoiceId}`, state: 'open',
    totalMinor: 10000, paidMinor: 0, refundedMinor: 0, voided: false,
    refType: 'membership', refId: membershipId,
  }).run();
  return { invoiceId, membershipId };
}

// Compare stored side effects, including authority/audit/event records, not just HTTP status.
function snapshot() {
  return Object.fromEntries(['payments', 'invoices', 'memberships', 'members', 'membership_events', 'provider_events', 'audit_log', 'outbox_events'].map((table) => [
    table, sqlite.prepare(`select * from ${table} order by id`).all(),
  ]));
}

it('refuses member checkout creation without creating a payment or granting access', async () => {
  const { invoiceId } = fixture();
  const before = snapshot();
  const response = await post('/member/billing/checkout-intent', member, { invoiceId });
  expect(response.status).toBe(412);
  expect(snapshot()).toEqual(before);
});

it.each(['created', 'succeeded', 'expired'] as const)('refuses a previously %s demo intent, preserving historical records', async (state) => {
  const { invoiceId } = fixture();
  const intentId = randomUUID();
  db.insert(schema.payments).values({
    id: intentId, tenantId, branchId: invoiceTemplate.branchId, invoiceId, memberId,
    method: 'upi', state: state === 'expired' ? 'created' : state, amountMinor: 10000, currency: 'INR', provider: 'demo',
    providerRef: 'synthetic-old-intent', idempotencyKey: intentId,
    createdAt: Date.now() - (state === 'expired' ? 24 * 60 * 60 * 1000 : 0),
  }).run();
  const before = snapshot();
  for (let retry = 0; retry < 2; retry++) {
    const response = await post(`/member/billing/checkout-intent/${intentId}/confirm`, member);
    expect(response.status).toBe(412);
    expect(snapshot()).toEqual(before);
  }
});

it.each(['succeeded', 'failed'])('refuses the staff demo %s callback without ledger/audit/provider side effects', async (outcome) => {
  const { invoiceId } = fixture();
  const before = snapshot();
  const response = await post('/admin/billing/webhooks/demo', owner, { invoiceId, outcome });
  expect(response.status).toBe(412);
  expect(snapshot()).toEqual(before);
});

it('the shared settlement boundary refuses demo providers and members even without route guards', () => {
  const { invoiceId } = fixture();
  const session = (headers: Session) => resolveSession(headers.cookie.match(/shark_session=([^;]+)/)![1]!)!;
  for (const [ctx, provider] of [[session(owner), 'demo'], [session(member), null]] as const) {
    const before = snapshot();
    expect(() => transact(() => applyPaymentToInvoice({
      ctx, invoiceId, amountMinor: 10000, method: 'cash', provider, providerRef: null,
      idempotencyKey: randomUUID(), recordedByName: ctx.name,
    }))).toThrow();
    expect(snapshot()).toEqual(before);
  }
  expect(db.select().from(schema.invoices).where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, tenantId))).get()!.paidMinor).toBe(0);
});
