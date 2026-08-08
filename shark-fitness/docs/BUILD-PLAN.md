# Build conventions

Read this before touching a slice. The foundation is built and proven; these
are the rules that keep parallel work from diverging.

## Where things live

```
packages/contracts   Zod schemas + enums + error/event envelopes.  DO NOT EDIT.
packages/domain      Pure business rules, 101 tests.               DO NOT EDIT.
packages/design-tokens  Sonar tokens + the copy register.          DO NOT EDIT.
apps/api/src/db/schema  86 tables.                                 DO NOT EDIT.
apps/api/src/app.ts     Route mounts, all pre-wired.               DO NOT EDIT.
apps/member-pwa/src/router.tsx  All routes registered.             DO NOT EDIT.
apps/member-pwa/src/ui/*        Design system.                     DO NOT EDIT.
```

Every slice owns its own files. If you need something from a DO-NOT-EDIT file
that is not there, say so in your report rather than editing it.

## The reference implementation

`apps/api/src/routes/member/home.ts` and `apps/member-pwa/src/screens/Home.tsx`
are the pattern. Match them.

## Backend rules

- Route files are adapters. Validate with `zValidator`, call a service,
  serialise. No business logic in a handler.
- Reach for `@shark/domain` before writing a rule. `evaluateEligibility`,
  `decideAccess`, `adaptLoad`, `retentionRisk`, `levelFor`, `computeStreak`,
  `totalsFor`, `invoiceStateFor`, `recoveryPct`, `platesPerSide` already exist
  and are tested. Do not reimplement them.
- Every query filters on `ctx.tenantId`. Every branch-scoped query also checks
  `ctx.branchIds`. Use `requireBranch` / `requirePermission` from `lib/context`.
- Throw `AppError` (or the shorthands in `lib/errors`). Never return a bare 500.
- Anything that changes money, access, membership state, or another person's
  record calls `audit(ctx, {...})` in the same transaction.
- Anything another client should see immediately calls `emit({...})` from
  `lib/events` with a topic from the `EventTopic` enum.
- Mutations that must not run twice take an `idempotencyKey` in the body and
  are unique-indexed on it. The booking claim and payment recording already
  have their indexes.
- Capacity changes go through `transact()` in `db/client` — it is the single
  concurrency authority, and the database has a trigger that will abort an
  overbook regardless.

## Frontend rules

- Build from `ui/primitives` and `ui/shell`. Do not write raw bordered divs;
  use `Panel`, `Seam`, `Metric`, `Chip`, `Button`, `Bar`, `Display`, `Eyebrow`,
  `Label`, `SectionRule`.
- Colour: only the token utilities (`text-sonar`, `border-line`, `bg-wash-flare`,
  …). No hex values in a component. No `rounded-*`. No `shadow-*`.
- Every screen implements **loading, empty, error, and offline**. `Skeleton`,
  `EmptyState`, `ErrorState`, `PermissionState` exist for this. A loading state
  preserves layout; an empty state says what to do next; permission denial never
  looks like missing data.
- Copy in the member's register via `useCopy()`. Pass a surface —
  `useCopy('billing')`, `useCopy('access-denied')` — on anything to do with
  money, access denial, injury, privacy or support: those force the plain
  register. See `packages/design-tokens/src/tone.ts`.
- Writes that can happen on a gym floor go through `enqueue()` from
  `lib/outbox`, never a bare fetch. Logging a set, logging a habit, sending a
  message. Booking a class does **not** — a last-seat claim must wait for the
  server, and the design PRD says so.
- Touch targets ≥44px. Every icon-only control gets an `aria-label`. Status is
  never colour alone — `Chip` handles this for you.

## Voice

Plain verbs, sentence case, active voice. Say what a control does: "Log set",
not "Submit". An error explains what happened and how to fix it, and does not
apologise. An empty screen is an invitation.

The predator register (Hunt / Strike / Depth / Pack) is the training floor
only. Never on payment, denial, injury, support or privacy.

## Verify before you report

```
pnpm -F @shark/api typecheck
pnpm -F @shark/member-pwa typecheck
pnpm -F @shark/admin-web typecheck
```

The API is running on :8787, seeded. Sign in for a token:

```
curl -s -X POST localhost:8787/v1/auth/password \
  -H 'content-type: application/json' \
  -d '{"email":"aman@sharkfitness.in","password":"shark1234"}'
```

Then curl your own endpoint with `-H "authorization: Bearer $TOKEN"` and paste
the real response into your report. Do not claim an endpoint works without it.

Demo accounts: `aman@sharkfitness.in` (active member, mid-block),
`rohit@sharkfitness.in` (grace period, failed payment),
`owner@ / manager@ / reception@ / rehan@ / nikhil@ / priya@ / accounts@sharkfitness.in`.
Password for all: `shark1234`.
