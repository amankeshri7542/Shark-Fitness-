# Shark Fitness

A multi-tenant gym operating system: a member PWA and a staff operations console,
built to the four PRDs in the parent directory.

```
apps/
  api/            Hono + SQLite (D1-compatible) + Drizzle. 86 tables, migrations, seed.
  member-pwa/     React + Vite PWA, mobile-first, offline-capable.
  admin-web/      React + Vite operations console, desktop-first.
packages/
  contracts/      Zod schemas, enums, error + event envelopes. One source of truth.
  domain/         Pure business rules. 101 tests. No I/O, no framework.
  design-tokens/  The Sonar design system + the copy register.
infrastructure/
  migrations/     Generated SQL, checked in.
docs/
  DESIGN.md       The visual direction and why each decision was made.
  BUILD-PLAN.md   Conventions every contributor builds against.
  ADR-001-runtime.md  Why this deviates from the PRD's Cloudflare/Expo stack.
```

## Running it

```bash
pnpm install
pnpm db:reset      # migrate + seed. Deterministic — same gym every time.
pnpm dev           # api :8787 · member :5173 · admin :5174
```

The seed builds one tenant (Shark Fitness, Bengaluru) with three branches, 39 members,
550 class sessions across 21 days, a six-week training programme, twelve weeks of
workout history, live floor occupancy, and the awkward states the PRDs demand — a
member in grace with a failed payment, a full class with a waitlist, a lead past its
SLA, an overdue safety work order.

## Signing in

| Account | Role | What it demonstrates |
|---|---|---|
| `aman@sharkfitness.in` | member | Active, mid-block, level 8, PRs, a pending adaptive change |
| `rohit@sharkfitness.in` | member | Grace period with a failed renewal — the denial path |
| `owner@sharkfitness.in` | owner | The whole console |
| `manager@sharkfitness.in` | branch manager | One branch, no refunds |
| `reception@sharkfitness.in` | reception | Six modules, balances but not revenue |
| `rehan@sharkfitness.in` | trainer | Their own roster only, no money |
| `accounts@sharkfitness.in` | accountant | Money and reports, no schedule |

Password for all: `shark1234`. Members can also sign in by OTP; in a dev build the
code is echoed to the API log and prefilled.

The console changes shape per role — that is the point, not a detail. Sign in as
reception and then as owner to see it.

## Verifying

```bash
pnpm typecheck              # all five packages, zero errors
pnpm -F @shark/domain test  # 101 tests
pnpm build                  # both apps
```

## The parts worth knowing about

**Money is integer minor units everywhere.** Tax is computed per line and summed, never
on a rounded subtotal — the two differ by a rupee often enough to matter on a
reconciliation.

**The domain package holds the rules.** Membership state machine, booking eligibility,
door decisions, the adaptive training engine, XP and streaks, retention risk, safety
scanning, dunning. All pure, all tested. Route handlers are adapters; if a rule is
being written inside a handler, it is in the wrong place.

**Tenant isolation is enforced by the repository layer**, not by the database. SQLite
and D1 have no row-level security, so every query filters on `tenantId` and every
branch-scoped query checks `ctx.branchIds`. There is no code path that reads a business
table without a tenant.

**Append-only ledgers are enforced by triggers.** `audit_log`, `xp_ledger` and
`stock_ledger` have `BEFORE UPDATE`/`BEFORE DELETE` triggers that abort. A correction
is a compensating entry, never an edit.

**Overbooking is impossible at three levels**: the eligibility rule, the transactional
claim, and a database trigger that aborts if `booked > capacity`. The last one should
never fire; it exists because the first two are code.

**Offline is real on the member app.** Every write that can happen on a gym floor goes
through an IndexedDB outbox with a client-generated id that doubles as the idempotency
key. Losing signal mid-workout costs a retry and nothing else. Bookings deliberately do
*not* queue — a last-seat claim has to wait for the server.

**Status is never colour alone.** Every `Chip` pairs its colour with a glyph, per WCAG
2.2 and the design PRD.

**The copy register is bounded.** The predator voice (Hunt / Strike / Depth / Pack) is
the training floor only. Payment, access denial, injury, support and privacy always use
the plain register — enforced by `PLAIN_ONLY_SURFACES` in `packages/design-tokens/src/tone.ts`,
so a caller cannot reach for the aggressive voice on a failed payment.

## Known deviations from the PRDs

Recorded properly in `docs/ADR-001-runtime.md`. In short: this runs on Node + SQLite +
a WebSocket hub rather than Cloudflare Workers + D1 + Durable Objects, and the member
app is a PWA rather than Expo. The SQL dialect, migrations, query shapes and realtime
contract are all the ones the PRD specifies, so the port is mechanical rather than a
rewrite.
