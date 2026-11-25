# P02 independent review: Razorpay payments in test mode

Reviewer: independent senior review (did not write the code). Branch `phase/P02-payments-razorpay`, reviewed from `6b6264c` (implementer's last commit) against `phase/P01-prod-readiness`. Node 22, worktree `/workspace/sf-wt/P02`.

## Verdict

**Ready for PR, with known issues listed below.** The design is sound: an async port, a fetch adapter that refuses to run inside a transaction, intents committed before any provider call, one idempotent settlement path, raw-body HMAC webhooks stored before processing, convergent out-of-order handling, and an honest no-provider path. The tests are real: the harness fails on any non-loopback request, any route the fake does not serve, and any provider call inside `transact()`.

I found four real-money and data-integrity bugs around retries, retired attempts and refunds, plus a fail-open list and a flaky P01 test. All are fixed on the branch, each with a regression test that fails before the fix and passes after.

## How I checked

- Read the spec, notes, PR draft and the full diff (74 files). Read in full: the port, the adapter, checkout, settlement, webhooks, refunds, payment links, plans, reconciliation, the scheduler change, the routes, the member checkout hook and panel, the admin link and reconciliation UI, the e2e harness and spec, and the docs.
- Re-ran every gate myself instead of trusting the checklist (results at the end). The first baseline run was **not** all green: `apps/api` failed 958/959 (flaky P01 test, finding 6).
- Probed suspected bugs with throwaway integration tests against the fake Razorpay, then turned each confirmed one into a permanent regression test.

## Findings

### Major (fixed)

1. **"Try again" could hand back a payable order for an invoice already paid, voided or part-paid, so a member could pay twice.** `startInvoiceCheckout` returned the keyed intent's existing order without re-checking the invoice, and the member app reuses the Idempotency-Key on retry. Scenario: the member opens Checkout and closes it, then pays at the desk, then taps "Try again" on the still-visible panel. They got the old order for the full amount. Probe: paid → 200 with an order; void → 200; part-paid → 200 with the old full amount.
   *Fix* `ef8b9c5`: a keyed retry re-checks the invoice. Paid or void → 409. Amount changed → the old order is superseded and the app shows "out of date" and starts a fresh attempt. Test: `razorpay-checkout` "a retry with the same key re-checks the invoice…".

2. **A provider refund that timed out was stuck `pending` for good, and held its amount out of the refundable balance.** The console retries with the same key only while the refund sheet stays open. Once it closed, nothing ever asked Razorpay again, so the refund was never made and staff couldn't issue another one ("more than the refundable balance").
   *Fix* `de24765`: submission moved into one function, `submitProviderRefund`. `reconcile-payments` resends refunds still pending with no Razorpay id after 15 minutes, using our refund id as `X-Refund-Idempotency`, so it can never refund twice. Test: `razorpay-refunds` "a timed-out refund nobody retried is asked again by reconcile-payments, once, with the same key".

3. **Payment links stayed "active" after the invoice was paid at the desk or voided, and the admin drawer kept offering them with a Copy button.** Staff could send a member a link for a debt that no longer exists.
   *Fix* `dc8ca83`: the single settlement path (`settleInvoicePayment`) and void now supersede live attempts whose amount no longer matches what's owed, and the drawer never shows a link to copy on a non-payable invoice. Money still paid through an old link opens an `invoice_already_settled` exception and isn't settled twice (tested). Test: `razorpay-payment-links` "stops offering a link once the invoice is paid at the desk or voided…".

4. **The server captured authorized payments for attempts already retired.** Both the `payment.authorized` webhook and confirm captured any authorized payment on a known order. That took money the gym then had to refund by hand through an exception. Left uncaptured, Razorpay returns it to the member automatically.
   *Fix* `e895a80`: both paths capture only for live attempts (`created`/`processing`/`failed`). Tests in `razorpay-webhooks` and `razorpay-checkout`.

### Minor (fixed)

5. **Balances under ₹1** went to Razorpay, which rejects orders below its minimum. The member saw "could not be started just now… try again", which can never succeed. Now refused up front with a plain 409, the same rule payment links already had (`ef8b9c5`, test).
6. **Flaky P01 test**: `phase3-stabilization` `makeMember` picked `SF-<random 50000..89999>`, the same band enrollment fills with max+1. It failed the first full run of this review with `UNIQUE constraint failed: members.member_no`. It now uses a non-numeric suffix (`2672875`).
7. **Reconciliation list failed open** for a caller with an empty branch scope: it showed every branch's exceptions. Every other branch-scoped list returns nothing in that case. Fixed with a test (`2ffa570`). Hard to reach in practice, since staff creation requires a branch.
8. Docs updated for 1–3 (`281e058`).

### Remaining (not fixed; recommended follow-ups)

- **Minor:** a retired payment link is still payable at Razorpay until it expires (7 days). Cancelling it needs a new port method (`POST /payment_links/:id/cancel`). Meanwhile, money through it isn't settled and lands in Reconciliation for a refund.
- **Minor:** the e2e global setup only warns (`console.warn`) when the fake Razorpay sees a request it doesn't serve; it doesn't fail the run. The API integration harness does fail. Making teardown throw needs care so the API server is still stopped. P08 should harden it.
- **Minor:** two first-time checkouts for the same invoice with *different* keys at the same instant can create two orders, because the "one live order" dedupe ignores `created` intents. If both were paid, the second becomes an exception (not a double settlement).
- **Minor / informational:** reconciliation's 48 h sweep can match an order-less payment by its `notes.intent_id`, and Checkout notes are set in the browser. The worst case is paying someone else's invoice with your own money for the exact amount owed. No funds can be diverted.
- **Spec deviation (accepted):** `verifyCheckoutSignature`/`verifyWebhookSignature` are synchronous (pure HMAC) rather than async, as the notes document.
- **Spec deviation (accepted):** the retired `/checkout-intent` endpoints are kept as always-412 rather than removed, so the existing boundary tests stay unchanged. New endpoints sit beside them.
- **Environment note:** the e2e API port comes from P01's OS free-port probe, not the 18100–18199 band. It's collision-safe, and I pinned the fake Razorpay via `SHARK_E2E_RAZORPAY_PORT` (18151–18154) for my runs.

### Checked and fine

- AC1: no-provider 412s use the same message; dunning outcome codes are unchanged without a provider. AC2: config tests for `rzp_live_` in dev/test/prod and missing secrets. AC8: runtime guard plus a harness check on every call.
- AC11: `git grep` shows one `createMembershipPurchase` and one `validateMembershipProduct` (`services/billing-membership.ts`). No tests were deleted.
- `git grep rzp_live_ -- ':!docs' ':!**/__tests__/**'` prints nothing; the refusal is an `rzp_test_` allow-list, so there is no live-key literal.
- Webhook: constant-time compare over the raw body; bad signatures are logged without storing the body; event stored before processing; duplicates are a 200 no-op; failed processing returns 503 for redelivery; CSRF exempt; rate-limited; 256 KiB cap.
- Payment links send `notify.sms=false`, `notify.email=false`, `reminder_enable=false` and no customer, so nothing is ever messaged. No PII in order notes. The browser gets only the key id.
- `reverseMembership` throws only before it writes, so swallowing its error inside the refund webhook can't leave a partial reversal.
- Member UI: plain register; states opening/dismissed/failed/confirming/paid/review; `role=status`/`alert`; Checkout.js loaded only on tap, from `https://checkout.razorpay.com/v1/checkout.js`. Admin panel: loading/empty/error/read-only states.

## Final verification (after all fixes)

Run on the branch head `2ffa570`, Node 22, from `shark-fitness/`:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm typecheck` | pass (0 errors) |
| `pnpm lint` | pass |
| `pnpm test` | contracts 6/6 (1 file), domain 271/271 (12), member-pwa 52/52 (12), admin-web 305/305 (39), api **966/966 (71)**. Total **1,600**, all passing |
| `pnpm -F @shark/api test -- razorpay payment webhook reconciliation refund` | 966/966 (the package script runs the whole API suite; the filters don't narrow it) |
| `pnpm build` | pass |
| `pnpm -F @shark/api db:check-drift` | `migration_drift=none` |
| `pnpm e2e` | 4 passed (3 desktop + `@payments` on Pixel 7); no unexpected fake-Razorpay requests |
| `pnpm e2e -- --grep "@payments"` | 1 passed (mobile-chromium) |
| `git grep -n "rzp_live_" -- ':!docs' ':!**/__tests__/**'` | no output |

Test count: the API went from 959 to 966 (+7 regression tests from this review), and the total from 1,593 to 1,600. No tests were deleted or weakened. The one P01 test I changed (`phase3-stabilization` `makeMember`) changes only how it generates member numbers.

The first baseline run of this review failed in `apps/api` at 958/959 (finding 6). One mid-review full run timed out once in `process-handlers.test.ts` (it spawns a child process, and the machine had load average ~5); it passed when re-run alone and in the final run.
