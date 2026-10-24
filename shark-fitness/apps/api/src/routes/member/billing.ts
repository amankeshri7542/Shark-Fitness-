import { receiptHtml, receiptRecord } from '../../services/payment-receipt.js';
import { readCreditAccount } from '../../services/credit-account.js';
import { reconcileMembershipDates } from '../../services/membership-dates.js';
import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { formatMoney } from '@shark/domain';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { notFound, precondition } from '../../lib/errors.js';

export const billingRoutes = new Hono();

billingRoutes.get('/credits', (c) => {
  const ctx = ctxOf(c);
  const member = db.select().from(schema.members).where(and(eq(schema.members.tenantId, ctx.tenantId), eq(schema.members.id, ctx.memberId!))).get();
  if (!member) throw notFound('Your membership account');
  return c.json(readCreditAccount(member));
});


billingRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  reconcileMembershipDates(memberId);

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} != 'cancelled'`))
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  const invoices = db.select().from(schema.invoices).where(eq(schema.invoices.memberId, memberId)).orderBy(desc(schema.invoices.issuedOn)).limit(24).all();

  const outstanding = db.select({ total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}), 0)` })
    .from(schema.invoices).where(and(eq(schema.invoices.memberId, memberId),
      sql`${schema.invoices.voided} = 0 and ${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`,
    )).get()?.total ?? 0;
  const member = db.select().from(schema.members).where(and(eq(schema.members.tenantId, ctx.tenantId), eq(schema.members.id, memberId))).get()!;
  return c.json({
    outstandingMinor: outstanding,
    outstandingLabel: formatMoney(outstanding, 'INR'),
    credits: readCreditAccount(member),
    receipts: db.select().from(schema.payments).where(and(eq(schema.payments.tenantId, ctx.tenantId), eq(schema.payments.memberId, memberId), eq(schema.payments.state, 'succeeded'))).orderBy(desc(schema.payments.createdAt)).limit(24).all().map((payment) => ({
      id: payment.id, amountLabel: formatMoney(payment.amountMinor, payment.currency), method: payment.method,
      settledAt: new Date(payment.settledAt ?? payment.createdAt).toISOString(),
    })),
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
      dueMinor: i.voided ? 0 : Math.max(0, i.totalMinor - i.paidMinor),
      dueLabel: formatMoney(i.voided ? 0 : Math.max(0, i.totalMinor - i.paidMinor), i.currency),
      payable: !i.voided && i.totalMinor - i.paidMinor > 0,
    })),
  });
});

billingRoutes.get('/invoices/:invoiceId', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  reconcileMembershipDates(memberId);
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
      dueLabel: formatMoney(invoice.voided ? 0 : Math.max(0, invoice.totalMinor - invoice.paidMinor), invoice.currency),
      payable: !invoice.voided && invoice.totalMinor - invoice.paidMinor > 0,
    },
    lines: lines.map((l) => ({ id: l.id, description: l.description, unitLabel: formatMoney(l.unitMinor, invoice.currency), taxLabel: formatMoney(l.taxMinor, invoice.currency), totalLabel: formatMoney(l.totalMinor, invoice.currency) })),
    receipts: payments.map((p) => ({ id: p.id, amountLabel: formatMoney(p.amountMinor, p.currency), method: p.method, settledAt: p.settledAt ? new Date(p.settledAt).toISOString() : null })),
  });
});

// Retired endpoints fail closed, including retries of historical demo intents.
// A server-generated simulated outcome is not evidence of received funds.
const receptionSettlement = () => {
  throw precondition('Online payment is unavailable. Pay at reception; staff will record independently received funds.');
};
billingRoutes.post('/checkout-intent', receptionSettlement);
billingRoutes.post('/checkout-intent/:intentId/confirm', receptionSettlement);

billingRoutes.get('/payments/:paymentId/receipt', (c) => {
  const ctx = ctxOf(c);
  const payment = db.select().from(schema.payments).where(and(eq(schema.payments.id, c.req.param('paymentId')), eq(schema.payments.tenantId, ctx.tenantId), eq(schema.payments.memberId, ctx.memberId!))).get();
  if (!payment) throw notFound('That payment');
  const record = receiptRecord(ctx.tenantId, payment.id);
  c.header('Cache-Control', 'no-store');
  if (c.req.query('format') === 'html') return c.html(receiptHtml(record.content));
  c.header('Content-Disposition', `attachment; filename="receipt-${payment.id.replace(/[^a-zA-Z0-9_-]/g, '')}.txt"`);
  return c.text(record.content);
});
