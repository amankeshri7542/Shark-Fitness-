/**
 * The payment provider boundary.
 *
 * One port, one resolver, and the refusals that name their reason.
 *
 * `resolvePaymentProvider()` returns the Razorpay adapter only when
 * `SHARK_PAYMENT_PROVIDER=razorpay` and every credential is configured (and
 * config has already refused anything but a `rzp_test_` key). Otherwise it
 * returns null, and every caller keeps today's honest answer: member checkout
 * refuses with 412, staff record independently received funds, dunning writes
 * `no_payment_provider_configured` on each attempt.
 *
 * Network methods are async and must never run inside `transact()` — the
 * adapter refuses (db/client.ts `assertNoOpenTransaction`). The pattern is:
 * commit an intent, call the provider, record the outcome in a new
 * transaction. Signature checks are pure HMAC and stay synchronous.
 *
 * There are no stored instruments (no mandates, no saved cards, no UPI
 * Autopay), so nothing here can charge a member who is not present. Dunning
 * still asks — `submitRetry` — and is told why not.
 */

import { runtimeConfig } from './config.js';
import { createRazorpayProvider } from '../services/payments/razorpay.js';

export interface CreateOrderRequest {
  amountMinor: number;
  currency: string;
  /** ≤ 40 characters, unique per order (Razorpay treats it as an idempotency key). */
  receipt: string;
  notes: Record<string, string>;
}

export interface ProviderOrder {
  id: string;
  amountMinor: number;
  currency: string;
  /** created | attempted | paid */
  status: string;
  receipt: string | null;
}

export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';

export interface ProviderPayment {
  id: string;
  orderId: string | null;
  amountMinor: number;
  currency: string;
  status: ProviderPaymentStatus;
  /** True once money was captured, including after a later refund. */
  captured: boolean;
  method: string | null;
  amountRefundedMinor: number;
  errorCode: string | null;
  errorDescription: string | null;
  errorReason: string | null;
  notes: Record<string, string>;
  createdAtMs: number;
}

export interface RefundRequest {
  paymentId: string;
  amountMinor: number;
  /** 10+ characters of [A-Za-z0-9_-]; a retry with the same key and body returns the first refund. */
  idempotencyKey: string;
  receipt: string;
  notes: Record<string, string>;
}

export interface ProviderRefund {
  id: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  status: 'pending' | 'processed' | 'failed';
  notes: Record<string, string>;
}

export interface CreatePaymentLinkRequest {
  amountMinor: number;
  currency: string;
  description: string;
  /** ≤ 40 characters, unique per link. */
  referenceId: string;
  expiresAtMs: number;
  notes: Record<string, string>;
}

export interface ProviderPaymentLink {
  id: string;
  shortUrl: string;
  /** created | partially_paid | expired | cancelled | paid */
  status: string;
  referenceId: string | null;
  amountMinor: number;
  currency: string;
  expiresAtMs: number;
  notes: Record<string, string>;
}

export interface PaymentProvider {
  readonly name: 'razorpay';
  /** Public key id handed to the browser for Checkout. Never the secret. */
  readonly keyId: string;
  createOrder(request: CreateOrderRequest): Promise<ProviderOrder>;
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
  fetchOrderPayments(orderId: string): Promise<ProviderPayment[]>;
  capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<ProviderPayment>;
  refundPayment(request: RefundRequest): Promise<ProviderRefund>;
  createPaymentLink(request: CreatePaymentLinkRequest): Promise<ProviderPaymentLink>;
  fetchPaymentsForReconciliation(window: { fromMs: number; toMs: number }): Promise<ProviderPayment[]>;
}

/** What went wrong talking to the provider. `timeout` and `network` mean the
 *  outcome is unknown; `http` means the provider answered and refused. */
export class ProviderError extends Error {
  readonly kind: 'timeout' | 'network' | 'http';
  readonly status: number | null;
  readonly providerCode: string | null;
  readonly description: string | null;

  constructor(
    kind: ProviderError['kind'],
    message: string,
    details: { status?: number; providerCode?: string | null; description?: string | null } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = details.status ?? null;
    this.providerCode = details.providerCode ?? null;
    this.description = details.description ?? null;
  }
}

let configured: PaymentProvider | null | undefined;
let override: PaymentProvider | null | undefined;

/** The configured provider, or null. */
export function resolvePaymentProvider(): PaymentProvider | null {
  if (override !== undefined) return override;
  if (configured === undefined) {
    configured = runtimeConfig.payments ? createRazorpayProvider(runtimeConfig.payments.razorpay) : null;
  }
  return configured;
}

/** Tests install an adapter pointed at a local fake server (or null), and
 *  pass `undefined` to go back to configuration. */
export function setPaymentProviderForTests(provider: PaymentProvider | null | undefined): void {
  override = provider;
}

/** The reason code written onto an attempt when there is nothing to submit to.
 *  A code rather than a sentence so the console and the tests can both match
 *  on it without depending on wording. */
export const NO_PROVIDER = 'no_payment_provider_configured';

/** A provider is connected, but the member has no stored mandate or saved
 *  instrument, so there is nothing it could charge without them present. */
export const NO_STORED_MANDATE = 'no_stored_mandate';

export interface ChargeRequest {
  tenantId: string;
  invoiceId: string;
  memberId: string;
  amountMinor: number;
  currency: string;
  /** Stable per logical retry, so a provider that supports it can dedupe. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { submitted: true; providerRef: string; provider: string }
  /** The provider was asked and refused, or is not there to ask. */
  | { submitted: false; reason: string; provider: string | null };

/**
 * Ask the provider to retry a charge.
 *
 * The one function the dunning worker calls. It cannot return a success that
 * did not happen, and it never touches the network: an automatic retry needs a
 * stored mandate (UPI Autopay, eMandate, saved card), and this product stores
 * none (ADR-003). With no provider the code is `no_payment_provider_configured`
 * exactly as before; with Razorpay connected it is `no_stored_mandate`, and the
 * member is pointed at Pay now in the app or a payment link instead.
 */
export function submitRetry(_request: ChargeRequest): ChargeResult {
  const provider = resolvePaymentProvider();
  if (!provider) return { submitted: false, reason: NO_PROVIDER, provider: null };
  return { submitted: false, reason: NO_STORED_MANDATE, provider: provider.name };
}
