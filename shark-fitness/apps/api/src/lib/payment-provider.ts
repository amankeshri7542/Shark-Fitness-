/**
 * The payment provider boundary.
 *
 * There is no payment provider. This system *records* that cash or a card was
 * taken at a desk; it has never charged anybody, `payments.provider` is null
 * across every row, and `POST /billing/webhooks/demo` is a simulator that says
 * so in its own source.
 *
 * That fact needs a shape rather than a silence. Without one, the honest
 * answer — "this retry cannot be submitted, because nothing can submit it" —
 * has nowhere to come from, and the tempting alternative is a dunning worker
 * that marks an attempt "retried" when all it did was write a row. This module
 * is the seam: one interface, one resolver that currently returns null, and
 * one refusal that names the reason.
 *
 * Adding Razorpay, Cashfree or Stripe later is implementing `PaymentProvider`
 * and returning it from `resolvePaymentProvider`. Nothing in the dunning state
 * machine changes: it already asks for a provider, already handles not getting
 * one, and already records which of the two happened on the attempt.
 */

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

export interface PaymentProvider {
  readonly name: string;
  /**
   * Attempt to collect against an instrument the member has already
   * authorised. Returns whether the *submission* succeeded — never whether
   * money arrived. Settlement comes back on a webhook.
   */
  chargeStoredInstrument(request: ChargeRequest): ChargeResult;
}

/**
 * The configured provider, or null.
 *
 * Null today, deliberately and permanently until somebody integrates one.
 * There is no environment variable that turns a provider on, because there is
 * no adapter for it to turn on, and a config flag that enabled a provider that
 * does not exist would be the exact lie this module is here to prevent.
 */
export function resolvePaymentProvider(): PaymentProvider | null {
  return null;
}

/** The reason code written onto an attempt when there is nothing to submit to.
 *  A code rather than a sentence so the console and the tests can both match
 *  on it without depending on wording. */
export const NO_PROVIDER = 'no_payment_provider_configured';

/**
 * Ask the provider to retry a charge.
 *
 * The one function the dunning worker calls. It cannot return a success that
 * did not happen: with no provider configured there is no branch that produces
 * `submitted: true`.
 */
export function submitRetry(request: ChargeRequest): ChargeResult {
  const provider = resolvePaymentProvider();
  if (!provider) return { submitted: false, reason: NO_PROVIDER, provider: null };
  return provider.chargeStoredInstrument(request);
}
