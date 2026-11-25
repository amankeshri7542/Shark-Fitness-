import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, schema, sqlite, transact } from '../db/client.js';
import { setPaymentProviderForTests } from '../lib/payment-provider.js';
import {
  auditFor,
  checkout,
  createMember,
  intentRow,
  invoiceRow,
  membershipRow,
  openInvoice,
  outboxFor,
  paymentsFor,
  request,
  signIn,
  startHarness,
  type Harness,
  type Session,
} from './support/razorpay-harness.js';

/* P02 acceptance 3 and 8: Checkout → confirm against a fake Razorpay, with
   no outbound request and no provider call inside a transaction. */

let harness: Harness;
let member: ReturnType<typeof createMember>;
let session: Session;

beforeAll(async () => {
  harness = await startHarness();
  member = createMember('checkout');
  session = await signIn(member.email);
});
afterEach(() => harness.assertClean());
afterAll(async () => harness.close());

async function confirm(intentId: string, body: Record<string, string>) {
  const response = await request('POST', `/member/billing/checkout/${intentId}/confirm`, session, body);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe('member checkout', () => {
  it('(a) checkout → confirm → captured: invoice paid once, membership active, receipt, audit and realtime', async () => {
    const { invoiceId, membershipId } = openInvoice(member);
    const { response, body } = await checkout(session, invoiceId);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ state: 'processing', keyId: harness.fake.keyId, amountMinor: 29_500, currency: 'INR', invoiceId });
    expect(String(body.orderId)).toMatch(/^order_/);
    expect(body.description).toMatch(/^Invoice RZP-/);
    // The browser gets the public key id, never the secret.
    expect(JSON.stringify(body)).not.toContain(harness.fake.keySecret);
    const orderRequest = harness.fake.requests.find((entry) => entry.path === '/v1/orders')!;
    expect(orderRequest.body).toMatchObject({ amount: 29_500, currency: 'INR', notes: { invoice_id: invoiceId, intent_id: body.intentId } });
    expect(String(orderRequest.body!.receipt).length).toBeLessThanOrEqual(40);

    const payment = harness.fake.pay(body.orderId, { status: 'captured' });
    const confirmed = await confirm(body.intentId, {
      razorpay_order_id: body.orderId,
      razorpay_payment_id: String(payment.id),
      razorpay_signature: harness.fake.checkoutSignature(body.orderId, String(payment.id)),
    });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body).toMatchObject({ state: 'succeeded', invoiceId, failureReason: null });

    const payments = paymentsFor(invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ provider: 'razorpay', providerRef: payment.id, amountMinor: 29_500, method: 'upi', state: 'succeeded', recordedById: 'system:razorpay' });
    expect(confirmed.body.paymentId).toBe(payments[0]!.id);
    expect(invoiceRow(invoiceId)).toMatchObject({ state: 'paid', paidMinor: 29_500 });
    expect(membershipRow(membershipId).state).toBe('active');
    expect(db.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.paymentId, payments[0]!.id)).get()).toBeTruthy();
    const [entry] = auditFor(invoiceId, 'payment.settled_by_provider');
    expect(entry).toMatchObject({ actorId: 'system:razorpay', actorName: 'Razorpay' });
    expect(outboxFor(member.memberId, 'payment.succeeded').some((event) => JSON.parse(event.payload).invoiceId === invoiceId)).toBe(true);
    expect(outboxFor(member.memberId, 'membership.state_changed').length).toBeGreaterThan(0);

    // The receipt is the member's to download.
    const receipt = await request('GET', `/member/billing/payments/${payments[0]!.id}/receipt`, session);
    expect(receipt.status).toBe(200);

    // A second confirm (double tap, retry) settles nothing more.
    const again = await confirm(body.intentId, {
      razorpay_order_id: body.orderId,
      razorpay_payment_id: String(payment.id),
      razorpay_signature: harness.fake.checkoutSignature(body.orderId, String(payment.id)),
    });
    expect(again.body.state).toBe('succeeded');
    expect(paymentsFor(invoiceId)).toHaveLength(1);
    expect(auditFor(invoiceId, 'payment.settled_by_provider')).toHaveLength(1);
  });

  it('(b) a bad signature is a 400 and settles nothing', async () => {
    const { invoiceId, membershipId } = openInvoice(member);
    const { body } = await checkout(session, invoiceId);
    const payment = harness.fake.pay(body.orderId, { status: 'captured' });
    const fetchesBefore = harness.calls.filter((call) => call === 'fetchPayment').length;

    for (const tampered of [
      { razorpay_signature: harness.fake.checkoutSignature(body.orderId, 'pay_someoneelse') },
      { razorpay_signature: 'f'.repeat(64) },
      { razorpay_order_id: 'order_notours', razorpay_signature: harness.fake.checkoutSignature('order_notours', String(payment.id)) },
    ]) {
      const result = await confirm(body.intentId, {
        razorpay_order_id: body.orderId,
        razorpay_payment_id: String(payment.id),
        ...tampered,
      });
      expect(result.response.status).toBe(400);
      expect((result.body.error as { code: string }).code).toBe('SIGNATURE_INVALID');
    }
    expect(paymentsFor(invoiceId)).toEqual([]);
    expect(invoiceRow(invoiceId).paidMinor).toBe(0);
    expect(membershipRow(membershipId).state).toBe('pending_payment');
    // Nothing was even asked of Razorpay on an unverified claim.
    expect(harness.calls.filter((call) => call === 'fetchPayment').length).toBe(fetchesBefore);
  });

  it('(c) an authorized payment is captured by the server, then settles', async () => {
    const { invoiceId } = openInvoice(member);
    const { body } = await checkout(session, invoiceId);
    const payment = harness.fake.pay(body.orderId, { status: 'authorized' });
    const result = await confirm(body.intentId, {
      razorpay_order_id: body.orderId,
      razorpay_payment_id: String(payment.id),
      razorpay_signature: harness.fake.checkoutSignature(body.orderId, String(payment.id)),
    });
    expect(result.body.state).toBe('succeeded');
    const capture = harness.fake.requests.find((entry) => entry.path === `/v1/payments/${payment.id}/capture`)!;
    expect(capture.body).toEqual({ amount: 29_500, currency: 'INR' });
    expect(harness.fake.payments.get(String(payment.id))!.status).toBe('captured');
    expect(paymentsFor(invoiceId)).toHaveLength(1);
  });

  it('leaves a payment Razorpay has not finished in processing for the webhook', async () => {
    const { invoiceId } = openInvoice(member);
    const { body } = await checkout(session, invoiceId);
    const payment = harness.fake.pay(body.orderId, { status: 'created' });
    const result = await confirm(body.intentId, {
      razorpay_order_id: body.orderId,
      razorpay_payment_id: String(payment.id),
      razorpay_signature: harness.fake.checkoutSignature(body.orderId, String(payment.id)),
    });
    expect(result.body.state).toBe('processing');
    expect(paymentsFor(invoiceId)).toEqual([]);
    const status = await request('GET', `/member/billing/checkout/${body.intentId}`, session);
    expect(await status.json()).toMatchObject({ state: 'processing', paymentId: null });
  });

  it('reports a failed payment in plain words and lets the member retry the same order', async () => {
    const { invoiceId } = openInvoice(member);
    const key = randomUUID();
    const first = await checkout(session, invoiceId, key);
    const failed = harness.fake.pay(first.body.orderId, { status: 'failed' });
    const result = await confirm(first.body.intentId, {
      razorpay_order_id: first.body.orderId,
      razorpay_payment_id: String(failed.id),
      razorpay_signature: harness.fake.checkoutSignature(first.body.orderId, String(failed.id)),
    });
    expect(result.body).toMatchObject({ state: 'failed', failureReason: 'Payment failed because the UPI request was declined by the payer.' });
    expect(outboxFor(member.memberId, 'payment.failed').some((event) => JSON.parse(event.payload).intentId === first.body.intentId)).toBe(true);

    // Retry with the same key: same intent, same order, no new order at Razorpay.
    const orders = harness.fake.orders.size;
    const retry = await checkout(session, invoiceId, key);
    expect(retry.body).toMatchObject({ intentId: first.body.intentId, orderId: first.body.orderId, state: 'failed' });
    expect(harness.fake.orders.size).toBe(orders);
    const paid = harness.fake.pay(first.body.orderId, { status: 'captured' });
    const settled = await confirm(first.body.intentId, {
      razorpay_order_id: first.body.orderId,
      razorpay_payment_id: String(paid.id),
      razorpay_signature: harness.fake.checkoutSignature(first.body.orderId, String(paid.id)),
    });
    expect(settled.body.state).toBe('succeeded');
    expect(paymentsFor(invoiceId)).toHaveLength(1);
  });

  it('resumes the one live order for an invoice instead of opening a second', async () => {
    const { invoiceId } = openInvoice(member);
    const first = await checkout(session, invoiceId);
    const second = await checkout(session, invoiceId);
    expect(second.body.intentId).toBe(first.body.intentId);
    expect(second.body.orderId).toBe(first.body.orderId);
  });

  it('(d) a createOrder timeout leaves no payment and a FAILED intent; the same key then works', async () => {
    const { invoiceId } = openInvoice(member);
    const key = randomUUID();
    harness.fake.fault({ method: 'POST', path: /^\/v1\/orders$/ }, { hangMs: 2_000 });
    const first = await checkout(session, invoiceId, key);
    expect(first.response.status).toBe(503);
    expect((first.body.error as { code: string; message: string })).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: expect.stringMatching(/Nothing was charged/) });
    const intent = db.select().from(schema.paymentIntents).where(and(eq(schema.paymentIntents.invoiceId, invoiceId), eq(schema.paymentIntents.idempotencyKey, key))).get()!;
    expect(intent).toMatchObject({ state: 'failed', providerOrderId: null, failureCode: 'order_timeout' });
    expect(paymentsFor(invoiceId)).toEqual([]);

    const retry = await checkout(session, invoiceId, key);
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({ intentId: intent.id, state: 'processing' });
    expect(String(retry.body.orderId)).toMatch(/^order_/);
  });

  it('refuses a reused key for a different invoice', async () => {
    const key = randomUUID();
    const one = openInvoice(member);
    const two = openInvoice(member);
    expect((await checkout(session, one.invoiceId, key)).response.status).toBe(200);
    const reused = await checkout(session, two.invoiceId, key);
    expect(reused.response.status).toBe(409);
  });

  it('requires an Idempotency-Key', async () => {
    const { invoiceId } = openInvoice(member);
    const response = await request('POST', `/member/billing/invoices/${invoiceId}/checkout`, session, undefined, null);
    expect(response.status).toBe(422);
  });

  it("(e) another member's invoice, or another member's intent, is a 404", async () => {
    const other = createMember('other');
    const otherSession = await signIn(other.email);
    const { invoiceId } = openInvoice(other);
    expect((await checkout(session, invoiceId)).response.status).toBe(404);
    const theirs = await checkout(otherSession, invoiceId);
    expect(theirs.response.status).toBe(200);
    expect((await request('GET', `/member/billing/checkout/${theirs.body.intentId}`, session)).status).toBe(404);
    const confirmTheirs = await confirm(theirs.body.intentId, { razorpay_order_id: theirs.body.orderId, razorpay_payment_id: 'pay_x', razorpay_signature: 'x' });
    expect(confirmTheirs.response.status).toBe(404);
    // Staff in the same gym are not members: the member endpoints refuse them.
    const owner = await signIn('owner@sharkfitness.in');
    expect((await checkout(owner, invoiceId)).response.status).toBe(403);
  });

  it('(f) a void or paid invoice is a 409', async () => {
    const voided = openInvoice(member);
    db.update(schema.invoices).set({ voided: true, state: 'void', voidReason: 'test' }).where(eq(schema.invoices.id, voided.invoiceId)).run();
    expect((await checkout(session, voided.invoiceId)).response.status).toBe(409);
    const paid = openInvoice(member);
    db.update(schema.invoices).set({ paidMinor: 29_500, state: 'paid' }).where(eq(schema.invoices.id, paid.invoiceId)).run();
    const response = await checkout(session, paid.invoiceId);
    expect(response.response.status).toBe(409);
    expect((response.body.error as { message: string }).message).toBe('This invoice is already paid.');
    expect(harness.fake.orders.size).toBeGreaterThan(0);
  });

  it('exposes online payment on the billing summary', async () => {
    const summary = (await (await request('GET', '/member/billing', session)).json()) as { onlinePayment: unknown };
    expect(summary.onlinePayment).toEqual({ available: true, provider: 'razorpay', testMode: true });
  });
});

describe('no provider call inside a transaction (acceptance 8)', () => {
  it('the adapter refuses to call Razorpay while a transaction is open', async () => {
    const before = harness.fake.requests.length;
    await expect(transact(() => harness.provider.fetchPayment('pay_anything'))).rejects.toThrow(/inside a database transaction/);
    expect(harness.fake.requests.length).toBe(before);
    // The harness records it too; clear it so afterEach stays meaningful.
    expect(harness.callsInsideTransaction).toEqual(['fetchPayment']);
    harness.callsInsideTransaction.length = 0;
    expect(sqlite.inTransaction).toBe(false);
  });
});

describe('member plan purchase and renewal', () => {
  it('lists eligible plans and refuses while a plan is current', async () => {
    const newcomer = createMember('plans');
    const newcomerSession = await signIn(newcomer.email);
    const options = (await (await request('GET', '/member/billing/plans', newcomerSession)).json()) as {
      mode: string; onlinePayment: boolean; plans: Array<{ productId: string; totalMinor: number }>;
    };
    expect(options).toMatchObject({ mode: 'purchase', onlinePayment: true });
    expect(options.plans.length).toBeGreaterThan(0);
    // Nothing that needs staff approval or a corporate sponsor is offered.
    const offered = new Set(options.plans.map((plan) => plan.productId));
    for (const product of db.select().from(schema.products).where(eq(schema.products.tenantId, newcomer.tenantId)).all()) {
      if (product.eligibility.requiresApproval || product.eligibility.corporateOnly || product.status !== 'active') expect(offered.has(product.id)).toBe(false);
    }

    const plan = options.plans.find((candidate) => candidate.totalMinor >= 100)!;
    const key = randomUUID();
    const started = await request('POST', `/member/billing/plans/${plan.productId}/checkout`, newcomerSession, undefined, key);
    expect(started.status).toBe(200);
    const body = (await started.json()) as { kind: string; invoiceId: string; orderId: string; intentId: string; amountMinor: number };
    expect(body).toMatchObject({ kind: 'checkout', amountMinor: plan.totalMinor });
    const membership = db.select().from(schema.memberships).where(eq(schema.memberships.memberId, newcomer.memberId)).get()!;
    expect(membership.state).toBe('pending_payment');
    expect(invoiceRow(body.invoiceId)).toMatchObject({ refType: 'membership', refId: membership.id, state: 'open' });

    // Retrying the same request does not invoice twice.
    const retried = (await (await request('POST', `/member/billing/plans/${plan.productId}/checkout`, newcomerSession, undefined, key)).json()) as { invoiceId: string; intentId: string };
    expect(retried).toMatchObject({ invoiceId: body.invoiceId, intentId: body.intentId });
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.memberId, newcomer.memberId)).all()).toHaveLength(1);

    // While that plan waits for payment, no other purchase is offered.
    const pending = (await (await request('GET', '/member/billing/plans', newcomerSession)).json()) as { mode: string; plans: unknown[]; unavailableReason: string };
    expect(pending).toMatchObject({ mode: 'unavailable', plans: [] });
    expect(pending.unavailableReason).toMatch(/waiting for payment/);
    expect((await request('POST', `/member/billing/plans/${plan.productId}/checkout`, newcomerSession)).status).toBe(409);

    const payment = harness.fake.pay(body.orderId, { status: 'captured' });
    const confirmed = await request('POST', `/member/billing/checkout/${body.intentId}/confirm`, newcomerSession, {
      razorpay_order_id: body.orderId, razorpay_payment_id: payment.id, razorpay_signature: harness.fake.checkoutSignature(body.orderId, String(payment.id)),
    });
    expect(((await confirmed.json()) as { state: string }).state).toBe('succeeded');
    expect(membershipRow(membership.id).state).toBe('active');
    expect(intentRow(body.intentId).purpose).toBe('plan_purchase');
  });

  it('renews only an expired or cancelled membership, through the renewal quote', async () => {
    const lapsed = createMember('renew');
    const lapsedSession = await signIn(lapsed.email);
    const { membershipId } = openInvoice(lapsed);
    db.update(schema.memberships).set({ state: 'expired' }).where(eq(schema.memberships.id, membershipId)).run();
    const options = (await (await request('GET', '/member/billing/plans', lapsedSession)).json()) as { mode: string; plans: Array<{ productId: string; totalMinor: number }>; previousProductId: string };
    expect(options.mode).toBe('renew');
    expect(options.previousProductId).toBe(membershipRow(membershipId).productId);
    const plan = options.plans.find((candidate) => candidate.totalMinor >= 100)!;
    const started = (await (await request('POST', `/member/billing/plans/${plan.productId}/checkout`, lapsedSession)).json()) as { intentId: string };
    expect(intentRow(started.intentId).purpose).toBe('plan_renewal');
    const renewal = db.select().from(schema.memberships).where(and(eq(schema.memberships.memberId, lapsed.memberId), eq(schema.memberships.state, 'pending_payment'))).get()!;
    expect(renewal.previousMembershipId).toBe(membershipId);
    expect(auditFor(lapsed.memberId, 'membership.renewed')).toHaveLength(1);
  });
});

describe('with no provider configured (acceptance 1)', () => {
  it('every new member payment endpoint answers 412 exactly like the retired ones, and changes nothing', async () => {
    setPaymentProviderForTests(null);
    try {
      const { invoiceId } = openInvoice(member);
      const before = sqlite.prepare('select count(*) as n from payment_intents').get() as { n: number };
      for (const [path, body] of [
        [`/member/billing/invoices/${invoiceId}/checkout`, undefined],
        ['/member/billing/checkout/pi_whatever/confirm', { razorpay_order_id: 'o', razorpay_payment_id: 'p', razorpay_signature: 's' }],
        ['/member/billing/plans/prd_whatever/checkout', undefined],
        ['/member/billing/checkout-intent', { invoiceId }],
      ] as const) {
        const response = await request('POST', path, session, body);
        expect(response.status, path).toBe(412);
        expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
          'Online payment is unavailable. Pay at reception; staff will record independently received funds.',
        );
      }
      expect(sqlite.prepare('select count(*) as n from payment_intents').get()).toEqual(before);
      const summary = (await (await request('GET', '/member/billing', session)).json()) as { onlinePayment: unknown };
      expect(summary.onlinePayment).toEqual({ available: false, provider: null, testMode: false });
      const plans = (await (await request('GET', '/member/billing/plans', session)).json()) as { onlinePayment: boolean };
      expect(plans.onlinePayment).toBe(false);
    } finally {
      setPaymentProviderForTests(harness.provider);
    }
  });
});
