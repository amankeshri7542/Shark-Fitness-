import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, schema } from '../db/client.js';
import { jobsForTest } from '../jobs/scheduler.js';
import { now } from '../lib/time.js';
import {
  auditFor,
  checkout,
  createMember,
  exceptionsFor,
  invoiceRow,
  membershipRow,
  openInvoice,
  paymentsFor,
  postWebhook,
  request,
  signIn,
  startHarness,
  type Harness,
  type Session,
} from './support/razorpay-harness.js';

/* P02 acceptance 5: provider refunds stay pending until Razorpay says so. */

let harness: Harness;
let member: ReturnType<typeof createMember>;
let memberSession: Session;
let owner: Session;

beforeAll(async () => {
  harness = await startHarness();
  member = createMember('refunds');
  memberSession = await signIn(member.email);
  owner = await signIn('owner@sharkfitness.in');
});
afterEach(() => harness.assertClean());
afterAll(async () => harness.close());

/** An invoice paid online through Checkout. */
async function paidOnline() {
  const fixture = openInvoice(member);
  const { body } = await checkout(memberSession, fixture.invoiceId);
  const providerPayment = harness.fake.pay(body.orderId);
  await request('POST', `/member/billing/checkout/${body.intentId}/confirm`, memberSession, {
    razorpay_order_id: body.orderId,
    razorpay_payment_id: providerPayment.id,
    razorpay_signature: harness.fake.checkoutSignature(body.orderId, String(providerPayment.id)),
  });
  const [payment] = paymentsFor(fixture.invoiceId);
  expect(payment).toBeTruthy();
  return { ...fixture, payment: payment!, providerPayment, intentId: body.intentId };
}

function refund(paymentId: string, body: { amountMinor: number; reason?: string; entitlementReversed?: boolean }, key: string = randomUUID(), session = owner) {
  return request('POST', `/admin/billing/payments/${paymentId}/refund`, session, { reason: 'Member moved city', entitlementReversed: false, ...body }, key);
}

const refundRows = (paymentId: string) => db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, paymentId)).all();

async function processed(refundId: string, paymentId: string, extra: Record<string, unknown> = {}) {
  const row = db.select().from(schema.refunds).where(eq(schema.refunds.id, refundId)).get()!;
  const providerRefund = harness.fake.refunds.get(row.providerRefundId!)!;
  return postWebhook(harness, 'refund.processed', {
    refund: { ...providerRefund, status: 'processed', ...extra },
    payment: harness.fake.payments.get(paymentId)!,
  });
}

describe('provider refunds', () => {
  it('a full refund is pending until refund.processed, then the invoice is refunded and the membership reversed', async () => {
    const paid = await paidOnline();
    expect(membershipRow(paid.membershipId).state).toBe('active');
    const response = await refund(paid.payment.id, { amountMinor: 29_500, entitlementReversed: true });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { refundId: string; state: string };
    expect(body.state).toBe('pending');

    const [row] = refundRows(paid.payment.id);
    expect(row).toMatchObject({ state: 'pending', provider: 'razorpay', amountMinor: 29_500 });
    expect(row!.providerRefundId).toMatch(/^rfnd_/);
    // Razorpay was asked with our refund id as its idempotency key.
    const call = harness.fake.requests.find((entry) => entry.path === `/v1/payments/${paid.providerPayment.id}/refund`)!;
    expect(call.headers['x-refund-idempotency']).toBe(row!.id);
    expect(call.body).toMatchObject({ amount: 29_500, speed: 'normal', notes: { refund_id: row!.id } });
    // Nothing moves until Razorpay says it is done.
    expect(invoiceRow(paid.invoiceId)).toMatchObject({ refundedMinor: 0, state: 'paid' });
    expect(membershipRow(paid.membershipId).state).toBe('active');
    expect(auditFor(paid.invoiceId, 'payment.refund_requested')).toHaveLength(1);

    const detail = (await (await request('GET', `/admin/billing/invoices/${paid.invoiceId}`, owner)).json()) as {
      payments: Array<{ providerRef: string; provider: string; refundableMinor: number }>;
      refunds: Array<{ state: string; providerRefundId: string }>;
    };
    expect(detail.payments[0]).toMatchObject({ provider: 'razorpay', providerRef: paid.providerPayment.id, refundableMinor: 0 });
    expect(detail.refunds[0]).toMatchObject({ state: 'pending', providerRefundId: row!.providerRefundId });

    expect((await processed(row!.id, String(paid.providerPayment.id))).status).toBe(200);
    expect(refundRows(paid.payment.id)[0]!.state).toBe('succeeded');
    expect(invoiceRow(paid.invoiceId)).toMatchObject({ refundedMinor: 29_500, state: 'refunded' });
    expect(membershipRow(paid.membershipId).state).toBe('suspended');
    expect(auditFor(paid.invoiceId, 'payment.refunded')[0]).toMatchObject({ actorId: 'system:razorpay' });

    // Redelivered with a new event id: nothing moves twice.
    await processed(row!.id, String(paid.providerPayment.id));
    expect(invoiceRow(paid.invoiceId).refundedMinor).toBe(29_500);
  });

  it('partial refunds are bounded by captured minus refunded and pending, and over-refunds are refused', async () => {
    const paid = await paidOnline();
    expect((await refund(paid.payment.id, { amountMinor: 10_000 })).status).toBe(200);
    // 19,500 is still refundable while the first is pending; 19,501 is not.
    const over = await refund(paid.payment.id, { amountMinor: 19_501 });
    expect(over.status).toBe(422);
    expect(((await over.json()) as { error: { message: string } }).error.message).toMatch(/refundable balance \(19500\)/);
    const second = await refund(paid.payment.id, { amountMinor: 19_500 });
    expect(second.status).toBe(200);
    expect((await refund(paid.payment.id, { amountMinor: 1 })).status).toBe(422);

    const [first, rest] = refundRows(paid.payment.id).sort((a, b) => a.amountMinor - b.amountMinor);
    await processed(first!.id, String(paid.providerPayment.id));
    expect(invoiceRow(paid.invoiceId)).toMatchObject({ refundedMinor: 10_000, state: 'partially_refunded' });
    await processed(rest!.id, String(paid.providerPayment.id));
    expect(invoiceRow(paid.invoiceId)).toMatchObject({ refundedMinor: 29_500, state: 'refunded' });
  });

  it('a retry with the same key returns the same refund and asks Razorpay once', async () => {
    const paid = await paidOnline();
    const key = randomUUID();
    const first = (await (await refund(paid.payment.id, { amountMinor: 5_000 }, key)).json()) as { refundId: string };
    const asks = () => harness.fake.requests.filter((entry) => entry.path === `/v1/payments/${paid.providerPayment.id}/refund`).length;
    expect(asks()).toBe(1);
    const again = (await (await refund(paid.payment.id, { amountMinor: 5_000 }, key)).json()) as { refundId: string };
    expect(again.refundId).toBe(first.refundId);
    expect(asks()).toBe(1);
    expect(refundRows(paid.payment.id)).toHaveLength(1);
    expect((await refund(paid.payment.id, { amountMinor: 6_000 }, key)).status).toBe(409);
  });

  it('a refund that times out stays pending and the same request completes it without refunding twice', async () => {
    const paid = await paidOnline();
    const key = randomUUID();
    harness.fake.fault({ method: 'POST', path: /\/refund$/ }, { hangMs: 2_000 });
    const timedOut = await refund(paid.payment.id, { amountMinor: 29_500 }, key);
    expect(timedOut.status).toBe(503);
    expect(refundRows(paid.payment.id)[0]).toMatchObject({ state: 'pending', providerRefundId: null });
    const retried = await refund(paid.payment.id, { amountMinor: 29_500 }, key);
    expect(retried.status).toBe(200);
    expect(refundRows(paid.payment.id)).toHaveLength(1);
    expect(refundRows(paid.payment.id)[0]!.providerRefundId).toMatch(/^rfnd_/);
  });

  it('a timed-out refund nobody retried is asked again by reconcile-payments, once, with the same key', async () => {
    const paid = await paidOnline();
    harness.fake.fault({ method: 'POST', path: /\/refund$/ }, { hangMs: 2_000 });
    expect((await refund(paid.payment.id, { amountMinor: 29_500 })).status).toBe(503);
    const [stuck] = refundRows(paid.payment.id);
    expect(stuck).toMatchObject({ state: 'pending', providerRefundId: null });
    // The console closed; its retry key is gone. The balance is held meanwhile.
    expect((await refund(paid.payment.id, { amountMinor: 100 })).status).toBe(422);

    db.update(schema.refunds).set({ createdAt: now() - 20 * 60_000 }).where(eq(schema.refunds.id, stuck!.id)).run();
    await jobsForTest.execute('reconcile-payments');
    const [sent] = refundRows(paid.payment.id);
    expect(sent).toMatchObject({ id: stuck!.id, state: 'pending' });
    expect(sent!.providerRefundId).toMatch(/^rfnd_/);
    const asked = harness.fake.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/refund'));
    expect(asked.at(-1)!.headers['x-refund-idempotency']).toBe(stuck!.id);

    // Razorpay's word then finishes it as usual, and a later run leaves it be.
    expect((await processed(stuck!.id, paid.providerPayment.id as string)).status).toBe(200);
    expect(refundRows(paid.payment.id)[0]!.state).toBe('succeeded');
    const before = harness.fake.requests.length;
    await jobsForTest.execute('reconcile-payments');
    expect(harness.fake.requests.slice(before).some((entry) => entry.path.endsWith('/refund'))).toBe(false);
  });

  it('refund.failed returns the amount to the refundable balance', async () => {
    const paid = await paidOnline();
    await refund(paid.payment.id, { amountMinor: 29_500 });
    const [row] = refundRows(paid.payment.id);
    const providerRefund = harness.fake.refunds.get(row!.providerRefundId!)!;
    // What Razorpay does when a refund fails: the money stays captured.
    providerRefund.status = 'failed';
    harness.fake.payments.get(String(paid.providerPayment.id))!.amount_refunded = 0;
    const response = await postWebhook(harness, 'refund.failed', { refund: { ...providerRefund, status: 'failed' }, payment: harness.fake.payments.get(String(paid.providerPayment.id))! });
    expect(response.status).toBe(200);
    expect(refundRows(paid.payment.id)[0]).toMatchObject({ state: 'failed' });
    expect(invoiceRow(paid.invoiceId)).toMatchObject({ refundedMinor: 0, state: 'paid' });
    expect(auditFor(paid.invoiceId, 'payment.refund_failed')).toHaveLength(1);
    // Refundable again.
    const again = await refund(paid.payment.id, { amountMinor: 29_500 });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ state: 'pending' });
  });

  it('Razorpay refusing the refund marks it failed and says so', async () => {
    const paid = await paidOnline();
    harness.fake.fault({ method: 'POST', path: /\/refund$/ }, { status: 400, error: { error: { code: 'BAD_REQUEST_ERROR', description: 'The payment has been fully refunded already' } } });
    const response = await refund(paid.payment.id, { amountMinor: 1_000 });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/fully refunded already.*Nothing was refunded/);
    expect(refundRows(paid.payment.id)[0]).toMatchObject({ state: 'failed', failureReason: 'The payment has been fully refunded already' });
  });

  it('needs billing.refund', async () => {
    const paid = await paidOnline();
    const reception = await signIn('reception@sharkfitness.in');
    expect((await refund(paid.payment.id, { amountMinor: 100 }, randomUUID(), reception)).status).toBe(403);
    expect(refundRows(paid.payment.id)).toEqual([]);
  });

  it('a refund made in the Razorpay Dashboard before the capture was known here converges on the same state', async () => {
    const fixture = openInvoice(member);
    const { body } = await checkout(memberSession, fixture.invoiceId);
    const providerPayment = harness.fake.pay(body.orderId);
    // The member's tab closed before confirm and payment.captured is delayed;
    // the gym refunds from the Dashboard and that event arrives first.
    const dashboardRefund = { id: 'rfnd_dashboard_' + randomUUID().slice(0, 8), entity: 'refund', amount: 29_500, currency: 'INR', payment_id: providerPayment.id, notes: [], status: 'processed' };
    expect((await postWebhook(harness, 'refund.processed', { refund: dashboardRefund, payment: { ...providerPayment, status: 'refunded', amount_refunded: 29_500 } })).status).toBe(200);
    expect((await postWebhook(harness, 'payment.captured', { payment: providerPayment })).status).toBe(200);

    expect(paymentsFor(fixture.invoiceId)).toHaveLength(1);
    expect(invoiceRow(fixture.invoiceId)).toMatchObject({ paidMinor: 29_500, refundedMinor: 29_500, state: 'refunded' });
    const [payment] = paymentsFor(fixture.invoiceId);
    expect(refundRows(payment!.id)).toMatchObject([{ state: 'succeeded', providerRefundId: dashboardRefund.id, actorName: 'Razorpay' }]);
    // Staff decide what happens to the membership.
    expect(exceptionsFor(fixture.invoiceId)).toMatchObject([{ kind: 'refund_outside_console', state: 'open' }]);
  });
});

describe('manual payments keep the manual refund path', () => {
  it('a cash refund is immediate and never calls Razorpay', async () => {
    const { invoiceId } = openInvoice(member, 10_000);
    const paid = await request('POST', `/admin/billing/invoices/${invoiceId}/payments`, owner, { amountMinor: 10_000, method: 'cash', idempotencyKey: randomUUID() });
    expect(paid.status).toBe(200);
    const { paymentId } = (await paid.json()) as { paymentId: string };
    const callsBefore = harness.calls.length;
    const response = await refund(paymentId, { amountMinor: 4_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ invoiceState: 'partially_refunded' });
    expect(refundRows(paymentId)).toMatchObject([{ state: 'succeeded', provider: null, providerRefundId: null }]);
    expect(invoiceRow(invoiceId).refundedMinor).toBe(4_000);
    expect(harness.calls.length).toBe(callsBefore);
    expect((await refund(paymentId, { amountMinor: 6_001 })).status).toBe(422);
  });
});
