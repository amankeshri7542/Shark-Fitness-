import { and, eq } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { invoiceStateFor } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { branchTimeZone } from '../../lib/branch-time.js';
import { requirePermission, type RequestContext } from '../../lib/context.js';
import { AppError, conflict, invalid, notFound, precondition } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { id } from '../../lib/ids.js';
import { log } from '../../lib/observability.js';
import { ProviderError, resolvePaymentProvider, type PaymentProvider, type ProviderPayment, type ProviderRefund } from '../../lib/payment-provider.js';
import { isoDate, now } from '../../lib/time.js';
import { assertRefundableProduct, loadInvoiceInScope, refundableBalance } from '../billing.js';
import { reverseMembership } from '../billing-stabilization.js';
import { reinstateRevokedCredits } from '../credit-ledger.js';
import { openReconciliationException, razorpayContext, settleProviderPayment, type IntentRow } from './settlement.js';

/**
 * Refunds of Razorpay payments.
 *
 * Staff ask; Razorpay decides. The refund row is committed `pending` before the
 * provider is called (with our refund id as Razorpay's idempotency key, so a
 * retry cannot refund twice) and stays pending until `refund.processed` makes
 * it `succeeded` — only then does the invoice's refunded total move and, if
 * staff asked for it, the membership get reversed. `refund.failed` makes it
 * `failed`, which returns its amount to the refundable balance.
 *
 * Manual (cash/card/UPI recorded at the desk) payments keep the manual path in
 * services/billing.ts.
 */

type RefundRow = typeof schema.refunds.$inferSelect;
type InvoiceRow = typeof schema.invoices.$inferSelect;

export interface ProviderRefundResult {
  refundId: string;
  state: 'pending' | 'succeeded' | 'failed';
  invoiceState: string;
  entitlementState: null;
}

function view(refund: RefundRow, invoice: InvoiceRow): ProviderRefundResult {
  return { refundId: refund.id, state: refund.state as ProviderRefundResult['state'], invoiceState: invoice.state, entitlementState: null };
}

export async function requestProviderRefund(input: {
  ctx: RequestContext;
  paymentId: string;
  amountMinor: number;
  reason: string;
  entitlementReversed: boolean;
  idempotencyKey: string;
  /** Set only by the credit-pack refund (services/credit-packs.ts): runs in
   *  the same transaction as the pending refund row, so the pack's credits
   *  are taken back exactly when the refund is committed. */
  creditPackRefund?: (refundId: string) => void;
}): Promise<ProviderRefundResult> {
  const { ctx, paymentId, amountMinor, reason, entitlementReversed, idempotencyKey } = input;
  requirePermission(ctx, 'billing.refund');
  const provider = resolvePaymentProvider();
  if (!provider) throw precondition('This was an online payment. Refunding it needs the payment provider to be connected.');

  const { refund, payment } = transact(() => {
    const payment = db.select().from(schema.payments).where(and(eq(schema.payments.id, paymentId), eq(schema.payments.tenantId, ctx.tenantId))).get();
    if (!payment?.invoiceId || payment.provider !== 'razorpay' || !payment.providerRef) throw notFound('That payment');
    const invoice = loadInvoiceInScope(ctx, payment.invoiceId);

    const keyed = db
      .select()
      .from(schema.refunds)
      .where(and(eq(schema.refunds.tenantId, ctx.tenantId), eq(schema.refunds.idempotencyKey, idempotencyKey)))
      .get();
    if (keyed) {
      const same = keyed.paymentId === paymentId && keyed.amountMinor === amountMinor && keyed.reason === reason && keyed.entitlementReversed === entitlementReversed;
      if (!same) throw new AppError('IDEMPOTENCY_MISMATCH', 'This idempotency key was already used for a different refund.');
      return { refund: keyed, payment, invoice };
    }

    assertRefundableProduct(ctx, invoice, input.creditPackRefund !== undefined);
    if (payment.state !== 'succeeded') throw conflict('Only a succeeded payment can be refunded.');
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw invalid('Refund amount must be a positive safe integer.');
    const refundable = refundableBalance(payment);
    if (amountMinor > refundable) throw invalid(`That is more than the refundable balance (${refundable}), counting refunds still in progress.`);

    const refund: RefundRow = {
      id: id('ref'),
      tenantId: ctx.tenantId,
      paymentId,
      amountMinor,
      reason,
      state: 'pending',
      entitlementReversed,
      actorName: ctx.name,
      createdAt: now(),
      provider: 'razorpay',
      providerRefundId: null,
      idempotencyKey,
      failureReason: null,
      updatedAt: now(),
    };
    db.insert(schema.refunds).values(refund).run();
    input.creditPackRefund?.(refund.id);
    audit(ctx, {
      action: 'payment.refund_requested',
      entityType: 'invoice',
      entityId: invoice.id,
      entityLabel: invoice.number,
      reason,
      after: { refundId: refund.id, amountMinor, provider: 'razorpay', providerPaymentId: payment.providerRef, entitlementReversed },
    });
    return { refund, payment, invoice };
  });

  // Already with Razorpay, or already decided: answer with what we know.
  if (refund.providerRefundId || refund.state !== 'pending') {
    return view(refund, loadInvoiceInScope(ctx, payment.invoiceId!));
  }

  let updated: RefundRow;
  try {
    updated = await submitProviderRefund(provider, refund, { providerRef: payment.providerRef!, invoiceId: payment.invoiceId! }, ctx);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error.kind === 'http') {
      throw conflict(`Razorpay refused the refund${error.description ? `: ${error.description}` : ''}. Nothing was refunded.`);
    }
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'Razorpay did not confirm the refund yet. Try again with the same request; it will not refund twice.',
      { retryAfterSec: 30 },
    );
  }
  return view(updated, loadInvoiceInScope(ctx, payment.invoiceId!));
}

/**
 * Hand a committed `pending` refund to Razorpay and record its answer.
 * Outside any transaction. Our refund id is Razorpay's idempotency key, so
 * asking again (staff retrying, or the reconcile-payments job after a timeout
 * whose retry key the console has lost) can never refund twice.
 *
 * A refusal (`http`) marks the refund failed, which returns its amount to the
 * refundable balance, and rethrows. A timeout or network error leaves it
 * pending and rethrows: the outcome is unknown.
 */
export async function submitProviderRefund(
  provider: PaymentProvider,
  refund: RefundRow,
  payment: { providerRef: string; invoiceId: string },
  ctx: RequestContext,
): Promise<RefundRow> {
  let providerRefund: ProviderRefund;
  try {
    providerRefund = await provider.refundPayment({
      paymentId: payment.providerRef,
      amountMinor: refund.amountMinor,
      idempotencyKey: refund.id,
      receipt: refund.id,
      notes: { refund_id: refund.id, tenant_id: refund.tenantId, invoice_id: payment.invoiceId },
    });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error.kind === 'http') {
      transact(() => {
        db.update(schema.refunds)
          .set({ state: 'failed', failureReason: error.description ?? 'Razorpay refused the refund.', updatedAt: now() })
          .where(and(eq(schema.refunds.id, refund.id), eq(schema.refunds.state, 'pending')))
          .run();
        audit(ctx, { action: 'payment.refund_refused', entityType: 'refund', entityId: refund.id, reason: error.description ?? null });
        // The money never left, so a credit pack keeps its credits.
        reinstateRevokedCredits(ctx, refund.id, now());
      });
    } else {
      log('warn', 'razorpay_refund_unconfirmed', { refundId: refund.id, kind: error.kind });
    }
    throw error;
  }

  return transact(() => {
    db.update(schema.refunds)
      .set({ providerRefundId: providerRefund.id, updatedAt: now(), ...(providerRefund.status === 'failed' ? { state: 'failed', failureReason: 'Razorpay could not process the refund.' } : {}) })
      .where(eq(schema.refunds.id, refund.id))
      .run();
    if (providerRefund.status === 'failed') reinstateRevokedCredits(ctx, refund.id, now());
    return db.select().from(schema.refunds).where(eq(schema.refunds.id, refund.id)).get()!;
  });
}

/**
 * `refund.processed` / `refund.failed`, inside a transaction. Converges on the
 * provider's final word whatever the delivery order:
 *
 * - our own refund (matched by Razorpay refund id or our `refund_id` note):
 *   pending → succeeded or failed; a processed refund is final.
 * - a refund made outside the console (Razorpay Dashboard): if the payment it
 *   refunds was never settled here, settle it first from the signed payload
 *   (the captured event may still be on its way), then record the refund and
 *   open an exception so staff decide about the membership.
 */
export function applyRefundEvent(
  type: 'refund.processed' | 'refund.failed',
  providerRefund: ProviderRefund,
  payment: ProviderPayment | null,
  intent: IntentRow | undefined,
): string | null {
  let refund =
    db.select().from(schema.refunds).where(and(eq(schema.refunds.provider, 'razorpay'), eq(schema.refunds.providerRefundId, providerRefund.id))).get() ??
    (providerRefund.notes.refund_id ? db.select().from(schema.refunds).where(eq(schema.refunds.id, providerRefund.notes.refund_id)).get() : undefined);

  if (!refund) {
    if (type === 'refund.failed') return 'A refund this system did not start failed; nothing to record.';
    if (intent && payment) settleProviderPayment(intent.id, { ...payment, captured: true }, 'webhook');
    const local = db
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.provider, 'razorpay'), eq(schema.payments.providerRef, providerRefund.paymentId)))
      .get();
    if (!local?.invoiceId) return 'Refund for a payment this system does not know.';
    refund = {
      id: id('ref'),
      tenantId: local.tenantId,
      paymentId: local.id,
      amountMinor: providerRefund.amountMinor,
      reason: 'Refunded outside Shark Fitness (Razorpay Dashboard).',
      state: 'pending',
      entitlementReversed: false,
      actorName: 'Razorpay',
      createdAt: now(),
      provider: 'razorpay',
      providerRefundId: providerRefund.id,
      idempotencyKey: null,
      failureReason: null,
      updatedAt: now(),
    };
    db.insert(schema.refunds).values(refund).run();
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, local.invoiceId)).get()!;
    openReconciliationException({
      tenantId: local.tenantId,
      branchId: invoice.branchId,
      invoiceId: invoice.id,
      intentId: intent?.id ?? null,
      kind: 'refund_outside_console',
      providerPaymentId: providerRefund.paymentId,
      providerRefundId: providerRefund.id,
      expectedMinor: null,
      receivedMinor: providerRefund.amountMinor,
      currency: providerRefund.currency,
      detail: 'Razorpay refunded this payment from outside the console. The refund is recorded; decide whether the membership should change.',
    });
  }

  if (refund.state === 'succeeded') return null;
  if (refund.providerRefundId === null) {
    db.update(schema.refunds).set({ providerRefundId: providerRefund.id }).where(eq(schema.refunds.id, refund.id)).run();
  }

  const payment_ = db.select().from(schema.payments).where(eq(schema.payments.id, refund.paymentId)).get()!;
  const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, payment_.invoiceId!)).get()!;
  const ctx = razorpayContext(invoice.tenantId, invoice.branchId);

  if (type === 'refund.failed') {
    if (refund.state === 'failed') return null;
    db.update(schema.refunds).set({ state: 'failed', failureReason: 'Razorpay could not process the refund.', updatedAt: now() }).where(eq(schema.refunds.id, refund.id)).run();
    reinstateRevokedCredits(ctx, refund.id, now());
    audit(ctx, { action: 'payment.refund_failed', entityType: 'invoice', entityId: invoice.id, entityLabel: invoice.number, after: { refundId: refund.id, amountMinor: refund.amountMinor } });
    emit({ tenantId: invoice.tenantId, branchId: invoice.branchId, channel: channels.branch(invoice.branchId), topic: 'invoice.updated', payload: { invoiceId: invoice.id, state: invoice.state } });
    return null;
  }

  const newRefundedMinor = invoice.refundedMinor + refund.amountMinor;
  const newState = invoiceStateFor({
    totalMinor: invoice.totalMinor,
    paidMinor: invoice.paidMinor,
    refundedMinor: newRefundedMinor,
    dueOn: invoice.dueOn,
    today: isoDate(now(), branchTimeZone(invoice.tenantId, invoice.branchId)),
    voided: invoice.voided,
  });
  db.update(schema.refunds).set({ state: 'succeeded', failureReason: null, updatedAt: now() }).where(eq(schema.refunds.id, refund.id)).run();
  db.update(schema.invoices).set({ refundedMinor: newRefundedMinor, state: newState, updatedAt: now() }).where(eq(schema.invoices.id, invoice.id)).run();
  audit(ctx, {
    action: 'payment.refunded',
    entityType: 'invoice',
    entityId: invoice.id,
    entityLabel: invoice.number,
    reason: refund.reason,
    before: { refundedMinor: invoice.refundedMinor, state: invoice.state },
    after: { refundedMinor: newRefundedMinor, state: newState, provider: 'razorpay', providerRefundId: providerRefund.id },
  });
  if (refund.entitlementReversed && invoice.refType === 'membership') {
    // The money is back with the member whatever happens here; a membership
    // that cannot move (already ended, say) must not hold the refund hostage.
    try {
      reverseMembership(ctx, invoice, `Refund: ${refund.reason}`);
    } catch (error) {
      log('warn', 'refund_entitlement_reversal_skipped', { refundId: refund.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  emit({
    tenantId: invoice.tenantId,
    branchId: invoice.branchId,
    channel: channels.member(invoice.memberId),
    topic: 'invoice.updated',
    payload: { invoiceId: invoice.id, state: newState },
  });
  return null;
}
