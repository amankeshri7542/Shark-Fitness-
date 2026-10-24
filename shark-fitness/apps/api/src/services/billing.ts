import { and, eq, sql } from 'drizzle-orm';
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

/** Must be called inside the transaction that inserts the invoice it numbers
 *  — this process is single-connection/synchronous (db/client.ts), so nothing
 *  else can read a stale max between this call and the insert that follows. */
export function nextInvoiceNumber(tenantId: string): string {
  const year = new Date(now()).getUTCFullYear();
  const row = db
    .select({ max: sql<number>`max(cast(substr(${schema.invoices.number}, -5) as integer))` })
    .from(schema.invoices)
    .where(eq(schema.invoices.tenantId, tenantId))
    .get();
  return `SF-${year}-${String((row?.max ?? 0) + 1).padStart(5, '0')}`;
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
 * No simulated provider or member confirmation may settle an invoice. */
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
      note: note ?? null,
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
      const transition = canTransition({
        from: 'pending_payment',
        to: 'active',
        reason: 'Payment received',
        actorRole: 'staff',
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
            reason: 'Payment received',
            actorId: ctx.userId,
            actorName: recordedByName ?? ctx.name,
            source: 'staff',
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
    action: 'payment.recorded',
    entityType: 'invoice',
    entityId: invoiceId,
    entityLabel: invoice.number,
    before: { paidMinor: invoice.paidMinor, state: invoice.state },
    after: { paidMinor: newPaidMinor, state: newState },
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
  const creditKinds = new Set(['class_pack', 'pt_credits']);
  const referencedProduct = invoice.refType === 'product' && invoice.refId ? db.select().from(schema.products).where(and(eq(schema.products.id, invoice.refId), eq(schema.products.tenantId, ctx.tenantId))).get() : undefined;
  const membership = invoice.refType === 'membership' && invoice.refId ? db.select().from(schema.memberships).where(and(eq(schema.memberships.id, invoice.refId), eq(schema.memberships.tenantId, ctx.tenantId))).get() : undefined;
  const productLines = db.select({ kind: schema.products.kind }).from(schema.invoiceLines).innerJoin(schema.products, eq(schema.products.id, schema.invoiceLines.productId)).where(and(eq(schema.invoiceLines.invoiceId, invoice.id), eq(schema.products.tenantId, ctx.tenantId))).all();
  if (['credits', 'credit_purchase', 'class_pack', 'pt_credits'].includes(invoice.refType ?? '') || (referencedProduct && creditKinds.has(referencedProduct.kind)) || (membership && creditKinds.has(membership.productSnapshot.kind)) || productLines.some((product) => creditKinds.has(product.kind))) {
    throw precondition('Credit-product refunds are unavailable until the gym approves allocation, consumed/expired-credit and cancellation rules. No money or credit units were changed.');
  }
  if (payment.state !== 'succeeded') throw conflict('Only a succeeded payment can be refunded.');

  const priorRefunds = db
    .select({ total: sql<number>`coalesce(sum(${schema.refunds.amountMinor}), 0)` })
    .from(schema.refunds)
    .where(eq(schema.refunds.paymentId, paymentId))
    .get();
  const refundableMinor = payment.amountMinor - (priorRefunds?.total ?? 0);
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
