# ADR-003: Payment provider port — Razorpay first, Stripe as a contract only, no mandates

- **Status:** Accepted
- **Date:** 2026-11-25
- **Decision owners:** Shark Fitness engineering (P02)

## Context

PRD 01 (PF-BILL-002/003/004/006, §4.6 "Razorpay adapter for cards, UPI …,
UPI payment-link support"), PRD 02 ("Payments", Phase 3) and PRD 04 §10.4
require a hosted payment provider. Until now the system only *recorded* money
staff had received: `lib/payment-provider.ts` was a synchronous port whose
resolver always returned null, and member checkout answered 412.

The invoice, per-line GST, idempotent settlement, dunning, grace and receipt
machinery already existed and is trusted. The decision is how to connect a
provider without weakening any of it.

## Decision

1. **One port, `PaymentProvider`, in `lib/payment-provider.ts`.** Network
   operations are async (`createOrder`, `fetchPayment`, `fetchOrderPayments`,
   `capturePayment`, `refundPayment`, `createPaymentLink`, `fetchPaymentLink`,
   `fetchPaymentsForReconciliation`); signature checks
   (`verifyCheckoutSignature`, `verifyWebhookSignature`) are pure HMAC and stay
   synchronous. `resolvePaymentProvider()` returns an adapter only when
   `SHARK_PAYMENT_PROVIDER=razorpay` and every credential is set; otherwise null,
   and every caller keeps its previous refusal word for word.
2. **Razorpay is the first and only adapter** (`services/payments/razorpay.ts`),
   written against the REST API with `fetch` and Basic auth — no SDK. It is the
   provider the PRDs name for India, it supports cards, UPI, netbanking, wallets
   and payment links, and test mode needs no KYC.
3. **Test mode only in this engagement.** Config refuses any key id that does
   not start `rzp_test_`, in every environment. Allowing live keys is a reviewed
   code change, not a flag (docs/PAYMENTS-RAZORPAY.md "Going live").
4. **One account per deployment**, from env. The pilot is one gym; encrypted
   per-tenant credentials are a later enterprise item.
5. **Commit, call, record.** Every flow commits a `payment_intents` row before
   calling the provider and records the outcome in a second transaction. The
   adapter refuses to run while a SQLite transaction is open: a slow provider
   must never hold the single writer.
6. **One settlement path.** Provider money settles through the same
   `settleInvoicePayment` staff payments use (receipt, dunning stop, membership
   activation, audit, realtime), as actor `system:razorpay`, only for a
   captured payment confirmed server-to-server or by a signed webhook, at most
   once (unique `(provider, provider_ref)`). Anything that does not match opens
   a reconciliation exception; money is never moved to make one go away.
7. **No stored instruments and no mandates.** No saved cards, UPI Autopay or
   eMandate. Dunning keeps `automaticCollection.available=false` and, with a
   provider connected, records `no_stored_mandate` instead of
   `no_payment_provider_configured`. `submitRetry` stays synchronous and never
   touches the network, so the dunning worker's outcome codes without a provider
   are unchanged.
8. **Stripe: contract only.** No Stripe code. The port's shapes are
   provider-neutral (orders ≈ PaymentIntents, payment links ≈ Payment Links,
   webhook signature verification over the raw body, refunds with idempotency
   keys), so a Stripe adapter is an implementation of `PaymentProvider` plus a
   webhook route, and `SHARK_PAYMENT_PROVIDER` gains a value. The
   `provider` column is already on payments, refunds, intents and events.

## Consequences

- Members can pay open invoices and buy or renew plans in the app; staff can
  issue payment links and provider refunds; a 6-hourly job reconciles what
  webhooks missed. All of it is covered by tests against a local fake of
  Razorpay's API that fail on any outbound request.
- Recurring billing still needs a member to pay each term. Adding mandates
  (UPI Autopay / eMandate) is a new decision: it needs stored-instrument
  consent, RBI e-mandate rules (pre-debit notifications), and a
  `chargeStoredInstrument` operation on the port.
- Checkout.js runs third-party script in the member app; P06's CSP must allow
  its origins (docs/PAYMENTS-RAZORPAY.md lists them).

## Revisit when

- The gym is ready to go live (KYC done, live keys issued).
- A second gym needs its own Razorpay account (per-tenant credentials).
- Members ask for automatic renewal (mandates), or a non-INR market needs
  Stripe.
