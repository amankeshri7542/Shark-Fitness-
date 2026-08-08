# Phase 3 — Membership Plans & Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, following the same TDD discipline as the Phase 2 stabilization commit) to implement this plan task-by-task.

**Goal:** Replace the `billing.ts` (admin + member) and `Plans.tsx`/`Billing.tsx` (admin) / `Billing.tsx` (member) stubs with a working product catalogue, plan assignment, transactional invoicing, a clearly-labelled demo payment adapter, idempotent payment recording, refunds, and membership activation gated strictly on authoritative payment success. This closes "Plan purchase → Payment → Membership activation → Renewal" in the priority business journey and lets a Phase-2-converted lead actually get a membership.

**Architecture:** A new `apps/api/src/services/billing.ts` holds the orchestration both route files need — invoice creation from a product (line snapshot + tax via `@shark/domain`'s `totalsFor`), applying a successful payment to an invoice and, only then, activating a `pending_payment` membership via `@shark/domain`'s `canTransition`. Both `routes/admin/billing.ts` (manual/staff payment recording, refunds, a staff-only demo webhook simulator) and `routes/member/billing.ts` (self-service demo checkout) call the *same* `applyPaymentToInvoice` function, so activation logic exists in exactly one place. Route files stay thin adapters, matching `routes/admin/members.ts`.

**Tech Stack:** Hono, Drizzle, Zod (`@shark/contracts` — `membership.ts` schemas, already fully defined), Vitest, React 18, TanStack Router/Query.

## Global Constraints

- Money is integer minor units everywhere. Tax via `taxOn`/`totalsFor` from `@shark/domain` — never computed inline.
- Every query filters `tenantId`; invoice/product reads and writes also check branch scope via `ctx.branchIds` (same `loadXInScope` pattern introduced in the Phase 2 stabilization commit — return `notFound`, not `forbidden`, for an out-of-scope record).
- **No live payment gateway exists or is simulated as one.** The member-facing "confirm" endpoint is server-authoritative and accepts no outcome data from the client body — the server itself decides success, exactly like a receptionist manually confirming a payment was received. A separate, staff-only, explicitly-named demo webhook simulator (`POST /admin/billing/webhooks/demo`) is the only place a "failed" outcome can be produced, and it requires `billing.record_payment` — never reachable by a member or an anonymous client.
- Membership activation (`pending_payment` → `active`) happens in exactly one function, `applyPaymentToInvoice` (services/billing.ts), called only after a payment is confirmed `succeeded` — never from route-level "trust the caller" logic.
- Payment recording is idempotent on `(tenantId, idempotencyKey)`: look up the existing row before inserting; a repeated key returns the original result, it does not error and does not double-write.
- `audit()` inside the same transaction for every mutation touching money, membership state, or another person's record. `emit()` with `payment.succeeded` / `payment.failed` / `invoice.updated` / `membership.state_changed` (all already exist in `EventTopic` — no contract changes needed).
- Known, accepted foundation gaps (flag, do not fabricate): no coupon/discount-code table (only a flat per-line `discountMinor`, unused by default), no separate credit-note document (a refund record is the credit-note mechanism here), no subscription/mandate table (`memberships.autoRenew` is the only recurring signal — no auto-renew *job* in this phase, out of scope), no GSTIN/HSN fields (only `taxRateBp`).
- Invoice numbers follow the existing seed convention exactly: `SF-{year}-{5-digit sequential}` (see `apps/api/src/db/seed.ts:838`). Generated inside the same transaction as the insert that consumes it (same pattern as the Phase 2 `memberNo` fix).
- Do not edit `packages/contracts`, `packages/domain`, `apps/api/src/db/schema`, `apps/api/src/app.ts` (already mounts `billingRoutes`/`memberBillingRoutes`), `apps/member-pwa/src/router.tsx` (already registers `/billing`). `apps/admin-web/src/router.tsx` may be edited (confirmed not DO-NOT-EDIT) — used here only if a dedicated invoice-detail route is warranted; default to an in-page detail panel first and only add a route if that proves awkward.

---

## File structure

- Create: `apps/api/src/services/billing.ts` — invoice creation, idempotent payment application, membership activation, refund application, invoice-number generation.
- Modify: `apps/api/src/routes/admin/billing.ts` — products CRUD, invoice list/detail, manual payment recording, void, refund, demo webhook simulator, dunning queue, `assign-plan`.
- Modify: `apps/api/src/routes/member/billing.ts` — member invoice list/detail, checkout-intent, checkout-intent confirm.
- Create: `apps/api/src/__tests__/billing.integration.test.ts`.
- Modify: `apps/admin-web/src/screens/Plans.tsx` — product catalogue.
- Modify: `apps/admin-web/src/screens/Billing.tsx` — reconciliation dashboard + invoice detail (in-page).
- Modify: `apps/admin-web/src/screens/MemberDetail.tsx` — add an "Assign plan" action calling `assign-plan`.
- Modify: `apps/member-pwa/src/screens/Billing.tsx` — member billing screen.

---

### Task 1: `services/billing.ts`

**Interfaces:**
- Produces: `nextInvoiceNumber(tenantId): string` (call inside a transaction), `createInvoiceForProduct(input): { invoiceId, totalMinor, ... }`, `applyPaymentToInvoice(input): { invoiceState, membershipActivated }`, `applyRefund(input): void`, `findIdempotentPayment(tenantId, idempotencyKey)`.
- Consumes: `db`, `schema`, `transact` from `../db/client.js`; `totalsFor`, `taxOn`, `invoiceStateFor`, `canTransition`, `ENTITLED_STATES` from `@shark/domain`; `audit`, `emit`, `id`, `now`, `isoDate`, `addDays`.

- [ ] **Step 1: Write the service**

```typescript
// apps/api/src/services/billing.ts
import { and, eq, sql } from 'drizzle-orm';
import type { Product } from '@shark/contracts';
import { channels } from '@shark/contracts';
import { canTransition, invoiceStateFor, totalsFor } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { audit, type AuditInput } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { addDays, isoDate, now } from '../lib/time.js';
import type { RequestContext } from '../lib/context.js';

/** Must be called inside the transaction that inserts the invoice — this
 *  process is single-connection/synchronous (see db/client.ts), so nothing
 *  else can read a stale max between this call and the insert. */
export function nextInvoiceNumber(tenantId: string): string {
  const year = new Date(now()).getUTCFullYear();
  const row = db
    .select({ max: sql<number>`max(cast(substr(${schema.invoices.number}, -5) as integer))` })
    .from(schema.invoices)
    .where(eq(schema.invoices.tenantId, tenantId))
    .get();
  return `SF-${year}-${String((row?.max ?? 0) + 1).padStart(5, '0')}`;
}

export interface CreateInvoiceInput {
  ctx: RequestContext;
  memberId: string;
  branchId: string;
  product: Product;
  refType: string;
  refId: string;
}

/** Invoice + line snapshot for a product purchase. A zero-price product
 *  (a comped trial, say) is created already `paid` — there is nothing to
 *  collect, so there is nothing to gate activation on. */
export function createInvoiceForProduct(input: CreateInvoiceInput): { invoiceId: string; totalMinor: number; state: string } {
  const { ctx, memberId, branchId, product, refType, refId } = input;
  const totals = totalsFor([{ quantity: 1, unitMinor: product.priceMinor, taxRateBp: product.taxRateBp }]);
  const invoiceId = id('inv');
  const issuedOn = isoDate(now(), 'Asia/Kolkata');
  const dueOn = addDays(issuedOn, 7);
  const paidInFull = totals.totalMinor <= 0;
  const state = paidInFull ? 'paid' : 'open';

  db.insert(schema.invoices)
    .values({
      id: invoiceId,
      tenantId: ctx.tenantId,
      branchId,
      memberId,
      number: nextInvoiceNumber(ctx.tenantId),
      state,
      issuedOn,
      dueOn,
      currency: product.currency,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      paidMinor: paidInFull ? totals.totalMinor : 0,
      refundedMinor: 0,
      voided: false,
      voidReason: null,
      refType,
      refId,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  db.insert(schema.invoiceLines)
    .values({
      id: id('ivl'),
      tenantId: ctx.tenantId,
      invoiceId,
      description: product.name,
      quantity: 1,
      unitMinor: product.priceMinor,
      discountMinor: 0,
      taxRateBp: product.taxRateBp,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      productId: refType === 'membership' ? refId : null,
    })
    .run();

  emit({ tenantId: ctx.tenantId, branchId, channel: channels.member(memberId), topic: 'invoice.updated', payload: { invoiceId, state } });
  return { invoiceId, totalMinor: totals.totalMinor, state };
}

export interface ApplyPaymentInput {
  ctx: RequestContext;
  invoiceId: string;
  amountMinor: number;
  method: string;
  provider: string | null;
  providerRef: string | null;
  idempotencyKey: string;
  recordedByName: string | null;
  note?: string;
}

export interface ApplyPaymentResult {
  paymentId: string;
  invoiceState: string;
  membershipActivated: boolean;
  alreadyProcessed: boolean;
}

/** Looked up before every payment insert — a repeated idempotency key returns
 *  the original outcome rather than erroring or double-writing. */
export function findIdempotentPayment(tenantId: string, idempotencyKey: string) {
  return db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.tenantId, tenantId), eq(schema.payments.idempotencyKey, idempotencyKey)))
    .get();
}

/**
 * The one place a payment becomes money-on-the-invoice and, if that clears
 * the balance, activates a pending membership. Called from three places only:
 * admin manual recording, the member checkout confirm, and the demo webhook
 * simulator's "succeeded" branch — never from anywhere that hasn't itself
 * already verified the payment succeeded.
 */
export function applyPaymentToInvoice(input: ApplyPaymentInput): ApplyPaymentResult {
  const { ctx, invoiceId, amountMinor, method, provider, providerRef, idempotencyKey, recordedByName, note } = input;

  const existing = findIdempotentPayment(ctx.tenantId, idempotencyKey);
  if (existing) {
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, existing.invoiceId!)).get()!;
    return { paymentId: existing.id, invoiceState: invoice.state, membershipActivated: false, alreadyProcessed: true };
  }

  const invoice = db.select().from(schema.invoices).where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, ctx.tenantId))).get();
  if (!invoice) throw notFoundInvoice();
  if (['paid', 'void', 'refunded'].includes(invoice.state)) throw settledInvoice();
  const dueMinor = invoice.totalMinor - invoice.paidMinor;
  if (amountMinor > dueMinor) throw overpayment(dueMinor);

  const paymentId = id('pay');
  const newPaidMinor = invoice.paidMinor + amountMinor;
  const newState = invoiceStateFor({
    totalMinor: invoice.totalMinor,
    paidMinor: newPaidMinor,
    refundedMinor: invoice.refundedMinor,
    dueOn: invoice.dueOn,
    today: isoDate(now(), 'Asia/Kolkata'),
    voided: invoice.voided,
  });

  let membershipActivated = false;

  db.insert(schema.payments)
    .values({
      id: paymentId,
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      invoiceId,
      memberId: invoice.memberId,
      method,
      state: 'succeeded',
      amountMinor,
      currency: invoice.currency,
      provider,
      providerRef,
      idempotencyKey,
      recordedById: ctx.role === 'member' ? null : ctx.userId,
      recordedByName,
      failureReason: null,
      note: note ?? null,
      createdAt: now(),
      settledAt: now(),
    })
    .run();

  db.update(schema.invoices).set({ paidMinor: newPaidMinor, state: newState, updatedAt: now() }).where(eq(schema.invoices.id, invoiceId)).run();

  // Activation only on a state that means "the member is no longer waiting
  // on money" — partially_paid does not activate a pending_payment membership.
  if (invoice.refType === 'membership' && (newState === 'paid' || newState === 'partially_paid') && newState === 'paid') {
    const membership = db
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.memberId, invoice.memberId), eq(schema.memberships.id, invoice.refId ?? '')))
      .get();
    if (membership && membership.state === 'pending_payment') {
      const transition = canTransition({ from: 'pending_payment', to: 'active', reason: 'Payment received', actorRole: ctx.role === 'member' ? 'member' : 'staff' });
      if (transition.ok) {
        db.update(schema.memberships).set({ state: 'active', updatedAt: now(), version: membership.version + 1 }).where(eq(schema.memberships.id, membership.id)).run();
        db.insert(schema.membershipEvents)
          .values({
            id: id('mev'),
            tenantId: ctx.tenantId,
            membershipId: membership.id,
            fromState: 'pending_payment',
            toState: 'active',
            reason: 'Payment received',
            actorId: ctx.role === 'member' ? null : ctx.userId,
            actorName: recordedByName ?? 'Member',
            source: ctx.role === 'member' ? 'member' : 'staff',
            effectiveAt: now(),
          })
          .run();
        db.update(schema.members).set({ lifecycle: 'active', updatedAt: now() }).where(eq(schema.members.id, invoice.memberId)).run();
        membershipActivated = true;
        emit({ tenantId: ctx.tenantId, branchId: invoice.branchId, channel: channels.member(invoice.memberId), topic: 'membership.state_changed', payload: { membershipId: membership.id, from: 'pending_payment', to: 'active' } });
      }
    }
  }

  audit(ctx, {
    action: 'payment.recorded',
    entityType: 'invoice',
    entityId: invoiceId,
    entityLabel: invoice.number,
    before: { paidMinor: invoice.paidMinor, state: invoice.state },
    after: { paidMinor: newPaidMinor, state: newState },
  });
  emit({ tenantId: ctx.tenantId, branchId: invoice.branchId, channel: channels.member(invoice.memberId), topic: 'payment.succeeded', payload: { paymentId, invoiceId, amountMinor } });
  emit({ tenantId: ctx.tenantId, branchId: invoice.branchId, channel: channels.member(invoice.memberId), topic: 'invoice.updated', payload: { invoiceId, state: newState } });

  return { paymentId, invoiceState: newState, membershipActivated, alreadyProcessed: false };
}

// notFoundInvoice/settledInvoice/overpayment: thin AppError factories kept
// here (not lib/errors.js) since their copy is billing-specific — see Step 1
// of Task 2 for their bodies, imported from lib/errors.js's exported classes.
```

The three error factories (`notFoundInvoice`, `settledInvoice`, `overpayment`) should just call `notFound('That invoice')`, `conflict('This invoice is already settled.')`, and `invalid(...)` respectively from `../lib/errors.js` — write them as trivial one-line functions in this file (`import { conflict, invalid, notFound } from '../lib/errors.js';`) rather than the placeholder comment above; the comment marks a drafting note, not something to leave in the real file.

Also add `applyRefund(input: { ctx, paymentId, amountMinor, reason, entitlementReversed, actorName }): void` in this same file: loads the payment (tenant-scoped), rejects if `amountMinor` exceeds `payment.amountMinor - sum(existing refunds for this payment)`, inserts a `refunds` row, updates the invoice's `refundedMinor` and recomputes state via `invoiceStateFor`, `audit()`s with the before/after refundedMinor, `emit()`s `invoice.updated`. Does **not** touch membership state — entitlement reversal is the caller's explicit separate decision per the `refunds.entitlementReversed` column comment.

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @shark/api typecheck`

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/billing.ts
git commit -m "feat(api): add billing service — invoicing, idempotent payment application, membership activation, refunds"
```

---

### Task 2: Admin billing routes — products

**Files:** Modify `apps/api/src/routes/admin/billing.ts`.

- [ ] Replace the stub with `productsRoutes`-equivalent handlers on `billingRoutes`: `GET /products` (all tenant products, `product.manage` — reception/branch_manager lack this permission per `packages/domain/src/permissions.ts`, so `PermissionState` gates the admin-web screen), `POST /products` (validate the full `Product` shape minus `id`/`version`/generated fields via a local Zod schema mirroring `packages/contracts/src/schemas/membership.ts`'s `Product`/`AccessRules`/`FreezeRules`/`CancellationPolicy`), `PATCH /products/:id` (bumps `version`), `POST /products/:id/retire` (sets `status:'retired'`, response includes `activeMembershipCount` — `SELECT count(*) FROM memberships WHERE productId = ? AND state IN ('active','pending_payment','frozen','grace')` — so the UI can show the retire-impact per UX-A06), `POST /products/:id/duplicate` (new id, `status:'draft'`, name suffixed " (copy)").
- [ ] Write tests first (RED): product create/edit/retire/duplicate round-trip, `product.manage` permission denial for reception, retire reporting a nonzero `activeMembershipCount` against a seeded product with active members.
- [ ] Implement (GREEN). Typecheck. Run tests.
- [ ] Commit: `feat(api): add admin product catalogue endpoints`

---

### Task 3: Admin billing routes — invoices, payments, refunds, dunning, plan assignment

**Files:** Modify `apps/api/src/routes/admin/billing.ts` (append).

- [ ] `GET /summary` — KPIs for the reconciliation dashboard (`billing.view`): this-month revenue (`sum(paidMinor)` where a payment's `createdAt` falls this month), outstanding total, overdue count, failed-payment count (payments where `state='failed'` in the last 30 days). Branch-scoped like `dashboard.ts`.
- [ ] `GET /invoices` — list, same full-scope-then-paginate pattern as the Phase 2 leads-list fix (compute total/state-breakdown over every matching row, slice for `items`, return `hasMore`). Filters: state, memberId, branchId, search (member name/invoice number).
- [ ] `GET /invoices/:id` — detail: invoice + lines + payments + refunds + dunning attempts, loaded through a branch-scope check identical in spirit to `loadLeadInScope` (write a small local helper or a `loadInvoiceInScope` addition to `services/billing.ts` — prefer the latter for reuse from the member route's ownership check too, though the member check is by `memberId` not `branchIds`).
- [ ] `POST /invoices/:id/payments` — body validated against `RecordPaymentInput` (already fully defined in contracts — import it directly, do not redeclare). `requirePermission(ctx, 'billing.record_payment')`. Calls `applyPaymentToInvoice` inside `transact()`. Returns `{ ok, invoiceState, membershipActivated, alreadyProcessed }`.
- [ ] `POST /invoices/:id/void` — `billing.write_off`; rejects if `paidMinor > 0` ("refund first"); sets `voided:true`, `voidReason` (required body field), `state:'void'`; `audit()`.
- [ ] `POST /payments/:id/refund` — `billing.refund`; body `{ amountMinor, reason, entitlementReversed: boolean }`; calls `applyRefund`.
- [ ] `POST /webhooks/demo` — `billing.record_payment`; body `{ invoiceId, outcome: z.enum(['succeeded','failed']), reason: z.string().optional() }`. **Docstring on this handler must state plainly it is a staff-only simulation tool with no real payment gateway behind it.** Writes a `providerEvents` row first (`provider:'demo'`, fresh `providerEventId`), then on `succeeded` calls `applyPaymentToInvoice` for the invoice's full outstanding amount with `method:'upi'` (a plausible demo default) and `provider:'demo'`; on `failed`, inserts a `payments` row `state:'failed'` with `failureReason: reason`, inserts the first `dunningAttempts` row via `dunningPlan(['email','in_app'])`'s first step, `emit()`s `payment.failed`.
- [ ] `GET /dunning` — `billing.view`; invoices with `state IN ('overdue','open')` joined to their latest `dunningAttempts` row, for the staff queue (§6.5 step 7).
- [ ] `POST /members/:memberId/assign-plan` — `requirePermission(ctx,'membership.manage')`; body `{ productId }`. Loads the member (branch-scoped like `members.ts` already does), loads the product (must be `status:'active'` and cover the member's branch — `product.access.allBranches || product.branchIds.includes(member.homeBranchId)`), rejects if the member already has a non-terminal membership (`state NOT IN ('cancelled','expired')`) with a clear conflict message ("this member already has a plan — cancel or let it expire before assigning a new one"). Inside one `transact()`: insert the `memberships` row (`state:'pending_payment'`, `productSnapshot: product`), then `createInvoiceForProduct({..., refType:'membership', refId: membershipId})`; if the created invoice is already `paid` (zero-price product), activate the membership immediately in the same transaction (same activation code path — call `applyPaymentToInvoice` is overkill for a zero-amount invoice with no payment row; instead set `memberships.state:'active'` + `membershipEvents` insert directly, mirroring `applyPaymentToInvoice`'s activation block — accept the small duplication here since a zero-price product is an edge case, not the primary path). `audit()`, `emit(membership.state_changed)` is skipped for pending_payment (not a real transition worth broadcasting) but IS emitted if immediately active.

- [ ] Write tests first (RED) for every endpoint above (see Task 5 for the full test list — write and run them against the stub/partial implementation as you build each endpoint, not all at the end).
- [ ] Typecheck, run tests, commit: `feat(api): add admin invoice, payment, refund, dunning, and plan-assignment endpoints`

---

### Task 4: Member billing routes

**Files:** Modify `apps/api/src/routes/member/billing.ts`.

```typescript
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { transact } from '../../db/client.js';
import { conflict, notFound, precondition } from '../../lib/errors.js';
import { id } from '../../lib/ids.js';
import { now } from '../../lib/time.js';
import { applyPaymentToInvoice } from '../../services/billing.js';

export const billingRoutes = new Hono();

billingRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const invoices = db.select().from(schema.invoices).where(eq(schema.invoices.memberId, memberId)).orderBy(desc(schema.invoices.issuedOn)).limit(24).all();
  const membership = db.select().from(schema.memberships).where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} != 'cancelled'`)).orderBy(desc(schema.memberships.createdAt)).get();
  // ...shape the response: membership summary + invoices list (number, state, totalLabel, dueLabel, issuedOn, dueOn)
});

billingRoutes.get('/invoices/:invoiceId', (c) => { /* tenant+memberId scoped, else notFound — never reveal another member's invoice exists */ });

const CheckoutIntentBody = z.object({ invoiceId: z.string() });
billingRoutes.post('/checkout-intent', validate('json', CheckoutIntentBody), (c) => {
  // load invoice scoped to ctx.memberId; reject if already paid/void; create a
  // `payments` row state:'created', provider:'demo', a fresh idempotencyKey,
  // return CheckoutIntent shape { intentId: paymentId, invoiceId, amountMinor: due, currency, provider:'demo', clientToken: token(16), expiresAt: now()+10min }
});

billingRoutes.post('/checkout-intent/:intentId/confirm', (c) => {
  // NO outcome accepted from the client body — this endpoint takes no body.
  // Load the payment row scoped to tenant+memberId+id=intentId, must be
  // state:'created' and not expired; the server itself decides success (this
  // *is* the demo adapter — see docs/BUILD-PLAN or the plan header for why
  // this satisfies "not altered from an unverified client callback": the
  // client sends no outcome, only "confirm this specific intent I already
  // hold," and the server's own code — not client JSON — marks it succeeded).
  // Call applyPaymentToInvoice with method inferred from... (there's no method
  // for a demo checkout; use 'upi' as the demo default, provider:'demo').
});
```

Precise behavior for `confirm`: the `payments` row created by `checkout-intent` already reserved an `idempotencyKey` (its own id is fine as the key, or a stored `clientToken` — use the payment id itself, `payment.id`, as the idempotency key passed into `applyPaymentToInvoice`, since one intent must resolve to exactly one payment application and the row already exists — **do not** call `applyPaymentToInvoice` in a way that inserts a *second* payment row for the same intent). Since `applyPaymentToInvoice` as written in Task 1 always inserts a fresh payment row, the confirm handler cannot call it as-is for an existing `created` payment row — **adjust Task 1**: either (a) give `applyPaymentToInvoice` an optional `existingPaymentId` param that updates-in-place instead of inserting when provided, or (b) have `checkout-intent` NOT pre-insert a payment row at all and instead store the pending intent's `invoiceId`+`amountMinor`+expiry in-memory-adjacent fields on a lightweight `payments` row with `state:'created'`, and have confirm delete-then-let-`applyPaymentToInvoice`-insert. Prefer (a) — it keeps one row per attempt and matches the `payments.state` lifecycle (`created`→`succeeded`) the contract already models instead of working around it. Implement `applyPaymentToInvoice`'s insert as an upsert: if `input.existingPaymentId` is set, `UPDATE payments SET state='succeeded', settledAt=now() WHERE id = existingPaymentId` instead of `INSERT`. Update Task 1's function signature accordingly before or during this task — this is a real design correction found while writing the member flow, not a deferred TODO.

- [ ] Write tests first (RED): member sees only their own invoices/gets 404 for another member's invoice id; checkout-intent → confirm activates a pending_payment membership; confirming twice is idempotent (second confirm either 409s cleanly or returns the same already-succeeded result — pick one and assert it, "already processed" via `alreadyProcessed:true` is the more member-friendly choice, matching `applyPaymentToInvoice`'s existing idempotency contract); confirming an expired intent fails with a clear error, not a silent success.
- [ ] Implement (GREEN), including the Task 1 signature correction. Typecheck, test.
- [ ] Commit: `feat(api): add member self-service billing and demo checkout`

---

### Task 5: Integration tests — consolidated list (write incrementally per task above, verify all together here)

**File:** `apps/api/src/__tests__/billing.integration.test.ts` (new — mirror `leads.integration.test.ts`'s session-caching `signIn()` helper verbatim to avoid the same rate-limiter problem).

Required coverage (from the user's brief): admin product CRUD + retire-impact count; plan assignment from a member profile (including the "already has a plan" conflict); transactional invoice creation with correct line/tax snapshot; demo checkout intent → confirm activates membership; idempotent payment recording (same idempotency key replayed returns the original result, not a duplicate payment row — assert `payments` row count unchanged); partial payment leaves invoice `partially_paid` and does **not** activate the membership; a webhook-simulated failure creates a `dunningAttempts` row and does not touch `paidMinor`; refund reduces invoice state to `partially_refunded`/`refunded` correctly and never auto-reverses entitlements; branch isolation on invoices/products (reuse the Phase 2 pattern: an out-of-branch invoice 404s, not 403s); permission denial for each of `product.manage`/`billing.view`/`billing.record_payment`/`billing.refund`/`billing.write_off` against a role that lacks it (reception lacks `billing.refund`/`billing.write_off` per `permissions.ts` — good test subjects).

- [ ] Confirm every test fails first against the stub/partial implementation (RED), per TDD — do not write implementation ahead of a failing test for any endpoint above.
- [ ] All green. Run `pnpm -F @shark/api typecheck && pnpm -F @shark/api test`.

---

### Task 6: Admin — `Plans.tsx`

**Files:** Modify `apps/admin-web/src/screens/Plans.tsx`.

- [ ] Product table (`Panel`/`Seam`, `Chip` for draft/active/retired), gated on `usePermission('product.manage')` → `PermissionState` otherwise. "New product" opens a builder form (type/pricing/tax/cadence/access/freeze/cancellation — the full `Product` shape; reuse `Field`/`select` patterns from the Phase 2 lead-capture form). Publish/duplicate/retire actions; retire shows the `activeMembershipCount` from the API response in a confirmation dialog before proceeding (UX-A06 "existing purchasers" mandatory state). Loading/empty/error states via `Skeleton`/`EmptyState`/`ErrorState`.

---

### Task 7: Admin — `Billing.tsx`

**Files:** Modify `apps/admin-web/src/screens/Billing.tsx`.

- [ ] Reconciliation dashboard: KPI row (`Metric`) from `GET /summary`; invoice table (filterable by state/search) from `GET /invoices` with the `hasMore` truncation banner (same pattern as Phase 2's `Leads.tsx`); clicking a row expands an in-page invoice detail panel (lines, payments, refunds, dunning history) rather than a new route, per the plan header's default; "Record payment" modal (amount/method/reference, generates a fresh `idempotencyKey` via the existing `idempotencyKey()` helper in `lib/api.ts`); "Refund" modal (amount/reason/entitlement-reversal checkbox); "Void" action (reason required); dunning queue panel from `GET /dunning`. Gate `record payment`/`refund`/`void` buttons individually on their respective permissions (not the whole screen on one), same pattern as `MemberDetail.tsx`'s `canSeeBalances`/`canSeeStaffNotes` split.

---

### Task 8: Admin — "Assign plan" on `MemberDetail.tsx`

**Files:** Modify `apps/admin-web/src/screens/MemberDetail.tsx`.

- [ ] Add an "Assign plan" button (visible when `membership` is `null` or terminal, gated `usePermission('membership.manage')`) opening a product picker (fetch `GET /admin/billing/products`, filter to `status:'active'` and branch-eligible), calling `POST /admin/billing/members/:memberId/assign-plan`. On success, invalidate `['member', memberId]` and show the resulting invoice state (paid immediately, or "invoice created — record payment when received").

---

### Task 9: Member — `Billing.tsx`

**Files:** Modify `apps/member-pwa/src/screens/Billing.tsx`.

- [ ] Current plan + renewal date/auto-renew (reuse the `['home']` query's `membership` object where possible, per the Phase 7 audit's recommendation for `Profile.tsx` — consistent pattern), outstanding-balance hero using `formatMoney`, invoice list (`Seam`/`SeamCell`), "Pay now" on an outstanding invoice → `POST /member/billing/checkout-intent` → confirm screen/step → `POST .../confirm`, honest payment-status states (pending/succeeded/failed — this screen is where §6.5's member-facing "receives an approved communication" and "grace period" messaging lives). Money/billing copy via `useCopy('billing')` (plain register) per BUILD-PLAN.md. Loading/empty/error/offline states.

---

### Task 10: Full verification pass

- [ ] `pnpm typecheck && pnpm test && pnpm build` (all workspaces).
- [ ] Live HTTP verification against the running dev server: assign a plan to a member with no membership, confirm invoice/membership state; record a manual payment via the admin endpoint and confirm activation; run the demo checkout confirm flow as a member; simulate a webhook failure and confirm a dunning attempt appears; issue a refund and confirm invoice state moves to `partially_refunded`.
- [ ] Commit: `chore: verify phase 3 (typecheck, tests, build) passes`.
