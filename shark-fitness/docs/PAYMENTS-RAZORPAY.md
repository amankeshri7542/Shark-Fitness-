# Online payments with Razorpay (test mode)

Shark Fitness takes online payments through Razorpay. **This release runs in
Razorpay test mode only.** The API refuses to boot with any key id that does not
start `rzp_test_`, in every environment, so no real money can move until the
"Going live" checklist below has been worked through and a code change allows
live keys.

Without the Razorpay variables nothing changes from before: members see
"Pay at reception", staff record cash, card and UPI by hand, and every
online-payment endpoint answers `412` with the same message as before.

Design record: [ADR-003](ADR-003-payment-provider.md).

## What members and staff can do

| Who | What | Where |
|---|---|---|
| Member | Pay an open invoice ("Pay ₹… now") | App → Billing |
| Member | Choose a first plan, or renew an expired or cancelled one | App → Billing → Choose a plan / Renew |
| Staff (`billing.record_payment`) | Create a payment link for an open invoice and copy it | Console → Billing → invoice → Payment link |
| Staff (`billing.refund`) | Refund an online payment (full or partial) back through Razorpay | Console → Billing → invoice → Refund |
| Staff (`billing.view`) | See the Razorpay payment id, every attempt and its signed events, refund state | Console → Billing → invoice |
| Staff (`billing.refund`) | Resolve or ignore a reconciliation exception, with a reason | Console → Billing → Reconciliation |

Nothing is ever sent to a member by Razorpay or by us: payment links are
created with `notify.sms=false`, `notify.email=false` and `reminder_enable=false`,
and staff share them through whatever conversation they already have.

No card details, mandates or saved instruments are stored. There is no
automatic renewal or automatic retry of a failed charge (dunning says so on every
attempt: `no_stored_mandate`).

## Setting up test keys

1. Sign up at <https://dashboard.razorpay.com/> (no KYC is needed for test mode)
   and switch the Dashboard to **Test Mode**.
2. **Account & Settings → API Keys → Generate Test Key.** Copy the key id
   (`rzp_test_…`) and the key secret.
3. **Account & Settings → Webhooks → Add New Webhook:**
   - Webhook URL: `<SHARK_PUBLIC_ORIGIN>/v1/webhooks/razorpay`, for example
     `https://gym.example.com/v1/webhooks/razorpay`. Razorpay must be able to
     reach it over the internet; for a laptop, use a tunnel (see "Local
     testing").
   - Secret: a long random string you choose (`openssl rand -hex 24`). In
     production it must be at least 16 characters.
   - Active events — tick exactly these:
     `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`,
     `refund.processed`, `refund.failed`, `payment_link.paid`.
     Anything else Razorpay sends is stored and acknowledged, not acted on.
4. Set the server's environment (placeholders in `.env.example`):

   ```bash
   SHARK_PAYMENT_PROVIDER=razorpay
   SHARK_RAZORPAY_KEY_ID=rzp_test_…
   SHARK_RAZORPAY_KEY_SECRET=…
   SHARK_RAZORPAY_WEBHOOK_SECRET=…        # the one typed in step 3
   ```

   Boot refuses a missing secret, a live key, or an unknown provider name.
   `SHARK_RAZORPAY_API_BASE` exists only to point the adapter at a local fake
   (tests, E2E); it accepts `https://api.razorpay.com/v1` or a loopback URL and
   nothing else.
5. Payment capture: either leave the Dashboard's default (manual capture) or
   turn on automatic capture — both work. The server captures an `authorized`
   payment itself, on confirm, on the `payment.authorized` webhook, or in the
   reconciliation job.

One Razorpay account serves the whole deployment (the pilot is one gym).
Per-tenant credentials are a later enterprise item.

## How a payment flows

```
member taps Pay ──► POST /v1/member/billing/invoices/:id/checkout  (Idempotency-Key)
                     1. commit payment_intents row (created)
                     2. Razorpay POST /v1/orders              ← no DB transaction open
                     3. record order id (processing) and return {orderId, keyId, …}
app loads https://checkout.razorpay.com/v1/checkout.js and opens Checkout
Checkout success ──► POST /v1/member/billing/checkout/:intentId/confirm
                     verify HMAC_SHA256(order_id|payment_id, key_secret) on OUR order id
                     Razorpay GET /v1/payments/:id  (server to server)
                     authorized → capture; captured → settle; otherwise wait
Razorpay ─────────► POST /v1/webhooks/razorpay  (signed)  → settle / fail / refund
every 6 h ────────► reconcile-payments job asks Razorpay about anything stuck
```

- **Only a captured payment settles**, and only once: the `payments` row is
  unique on `(provider, provider_ref)` for Razorpay, and every path (confirm,
  webhook, reconciliation) goes through the same idempotent settlement.
- **Settlement is the existing path** (`settleInvoicePayment`): payment row,
  receipt, invoice state, dunning stopped, a `pending_payment` membership
  activated, audit (`payment.settled_by_provider`, actor `system:razorpay`) and
  realtime `payment.succeeded`.
- **Mismatches never settle.** A captured amount or currency that differs from
  the attempt, or money for an invoice already settled at the desk (or void),
  opens a reconciliation exception, and the member is told the payment is
  "being checked — do not pay again".
- **No provider call ever runs inside a database transaction** (the adapter
  refuses, and the tests check every call).
- The app waits for the server's word: realtime `payment.succeeded` /
  `invoice.updated`, with a 2-second status poll as fallback.
- **Retries are safe.** The same Idempotency-Key returns the same attempt and
  order; one live order exists per invoice and amount, so a second tap or tab
  resumes it rather than creating another. A timed-out order creation leaves the
  attempt `failed` with no payment, and the same key tries again.

### Webhooks

- Signature: HMAC-SHA256 of the **raw** body with the webhook secret, compared
  in constant time against `X-Razorpay-Signature`. Missing or wrong → `400`, a
  `security_razorpay_webhook_signature_invalid` log line (no body), nothing
  stored.
- Each event is stored in `provider_events` (unique per `x-razorpay-event-id`)
  before it is acted on. A redelivery of a processed event is a `200` no-op; one
  whose processing failed is processed again (we answer `503` so Razorpay
  retries; it retries for 24 hours).
- Razorpay does not guarantee order, and documents `payment.failed` arriving
  after `payment.captured`. Handlers converge on state: a failure never undoes a
  success; a capture seen by the webhook before the member's confirm makes the
  confirm a no-op; a refund seen before its capture settles the capture first.
- Bodies over 256 KiB are refused (`413`). The route is exempt from the
  browser CSRF/Origin checks and rate-limited per IP (300/min).

### Refunds

A refund of a Razorpay payment goes back through Razorpay. The refund row is
committed `pending` first, then Razorpay is called with our refund id as the
`X-Refund-Idempotency` key (so a retry cannot refund twice). It stays
**pending** until `refund.processed` makes it `succeeded` — only then does the
invoice's refunded total move and, if staff asked, the membership get reversed.
`refund.failed` marks it `failed` and the amount is refundable again. Partial
refunds are bounded by captured minus refunded minus still-pending. Refunds made
in the Razorpay Dashboard are recorded when their webhook arrives and raise a
`refund_outside_console` exception so staff decide about the membership.
Manual (desk) payments keep the manual refund path. Credit-pack refunds stay
refused until P05.

### Payment links

`POST /v1/admin/billing/invoices/:id/payment-link` (Idempotency-Key) creates a
standard Razorpay link for the amount due, valid for 7 days (Razorpay's minimum
is 15 minutes; the default and maximum is six months). A second request for the
same invoice and amount returns the same live link. `payment_link.paid` settles
the invoice. Razorpay limits test mode to 30 payment links per business.

### Reconciliation

The `reconcile-payments` job runs every 6 hours (recorded in `job_runs`, visible
on Platform → Health). It re-fetches every attempt still `processing` 15 minutes
after its last change (up to 7 days old) and every payment Razorpay recorded in
the last 48 hours, captures authorized ones, settles captured ones, and opens an
exception for captured money that matches nothing here but names one of our
tenants. Two overlapping runs settle once. Without a provider it records a
no-op run.

`GET /v1/admin/billing/reconciliation?state=open|resolved|ignored|all` lists
exceptions; `POST /v1/admin/billing/reconciliation/:id/resolve`
`{action: "resolve"|"ignore", reason}` closes one (reason required, audited).
Nothing there moves money: use Refund or Record payment for that.

## Local testing

**Automated, no Razorpay account needed.** The integration tests and the E2E
spec use a local fake of Razorpay's API (`apps/api/src/testing/razorpay-fake.ts`)
and signed fixtures in the documented webhook shapes
(`apps/api/fixtures/razorpay/*.json`). Any request to the internet fails them.

```bash
pnpm -F @shark/api test -- razorpay          # config, checkout, webhooks, refunds, links, reconciliation
pnpm build && pnpm e2e -- --grep "@payments"  # member pays on a Pixel 7 viewport
```

**Signing a webhook by hand** against a local API started with the Razorpay
variables:

```bash
SHARK_RAZORPAY_WEBHOOK_SECRET=<same as the API> \
  pnpm -F @shark/api razorpay:webhook -- payment.captured \
  --order order_… --payment pay_… --amount 29500 [--url http://localhost:8787/v1/webhooks/razorpay]
```

The tool refuses any URL that is not on this machine. Fixture names:
`payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`,
`refund.processed`, `refund.failed`, `payment_link.paid`,
`payment.dispute.created` (an event we store but do not act on).

**Against Razorpay's real test mode** from a laptop: run the API with your test
keys, expose port 8787 with a tunnel (for example `cloudflared tunnel --url
http://localhost:8787`), and use the tunnel URL as the webhook URL in the
Dashboard. Pay with Razorpay's test instruments: the UPI ids `success@razorpay`
and `failure@razorpay`, the netbanking/wallet mock page's Success and Failure
buttons, and the test cards listed on Razorpay's
[integration steps](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
and [test card details](https://razorpay.com/docs/payments/payments/test-card-details/)
pages. (Card numbers are deliberately not copied here.)

## Content-Security-Policy (for P06)

The member app loads Checkout on demand, only when the member pays, only from
`https://checkout.razorpay.com/v1/checkout.js`. Razorpay does not publish a CSP
list for Standard Checkout; the documented origins are:

| Directive | Origin | Source |
|---|---|---|
| `script-src` | `https://checkout.razorpay.com` | the Checkout script URL |
| `frame-src` | `https://api.razorpay.com`, `https://checkout.razorpay.com` | Checkout renders in an iframe |
| `connect-src` | `https://api.razorpay.com` | Razorpay API host |

Checkout is also commonly reported to reach `https://lumberjack.razorpay.com`
(telemetry, `connect-src`) and `https://cdn.razorpay.com` (images,
`img-src`). These are **not** in Razorpay's docs; confirm them from the browser's
network log in test mode (P06 runs its E2E with a CSP-violation listener) before
enforcing. The server never needs inbound or outbound CSP: it calls
`https://api.razorpay.com/v1` only.

The member app's `Cross-Origin-Opener-Policy: same-origin` header may need to
become `same-origin-allow-popups` if a payment method (some netbanking and
wallet flows) opens a popup window; verify in test mode with each method.

## Going live — checklist for the gym owner

Live mode is out of scope for this release. To go live, all of these:

1. Complete Razorpay KYC and activation for the business; agree MDR/pricing.
2. Decide the settlement account and the settlement cycle in the Dashboard.
3. Generate **live** keys; store them only in the server's secret store.
4. A code change (reviewed) that allows `rzp_live_` key ids in production only
   (`lib/config.ts`, `RAZORPAY_TEST_KEY_PATTERN`) — deliberately not a flag.
5. Add a live-mode webhook with the same seven events and a new secret.
6. Run one real low-value payment, refund it, and check the receipt, the invoice
   drawer, `job_runs` for `reconcile-payments`, and the Dashboard agree.
7. Have the accountant confirm receipt and GST invoice wording for online
   payments, and the refund policy shown to members.
8. Turn on alerts for `security_razorpay_webhook_signature_invalid`,
   `razorpay_webhook_processing_failed`, `payment_reconciliation_exception`
   and failed `reconcile-payments` runs (docs/OPERATIONS-ALERTS.md).
9. Settle the CSP origins above with enforcement on (P06).

## Razorpay documentation used

Payload shapes and behaviour were taken from Razorpay's docs (read 25 Nov 2026),
not from memory:

- Orders: <https://razorpay.com/docs/api/orders/create/>
- Payments, fetch / capture / list: <https://razorpay.com/docs/api/payments/fetch-with-id/>,
  <https://razorpay.com/docs/api/payments/capture/>, <https://razorpay.com/docs/api/payments/fetch-all-payments/>
- Refunds (incl. `X-Refund-Idempotency`): <https://razorpay.com/docs/api/refunds/create-normal/>
- Payment Links: <https://razorpay.com/docs/api/payments/payment-links/create-standard/>
- Webhooks, validation and best practices: <https://razorpay.com/docs/webhooks/validate-test/>,
  <https://razorpay.com/docs/webhooks/best-practices/>
- Webhook payloads: <https://razorpay.com/docs/webhooks/payments/>, <https://razorpay.com/docs/webhooks/orders/>,
  <https://razorpay.com/docs/webhooks/refunds/>, <https://razorpay.com/docs/webhooks/payment-links/>
- Standard Checkout and signature verification:
  <https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/>
- Late authorisation and auto-refunds: <https://razorpay.com/docs/payments/payments/late-authorisation/>,
  <https://razorpay.com/docs/payments/refunds/auto-refunds/>
