import { and, eq, inArray } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import type { RequestContext } from '../../lib/context.js';
import { emit } from '../../lib/events.js';
import { id } from '../../lib/ids.js';
import { log } from '../../lib/observability.js';
import type { ProviderPayment } from '../../lib/payment-provider.js';
import { now } from '../../lib/time.js';
import { settleInvoicePayment } from '../billing.js';
import { emitIntegrationEvent } from '../integration-events.js';
import { notifyPaymentOutcome } from '../notifications.js';

export type IntentRow = typeof schema.paymentIntents.$inferSelect;
export type IntentState = 'created' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'superseded' | 'needs_review';

/** Intents that may still turn into money. */
export const LIVE_INTENT_STATES: IntentState[] = ['created', 'processing', 'failed'];

export const SYSTEM_ACTOR_ID = 'system:razorpay';

/**
 * The actor for anything Razorpay tells us. Audit rows need one, and inventing
 * a user would put a person's name on something they did not do (the same
 * reasoning as the dunning scheduler's context).
 */
export function razorpayContext(tenantId: string, branchId: string | null): RequestContext {
  return {
    requestId: `razorpay:${id('req')}`,
    sessionId: 'system',
    authMethod: 'bearer',
    tenantId,
    userId: SYSTEM_ACTOR_ID,
    memberId: null,
    staffId: null,
    role: 'platform_admin',
    name: 'Razorpay',
    branchIds: branchId ? [branchId] : [],
    activeBranchId: branchId,
    permissions: [],
    ip: '127.0.0.1',
    userAgent: 'razorpay',
    impersonatorId: null,
  };
}

export type ExceptionKind =
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'invoice_already_settled'
  | 'unmatched_payment'
  | 'refund_outside_console';

/**
 * Record something that must not be settled automatically. One row per
 * provider object and kind (`dedupeKey`), so a webhook retry, the confirm call
 * and the reconciliation job all land on the same exception. Must run inside
 * a transaction.
 */
export function openReconciliationException(input: {
  tenantId: string;
  branchId: string | null;
  invoiceId: string | null;
  intentId: string | null;
  kind: ExceptionKind;
  providerPaymentId?: string | null;
  providerRefundId?: string | null;
  expectedMinor?: number | null;
  receivedMinor?: number | null;
  currency?: string | null;
  detail: string;
}): { exceptionId: string; created: boolean } {
  const dedupeKey = `${input.kind}:${input.providerRefundId ?? input.providerPaymentId ?? input.intentId ?? input.invoiceId}`;
  const existing = db
    .select({ id: schema.paymentReconciliationExceptions.id })
    .from(schema.paymentReconciliationExceptions)
    .where(and(eq(schema.paymentReconciliationExceptions.tenantId, input.tenantId), eq(schema.paymentReconciliationExceptions.dedupeKey, dedupeKey)))
    .get();
  if (existing) return { exceptionId: existing.id, created: false };

  const exceptionId = id('rex');
  db.insert(schema.paymentReconciliationExceptions)
    .values({
      id: exceptionId,
      tenantId: input.tenantId,
      branchId: input.branchId,
      invoiceId: input.invoiceId,
      intentId: input.intentId,
      provider: 'razorpay',
      providerPaymentId: input.providerPaymentId ?? null,
      providerRefundId: input.providerRefundId ?? null,
      kind: input.kind,
      dedupeKey,
      expectedMinor: input.expectedMinor ?? null,
      receivedMinor: input.receivedMinor ?? null,
      currency: input.currency ?? null,
      detail: input.detail,
      state: 'open',
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  audit(razorpayContext(input.tenantId, input.branchId), {
    action: 'payment.reconciliation_exception_opened',
    entityType: input.invoiceId ? 'invoice' : 'payment_reconciliation_exception',
    entityId: input.invoiceId ?? exceptionId,
    after: { exceptionId, kind: input.kind, providerPaymentId: input.providerPaymentId ?? null, expectedMinor: input.expectedMinor ?? null, receivedMinor: input.receivedMinor ?? null },
  });
  log('warn', 'payment_reconciliation_exception', { tenantId: input.tenantId, kind: input.kind, exceptionId });
  return { exceptionId, created: true };
}

export type SettleOutcome =
  | { kind: 'settled'; paymentId: string; membershipActivated: boolean }
  | { kind: 'already_settled'; paymentId: string }
  | { kind: 'exception'; exceptionId: string; created: boolean }
  | { kind: 'not_captured' };

/** Razorpay's method names are stored as they are (`upi`, `card`,
 *  `netbanking`, `wallet`, …); receipts say how the member paid. */
function methodOf(payment: ProviderPayment): string {
  return payment.method ?? 'online';
}

/**
 * Settle a provider payment against its intent, at most once.
 *
 * Runs inside the caller's transaction and never calls the provider: every
 * caller (confirm, webhook, reconciliation) has already obtained the payment
 * from a source it trusts — a server-to-server fetch or a signed webhook.
 *
 * Only captured money settles. A payment whose amount or currency differs from
 * the intent, or which arrives for an invoice that is no longer owed that much,
 * never touches the invoice: it opens a reconciliation exception and the
 * intent waits for staff (`needs_review`).
 */
export function settleProviderPayment(intentId: string, payment: ProviderPayment, source: 'confirm' | 'webhook' | 'reconciliation'): SettleOutcome {
  const intent = db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intentId)).get();
  if (!intent) throw new Error(`Payment intent ${intentId} vanished during settlement.`);
  if (!payment.captured && payment.status !== 'captured') return { kind: 'not_captured' };

  // The payment row is the proof of settlement, whichever path wrote it.
  const settled = db
    .select({ id: schema.payments.id, invoiceId: schema.payments.invoiceId })
    .from(schema.payments)
    .where(and(eq(schema.payments.provider, 'razorpay'), eq(schema.payments.providerRef, payment.id)))
    .get();
  if (settled) {
    if (intent.state !== 'succeeded' && settled.invoiceId === intent.invoiceId) {
      markIntent(intent, { state: 'succeeded', providerPaymentId: payment.id, paymentId: settled.id, settledAt: now(), failureCode: null, failureReason: null });
    }
    return { kind: 'already_settled', paymentId: settled.id };
  }

  const invoice = db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, intent.invoiceId), eq(schema.invoices.tenantId, intent.tenantId)))
    .get();
  const due = invoice && !invoice.voided ? invoice.totalMinor - invoice.paidMinor : 0;

  const mismatch: { kind: ExceptionKind; detail: string } | null =
    payment.currency !== intent.currency
      ? { kind: 'currency_mismatch', detail: `Razorpay captured ${payment.currency}; this checkout was for ${intent.currency}.` }
      : payment.amountMinor !== intent.amountMinor
        ? { kind: 'amount_mismatch', detail: `Razorpay captured ${payment.amountMinor}; this checkout was for ${intent.amountMinor} (minor units).` }
        : intent.state === 'succeeded' || !invoice || invoice.voided || payment.amountMinor > due
          ? {
              kind: 'invoice_already_settled',
              detail: `Razorpay captured ${payment.amountMinor}, but the invoice ${invoice?.voided ? 'is void' : `has ${due} outstanding`}. The member may have paid twice.`,
            }
          : null;

  if (mismatch) {
    const { exceptionId, created } = openReconciliationException({
      tenantId: intent.tenantId,
      branchId: intent.branchId,
      invoiceId: intent.invoiceId,
      intentId: intent.id,
      kind: mismatch.kind,
      providerPaymentId: payment.id,
      expectedMinor: intent.amountMinor,
      receivedMinor: payment.amountMinor,
      currency: payment.currency,
      detail: mismatch.detail,
    });
    if (intent.state !== 'succeeded') {
      markIntent(intent, { state: 'needs_review', providerPaymentId: payment.id, failureCode: mismatch.kind, failureReason: null });
    }
    return { kind: 'exception', exceptionId, created };
  }

  const ctx = razorpayContext(intent.tenantId, intent.branchId);
  const result = settleInvoicePayment({
    ctx,
    invoice: invoice!,
    amountMinor: payment.amountMinor,
    method: methodOf(payment),
    provider: 'razorpay',
    providerRef: payment.id,
    idempotencyKey: `razorpay:${payment.id}`,
    recordedByName: 'Razorpay',
    note: `Online payment (${source})`,
    source: 'provider',
  });
  markIntent(intent, {
    state: 'succeeded',
    providerPaymentId: payment.id,
    paymentId: result.paymentId,
    settledAt: now(),
    failureCode: null,
    failureReason: null,
  });
  // Any other open attempt for this invoice can no longer be paid against it.
  db.update(schema.paymentIntents)
    .set({ state: 'superseded', updatedAt: now() })
    .where(
      and(
        eq(schema.paymentIntents.tenantId, intent.tenantId),
        eq(schema.paymentIntents.invoiceId, intent.invoiceId),
        inArray(schema.paymentIntents.state, ['created', 'processing', 'failed']),
      ),
    )
    .run();
  return { kind: 'settled', paymentId: result.paymentId, membershipActivated: result.membershipActivated };
}

/**
 * A failed attempt. Never overrides success: Razorpay documents that
 * `payment.failed` can arrive after `payment.captured`, and a member may fail
 * once and then pay on the same order.
 */
export function recordFailedAttempt(intentId: string, payment: ProviderPayment): { changed: boolean } {
  const intent = db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intentId)).get();
  if (!intent || !['created', 'processing', 'failed'].includes(intent.state)) return { changed: false };
  // A failure for an older payment does not undo progress on a newer one.
  if (intent.providerPaymentId && intent.providerPaymentId !== payment.id && intent.state === 'processing') return { changed: false };
  markIntent(intent, {
    state: 'failed',
    providerPaymentId: payment.id,
    failureCode: payment.errorReason ?? payment.errorCode ?? 'payment_failed',
    failureReason: payment.errorDescription,
  });
  emit({
    tenantId: intent.tenantId,
    branchId: intent.branchId,
    channel: channels.member(intent.memberId),
    topic: 'payment.failed',
    payload: { intentId: intent.id, invoiceId: intent.invoiceId },
  });
  // Outbound webhooks (P06): ids, amounts and the provider's reason code only.
  emitIntegrationEvent({
    tenantId: intent.tenantId,
    branchId: intent.branchId,
    type: 'payment.failed',
    data: {
      intentId: intent.id,
      invoiceId: intent.invoiceId,
      memberId: intent.memberId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      failureCode: payment.errorReason ?? payment.errorCode ?? 'payment_failed',
    },
  });
  // The member's phone (P04): in the app, and as a push when they have it on.
  // One per provider payment, so a second failed try is a second message.
  const member = db.select({ userId: schema.members.userId }).from(schema.members).where(eq(schema.members.id, intent.memberId)).get();
  const invoice = db.select({ number: schema.invoices.number }).from(schema.invoices).where(eq(schema.invoices.id, intent.invoiceId)).get();
  if (member?.userId && invoice) {
    notifyPaymentOutcome({
      tenantId: intent.tenantId,
      userId: member.userId,
      branchId: intent.branchId,
      invoiceId: intent.invoiceId,
      invoiceNumber: invoice.number,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      outcome: 'failed',
      attemptRef: String(payment.id),
    });
  }
  return { changed: true };
}

export function markIntent(intent: IntentRow, changes: Partial<Omit<IntentRow, 'id' | 'tenantId'>>): void {
  db.update(schema.paymentIntents)
    .set({ ...changes, updatedAt: now() })
    .where(eq(schema.paymentIntents.id, intent.id))
    .run();
}
