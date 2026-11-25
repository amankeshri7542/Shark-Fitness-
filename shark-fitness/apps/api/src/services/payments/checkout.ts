import { and, desc, eq, inArray } from 'drizzle-orm';
import { formatMoney } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import type { RequestContext } from '../../lib/context.js';
import { requestHash } from '../../lib/crypto.js';
import { AppError, conflict, invalid, notFound, precondition } from '../../lib/errors.js';
import { id } from '../../lib/ids.js';
import { log } from '../../lib/observability.js';
import { ProviderError, resolvePaymentProvider, type PaymentProvider, type ProviderPayment } from '../../lib/payment-provider.js';
import { now } from '../../lib/time.js';
import { markIntent, recordFailedAttempt, settleProviderPayment, type IntentRow } from './settlement.js';

/** Today's refusal, kept word for word: with no provider configured, member
 *  checkout answers 412 exactly as the retired endpoints always have. */
export const ONLINE_PAYMENT_UNAVAILABLE =
  'Online payment is unavailable. Pay at reception; staff will record independently received funds.';

export function requireProvider(): PaymentProvider {
  const provider = resolvePaymentProvider();
  if (!provider) throw precondition(ONLINE_PAYMENT_UNAVAILABLE);
  return provider;
}

export function requireIdempotencyKey(key: string | undefined): string {
  const trimmed = key?.trim();
  if (!trimmed || trimmed.length > 200) throw invalid('An Idempotency-Key header (up to 200 characters) is required for payments.');
  return trimmed;
}

/** What the member's screen can be told. Internal states collapse into the
 *  five the app renders. */
export type MemberCheckoutState = 'processing' | 'succeeded' | 'failed' | 'needs_review' | 'expired';

export interface CheckoutStatus {
  intentId: string;
  invoiceId: string;
  state: MemberCheckoutState;
  amountLabel: string;
  paymentId: string | null;
  /** Plain words, safe to show; null unless the attempt failed. */
  failureReason: string | null;
}

export interface CheckoutSession extends CheckoutStatus {
  orderId: string | null;
  keyId: string;
  amountMinor: number;
  currency: string;
  /** Shown in Razorpay Checkout's header. */
  name: string;
  description: string;
  prefill: { name: string; email: string | null; contact: string | null };
}

const FAILED_FALLBACK = 'The payment did not go through. If money left your account, your bank returns it automatically.';

function memberState(state: string): MemberCheckoutState {
  if (state === 'succeeded') return 'succeeded';
  if (state === 'failed') return 'failed';
  if (state === 'needs_review') return 'needs_review';
  if (state === 'expired' || state === 'superseded') return 'expired';
  return 'processing';
}

export function checkoutStatus(intent: IntentRow): CheckoutStatus {
  const state = memberState(intent.state);
  return {
    intentId: intent.id,
    invoiceId: intent.invoiceId,
    state,
    amountLabel: formatMoney(intent.amountMinor, intent.currency),
    paymentId: intent.paymentId,
    failureReason: state === 'failed' ? intent.failureReason || FAILED_FALLBACK : null,
  };
}

function loadIntent(tenantId: string, intentId: string): IntentRow | undefined {
  return db.select().from(schema.paymentIntents).where(and(eq(schema.paymentIntents.id, intentId), eq(schema.paymentIntents.tenantId, tenantId))).get();
}

/** The caller's own intent, or 404 — another member's intent does not exist. */
export function loadMemberIntent(ctx: RequestContext, intentId: string): IntentRow {
  const intent = loadIntent(ctx.tenantId, intentId);
  if (!intent || intent.memberId !== ctx.memberId || intent.channel !== 'checkout') throw notFound('That payment');
  return intent;
}

function session(provider: PaymentProvider, intent: IntentRow): CheckoutSession {
  const tenant = db.select({ name: schema.tenants.displayName }).from(schema.tenants).where(eq(schema.tenants.id, intent.tenantId)).get();
  const invoice = db.select({ number: schema.invoices.number }).from(schema.invoices).where(eq(schema.invoices.id, intent.invoiceId)).get();
  const member = db
    .select({ firstName: schema.members.firstName, lastName: schema.members.lastName, email: schema.members.email, phone: schema.members.phone })
    .from(schema.members)
    .where(eq(schema.members.id, intent.memberId))
    .get();
  return {
    ...checkoutStatus(intent),
    orderId: intent.providerOrderId,
    keyId: provider.keyId,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    name: tenant?.name ?? 'Membership',
    description: invoice ? `Invoice ${invoice.number}` : 'Invoice',
    prefill: {
      name: member ? `${member.firstName} ${member.lastName}`.trim() : '',
      email: member?.email ?? null,
      contact: member?.phone ?? null,
    },
  };
}

/**
 * Open (or resume) a Razorpay Checkout for one of the caller's open invoices.
 *
 * 1. In a transaction: check the invoice is the caller's and still owed,
 *    then find or commit the intent. One live order per invoice and amount:
 *    a second tap, a second tab or a retry resumes the same order, so the
 *    member cannot end up holding two payable orders for one debt.
 * 2. Outside any transaction: ask Razorpay for an order.
 * 3. In a new transaction: record the order (or the failure).
 *
 * A timeout leaves the intent `failed` with no order and no payment; the same
 * Idempotency-Key retried later asks Razorpay again.
 */
export async function startInvoiceCheckout(
  ctx: RequestContext,
  invoiceId: string,
  idempotencyKey: string,
  purpose: string = 'invoice',
): Promise<CheckoutSession> {
  const provider = requireProvider();
  if (!ctx.memberId) throw notFound('That invoice');
  const hash = requestHash({ invoiceId });

  const intent = transact((): IntentRow => {
    const invoice = db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, ctx.tenantId), eq(schema.invoices.memberId, ctx.memberId!)))
      .get();
    if (!invoice) throw notFound('That invoice');

    const keyed = db
      .select()
      .from(schema.paymentIntents)
      .where(and(eq(schema.paymentIntents.tenantId, ctx.tenantId), eq(schema.paymentIntents.idempotencyKey, idempotencyKey)))
      .get();
    if (keyed) {
      if (keyed.requestHash !== hash || keyed.memberId !== ctx.memberId) {
        throw new AppError('IDEMPOTENCY_MISMATCH', 'This idempotency key was already used for a different request.');
      }
      // A finished or failed attempt answers with what happened to it; an
      // order-less failure (timeout) is retried below.
      if (keyed.state !== 'failed' || keyed.providerOrderId) return keyed;
    }

    if (invoice.voided) throw conflict('This invoice was cancelled, so there is nothing to pay.');
    const due = invoice.totalMinor - invoice.paidMinor;
    if (due <= 0) throw conflict('This invoice is already paid.');

    if (keyed) {
      markIntent(keyed, { state: 'created', failureCode: null, failureReason: null, amountMinor: due, currency: invoice.currency });
      return { ...keyed, state: 'created', amountMinor: due };
    }

    const open = db
      .select()
      .from(schema.paymentIntents)
      .where(
        and(
          eq(schema.paymentIntents.tenantId, ctx.tenantId),
          eq(schema.paymentIntents.invoiceId, invoice.id),
          eq(schema.paymentIntents.channel, 'checkout'),
          inArray(schema.paymentIntents.state, ['processing', 'failed']),
        ),
      )
      .orderBy(desc(schema.paymentIntents.createdAt))
      .all();
    const resumable = open.find((row) => row.providerOrderId && row.amountMinor === due && row.currency === invoice.currency);
    if (resumable) return resumable;
    // The amount owed changed (part paid at the desk, say): an order for the
    // old amount must not be paid against this invoice any more.
    for (const stale of open) markIntent(stale, { state: 'superseded' });

    const row: IntentRow = {
      id: id('pi'),
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      memberId: invoice.memberId,
      invoiceId: invoice.id,
      provider: provider.name,
      channel: 'checkout',
      purpose,
      state: 'created',
      amountMinor: due,
      currency: invoice.currency,
      providerOrderId: null,
      providerPaymentId: null,
      providerLinkId: null,
      linkUrl: null,
      expiresAt: null,
      idempotencyKey,
      requestHash: hash,
      paymentId: null,
      failureCode: null,
      failureReason: null,
      createdById: ctx.userId,
      createdByName: ctx.name,
      createdAt: now(),
      updatedAt: now(),
      settledAt: null,
      lastCheckedAt: null,
    };
    db.insert(schema.paymentIntents).values(row).run();
    return row;
  });

  if (intent.providerOrderId || intent.state !== 'created') return session(provider, intent);

  try {
    const order = await provider.createOrder({
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      // ≤ 40 characters and unique per order. A fresh suffix per attempt: an
      // order Razorpay created during a timed-out attempt is simply never paid.
      receipt: `${intent.id}.${Date.now().toString(36)}`.slice(0, 40),
      notes: { tenant_id: intent.tenantId, intent_id: intent.id, invoice_id: intent.invoiceId },
    });
    const updated = transact(() => {
      markIntent(intent, { state: 'processing', providerOrderId: order.id });
      return loadIntent(intent.tenantId, intent.id)!;
    });
    return session(provider, updated);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    transact(() => markIntent(intent, { state: 'failed', failureCode: `order_${error.kind}`, failureReason: 'Online payment could not be started.' }));
    log('warn', 'razorpay_order_failed', { intentId: intent.id, kind: error.kind, status: error.status });
    throw new AppError('PROVIDER_UNAVAILABLE', 'Online payment could not be started just now. Nothing was charged. Try again in a moment.', { retryAfterSec: 10 });
  }
}

export interface ConfirmInput {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/**
 * The member's browser says Checkout succeeded. That is a claim, not money:
 *
 * 1. The signature must verify against *our* order id and the key secret.
 * 2. The payment is then fetched from Razorpay server-to-server.
 * 3. Only a `captured` payment settles. An `authorized` one is captured here
 *    first. Anything else leaves the intent processing for the webhook.
 */
export async function confirmCheckout(ctx: RequestContext, intentId: string, input: ConfirmInput): Promise<CheckoutStatus> {
  const provider = requireProvider();
  const intent = loadMemberIntent(ctx, intentId);
  if (intent.state === 'succeeded') return checkoutStatus(intent);

  if (
    !intent.providerOrderId ||
    input.razorpay_order_id !== intent.providerOrderId ||
    !provider.verifyCheckoutSignature({ orderId: intent.providerOrderId, paymentId: input.razorpay_payment_id, signature: input.razorpay_signature })
  ) {
    log('warn', 'security_razorpay_checkout_signature_invalid', { tenantId: ctx.tenantId, intentId, requestId: ctx.requestId });
    throw new AppError('SIGNATURE_INVALID', 'We could not verify that payment. Nothing was settled. If money left your account, contact reception with the payment reference.');
  }

  let payment: ProviderPayment;
  try {
    payment = await provider.fetchPayment(input.razorpay_payment_id);
    if (payment.orderId !== intent.providerOrderId) {
      throw new AppError('SIGNATURE_INVALID', 'That payment belongs to a different order. Nothing was settled.');
    }
    if (payment.status === 'authorized') payment = await captureOrRefetch(provider, payment);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    // We do not know yet. The webhook or the reconciliation job will.
    transact(() => markIntent(intent, { state: 'processing', providerPaymentId: input.razorpay_payment_id }));
    log('warn', 'razorpay_confirm_unconfirmed', { intentId, kind: error.kind });
    return checkoutStatus(loadIntent(ctx.tenantId, intentId)!);
  }

  return transact(() => {
    applyProviderPayment(intent.id, payment, 'confirm');
    return checkoutStatus(loadIntent(ctx.tenantId, intentId)!);
  });
}

/** Capture an authorized payment for its full amount. If Razorpay refuses
 *  because someone (the webhook, auto-capture) already captured it, the fresh
 *  fetch says so. Outside any transaction. */
export async function captureOrRefetch(provider: PaymentProvider, payment: ProviderPayment): Promise<ProviderPayment> {
  try {
    return await provider.capturePayment(payment.id, payment.amountMinor, payment.currency);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'http') return provider.fetchPayment(payment.id);
    throw error;
  }
}

/** Route a provider payment's current status into the intent. Inside a
 *  transaction. */
export function applyProviderPayment(intentId: string, payment: ProviderPayment, source: 'confirm' | 'webhook' | 'reconciliation'): void {
  if (payment.captured || payment.status === 'captured') {
    settleProviderPayment(intentId, payment, source);
  } else if (payment.status === 'failed') {
    recordFailedAttempt(intentId, payment);
  } else {
    const intent = db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intentId)).get();
    if (intent && ['created', 'processing', 'failed'].includes(intent.state)) {
      markIntent(intent, { state: 'processing', providerPaymentId: payment.id, failureCode: null, failureReason: null });
    }
  }
}

export function memberCheckoutStatus(ctx: RequestContext, intentId: string): CheckoutStatus {
  return checkoutStatus(loadMemberIntent(ctx, intentId));
}
