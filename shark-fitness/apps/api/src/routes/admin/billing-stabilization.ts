import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RecordPaymentInput } from '@shark/contracts';
import { validate } from '../../middleware/validate.js';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requireBranch, requirePermission } from '../../lib/context.js';
import { conflict, notFound } from '../../lib/errors.js';
import {
  applyPaymentSafely,
  createMembershipPurchase,
  refundSafely,
  voidInvoiceSafely,
} from '../../services/billing-stabilization.js';

export const billingStabilizationRoutes = new Hono();

billingStabilizationRoutes.post(
  '/invoices/:invoiceId/payments',
  validate('json', RecordPaymentInput.omit({ invoiceId: true })),
  (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'billing.record_payment');
    const invoiceId = c.req.param('invoiceId');
    const body = c.req.valid('json');

    const invoice = db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, ctx.tenantId)))
      .get();
    if (!invoice || !ctx.branchIds.includes(invoice.branchId)) throw notFound('That invoice');

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
    return c.json(
      transact(() =>
        refundSafely({
          ctx,
          paymentId: c.req.param('paymentId'),
          amountMinor: body.amountMinor,
          reason: body.reason,
          entitlementReversed: body.entitlementReversed,
        }),
      ),
    );
  },
);

const PlanBody = z.object({ productId: z.string() });

function loadMemberAndProduct(ctx: ReturnType<typeof ctxOf>, memberId: string, productId: string) {
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) throw notFound('That member');
  requireBranch(ctx, member.homeBranchId);

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
    const { member, product } = loadMemberAndProduct(
      ctx,
      memberId,
      c.req.valid('json').productId,
    );

    const result = transact(() =>
      createMembershipPurchase({ ctx, member, product, previousMembershipId: null }),
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

    const member = db
      .select()
      .from(schema.members)
      .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId)))
      .get();
    if (!member) throw notFound('That member');
    requireBranch(ctx, member.homeBranchId);

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

    const productId = c.req.valid('json').productId ?? previous.productId;
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
      }),
    );
    return c.json(result, 201);
  },
);
