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

(filled in as work proceeds)

## Integration notes

(filled in as work proceeds)
