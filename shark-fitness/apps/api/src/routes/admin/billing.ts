import { Hono } from 'hono';
import { taxDocumentKind } from '../../services/tax-invoice.js';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { BillingCadence, ProductKind } from '@shark/contracts';
import { can, formatMoney, planSoldAt } from '@shark/domain';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import type { RequestContext } from '../../lib/context.js';
import { branchScope, requirePermission } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { invalid, notFound, precondition } from '../../lib/errors.js';
import { id } from '../../lib/ids.js';
import { DAY, now } from '../../lib/time.js';
import { loadInvoiceInScope } from '../../services/billing.js';
import { dunningForInvoice } from '../../services/dunning.js';
import { resolvePaymentProvider } from '../../lib/payment-provider.js';
import { invoicePaymentLinks } from '../../services/payments/payment-links.js';

export const billingRoutes = new Hono();

/* — Products (Plans catalogue, UX-A06) ————————————————————————— */

const AccessRulesBody = z.object({
  allBranches: z.boolean(),
  branchIds: z.array(z.string().min(1)),
  windowStartMin: z.number().int().nullable(),
  windowEndMin: z.number().int().nullable(),
  visitsPerWeek: z.number().int().nullable(),
  guestPassesPerMonth: z.number().int(),
  classPriorityTier: z.number().int(),
  bookingWindowHours: z.number().int(),
});

const FreezeRulesBody = z.object({
  allowed: z.boolean(),
  maxDaysPerTerm: z.number().int(),
  minDaysPerFreeze: z.number().int(),
  extendsExpiry: z.boolean(),
  feeMinor: z.number().int().min(0),
});

const CancellationPolicyBody = z.object({
  noticeDays: z.number().int(),
  commitmentMonths: z.number().int(),
  earlyExitFeeMinor: z.number().int().min(0),
  refundable: z.boolean(),
  description: z.string(),
});

const ProductBody = z.object({
  kind: ProductKind,
  name: z.string().min(1),
  description: z.string().default(''),
  priceMinor: z.number().int().min(0),
  currency: z.string().length(3).default('INR'),
  taxRateBp: z.number().int().min(0).default(1800),
  cadence: BillingCadence,
  durationDays: z.number().int().nullable().default(null),
  credits: z.number().int().nullable().default(null),
  creditsExpireDays: z.number().int().nullable().default(null),
  access: AccessRulesBody,
  freeze: FreezeRulesBody,
  cancellation: CancellationPolicyBody,
  eligibility: z
    .object({ minAge: z.number().int().nullable(), maxAge: z.number().int().nullable(), corporateOnly: z.boolean(), requiresApproval: z.boolean() })
    .default({ minAge: null, maxAge: null, corporateOnly: false, requiresApproval: false }),
  branchIds: z.array(z.string().min(1)).optional(),
});

type CatalogueAccess = z.infer<typeof AccessRulesBody>;

function sameBranchIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((branchId) => right.includes(branchId));
}

/** Validate both copies of catalogue branch access and return one canonical
 * representation. `products.branchIds` is retained for the frozen Product
 * contract, but access rules are the source of truth used by eligibility. */
function catalogueBranchAccess(
  ctx: RequestContext,
  access: CatalogueAccess,
  suppliedBranchIds?: string[],
): { access: CatalogueAccess; branchIds: string[] } {
  const accessBranchIds = [...new Set(access.branchIds)];
  if (accessBranchIds.length !== access.branchIds.length) {
    throw invalid('Choose each catalogue branch once.');
  }
  if (access.allBranches && accessBranchIds.length > 0) {
    throw invalid('An all-branches product must not also list individual branches.');
  }

  const canonicalBranchIds = access.allBranches ? [] : accessBranchIds;
  if (suppliedBranchIds !== undefined) {
    const uniqueSupplied = [...new Set(suppliedBranchIds)];
    if (uniqueSupplied.length !== suppliedBranchIds.length || !sameBranchIds(uniqueSupplied, canonicalBranchIds)) {
      throw invalid('Product branchIds must match its access rules.');
    }
  }

  const tenantBranches = db
    .select({ id: schema.branches.id, state: schema.branches.state })
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, ctx.tenantId))
    .all();
  const activeTenantBranchIds = tenantBranches.filter((branch) => branch.state !== 'archived').map((branch) => branch.id);
  const requestScope = branchScope(ctx);

  if (access.allBranches) {
    if (!activeTenantBranchIds.every((branchId) => requestScope.includes(branchId))) {
      throw invalid('All-branches access is outside the branches in this request.');
    }
  } else {
    const validTenantBranchIds = new Set(activeTenantBranchIds);
    if (!canonicalBranchIds.every((branchId) => validTenantBranchIds.has(branchId))) {
      throw invalid('Choose active branches from this tenant.');
    }
    if (!canonicalBranchIds.every((branchId) => requestScope.includes(branchId))) {
      throw invalid('Choose branches within this request scope.');
    }
  }

  return { access: { ...access, branchIds: canonicalBranchIds }, branchIds: canonicalBranchIds };
}

billingRoutes.get('/products', (c) => {
  const ctx = ctxOf(c);
  const canManage = can(ctx.role, 'product.manage');
  if (!canManage) requirePermission(ctx, 'membership.manage');
  const scope = branchScope(ctx);
  const rows = db.select().from(schema.products).where(and(
    eq(schema.products.tenantId, ctx.tenantId),
    canManage ? undefined : eq(schema.products.status, 'active'),
  )).orderBy(desc(schema.products.updatedAt)).all().filter((p) =>
    canManage || (scope.length > 0 && scope.some((branchId) => planSoldAt(p.access, branchId))),
  );
  return c.json({
    items: rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      description: p.description,
      version: p.version,
      priceMinor: p.priceMinor,
      priceLabel: formatMoney(p.priceMinor, p.currency),
      currency: p.currency,
      taxRateBp: p.taxRateBp,
      cadence: p.cadence,
      durationDays: p.durationDays,
      credits: p.credits,
      access: p.access,
      freeze: p.freeze,
      cancellation: p.cancellation,
      eligibility: p.eligibility,
      branchIds: p.branchIds,
      status: p.status,
      public: p.isPublic,
    })),
  });
});

billingRoutes.post('/products', validate('json', ProductBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'product.manage');
  const body = c.req.valid('json');
  const productId = id('prd');
  const normalizedAccess = catalogueBranchAccess(ctx, body.access, body.branchIds);

  db.insert(schema.products)
    .values({
      id: productId,
      tenantId: ctx.tenantId,
      kind: body.kind,
      name: body.name,
      description: body.description,
      version: 1,
      priceMinor: body.priceMinor,
      currency: body.currency,
      taxRateBp: body.taxRateBp,
      cadence: body.cadence,
      durationDays: body.durationDays,
      credits: body.credits,
      creditsExpireDays: body.creditsExpireDays,
      access: normalizedAccess.access,
      freeze: body.freeze,
      cancellation: body.cancellation,
      eligibility: body.eligibility,
      branchIds: normalizedAccess.branchIds,
      status: 'draft',
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  audit(ctx, { action: 'product.created', entityType: 'product', entityId: productId, entityLabel: body.name });
  return c.json({ id: productId }, 201);
});

const ProductEditBody = ProductBody.partial().extend({ status: z.enum(['draft', 'active', 'retired']).optional() });

billingRoutes.patch('/products/:productId', validate('json', ProductEditBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'product.manage');
  const productId = c.req.param('productId');
  const body = c.req.valid('json');

  const product = db.select().from(schema.products).where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, ctx.tenantId))).get();
  if (!product) throw notFound('That product');
  const normalizedAccess =
    body.access !== undefined || body.branchIds !== undefined
      ? catalogueBranchAccess(ctx, body.access ?? product.access, body.branchIds)
      : null;

  // Editing published terms bumps the version — memberships already sold
  // keep their frozen productSnapshot regardless (PF-CAT-003); this only
  // affects what a *future* purchase sees.
  const bumpsVersion = product.status === 'active';

  db.update(schema.products)
    .set({
      ...body,
      ...(normalizedAccess ? { access: normalizedAccess.access, branchIds: normalizedAccess.branchIds } : {}),
      version: bumpsVersion ? product.version + 1 : product.version,
      updatedAt: now(),
    })
    .where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, ctx.tenantId)))
    .run();

  audit(ctx, { action: 'product.updated', entityType: 'product', entityId: productId, entityLabel: product.name, before: { status: product.status }, after: { status: body.status ?? product.status } });
  return c.json({ ok: true });
});

billingRoutes.post('/products/:productId/retire', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'product.manage');
  const productId = c.req.param('productId');

  const product = db.select().from(schema.products).where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, ctx.tenantId))).get();
  if (!product) throw notFound('That product');

  const activeMembershipCount = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.productId, productId), sql`${schema.memberships.state} in ('active','pending_payment','frozen','grace')`))
    .get()?.n ?? 0;

  db.update(schema.products).set({ status: 'retired', updatedAt: now() }).where(eq(schema.products.id, productId)).run();
  audit(ctx, { action: 'product.retired', entityType: 'product', entityId: productId, entityLabel: product.name, after: { activeMembershipCount } });

  return c.json({ ok: true, activeMembershipCount });
});

billingRoutes.post('/products/:productId/duplicate', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'product.manage');
  const productId = c.req.param('productId');

  const product = db.select().from(schema.products).where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, ctx.tenantId))).get();
  if (!product) throw notFound('That product');

  const newId = id('prd');
  db.insert(schema.products)
    .values({
      id: newId,
      tenantId: ctx.tenantId,
      kind: product.kind,
      name: `${product.name} (copy)`,
      description: product.description,
      version: 1,
      priceMinor: product.priceMinor,
      currency: product.currency,
      taxRateBp: product.taxRateBp,
      cadence: product.cadence,
      durationDays: product.durationDays,
      credits: product.credits,
      creditsExpireDays: product.creditsExpireDays,
      access: product.access,
      freeze: product.freeze,
      cancellation: product.cancellation,
      eligibility: product.eligibility,
      branchIds: product.branchIds,
      status: 'draft',
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  audit(ctx, { action: 'product.duplicated', entityType: 'product', entityId: newId, entityLabel: `${product.name} (copy)` });
  return c.json({ id: newId }, 201);
});

/* — Billing dashboard ——————————————————————————————————————————— */

billingRoutes.get('/summary', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'billing.view');
  const scope = branchScope(ctx);
  const monthStart = new Date(now());
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  // Revenue is report.financial's, as it is on Reports and the dashboard:
  // reception and a branch manager work the balances, not the takings. The
  // figure is withheld as absent, never as zero.
  const canSeeRevenue = can(ctx.role, 'report.financial');
  const revenueThisMonth = canSeeRevenue
    ? db
        .select({ total: sql<number>`coalesce(sum(${schema.payments.amountMinor}), 0)` })
        .from(schema.payments)
        .where(and(eq(schema.payments.tenantId, ctx.tenantId), inArray(schema.payments.branchId, scope), eq(schema.payments.state, 'succeeded'), gte(schema.payments.createdAt, monthStart.getTime())))
        .get()
    : null;

  const outstanding = db
    .select({ total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}), 0)`, count: sql<number>`count(*)` })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.tenantId, ctx.tenantId), inArray(schema.invoices.branchId, scope), sql`${schema.invoices.voided} = 0 and ${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`))
    .get();

  const overdueCount = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.tenantId, ctx.tenantId), inArray(schema.invoices.branchId, scope), eq(schema.invoices.state, 'overdue')))
    .get()?.n ?? 0;

  const failedPaymentCount = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.payments)
    .where(and(eq(schema.payments.tenantId, ctx.tenantId), inArray(schema.payments.branchId, scope), eq(schema.payments.state, 'failed'), gte(schema.payments.createdAt, now() - 30 * DAY)))
    .get()?.n ?? 0;

  return c.json({
    revenueThisMonthMinor: revenueThisMonth ? revenueThisMonth.total : null,
    revenueThisMonthLabel: revenueThisMonth ? formatMoney(revenueThisMonth.total, 'INR') : null,
    restricted: canSeeRevenue ? [] : ['revenueThisMonth'],
    outstandingMinor: outstanding?.total ?? 0,
    outstandingLabel: formatMoney(outstanding?.total ?? 0, 'INR'),
    outstandingInvoiceCount: outstanding?.count ?? 0,
    overdueCount,
    failedPaymentCount,
  });
});

const InvoiceListQuery = z.object({
  state: z.enum(['outstanding', 'open', 'partially_paid', 'overdue', 'paid', 'void', 'partially_refunded', 'refunded']).optional(),
  memberId: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

billingRoutes.get('/invoices', validate('query', InvoiceListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'billing.view');
  const q = c.req.valid('query');
  const scope = branchScope(ctx);

  const filters = [eq(schema.invoices.tenantId, ctx.tenantId), inArray(schema.invoices.branchId, scope)];
  if (q.state === 'outstanding') filters.push(sql`${schema.invoices.voided} = 0 and ${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`);
  else if (q.state) filters.push(eq(schema.invoices.state, q.state));
  if (q.memberId) filters.push(eq(schema.invoices.memberId, q.memberId));

  const rows = db
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      state: schema.invoices.state,
      issuedOn: schema.invoices.issuedOn,
      dueOn: schema.invoices.dueOn,
      currency: schema.invoices.currency,
      totalMinor: schema.invoices.totalMinor,
      paidMinor: schema.invoices.paidMinor,
      refundedMinor: schema.invoices.refundedMinor,
      memberId: schema.invoices.memberId,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      memberNo: schema.members.memberNo,
    })
    .from(schema.invoices)
    .innerJoin(schema.members, eq(schema.members.id, schema.invoices.memberId))
    .where(and(...filters))
    .orderBy(desc(schema.invoices.issuedOn))
    .all();

  const withNames = q.q
    ? rows.filter((r) => {
        const term = q.q!.toLowerCase();
        return `${r.firstName} ${r.lastName}`.toLowerCase().includes(term) || r.number.toLowerCase().includes(term) || r.memberNo.toLowerCase().includes(term);
      })
    : rows;

  const total = withNames.length;
  const items = withNames.slice(q.offset, q.offset + q.limit).map((r) => ({
    id: r.id,
    number: r.number,
    state: r.state,
    issuedOn: r.issuedOn,
    dueOn: r.dueOn,
    memberId: r.memberId,
    memberName: `${r.firstName} ${r.lastName}`,
    memberNo: r.memberNo,
    totalLabel: formatMoney(r.totalMinor, r.currency),
    dueMinor: r.state === 'void' ? 0 : Math.max(0, r.totalMinor - r.paidMinor),
    dueLabel: formatMoney(r.state === 'void' ? 0 : Math.max(0, r.totalMinor - r.paidMinor), r.currency),
  }));

  return c.json({ total, items, hasMore: q.offset + items.length < total, limit: q.limit, offset: q.offset });
});

billingRoutes.get('/invoices/:invoiceId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'billing.view');
  const invoiceId = c.req.param('invoiceId');
  const invoice = loadInvoiceInScope(ctx, invoiceId);

  const member = db.select({ firstName: schema.members.firstName, lastName: schema.members.lastName, memberNo: schema.members.memberNo }).from(schema.members).where(eq(schema.members.id, invoice.memberId)).get();
  const lines = db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)).all();
  const payments = db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)).orderBy(desc(schema.payments.createdAt)).all();
  const paymentIds = payments.map((p) => p.id);
  const refunds = paymentIds.length ? db.select().from(schema.refunds).where(inArray(schema.refunds.paymentId, paymentIds)).all() : [];
  const dunning = db.select().from(schema.dunningAttempts).where(eq(schema.dunningAttempts.invoiceId, invoiceId)).orderBy(schema.dunningAttempts.attempt).all();
  const intents = db.select().from(schema.paymentIntents).where(and(eq(schema.paymentIntents.tenantId, ctx.tenantId), eq(schema.paymentIntents.invoiceId, invoiceId))).orderBy(desc(schema.paymentIntents.createdAt)).all();
  const events = intents.length
    ? db.select().from(schema.providerEvents).where(inArray(schema.providerEvents.intentId, intents.map((intent) => intent.id))).orderBy(desc(schema.providerEvents.receivedAt)).limit(50).all()
    : [];
  const exceptions = db.select().from(schema.paymentReconciliationExceptions).where(and(eq(schema.paymentReconciliationExceptions.tenantId, ctx.tenantId), eq(schema.paymentReconciliationExceptions.invoiceId, invoiceId))).all();
  const refundedByPayment = new Map<string, number>();
  for (const r of refunds) if (r.state !== 'failed') refundedByPayment.set(r.paymentId, (refundedByPayment.get(r.paymentId) ?? 0) + r.amountMinor);

  return c.json({
    invoice: {
      id: invoice.id,
      number: invoice.number,
      state: invoice.state,
      issuedOn: invoice.issuedOn,
      dueOn: invoice.dueOn,
      currency: invoice.currency,
      subtotalLabel: formatMoney(invoice.subtotalMinor, invoice.currency),
      taxLabel: formatMoney(invoice.taxMinor, invoice.currency),
      totalLabel: formatMoney(invoice.totalMinor, invoice.currency),
      paidLabel: formatMoney(invoice.paidMinor, invoice.currency),
      refundedLabel: formatMoney(invoice.refundedMinor, invoice.currency),
      dueMinor: invoice.voided ? 0 : Math.max(0, invoice.totalMinor - invoice.paidMinor),
      dueLabel: formatMoney(invoice.voided ? 0 : Math.max(0, invoice.totalMinor - invoice.paidMinor), invoice.currency),
      voided: invoice.voided,
      voidReason: invoice.voidReason,
      memberId: invoice.memberId,
      memberName: member ? `${member.firstName} ${member.lastName}` : '',
      memberNo: member?.memberNo ?? '',
      /** Whether the printable document is a GST tax invoice or a plain invoice. */
      document: taxDocumentKind(ctx.tenantId, invoice),
    },
    lines: lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity, unitLabel: formatMoney(l.unitMinor, invoice.currency), taxLabel: formatMoney(l.taxMinor, invoice.currency), totalLabel: formatMoney(l.totalMinor, invoice.currency) })),
    payments: payments.map((p) => {
      const refundableMinor = p.state === 'succeeded' ? Math.max(0, p.amountMinor - (refundedByPayment.get(p.id) ?? 0)) : 0;
      return { id: p.id, method: p.method, state: p.state, amountMinor: p.amountMinor, amountLabel: formatMoney(p.amountMinor, p.currency), provider: p.provider,
        /** Razorpay's payment id (pay_…) for online payments; the UPI/card reference staff typed for manual ones. */
        providerRef: p.providerRef, refundableMinor, refundableLabel: formatMoney(refundableMinor, p.currency),
        failureReason: p.failureReason, recordedByName: p.recordedByName, createdAt: new Date(p.createdAt).toISOString() };
    }),
    refunds: refunds.map((r) => ({ id: r.id, paymentId: r.paymentId, amountLabel: formatMoney(r.amountMinor, invoice.currency), reason: r.reason, entitlementReversed: r.entitlementReversed, actorName: r.actorName, createdAt: new Date(r.createdAt).toISOString(),
      /** succeeded | pending (with Razorpay) | failed (amount is refundable again). */
      state: r.state, provider: r.provider, providerRefundId: r.providerRefundId, failureReason: r.failureReason })),
    /** Online payment attempts (Checkout and payment links), newest first. */
    attempts: intents.map((i) => ({ id: i.id, channel: i.channel, purpose: i.purpose, state: i.state, amountLabel: formatMoney(i.amountMinor, i.currency),
      providerOrderId: i.providerOrderId, providerPaymentId: i.providerPaymentId, providerLinkId: i.providerLinkId, linkUrl: i.linkUrl,
      expiresAt: i.expiresAt ? new Date(i.expiresAt).toISOString() : null, failureReason: i.failureReason ?? i.failureCode, createdByName: i.createdByName,
      createdAt: new Date(i.createdAt).toISOString(), updatedAt: new Date(i.updatedAt).toISOString(), settledAt: i.settledAt ? new Date(i.settledAt).toISOString() : null })),
    /** Signed provider events routed to those attempts. */
    events: events.map((e) => ({ id: e.id, type: e.type, intentId: e.intentId, receivedAt: new Date(e.receivedAt).toISOString(), processedAt: e.processedAt ? new Date(e.processedAt).toISOString() : null, note: e.processingError })),
    paymentLinks: invoicePaymentLinks(ctx.tenantId, invoiceId),
    reconciliation: exceptions.map((x) => ({ id: x.id, kind: x.kind, state: x.state, detail: x.detail })),
    onlinePayment: { available: resolvePaymentProvider() !== null },
    dunning: dunning.map((d) => ({ id: d.id, attempt: d.attempt, channel: d.channel, state: d.state, scheduledFor: new Date(d.scheduledFor).toISOString() })),
  });
});

// Historical provider/payment rows remain readable; simulation cannot mutate them.
billingRoutes.post('/webhooks/demo', () => {
  throw precondition('Payment simulation is unavailable. Record only independently received funds at reception.');
});

/** The dunning state of one invoice, including — stated rather than implied —
 *  that no automatic retry is possible. */
billingRoutes.get('/invoices/:invoiceId/dunning', (c) =>
  c.json(dunningForInvoice(ctxOf(c), c.req.param('invoiceId'))),
);

billingRoutes.get('/dunning', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'billing.view');
  const scope = branchScope(ctx);

  const rows = db
    .select({
      invoiceId: schema.invoices.id,
      number: schema.invoices.number,
      state: schema.invoices.state,
      dueMinor: sql<number>`${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}`,
      currency: schema.invoices.currency,
      memberId: schema.invoices.memberId,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
    })
    .from(schema.invoices)
    .innerJoin(schema.members, eq(schema.members.id, schema.invoices.memberId))
    .where(and(eq(schema.invoices.tenantId, ctx.tenantId), inArray(schema.invoices.branchId, scope), sql`${schema.invoices.state} in ('open','overdue','partially_paid')`))
    .all();

  const invoiceIds = rows.map((r) => r.invoiceId);
  const attempts = invoiceIds.length ? db.select().from(schema.dunningAttempts).where(inArray(schema.dunningAttempts.invoiceId, invoiceIds)).all() : [];

  return c.json({
    items: rows
      .filter((r) => attempts.some((a) => a.invoiceId === r.invoiceId))
      .map((r) => ({
        invoiceId: r.invoiceId,
        number: r.number,
        state: r.state,
        dueLabel: formatMoney(r.dueMinor, r.currency),
        memberId: r.memberId,
        memberName: `${r.firstName} ${r.lastName}`,
        attempts: attempts.filter((a) => a.invoiceId === r.invoiceId).map((a) => ({ attempt: a.attempt, channel: a.channel, state: a.state })),
      })),
  });
});
