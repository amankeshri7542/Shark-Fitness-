import { reconcileMembershipDates } from '../../services/membership-dates.js';
import { receiptHtml, receiptRecord } from '../../services/payment-receipt.js';
import { taxInvoiceFilename, taxInvoiceHtml, taxInvoiceRecord, taxInvoiceText } from '../../services/tax-invoice.js';
import { readCreditAccount } from '../../services/credit-account.js';
import { runIdempotently } from '../../lib/idempotency.js';
import { Hono } from 'hono';
import { can } from '@shark/domain';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { RecordPaymentInput } from '@shark/contracts';
import { validate } from '../../middleware/validate.js';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requireAssignedMember, requirePermission } from '../../lib/context.js';
import { conflict, invalid, notFound } from '../../lib/errors.js';
import {
  applyPaymentSafely,
  refundSafely,
  voidInvoiceSafely,
} from '../../services/billing-stabilization.js';
import { createMembershipPurchase, renewalQuote } from '../../services/billing-membership.js';
import { loadInvoiceInScope } from '../../services/billing.js';
import { loadMemberInScope } from '../../services/members.js';
import { requireIdempotencyKey } from '../../services/payments/checkout.js';
import { requestProviderRefund } from '../../services/payments/refunds.js';
import { recordPtSession, refundCreditPack, sellCreditPack } from '../../services/credit-packs.js';

export const billingStabilizationRoutes = new Hono();

billingStabilizationRoutes.get('/members/:memberId/credits', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'member.view');
  const member = loadMemberInScope(ctx, c.req.param('memberId'));
  requireAssignedMember(ctx, member.trainerId);
  const account = readCreditAccount(member);
  // A coach sees how many credits a member has and their history; what packs
  // cost, their invoices and refund amounts are billing information (P05).
  if (!can(ctx.role, 'billing.view')) return c.json({ ...account, packs: undefined, offers: undefined, saleAvailable: false });
  return c.json(account);
});

/* ——— Credit packs (P05, decision 11) ——————————————————————————— */

billingStabilizationRoutes.post(
  '/members/:memberId/credit-packs',
  validate('json', z.object({ productId: z.string().min(1) })),
  (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'billing.record_payment');
    const member = loadMemberInScope(ctx, c.req.param('memberId'));
    const sale = sellCreditPack(ctx, {
      memberId: member.id,
      productId: c.req.valid('json').productId,
      idempotencyKey: `staff:${requireIdempotencyKey(c.req.header('idempotency-key'))}`,
      soldBy: 'staff',
    });
    return c.json({
      ...sale,
      message: sale.creditsAllocated
        ? 'The pack is on the account and its credits are ready to use.'
        : 'Invoice raised. The credits appear as soon as it is paid in full.',
    });
  },
);

billingStabilizationRoutes.post(
  '/credit-packs/:packId/refund',
  validate('json', z.object({ reason: z.string().trim().min(4).max(280) })),
  async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'billing.refund');
    return c.json(
      await refundCreditPack(ctx, c.req.param('packId'), {
        reason: c.req.valid('json').reason,
        idempotencyKey: `pack:${requireIdempotencyKey(c.req.header('idempotency-key'))}`,
      }),
    );
  },
);

billingStabilizationRoutes.post(
  '/members/:memberId/pt-sessions',
  validate('json', z.object({ note: z.string().trim().max(280).nullable().default(null), trainerId: z.string().min(1).nullable().default(null) })),
  (c) => {
    const ctx = ctxOf(c);
    const key = requireIdempotencyKey(c.req.header('idempotency-key'));
    if (!/^[A-Za-z0-9:_-]{8,120}$/.test(key)) throw invalid('That request key is not valid.');
    const body = c.req.valid('json');
    return c.json(recordPtSession(ctx, c.req.param('memberId'), { idempotencyKey: key.replace(/[^A-Za-z0-9_-]/g, '_'), note: body.note, trainerId: body.trainerId }));
  },
);

billingStabilizationRoutes.post(
  '/invoices/:invoiceId/payments',
  validate('json', RecordPaymentInput.omit({ invoiceId: true })),
  (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'billing.record_payment');
    const invoiceId = c.req.param('invoiceId');
    const body = c.req.valid('json');

    if (body.method === 'upi' && !body.reference?.trim()) throw invalid('A verified UPI transaction reference is required.');

    loadInvoiceInScope(ctx, invoiceId);

    const result = transact(() =>
      applyPaymentSafely({
        ctx,
        invoiceId,
        amountMinor: body.amountMinor,
        method: body.method,
        provider: null,
        providerRef: body.reference ?? null,
        idempotencyKey: body.idempotencyKey,
        recordedByName: ctx.name,
        note: body.note,
      }),
    );
    return c.json(result);
  },
);

billingStabilizationRoutes.get('/payments/:paymentId/receipt', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'billing.view');
  const payment = db.select().from(schema.payments).where(and(eq(schema.payments.tenantId, ctx.tenantId), eq(schema.payments.id, c.req.param('paymentId')))).get();
  if (!payment?.invoiceId) throw notFound('That payment');
  loadInvoiceInScope(ctx, payment.invoiceId);
  const record = receiptRecord(ctx.tenantId, payment.id);
  c.header('Cache-Control', 'no-store');
  if (c.req.query('format') === 'html') return c.html(receiptHtml(record.content));
  c.header('Content-Disposition', `attachment; filename="receipt-${record.payment.id.replace(/[^a-zA-Z0-9_-]/g, '')}.txt"`);
  return c.text(record.content);
});

/** The invoice as a GST tax invoice, or a plain invoice where no valid GSTIN
 *  was configured when it was raised. Same scope as the invoice itself. */
billingStabilizationRoutes.get('/invoices/:invoiceId/tax-invoice', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'billing.view');
  const invoice = loadInvoiceInScope(ctx, c.req.param('invoiceId'));
  const record = taxInvoiceRecord(ctx.tenantId, invoice.id);
  c.header('Cache-Control', 'no-store');
  if (c.req.query('format') === 'html') return c.html(taxInvoiceHtml(record));
  c.header('Content-Disposition', `attachment; filename="${taxInvoiceFilename(record.title, invoice.number)}"`);
  return c.text(taxInvoiceText(record));
});
billingStabilizationRoutes.post(
  '/invoices/:invoiceId/void',
  validate('json', z.object({ reason: z.string().min(4) })),
  (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'billing.write_off');
    return c.json(
      transact(() => voidInvoiceSafely(ctx, c.req.param('invoiceId'), c.req.valid('json').reason)),
    );
  },
);

billingStabilizationRoutes.post(
  '/payments/:paymentId/refund',
  validate(
    'json',
    z.object({
      amountMinor: z.number().int().positive(),
      reason: z.string().min(4),
      entitlementReversed: z.boolean().default(false),
    }),
  ),
  async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'billing.refund');
    const body = c.req.valid('json');
    const paymentId = c.req.param('paymentId');
    const payment = db.select().from(schema.payments).where(and(
      eq(schema.payments.id, paymentId), eq(schema.payments.tenantId, ctx.tenantId),
    )).get();
    if (!payment?.invoiceId) throw notFound('That payment');
    // Recheck branch access even for a cached retry response.
    loadInvoiceInScope(ctx, payment.invoiceId);
    if (payment.provider === 'razorpay') {
      // The money has to go back the way it came: through Razorpay, pending
      // until Razorpay reports it processed (services/payments/refunds.ts).
      return c.json(await requestProviderRefund({
        ctx, paymentId, ...body, idempotencyKey: requireIdempotencyKey(c.req.header('idempotency-key')),
      }));
    }
    return c.json(runIdempotently(ctx, 'billing.refund', c.req.header('idempotency-key'),
      { paymentId, ...body }, () => transact(() => refundSafely({ ctx, paymentId, ...body })),
    ));
  },
);

const PlanBody = z.object({
  productId: z.string(),
  eligibilityApproved: z.boolean().default(false),
});

function loadMemberAndProduct(ctx: ReturnType<typeof ctxOf>, memberId: string, productId: string) {
  const member = loadMemberInScope(ctx, memberId);
  reconcileMembershipDates(memberId);

  const product = db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, ctx.tenantId)))
    .get();
  if (!product) throw notFound('That product');
  return { member, product };
}

billingStabilizationRoutes.post(
  '/members/:memberId/assign-plan',
  validate('json', PlanBody),
  (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'membership.manage');
    const memberId = c.req.param('memberId');
    const body = c.req.valid('json');
    const { member, product } = loadMemberAndProduct(ctx, memberId, body.productId);

    const result = transact(() =>
      createMembershipPurchase({
        ctx,
        member,
        product,
        previousMembershipId: null,
        eligibilityApproved: body.eligibilityApproved,
      }),
    );
    return c.json(result, 201);
  },
);

billingStabilizationRoutes.post(
  '/members/:memberId/renew',
  validate('json', PlanBody.partial().extend({ quoteToken: z.string().length(64) })),
  (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'membership.manage');
    const memberId = c.req.param('memberId');

    loadMemberInScope(ctx, memberId);
    const body = c.req.valid('json');
    const key = c.req.header('idempotency-key');
    if (!key?.trim() || key.length > 200) throw invalid('A bounded idempotency key is required for renewal.');
    const result = runIdempotently(ctx, 'membership.renew', key, { memberId, ...body }, () => transact(() => {
      const { member, product, previous, quote } = renewalQuote(ctx, memberId, body.productId);
      if (quote.quoteToken !== body.quoteToken) throw conflict('The member, terms, date or balance changed. Review a fresh renewal quote.');
      return createMembershipPurchase({ ctx, member, product, previousMembershipId: previous.id, eligibilityApproved: body.eligibilityApproved ?? false });
    }));
    return c.json(result, 201);
  },
);
billingStabilizationRoutes.get('/members/:memberId/renewal-quote', validate('query', z.object({ productId: z.string().optional() })), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'membership.manage');
  return c.json(renewalQuote(ctx, c.req.param('memberId'), c.req.valid('query').productId).quote);
});
