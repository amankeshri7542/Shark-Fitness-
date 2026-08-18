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

Verified on `feat/phase-7-store` at `d97cf59` on **18 August 2026** (Node
22.23.2, as `.node-version` pins and CI reads). Verification evidence: `pnpm
lint` and `pnpm typecheck` clean across 6 packages, `pnpm test` **405 passing**
(101 domain, 199 API integration, 24 member PWA, 81 admin console), `pnpm build`
clean, and the production single-origin server exercised over HTTP and in a real
browser at 1440×900, 1024×768, 768×1024 and 375×812, in both themes.

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
| Database schema | **85 tables** across 5 schema files (counted as `sqliteTable()` definitions, and matching `CREATE TABLE` in the generated migration), with 110 indexes and 7 append-only guard triggers. Complete for every module in this plan. |
| Migrations | Generated and checked in at `infrastructure/migrations/`. |
| `@shark/contracts` | Zod schemas, enums, error envelope, realtime events (29 topics, including 6 for POS). `schemas/pos.ts` is the Store's canonical wire shape — the console reads it rather than keeping its own copy. |
| `@shark/domain` | Membership state machine, booking eligibility, access decisions, strength maths, adaptive engine, gamification, money, permissions, safety scanning, retention risk. 101 tests. |
| `@shark/design-tokens` | The Sonar system and the bounded copy register (`tone.ts`). |
| Member PWA | **All 18 screens implemented.** No stubs remain. |
| Admin console | **16 of 21 screens implemented** (counted as files over 60 lines). The 5 placeholders are Automations, Platform, Reports, Settings and Support. Store is now five surfaces under `screens/store/`. |
| API | **25 of 28 route modules implemented.** The 3 stubs are `admin/reports`, `admin/settings` and `admin/support`, each still 7 lines. All 28 are mounted in `app.ts`. |

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
no order, line, payment or stock movement behind.


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

## Phase 9 — Support: tickets, SLA and retention

**Requirements:** PF-SUP-001 … PF-SUP-006.
**Permissions:** `support.manage`.
**Files:** `apps/api/src/routes/admin/support.ts` (stub — note the existing TODO
already names the intended scope), `apps/admin-web/src/screens/Support.tsx`.

**Tables:** `tickets` (seeded), plus `conversations` and `messages` which the
member-side messaging already uses — reuse them rather than adding a parallel
thread model.

**Endpoints**

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/admin/support/tickets` | Filter by state, severity, assignee, SLA breach. |
| GET | `/v1/admin/support/tickets/:ticketId` | With full conversation thread. |
| POST | `/v1/admin/support/tickets` | |
| PATCH | `/v1/admin/support/tickets/:ticketId` | Assign, re-prioritise, change state. |
| POST | `/v1/admin/support/tickets/:ticketId/reply` | Appends to the member conversation. |
| POST | `/v1/admin/support/tickets/:ticketId/resolve` | Requires a resolution reason. |

**Rules**

- **Plain register throughout.** Support is in `PLAIN_ONLY_SURFACES`.
- SLA state is computed, never stored — mirror `leadSlaBreached` in
  `services/leads.ts`.
- A reply is visible to the member in the existing member messaging screens;
  verify the realtime event reaches the member channel.

**Edge cases:** ticket raised by a member who has since been deleted; reassigning
across branches; a reply written while the member is offline; SLA clock across a
branch's closed hours.

---

## Phase 10 — Reports and analytics

**Requirements:** PF-RPT-001 … PF-RPT-006.
**Permissions:** `report.view`, `report.financial`, `report.export`.
**Files:** `apps/api/src/routes/admin/reports.ts` (stub),
`apps/admin-web/src/screens/Reports.tsx`.

**Depends on Phases 7 and 8** for complete revenue and facility figures.

**Tables:** `metric_rollups` exists but is **not seeded** — seed it, or every
chart opens empty.

**Endpoints**

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/admin/reports/revenue` | By period, branch, product, payment method. |
| GET | `/v1/admin/reports/membership` | Joins, churn, freezes, renewals, LTV. |
| GET | `/v1/admin/reports/attendance` | Occupancy, peak hours, no-shows. |
| GET | `/v1/admin/reports/trainer` | Utilisation, retention by coach. |
| GET | `/v1/admin/reports/retention` | Cohorts and risk bands. |
| POST | `/v1/admin/reports/export` | CSV. `report.export` only. Audit every export. |

**Rules**

- `report.financial` gates revenue figures **separately** from `report.view`.
  The reception role holds balances but not revenue — a reception user must be
  able to open Reports and see attendance while revenue panels render
  `PermissionState`, not an error.
- Every figure declares freshness (real-time / near-real-time / batch), per
  PF-DASH-003. Reuse the freshness component already used on the Command Center.
- Exports are audited with the filter set that produced them.

**Edge cases:** a range with no prior comparison period; a user scoped to 2 of 3
branches; an export larger than one page of results; a currency change mid-range.

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

pnpm typecheck        # 6 packages, 0 errors
pnpm test             # domain + API integration
pnpm build            # both apps
```

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

---

# 6. Sequencing summary

| Phase | Module | Depends on | Requirement IDs |
|---|---|---|---|
| — | ~~Rebase Phase 6 onto main~~ — **merged** (PR #5) | — | PF-STAFF, PF-WORK |
| 7 | Store — **next** | — | PF-POS-001…006 |
| 8 | Equipment — **built** (PR #6) | — | PF-FAC-001…006 |
| 9 | Support | — | PF-SUP-001…006 |
| 10 | Reports | 7, 8 | PF-RPT-001…006 |
| 11 | Settings | — | PF-TEN-001…006 |
| 12 | Automations | 11 | PF-COMM-001…006 |
| 13 | Platform | 11 | PF-PLAT-001…006 |

Phases 7, 9 and 11 have no dependency on each other. **Phase 7 (Store) is the
next one to start**, once PR #6 is on `main`. Phase 8 is built: the safety alert
the Command Center raises now lands on a working Equipment screen.
