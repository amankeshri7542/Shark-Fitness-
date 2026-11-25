import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setPaymentProviderForTests } from '../lib/payment-provider.js';
import {
  auditFor,
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

/* P02 acceptance 6: payment links that Razorpay never sends, settled by
   payment_link.paid. */

let harness: Harness;
let member: ReturnType<typeof createMember>;
let reception: Session;

beforeAll(async () => {
  harness = await startHarness();
  member = createMember('links');
  reception = await signIn('reception@sharkfitness.in');
});
afterEach(() => harness.assertClean());
afterAll(async () => harness.close());

const createLink = (invoiceId: string, session = reception, key: string = randomUUID()) =>
  request('POST', `/admin/billing/invoices/${invoiceId}/payment-link`, session, undefined, key);

describe('payment links', () => {
  it('creates a link Razorpay will not send, shows it with its expiry, and settles on payment_link.paid', async () => {
    const { invoiceId, membershipId } = openInvoice(member);
    const before = Date.now();
    const response = await createLink(invoiceId);
    expect(response.status).toBe(201);
    const link = (await response.json()) as { intentId: string; url: string; expiresAt: string; state: string; amountLabel: string };
    expect(link).toMatchObject({ state: 'active', amountLabel: '₹295' });
    expect(link.url).toMatch(/^https:\/\/rzp\.io\/i\//);

    const call = harness.fake.requests.find((entry) => entry.path === '/v1/payment_links')!;
    // Nothing is ever sent to the member by Razorpay.
    expect(call.body).toMatchObject({
      amount: 29_500,
      currency: 'INR',
      accept_partial: false,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { invoice_id: invoiceId, intent_id: link.intentId },
    });
    expect(call.body).not.toHaveProperty('customer');
    expect(String(call.body!.reference_id).length).toBeLessThanOrEqual(40);
    // At least 15 minutes ahead (Razorpay's minimum); this product uses 7 days.
    const expireBy = Number(call.body!.expire_by) * 1000;
    expect(expireBy).toBeGreaterThan(before + 6.9 * 86_400_000);
    expect(new Date(link.expiresAt).getTime()).toBe(expireBy);
    expect(auditFor(invoiceId, 'payment_link.created')).toHaveLength(1);

    // A second click shows the same link rather than minting another.
    const again = (await (await createLink(invoiceId)).json()) as { intentId: string; url: string };
    expect(again).toMatchObject({ intentId: link.intentId, url: link.url });
    expect(harness.fake.requests.filter((entry) => entry.path === '/v1/payment_links')).toHaveLength(1);

    const owner = await signIn('owner@sharkfitness.in');
    const detail = (await (await request('GET', `/admin/billing/invoices/${invoiceId}`, owner)).json()) as { paymentLinks: Array<{ url: string; state: string }>; onlinePayment: { available: boolean } };
    expect(detail.onlinePayment.available).toBe(true);
    expect(detail.paymentLinks).toMatchObject([{ url: link.url, state: 'active' }]);

    const providerLink = [...harness.fake.links.values()][0]!;
    const { payment, order } = harness.fake.payLink(String(providerLink.id));
    const paid = await postWebhook(harness, 'payment_link.paid', { payment_link: providerLink, order, payment });
    expect(paid.status).toBe(200);
    expect(paymentsFor(invoiceId)).toMatchObject([{ provider: 'razorpay', providerRef: payment.id, amountMinor: 29_500 }]);
    expect(invoiceRow(invoiceId).state).toBe('paid');
    expect(membershipRow(membershipId).state).toBe('active');
    const after = (await (await request('GET', `/admin/billing/invoices/${invoiceId}`, owner)).json()) as {
      paymentLinks: Array<{ state: string }>;
      attempts: Array<{ channel: string; state: string; providerPaymentId: string }>;
      events: Array<{ type: string }>;
    };
    expect(after.paymentLinks[0]!.state).toBe('paid');
    expect(after.attempts[0]).toMatchObject({ channel: 'payment_link', state: 'succeeded', providerPaymentId: payment.id });
    expect(after.events.map((event) => event.type)).toContain('payment_link.paid');

    // A link for a paid invoice is refused.
    expect((await createLink(invoiceId)).status).toBe(409);
  });

  it('stops offering a link once the invoice is paid at the desk or voided; money through it later is an exception, not a second payment', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const linkState = async (invoiceId: string) =>
      ((await (await request('GET', `/admin/billing/invoices/${invoiceId}`, owner)).json()) as { paymentLinks: Array<{ state: string }> }).paymentLinks.map((link) => link.state);

    const desk = openInvoice(member);
    expect((await createLink(desk.invoiceId)).status).toBe(201);
    const providerLink = [...harness.fake.links.values()].at(-1)!;
    const cash = await request('POST', `/admin/billing/invoices/${desk.invoiceId}/payments`, owner, { method: 'cash', amountMinor: 29_500, idempotencyKey: randomUUID(), note: 'Paid at the desk' });
    expect(cash.status).toBeLessThan(300);
    expect(await linkState(desk.invoiceId)).toEqual(['superseded']);

    // The member pays the old link anyway: recorded for staff, never settled twice.
    const { payment, order } = harness.fake.payLink(String(providerLink.id));
    expect((await postWebhook(harness, 'payment_link.paid', { payment_link: providerLink, order, payment })).status).toBe(200);
    expect(paymentsFor(desk.invoiceId)).toHaveLength(1);
    expect(exceptionsFor(desk.invoiceId).map((row) => row.kind)).toEqual(['invoice_already_settled']);

    const voided = openInvoice(member);
    expect((await createLink(voided.invoiceId)).status).toBe(201);
    expect((await request('POST', `/admin/billing/invoices/${voided.invoiceId}/void`, owner, { reason: 'Raised in error' })).status).toBeLessThan(300);
    expect(await linkState(voided.invoiceId)).toEqual(['superseded']);
  });

  it('refuses staff without billing.record_payment, and invoices outside the tenant', async () => {
    const { invoiceId } = openInvoice(member);
    const trainer = await signIn('rehan@sharkfitness.in');
    expect((await createLink(invoiceId, trainer)).status).toBe(403);
    expect((await createLink('inv_does_not_exist')).status).toBe(404);
  });

  it('says so when no provider is configured', async () => {
    const { invoiceId } = openInvoice(member);
    setPaymentProviderForTests(null);
    try {
      const response = await createLink(invoiceId);
      expect(response.status).toBe(412);
      expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/Payment links need online payment/);
    } finally {
      setPaymentProviderForTests(harness.provider);
    }
  });
});
