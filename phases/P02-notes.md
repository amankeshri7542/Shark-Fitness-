# P02 notes — Razorpay payments in test mode

Branch `phase/P02-payments-razorpay`, from `phase/P01-prod-readiness` (128aec1). Worktree `/workspace/sf-wt/P02`. Node 22 from `/home/box/opt/node22`, pnpm 10.28.0.

## Plan

1. **Dead code first** (behaviour-neutral, proves the baseline): delete the four shadowed handlers in `routes/admin/billing.ts` (payments, void, refund, assign-plan) and the duplicate `validateMembershipProduct`/`createMembershipPurchase` in `services/billing-stabilization.ts`. Run the API suite.
2. **Config + port**: `SHARK_PAYMENT_PROVIDER`, `SHARK_RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`, `SHARK_RAZORPAY_API_BASE` (loopback-only override for fakes). Key id must start `rzp_test_` in every environment. `lib/payment-provider.ts` grows the async port; `resolvePaymentProvider()` returns the adapter only when fully configured. `submitRetry` stays synchronous (no stored mandates exist, so dunning never calls the network); with Razorpay configured it reports `no_stored_mandate`.
3. **Schema** (one migration, drizzle-kit generated): `payment_intents`, `payment_reconciliation_exceptions`, provider columns on `refunds`, a partial unique index on `payments(provider, provider_ref)` for Razorpay rows. `provider_events` reused.
4. **Adapter** `services/payments/razorpay.ts`: fetch + Basic auth + timeout, typed errors, runtime guard that refuses to run inside an open SQLite transaction.
5. **Settlement**: extract the core of `applyPaymentToInvoice` into one `settleInvoicePayment` used by the manual path and the provider path (`system:razorpay` actor). Provider settlement is idempotent on provider payment id; amount/currency mismatch or an already-settled invoice opens a reconciliation exception instead.
6. **Member checkout API**: invoice checkout, confirm (signature + server fetch + capture of authorized), status poll, plans list, plan purchase/renewal → invoice → same checkout.
7. **Webhook** `POST /v1/webhooks/razorpay`: raw-body HMAC, event persisted before processing, duplicates no-op, out-of-order safe.
8. **Refunds** through the provider (pending → processed/failed), **payment links**, **reconciliation** job + admin endpoints.
9. **Member PWA**: checkout hook (on-demand Checkout.js), Pay now / plans / confirmation sheet / states; Book drop-in confirmation.
10. **Admin**: invoice drawer provider details + timeline + refund state, payment link action, Reconciliation panel.
11. **E2E** `@payments` spec on a mobile project with a fake Razorpay API started by global setup.
12. Docs: `docs/PAYMENTS-RAZORPAY.md`, ADR-003, `.env.example`, PRODUCTION-READINESS §7, dev webhook tool.

## Checklist (mirrors P02-progress.json)

1. AC1 — no provider env: existing billing/provider-truthfulness tests unchanged and green; member checkout 412.
2. AC2 — config refuses `rzp_live_` (dev/test/prod) and `SHARK_PAYMENT_PROVIDER=razorpay` with a missing secret.
3. AC3 — checkout integration tests against a fake Razorpay server (a–f), unexpected outbound requests fail.
4. AC4 — webhook tests (each event, duplicate, tampered, missing signature, out-of-order, captured-before-confirm, amount mismatch, unknown).
5. AC5 — refund tests (full, partial, over-refund, refund.failed, manual unchanged).
6. AC6 — payment link test (notify flags false; payment_link.paid settles).
7. AC7 — reconciliation job test (double concurrent run settles once; mismatch listed; resolve needs reason + audit).
8. AC8 — no provider call inside `transact()` (runtime guard + test).
9. AC9 — member PWA component tests for all checkout states; Playwright mobile `@payments` spec (Paid + receipt, reload does not offer pay).
10. AC10 — admin component tests: payment link action, reconciliation panel (loading/empty/error/permission).
11. AC11 — shadowed handlers and duplicate services removed; one `createMembershipPurchase`.
12. AC12 — docs, ADR-003, `.env.example`, PRODUCTION-READINESS §7; standard gates + `pnpm e2e` green.
13. Member plan purchase/renewal via checkout (eligibility + expired/cancelled-only renewal).
14. Dev tool `pnpm -F @shark/api razorpay:webhook`.
15. Screenshots in `phases/P02-screens/`, PR description `pr/P02.md`.

## Decisions and assumptions

- **Signature checks stay synchronous.** The spec lists `verifyCheckoutSignature`/`verifyWebhookSignature` among the async port methods; they are pure HMAC, so they are sync. Every network method is async. The port also gained `fetchOrderPayments` and `fetchPaymentLink` (reconciliation needs them).
- **Dunning never touches the network.** No stored mandates exist, so `submitRetry` stays synchronous: `no_payment_provider_configured` without a provider (byte-for-byte as before), `no_stored_mandate` with Razorpay. `automaticCollection.available` stays false with honest copy for both cases.
- **Live keys:** refused by allow-list (`/^rzp_test_[A-Za-z0-9]+$/`) in every environment, even with `SHARK_PAYMENT_PROVIDER=none`. Going live needs a reviewed code change, not a flag.
- **`SHARK_RAZORPAY_API_BASE`** (new) only accepts `https://api.razorpay.com/v1` or a loopback URL, so tests/E2E can use a fake without the key secret ever going to another host. Production webhook secret ≥ 16 chars.
- **Intent states:** created → processing → succeeded | failed | expired/superseded | needs_review. `needs_review` is new: a captured payment that does not match (amount, currency, invoice already settled/void) opens a reconciliation exception and the member is told not to pay again.
- **One live order per invoice and amount**: a second tap/tab/key resumes the same order instead of creating a second payable one; if the amount owed changes, old attempts are superseded.
- **Order `receipt`/link `reference_id`** get a per-attempt suffix (Razorpay treats `receipt` as an idempotency key and rejects duplicates; an order created during a timed-out attempt is simply never paid).
- **Refund idempotency** uses our refund id as `X-Refund-Idempotency`. Refunds stay `pending` until `refund.processed` (even if Razorpay's response already says processed), per the spec. Entitlement reversal for a provider refund happens when it is processed, not when requested (no money back → no reversal). A reversal failure is logged and does not block the refund.
- **Dashboard refunds** (not started here) are recorded from the signed webhook and raise `refund_outside_console`; if the capture was never seen, the payment is settled first from the signed payload, so any delivery order converges.
- **Webhook tenant:** one Razorpay account per deployment; tenant comes from the intent/refund the event routes to. Unrouted events are stored with `tenant_id = ''` (provider_events.tenant_id is NOT NULL and existing). `provider_events.intent_id` added for the invoice timeline.
- **Unconfigured webhook endpoint answers 412** (consistent with the member endpoints).
- **Processing failure → 503** so Razorpay retries; a stored event with `processed_at` null is reprocessed on redelivery, a processed one is a 200 no-op.
- **Retired `/checkout-intent` endpoints kept** returning 412 always (the existing boundary tests call them unchanged); the new endpoints are `/invoices/:id/checkout` and `/checkout/:intentId/confirm`.
- **New error code `SIGNATURE_INVALID` → 400** in `@shark/contracts` (additive): the spec wants 400 for bad signatures and no existing code mapped to 400.
- **Member plan purchase** creates the invoice only after the member confirms in a sheet showing price, GST, total, term and cancellation terms; eligibility approval is never assumed for a member (requires-approval and corporate-only plans are not offered). An abandoned purchase leaves a pending plan + open invoice, exactly as reception assignment would; it can be paid later or voided by staff.
- **Drop-in fees** are recorded on the booking and collected at reception (no invoice exists), so Book's new confirmation says so; paying drop-ins online would need a drop-in invoice — follow-up.
- **Reconciliation permissions:** list needs `billing.view`; resolve/ignore needs `billing.refund` (owner, regional manager, accountant). Exceptions with no branch are visible to everyone with billing.view in the tenant.
- **Scheduler** now records async jobs when their promise settles and never overlaps a run of the same job in one process; sync jobs behave exactly as before (a regression I introduced in bookkeeping-on-failure was caught by the existing scheduler test and fixed).
- **Removed dead code:** the four shadowed handlers in `routes/admin/billing.ts` (payments, void, refund, assign-plan) and the unused `validateMembershipProduct`/`createMembershipPurchase` copies in `services/billing-stabilization.ts`. No tests were deleted (API suite 889/889 before and after).
- **`pnpm e2e -- --grep …`** did not reach Playwright (pnpm forwards the literal `--`); `e2e/run.mjs` drops a leading `--`.
- No new dependencies.

## Integration notes

- **P06 (CSP):** member app needs `script-src https://checkout.razorpay.com`, `frame-src https://api.razorpay.com https://checkout.razorpay.com`, `connect-src https://api.razorpay.com`. Commonly also `connect-src https://lumberjack.razorpay.com` and `img-src https://cdn.razorpay.com` — not in Razorpay's docs; confirm in test mode. COOP `same-origin` may need `same-origin-allow-popups` for popup-based payment methods. The apps also load Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) today — seen in the E2E network log. `/v1/webhooks/*` is exempt from CSRF/Origin (lib/security.ts `WEBHOOK_PATH_PREFIX`); P06 outbound webhooks are a different direction.
- **P06 (step-up):** provider refunds go through the existing `POST /v1/admin/billing/payments/:id/refund` (branch in routes/admin/billing-stabilization.ts); step-up should wrap that route once for both manual and provider refunds. Reconciliation resolve and payment-link creation are candidates too.
- **P04 (member app at /app/):** `e2e/specs/member-payments.spec.ts` navigates to `/billing` and `signInToMemberApp` uses `/`; move to `/app/billing`. Receipt links use `API_ORIGIN + /v1/...` (unaffected). Checkout.js is loaded at runtime, never precached — keep it out of the service worker's precache and runtime caching. The new `ui/Sheet.tsx` portals into `.sf-device` (falls back to `body`) — check after the responsive shell change.
- **P03 (website):** link plan purchase to the member app Billing screen (`/billing`, later `/app/billing`); `GET /v1/member/billing/plans` lists what a signed-in member can buy. Purchase needs a member session.
- **P05 (credit packs):** create the pack's invoice with your own service (refType for the pack), then call `startInvoiceCheckout(ctx, invoiceId, key, 'credit_pack')` from `services/payments/checkout.ts` (or the member route `POST /v1/member/billing/invoices/:id/checkout`). Allocate credits inside `settleInvoicePayment` (services/billing.ts) — the single settlement path used by both desk and Razorpay — when the invoice becomes fully paid. Credit-product refunds are still refused by `assertRefundableProduct` (shared by manual and provider refunds); replace that guard with the decided policy.
- **Shared files touched (additions):** `app.ts` (webhook mount + rate limit, admin payment routes mount), `lib/security.ts` (webhook exemption), `lib/config.ts` (5 vars), `.env.example`, `packages/contracts/src/envelope.ts` (`SIGNATURE_INVALID`), `db/schema/index.ts` + `drizzle.config.ts` (payments.ts), `db/seed-tables.ts`, `jobs/scheduler.ts` (async jobs + `reconcile-payments`), `e2e/global-setup.ts`, `e2e/playwright.config.ts` (mobile project for `@payments`), `e2e/package.json`.
- **Migration:** one file, `infrastructure/migrations/0018_razorpay_payments.sql` (+ snapshot/journal). Renumber at merge if another phase also adds 0018.
- **Seed:** Rohit's seeded failed card payment is labelled `provider: razorpay` in the existing seed; the console now shows its ref as "Razorpay payment …". It is demo data, not from this integration (P12 demo-data pass may relabel it).

## E2E specs P08 should extend

- Plan purchase from Billing (Choose a plan / Renew) through the stub Checkout.
- Failed then retried payment; dismissed window.
- Admin: create payment link → `payment_link.paid` webhook → drawer shows paid; provider refund → `refund.processed` → refunded; reconciliation resolve.
