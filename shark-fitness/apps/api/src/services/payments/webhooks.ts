import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, schema, transact } from '../../db/client.js';
import { AppError, invalid, precondition } from '../../lib/errors.js';
import { id } from '../../lib/ids.js';
import { log } from '../../lib/observability.js';
import { resolvePaymentProvider, type ProviderPayment } from '../../lib/payment-provider.js';
import { now } from '../../lib/time.js';
import { applyProviderPayment, captureOrRefetch } from './checkout.js';
import { toPayment, toRefund } from './razorpay.js';
import { applyRefundEvent } from './refunds.js';
import { LIVE_INTENT_STATES, recordFailedAttempt, type IntentRow, type IntentState } from './settlement.js';

/**
 * Razorpay webhooks (`POST /v1/webhooks/razorpay`).
 *
 * Razorpay delivers at least once, retries any non-2xx for 24 hours, and does
 * not promise order (docs/PAYMENTS-RAZORPAY.md). So:
 *
 * 1. The HMAC of the *raw* body is checked first, in constant time. A bad or
 *    missing signature is a 400 and a security log line; the body is not
 *    stored anywhere.
 * 2. The event is persisted to `provider_events` (unique per provider and
 *    `x-razorpay-event-id`) before anything acts on it. A redelivery of an
 *    event already processed is a 200 no-op; one whose processing failed is
 *    processed again.
 * 3. Handlers converge on state rather than replaying transitions: settlement
 *    is idempotent on the provider payment id, a failure never overrides
 *    success, and a refund seen before its capture settles the capture first.
 *    Any delivery order ends in the same place.
 */

export const HANDLED_EVENTS = new Set([
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.processed',
  'refund.failed',
  'payment_link.paid',
]);

/** 256 KiB is far above any documented Razorpay payload. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

type Json = Record<string, unknown>;

export interface WebhookOutcome {
  eventId: string;
  duplicate: boolean;
  handled: boolean;
}

function entity(payload: Json, key: string): Json | null {
  const holder = payload[key];
  if (!holder || typeof holder !== 'object') return null;
  const value = (holder as Json).entity;
  return value && typeof value === 'object' ? (value as Json) : null;
}

function findIntent(column: 'providerOrderId' | 'providerLinkId', value: string | null): IntentRow | undefined {
  if (!value) return undefined;
  return db
    .select()
    .from(schema.paymentIntents)
    .where(and(eq(schema.paymentIntents.provider, 'razorpay'), eq(schema.paymentIntents[column], value)))
    .get();
}

export async function handleRazorpayWebhook(input: {
  rawBody: string;
  signature: string | undefined;
  eventIdHeader: string | undefined;
  ip: string;
  requestId: string;
}): Promise<WebhookOutcome> {
  const provider = resolvePaymentProvider();
  if (!provider) throw precondition('Online payment is not configured on this server.');

  if (!input.signature || !provider.verifyWebhookSignature(input.rawBody, input.signature)) {
    // A security event, not an error report: counted, never stored.
    log('warn', 'security_razorpay_webhook_signature_invalid', {
      reason: input.signature ? 'mismatch' : 'missing',
      ip: input.ip,
      requestId: input.requestId,
      bytes: Buffer.byteLength(input.rawBody),
      eventId: input.eventIdHeader?.slice(0, 64) ?? null,
    });
    throw new AppError('SIGNATURE_INVALID', 'The webhook signature did not verify.');
  }

  let event: Json;
  try {
    event = JSON.parse(input.rawBody) as Json;
  } catch {
    throw invalid('The webhook body is not valid JSON.');
  }
  const type = typeof event.event === 'string' ? event.event : 'unknown';
  const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Json;
  const eventId = input.eventIdHeader?.trim().slice(0, 200) || `sha256:${createHash('sha256').update(input.rawBody).digest('hex')}`;

  const paymentEntity = entity(payload, 'payment');
  const orderEntity = entity(payload, 'order');
  const refundEntity = entity(payload, 'refund');
  const linkEntity = entity(payload, 'payment_link');
  const payment = paymentEntity ? toPayment(paymentEntity) : null;
  const orderId = payment?.orderId ?? (typeof orderEntity?.id === 'string' ? orderEntity.id : null);
  const intent =
    findIntent('providerLinkId', typeof linkEntity?.id === 'string' ? linkEntity.id : null) ?? findIntent('providerOrderId', orderId);
  const refund = refundEntity ? toRefund(refundEntity) : null;
  const refundRow = refund
    ? db
        .select({ tenantId: schema.refunds.tenantId })
        .from(schema.refunds)
        .where(and(eq(schema.refunds.provider, 'razorpay'), eq(schema.refunds.providerRefundId, refund.id)))
        .get() ??
      (refund.notes.refund_id
        ? db.select({ tenantId: schema.refunds.tenantId }).from(schema.refunds).where(eq(schema.refunds.id, refund.notes.refund_id)).get()
        : undefined)
    : undefined;
  // One Razorpay account serves this deployment; the tenant is whoever owns
  // the intent or refund the event is about. Events that match nothing here
  // are kept with an empty tenant.
  const tenantId = intent?.tenantId ?? refundRow?.tenantId ?? '';

  const stored = transact(() => {
    const existing = db
      .select()
      .from(schema.providerEvents)
      .where(and(eq(schema.providerEvents.provider, 'razorpay'), eq(schema.providerEvents.providerEventId, eventId)))
      .get();
    if (existing) return existing;
    const row = {
      id: id('pev'),
      tenantId,
      provider: 'razorpay',
      providerEventId: eventId,
      type,
      payload: event,
      signatureOk: true,
      receivedAt: now(),
      processedAt: null,
      processingError: null,
      intentId: intent?.id ?? null,
    };
    db.insert(schema.providerEvents).values(row).run();
    return row;
  });
  if (stored.processedAt !== null) return { eventId, duplicate: true, handled: HANDLED_EVENTS.has(type) };

  try {
    const note = await processEvent(type, intent, payment, refund);
    transact(() =>
      db.update(schema.providerEvents)
        .set({ processedAt: now(), processingError: note })
        .where(eq(schema.providerEvents.id, stored.id))
        .run(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    transact(() => db.update(schema.providerEvents).set({ processingError: message }).where(eq(schema.providerEvents.id, stored.id)).run());
    log('error', 'razorpay_webhook_processing_failed', { eventId, type, error: message });
    // Razorpay retries on any non-2xx; the stored event is processed again.
    throw new AppError('PROVIDER_UNAVAILABLE', 'The event could not be processed yet. It will be retried.', { retryAfterSec: 60 });
  }
  return { eventId, duplicate: false, handled: HANDLED_EVENTS.has(type) };
}

/** Act on one verified event. Returns a note for the event row (why nothing
 *  happened), or null. Provider calls only outside transactions. */
async function processEvent(
  type: string,
  intent: IntentRow | undefined,
  payment: ProviderPayment | null,
  refund: ReturnType<typeof toRefund> | null,
): Promise<string | null> {
  switch (type) {
    case 'payment.authorized': {
      if (!intent || !payment) return 'No matching payment intent.';
      // An attempt already retired (paid at the desk, voided, amount changed)
      // must not take the money: left uncaptured, Razorpay returns it to the
      // member by itself. Capturing it would only make a refund for staff.
      if (!LIVE_INTENT_STATES.includes(intent.state as IntentState)) return `Not captured: the attempt is ${intent.state}.`;
      // Accounts without auto-capture leave payments authorized; capture here
      // so the member is not left waiting for staff. A ProviderError
      // propagates, and Razorpay redelivers the event.
      const current = await captureOrRefetch(resolvePaymentProvider()!, payment);
      transact(() => applyProviderPayment(intent.id, current, 'webhook'));
      return null;
    }
    case 'payment.captured':
    case 'order.paid':
    case 'payment_link.paid': {
      if (!intent || !payment) return 'No matching payment intent.';
      transact(() => applyProviderPayment(intent.id, payment, 'webhook'));
      return null;
    }
    case 'payment.failed': {
      if (!intent || !payment) return 'No matching payment intent.';
      transact(() => recordFailedAttempt(intent.id, payment));
      return null;
    }
    case 'refund.processed':
    case 'refund.failed': {
      if (!refund) return 'No refund entity in the payload.';
      return transact(() => applyRefundEvent(type, refund, payment, intent));
    }
    default:
      return `Stored and acknowledged; ${type} is not acted on.`;
  }
}
