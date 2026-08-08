import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { formatMoney } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { conflict, notFound, precondition } from '../../lib/errors.js';
import { id, token } from '../../lib/ids.js';
import { MINUTE, now } from '../../lib/time.js';
import { applyPaymentToInvoice } from '../../services/billing.js';

export const billingRoutes = new Hono();

const INTENT_TTL_MS = 10 * MINUTE;

billingRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} != 'cancelled'`))
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  const invoices = db.select().from(schema.invoices).where(eq(schema.invoices.memberId, memberId)).orderBy(desc(schema.invoices.issuedOn)).limit(24).all();

  return c.json({
    membership: membership
      ? {
          id: membership.id,
          productName: membership.productName,
          state: membership.state,
          endsOn: membership.endsOn,
          autoRenew: membership.autoRenew,
          priceLabel: formatMoney(membership.priceMinor, membership.currency),
        }
      : null,
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      state: i.state,
      issuedOn: i.issuedOn,
      dueOn: i.dueOn,
      totalLabel: formatMoney(i.totalMinor, i.currency),
      dueMinor: Math.max(0, i.totalMinor - i.paidMinor),
      dueLabel: formatMoney(Math.max(0, i.totalMinor - i.paidMinor), i.currency),
      payable: !i.voided && i.totalMinor - i.paidMinor > 0 && i.state !== 'refunded',
    })),
  });
});

billingRoutes.get('/invoices/:invoiceId', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const invoiceId = c.req.param('invoiceId');

  const invoice = db.select().from(schema.invoices).where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.memberId, memberId))).get();
  if (!invoice) throw notFound('That invoice');

  const lines = db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)).all();
  const payments = db.select().from(schema.payments).where(and(eq(schema.payments.invoiceId, invoiceId), eq(schema.payments.state, 'succeeded'))).orderBy(desc(schema.payments.createdAt)).all();

  return c.json({
    invoice: {
      id: invoice.id,
      number: invoice.number,
      state: invoice.state,
      issuedOn: invoice.issuedOn,
      dueOn: invoice.dueOn,
      totalLabel: formatMoney(invoice.totalMinor, invoice.currency),
      paidLabel: formatMoney(invoice.paidMinor, invoice.currency),
      dueLabel: formatMoney(Math.max(0, invoice.totalMinor - invoice.paidMinor), invoice.currency),
      payable: !invoice.voided && invoice.totalMinor - invoice.paidMinor > 0,
    },
    lines: lines.map((l) => ({ id: l.id, description: l.description, unitLabel: formatMoney(l.unitMinor, invoice.currency), taxLabel: formatMoney(l.taxMinor, invoice.currency), totalLabel: formatMoney(l.totalMinor, invoice.currency) })),
    receipts: payments.map((p) => ({ id: p.id, amountLabel: formatMoney(p.amountMinor, p.currency), method: p.method, settledAt: p.settledAt ? new Date(p.settledAt).toISOString() : null })),
  });
});

const CheckoutIntentBody = z.object({ invoiceId: z.string() });

/**
 * Demo checkout — there is no live payment gateway. This creates a pending
 * payment attempt the member then confirms; see POST .../confirm for why
 * that confirmation is server-authoritative rather than client-supplied.
 */
billingRoutes.post('/checkout-intent', validate('json', CheckoutIntentBody), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const { invoiceId } = c.req.valid('json');

  const invoice = db.select().from(schema.invoices).where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.memberId, memberId))).get();
  if (!invoice) throw notFound('That invoice');
  if (invoice.voided || ['paid', 'refunded'].includes(invoice.state)) throw conflict('This invoice is not payable.');

  const dueMinor = invoice.totalMinor - invoice.paidMinor;
  if (dueMinor <= 0) throw conflict('This invoice has nothing outstanding.');

  const paymentId = id('pay');
  const clientToken = token(16);
  const expiresAt = now() + INTENT_TTL_MS;

  db.insert(schema.payments)
    .values({
      id: paymentId,
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      invoiceId,
      memberId,
      method: 'upi',
      state: 'created',
      amountMinor: dueMinor,
      currency: invoice.currency,
      provider: 'demo',
      providerRef: clientToken,
      idempotencyKey: paymentId,
      recordedById: null,
      recordedByName: null,
      failureReason: null,
      note: null,
      createdAt: now(),
      settledAt: null,
    })
    .run();

  return c.json({
    intentId: paymentId,
    invoiceId,
    amountMinor: dueMinor,
    currency: invoice.currency,
    provider: 'demo',
    clientToken,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

/**
 * Server-authoritative confirmation. The request body carries no outcome —
 * the member is not telling the server "it succeeded"; the server itself,
 * acting as this demo/manual adapter, decides. A real gateway's webhook
 * would occupy exactly this role; this endpoint stands in for it because
 * there is no live gateway behind this build (see docs/PHASE-1-SECURITY /
 * the Phase 3 plan header).
 */
billingRoutes.post('/checkout-intent/:intentId/confirm', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const intentId = c.req.param('intentId');

  const payment = db.select().from(schema.payments).where(and(eq(schema.payments.id, intentId), eq(schema.payments.tenantId, ctx.tenantId), eq(schema.payments.memberId, memberId))).get();
  if (!payment) throw notFound('That checkout attempt');

  if (payment.state === 'succeeded') {
    return c.json({ ok: true, invoiceState: 'settled_previously', alreadyProcessed: true });
  }
  if (payment.state !== 'created') throw conflict('This checkout attempt is no longer active.');
  if (now() - payment.createdAt > INTENT_TTL_MS) throw precondition('This checkout attempt expired. Start again.');

  const result = transact(() =>
    applyPaymentToInvoice({
      ctx,
      invoiceId: payment.invoiceId!,
      amountMinor: payment.amountMinor,
      method: payment.method,
      provider: 'demo',
      providerRef: payment.providerRef,
      idempotencyKey: payment.idempotencyKey,
      recordedByName: null,
      existingPaymentId: payment.id,
    }),
  );

  return c.json(result);
});
