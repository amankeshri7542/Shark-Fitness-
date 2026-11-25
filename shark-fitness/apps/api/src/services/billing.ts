import { and, eq, like, sql } from 'drizzle-orm';
import type { Product } from '@shark/contracts';
import { channels } from '@shark/contracts';
import { canTransition, invoiceStateFor, totalsFor } from '@shark/domain';
import { stopDunning } from './dunning.js';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { addDays, isoDate, now } from '../lib/time.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { FITNESS_SERVICE_CODE, recordTaxDocument } from './tax-invoice.js';

/** Must be called inside the transaction that inserts the invoice it numbers
 *  — this process is single-connection/synchronous (db/client.ts), so nothing
 *  else can read a stale max between this call and the insert that follows.
 *
 *  The prefix is the gym's own (`taxProfile.invoicePrefix`), "SF" when unset.
 *  Each prefix and year is its own series, `SF-2026-00001` onwards. A number
 *  is therefore unique within a financial year however often the prefix
 *  changes, and never more than 5 + 1 + 4 + 1 + 5 = 16 characters, the most a
 *  GST invoice number may be. A full series is refused in words: the old
 *  single counter read invoice 100000 back as 0 and then failed every insert
 *  on the unique index. */
export function nextInvoiceNumber(tenantId: string): string {
  const year = new Date(now()).getUTCFullYear();
  const tenant = db.select({ taxProfile: schema.tenants.taxProfile }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  const prefix = (tenant?.taxProfile as { invoicePrefix?: string } | null)?.invoicePrefix || 'SF';
  const series = `${prefix}-${year}-`;
  const row = db
    .select({ max: sql<number>`max(cast(substr(${schema.invoices.number}, ${series.length + 1}) as integer))` })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.tenantId, tenantId), like(schema.invoices.number, `${series}%`)))
    .get();
  const next = (row?.max ?? 0) + 1;
  if (next > 99_999) {
    throw conflict(`The invoice series ${series} is full. Change the invoice prefix in Settings to start a new one.`);
  }
  return `${series}${String(next).padStart(5, '0')}`;
}

export interface CreateInvoiceInput {
  ctx: RequestContext;
  memberId: string;
  branchId: string;
  product: Product;
  refType: string;
  refId: string;
}

/** Invoice + line snapshot for a product purchase. A zero-price product (a
 *  comped trial, say) is created already `paid` — there is nothing to
 *  collect, so there is nothing to gate activation on. */
export function createInvoiceForProduct(input: CreateInvoiceInput): { invoiceId: string; totalMinor: number; state: string } {
  const { ctx, memberId, branchId, product, refType, refId } = input;
  const totals = totalsFor([{ quantity: 1, unitMinor: product.priceMinor, taxRateBp: product.taxRateBp }]);
  const invoiceId = id('inv');
  // The branch that raised it, not the server and not a literal. An invoice
  // dated by the wrong zone is dated by the wrong *day* either side of
  // midnight, which moves its due date and its ageing with it.
  const issuedOn = isoDate(now(), branchTimeZone(ctx.tenantId, branchId));
  const dueOn = addDays(issuedOn, 7);
  const paidInFull = totals.totalMinor <= 0;
  const state = paidInFull ? 'paid' : 'open';

  db.insert(schema.invoices)
    .values({
      id: invoiceId,
      tenantId: ctx.tenantId,
      branchId,
      memberId,
      number: nextInvoiceNumber(ctx.tenantId),
      state,
      issuedOn,
      dueOn,
      currency: product.currency,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      paidMinor: paidInFull ? totals.totalMinor : 0,
      refundedMinor: 0,
      voided: false,
      voidReason: null,
      refType,
      refId,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  db.insert(schema.invoiceLines)
    .values({
      id: id('ivl'),
      tenantId: ctx.tenantId,
      invoiceId,
      description: product.name,
      quantity: 1,
      unitMinor: product.priceMinor,
      discountMinor: 0,
      taxRateBp: product.taxRateBp,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      productId: refType === 'membership' ? product.id : null,
    })
    .run();

  // Frozen with the invoice: the GSTIN, address and state it was raised under.
  recordTaxDocument(ctx.tenantId, invoiceId, FITNESS_SERVICE_CODE);

  emit({
    tenantId: ctx.tenantId,
    branchId,
    channel: channels.member(memberId),
    topic: 'invoice.updated',
    payload: { invoiceId, state },
  });

  return { invoiceId, totalMinor: totals.totalMinor, state };
}

export interface ApplyPaymentInput {
  ctx: RequestContext;
  invoiceId: string;
  amountMinor: number;
  method: string;
  provider: string | null;
  providerRef: string | null;
  idempotencyKey: string;
  recordedByName: string | null;
  note?: string;
}

export interface ApplyPaymentResult {
  paymentId: string;
  invoiceState: string;
  membershipActivated: boolean;
  alreadyProcessed: boolean;
}

/** Only succeeded, independently recorded payments qualify for a retry. */
export function findIdempotentPayment(tenantId: string, idempotencyKey: string) {
  return db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.tenantId, tenantId), eq(schema.payments.idempotencyKey, idempotencyKey), eq(schema.payments.state, 'succeeded')))
    .get();
}

/** Shared money boundary: authorized staff record independently received funds.
 * No simulated provider or member confirmation may settle an invoice. Provider
 * money arrives through services/payments/settlement.ts, which verifies it
 * with the provider and then uses the same `settleInvoicePayment` below. */
export function applyPaymentToInvoice(input: ApplyPaymentInput): ApplyPaymentResult {
  const { ctx, invoiceId, amountMinor, method, provider, providerRef, idempotencyKey, recordedByName, note } = input;

  requirePermission(ctx, 'billing.record_payment');
  if (provider !== null) throw precondition('Provider settlement is unavailable. Record independently received funds.');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw invalid('Enter a positive whole amount in minor units.');
  if (method === 'upi' && !providerRef?.trim()) throw invalid('A verified UPI transaction reference is required.');
  const invoice = loadInvoiceInScope(ctx, invoiceId);
  const existing = findIdempotentPayment(ctx.tenantId, idempotencyKey);
  if (existing) {
    if (existing.invoiceId !== invoiceId || existing.amountMinor !== amountMinor || existing.method !== method || existing.provider !== provider || existing.providerRef !== providerRef || existing.note !== (note ?? null)) {
      throw conflict('This idempotency key was already used for a different payment request.');
    }
    return { paymentId: existing.id, invoiceState: invoice.state, membershipActivated: false, alreadyProcessed: true };
  }

  if (invoice.voided || invoice.totalMinor <= invoice.paidMinor) throw conflict('This invoice is already settled.');
  const dueMinor = invoice.totalMinor - invoice.paidMinor;
  if (amountMinor > dueMinor) throw invalid(`That is more than the amount outstanding (${dueMinor}).`);

  return settleInvoicePayment({
    ctx, invoice, amountMinor, method, provider: null, providerRef, idempotencyKey, recordedByName, note: note ?? null, source: 'staff',
  });
}

export interface SettleInvoicePaymentInput {
  ctx: RequestContext;
  invoice: typeof schema.invoices.$inferSelect;
  amountMinor: number;
  method: string;
  provider: 'razorpay' | null;
  providerRef: string | null;
  idempotencyKey: string;
  recordedByName: string | null;
  note: string | null;
  /** Who vouches for the money: staff who received it, or a provider that
   *  confirmed it server-to-server. */
  source: 'staff' | 'provider';
}

/**
 * The single settlement path. Records the payment and its receipt, moves the
 * invoice, stops dunning, activates a membership waiting on this invoice, and
 * writes the audit row and realtime events — all in the caller's transaction.
 *
 * It trusts its caller completely: permission, scope, idempotency, provider
 * verification and "is this amount still due" are the caller's job, and both
 * callers (`applyPaymentToInvoice`, `settleProviderPayment`) do them first.
 */
export function settleInvoicePayment(input: SettleInvoicePaymentInput): ApplyPaymentResult {
  const { ctx, invoice, amountMinor, method, provider, providerRef, idempotencyKey, recordedByName, note, source } = input;
  const invoiceId = invoice.id;
  const paymentId = id('pay');
  const newPaidMinor = invoice.paidMinor + amountMinor;
  const newState = invoiceStateFor({
    totalMinor: invoice.totalMinor,
    paidMinor: newPaidMinor,
    refundedMinor: invoice.refundedMinor,
    dueOn: invoice.dueOn,
    // Whether an invoice is overdue is a question about the counter's
    // calendar, not the server's.
    today: isoDate(now(), branchTimeZone(ctx.tenantId, invoice.branchId)),
    voided: invoice.voided,
  });

  let membershipActivated = false;

  db.insert(schema.payments)
    .values({
      id: paymentId,
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      invoiceId,
      memberId: invoice.memberId,
      method,
      state: 'succeeded',
      amountMinor,
      currency: invoice.currency,
      provider,
      providerRef,
      idempotencyKey,
      recordedById: ctx.userId,
      recordedByName,
      failureReason: null,
      note,
      createdAt: now(),
      settledAt: now(),
    })
    .run();

  db.update(schema.invoices).set({ paidMinor: newPaidMinor, state: newState, updatedAt: now() }).where(eq(schema.invoices.id, invoiceId)).run();
  const issuer = db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get()!;
  const recipient = db.select().from(schema.members).where(and(eq(schema.members.id, invoice.memberId), eq(schema.members.tenantId, ctx.tenantId))).get()!;
  db.insert(schema.paymentReceipts).values({ paymentId, tenantId: ctx.tenantId, issuerName: issuer.legalName,
    memberName: `${recipient.firstName} ${recipient.lastName}`, memberNo: recipient.memberNo, createdAt: now() }).run();

  // Money arrived: stop chasing it. Without this a member who settles at the
  // desk still gets next week's reminder, because the dunning worker only
  // learns about the payment when it next reaches the step.
  if (newPaidMinor >= invoice.totalMinor) stopDunning(ctx.tenantId, invoiceId, 'recovered');

  // Activation only when the invoice is fully settled — a partial payment
  // does not activate a membership someone is still paying off.
  if (invoice.refType === 'membership' && newPaidMinor >= invoice.totalMinor) {
    const membership = db
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.memberId, invoice.memberId), eq(schema.memberships.id, invoice.refId ?? '')))
      .get();
    if (membership && membership.state === 'pending_payment') {
      const reason = source === 'provider' ? 'Payment received online' : 'Payment received';
      const transition = canTransition({
        from: 'pending_payment',
        to: 'active',
        reason,
        actorRole: source === 'provider' ? 'provider' : 'staff',
      });
      if (transition.ok) {
        db.update(schema.memberships)
          .set({ state: 'active', updatedAt: now(), version: membership.version + 1 })
          .where(eq(schema.memberships.id, membership.id))
          .run();
        db.insert(schema.membershipEvents)
          .values({
            id: id('mev'),
            tenantId: ctx.tenantId,
            membershipId: membership.id,
            fromState: 'pending_payment',
            toState: 'active',
            reason,
            actorId: ctx.userId,
            actorName: recordedByName ?? ctx.name,
            source: source === 'provider' ? 'provider' : 'staff',
            effectiveAt: now(),
          })
          .run();
        db.update(schema.members).set({ lifecycle: 'active', updatedAt: now() }).where(eq(schema.members.id, invoice.memberId)).run();
        membershipActivated = true;
        emit({
          tenantId: ctx.tenantId,
          branchId: invoice.branchId,
          channel: channels.member(invoice.memberId),
          topic: 'membership.state_changed',
          payload: { membershipId: membership.id, from: 'pending_payment', to: 'active' },
        });
      }
    }
  }

  audit(ctx, {
    action: source === 'provider' ? 'payment.settled_by_provider' : 'payment.recorded',
    entityType: 'invoice',
    entityId: invoiceId,
    entityLabel: invoice.number,
    before: { paidMinor: invoice.paidMinor, state: invoice.state },
    after: { paidMinor: newPaidMinor, state: newState, ...(provider ? { provider, providerRef } : {}) },
  });
  emit({
    tenantId: ctx.tenantId,
    branchId: invoice.branchId,
    channel: channels.member(invoice.memberId),
    topic: 'payment.succeeded',
    payload: { paymentId, invoiceId, amountMinor },
  });
  emit({
    tenantId: ctx.tenantId,
    branchId: invoice.branchId,
    channel: channels.member(invoice.memberId),
    topic: 'invoice.updated',
    payload: { invoiceId, state: newState },
  });

  return { paymentId, invoiceState: newState, membershipActivated, alreadyProcessed: false };
}

export interface ApplyRefundInput {
  ctx: RequestContext;
  paymentId: string;
  amountMinor: number;
  reason: string;
  entitlementReversed: boolean;
  actorName: string;
}

/** Reversing entitlements is a separate decision from refunding money
 *  (refunds.entitlementReversed) — this never touches membership/credit state
 *  itself, it only records that a caller asserted they handled it. */
export function applyRefund(input: ApplyRefundInput): { refundId: string; invoiceState: string } {
  const { ctx, paymentId, amountMinor, reason, entitlementReversed, actorName } = input;
  requirePermission(ctx, 'billing.refund');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw invalid('Refund amount must be a positive safe integer.');

  const payment = db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.id, paymentId), eq(schema.payments.tenantId, ctx.tenantId)))
    .get();
  if (!payment) throw notFound('That payment');
  const invoice = loadInvoiceInScope(ctx, payment.invoiceId ?? '');
  assertRefundableProduct(ctx, invoice);
  if (payment.state !== 'succeeded') throw conflict('Only a succeeded payment can be refunded.');

  const refundableMinor = refundableBalance(payment);
  if (amountMinor > refundableMinor) throw invalid(`That is more than the refundable balance (${refundableMinor}).`);

  const refundId = id('ref');
  db.insert(schema.refunds)
    .values({
      id: refundId,
      tenantId: ctx.tenantId,
      paymentId,
      amountMinor,
      reason,
      state: 'succeeded',
      entitlementReversed,
      actorName,
      createdAt: now(),
    })
    .run();

  const newRefundedMinor = invoice.refundedMinor + amountMinor;
  const newState = invoiceStateFor({
    totalMinor: invoice.totalMinor,
    paidMinor: invoice.paidMinor,
    refundedMinor: newRefundedMinor,
    dueOn: invoice.dueOn,
    today: isoDate(now(), branchTimeZone(ctx.tenantId, invoice.branchId)),
    voided: invoice.voided,
  });

  db.update(schema.invoices).set({ refundedMinor: newRefundedMinor, state: newState, updatedAt: now() }).where(eq(schema.invoices.id, invoice.id)).run();

  audit(ctx, {
    action: 'payment.refunded',
    entityType: 'invoice',
    entityId: invoice.id,
    entityLabel: invoice.number,
    reason,
    before: { refundedMinor: invoice.refundedMinor, state: invoice.state },
    after: { refundedMinor: newRefundedMinor, state: newState },
  });
  emit({
    tenantId: ctx.tenantId,
    branchId: invoice.branchId,
    channel: channels.member(invoice.memberId),
    topic: 'invoice.updated',
    payload: { invoiceId: invoice.id, state: newState },
  });

  return { refundId, invoiceState: newState };
}

/** Credit products are refused until the gym approves a refund policy for
 *  them (PHASE-PLAN decision 11 lands in P05). Shared by the manual and the
 *  provider refund paths. */
export function assertRefundableProduct(ctx: { tenantId: string }, invoice: typeof schema.invoices.$inferSelect): void {
  const creditKinds = new Set(['class_pack', 'pt_credits']);
  const referencedProduct = invoice.refType === 'product' && invoice.refId ? db.select().from(schema.products).where(and(eq(schema.products.id, invoice.refId), eq(schema.products.tenantId, ctx.tenantId))).get() : undefined;
  const membership = invoice.refType === 'membership' && invoice.refId ? db.select().from(schema.memberships).where(and(eq(schema.memberships.id, invoice.refId), eq(schema.memberships.tenantId, ctx.tenantId))).get() : undefined;
  const productLines = db.select({ kind: schema.products.kind }).from(schema.invoiceLines).innerJoin(schema.products, eq(schema.products.id, schema.invoiceLines.productId)).where(and(eq(schema.invoiceLines.invoiceId, invoice.id), eq(schema.products.tenantId, ctx.tenantId))).all();
  if (['credits', 'credit_purchase', 'class_pack', 'pt_credits'].includes(invoice.refType ?? '') || (referencedProduct && creditKinds.has(referencedProduct.kind)) || (membership && creditKinds.has(membership.productSnapshot.kind)) || productLines.some((product) => creditKinds.has(product.kind))) {
    throw precondition('Credit-product refunds are unavailable until the gym approves allocation, consumed/expired-credit and cancellation rules. No money or credit units were changed.');
  }
}

/** Captured minus everything already refunded or still being refunded. A
 *  failed provider refund gives its amount back. */
export function refundableBalance(payment: { id: string; amountMinor: number }): number {
  const prior = db
    .select({ total: sql<number>`coalesce(sum(${schema.refunds.amountMinor}), 0)` })
    .from(schema.refunds)
    .where(and(eq(schema.refunds.paymentId, payment.id), sql`${schema.refunds.state} != 'failed'`))
    .get();
  return payment.amountMinor - (prior?.total ?? 0);
}

/** Same branch-scope-hides-existence pattern as services/leads.ts's
 *  loadLeadInScope — an invoice in a branch the caller can't see 404s exactly
 *  like one that doesn't exist. */
export function loadInvoiceInScope(ctx: { tenantId: string; branchIds: string[] }, invoiceId: string): typeof schema.invoices.$inferSelect {
  const invoice = db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, ctx.tenantId)))
    .get();
  if (!invoice || !branchScope(ctx).includes(invoice.branchId)) throw notFound('That invoice');
  return invoice;
}
