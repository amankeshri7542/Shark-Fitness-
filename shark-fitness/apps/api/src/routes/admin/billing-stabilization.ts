import { runIdempotently } from '../../lib/idempotency.js';
import { reconcileMembershipDates } from '../../services/membership-dates.js';
import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { formatMoney } from '@shark/domain';
import { RecordPaymentInput } from '@shark/contracts';
import { validate } from '../../middleware/validate.js';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requirePermission } from '../../lib/context.js';
import { conflict, invalid, notFound } from '../../lib/errors.js';
import {
  applyPaymentSafely,
  refundSafely,
  voidInvoiceSafely,
} from '../../services/billing-stabilization.js';
import { createMembershipPurchase } from '../../services/billing-membership.js';
import { loadInvoiceInScope } from '../../services/billing.js';
import { loadMemberInScope } from '../../services/members.js';

export const billingStabilizationRoutes = new Hono();

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
  const payment = db.select().from(schema.payments).where(and(
    eq(schema.payments.id, c.req.param('paymentId')), eq(schema.payments.tenantId, ctx.tenantId),
  )).get();
  if (!payment?.invoiceId) throw notFound('That payment');
  const invoice = loadInvoiceInScope(ctx, payment.invoiceId);
  if (payment.state !== 'succeeded') throw conflict('A receipt is available only for a successful payment.');
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get()!;
  const member = loadMemberInScope(ctx, payment.memberId);
  const refunds = db.select().from(schema.refunds).where(and(
    eq(schema.refunds.tenantId, ctx.tenantId), eq(schema.refunds.paymentId, payment.id), eq(schema.refunds.state, 'succeeded'),
  )).all();
  const refunded = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
  const clean = (value: string) => value.replace(/[\r\n\t]/g, ' ');
  const content = [
    'PAYMENT RECEIPT — recorded payment, not a tax invoice',
    `Receipt: ${payment.id}`,
    `Gym: ${clean(tenant.legalName)}`,
    `Member: ${clean(`${member.firstName} ${member.lastName}`)} (${member.memberNo})`,
    `Invoice: ${invoice.number}`,
    `Payment date (UTC): ${new Date(payment.settledAt ?? payment.createdAt).toISOString()}`,
    `Method: ${payment.method}`,
    `Amount: ${formatMoney(payment.amountMinor, payment.currency)}`,
    `Reference: ${clean(payment.providerRef ?? 'Not provided')}`,
    `Recorded by: ${clean(payment.recordedByName ?? payment.provider ?? 'System')}`,
    `Refunded: ${formatMoney(refunded, payment.currency)}`,
    `Net received: ${formatMoney(payment.amountMinor - refunded, payment.currency)}`,
    ...refunds.map((refund) => `Refund ${refund.id}: ${formatMoney(refund.amountMinor, payment.currency)} — ${clean(refund.reason)}`),
    '',
    'This receipt records the gym ledger. It does not independently verify bank settlement.',
  ].join('\n');
  c.header('Content-Disposition', `attachment; filename="receipt-${payment.id.replace(/[^a-zA-Z0-9_-]/g, '')}.txt"`);
  c.header('Cache-Control', 'no-store');
  return c.text(content);
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
  (c) => {
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
  validate('json', PlanBody.partial()),
  (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'membership.manage');
    const memberId = c.req.param('memberId');

    const member = loadMemberInScope(ctx, memberId);
    reconcileMembershipDates(memberId);

    const previous = db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.memberId, memberId),
          sql`${schema.memberships.state} in ('cancelled','expired')`,
        ),
      )
      .orderBy(desc(schema.memberships.updatedAt))
      .get();
    if (!previous) {
      throw conflict('Only an expired or cancelled membership can be renewed through this endpoint.');
    }

    const body = c.req.valid('json');
    const productId = body.productId ?? previous.productId;
    const product = db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, ctx.tenantId)))
      .get();
    if (!product) throw notFound('That product');

    const result = transact(() =>
      createMembershipPurchase({
        ctx,
        member,
        product,
        previousMembershipId: previous.id,
        eligibilityApproved: body.eligibilityApproved ?? false,
      }),
    );
    return c.json(result, 201);
  },
);
