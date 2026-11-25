import { createHmac } from 'node:crypto';
import { constantTimeEqual } from '../../lib/crypto.js';
import { assertNoOpenTransaction } from '../../db/client.js';
import {
  ProviderError,
  type CreateOrderRequest,
  type CreatePaymentLinkRequest,
  type PaymentProvider,
  type ProviderOrder,
  type ProviderPayment,
  type ProviderPaymentLink,
  type ProviderRefund,
  type RefundRequest,
} from '../../lib/payment-provider.js';

/**
 * Razorpay adapter (test mode only; config refuses any key that is not
 * `rzp_test_…`).
 *
 * Plain `fetch` against the documented REST API with HTTP Basic auth, so there
 * is no SDK to pin, audit or keep in step. Field names follow Razorpay's API
 * reference (Orders, Payments, Refunds, Payment Links; see
 * docs/PAYMENTS-RAZORPAY.md for the pages). Every call:
 *
 * - refuses to run while a SQLite transaction is open — a slow provider must
 *   never hold the single write lock (PRD 05 §3, P02 acceptance 8);
 * - has a timeout, and reports it as `ProviderError('timeout')` so a caller
 *   can tell "Razorpay said no" from "we do not know what Razorpay did".
 */

export const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Production is always RAZORPAY_API_BASE; tests and the E2E harness point
   *  this at a loopback fake (config refuses any other host). */
  apiBase?: string;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 10_000;

export function createRazorpayProvider(credentials: RazorpayCredentials): PaymentProvider {
  const base = (credentials.apiBase ?? RAZORPAY_API_BASE).replace(/\/$/, '');
  const timeoutMs = credentials.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authorization = `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64')}`;

  async function call(method: 'GET' | 'POST', path: string, body?: Json, headers: Record<string, string> = {}): Promise<Json> {
    assertNoOpenTransaction('A Razorpay request');
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError('timeout', `Razorpay did not answer ${method} ${path} within ${timeoutMs} ms.`);
      }
      throw new ProviderError('network', `Razorpay could not be reached for ${method} ${path}.`);
    }

    const text = await response.text();
    let payload: Json;
    try {
      payload = text ? (JSON.parse(text) as Json) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const error = (payload.error ?? {}) as Json;
      throw new ProviderError('http', `Razorpay refused ${method} ${path} (${response.status}).`, {
        status: response.status,
        providerCode: typeof error.code === 'string' ? error.code : null,
        description: typeof error.description === 'string' ? error.description : null,
      });
    }
    return payload;
  }

  return {
    name: 'razorpay',
    keyId: credentials.keyId,

    async createOrder(request: CreateOrderRequest): Promise<ProviderOrder> {
      const entity = await call('POST', '/orders', {
        amount: request.amountMinor,
        currency: request.currency,
        receipt: request.receipt,
        notes: request.notes,
      });
      return toOrder(entity);
    },

    verifyCheckoutSignature({ orderId, paymentId, signature }) {
      // Razorpay: hmac_sha256(order_id + "|" + razorpay_payment_id, key_secret),
      // where order_id is *ours*, never the one the browser echoed back.
      const expected = createHmac('sha256', credentials.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
      return constantTimeEqual(expected, signature);
    },

    verifyWebhookSignature(rawBody: string, signature: string) {
      const expected = createHmac('sha256', credentials.webhookSecret).update(rawBody).digest('hex');
      return constantTimeEqual(expected, signature);
    },

    async fetchPayment(paymentId: string): Promise<ProviderPayment> {
      return toPayment(await call('GET', `/payments/${encodeURIComponent(paymentId)}`));
    },

    async fetchOrderPayments(orderId: string): Promise<ProviderPayment[]> {
      const page = await call('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
      return asItems(page).map(toPayment);
    },

    async capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<ProviderPayment> {
      return toPayment(await call('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountMinor, currency }));
    },

    async refundPayment(request: RefundRequest): Promise<ProviderRefund> {
      const entity = await call(
        'POST',
        `/payments/${encodeURIComponent(request.paymentId)}/refund`,
        { amount: request.amountMinor, speed: 'normal', receipt: request.receipt, notes: request.notes },
        // Documented for normal refunds: a retry with the same key and body
        // returns the first refund instead of creating a second one.
        { 'X-Refund-Idempotency': request.idempotencyKey },
      );
      return toRefund(entity);
    },

    async createPaymentLink(request: CreatePaymentLinkRequest): Promise<ProviderPaymentLink> {
      const entity = await call('POST', '/payment_links', {
        amount: request.amountMinor,
        currency: request.currency,
        accept_partial: false,
        description: request.description,
        reference_id: request.referenceId,
        expire_by: Math.floor(request.expiresAtMs / 1000),
        // Nothing is ever sent by Razorpay: staff copy the link and share it
        // themselves (P02 scope; PRD 04 consent rules for outbound messages).
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: request.notes,
      });
      return toPaymentLink(entity);
    },

    async fetchPaymentLink(linkId: string) {
      const entity = await call('GET', `/payment_links/${encodeURIComponent(linkId)}`);
      const payments = Array.isArray(entity.payments) ? (entity.payments as Json[]) : [];
      return { ...toPaymentLink(entity), paymentIds: payments.map((row) => str(row.payment_id)).filter((value): value is string => value !== null) };
    },

    async fetchPaymentsForReconciliation({ fromMs, toMs }): Promise<ProviderPayment[]> {
      const from = Math.floor(fromMs / 1000);
      const to = Math.floor(toMs / 1000);
      const all: ProviderPayment[] = [];
      // count is capped at 100 by the API; ten pages bounds one run.
      for (let skip = 0; skip < 1_000; skip += 100) {
        const page = asItems(await call('GET', `/payments?from=${from}&to=${to}&count=100&skip=${skip}`));
        all.push(...page.map(toPayment));
        if (page.length < 100) break;
      }
      return all;
    },
  };
}

function asItems(page: Json): Json[] {
  return Array.isArray(page.items) ? (page.items as Json[]) : [];
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const int = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) ? value : 0);
const notesOf = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
};

export function toOrder(entity: Json): ProviderOrder {
  return {
    id: str(entity.id) ?? '',
    amountMinor: int(entity.amount),
    currency: str(entity.currency) ?? '',
    status: str(entity.status) ?? 'created',
    receipt: str(entity.receipt),
  };
}

const PAYMENT_STATUSES = new Set(['created', 'authorized', 'captured', 'refunded', 'failed']);

export function toPayment(entity: Json): ProviderPayment {
  const status = str(entity.status) ?? 'created';
  return {
    id: str(entity.id) ?? '',
    orderId: str(entity.order_id),
    amountMinor: int(entity.amount),
    currency: str(entity.currency) ?? '',
    status: (PAYMENT_STATUSES.has(status) ? status : 'created') as ProviderPayment['status'],
    captured: entity.captured === true,
    method: str(entity.method),
    amountRefundedMinor: int(entity.amount_refunded),
    errorCode: str(entity.error_code),
    errorDescription: str(entity.error_description),
    errorReason: str(entity.error_reason),
    notes: notesOf(entity.notes),
    createdAtMs: int(entity.created_at) * 1000,
  };
}

export function toRefund(entity: Json): ProviderRefund {
  const status = str(entity.status);
  return {
    id: str(entity.id) ?? '',
    paymentId: str(entity.payment_id) ?? '',
    amountMinor: int(entity.amount),
    currency: str(entity.currency) ?? '',
    status: status === 'processed' || status === 'failed' ? status : 'pending',
    notes: notesOf(entity.notes),
  };
}

export function toPaymentLink(entity: Json): ProviderPaymentLink {
  return {
    id: str(entity.id) ?? '',
    shortUrl: str(entity.short_url) ?? '',
    status: str(entity.status) ?? 'created',
    referenceId: str(entity.reference_id),
    amountMinor: int(entity.amount),
    currency: str(entity.currency) ?? '',
    expiresAtMs: int(entity.expire_by) * 1000,
    notes: notesOf(entity.notes),
  };
}
