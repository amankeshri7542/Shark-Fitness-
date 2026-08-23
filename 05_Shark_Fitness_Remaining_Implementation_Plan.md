# Shark Fitness
## Remaining Implementation Plan

## Document governance

This document is subordinate to the four PRDs. Where it appears to relax a
**SHALL** requirement in
[01_Shark_Fitness_Product_Functional_PRD.md](./01_Shark_Fitness_Product_Functional_PRD.md),
the PRD wins and this document is wrong. Its purpose is narrower than a PRD: it
records **what is already built**, so that an implementing agent does not
rebuild it, and it sequences **what is left**.

Every implementing agent SHALL follow the *AI-agent execution contract* in
§`AI-agent execution contract` of the Product PRD in full. This plan adds
repository-specific detail to that contract; it does not replace it.

### Status of this document

Verified on `feat/phase-10-reports-ui-polish` on **23 August 2026** (Node
22.23.2, as `.node-version` pins and CI reads). Phase 9 is **merged** — PR #9
squashed to `main` as `07fb53f`. Phase 10 is **built** on this branch and is
PR #10, open.

Evidence for the current branch: `pnpm lint` and `pnpm typecheck` clean across
6 packages, `pnpm test` **717 passing** (153 domain, 315 API integration, 24
member PWA, 225 admin console), `pnpm build` clean, and a browser pass at
1440×900, 1024×768, 768×1024 and 375×812 in both themes and both densities
across all 15 console routes — no horizontal overflow, no clipped content
outside a scroller, no console errors.

**Do not read the counts in the older phase sections as current.** Each is
kept as the record of what *that* branch was verified at, and the numbers only
go up.

### What this session changed, and why the record needed correcting

Two correctness defects were found on this branch and fixed before anything
else. Both are worth reading before touching branch scope or a detail endpoint,
because both were invisible from the tests and from the code as written.

**"All branches" covered one branch.** The console's switcher expresses "no
branch selected" by sending no `x-branch-id` header. `resolveSession` seeded
`activeBranchId` to `member?.homeBranchId ?? branchIds[0]`, and eight modules
each carried their own copy of `activeBranchId ? [activeBranchId] :
branchIds` — so an owner of three gyms read a screen labelled "All branches
(3)" over one gym's figures. Nothing errored. `activeBranchId` now means only
"the branch this request selected"; `branchScope(ctx, requested?)` in
`lib/context.ts` is the single place that turns that into a list; and a header
naming a branch outside the caller's entitlement is refused with 403 rather
than silently ignored. A single-branch tenant cannot see this bug, which is
why it survived nine phases — on one branch both readings agree.

**The member record ignored the scoping its own directory applied.**
`GET /admin/members/:memberId` matched on member id and tenant id alone, so any
non-trainer role holding `member.view` could read another branch's member by id.
Freeze, unfreeze and cancel looked their membership up by member id with **no
tenant condition at all**, and a notice-period cancellation from an
out-of-scope manager returned 200. All five paths now go through
`loadMemberInScope`, which already existed for attendance. A sweep of every
other detail endpoint found no second occurrence.

Both have regression tests that fail without the fix
(`branch-scope.integration.test.ts`, `member-scope.integration.test.ts`).

### Phase 7 as verified before merge

Verified on `feat/phase-7-store` on **19 August 2026**, after the hardening pass
described below.
Verification evidence: `pnpm lint` and `pnpm typecheck` clean across 6 packages,
`pnpm test` **444 passing** (101 domain, 207 API integration, 24 member PWA, 112
admin console), `pnpm build` clean, the CI browser-smoke harness
(`scripts/admin-browser-smoke.mjs`) run locally against the production
single-origin server, and that server worked by hand at 1440×900, 1024×768,
768×1024 and 375×812.

The table count is **90**, not the 85 an earlier revision recorded — Phase 7's
migration added five and the line was not updated. Counted two ways from the
tree: `sqliteTable()` definitions in the five schema files, and unique
`CREATE TABLE` names in the generated migrations. They agree.

The browser pass was a working session at a till rather than a page load: a
two-line sale settled across cash and card, a partial refund against it, a stock
adjustment of +24 with a reason, and an inter-branch transfer received one unit
short. Stock figures updated live from the realtime topics without a reload,
`Store-*.js` was fetched on demand as a single 64 kB chunk, every
`/v1/admin/store/*` call returned 200, and the console was clean. `document.body`
did not scroll horizontally at any of the four viewports; the dense tables
contain their own overflow.

That session found five defects the test suite could not see — a null unit cost
rendering as "Restricted" rather than "not applicable", a product drawer quoting
a stale on-hand after its own adjustment, low-stock rows naming a product
without its variant, an order drawer too narrow for the return steppers, and
seeded receipt lines all reading "Retail item". All five are fixed in `d97cf59`
and re-verified in the browser. **A green suite is not a smoke test**; on a
module that handles money, run both.

### The hardening pass — what a second reading found

A green suite and a clean browser session are still not an audit. A deliberate
re-read of Phase 7 against the PRDs found eight more defects, two of which could
take a customer's money twice or hide a figure from the person who entered it.
They are fixed and each one has a test that fails without the fix.

**The till could sell the same basket twice.** `Register.tsx` built its
`Idempotency-Key` *inside* `mutationFn`, and `idempotencyKey()` ends every key
it returns with a random suffix. So the header that exists to make a retry safe
was a different value on every press: server commits, response is lost, cashier
presses again, second sale. The key is now minted once per checkout attempt,
against a fingerprint of the exact request body, and held in a ref: a retry of
an unchanged basket reuses it, a changed basket mints a new one, and a completed
sale retires it — because the next customer buying the same thing must not be
answered with the last one's receipt. The API side gained the counting tests
that prove a replay leaves one order, one tender and one movement, and that a
key replayed against a different basket is a 409 rather than either a second
sale or the wrong receipt.

**Unit cost was gated two different ways.** `toOrderLine` and `toTransferLine`
withheld `unitCostMinor` on `report.financial` while
`financialAccess().restricted` filed it under `inventory.manage`. The response
therefore contradicted itself: a branch manager was told "Restricted" about a
cost they had typed in when the delivery arrived, and an accountant was handed
one their own `restricted` list said they could not have. All four unit costs —
product, ledger row, sold line, transfer line — now follow `inventory.manage`,
and a role-matrix test asserts, for owner / branch manager / reception /
accountant across five surfaces, that `restricted` is an exact account of which
fields came back `null`.

**Business dates were not the branch's.** The POS receipt reference took its
date from `toISOString()` — UTC — and `raiseAccountInvoice` hard-coded
`Asia/Kolkata`, so the same sale could be filed on two different days and the
invoice due date inherited the drift. Both now read `lib/branch-time.ts`, the
one place that answers *which* zone (branch, then tenant, then the column
default). The console had the mirror problem: every Store timestamp and the
shared `Freshness` component formatted in the *browser's* zone, so a manager
reading from another city saw the wrong hour stated as fact.
`useBranchTimeZone()` supplies it and `Freshness` now requires it.

**An error rendered as an empty shop.** Orders, Transfers and Insights all read
`data?.items ?? []`, so a failed request and a quiet day looked identical — and
the Orders and Transfer drawers sat on their skeleton for ever rather than
saying the read failed. Each surface now names the read it cannot work without
and shows what happened with a retry, which is what the Design PRD's "permission
denial SHALL NOT masquerade as missing data" means for the other failure too.

**An account tender with no member was clickable.** The Register warned about it
and then let the button be pressed anyway, spending a round trip to be told
something the screen already knew. The server stays authoritative — that refusal
is still tested — and the button now holds.

**Smaller, but real:** the member picker asked `/admin/members` for
`firstName`/`lastName` against a route that has only ever sent one `name`, so
every result rendered as a blank line above its member number — the client-side
fork of a server shape that `schemas/pos.ts` exists to prevent, hidden because
the test fixture invented the missing fields. Clickable table rows declared
`role="button"`, which does not add a button to a table but removes a row from
one; rows keep their semantics and the identifying cell now carries the control.
Opening the till fetched the whole sales history and ran the full report before
anything was scanned; those two load with their surface. The member lookup fired
a request per keystroke and is now debounced. The open surface lives in the URL,
so a reload lands back at the till. And the command palette offered to search
members, invoices and classes against an index holding only modules — a promise
answered with "nothing matches", which reads as "that member does not exist".

The 282-test figure in the previous revision was correct for
`chore/production-hardening`; this revision adds 15 API and 66 admin console
tests on top of it. The 243-test figure before that predates the front-end
component suites. The revision before that recorded 203 tests against `main` on
16 August 2026 and stated `22 of 29` API route modules — that denominator
counted a module that does not exist. Counts here are taken from the tree.

---

# 1. What is already built

Do not re-implement any of this. Read it before planning a change.

| Layer | State |
|---|---|
| Database schema | **93 tables** across 5 schema files (counted as `sqliteTable()` definitions, and matching `CREATE TABLE` in the generated migrations), with 110 indexes and 7 append-only guard triggers. Complete for every module in this plan. |
| Migrations | Generated and checked in at `infrastructure/migrations/`. |
| `@shark/contracts` | Zod schemas, enums, error envelope, realtime events (29 topics, including 6 for POS). `schemas/pos.ts` is the Store's canonical wire shape — the console reads it rather than keeping its own copy. |
| `@shark/domain` | Membership state machine, booking eligibility, access decisions, strength maths, adaptive engine, gamification, money, permissions, safety scanning, retention risk, reporting periods and comparisons. 153 tests. |
| `@shark/design-tokens` | The Sonar system and the bounded copy register (`tone.ts`). |
| Member PWA | **All 18 screens implemented.** No stubs remain. |
| Admin console | **18 of 21 screens implemented** (counted as files over 60 lines). The 3 placeholders are Automations, Platform and Settings — 11 lines each. Reports is now built: `Reports.tsx` plus five surfaces under `screens/reports/`. Store is five surfaces under `screens/store/`; Support is four under `screens/support/`. |
| API | **27 of 28 route modules implemented.** The 1 stub is `admin/settings`, still 7 lines. `admin/reports` is now a 73-line adapter over `services/reports.ts` (1,338 lines). All 28 are mounted in `app.ts`. |
| Branch scope | One rule, one helper. `branchScope(ctx, requested?)` in `apps/api/src/lib/context.ts` decides which branches any read covers; no module keeps its own copy. See §3.3. |

**Migrations: check, do not assume.** An earlier revision asserted that no
module in this plan needs one. Phase 7 disproved that — four of its six SHALL
requirements had nowhere to live, and `0001_phase7_store.sql` was written. The
tables for Phases 9–13 do all exist today, but confirm against the schema
before planning rather than trusting this line.

The remaining work is route handlers plus console screens.

---

# 2. Resolved prerequisite — Phase 6 is on `main`

**This is no longer a blocker.** Phase 6 (Staff & Training admin) was rebased
onto `main` and merged as **PR #5** (`b98761b`, "rebase Phase 6 staff and
training work onto main"). Verified present on `main`: `services/staff.ts`
(626 lines), `services/training-admin.ts` (1,114), `admin/staff.ts` (213),
`admin/training.ts` (294), `lib/idempotency.ts`, and the `phase6-staff` /
`phase6-training` suites. `admin/staff.ts` and `admin/training.ts` are full
route modules; the Staff and Training screens are no longer placeholders.

The merge was done the required way rather than naively, which matters because
the Phase 6 branch predated the deployment fixes and a naive merge would have
reverted them. All three regression points held:

| File | Risk a naive merge carried | State on `main` |
|---|---|---|
| `apps/api/src/server.ts` | Reverting the relative-root `serveStatic` fix and the HTML/asset cache boundaries would serve every JS and CSS file as the SPA HTML fallback — a blank page. | Intact. Assets serve with their own content types. |
| `apps/member-pwa/vite.config.ts` | Reverting `navigateFallbackDenylist` would let the member service worker answer `/admin/*` with the member shell, making the console unreachable. | Intact. |
| `apps/api/src/__tests__/phase5-staff-branch-scope.integration.test.ts` | Deleting the test outright. | Present (123 lines) and passing. |

Keep CI's production smoke step as the standing regression gate for the first
two: it asserts assets are not the HTML fallback and that cache headers are
present.

---

# 3. Conventions an implementing agent SHALL follow

These are observable in the existing code. Read one implemented module before
writing a new one — `apps/api/src/routes/admin/leads.ts` and
`apps/admin-web/src/screens/Leads.tsx` are the reference pair.

### 3.1 Route handlers are adapters

Business rules live in `@shark/domain` (pure, no I/O) or in
`apps/api/src/services/*.ts` (data access). A handler validates, authorises,
delegates, and serialises. If a rule is being written inside a handler, it is in
the wrong place.

### 3.2 Every route module follows this shape

```ts
export const storeRoutes = new Hono();

const ListQuery = z.object({ /* … */ });

storeRoutes.get('/products', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);                    // tenant, branch scope, permissions
  requirePermission(ctx, 'inventory.view'); // throws FORBIDDEN
  // …
});
```

- Validate with `validate('json' | 'query' | 'param', Schema)` from
  `middleware/validate.ts`. Do not hand-parse a body.
- Authorise with `requirePermission(ctx, '<key>')` and, for branch-scoped reads,
  `requireBranch(ctx, branchId)`.
- Mutations run inside `transact()`, write an `audit()` entry, and `emit()` the
  realtime event on the correct channel.
- Mutations that a client may retry take an `Idempotency-Key`.
- The router is already registered in `app.ts`. **Add handlers to the existing
  file; do not edit `app.ts`.**

### 3.3 Tenant and branch isolation is enforced in code

SQLite has no row-level security. Every query filters on `tenantId`, and every
branch-scoped query checks `ctx.branchIds`. There is no code path that reads a
business table without a tenant. A new query that omits either is a defect even
if no test catches it.

**Which branches a read covers has exactly one answer:**

```ts
import { branchScope } from '../../lib/context.js';
const scope = branchScope(ctx, query.branchId ?? null);
```

Four cases, and they are distinct on purpose:

| Case | Meaning | Result |
|---|---|---|
| A branch named in the query | The caller asked for one | `[branchId]`, after `requireBranch` |
| `x-branch-id` sent by the console | The switcher has a selection | `[activeBranchId]`, validated in middleware |
| Neither | **All branches the caller may see** | `ctx.branchIds` |
| A branch outside the entitlement | Refused, not narrowed | 403 in `authenticate` |

`ctx.activeBranchId` is `null` until a client selects a branch. Do **not**
default it to `branchIds[0]`, and do not write a module-local `scopeOf`. Both
were done, in eight modules, and the result was a console that said "All
branches (3)" over one branch's figures for nine phases. A single-branch tenant
cannot see that bug, so it will not show up in casual testing.

**A detail endpoint is scoped exactly as hard as its list endpoint.** A list
that filters on branch and a `GET /:id` that filters only on tenant is not a
narrower version of the same rule — it is a way round it for anyone who knows
an id. Load through the module's `load*InScope` helper
(`loadMemberInScope`, `loadInvoiceInScope`, `loadLeadInScope`,
`loadStaffInScope`, `loadEquipmentInScope`, `ticketInScope`, …), which answers
**404** rather than 403: a 403 confirms the record exists somewhere the caller
may not look.

### 3.4 Money, ledgers, and time

- Money is **integer minor units** everywhere. Tax is computed per line and
  summed, never on a rounded subtotal.
- `audit_log`, `xp_ledger` and `stock_ledger` are append-only, enforced by
  `BEFORE UPDATE`/`BEFORE DELETE` triggers. A correction is a compensating
  entry, never an edit.
- Timestamps are epoch milliseconds UTC. User-facing dates are computed in the
  **branch's** timezone via `lib/time.ts`, never the server's.

### 3.5 Console screens

Compose from `ui/console.tsx` (`Panel`, `Toolbar`, `Chip`, `Metric`, `Field`,
`Skeleton`, `EmptyState`, `ErrorState`, `PermissionState`, `Seam`) and
`ui/shell.tsx` (`Page`). Every screen SHALL implement loading, empty, error,
permission-denied and offline states — `PermissionState` is not optional, since
the console changes shape per role.

Status is **never colour alone**: every `Chip` pairs its colour with a glyph
(WCAG 2.2, Design PRD).

### 3.6 Copy register

The predator voice (Hunt / Strike / Depth / Pack) is the training floor only.
Payment, access denial, injury, support, safety and privacy always use the plain
register, enforced by `PLAIN_ONLY_SURFACES` in
`packages/design-tokens/src/tone.ts`. **Every module in this plan except none is
a plain-register surface** — Store, Support, Reports, Settings, Automations,
Equipment and Platform are all operational, so none of them may reach for the
predator voice.

### 3.7 Definition of done, per module

A module is complete only when all of the following hold. This mirrors the
*Module completion rule* in the Product PRD.

1. Every listed requirement ID is implemented.
2. Every listed edge case has a test.
3. Permissions enforced and covered by a test that asserts a denied role is
   refused.
4. Tenant and branch isolation covered by a test that asserts cross-tenant and
   cross-branch reads return 404, not 403 — the console must not confirm that a
   record exists outside the caller's scope.
5. Audit entries written for every mutation.
6. Loading, empty, error, permission-denied and offline states implemented.
7. Seed data exists so the screen is not empty on a fresh `pnpm db:reset`.
8. `pnpm typecheck && pnpm test && pnpm build` all pass.

---

# 4. The remaining phases

Sequenced by dependency and by how much each unblocks. Phases 7–9 are
independent of one another and may be done in any order or in parallel. Phase 10
depends on 7 and 8. Phases 11–13 are independent.

Each phase names the requirement IDs it satisfies. Read those requirements and
their *Required edge-case coverage* in the Product PRD before starting — they
are normative and this plan does not restate them in full.

---

## Phase 7 — Store: point of sale and inventory — **COMPLETE**

**Requirements:** PF-POS-001 … PF-POS-006 — all six implemented and tested.
**Permissions:** `inventory.view`, `inventory.manage`, and — see below —
`report.financial`.
**Files:** `apps/api/src/services/store.ts` (every rule),
`apps/api/src/routes/admin/store.ts` (thin adapter),
`packages/contracts/src/schemas/pos.ts` (the wire shapes),
`apps/admin-web/src/screens/Store.tsx` plus `screens/store/*` (five surfaces),
`apps/admin-web/src/ui/overlay.tsx` (drawer and confirm dialog),
`apps/api/src/__tests__/phase7-store.integration.test.ts` (57 tests),
`apps/admin-web/src/screens/store/__tests__/*` and `ui/__tests__/overlay.test.tsx`
(66 tests).

**Migration:** `infrastructure/migrations/0001_phase7_store.sql` adds
`suppliers`, `retail_product_groups`, `pos_payments`, `stock_transfers` and
`stock_transfer_lines`, plus additive columns on the four existing tables. An
earlier revision of this plan claimed no migration was needed; that was wrong,
and four of the six SHALL requirements had no home without it. The
stock-keeping unit stays `retail_products` — it already carries the SKU,
barcode, price and cost, and the ledger already points at it — so
`retail_product_groups` is only the parent that turns "Shark Tee" into S/M/L,
and no existing ledger or order-line row was rewritten. Every added column is
nullable or defaulted.

**Seed:** products, stock, suppliers, groups, a realistic day of sales
including a refund, and one open inter-branch transfer.

### Three decisions worth not re-litigating

**Contracts are canonical, and the console does not fork them.** `ops.ts` once
carried `RetailProduct`, `StockMovement` and `PosOrder`, written before the
module existed. Nothing imported them, none matched what the API served, and
the console kept private copies instead — a client-side fork of a server shape
that typechecks while it drifts. They are gone; `schemas/pos.ts` is what the
routes serialise and what the console reads. Timestamps are ISO-8601 on the
wire like every other module, and branch ids always travel with branch names.

**Cost and margin are not `inventory.view`.** The Product PRD files product
margin under financial reports (§4.20) and gives reception "no access to
sensitive global reports", so:

| Figure | Permission | Why |
|---|---|---|
| stock on hand, price, reorder point, units sold, low stock, takings | `inventory.view` | running the shop |
| unit cost on a product, a ledger row or a purchase | `inventory.manage` | an operational input — whoever books in a delivery types it |
| margin, stock valuation, shrinkage **value**, per-product margin | `report.financial` | the gym's commercial position |

A withheld figure is `null` and flagged in a `financial` block on the response,
never `0`. Zero margin is a real and alarming number in a shop, and
substituting it for "you may not see this" would put a falsehood in a report
(PF-RPT-005). The console renders those as a permission state, not a blank.
Tested as a matrix across owner, branch manager, reception and accountant.

**`pos_orders.invoice_id` is set for exactly one tender.** An `account` charge
is the only tender that does not settle at the counter, so it is the only one
that raises a receivable, using the existing `invoices` / `invoice_lines`
tables and `nextInvoiceNumber`. Only the on-account share is billed, so a
basket half-settled in cash leaves a debt for the remainder and not for the
whole sale. Cash, card and UPI receipts stay standalone **deliberately**:
minting an invoice that is born paid would double-count the day's takings
against the billing ledger and put a stack of meaningless documents in the
member's account. `invoices.member_id` is NOT NULL, which is also why an
account tender without a member is refused at the till rather than papered over
with a placeholder.

### Realtime

Six POS topics replace the single borrowed `payment.succeeded` the first cut
emitted: `pos.sale_completed`, `pos.return_completed`, `pos.order_voided`,
`stock.changed`, `stock.low`, `transfer.updated`. A counter sale settling in
cash is not a billing payment, and publishing it as one told dunning,
reconciliation and membership activation something untrue in exchange for a
free cache invalidation. `transfer.updated` publishes to **both** branches,
because a transfer is the one Store fact that is never about a single shelf.
The old `alert.raised` with `kind: 'stock_low'` had no consumer and did not
match the `low_stock` value in the alert contract; it is gone.

### Console

Five surfaces rather than one screen, because a shop is five jobs: **Register**
(barcode or name entry, member lookup, per-line discount, tax breakdown, true
mixed tender with a running remaining balance, tender references, an
authoritative server receipt), **Inventory** (dense sticky-header table,
create/edit product, suppliers, stock adjustment with a reason, per-product
movement ledger), **Orders** (searchable history, order detail, partial and
full return, reason-gated void stating its consequence), **Transfers** (draft,
dispatch, per-line receipt with visible shrinkage, cancel), **Insights** (sales,
low stock, valuation, shrinkage, top products, permission-aware).

New Sonar primitives, added because they earn their keep across several of
those: sticky-header tables that contain their own horizontal scroll, a
focus-trapping `Drawer` and `ConfirmDialog`, `Tabs`, `Stepper`, `Segmented`,
`Restricted`.

**Rules that must not be got wrong** — unchanged and still enforced: stock is
derived from `stock_ledger` and never stored; selling below zero is refused
unless the tenant enabled it *and* a reason is given; tax is per line then
summed, in integer minor units; a refund is a compensating entry, never an
edit; mixed tender must sum to the total exactly.

**Edge cases covered by tests:** sale of an item that went out of stock between
the screen loading and the sale; refund of an order whose product was since
retired; a return taken at a different branch from the sale; a stock adjustment
by a user holding `inventory.view` but not `inventory.manage`; an order at a
branch the caller cannot see (404, not 403); a duplicate barcode; a stocktake
against a dispatched transfer; a transfer received short; a failed sale leaving
no order, line, payment or stock movement behind; a sale that committed and lost
its response, retried by the cashier; the same key replayed against a different
basket; two customers buying an identical basket back to back; the full
cost/margin visibility matrix across four roles and five surfaces; and a receipt
reference and account invoice dated by a branch two zones from the server.

### Two things to carry into the phases that follow

**`lib/branch-time.ts` is where "which zone" is answered.** It exists because
Store had the question in two places and got two answers. Four modules still
inline the same query and one hard-codes the literal; they were left alone here
because they are outside this PR, but Phase 10 (timezone cutoffs are normative
in PF-RPT-002), Phase 11 (a branch created in another timezone is a named edge
case) and Phase 12 (quiet hours are evaluated in the branch's zone) should all
use the helper rather than add a sixth spelling.

**A retryable write needs a stable key on the client, not just a header on the
server.** `runIdempotently` was correct throughout; the till defeated it by
minting a new key per press. Any screen that takes money or claims a seat should
be read with that in mind — the key belongs to the *attempt*, and the attempt
outlives the request.


---

## Phase 8 — Equipment: facility operations — **BUILT**

**Requirements:** PF-FAC-001 … PF-FAC-006.
**Permissions:** `facility.view`, `facility.manage`.
**Files:** `apps/api/src/routes/admin/facility.ts` (thin adapter),
`apps/api/src/services/facility.ts` (every rule),
`apps/admin-web/src/screens/Equipment.tsx`,
`apps/api/src/__tests__/phase8-facility.integration.test.ts` (25 tests).

**Tables — all exist:** `equipment`, `work_orders`, `facility_tasks`. All three
are seeded, including an overdue safety work order that the Command Center
surfaces as an exception. That alert now lands on a working screen.

**Endpoints**

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/admin/facility/equipment` | Filter by branch, category, status, due-for-service. |
| POST | `/v1/admin/facility/equipment` | |
| PATCH | `/v1/admin/facility/equipment/:equipmentId` | Includes status transitions. |
| POST | `/v1/admin/facility/equipment/:equipmentId/return-to-service` | Lifts a safety hold. Requires a note. |
| GET | `/v1/admin/facility/work-orders` | Filter by state, severity, assignee, overdue. |
| POST | `/v1/admin/facility/work-orders` | |
| PATCH | `/v1/admin/facility/work-orders/:workOrderId` | Assign, change state, resolve. |
| GET | `/v1/admin/facility/tasks` | Recurring maintenance checklist. |
| POST | `/v1/admin/facility/tasks/:taskId/complete` | |

**Rules**

- Equipment marked out of service SHALL be excluded from the exercise library's
  available-equipment reads, so programming does not prescribe a broken machine.
  Check `@shark/domain`'s safety scanning before duplicating that logic.
- A **safety**-severity work order is a plain-register surface and escalates to
  the Command Center exception list.
- Closing a work order requires a resolution note.
- `out_of_service` is a **hold, not a derived status**. Closing the last safety
  work order SHALL NOT return an asset to service. `out_of_service` is never
  lifted by an automatic transition; only `POST …/return-to-service` lifts it,
  it requires a note recorded in the audit log, and it is refused while open
  safety or blocked work stands. The resulting status is re-derived, so an asset
  with open routine work returns as `in_maintenance`, not `available`.
- The ceremony is **proportional to the risk**. An asset with any safety work
  order in its history is a *safety hold*: lifting it additionally requires a
  management role, checked against `ctx.role` rather than `facility.manage` so
  that widening that permission cannot silently widen who may clear a hold, and
  a plain `PATCH … {status: 'available'}` on it is refused. An asset that was
  only ever administratively down — pulled for a relocation, say — carries no
  such history, and needs only `facility.manage`.
- A work order that keeps its `in_progress` or `blocked` state after losing its
  assignee is reported with `needsReassignment`, so work that is live but
  unstaffed is visible rather than merely unassigned.

**Edge cases — all covered by tests:** equipment moved between branches with an
open work order (assignees who do not cover the destination are unassigned and
the clearance audited); a safety order left open past its SLA; a recurring task
whose branch is temporarily closed.

---

## Phase 9 — Support: tickets, SLA and retention — **BUILT** (PR open)

**Requirements:** PF-SUP-001 … PF-SUP-006 — all six implemented and tested.
**Permissions:** `support.manage`.
**Files:** `apps/api/src/services/support.ts` (every rule, ~1,100 lines),
`apps/api/src/routes/admin/support.ts` (thin adapter),
`packages/domain/src/support.ts` (the pure rules — SLA, transitions,
effectiveness, NPS/CSAT), `packages/contracts/src/schemas/support.ts` (the wire
shapes), `apps/admin-web/src/screens/Support.tsx` plus `screens/support/*`
(three surfaces), `apps/api/src/__tests__/phase9-support.integration.test.ts`
(46 tests), `packages/domain/src/__tests__/support.test.ts` (29),
`apps/admin-web/src/screens/__tests__/Support.test.tsx` and
`screens/support/__tests__/*` (53).

**Migration:** `infrastructure/migrations/0002_phase9_support.sql` adds
`ticket_events`, `feedback` and `interventions`, plus ten additive nullable
columns on `tickets`. `ticket_events` gets `BEFORE UPDATE`/`BEFORE DELETE`
guard triggers in `migrate.ts`, joining `audit_log`, `xp_ledger` and
`stock_ledger` as append-only. **The table count is now 93.**

**Seed:** seven tickets across the states a desk actually has (one breaching,
one answered inside its promise, one waiting on each side, one closed, one
anonymous escalated complaint), their conversations and immutable timelines,
51 feedback responses clearing the NPS and CSAT reporting floors, real
cancellation reasons, and eight interventions with enough closed outcomes on
one action to make a retention rate reportable.

### Five decisions worth not re-litigating

**One history, not two.** A ticket already owns a `conversations` row with
`kind: 'support'` and a `ticket_id`, created by the member app. A staff reply is
a `messages` row in *that* conversation and emits the same `message.created` on
the member's channel that their phone already listens to. A staff-side reply
store would have produced two records of one exchange that disagree the first
time either side edits or deletes — and a dispute is exactly when that matters.
Verified in the browser: one reply, one message row, one `member:` event, one
timeline entry carrying the message id.

**The SLA is computed; only the promise and the facts are stored.** `slaDueAt`,
`slaResponseMinutes`, `openedAt` and `firstResponseAt` persist; the verdict is
derived on every read. The clock stops at the **first reply**, not at
resolution — a desk that answers in twenty minutes and then spends a week
fixing a boiler has kept its promise — and once a first reply exists the verdict
never changes again, because whether it was late is a fact about the past.
Quietly resolving a never-answered ticket does not launder the breach.

**The clock runs in open hours.** A four-hour promise made at 22:40 does not
fall due at 02:40 with nobody in the building, and a queue sorted by such a
deadline puts every overnight ticket at the top every morning — which is the
same as having no priority order. `slaDeadline` walks forward through the
branch's own hours in the branch's own timezone, via `lib/branch-time.ts`. The
member app now computes its promise from the same table and the same helper, so
the member and the desk cannot be told two different numbers about one ticket.

**Anonymity is absence, not masking.** An anonymous report carries no
`member_id` and no conversation. There is nothing to unmask because nothing was
written down — which also means the desk cannot reply, stated plainly on the
response rather than discovered by a button that fails. It remains fully
workable: assignable, escalatable, resolvable.

**Escalation is one-way.** PF-SUP-006 asks for immutable records for disputes
and safety incidents. A flag that can be quietly lowered by whoever is being
disputed with is not a record, so escalation takes an author and a reason and is
never reversed; the ticket is resolved or closed instead. The timeline is a
separate append-only table rather than the audit log, because `audit_log` needs
`audit.view` — which reception and branch managers, the people who actually
handle complaints, do not hold. Both are written; neither can be edited.

### Realtime

One new topic: `ticket.updated`, on the branch channel (tenant channel for a
ticket that names no branch). There is deliberately **no** `ticket.replied`: a
member-visible reply is already a `message.created` on the member's channel, and
a second topic for the same fact would create the two histories the conversation
model exists to prevent. Escalation reuses `alert.raised`, which the Command
Center already consumes.

### Console

Three surfaces, because the module answers three questions at three rhythms:
**Queue** (the table is the screen — filters, four counts that double as
filters, breach-first ordering, ticket drawer with SLA, ownership, member
context, the conversation and the immutable history), **Feedback** (NPS by its
actual definition, CSAT, class and trainer ratings, and the cancellation-reason
report), **Retention** (explainable risk with per-reason weights, the PF-SUP-005
outreach refusal printed next to each member, intervention planning with the
risk score frozen at creation, and effectiveness that excludes unreachable
members and false positives from its rate).

**Edge cases covered by tests:** an anonymous harassment report that cannot be
replied to; a risk score suppressed because the branch was shut; a ticket left
open and resolvable after its member record is deleted; a cancellation that
conflicts with contract terms carried as both feedback and a real ticket; an
assignee who does not cover the ticket's branch; a reopened dispute that keeps
its reference, history and original first-reply verdict; a closed ticket that
cannot be moved; a retried reply that does not tell the member twice; a
cross-branch ticket returning 404 rather than 403.

**Two defects the suite could not see, found in the browser:** an unfiltered
read scoped to `ctx.activeBranchId` — set to the first permitted branch at
sign-in and only moved by an `x-branch-id` header — so "All branches" in the
console was a lie and an entire branch's complaints never reached an owner's
queue; and `retentionRisk` labelling a lapsed membership "Expires in −5 days".
Both fixed, both now have regression tests.

---

## Phase 10 — Reports and analytics — **BUILT** (PR #10 open)

**Requirements:** PF-RPT-001 … PF-RPT-006 — all six implemented and tested.
**Permissions:** `report.view`, `report.financial`, `report.export`.
**Files:** `apps/api/src/services/reports.ts` (every rule, 1,369 lines),
`apps/api/src/routes/admin/reports.ts` (73-line adapter),
`packages/domain/src/reports.ts` (the pure maths — periods, comparisons, basis
points, currency grouping; 23 tests),
`packages/contracts/src/schemas/reports.ts` (the wire shapes),
`apps/admin-web/src/screens/Reports.tsx` plus `screens/reports/*` (five report
surfaces and a shared strip),
`apps/api/src/__tests__/phase10-reports.integration.test.ts` (40 tests),
`apps/admin-web/src/screens/__tests__/Reports.test.tsx` (15) and
`screens/reports/__tests__/Revenue.test.tsx` (12).

**Migration:** none. `metric_rollups` already existed. The table count stays
at **93**.

**Seed:** `backfillRollups(tenantId, 180)` fills 180 days of daily metrics.
The table shipped empty, so every chart opened blank on a database full of
history — which reads as "this gym did nothing for four months" rather than
"this table was never populated". It is not what makes the figures correct
(reports materialise any day they need on demand), it is what makes the demo
honest on first load, and it exercises the same path the nightly job uses.

**Endpoints** — all implemented.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/admin/reports/revenue` | Period, branch, what sold, payment method, currency. |
| GET | `/v1/admin/reports/membership` | Joins, churn, freezes, renewals, LTV. |
| GET | `/v1/admin/reports/attendance` | Occupancy, peak hours, no-shows. |
| GET | `/v1/admin/reports/trainer` | Utilisation, retention by coach. |
| GET | `/v1/admin/reports/retention` | Cohorts and risk bands. |
| POST | `/v1/admin/reports/export` | CSV. `report.export` only. Every export audited with its filters. |

### Five decisions worth not re-litigating

**Withheld is `null`, never `0`.** `report.financial` gates money separately
from `report.view`, so a branch manager opens Reports, works the attendance,
membership and coach figures, and sees revenue as *absent* — named in
`meta.restricted`, rendered as a `PermissionState`. A zero renders as a real
number, and "revenue this month: ₹0" is something a person escalates.

**No `branchId` means every branch the caller may see.** Reports was written
against the correct rule from the start; §3.3 is now the rule everywhere.

**Every boundary is computed in the branch's timezone.** A range is stated in
dates and the tables store epoch milliseconds, so somebody has to decide when a
day begins. Doing it in the server's zone files a 23:30 sale in Bengaluru
against the previous day whenever the process runs in UTC.

**Money is never summed across currencies.** A range spanning a currency change
has no single total: `totals` is `null` and `byCurrency` carries each one.

**The daily series is cached in `metric_rollups` (PF-RPT-006).** Completed days
are computed once and stored; the current day is recomputed every time because
it is still moving. A figure served from the store says so, with the instant it
was computed. `rollUpMetrics` in `jobs/scheduler.ts` keeps the last three days
warm — three rather than one, because a day can still gain a late refund or a
corrected booking after it has ended.

### What the UI pass corrected

**`byProduct` was a grouping by free text wearing a product's name.**
`invoice_lines.product_id` is populated for a membership sale and was simply
not being read, so every row came back `productId: null` grouped by
description — two products sharing a name merged, a renamed product split in
two, and the console called it "By product". Rows now group by product id where
one exists and by description where none does, carry `identified` to say which,
and count units rather than lines. The panel is **"What sold"**, and an
unidentified row is marked "Not itemised": a shop basket posts as one free-text
line, and the Store report is where those break down by item.

**A payload that does not match the contract stays inside the report panel.**
The bodies dereference `meta.period` and map `series` on the strength of a
cast, so a shape mismatch threw and took the whole route to the error boundary
— tabs, period and branch gone. There is now a shallow shape check before
render and an error boundary behind it.

**Edge cases covered by tests:** a range with no prior comparison period; a
caller scoped to a subset of branches; an export larger than one page; a
currency change mid-range; a withheld figure; a day boundary in a non-UTC zone.

---

## Phase 11 — Settings

**Requirements:** PF-TEN-001 … PF-TEN-006.
**Permissions:** `settings.manage`.
**Files:** `apps/api/src/routes/admin/settings.ts` (stub),
`apps/admin-web/src/screens/Settings.tsx`.

**Tables:** `tenants`, `branches`, `consents` (`consents` is **not** seeded).

**Endpoints:** tenant profile; branch CRUD including hours, holidays, capacity,
rooms and access policy; tenant defaults with explicit branch-override
indicators; the guided setup checklist (PF-TEN-006); consent and
data-processing settings.

**Rules**

- Branch states are draft / active / temporarily closed / suspended / archived,
  and SHALL NOT delete history (PF-TEN-004).
- Inheritance must be **visible**: a branch value that comes from the tenant
  default renders as inherited, not as a duplicate value (PF-TEN-003).
- Changing a branch timezone must not retroactively move stored timestamps —
  they are UTC ms; only presentation changes.

**Edge cases (all four are named in the PRD and all four need tests):** a branch
created in a different timezone; a branch closed while future bookings exist; a
tenant currency change after invoices exist; a branch archived while members
retain cross-branch entitlement.

---

## Phase 12 — Automations

**Requirements:** PF-COMM-001 … PF-COMM-006.
**Permissions:** `automation.manage`.
**Files:** `apps/admin-web/src/screens/Automations.tsx`. Handlers belong in
`routes/admin/settings.ts` unless that file grows past ~600 lines, in which case
add `routes/admin/automations.ts` **and** register it in `app.ts` — the only
phase in this plan permitted to touch `app.ts`.

**Tables:** `automations`, `message_templates`, `notifications` — all seeded.

**Scope:** trigger/condition/action rule builder; template editor with variable
interpolation (`{{endsOn}}` and friends already exist in the seeded templates);
per-channel quiet hours; a dry-run preview that resolves a rule against real
data **without sending**; delivery log.

**Rules**

- A dry run SHALL NOT enqueue a notification. Make this structurally impossible,
  not merely a flag checked at the send site.
- Quiet hours are evaluated in the **branch's** timezone.
- The existing scheduler (`jobs/scheduler.ts`, 4 jobs) is the execution path —
  extend it, do not add a second scheduler.

**Edge cases:** a rule whose target audience is empty; a template referencing a
variable the member has no value for; a rule firing during quiet hours; two
rules matching the same member in one run.

---

## Phase 13 — Platform: SaaS super admin

**Requirements:** PF-PLAT-001 … PF-PLAT-006.
**Permissions:** `platform.admin`, `platform.impersonate`.
**Files:** `apps/api/src/routes/admin/settings.ts` or a new
`routes/admin/platform.ts`, `apps/admin-web/src/screens/Platform.tsx`.

**Tables:** `tenants`, `usage_meters` (seeded), `audit_log`.

**Scope:** cross-tenant list and health; per-tenant plan, quota and feature
flags; usage metering; impersonation.

**Rules — this is the highest-risk module in the plan**

- Impersonation SHALL write an `audit_log` entry on **start and end**, record
  the acting platform user, and be visibly banded in the UI for its whole
  duration so an operator cannot forget they are impersonating.
- An impersonated session SHALL NOT be able to re-enter platform admin.
- Cross-tenant reads are permitted **only** here, and only with
  `platform.admin`. Every such query must be explicit about crossing the
  boundary; do not weaken the shared repository helpers to enable it.
- Test that a normal owner — the highest ordinary role — is refused every
  platform endpoint.

---

# 5. Verification

Run from `shark-fitness/`. Node 22 is required (`.node-version`); the compiled
`better-sqlite3` binding does not load on Node 24.

```bash
fnm use 22
pnpm install
pnpm db:reset

pnpm lint             # eslint --max-warnings=0
pnpm typecheck        # 6 packages, 0 errors
pnpm test             # 717 across 4 packages
pnpm build            # both apps
git diff --check      # no whitespace damage
```

**Never pipe `pnpm test` through `tail`.** The four packages interleave and the
tail shows one of them; a package can fail while the visible summary is green.
Redirect to a file and read all four "Test Files" lines.

Before opening a PR, also run the production single-origin mode, because three
past defects were invisible in `pnpm dev` and reproduced only here:

```bash
pnpm build
cd apps/api
NODE_ENV=production PORT=8788 SHARK_SERVE_STATIC=true \
  SHARK_ALLOWED_ORIGINS=http://localhost:8788 \
  SHARK_PASS_SECRET=any-48-plus-random-bytes-for-local-testing-only \
  pnpm start
```

Then confirm: an asset URL returns `text/javascript` and **not** HTML; `/admin/`
loads with the title *Shark Fitness — Operations* after `/` has been visited (so
the service worker is active); and sign-in still succeeds with a stale session
cookie present.

CI (`.github/workflows/ci.yml`) runs all of the above plus a headless-Chrome
smoke test, and Render deploys only on `checksPass` — so a red build does not
merely fail the PR, it silently stops the demo from updating.

**A green suite is not a browser pass, and a browser pass at one width is not a
browser pass.** Every defect in §"What this session changed" that the suite
could not see was found by opening the console: at 375×812 the status strip sat
in an implicit grid column outside the viewport with no scrollbar, so sign-out
and the theme toggle were unreachable; the phone rail had never lain down
because a `@layer components` rule cannot beat a Tailwind utility on the same
element; and Escape returned focus to `<body>` in every dialog with an
autofocused field. Work the four viewports in both themes and both densities,
open a dialog, and press Escape.

---

# 6. Sequencing summary

| Phase | Module | Depends on | Requirement IDs |
|---|---|---|---|
| — | ~~Rebase Phase 6 onto main~~ — **merged** (PR #5) | — | PF-STAFF, PF-WORK |
| 7 | Store — **merged** (PR #8, `c782ea1`) | — | PF-POS-001…006 |
| 8 | Equipment — **merged** (PR #6) | — | PF-FAC-001…006 |
| 9 | Support — **merged** (PR #9, `07fb53f`) | — | PF-SUP-001…006 |
| 10 | Reports — **built** (PR #10, open) | 7, 8 | PF-RPT-001…006 |
| 11 | Settings | — | PF-TEN-001…006 |
| 12 | Automations | 11 | PF-COMM-001…006 |
| 13 | Platform | 11 | PF-PLAT-001…006 |

Phases 7, 8 and 9 are on `main`. Phase 10 is built on
`feat/phase-10-reports-ui-polish` and awaiting review as PR #10;
`metric_rollups` is seeded with 180 days and kept warm by the nightly job, so
that caveat is closed.

**Phase 11 (Settings) is the next one to start.** It is the last API stub
(`admin/settings.ts`, 7 lines) and one of the three remaining console
placeholders, and both Phase 12 and Phase 13 depend on it. Before writing it,
read §3.3: Settings is where a branch is created, renamed and archived, and an
archived branch that stays in `ctx.branchIds` is the same class of defect this
session spent its first half removing.
