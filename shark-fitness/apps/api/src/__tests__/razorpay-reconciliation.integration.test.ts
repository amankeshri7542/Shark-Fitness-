import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jobsForTest, SCHEDULED_JOB_NAMES } from '../jobs/scheduler.js';
import { db, schema } from '../db/client.js';
import { setPaymentProviderForTests } from '../lib/payment-provider.js';
import { now } from '../lib/time.js';
import { hashToken } from '../lib/crypto.js';
import { testTotp } from './helpers/mfa.js';
import type { RequestContext } from '../lib/context.js';
import { listReconciliationExceptions } from '../services/payments/reconciliation.js';
import {
  auditFor,
  checkout,
  createMember,
  exceptionsFor,
  intentRow,
  invoiceRow,
  openInvoice,
  paymentsFor,
  request,
  signIn,
  startHarness,
  type Harness,
  type Session,
} from './support/razorpay-harness.js';

/* P02 acceptance 7: the reconcile-payments job finds what webhooks missed,
   settles it exactly once, and surfaces what it cannot settle. */

let harness: Harness;
let member: ReturnType<typeof createMember>;
let memberSession: Session;
let owner: Session;

beforeAll(async () => {
  harness = await startHarness();
  member = createMember('recon');
  memberSession = await signIn(member.email);
  owner = await signIn('owner@sharkfitness.in');
});
afterEach(() => harness.assertClean());
afterAll(async () => harness.close());

/** An intent the member paid for, whose confirm and webhook never arrived. */
async function stuck(options: { status?: 'captured' | 'authorized'; amount?: number } = {}) {
  const fixture = openInvoice(member);
  const { body } = await checkout(memberSession, fixture.invoiceId);
  const payment = harness.fake.pay(body.orderId, { status: options.status ?? 'captured', ...(options.amount ? { amount: options.amount } : {}) });
  db.update(schema.paymentIntents).set({ updatedAt: now() - 20 * 60_000 }).where(eq(schema.paymentIntents.id, body.intentId)).run();
  return { ...fixture, intentId: body.intentId, orderId: body.orderId, payment };
}

const latestRun = () => db.select().from(schema.jobRuns).where(eq(schema.jobRuns.job, 'reconcile-payments')).orderBy(desc(schema.jobRuns.startedAt)).limit(1).get()!;

describe('reconcile-payments', () => {
  it('is scheduled with the other jobs', () => {
    expect(SCHEDULED_JOB_NAMES).toContain('reconcile-payments');
  });

  it('settles a missed capture exactly once, even when two runs overlap', async () => {
    const missed = await stuck();
    await Promise.all([jobsForTest.execute('reconcile-payments'), jobsForTest.execute('reconcile-payments')]);
    expect(paymentsFor(missed.invoiceId)).toHaveLength(1);
    expect(auditFor(missed.invoiceId, 'payment.settled_by_provider')).toHaveLength(1);
    expect(invoiceRow(missed.invoiceId).state).toBe('paid');
    expect(intentRow(missed.intentId)).toMatchObject({ state: 'succeeded', providerPaymentId: missed.payment.id });
    const runs = db.select().from(schema.jobRuns).where(eq(schema.jobRuns.job, 'reconcile-payments')).orderBy(desc(schema.jobRuns.startedAt)).limit(2).all();
    expect(runs.map((run) => run.status)).toEqual(['succeeded', 'succeeded']);
    // Between them the two runs report exactly the one settlement they made.
    expect(runs.reduce((total, run) => total + Number(run.summary?.settled ?? 0), 0)).toBe(1);

    // And a third run later finds nothing to do.
    await jobsForTest.execute('reconcile-payments');
    expect(paymentsFor(missed.invoiceId)).toHaveLength(1);
  });

  it('captures an authorized payment it finds, then settles it', async () => {
    const missed = await stuck({ status: 'authorized' });
    await jobsForTest.execute('reconcile-payments');
    expect(harness.fake.payments.get(String(missed.payment.id))!.status).toBe('captured');
    expect(paymentsFor(missed.invoiceId)).toHaveLength(1);
  });

  it('leaves a recent intent alone (webhooks get 15 minutes first)', async () => {
    const fixture = openInvoice(member);
    const { body } = await checkout(memberSession, fixture.invoiceId);
    harness.fake.pay(body.orderId, { status: 'created' });
    const asked = harness.fake.requests.filter((entry) => entry.path === `/v1/orders/${body.orderId}/payments`).length;
    await jobsForTest.execute('reconcile-payments');
    expect(harness.fake.requests.filter((entry) => entry.path === `/v1/orders/${body.orderId}/payments`).length).toBe(asked);
    expect(intentRow(body.intentId).state).toBe('processing');
  });

  it('records a mismatch for staff, who must give a reason to resolve it, and that is audited', async () => {
    const mismatched = await stuck({ amount: 100 });
    await jobsForTest.execute('reconcile-payments');
    expect(paymentsFor(mismatched.invoiceId)).toEqual([]);
    const [exception] = exceptionsFor(mismatched.invoiceId);
    expect(exception).toMatchObject({ kind: 'amount_mismatch', state: 'open' });

    const list = (await (await request('GET', '/admin/billing/reconciliation', owner)).json()) as {
      items: Array<{ id: string; title: string; invoiceNumber: string; expectedLabel: string; receivedLabel: string; providerPaymentId: string }>;
    };
    const item = list.items.find((entry) => entry.id === exception!.id)!;
    expect(item).toMatchObject({ title: 'Amount does not match', expectedLabel: '₹295', receivedLabel: '₹1', providerPaymentId: mismatched.payment.id });
    expect(item.invoiceNumber).toBe(invoiceRow(mismatched.invoiceId).number);

    const resolve = (body: unknown, session = owner) => request('POST', `/admin/billing/reconciliation/${exception!.id}/resolve`, session, body);
    expect((await resolve({ action: 'resolve' })).status).toBe(422);
    expect((await resolve({ action: 'resolve', reason: '  ' })).status).toBe(422);
    const reception = await signIn('reception@sharkfitness.in');
    expect((await resolve({ action: 'resolve', reason: 'Refunded the ₹1 test' }, reception)).status).toBe(403);
    // Closing a money mismatch needs a recent re-authentication (P06 step-up).
    const token = owner.cookie.match(/shark_session=([^;]+)/)![1]!;
    db.update(schema.sessions).set({ reauthenticatedAt: now() - 6 * 60_000 }).where(eq(schema.sessions.tokenHash, hashToken(token))).run();
    const stale = await resolve({ action: 'resolve', reason: 'Refunded the ₹1 test payment from the Dashboard' });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED', details: { action: 'billing.reconcile' } } });
    expect(exceptionsFor(mismatched.invoiceId)[0]).toMatchObject({ state: 'open' });
    const ownerId = db.select().from(schema.users).where(eq(schema.users.email, 'owner@sharkfitness.in')).get()!.id;
    expect((await request('POST', '/auth/step-up', owner, { password: 'shark1234', code: testTotp(ownerId) }, null)).status).toBe(200);
    const done = await resolve({ action: 'resolve', reason: 'Refunded the ₹1 test payment from the Dashboard' });
    expect(done.status).toBe(200);
    expect(exceptionsFor(mismatched.invoiceId)[0]).toMatchObject({ state: 'resolved', resolutionReason: 'Refunded the ₹1 test payment from the Dashboard', resolvedByName: expect.any(String) });
    const [audit] = auditFor(exception!.id, 'payment.reconciliation_resolved');
    expect(audit).toMatchObject({ reason: 'Refunded the ₹1 test payment from the Dashboard' });
    expect((await resolve({ action: 'ignore', reason: 'again' })).status).toBe(409);

    const open = (await (await request('GET', '/admin/billing/reconciliation', owner)).json()) as { items: Array<{ id: string }> };
    expect(open.items.some((entry) => entry.id === exception!.id)).toBe(false);
    const resolved = (await (await request('GET', '/admin/billing/reconciliation?state=resolved', owner)).json()) as { items: Array<{ id: string }> };
    expect(resolved.items.some((entry) => entry.id === exception!.id)).toBe(true);
  });

  it('flags captured money that names this gym but matches no checkout', async () => {
    const orphanOrder = harness.fake.orders.size;
    // A payment made against an order nobody here created, carrying our tenant note.
    const order = { id: `order_orphan${orphanOrder}`, amount: 5_000, currency: 'INR', notes: { tenant_id: member.tenantId }, status: 'created', attempts: 0 };
    harness.fake.orders.set(order.id, order);
    const payment = harness.fake.pay(order.id);
    await jobsForTest.execute('reconcile-payments');
    const row = db.select().from(schema.paymentReconciliationExceptions).where(eq(schema.paymentReconciliationExceptions.providerPaymentId, String(payment.id))).get();
    expect(row).toMatchObject({ kind: 'unmatched_payment', tenantId: member.tenantId, branchId: null, receivedMinor: 5_000 });
    const list = (await (await request('GET', '/admin/billing/reconciliation', owner)).json()) as { items: Array<{ id: string; title: string }> };
    expect(list.items.find((entry) => entry.id === row!.id)).toMatchObject({ title: 'Payment matches nothing here' });
  });

  it('does nothing, successfully, without a provider', async () => {
    setPaymentProviderForTests(null);
    try {
      const requests = harness.fake.requests.length;
      await jobsForTest.execute('reconcile-payments');
      expect(latestRun()).toMatchObject({ status: 'succeeded', summary: expect.objectContaining({ provider: 'none' }) });
      expect(harness.fake.requests.length).toBe(requests);
    } finally {
      setPaymentProviderForTests(harness.provider);
    }
  });

  it('records a provider outage on the run instead of failing it', async () => {
    harness.fake.fault({ method: 'GET', path: /^\/v1\/payments$/ }, { status: 503 });
    await jobsForTest.execute('reconcile-payments');
    expect(latestRun()).toMatchObject({ status: 'succeeded', summary: expect.objectContaining({ providerErrors: 1 }) });
  });

  it('lists nothing for a caller with no branches in scope', async () => {
    await stuck({ amount: 1_000 });
    await jobsForTest.execute('reconcile-payments');
    const ctx = { tenantId: member.tenantId, branchIds: [], activeBranchId: null, permissions: [], role: 'owner' } as unknown as RequestContext;
    expect(listReconciliationExceptions(ctx, 'all').items).toEqual([]);
  });

  it('needs billing.view to list exceptions', async () => {
    const trainer = await signIn('rehan@sharkfitness.in');
    expect((await request('GET', '/admin/billing/reconciliation', trainer)).status).toBe(403);
    expect((await request('POST', `/admin/billing/reconciliation/rex_${randomUUID()}/resolve`, owner, { action: 'ignore', reason: 'Not ours' })).status).toBe(404);
  });
});
