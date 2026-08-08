import { and, eq, sql } from 'drizzle-orm';
import type { Product } from '@shark/contracts';
import { channels } from '@shark/contracts';
import { canTransition, invoiceStateFor, totalsFor } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { addDays, isoDate, now } from '../lib/time.js';
import type { RequestContext } from '../lib/context.js';

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
  const issuedOn = isoDate(now(), 'Asia/Kolkata');
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
  /** Set only by the member checkout-intent confirm flow, whose payment row
   *  already exists in `created` state — this updates it in place instead of
   *  inserting a second row for the same attempt. */
  existingPaymentId?: string;
}

export interface ApplyPaymentResult {
  paymentId: string;
  invoiceState: string;
  membershipActivated: boolean;
  alreadyProcessed: boolean;
}

/**
 * Looked up before every payment write — a repeated idempotency key for an
 * already-*succeeded* payment returns the original outcome rather than
 * erroring or double-writing. Deliberately scoped to `state: 'succeeded'`:
 * the member checkout flow reuses its own payment row's id as its
 * idempotency key across the `created` → `succeeded` transition (see
 * `existingPaymentId` below), so a `created` row must NOT be treated as
 * "already processed" — that would make the very first confirm a no-op.
 */
export function findIdempotentPayment(tenantId: string, idempotencyKey: string) {
  return db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.tenantId, tenantId), eq(schema.payments.idempotencyKey, idempotencyKey), eq(schema.payments.state, 'succeeded')))
    .get();
}

/**
 * The one place a payment becomes money-on-the-invoice and, if that clears
 * the balance, activates a pending membership. Called from three places only:
 * admin manual recording, the member checkout confirm, and the demo webhook
 * simulator's "succeeded" branch — never from anywhere that hasn't itself
 * already verified the payment succeeded.
 */
export function applyPaymentToInvoice(input: ApplyPaymentInput): ApplyPaymentResult {
  const { ctx, invoiceId, amountMinor, method, provider, providerRef, idempotencyKey, recordedByName, note, existingPaymentId } = input;

  const existing = findIdempotentPayment(ctx.tenantId, idempotencyKey);
  if (existing) {
    const existingInvoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, existing.invoiceId!)).get()!;
    return { paymentId: existing.id, invoiceState: existingInvoice.state, membershipActivated: false, alreadyProcessed: true };
  }

  const invoice = db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, ctx.tenantId)))
    .get();
  if (!invoice) throw notFound('That invoice');
  if (['paid', 'void', 'refunded'].includes(invoice.state)) throw conflict('This invoice is already settled.');
  const dueMinor = invoice.totalMinor - invoice.paidMinor;
  if (amountMinor > dueMinor) throw invalid(`That is more than the amount outstanding (${dueMinor}).`);

  const paymentId = existingPaymentId ?? id('pay');
  const newPaidMinor = invoice.paidMinor + amountMinor;
  const newState = invoiceStateFor({
    totalMinor: invoice.totalMinor,
    paidMinor: newPaidMinor,
    refundedMinor: invoice.refundedMinor,
    dueOn: invoice.dueOn,
    today: isoDate(now(), 'Asia/Kolkata'),
    voided: invoice.voided,
  });

  let membershipActivated = false;

  if (existingPaymentId) {
    db.update(schema.payments)
      .set({ state: 'succeeded', settledAt: now(), providerRef })
      .where(and(eq(schema.payments.id, existingPaymentId), eq(schema.payments.tenantId, ctx.tenantId)))
      .run();
  } else {
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
        recordedById: ctx.role === 'member' ? null : ctx.userId,
        recordedByName,
        failureReason: null,
        note: note ?? null,
        createdAt: now(),
        settledAt: now(),
      })
      .run();
  }

  db.update(schema.invoices).set({ paidMinor: newPaidMinor, state: newState, updatedAt: now() }).where(eq(schema.invoices.id, invoiceId)).run();

  // Activation only when the invoice is fully settled — a partial payment
  // does not activate a membership someone is still paying off.
  if (invoice.refType === 'membership' && newState === 'paid') {
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
        actorRole: ctx.role === 'member' ? 'member' : 'staff',
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
            actorId: ctx.role === 'member' ? null : ctx.userId,
            actorName: recordedByName ?? 'Member',
            source: ctx.role === 'member' ? 'member' : 'staff',
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

  const payment = db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.id, paymentId), eq(schema.payments.tenantId, ctx.tenantId)))
    .get();
  if (!payment) throw notFound('That payment');
  if (payment.state !== 'succeeded') throw conflict('Only a succeeded payment can be refunded.');

  const priorRefunds = db
    .select({ total: sql<number>`coalesce(sum(${schema.refunds.amountMinor}), 0)` })
    .from(schema.refunds)
    .where(eq(schema.refunds.paymentId, paymentId))
    .get();
  const refundableMinor = payment.amountMinor - (priorRefunds?.total ?? 0);
  if (amountMinor > refundableMinor) throw invalid(`That is more than the refundable balance (${refundableMinor}).`);

  const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, payment.invoiceId ?? '')).get();
  if (!invoice) throw notFound('The invoice for that payment');

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
    today: isoDate(now(), 'Asia/Kolkata'),
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
  if (!invoice || !ctx.branchIds.includes(invoice.branchId)) throw notFound('That invoice');
  return invoice;
}
