# Razorpay webhook fixtures

Signed and posted by the integration tests (`src/__tests__/razorpay-*.test.ts`),
the E2E payments spec, and the dev tool:

```bash
pnpm -F @shark/api razorpay:webhook -- payment.captured --order order_… --payment pay_… --amount 29500
```

Each file is one webhook body in the shape Razorpay documents: the `event`
envelope (`entity`, `account_id`, `event`, `contains`, `payload`, `created_at`)
with the sub-entities each event carries (Webhooks → Payments, Orders, Refunds,
Payment Links in Razorpay's docs; see docs/PAYMENTS-RAZORPAY.md for the pages).
Ids, amounts and notes are placeholders; tests and the tool overwrite them.
The contact number and email are fictitious, and no card data appears here.
