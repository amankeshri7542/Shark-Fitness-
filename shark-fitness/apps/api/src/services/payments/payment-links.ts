import { and, desc, eq } from 'drizzle-orm';
import { formatMoney } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { requirePermission, type RequestContext } from '../../lib/context.js';
import { requestHash } from '../../lib/crypto.js';
import { AppError, conflict, precondition } from '../../lib/errors.js';
import { id } from '../../lib/ids.js';
import { log } from '../../lib/observability.js';
import { ProviderError, resolvePaymentProvider } from '../../lib/payment-provider.js';
import { DAY, MINUTE, now } from '../../lib/time.js';
import { loadInvoiceInScope } from '../billing.js';
import { markIntent, type IntentRow } from './settlement.js';

/**
 * Razorpay Payment Links for an open invoice (PRD 01 §4.6 "UPI payment-link
 * support").
 *
 * The console shows the link and its expiry for staff to copy into whatever
 * conversation they already have with the member. Razorpay is told not to
 * send anything (`notify.sms/email=false`, no reminders), so no message leaves
 * this system on anyone's behalf. `payment_link.paid` settles the invoice
 * through the same path as Checkout.
 */

export const PAYMENT_LINK_TTL_MS = 7 * DAY;

export interface PaymentLinkView {
  intentId: string;
  url: string | null;
  state: 'active' | 'paid' | 'expired' | 'superseded' | 'failed' | 'creating';
  expiresAt: string | null;
  amountLabel: string;
  createdByName: string;
  createdAt: string;
}

export function linkView(intent: IntentRow, at = now()): PaymentLinkView {
  const state: PaymentLinkView['state'] =
    intent.state === 'succeeded'
      ? 'paid'
      : intent.state === 'superseded'
        ? 'superseded'
        : intent.state === 'failed' && !intent.providerLinkId
          ? 'failed'
          : intent.state === 'created'
            ? 'creating'
            : intent.expiresAt !== null && intent.expiresAt <= at
              ? 'expired'
              : 'active';
  return {
    intentId: intent.id,
    url: intent.linkUrl,
    state,
    expiresAt: intent.expiresAt ? new Date(intent.expiresAt).toISOString() : null,
    amountLabel: formatMoney(intent.amountMinor, intent.currency),
    createdByName: intent.createdByName,
    createdAt: new Date(intent.createdAt).toISOString(),
  };
}

export function invoicePaymentLinks(tenantId: string, invoiceId: string): PaymentLinkView[] {
  return db
    .select()
    .from(schema.paymentIntents)
    .where(and(eq(schema.paymentIntents.tenantId, tenantId), eq(schema.paymentIntents.invoiceId, invoiceId), eq(schema.paymentIntents.channel, 'payment_link')))
    .orderBy(desc(schema.paymentIntents.createdAt))
    .all()
    .map((intent) => linkView(intent));
}

export async function createInvoicePaymentLink(ctx: RequestContext, invoiceId: string, idempotencyKey: string): Promise<PaymentLinkView> {
  requirePermission(ctx, 'billing.record_payment');
  const provider = resolvePaymentProvider();
  if (!provider) throw precondition('Payment links need online payment to be connected. Members can still pay at reception.');
  const hash = requestHash({ invoiceId, kind: 'payment_link' });

  const intent = transact((): IntentRow => {
    const invoice = loadInvoiceInScope(ctx, invoiceId);
    const keyed = db
      .select()
      .from(schema.paymentIntents)
      .where(and(eq(schema.paymentIntents.tenantId, ctx.tenantId), eq(schema.paymentIntents.idempotencyKey, idempotencyKey)))
      .get();
    if (keyed) {
      if (keyed.requestHash !== hash) throw new AppError('IDEMPOTENCY_MISMATCH', 'This idempotency key was already used for a different request.');
      if (keyed.state !== 'failed' || keyed.providerLinkId) return keyed;
    }

    if (invoice.voided) throw conflict('This invoice is void, so there is nothing to collect.');
    const due = invoice.totalMinor - invoice.paidMinor;
    if (due <= 0) throw conflict('This invoice is already paid.');
    // Razorpay's minimum for INR links is ₹1.
    if (invoice.currency === 'INR' && due < 100) throw conflict('Razorpay payment links start at ₹1. Collect this balance at reception.');

    if (keyed) {
      markIntent(keyed, { state: 'created', failureCode: null, failureReason: null, amountMinor: due, expiresAt: now() + PAYMENT_LINK_TTL_MS });
      return { ...keyed, state: 'created', amountMinor: due, expiresAt: now() + PAYMENT_LINK_TTL_MS };
    }

    // One live link per invoice and amount: a second click shows the same link.
    const live = db
      .select()
      .from(schema.paymentIntents)
      .where(
        and(
          eq(schema.paymentIntents.tenantId, ctx.tenantId),
          eq(schema.paymentIntents.invoiceId, invoice.id),
          eq(schema.paymentIntents.channel, 'payment_link'),
          eq(schema.paymentIntents.state, 'processing'),
        ),
      )
      .all();
    const reusable = live.find((row) => row.amountMinor === due && (row.expiresAt ?? 0) > now() + 10 * MINUTE);
    if (reusable) return reusable;
    for (const stale of live) {
      if ((stale.expiresAt ?? 0) > now()) markIntent(stale, { state: 'superseded' });
    }

    const row: IntentRow = {
      id: id('pi'),
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      memberId: invoice.memberId,
      invoiceId: invoice.id,
      provider: provider.name,
      channel: 'payment_link',
      purpose: 'invoice',
      state: 'created',
      amountMinor: due,
      currency: invoice.currency,
      providerOrderId: null,
      providerPaymentId: null,
      providerLinkId: null,
      linkUrl: null,
      expiresAt: now() + PAYMENT_LINK_TTL_MS,
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

  if (intent.state !== 'created') return linkView(intent);

  const invoice = db.select({ number: schema.invoices.number }).from(schema.invoices).where(eq(schema.invoices.id, intent.invoiceId)).get()!;
  const tenant = db.select({ name: schema.tenants.displayName }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get();
  try {
    const link = await provider.createPaymentLink({
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      description: `${tenant?.name ?? 'Gym'} invoice ${invoice.number}`.slice(0, 2048),
      // ≤ 40 characters and unique per link; a fresh suffix per attempt.
      referenceId: `${intent.id}.${Date.now().toString(36)}`.slice(0, 40),
      expiresAtMs: intent.expiresAt!,
      notes: { tenant_id: intent.tenantId, intent_id: intent.id, invoice_id: intent.invoiceId },
    });
    return transact(() => {
      markIntent(intent, { state: 'processing', providerLinkId: link.id, linkUrl: link.shortUrl, expiresAt: link.expiresAtMs || intent.expiresAt });
      audit(ctx, {
        action: 'payment_link.created',
        entityType: 'invoice',
        entityId: intent.invoiceId,
        entityLabel: invoice.number,
        after: { intentId: intent.id, providerLinkId: link.id, amountMinor: intent.amountMinor, expiresAt: new Date(link.expiresAtMs || intent.expiresAt!).toISOString() },
      });
      return linkView(db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)).get()!);
    });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    transact(() => markIntent(intent, { state: 'failed', failureCode: `link_${error.kind}`, failureReason: error.description }));
    log('warn', 'razorpay_payment_link_failed', { intentId: intent.id, kind: error.kind, status: error.status });
    throw new AppError('PROVIDER_UNAVAILABLE', 'Razorpay could not create the link just now. Nothing was sent to the member. Try again in a moment.', { retryAfterSec: 10 });
  }
}
