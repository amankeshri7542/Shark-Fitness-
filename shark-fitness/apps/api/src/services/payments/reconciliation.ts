import { and, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { formatMoney } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { branchScope, requirePermission, type RequestContext } from '../../lib/context.js';
import { conflict, notFound } from '../../lib/errors.js';
import { log } from '../../lib/observability.js';
import { ProviderError, resolvePaymentProvider, type PaymentProvider, type ProviderPayment } from '../../lib/payment-provider.js';
import { DAY, HOUR, MINUTE, now } from '../../lib/time.js';
import { applyProviderPayment, captureOrRefetch } from './checkout.js';
import { openReconciliationException, type IntentRow } from './settlement.js';

/**
 * `reconcile-payments` (every 6 hours; scheduler, durable `job_runs`).
 *
 * Webhooks can be missed: the server was down for more than Razorpay's 24 h of
 * retries, a webhook was disabled in the Dashboard, a member closed the tab
 * before confirm. This job asks Razorpay directly:
 *
 * 1. every intent still `processing` 15 minutes after its last change (and
 *    younger than 7 days): the payments on its order or link;
 * 2. every payment Razorpay recorded in the last 48 hours.
 *
 * Captured money settles through the same idempotent path as confirm and
 * webhooks, so running this twice — even at the same moment — settles once.
 * Captured money that matches nothing becomes an exception for staff.
 */

export const STUCK_AFTER_MS = 15 * MINUTE;
export const INTENT_HORIZON_MS = 7 * DAY;
export const PAYMENT_WINDOW_MS = 48 * HOUR;

export interface ReconcileSummary {
  provider: 'razorpay' | 'none';
  intentsChecked: number;
  paymentsSeen: number;
  settled: number;
  exceptions: number;
  providerErrors: number;
}

export async function reconcilePayments(atMs = now()): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { provider: 'none', intentsChecked: 0, paymentsSeen: 0, settled: 0, exceptions: 0, providerErrors: 0 };
  const provider = resolvePaymentProvider();
  if (!provider) return summary;
  summary.provider = 'razorpay';

  const stuck = db
    .select()
    .from(schema.paymentIntents)
    .where(
      and(
        eq(schema.paymentIntents.provider, 'razorpay'),
        eq(schema.paymentIntents.state, 'processing'),
        lte(schema.paymentIntents.updatedAt, atMs - STUCK_AFTER_MS),
        gte(schema.paymentIntents.createdAt, atMs - INTENT_HORIZON_MS),
      ),
    )
    .all();

  for (const intent of stuck) {
    summary.intentsChecked += 1;
    try {
      const payments = await paymentsForIntent(provider, intent);
      const captured = payments.find((payment) => payment.captured || payment.status === 'captured');
      const authorized = payments.find((payment) => payment.status === 'authorized');
      const chosen = captured ?? (authorized ? await captureOrRefetch(provider, authorized) : payments.find((payment) => payment.status === 'failed'));
      summary.paymentsSeen += payments.length;
      const outcome = transact(() => {
        const result = chosen ? applyProviderPayment(intent.id, chosen, 'reconciliation') : 'unchanged';
        db.update(schema.paymentIntents).set({ lastCheckedAt: atMs }).where(eq(schema.paymentIntents.id, intent.id)).run();
        return result;
      });
      if (outcome === 'settled') summary.settled += 1;
      if (outcome === 'exception') summary.exceptions += 1;
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      summary.providerErrors += 1;
    }
  }

  let recent: ProviderPayment[] = [];
  try {
    recent = await provider.fetchPaymentsForReconciliation({ fromMs: atMs - PAYMENT_WINDOW_MS, toMs: atMs });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    summary.providerErrors += 1;
  }
  for (const payment of recent) {
    summary.paymentsSeen += 1;
    if (!(payment.captured || payment.status === 'captured')) continue;
    const result = transact(() => {
      const known = db
        .select({ id: schema.payments.id })
        .from(schema.payments)
        .where(and(eq(schema.payments.provider, 'razorpay'), eq(schema.payments.providerRef, payment.id)))
        .get();
      if (known) return 'known' as const;
      const intent = payment.orderId
        ? db.select().from(schema.paymentIntents).where(and(eq(schema.paymentIntents.provider, 'razorpay'), eq(schema.paymentIntents.providerOrderId, payment.orderId))).get()
        : undefined;
      const byNote = !intent && payment.notes.intent_id
        ? db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, payment.notes.intent_id)).get()
        : undefined;
      const match = intent ?? byNote;
      if (match) return applyProviderPayment(match.id, payment, 'reconciliation');
      // Captured money nobody here asked for. Only attributable when the
      // payment names one of our tenants; otherwise it is another integration
      // on the same Razorpay account and is left alone.
      const tenantId = payment.notes.tenant_id;
      const tenant = tenantId ? db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get() : undefined;
      if (!tenant) return 'foreign' as const;
      const opened = openReconciliationException({
        tenantId: tenant.id,
        branchId: null,
        invoiceId: null,
        intentId: null,
        kind: 'unmatched_payment',
        providerPaymentId: payment.id,
        receivedMinor: payment.amountMinor,
        currency: payment.currency,
        detail: 'Razorpay captured this payment, but it matches no checkout or payment link here.',
      });
      return opened.created ? ('exception' as const) : ('unchanged' as const);
    });
    if (result === 'settled') summary.settled += 1;
    if (result === 'exception') summary.exceptions += 1;
  }

  if (summary.settled + summary.exceptions > 0) log('info', 'payments_reconciled', { ...summary });
  return summary;
}

async function paymentsForIntent(provider: PaymentProvider, intent: IntentRow): Promise<ProviderPayment[]> {
  if (intent.providerOrderId) return provider.fetchOrderPayments(intent.providerOrderId);
  if (intent.providerLinkId) {
    const link = await provider.fetchPaymentLink(intent.providerLinkId);
    const payments: ProviderPayment[] = [];
    for (const paymentId of link.paymentIds) payments.push(await provider.fetchPayment(paymentId));
    return payments;
  }
  return [];
}

/* — Console ———————————————————————————————————————————————————————— */

export const EXCEPTION_COPY: Record<string, string> = {
  amount_mismatch: 'Amount does not match',
  currency_mismatch: 'Currency does not match',
  invoice_already_settled: 'Paid after the invoice was settled',
  unmatched_payment: 'Payment matches nothing here',
  refund_outside_console: 'Refunded outside the console',
};

export function listReconciliationExceptions(ctx: RequestContext, state: 'open' | 'resolved' | 'ignored' | 'all') {
  requirePermission(ctx, 'billing.view');
  const scope = branchScope(ctx);
  const rows = db
    .select({
      exception: schema.paymentReconciliationExceptions,
      invoiceNumber: schema.invoices.number,
      memberId: schema.invoices.memberId,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
    })
    .from(schema.paymentReconciliationExceptions)
    .leftJoin(schema.invoices, eq(schema.invoices.id, schema.paymentReconciliationExceptions.invoiceId))
    .leftJoin(schema.members, eq(schema.members.id, schema.invoices.memberId))
    .where(
      and(
        eq(schema.paymentReconciliationExceptions.tenantId, ctx.tenantId),
        state === 'all' ? undefined : eq(schema.paymentReconciliationExceptions.state, state),
        // Unattributed exceptions (no branch) are for whoever sees every branch.
        scope.length > 0
          ? or(inArray(schema.paymentReconciliationExceptions.branchId, scope), isNull(schema.paymentReconciliationExceptions.branchId))
          : undefined,
      ),
    )
    .orderBy(desc(schema.paymentReconciliationExceptions.createdAt))
    .limit(200)
    .all();
  return {
    onlinePayment: resolvePaymentProvider() !== null,
    items: rows.map(({ exception, invoiceNumber, memberId, firstName, lastName }) => ({
      id: exception.id,
      kind: exception.kind,
      title: EXCEPTION_COPY[exception.kind] ?? exception.kind,
      detail: exception.detail,
      state: exception.state,
      invoiceId: exception.invoiceId,
      invoiceNumber: invoiceNumber ?? null,
      memberId: memberId ?? null,
      memberName: firstName ? `${firstName} ${lastName ?? ''}`.trim() : null,
      providerPaymentId: exception.providerPaymentId,
      providerRefundId: exception.providerRefundId,
      expectedLabel: exception.expectedMinor !== null ? formatMoney(exception.expectedMinor, exception.currency ?? 'INR') : null,
      receivedLabel: exception.receivedMinor !== null ? formatMoney(exception.receivedMinor, exception.currency ?? 'INR') : null,
      resolutionReason: exception.resolutionReason,
      resolvedByName: exception.resolvedByName,
      resolvedAt: exception.resolvedAt ? new Date(exception.resolvedAt).toISOString() : null,
      createdAt: new Date(exception.createdAt).toISOString(),
    })),
  };
}

/** Close an exception. Money is never moved from here: refunds and manual
 *  payments have their own audited paths; this records what staff decided. */
export function resolveReconciliationException(ctx: RequestContext, exceptionId: string, action: 'resolve' | 'ignore', reason: string) {
  requirePermission(ctx, 'billing.refund');
  return transact(() => {
    const row = db
      .select()
      .from(schema.paymentReconciliationExceptions)
      .where(and(eq(schema.paymentReconciliationExceptions.id, exceptionId), eq(schema.paymentReconciliationExceptions.tenantId, ctx.tenantId)))
      .get();
    if (!row || (row.branchId !== null && !branchScope(ctx).includes(row.branchId))) throw notFound('That exception');
    if (row.state !== 'open') throw conflict('This exception was already closed.');
    const state = action === 'resolve' ? 'resolved' : 'ignored';
    db.update(schema.paymentReconciliationExceptions)
      .set({ state, resolutionReason: reason, resolvedById: ctx.userId, resolvedByName: ctx.name, resolvedAt: now(), updatedAt: now() })
      .where(eq(schema.paymentReconciliationExceptions.id, row.id))
      .run();
    audit(ctx, {
      action: action === 'resolve' ? 'payment.reconciliation_resolved' : 'payment.reconciliation_ignored',
      entityType: 'payment_reconciliation_exception',
      entityId: row.id,
      entityLabel: EXCEPTION_COPY[row.kind] ?? row.kind,
      branchId: row.branchId,
      reason,
      before: { state: row.state },
      after: { state, invoiceId: row.invoiceId, providerPaymentId: row.providerPaymentId },
    });
    return { ok: true as const, id: row.id, state };
  });
}
