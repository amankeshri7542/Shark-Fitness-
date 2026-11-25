import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { db, schema, sqlite } from '../db/client.js';
import { setPaymentProviderForTests } from '../lib/payment-provider.js';
import { webhookBody, webhookSignature } from '../testing/razorpay-fake.js';
import {
  auditFor,
  checkout,
  createMember,
  exceptionsFor,
  intentRow,
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

/* P02 acceptance 4: signed webhooks, at-least-once and out-of-order delivery. */

let harness: Harness;
let member: ReturnType<typeof createMember>;
let session: Session;

beforeAll(async () => {
  harness = await startHarness();
  member = createMember('webhooks');
  session = await signIn(member.email);
});
afterEach(() => harness.assertClean());
afterAll(async () => harness.close());

/** An invoice with a live order, as after the member tapped Pay now. */
async function liveOrder(totalMinor = 29_500) {
  const fixture = openInvoice(member, totalMinor);
  const { body } = await checkout(session, fixture.invoiceId);
  return { ...fixture, intentId: body.intentId, orderId: body.orderId };
}

const eventCount = () => (sqlite.prepare('select count(*) as n from provider_events').get() as { n: number }).n;
const storedEvent = (eventId: string) =>
  db.select().from(schema.providerEvents).where(and(eq(schema.providerEvents.provider, 'razorpay'), eq(schema.providerEvents.providerEventId, eventId))).get();

describe('handled events', () => {
  it('payment.captured settles the invoice and stores the event against the intent', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId);
    const response = await postWebhook(harness, 'payment.captured', { payment }, { eventId: 'evt_captured_1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, duplicate: false, handled: true });
    expect(paymentsFor(order.invoiceId)).toHaveLength(1);
    expect(invoiceRow(order.invoiceId).state).toBe('paid');
    expect(membershipRow(order.membershipId).state).toBe('active');
    expect(intentRow(order.intentId)).toMatchObject({ state: 'succeeded', providerPaymentId: payment.id });
    expect(storedEvent('evt_captured_1')).toMatchObject({ type: 'payment.captured', signatureOk: true, intentId: order.intentId, tenantId: member.tenantId });
    expect(storedEvent('evt_captured_1')!.processedAt).not.toBeNull();
  });

  it('payment.authorized is captured by the server, then settles', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId, { status: 'authorized' });
    expect((await postWebhook(harness, 'payment.authorized', { payment })).status).toBe(200);
    expect(harness.fake.payments.get(String(payment.id))!.status).toBe('captured');
    expect(paymentsFor(order.invoiceId)).toHaveLength(1);
  });

  it('order.paid settles from its payment entity', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId);
    const response = await postWebhook(harness, 'order.paid', { payment, order: harness.fake.orders.get(order.orderId)! });
    expect(response.status).toBe(200);
    expect(invoiceRow(order.invoiceId).state).toBe('paid');
  });

  it('payment.failed marks the attempt failed with Razorpay’s reason', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId, { status: 'failed' });
    expect((await postWebhook(harness, 'payment.failed', { payment })).status).toBe(200);
    expect(intentRow(order.intentId)).toMatchObject({ state: 'failed', failureCode: 'payment_declined' });
    const status = await (await request('GET', `/member/billing/checkout/${order.intentId}`, session)).json();
    expect(status).toMatchObject({ state: 'failed', failureReason: 'Payment failed because the UPI request was declined by the payer.' });
    expect(paymentsFor(order.invoiceId)).toEqual([]);
  });

  it('stores and acknowledges an event it does not act on', async () => {
    const before = eventCount();
    const response = await postWebhook(harness, 'payment.dispute.created', {}, { eventId: 'evt_unknown_1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ handled: false, duplicate: false });
    expect(eventCount()).toBe(before + 1);
    expect(storedEvent('evt_unknown_1')).toMatchObject({ type: 'payment.dispute.created', tenantId: '' });
    expect(storedEvent('evt_unknown_1')!.processingError).toMatch(/not acted on/);
  });

  it('acknowledges a captured payment that matches nothing here, without settling anything', async () => {
    const response = await postWebhook(harness, 'payment.captured', { payment: { id: 'pay_foreign0001', order_id: 'order_foreign0001' } }, { eventId: 'evt_foreign_1' });
    expect(response.status).toBe(200);
    expect(storedEvent('evt_foreign_1')!.processingError).toBe('No matching payment intent.');
    expect(db.select().from(schema.payments).where(eq(schema.payments.providerRef, 'pay_foreign0001')).all()).toEqual([]);
  });
});

describe('delivery guarantees', () => {
  it('a duplicate event id settles once and answers 200', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId);
    const first = await postWebhook(harness, 'payment.captured', { payment }, { eventId: 'evt_dup_1' });
    const second = await postWebhook(harness, 'payment.captured', { payment }, { eventId: 'evt_dup_1' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    // A new event id for the same payment (Razorpay retried with a new event)
    // is still one settlement.
    expect((await postWebhook(harness, 'order.paid', { payment, order: harness.fake.orders.get(order.orderId)! })).status).toBe(200);
    expect(paymentsFor(order.invoiceId)).toHaveLength(1);
    expect(auditFor(order.invoiceId, 'payment.settled_by_provider')).toHaveLength(1);
  });

  it('failed after captured: the invoice stays paid', async () => {
    const order = await liveOrder();
    const captured = harness.fake.pay(order.orderId);
    await postWebhook(harness, 'payment.captured', { payment: captured });
    // Razorpay documents payment.failed arriving after payment.captured.
    const failed = harness.fake.pay(order.orderId, { status: 'failed' });
    expect((await postWebhook(harness, 'payment.failed', { payment: failed })).status).toBe(200);
    expect((await postWebhook(harness, 'payment.failed', { payment: { ...captured, status: 'failed', captured: false } })).status).toBe(200);
    expect(invoiceRow(order.invoiceId).state).toBe('paid');
    expect(intentRow(order.intentId).state).toBe('succeeded');
    expect(paymentsFor(order.invoiceId)).toHaveLength(1);
  });

  it('captured before the local confirm: settles once, and the later confirm is a no-op', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId);
    await postWebhook(harness, 'payment.captured', { payment });
    const fetches = harness.calls.filter((call) => call === 'fetchPayment').length;
    const confirm = await request('POST', `/member/billing/checkout/${order.intentId}/confirm`, session, {
      razorpay_order_id: order.orderId,
      razorpay_payment_id: payment.id,
      razorpay_signature: harness.fake.checkoutSignature(order.orderId, String(payment.id)),
    });
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({ state: 'succeeded' });
    expect(harness.calls.filter((call) => call === 'fetchPayment').length).toBe(fetches);
    expect(paymentsFor(order.invoiceId)).toHaveLength(1);
  });

  it('an event whose processing failed is processed again when Razorpay redelivers it', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId, { status: 'authorized' });
    harness.fake.fault({ method: 'POST', path: /\/capture$/ }, { hangMs: 2_000 });
    const first = await postWebhook(harness, 'payment.authorized', { payment }, { eventId: 'evt_retry_1' });
    expect(first.status).toBe(503);
    expect(storedEvent('evt_retry_1')).toMatchObject({ processedAt: null });
    expect(paymentsFor(order.invoiceId)).toEqual([]);
    const redelivered = await postWebhook(harness, 'payment.authorized', { payment }, { eventId: 'evt_retry_1' });
    expect(redelivered.status).toBe(200);
    expect(paymentsFor(order.invoiceId)).toHaveLength(1);
    expect(storedEvent('evt_retry_1')!.processedAt).not.toBeNull();
  });
});

describe('money that does not match', () => {
  it('an amount mismatch never settles; it opens a reconciliation exception', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId, { amount: 100 });
    expect((await postWebhook(harness, 'payment.captured', { payment })).status).toBe(200);
    expect(paymentsFor(order.invoiceId)).toEqual([]);
    expect(invoiceRow(order.invoiceId)).toMatchObject({ paidMinor: 0, state: 'open' });
    expect(membershipRow(order.membershipId).state).toBe('pending_payment');
    const [exception] = exceptionsFor(order.invoiceId);
    expect(exception).toMatchObject({ kind: 'amount_mismatch', state: 'open', expectedMinor: 29_500, receivedMinor: 100, providerPaymentId: payment.id });
    expect(intentRow(order.intentId).state).toBe('needs_review');
    expect(await (await request('GET', `/member/billing/checkout/${order.intentId}`, session)).json()).toMatchObject({ state: 'needs_review' });
    // Seen again (retry, reconciliation): still one exception.
    await postWebhook(harness, 'payment.captured', { payment });
    expect(exceptionsFor(order.invoiceId)).toHaveLength(1);
  });

  it('a currency mismatch never settles', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId, { currency: 'USD' });
    await postWebhook(harness, 'payment.captured', { payment });
    expect(paymentsFor(order.invoiceId)).toEqual([]);
    expect(exceptionsFor(order.invoiceId)[0]).toMatchObject({ kind: 'currency_mismatch' });
  });

  it('a capture for an invoice already settled at the desk is an exception, not a second payment', async () => {
    const order = await liveOrder();
    db.update(schema.invoices).set({ paidMinor: 29_500, state: 'paid' }).where(eq(schema.invoices.id, order.invoiceId)).run();
    const payment = harness.fake.pay(order.orderId);
    await postWebhook(harness, 'payment.captured', { payment });
    expect(paymentsFor(order.invoiceId)).toEqual([]);
    expect(exceptionsFor(order.invoiceId)[0]).toMatchObject({ kind: 'invoice_already_settled', receivedMinor: 29_500 });
  });
});

describe('signature and transport', () => {
  it('a tampered body is a 400, logged as a security event, and nothing is stored', async () => {
    const order = await liveOrder();
    const payment = harness.fake.pay(order.orderId);
    const warn = vi.spyOn(console, 'warn');
    const before = eventCount();
    const response = await postWebhook(harness, 'payment.captured', { payment }, { tamper: (body) => body.replace('"amount":29500', '"amount":1') });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('SIGNATURE_INVALID');
    expect(eventCount()).toBe(before);
    expect(paymentsFor(order.invoiceId)).toEqual([]);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    warn.mockRestore();
    const line = lines.find((entry) => entry.includes('security_razorpay_webhook_signature_invalid'))!;
    expect(JSON.parse(line)).toMatchObject({ level: 'warn', reason: 'mismatch' });
    // The body (member contact, amounts) is not in the log.
    expect(line).not.toContain(String(payment.id));
    expect(line).not.toContain('member@example.com');
  });

  it('a missing signature is a 400', async () => {
    const before = eventCount();
    const response = await postWebhook(harness, 'payment.captured', {}, { signature: null });
    expect(response.status).toBe(400);
    expect(eventCount()).toBe(before);
  });

  it('a body signed with another secret is a 400', async () => {
    const body = webhookBody('payment.captured');
    const response = await app.request('/v1/webhooks/razorpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': webhookSignature(body, 'not-the-webhook-secret'), 'x-razorpay-event-id': 'evt_wrong_secret' },
      body,
    });
    expect(response.status).toBe(400);
    expect(storedEvent('evt_wrong_secret')).toBeUndefined();
  });

  it('needs no browser session, Origin or CSRF token, and refuses an oversized body', async () => {
    const huge = 'x'.repeat(300 * 1024);
    const response = await app.request('/v1/webhooks/razorpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': webhookSignature(huge, harness.fake.webhookSecret) },
      body: huge,
    });
    expect(response.status).toBe(413);
  });

  it('answers 412 when no provider is configured', async () => {
    setPaymentProviderForTests(null);
    try {
      const response = await postWebhook(harness, 'payment.captured', {});
      expect(response.status).toBe(412);
    } finally {
      setPaymentProviderForTests(harness.provider);
    }
  });
});
