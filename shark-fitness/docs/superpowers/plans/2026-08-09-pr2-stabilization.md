# PR #2 Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five correctness gaps the review found in PR #2 (Phase 4 Attendance + Phase 5 Schedule) so staff booking, attendance timing, override consumption, member branch scope, and schedule validation all match the canonical member-facing rules — then merge to `main`.

**Architecture:** Extract the member booking module's eligibility/claim engine out of `routes/member/schedule.ts` into a new shared service `apps/api/src/services/booking.ts`, so both the member route and the admin route call the exact same transactional `claimSeat`. Add a narrow, explicit `claimSeatOverride` for the rare staff-bypass case, gated by a *combination* of two existing permissions (`booking.manage_others` + `schedule.manage`) rather than a new permission constant, because `packages/domain` is DO-NOT-EDIT foundation. Centralize member branch-scope loading into a new `apps/api/src/services/members.ts`. Fix attendance timing and override-consumption as small, targeted logic changes in the existing files. Harden schedule validation inline in `services/schedule.ts`.

**Tech Stack:** Hono routes, Drizzle ORM (SQLite), Zod validation, Vitest integration tests hitting `app.request()` over real HTTP semantics.

## Global Constraints

- Do not edit `packages/contracts`, `packages/domain`, `apps/api/src/db/schema`, `apps/api/src/app.ts`, `apps/member-pwa/src/router.tsx`, or `apps/member-pwa/src/ui/*` — all DO-NOT-EDIT per `docs/BUILD-PLAN.md`.
- No new DB columns/tables (schema frozen). The override-consumption fix must use only existing `check_ins` columns (`overrideById`, `overrideByName`, `overrideReason`).
- No new `packages/domain` permission constant. The staff-override booking action is gated by requiring **both** `booking.manage_others` and `schedule.manage` at the route layer — this is the "separate, dedicated" gate the review asked for, composed from what already exists.
- Every mutation that changes money/access/membership/another person's record keeps calling `audit()` inside the same `transact()`. Every write another client should see keeps calling `emit()`.
- Preserve all existing passing behavior (83 tests) — this is a stabilization pass, not a rewrite. Reuse `LIVE_BOOKING_STATES`/`LIVE_WAITLIST_STATES` from one place; do not fork them further.
- Run `pnpm -F @shark/api typecheck && pnpm -F @shark/api test && pnpm build` after every task, before commit.

---

### Task 1: Centralize member branch scope (`services/members.ts`)

**Files:**
- Create: `apps/api/src/services/members.ts`
- Modify: `apps/api/src/services/attendance.ts` (remove local `memberBranchIds`/`loadMemberInScope`, import from new file)
- Modify: `apps/api/src/routes/admin/attendance.ts:279-349` (`GET /search`), `apps/api/src/routes/admin/attendance.ts:403-419` (`GET /member/:memberId`)
- Test: `apps/api/src/__tests__/phase4-attendance.integration.test.ts`

**Interfaces:**
- Produces: `memberBranchIds(member: {id, homeBranchId}): string[]`, `loadMemberInScope(ctx: {tenantId, branchIds}, memberId: string): typeof schema.members.$inferSelect` (throws `notFound('That member')`), `memberScopeCondition(ctx: {tenantId, branchIds}): SQL` — a Drizzle where-condition true for members whose home branch OR an explicit `member_branches` grant falls inside `ctx.branchIds`.

- [ ] **Step 1: Write `services/members.ts`**

```ts
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { notFound } from '../lib/errors.js';

/**
 * Member branch scope — shared by attendance search, attendance history,
 * manual check-in and staff class booking, so a member reachable from one
 * desk workflow is reachable from all of them.
 */

/** Home branch plus any explicitly granted extra branches (`member_branches`). */
export function memberBranchIds(member: { id: string; homeBranchId: string }): string[] {
  const extra = db
    .select({ branchId: schema.memberBranches.branchId })
    .from(schema.memberBranches)
    .where(eq(schema.memberBranches.memberId, member.id))
    .all()
    .map((row) => row.branchId);
  return [...new Set([member.homeBranchId, ...extra])];
}

/** A member is reachable when their home branch — or any branch they have
 *  been explicitly added to — is inside the caller's scope. A member of
 *  another region is "not found", never "forbidden": a 403 would confirm the
 *  record exists somewhere the caller cannot see. */
export function loadMemberInScope(
  ctx: { tenantId: string; branchIds: string[] },
  memberId: string,
): typeof schema.members.$inferSelect {
  const member = db
    .select()
    .from(schema.members)
    .where(
      and(
        eq(schema.members.id, memberId),
        eq(schema.members.tenantId, ctx.tenantId),
        isNull(schema.members.deletedAt),
      ),
    )
    .get();
  if (!member) throw notFound('That member');
  if (!memberBranchIds(member).some((branchId) => ctx.branchIds.includes(branchId))) {
    throw notFound('That member');
  }
  return member;
}

/** Member ids reachable via an explicit `member_branches` grant into scope —
 *  the list-query counterpart to `loadMemberInScope`, for search/browse. */
function memberIdsGrantedInto(ctx: { tenantId: string; branchIds: string[] }): string[] {
  if (ctx.branchIds.length === 0) return [];
  return db
    .select({ memberId: schema.memberBranches.memberId })
    .from(schema.memberBranches)
    .where(
      and(eq(schema.memberBranches.tenantId, ctx.tenantId), inArray(schema.memberBranches.branchId, ctx.branchIds)),
    )
    .all()
    .map((row) => row.memberId);
}

/** Where-condition for a member list query: home branch in scope, or an
 *  explicit `member_branches` grant into scope. */
export function memberScopeCondition(ctx: { tenantId: string; branchIds: string[] }) {
  const granted = memberIdsGrantedInto(ctx);
  return granted.length > 0
    ? or(inArray(schema.members.homeBranchId, ctx.branchIds), inArray(schema.members.id, granted))!
    : inArray(schema.members.homeBranchId, ctx.branchIds);
}
```

- [ ] **Step 2: Point `services/attendance.ts` at the shared module**

Delete the local `loadMemberInScope`/`memberBranchIds` functions (lines 85-129 in the current file) and add to the top imports:

```ts
import { loadMemberInScope, memberBranchIds } from './members.js';
```

Everything else in `attendance.ts` (`loadBranchInScope`, `loadCheckInInScope`, `decideForDesk`, `manualCheckIn`, `overrideCheckIn`, etc.) is unchanged — they already call `loadMemberInScope`/`memberBranchIds` by name.

- [ ] **Step 3: Fix `GET /search` in `routes/admin/attendance.ts`**

Replace the query's branch filter. Current (line ~306):

```ts
inArray(schema.members.homeBranchId, scope),
```

New — import `memberScopeCondition` from `../../services/members.js`, and replace that one line with:

```ts
memberScopeCondition({ tenantId: ctx.tenantId, branchIds: scope }),
```

- [ ] **Step 4: Fix `GET /member/:memberId` in `routes/admin/attendance.ts`**

Replace (line ~408-419):

```ts
const member = db
  .select()
  .from(schema.members)
  .where(
    and(
      eq(schema.members.id, memberId),
      eq(schema.members.tenantId, ctx.tenantId),
      isNull(schema.members.deletedAt),
    ),
  )
  .get();
if (!member || !ctx.branchIds.includes(member.homeBranchId)) throw notFound('That member');
```

with:

```ts
const member = loadMemberInScope(ctx, memberId);
```

Import `loadMemberInScope` from `../../services/members.js`. Remove the now-unused `isNull`/`and` imports if nothing else in the file needs them (check before removing).

- [ ] **Step 5: Add a regression test proving `member_branches` reach works for search + history**

Append to `apps/api/src/__tests__/phase4-attendance.integration.test.ts`:

```ts
it('reaches a member through an explicit member_branches grant, not just the home branch', async () => {
  const reception = await signIn('reception@sharkfitness.in');
  // A member whose home branch is NOT br_kor, explicitly granted access to br_kor.
  const outsider = idleEntitledMember('br_ind');

  db.insert(schema.memberBranches)
    .values({ memberId: outsider.id, branchId: 'br_kor', tenantId: tenantId() })
    .run();

  try {
    const search = await get(reception, `/v1/admin/attendance/search?q=${outsider.memberNo}`);
    expect(search.status).toBe(200);
    const body = (await search.json()) as { items: Array<{ memberId: string }> };
    expect(body.items.some((i) => i.memberId === outsider.id)).toBe(true);

    const history = await get(reception, `/v1/admin/attendance/member/${outsider.id}`);
    expect(history.status).toBe(200);
  } finally {
    db.delete(schema.memberBranches)
      .where(and(eq(schema.memberBranches.memberId, outsider.id), eq(schema.memberBranches.branchId, 'br_kor')))
      .run();
  }
});
```

- [ ] **Step 6: Run tests**

```
cd shark-fitness && pnpm -F @shark/api test -- phase4-attendance
```
Expected: all pass, including the new one.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/members.ts apps/api/src/services/attendance.ts apps/api/src/routes/admin/attendance.ts apps/api/src/__tests__/phase4-attendance.integration.test.ts
git commit -m "fix: centralize member branch scope across attendance and booking"
```

---

### Task 2: Actor-independent override consumption

**Files:**
- Modify: `apps/api/src/services/attendance.ts` (`overrideCheckIn`, ~lines 529-638)
- Test: `apps/api/src/__tests__/phase4-attendance.integration.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `overrideCheckIn` still returns `DeskCheckInResult`; behavior change only.

**Design:** Instead of querying for a *later granted row whose `overrideById` matches the current actor* (wrong: actor-specific, and ambiguous across multiple denials for the same member), mark consumption **on the denial row itself**. When an override succeeds, also `UPDATE` the original denial's `overrideById`/`overrideByName`/`overrideReason` (its `decision` and `enteredAt` stay untouched — the refusal is still preserved verbatim). Checking "already overridden" becomes `denial.overrideById !== null`, which is exact (tied to this one row) and actor-independent by construction.

- [ ] **Step 1: Write the failing regression test first**

Append to `apps/api/src/__tests__/phase4-attendance.integration.test.ts`, after the existing override tests:

```ts
it('does not let a second manager reuse a denial another manager already overrode', async () => {
  const managerA = await signIn('manager@sharkfitness.in');
  const managerB = await signIn('owner@sharkfitness.in');
  const member = blockedMember('br_kor');

  const denial = await post(managerA, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
  const { checkInId } = (await denial.json()) as { checkInId: string };

  const first = await post(managerA, '/v1/admin/attendance/override', {
    checkInId,
    reason: 'Manager A: paying now',
  });
  expect(first.status).toBe(200);

  // Member checks out — the visit closes, but the original denial row's
  // consumption must not depend on that.
  const opened = db.select().from(schema.checkIns).where(eq(schema.checkIns.decision, 'granted')).all()
    .find((r) => r.memberId === member.id && r.overrideReason?.includes('Manager A'));
  expect(opened).toBeTruthy();
  await post(managerA, '/v1/admin/attendance/check-out', { checkInId: opened!.id });

  // A different manager tries to reuse the SAME original denial.
  const second = await post(managerB, '/v1/admin/attendance/override', {
    checkInId,
    reason: 'Manager B: also paying now',
  });
  expect(second.status).toBe(409);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```
pnpm -F @shark/api test -- phase4-attendance -t "does not let a second manager"
```
Expected: FAILS (currently 200, not 409) — the existing actor-scoped check does not catch Manager B, a different actor.

- [ ] **Step 3: Fix `overrideCheckIn` in `services/attendance.ts`**

Replace the `alreadyOverridden` query block (current lines ~548-562):

```ts
// An override that has already been actioned must not mint a second entry.
const alreadyOverridden = db
  .select({ id: schema.checkIns.id })
  .from(schema.checkIns)
  .where(
    and(
      eq(schema.checkIns.tenantId, ctx.tenantId),
      eq(schema.checkIns.memberId, denial.memberId),
      eq(schema.checkIns.decision, 'granted'),
      eq(schema.checkIns.overrideById, ctx.staffId ?? ctx.userId),
      gte(schema.checkIns.enteredAt, denial.enteredAt),
    ),
  )
  .get();
if (alreadyOverridden) throw conflict('That refusal has already been overridden.');
```

with:

```ts
// Consumption lives on the denial row itself, so it is exact (tied to this
// one refusal, not a time-window heuristic) and actor-independent by
// construction — whoever asks, the second attempt sees the same row.
if (denial.overrideById) throw conflict('That refusal has already been overridden.');
```

`gte` may now be unused in this file — check other usages before removing the import (it is used elsewhere, e.g. `occupancyByBranch`/`hourlyArrivals`, so it will still be needed; verify with a search before touching the import line).

Then in the `transact()` block that inserts the new granted row (current lines ~573-619), add an `UPDATE` of the denial row right after the `db.insert(schema.checkIns)...run()` for the new entry:

```ts
db.update(schema.checkIns)
  .set({ overrideById: ctx.staffId ?? ctx.userId, overrideByName: ctx.name, overrideReason: reason })
  .where(eq(schema.checkIns.id, denial.id))
  .run();
```

Keep the existing `audit()` and `emit()` calls unchanged — they already record `before: { checkInId: denial.id, decision: denial.decision }`.

- [ ] **Step 4: Run the test again**

```
pnpm -F @shark/api test -- phase4-attendance -t "does not let a second manager"
```
Expected: PASS. Also re-run the whole file to confirm the two pre-existing override tests (`refuses an override to reception and allows it for a manager`, `never overrides a reused code`) still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/attendance.ts apps/api/src/__tests__/phase4-attendance.integration.test.ts
git commit -m "fix: make override consumption actor-independent"
```

---

### Task 3: Correct class attendance timing

**Files:**
- Modify: `apps/api/src/services/schedule.ts` (`markAttendance`, ~lines 1005-1045)
- Modify: `apps/api/src/__tests__/phase5-schedule.integration.test.ts` (existing test at line 321)

**Design:** Block `attended` the same way `no_show` is already blocked (before `session.startsAt`). Leave `confirmed` (the revert/undo state) unguarded by time — it is always safe to clear a mark, and it is how a correction after the class starts stays reversible.

- [ ] **Step 1: Update the test first (it currently asserts the buggy behavior)**

Replace the test `'marks attendance and refuses a no-show before the class has run'` (lines 321-342) with:

```ts
it('refuses both attended and no-show before the class has run, and stays reversible after', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const created = await createSession(manager, { capacity: 4 });
  const member = idleMember('br_kor');

  const booked = await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
    memberId: member.id,
    idempotencyKey: `attend-${created.id}`,
  });
  const { booking } = (await booked.json()) as { booking: { id: string } };

  // The class is in the future, so nobody can have turned up or failed to yet.
  const earlyNoShow = await post(manager, `/v1/admin/schedule/booking/${booking.id}/attendance`, { state: 'no_show' });
  expect(earlyNoShow.status).toBe(412);
  const earlyAttended = await post(manager, `/v1/admin/schedule/booking/${booking.id}/attendance`, { state: 'attended' });
  expect(earlyAttended.status).toBe(412);

  // Move the class into the past so marking becomes possible.
  db.update(schema.classSessions)
    .set({ startsAt: now() - 60 * 60_000, endsAt: now() - 15 * 60_000 })
    .where(eq(schema.classSessions.id, created.id))
    .run();

  const marked = await post(manager, `/v1/admin/schedule/booking/${booking.id}/attendance`, { state: 'attended' });
  expect(marked.status).toBe(200);
  let row = db.select().from(schema.bookings).where(eq(schema.bookings.id, booking.id)).get();
  expect(row?.state).toBe('attended');
  expect(row?.attendedAt).not.toBeNull();

  // Corrections stay possible once the class has started.
  const corrected = await post(manager, `/v1/admin/schedule/booking/${booking.id}/attendance`, { state: 'no_show' });
  expect(corrected.status).toBe(200);
  row = db.select().from(schema.bookings).where(eq(schema.bookings.id, booking.id)).get();
  expect(row?.state).toBe('no_show');
  expect(row?.attendedAt).toBeNull();
});
```

- [ ] **Step 2: Run it to confirm it fails on the `attended`-before-start assertion**

```
pnpm -F @shark/api test -- phase5-schedule -t "refuses both attended and no-show"
```
Expected: FAILS at `expect(earlyAttended.status).toBe(412)` (currently 200).

- [ ] **Step 3: Fix `markAttendance` in `services/schedule.ts`**

Replace (current lines ~1016-1018):

```ts
if (session.startsAt > atMs && state === 'no_show') {
  throw precondition('That class has not started yet.');
}
```

with:

```ts
if (session.startsAt > atMs && (state === 'no_show' || state === 'attended')) {
  throw precondition('That class has not started yet.');
}
```

- [ ] **Step 4: Run the test again, then the full file**

```
pnpm -F @shark/api test -- phase5-schedule
```
Expected: all pass.

- [ ] **Step 5: Update the admin-web UI to match (avoid a dead-end 412 click)**

`apps/admin-web/src/screens/Schedule.tsx` already hides "No-show" until `session.started` (line ~621). Apply the same gate to "Here" (attended), current lines ~612-620:

```tsx
{canMarkAttendance && !cancelled ? (
  <div className="flex items-center gap-1.5">
    <Button
      variant={row.state === 'attended' ? 'cta' : 'outline'}
      onClick={() => onMark(row.bookingId, row.state === 'attended' ? 'confirmed' : 'attended')}
      aria-label={`Mark ${row.name} as attended`}
    >
      Here
    </Button>
    {session.started ? (
      <Button
        variant="outline"
        onClick={() => onMark(row.bookingId, row.state === 'no_show' ? 'confirmed' : 'no_show')}
        aria-label={`Mark ${row.name} as a no-show`}
      >
        No-show
      </Button>
    ) : null}
  </div>
) : null}
```

becomes:

```tsx
{canMarkAttendance && !cancelled && session.started ? (
  <div className="flex items-center gap-1.5">
    <Button
      variant={row.state === 'attended' ? 'cta' : 'outline'}
      onClick={() => onMark(row.bookingId, row.state === 'attended' ? 'confirmed' : 'attended')}
      aria-label={`Mark ${row.name} as attended`}
    >
      Here
    </Button>
    <Button
      variant="outline"
      onClick={() => onMark(row.bookingId, row.state === 'no_show' ? 'confirmed' : 'no_show')}
      aria-label={`Mark ${row.name} as a no-show`}
    >
      No-show
    </Button>
  </div>
) : null}
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/schedule.ts apps/api/src/__tests__/phase5-schedule.integration.test.ts apps/admin-web/src/screens/Schedule.tsx
git commit -m "fix: block attendance marking before a class starts"
```

---

### Task 4: Canonical booking service (`services/booking.ts`)

This is the largest task. It extracts the member module's eligibility+claim engine into a shared service, then makes both member and admin routes call it.

**Files:**
- Create: `apps/api/src/services/booking.ts`
- Modify: `apps/api/src/routes/member/schedule.ts` (remove now-shared local helpers, call the shared service)
- Modify: `apps/api/src/services/schedule.ts` (`bookMemberOntoSession` becomes a thin adapter; move `LIVE_BOOKING_STATES`/`LIVE_WAITLIST_STATES` re-export)
- Modify: `apps/api/src/routes/admin/schedule.ts` (add `acceptDropInCharge` to `BookBody`, add the new `book-override` route)
- Test: `apps/api/src/__tests__/phase5-schedule.integration.test.ts`, `apps/api/src/__tests__/*` (member booking tests — locate and confirm unaffected)
- Modify (UI): `apps/admin-web/src/lib/api.ts` (expose `details` on `ApiError`), `apps/admin-web/src/screens/Schedule.tsx` (override affordance + drop-in charge confirmation)

**Interfaces:**
- Produces from `services/booking.ts`:
  - `LIVE_BOOKING_STATES`, `LIVE_WAITLIST_STATES` (moved here, single source of truth)
  - `interface SessionRow` (the classType/room/trainer-joined shape), `sessionColumns`, `sessionQuery()`, `sessionById(tenantId, sessionId): SessionRow | undefined`
  - `interface MembershipStanding`, `membershipStanding(memberId): MembershipStanding`
  - `classCreditsHeld(memberId, today): number`
  - `deadHoldCount(sessionIds, atMs): Map<string, number>`
  - `reapExpiredHolds(sessionId, atMs): number`
  - `myBookingFor(memberId, sessionId)`, `myWaitlistFor(memberId, sessionId)`, `myBookingsAround(memberId, fromMs, toMs)`, `overlapWith(session, others): string | null`
  - `interface EligibilityContext`, `eligibilityFor(session, effectiveBooked, scope, mine)`
  - `refuse(eligibility, session): AppError`
  - `runClaim<T>(fn: () => T): T`
  - `interface ClaimSeatInput { session: SessionRow; memberId: string; idempotencyKey: string; acceptDropInCharge: boolean; bookedByStaff: boolean; today: string; atMs: number }`
  - `interface ClaimSeatResult { booking: typeof schema.bookings.$inferSelect; replayed: boolean; creditsUsed: number; chargeMinor: number }`
  - `claimSeat(ctx: RequestContext, input: ClaimSeatInput): ClaimSeatResult`
  - `interface ClaimSeatOverrideInput { session: SessionRow; memberId: string; idempotencyKey: string; reason: string; atMs: number }`
  - `claimSeatOverride(ctx: RequestContext, input: ClaimSeatOverrideInput): ClaimSeatResult`
- Consumes (from `services/schedule.ts`): `loadSessionInScope` (unused by booking.ts — booking.ts owns its own `sessionById`/scope pattern; `services/schedule.ts` keeps `loadSessionInScope` for non-booking session reads).
- Consumes (from `services/members.ts`, Task 1): `loadMemberInScope`.

- [ ] **Step 1: Write `services/booking.ts`**

```ts
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { evaluateEligibility, holdIsLive, isEntitled } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { DAY, now } from '../lib/time.js';
import {
  AppError,
  capacityExhausted,
  conflict,
  entitlementMissing,
  forbidden,
  precondition,
} from '../lib/errors.js';

/**
 * The canonical booking engine — one claim, used by the member's own booking
 * (`routes/member/schedule.ts`) and staff booking a member on from the desk
 * (`services/schedule.ts`). Both run the exact same eligibility evaluation and
 * the exact same transactional last-seat claim, so a seat taken from the desk
 * behaves identically to one taken from the phone: same entitlement checks,
 * same credit/charge accounting, same idempotency.
 *
 * A staff member who must genuinely bypass eligibility (comping a seat) uses
 * `claimSeatOverride` instead — a distinct, narrowly-gated action, never the
 * default path.
 */

export const LIVE_BOOKING_STATES = ['held', 'confirmed', 'attended'] as const;
export const LIVE_WAITLIST_STATES = ['waiting', 'offered'] as const;

export interface SessionRow {
  id: string;
  branchId: string;
  classTypeId: string;
  trainerId: string | null;
  startsAt: number;
  endsAt: number;
  capacity: number;
  booked: number;
  state: string;
  bookingOpensAt: number | null;
  cancelDeadlineAt: number | null;
  creditsRequired: number;
  dropInPriceMinor: number | null;
  lateCancelFeeMinor: number;
  waitlistEnabled: boolean;
  cancelledReason: string | null;
  substituteFor: string | null;
  name: string;
  category: string;
  description: string;
  durationMin: number;
  intensity: string;
  roomName: string | null;
  trainerName: string | null;
}

export const sessionColumns = {
  id: schema.classSessions.id,
  branchId: schema.classSessions.branchId,
  classTypeId: schema.classSessions.classTypeId,
  trainerId: schema.classSessions.trainerId,
  startsAt: schema.classSessions.startsAt,
  endsAt: schema.classSessions.endsAt,
  capacity: schema.classSessions.capacity,
  booked: schema.classSessions.booked,
  state: schema.classSessions.state,
  bookingOpensAt: schema.classSessions.bookingOpensAt,
  cancelDeadlineAt: schema.classSessions.cancelDeadlineAt,
  creditsRequired: schema.classSessions.creditsRequired,
  dropInPriceMinor: schema.classSessions.dropInPriceMinor,
  lateCancelFeeMinor: schema.classSessions.lateCancelFeeMinor,
  waitlistEnabled: schema.classSessions.waitlistEnabled,
  cancelledReason: schema.classSessions.cancelledReason,
  substituteFor: schema.classSessions.substituteFor,
  name: schema.classTypes.name,
  category: schema.classTypes.category,
  description: schema.classTypes.description,
  durationMin: schema.classTypes.durationMin,
  intensity: schema.classTypes.intensity,
  roomName: schema.rooms.name,
  trainerName: schema.users.name,
};

export function sessionQuery() {
  return db
    .select(sessionColumns)
    .from(schema.classSessions)
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
    .leftJoin(schema.rooms, eq(schema.rooms.id, schema.classSessions.roomId))
    .leftJoin(schema.staff, eq(schema.staff.id, schema.classSessions.trainerId))
    .leftJoin(schema.users, eq(schema.users.id, schema.staff.userId));
}

export function sessionById(tenantId: string, sessionId: string): SessionRow | undefined {
  return sessionQuery()
    .where(and(eq(schema.classSessions.tenantId, tenantId), eq(schema.classSessions.id, sessionId)))
    .get();
}

export interface MembershipStanding {
  entitled: boolean;
  state: string | null;
  reason: string | null;
  productName: string | null;
  allBranches: boolean;
}

/** Money and access always speak plainly — never the predator register. */
export function membershipStanding(memberId: string): MembershipStanding {
  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} != 'cancelled'`))
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  if (!membership) {
    return {
      entitled: false,
      state: null,
      reason: 'You do not have a membership yet. Reception can set one up in a few minutes.',
      productName: null,
      allBranches: false,
    };
  }

  const entitled = isEntitled(membership.state as 'active');
  const reasons: Record<string, string> = {
    expired: 'Your membership has ended. Renew it and you can book again.',
    frozen: 'Your membership is frozen. Unfreeze it to book classes.',
    suspended: 'Your membership is suspended. Reception can explain what happens next.',
    pending_payment: 'Your membership starts once the first payment clears.',
    draft: 'Your membership is not active yet. Reception can finish setting it up.',
    cancel_scheduled: 'Your membership is closing. Reception can reinstate it if you want to keep booking.',
  };

  return {
    entitled,
    state: membership.state,
    reason: entitled ? null : (reasons[membership.state] ?? 'Your membership does not cover bookings right now.'),
    productName: membership.productName,
    allBranches: membership.productSnapshot.access.allBranches,
  };
}

/** Class credits on hand. Expired grants drop out; spends never do. */
export function classCreditsHeld(memberId: string, today: string): number {
  return db
    .select({ delta: schema.credits.delta, expiresOn: schema.credits.expiresOn })
    .from(schema.credits)
    .where(and(eq(schema.credits.memberId, memberId), eq(schema.credits.kind, 'class')))
    .all()
    .reduce((total, row) => total + (row.expiresOn !== null && row.expiresOn < today ? 0 : row.delta), 0);
}

/** A held seat whose hold has lapsed is not a seat. `booked` is denormalised,
 *  so read paths discount dead holds and the write paths reap them for real. */
export function deadHoldCount(sessionIds: string[], atMs: number): Map<string, number> {
  const counts = new Map<string, number>();
  if (sessionIds.length === 0) return counts;

  const held = db
    .select({ sessionId: schema.bookings.sessionId, bookedAt: schema.bookings.bookedAt })
    .from(schema.bookings)
    .where(and(inArray(schema.bookings.sessionId, sessionIds), eq(schema.bookings.state, 'held')))
    .all();

  const at = new Date(atMs);
  for (const row of held) {
    if (holdIsLive(new Date(row.bookedAt), at)) continue;
    counts.set(row.sessionId, (counts.get(row.sessionId) ?? 0) + 1);
  }
  return counts;
}

/** Cancels holds that have lapsed and gives their seats back. Call inside a
 *  transaction, before a claim, so the last seat is honestly counted. */
export function reapExpiredHolds(sessionId: string, atMs: number): number {
  const held = db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.sessionId, sessionId), eq(schema.bookings.state, 'held')))
    .all();

  const at = new Date(atMs);
  let reaped = 0;
  for (const booking of held) {
    if (holdIsLive(new Date(booking.bookedAt), at)) continue;
    db.update(schema.bookings).set({ state: 'cancelled', cancelledAt: atMs }).where(eq(schema.bookings.id, booking.id)).run();
    db.update(schema.classSessions)
      .set({ booked: sql`max(0, ${schema.classSessions.booked} - 1)` })
      .where(eq(schema.classSessions.id, sessionId))
      .run();
    reaped += 1;
  }
  return reaped;
}

export function myBookingFor(memberId: string, sessionId: string) {
  return db
    .select()
    .from(schema.bookings)
    .where(
      and(
        eq(schema.bookings.memberId, memberId),
        eq(schema.bookings.sessionId, sessionId),
        inArray(schema.bookings.state, [...LIVE_BOOKING_STATES]),
      ),
    )
    .get();
}

export function myWaitlistFor(memberId: string, sessionId: string) {
  return db
    .select()
    .from(schema.waitlistEntries)
    .where(
      and(
        eq(schema.waitlistEntries.memberId, memberId),
        eq(schema.waitlistEntries.sessionId, sessionId),
        inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
      ),
    )
    .get();
}

/** Every other seat this member holds anywhere near the given window. Branch
 *  does not matter — a person cannot be in two rooms at once. */
export function myBookingsAround(memberId: string, fromMs: number, toMs: number) {
  return db
    .select({
      bookingId: schema.bookings.id,
      sessionId: schema.bookings.sessionId,
      startsAt: schema.classSessions.startsAt,
      endsAt: schema.classSessions.endsAt,
    })
    .from(schema.bookings)
    .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
    .where(
      and(
        eq(schema.bookings.memberId, memberId),
        inArray(schema.bookings.state, [...LIVE_BOOKING_STATES]),
        sql`${schema.classSessions.state} != 'cancelled'`,
        gte(schema.classSessions.endsAt, fromMs),
        lt(schema.classSessions.startsAt, toMs),
      ),
    )
    .all();
}

export function overlapWith(
  session: { id: string; startsAt: number; endsAt: number },
  others: Array<{ sessionId: string; startsAt: number; endsAt: number }>,
): string | null {
  const clash = others.find((o) => o.sessionId !== session.id && o.startsAt < session.endsAt && o.endsAt > session.startsAt);
  return clash?.sessionId ?? null;
}

export interface EligibilityContext {
  atMs: number;
  today: string;
  standing: MembershipStanding;
  branchIds: string[];
  creditsHeld: number;
  otherBookings: Array<{ sessionId: string; startsAt: number; endsAt: number }>;
}

export function eligibilityFor(
  session: SessionRow,
  effectiveBooked: number,
  scope: EligibilityContext,
  mine: { booked: boolean; waitlisted: boolean },
) {
  return evaluateEligibility({
    now: new Date(scope.atMs),
    startsAt: new Date(session.startsAt),
    bookingOpensAt: session.bookingOpensAt === null ? null : new Date(session.bookingOpensAt),
    cancelDeadlineAt: session.cancelDeadlineAt === null ? null : new Date(session.cancelDeadlineAt),
    capacity: session.capacity,
    booked: effectiveBooked,
    sessionCancelled: session.state === 'cancelled',
    membershipEntitled: scope.standing.entitled,
    membershipReason: scope.standing.reason,
    branchPermitted: scope.branchIds.includes(session.branchId),
    creditsRequired: session.creditsRequired,
    creditsHeld: scope.creditsHeld,
    dropInPriceMinor: session.dropInPriceMinor,
    lateCancelFeeMinor: session.lateCancelFeeMinor,
    alreadyBooked: mine.booked,
    onWaitlist: mine.waitlisted,
    conflictsWithSessionId: overlapWith(session, scope.otherBookings),
    waitlistEnabled: session.waitlistEnabled,
  });
}

/** Turns a blocked eligibility into the error the write path should throw, so
 *  the caller reads the same sentence whichever door they came through. */
export function refuse(eligibility: ReturnType<typeof evaluateEligibility>, session: SessionRow): AppError {
  const reason = eligibility.reason;
  if (session.state === 'cancelled') return precondition(reason);
  if (eligibility.action === 'closed') return new AppError('BOOKING_WINDOW_CLOSED', reason);
  if (eligibility.conflictsWithSessionId) return conflict(reason);
  if (eligibility.action === 'waitlist') return capacityExhausted(reason);
  if (reason === 'Class is full.') return capacityExhausted(reason);
  if (reason === 'You are on the waitlist.') return conflict(reason);
  if (reason === 'Your membership does not include this branch.') return forbidden(reason);
  return entitlementMissing(reason);
}

/** The database refuses an overbook whatever the service layer believes. If
 *  that guard ever fires it is a real business outcome, not a fault, so it
 *  leaves here as CAPACITY_EXHAUSTED rather than a 500. */
export function runClaim<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('CAPACITY_EXHAUSTED')) throw capacityExhausted();
    if (message.includes('bookings_live_uq')) throw conflict('That member already has a seat in this class.');
    if (message.includes('bookings_idem_uq')) {
      throw conflict('That booking was already recorded. Refresh to see it.');
    }
    throw err;
  }
}

export interface ClaimSeatInput {
  session: SessionRow;
  memberId: string;
  idempotencyKey: string;
  acceptDropInCharge: boolean;
  bookedByStaff: boolean;
  today: string;
  atMs: number;
}

export interface ClaimSeatResult {
  booking: typeof schema.bookings.$inferSelect;
  replayed: boolean;
  creditsUsed: number;
  chargeMinor: number;
}

/**
 * The last-seat claim (PF-SCH-003). One function, called by the member's own
 * booking and by staff booking a member on, so entitlement, credits, drop-in
 * charges and conflicts are evaluated identically either way.
 */
export function claimSeat(ctx: RequestContext, input: ClaimSeatInput): ClaimSeatResult {
  const { memberId, idempotencyKey } = input;

  return transact(() => {
    const existing = db
      .select()
      .from(schema.bookings)
      .where(and(eq(schema.bookings.tenantId, ctx.tenantId), eq(schema.bookings.idempotencyKey, idempotencyKey)))
      .get();
    if (existing) {
      if (existing.memberId !== memberId || existing.sessionId !== input.session.id) {
        throw new AppError('IDEMPOTENCY_MISMATCH', 'That request key was already used for a different booking.');
      }
      return { booking: existing, replayed: true, creditsUsed: existing.creditsUsed, chargeMinor: existing.chargeMinor };
    }

    reapExpiredHolds(input.session.id, input.atMs);
    const fresh = sessionById(ctx.tenantId, input.session.id)!;

    const mineAlready = myBookingFor(memberId, fresh.id);
    if (mineAlready) {
      return { booking: mineAlready, replayed: true, creditsUsed: mineAlready.creditsUsed, chargeMinor: mineAlready.chargeMinor };
    }

    const standing = membershipStanding(memberId);
    const creditsHeld = classCreditsHeld(memberId, input.today);
    const eligibility = eligibilityFor(
      fresh,
      fresh.booked,
      {
        atMs: input.atMs,
        today: input.today,
        standing,
        branchIds: ctx.branchIds,
        creditsHeld,
        otherBookings: myBookingsAround(memberId, fresh.startsAt - DAY, fresh.endsAt + DAY),
      },
      { booked: false, waitlisted: myWaitlistFor(memberId, fresh.id) !== null },
    );

    if (eligibility.action !== 'book' && eligibility.action !== 'pay') throw refuse(eligibility, fresh);

    const payingCash = eligibility.action === 'pay';
    if (payingCash && !input.acceptDropInCharge) {
      throw new AppError('PAYMENT_REQUIRED', eligibility.reason, { details: { dropInPriceMinor: fresh.dropInPriceMinor } });
    }

    const claim = db
      .update(schema.classSessions)
      .set({ booked: sql`${schema.classSessions.booked} + 1`, updatedAt: input.atMs, version: sql`${schema.classSessions.version} + 1` })
      .where(
        and(
          eq(schema.classSessions.id, fresh.id),
          eq(schema.classSessions.tenantId, ctx.tenantId),
          sql`${schema.classSessions.booked} < ${schema.classSessions.capacity}`,
          sql`${schema.classSessions.state} != 'cancelled'`,
        ),
      )
      .run();
    if (claim.changes === 0) throw capacityExhausted();

    const seatNo =
      db.select({ booked: schema.classSessions.booked }).from(schema.classSessions).where(eq(schema.classSessions.id, fresh.id)).get()
        ?.booked ?? fresh.booked + 1;

    const creditsUsed = payingCash ? 0 : fresh.creditsRequired;
    const chargeMinor = payingCash ? (fresh.dropInPriceMinor ?? 0) : 0;
    const cameFromWaitlist = myWaitlistFor(memberId, fresh.id) !== null;

    const bookingId = id('bkg');
    db.insert(schema.bookings)
      .values({
        id: bookingId,
        tenantId: ctx.tenantId,
        sessionId: fresh.id,
        memberId,
        state: 'confirmed',
        seatNo,
        bookedAt: input.atMs,
        cancelledAt: null,
        heldUntil: null,
        creditsUsed,
        chargeMinor,
        cameFromWaitlist,
        idempotencyKey,
        attendedAt: null,
      })
      .run();

    if (creditsUsed > 0) {
      db.insert(schema.credits)
        .values({
          id: id('crd'),
          tenantId: ctx.tenantId,
          memberId,
          kind: 'class',
          delta: -creditsUsed,
          reason: `Booked ${fresh.name}`,
          refType: 'booking',
          refId: bookingId,
          expiresOn: null,
          createdAt: input.atMs,
        })
        .run();
    }

    if (cameFromWaitlist) {
      const waiting = myWaitlistFor(memberId, fresh.id);
      if (waiting) {
        db.update(schema.waitlistEntries).set({ state: 'confirmed', resolvedAt: input.atMs }).where(eq(schema.waitlistEntries.id, waiting.id)).run();
      }
    }

    audit(ctx, {
      action: 'booking.confirmed',
      entityType: 'booking',
      entityId: bookingId,
      entityLabel: fresh.name,
      branchId: fresh.branchId,
      after: { seatNo, creditsUsed, chargeMinor, sessionId: fresh.id, bookedByStaff: input.bookedByStaff },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: fresh.branchId,
      channel: channels.branch(fresh.branchId),
      topic: 'booking.confirmed',
      payload: { bookingId, sessionId: fresh.id, memberId, seatNo, booked: seatNo, capacity: fresh.capacity, byStaff: input.bookedByStaff },
    });

    const booking = db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).get()!;
    return { booking, replayed: false, creditsUsed, chargeMinor };
  });
}

export interface ClaimSeatOverrideInput {
  session: SessionRow;
  memberId: string;
  idempotencyKey: string;
  reason: string;
  atMs: number;
}

/**
 * A deliberate staff bypass — comping a seat regardless of membership state,
 * credits, booking window or overlapping bookings. Physical capacity is still
 * respected (the conditional UPDATE and the DB trigger both still apply): an
 * override waives eligibility, not physics. Always free (`creditsUsed: 0,
 * chargeMinor: 0`) and always audited with the reason and `override: true`,
 * so it can never be mistaken for a normal booking in the trail.
 */
export function claimSeatOverride(ctx: RequestContext, input: ClaimSeatOverrideInput): ClaimSeatResult {
  const reason = input.reason.trim();
  if (reason.length < 4) throw new AppError('VALIDATION_FAILED', 'An override needs a reason of at least 4 characters.');
  const { memberId, idempotencyKey } = input;

  return transact(() => {
    const existing = db
      .select()
      .from(schema.bookings)
      .where(and(eq(schema.bookings.tenantId, ctx.tenantId), eq(schema.bookings.idempotencyKey, idempotencyKey)))
      .get();
    if (existing) {
      if (existing.memberId !== memberId || existing.sessionId !== input.session.id) {
        throw new AppError('IDEMPOTENCY_MISMATCH', 'That request key was already used for a different booking.');
      }
      return { booking: existing, replayed: true, creditsUsed: existing.creditsUsed, chargeMinor: existing.chargeMinor };
    }

    reapExpiredHolds(input.session.id, input.atMs);
    const fresh = sessionById(ctx.tenantId, input.session.id)!;
    if (fresh.state === 'cancelled') throw precondition('That class was cancelled.');

    const mineAlready = myBookingFor(memberId, fresh.id);
    if (mineAlready) return { booking: mineAlready, replayed: true, creditsUsed: mineAlready.creditsUsed, chargeMinor: mineAlready.chargeMinor };

    const claim = db
      .update(schema.classSessions)
      .set({ booked: sql`${schema.classSessions.booked} + 1`, updatedAt: input.atMs, version: sql`${schema.classSessions.version} + 1` })
      .where(
        and(
          eq(schema.classSessions.id, fresh.id),
          eq(schema.classSessions.tenantId, ctx.tenantId),
          sql`${schema.classSessions.booked} < ${schema.classSessions.capacity}`,
          sql`${schema.classSessions.state} != 'cancelled'`,
        ),
      )
      .run();
    if (claim.changes === 0) throw capacityExhausted();

    const seatNo =
      db.select({ booked: schema.classSessions.booked }).from(schema.classSessions).where(eq(schema.classSessions.id, fresh.id)).get()
        ?.booked ?? fresh.booked + 1;

    const bookingId = id('bkg');
    db.insert(schema.bookings)
      .values({
        id: bookingId,
        tenantId: ctx.tenantId,
        sessionId: fresh.id,
        memberId,
        state: 'confirmed',
        seatNo,
        bookedAt: input.atMs,
        cancelledAt: null,
        heldUntil: null,
        creditsUsed: 0,
        chargeMinor: 0,
        cameFromWaitlist: false,
        idempotencyKey,
        attendedAt: null,
      })
      .run();

    audit(ctx, {
      action: 'booking.confirmed',
      entityType: 'booking',
      entityId: bookingId,
      entityLabel: fresh.name,
      reason,
      branchId: fresh.branchId,
      after: { seatNo, sessionId: fresh.id, override: true, overrideReason: reason },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: fresh.branchId,
      channel: channels.branch(fresh.branchId),
      topic: 'booking.confirmed',
      payload: { bookingId, sessionId: fresh.id, memberId, seatNo, booked: seatNo, capacity: fresh.capacity, byStaff: true, override: true },
    });

    const booking = db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).get()!;
    return { booking, replayed: false, creditsUsed: 0, chargeMinor: 0 };
  });
}
```

- [ ] **Step 2: Point `routes/member/schedule.ts` at the shared module**

Remove these now-duplicated local definitions from `routes/member/schedule.ts`: `LIVE_BOOKING_STATES`, `LIVE_WAITLIST_STATES` (lines 49-50), `interface SessionRow` (63-88), `sessionColumns` (90-115), `sessionQuery` (117-125), `sessionById` (127-131), `classCreditsHeld` (134-141), `interface MembershipStanding` (143-149), `membershipStanding` (152-187), `deadHoldCount` (193-212), `reapExpiredHolds` (216-238), `myBookingFor` (241-253), `myWaitlistFor` (255-267), `myBookingsAround` (271-291), `overlapWith` (293-301), `interface EligibilityContext` (308-315), `eligibilityFor` (317-343), `refuse` (347-358), `runClaim` (926-939).

Add to the top imports:

```ts
import {
  LIVE_BOOKING_STATES,
  LIVE_WAITLIST_STATES,
  claimSeat,
  classCreditsHeld,
  deadHoldCount,
  eligibilityFor,
  membershipStanding,
  myBookingFor,
  myBookingsAround,
  myWaitlistFor,
  overlapWith,
  reapExpiredHolds,
  runClaim,
  sessionById,
  type SessionRow,
} from '../../services/booking.js';
```

Drop `evaluateEligibility`, `holdIsLive`, `isEntitled`, `planPromotion as WaitlistCandidate`-only-used-locals from the `@shark/domain` import at the top if they are no longer referenced directly in this file after the move — check each remaining usage (`classifyCancellation` and `planPromotion`/`WaitlistCandidate` are still used by `promoteWaitlist` in this same file, so keep those two).

Replace the `POST /book` handler's transactional body. Current (lines 717-875, the `runClaim(() => transact(() => {...}))` call): replace the whole `const result = runClaim(...)` block with:

```ts
const result = runClaim(() =>
  claimSeat(ctx, {
    session,
    memberId,
    idempotencyKey: body.idempotencyKey,
    acceptDropInCharge: body.acceptDropInCharge,
    bookedByStaff: false,
    today,
    atMs,
  }),
);
```

Everything after that (the response-building `c.json({...})` block, lines 877-919) is unchanged — it already only reads `result.booking`/`result.chargeMinor`/`replayed` from local `result`/`replayed` bindings. Note `replayed` was previously a `let` mutated inside the transact closure; it must now be read from `result.replayed` instead — replace every `replayed` reference in the response block with `result.replayed`, and delete the now-unused `let replayed = false;` declaration above the claim call.

- [ ] **Step 3: Rewrite `bookMemberOntoSession` in `services/schedule.ts` as a thin adapter**

Replace the whole current function body (lines 715-821) with:

```ts
export function bookMemberOntoSession(
  ctx: RequestContext,
  input: { sessionId: string; memberId: string; idempotencyKey: string; acceptDropInCharge: boolean },
) {
  const atMs = now();
  const member = loadMemberInScope(ctx, input.memberId);
  const session = sessionById(ctx.tenantId, input.sessionId);
  if (!session || !ctx.branchIds.includes(session.branchId)) throw notFound('That class');

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, session.branchId)).get();
  const tz = branch?.timezone ?? 'Asia/Kolkata';
  const today = isoDate(atMs, tz);

  return runClaim(() =>
    claimSeat(ctx, {
      session,
      memberId: member.id,
      idempotencyKey: input.idempotencyKey,
      acceptDropInCharge: input.acceptDropInCharge,
      bookedByStaff: true,
      today,
      atMs,
    }),
  );
}

/**
 * A deliberate eligibility bypass — comping a seat. Gated at the route layer
 * by requiring `booking.manage_others` AND `schedule.manage` together (no new
 * permission constant: `packages/domain` is DO-NOT-EDIT foundation), so
 * ordinary staff booking never silently becomes an override.
 */
export function bookMemberOntoSessionOverride(
  ctx: RequestContext,
  input: { sessionId: string; memberId: string; idempotencyKey: string; reason: string },
) {
  const atMs = now();
  const member = loadMemberInScope(ctx, input.memberId);
  const session = sessionById(ctx.tenantId, input.sessionId);
  if (!session || !ctx.branchIds.includes(session.branchId)) throw notFound('That class');

  return runClaim(() =>
    claimSeatOverride(ctx, {
      session,
      memberId: member.id,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      atMs,
    }),
  );
}
```

Update the top of `services/schedule.ts`:
- Remove the local `export const LIVE_BOOKING_STATES = [...]` / `export const LIVE_WAITLIST_STATES = [...]` (lines 27-28); add `LIVE_BOOKING_STATES, LIVE_WAITLIST_STATES` to a new import from `./booking.js`.
- Add import: `import { claimSeat, claimSeatOverride, runClaim, sessionById, LIVE_BOOKING_STATES, LIVE_WAITLIST_STATES } from './booking.js';`
- Add import: `import { loadMemberInScope } from './members.js';`
- Add `isoDate` to the existing `../lib/time.js` import (already imports `MINUTE, localTime, now`).
- Every other function in this file (`loadSessionInScope`, `detectClashes`, `createSession`, `updateSession`, `cancelSessions`, `releaseBooking`, `promoteFromWaitlist`, `markAttendance`) is unaffected — they reference `LIVE_BOOKING_STATES`/`LIVE_WAITLIST_STATES` by name, which now resolve to the imported bindings instead of local consts.

- [ ] **Step 4: Add the override route and drop-in consent to `routes/admin/schedule.ts`**

Import `bookMemberOntoSessionOverride` alongside the existing `bookMemberOntoSession` import.

Replace `BookBody` (current lines 511-514):

```ts
const BookBody = z.object({
  memberId: z.string().min(1),
  idempotencyKey: z.string().min(8),
});
```

with:

```ts
const BookBody = z.object({
  memberId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  acceptDropInCharge: z.boolean().default(false),
});
```

Update the handler (current lines 516-525) to pass it through:

```ts
scheduleRoutes.post('/session/:id/book', validate('json', BookBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'booking.manage_others');
  const body = c.req.valid('json');
  const result = bookMemberOntoSession(ctx, { sessionId: c.req.param('id'), ...body });
  return c.json({
    replayed: result.replayed,
    booking: { id: result.booking.id, seatNo: result.booking.seatNo, state: result.booking.state },
    charge: result.chargeMinor > 0 ? { amountMinor: result.chargeMinor } : null,
  });
});
```

Add the new override route immediately after it:

```ts
const BookOverrideBody = z.object({
  memberId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  reason: z.string().trim().min(4).max(280),
});

/**
 * A deliberate eligibility bypass. Requires BOTH `booking.manage_others` and
 * `schedule.manage` — reception has the first but not the second, so this
 * action is a manager-and-above call, never an implicit part of ordinary
 * staff booking.
 */
scheduleRoutes.post('/session/:id/book-override', validate('json', BookOverrideBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'booking.manage_others');
  requirePermission(ctx, 'schedule.manage');
  const body = c.req.valid('json');
  const result = bookMemberOntoSessionOverride(ctx, { sessionId: c.req.param('id'), ...body });
  return c.json({
    replayed: result.replayed,
    booking: { id: result.booking.id, seatNo: result.booking.seatNo, state: result.booking.state },
  });
});
```

- [ ] **Step 5: Update `apps/admin-web/src/lib/api.ts` to expose `details`**

Add to the `ApiError` class (mirroring the existing `retryAfterSec` optional-field pattern):

```ts
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: Array<{ path: string; message: string }>;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = envelope.error.code;
    this.fields = envelope.error.fields ?? [];
    this.requestId = envelope.error.requestId;
    if (envelope.error.details) this.details = envelope.error.details;
  }
}
```

- [ ] **Step 6: Update `apps/admin-web/src/screens/Schedule.tsx`**

Add state for the override affordance and the drop-in confirmation, near the existing `bookMemberId` state (line 124):

```tsx
const [bookOverride, setBookOverride] = useState(false);
const [overrideReason, setOverrideReason] = useState('');
const [pendingCharge, setPendingCharge] = useState<{ memberId: string; dropInPriceMinor: number | null } | null>(null);
```

Add `canManage` is already read at the top (line 114) — reuse it as the override gate: `const canOverrideBooking = canBookOthers && canManage;`.

Replace the `bookMember` mutation (current lines 185-199) to accept the extra fields and surface `PAYMENT_REQUIRED` as a confirmation step rather than a dead-end error:

```tsx
const bookMember = useMutation({
  mutationFn: (input: { sessionId: string; memberId: string; acceptDropInCharge?: boolean }) =>
    api<{ replayed: boolean }>(`/admin/schedule/session/${input.sessionId}/book`, {
      method: 'POST',
      body: {
        memberId: input.memberId,
        idempotencyKey: idempotencyKey('admin-book', input.sessionId, input.memberId),
        acceptDropInCharge: input.acceptDropInCharge ?? false,
      },
      branchId,
    }),
  onSuccess: (r) => {
    setActionError(null);
    setPendingCharge(null);
    setNotice(r.replayed ? 'That member already had a seat.' : 'Seat booked.');
    setBookMemberId('');
    refresh();
  },
  onError: (err, input) => {
    if (err instanceof ApiError && err.code === 'PAYMENT_REQUIRED') {
      setPendingCharge({ memberId: input.memberId, dropInPriceMinor: (err.details?.dropInPriceMinor as number | undefined) ?? null });
      return;
    }
    fail(err);
  },
});

const bookMemberOverride = useMutation({
  mutationFn: (input: { sessionId: string; memberId: string; reason: string }) =>
    api<{ replayed: boolean }>(`/admin/schedule/session/${input.sessionId}/book-override`, {
      method: 'POST',
      body: { memberId: input.memberId, idempotencyKey: idempotencyKey('admin-book-override', input.sessionId, input.memberId), reason: input.reason },
      branchId,
    }),
  onSuccess: (r) => {
    setActionError(null);
    setNotice(r.replayed ? 'That member already had a seat.' : 'Seat booked as an override.');
    setBookMemberId('');
    setOverrideReason('');
    setBookOverride(false);
    refresh();
  },
  onError: fail,
});
```

Replace the "Book a member on" block (current lines 644-658) with a version that offers the override toggle (only when `canOverrideBooking`) and the drop-in confirmation:

```tsx
{canBookOthers && !cancelled && session.seatsLeft > 0 ? (
  <div className="flex flex-col gap-2">
    <div className="flex items-end gap-2">
      <Field
        label="Book a member on"
        placeholder="Member ID"
        hint={`${session.seatsLeft} ${session.seatsLeft === 1 ? 'seat' : 'seats'} left`}
        value={bookMemberId}
        onChange={(e) => setBookMemberId(e.target.value)}
        className="max-w-[320px]"
      />
      <Button
        variant={bookOverride ? 'warn' : 'cta'}
        disabled={busy || bookMemberId.trim().length < 3 || (bookOverride && overrideReason.trim().length < 4)}
        onClick={() =>
          bookOverride
            ? bookMemberOverride.mutate({ sessionId: session.id, memberId: bookMemberId.trim(), reason: overrideReason.trim() })
            : bookMember.mutate({ sessionId: session.id, memberId: bookMemberId.trim() })
        }
      >
        {bookOverride ? 'Book seat (override)' : 'Book seat'}
      </Button>
    </div>

    {canOverrideBooking ? (
      <label className="flex items-center gap-2 text-[12px] text-foam-45">
        <input type="checkbox" checked={bookOverride} onChange={(e) => setBookOverride(e.target.checked)} />
        Override eligibility — bypass membership, credits and booking-window checks. Requires a reason and is always audited.
      </label>
    ) : null}

    {bookOverride ? (
      <Field
        label="Override reason"
        placeholder="Why this member is being booked without meeting the usual checks"
        value={overrideReason}
        onChange={(e) => setOverrideReason(e.target.value)}
        className="max-w-[420px]"
      />
    ) : null}

    {pendingCharge ? (
      <div className="flex items-center gap-2 border border-line-strong px-3 py-2 text-[12px]">
        <span>
          This class needs a class credit the member does not have.
          {pendingCharge.dropInPriceMinor ? ` A drop-in charge of ₹${(pendingCharge.dropInPriceMinor / 100).toLocaleString('en-IN')} applies.` : ''}
          {' '}Confirm the member will pay?
        </span>
        <Button
          variant="cta"
          disabled={busy}
          onClick={() => bookMember.mutate({ sessionId: session.id, memberId: pendingCharge.memberId, acceptDropInCharge: true })}
        >
          Confirm charge
        </Button>
        <Button variant="ghost" onClick={() => setPendingCharge(null)}>
          Cancel
        </Button>
      </div>
    ) : null}
  </div>
) : null}
```

Check the `Button` component's `variant` union in `apps/admin-web/src/ui/console.tsx` includes `'warn'`; if it does not, use `'outline'` instead and rely on the label text change alone for the "clearly labelled" requirement.

Also pass `busy` including the two new mutations where `busy` is computed (search for where `bookMember.isPending` is combined into a `busy` boolean and add `bookMemberOverride.isPending`).

- [ ] **Step 7: Locate and update any existing member-side booking integration tests**

```
grep -rl "member/schedule/book" apps/api/src/__tests__
```
Read whichever file(s) match, confirm they still pass unmodified (the response shape from `claimSeat` matches the old inline logic exactly — same field names). Run that file's suite.

- [ ] **Step 8: Write the new admin-side regression tests**

Append to `apps/api/src/__tests__/phase5-schedule.integration.test.ts`:

```ts
it('enforces the same eligibility rules on staff booking as member self-booking', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const created = await createSession(manager, { capacity: 2 });

  // A member with no active membership cannot be booked by staff either.
  const noMembership = db
    .select({ id: schema.members.id })
    .from(schema.members)
    .leftJoin(schema.memberships, eq(schema.memberships.memberId, schema.members.id))
    .where(and(eq(schema.members.homeBranchId, 'br_kor'), sql`${schema.memberships.id} is null`))
    .get();
  if (noMembership) {
    const response = await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: noMembership.id,
      idempotencyKey: `no-membership-${created.id}`,
    });
    expect([402, 403, 409, 412, 422]).toContain(response.status);
    const session = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, created.id)).get();
    expect(session?.booked).toBe(0);
  }
});

it('charges credits on a staff booking exactly as a member self-booking would', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const created = await createSession(manager, { capacity: 2, creditsRequired: 1 });
  const member = idleMember('br_kor');

  db.insert(schema.credits)
    .values({
      id: `crd_test_${created.id}`,
      tenantId: tenantId(),
      memberId: member.id,
      kind: 'class',
      delta: 2,
      reason: 'Test grant',
      refType: 'booking',
      refId: null,
      expiresOn: null,
      createdAt: now(),
    })
    .run();

  const response = await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
    memberId: member.id,
    idempotencyKey: `credit-charge-${created.id}`,
  });
  expect(response.status).toBe(200);

  const booking = db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.sessionId, created.id), eq(schema.bookings.memberId, member.id)))
    .get();
  expect(booking?.creditsUsed).toBe(1);

  const spend = db
    .select({ n: sql<number>`coalesce(sum(${schema.credits.delta}), 0)` })
    .from(schema.credits)
    .where(and(eq(schema.credits.memberId, member.id), eq(schema.credits.kind, 'class')))
    .get();
  expect(spend!.n).toBe(1); // granted 2, spent 1
});

it('refuses an overlapping class to staff booking exactly as it would to the member', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const member = idleMember('br_kor');
  const first = await createSession(manager, { capacity: 2 });
  await post(manager, `/v1/admin/schedule/session/${first.id}/book`, { memberId: member.id, idempotencyKey: `ov-a-${first.id}` });

  // A second session at the exact same time, same branch.
  const overlapResponse = await post(manager, '/v1/admin/schedule/session', {
    branchId: 'br_kor',
    classTypeId,
    roomId: null,
    trainerId: null,
    startsAt: first.startsAt,
    durationMin: 45,
    capacity: 2,
  });
  const overlap = (await overlapResponse.json()) as { session: { id: string } };

  const clash = await post(manager, `/v1/admin/schedule/session/${overlap.session.id}/book`, {
    memberId: member.id,
    idempotencyKey: `ov-b-${overlap.session.id}`,
  });
  expect(clash.status).toBe(409);
});

it('lets a manager override eligibility with a reason, but refuses it to reception', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const reception = await signIn('reception@sharkfitness.in');
  const created = await createSession(manager, { capacity: 2 });

  const noMembership = db
    .select({ id: schema.members.id })
    .from(schema.members)
    .leftJoin(schema.memberships, eq(schema.memberships.memberId, schema.members.id))
    .where(and(eq(schema.members.homeBranchId, 'br_kor'), sql`${schema.memberships.id} is null`))
    .get();
  if (!noMembership) return;

  const refused = await post(reception, `/v1/admin/schedule/session/${created.id}/book-override`, {
    memberId: noMembership.id,
    idempotencyKey: `override-reception-${created.id}`,
    reason: 'Trying it on',
  });
  expect(refused.status).toBe(403);

  const allowed = await post(manager, `/v1/admin/schedule/session/${created.id}/book-override`, {
    memberId: noMembership.id,
    idempotencyKey: `override-manager-${created.id}`,
    reason: 'VIP guest — comping this class per owner approval',
  });
  expect(allowed.status).toBe(200);

  const booking = db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.sessionId, created.id), eq(schema.bookings.memberId, noMembership.id)))
    .get();
  expect(booking?.chargeMinor).toBe(0);
  expect(booking?.creditsUsed).toBe(0);

  const audited = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, 'booking.confirmed'), eq(schema.auditLog.entityId, booking!.id)))
    .get();
  expect(audited?.n).toBeGreaterThan(0);
});
```

- [ ] **Step 9: Run the full API test suite**

```
pnpm -F @shark/api typecheck && pnpm -F @shark/api test
```
Expected: all pass (83 pre-existing + new ones). Fix any type errors from the refactor (moved-symbol imports are the likely source).

- [ ] **Step 10: Typecheck the frontend**

```
pnpm -F @shark/admin-web typecheck
```

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/booking.ts apps/api/src/services/schedule.ts apps/api/src/routes/member/schedule.ts apps/api/src/routes/admin/schedule.ts apps/admin-web/src/lib/api.ts apps/admin-web/src/screens/Schedule.tsx apps/api/src/__tests__/phase5-schedule.integration.test.ts
git commit -m "fix: unify member and staff class booking on one canonical service"
```

---

### Task 5: Harden schedule validation

**Files:**
- Modify: `apps/api/src/services/schedule.ts` (`assertResources`, `createSession`, `updateSession`)
- Modify: `apps/api/src/routes/admin/schedule.ts` (`PatchBody` — make `version` required)
- Test: `apps/api/src/__tests__/phase5-schedule.integration.test.ts`

- [ ] **Step 1: Write the failing tests first**

Append to `apps/api/src/__tests__/phase5-schedule.integration.test.ts`:

```ts
it('refuses a class capacity larger than the room it is booked into', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const room = db.select().from(schema.rooms).where(eq(schema.rooms.id, roomKor)).get()!;

  const response = await post(manager, '/v1/admin/schedule/session', {
    branchId: 'br_kor',
    classTypeId,
    roomId: roomKor,
    trainerId: null,
    startsAt: futureSlot().startsAt,
    durationMin: 45,
    capacity: room.capacity + 50,
  });
  expect(response.status).toBe(422);
});

it('refuses a class created in the past', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const response = await post(manager, '/v1/admin/schedule/session', {
    branchId: 'br_kor',
    classTypeId,
    roomId: null,
    trainerId: null,
    startsAt: new Date(now() - DAY).toISOString(),
    capacity: 5,
  });
  expect(response.status).toBe(422);
});

it('refuses a booking-open time that is not before the class starts', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const slot = futureSlot();
  const response = await post(manager, '/v1/admin/schedule/session', {
    branchId: 'br_kor',
    classTypeId,
    roomId: null,
    trainerId: null,
    startsAt: slot.startsAt,
    capacity: 5,
    bookingOpensAt: slot.startsAt,
  });
  expect(response.status).toBe(422);
});

it('refuses a cancel deadline that is not before the class starts', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const slot = futureSlot();
  const response = await post(manager, '/v1/admin/schedule/session', {
    branchId: 'br_kor',
    classTypeId,
    roomId: null,
    trainerId: null,
    startsAt: slot.startsAt,
    capacity: 5,
    cancelDeadlineAt: new Date(slot.ms + 60_000).toISOString(),
  });
  expect(response.status).toBe(422);
});

it('requires the current version on every session PATCH', async () => {
  const manager = await signIn('manager@sharkfitness.in');
  const created = await createSession(manager);

  const noVersion = await patch(manager, `/v1/admin/schedule/session/${created.id}`, { capacity: 4 });
  expect(noVersion.status).toBe(422);
});
```

Note: `DAY` must be imported at the top of the test file (`import { now } from '../lib/time.js';` already exists — add `DAY` alongside it).

- [ ] **Step 2: Run them to confirm they fail**

```
pnpm -F @shark/api test -- phase5-schedule -t "refuses a class capacity larger"
```
Expected: all five new tests currently fail (creation succeeds where it should not; PATCH without version currently succeeds).

- [ ] **Step 3: Harden `assertResources` and `createSession` in `services/schedule.ts`**

Replace `assertResources`'s signature and room check (current lines 252-281):

```ts
function assertResources(
  tenantId: string,
  input: { branchId: string; classTypeId: string; roomId: string | null; trainerId: string | null; capacity: number },
) {
  const classType = db
    .select()
    .from(schema.classTypes)
    .where(and(eq(schema.classTypes.id, input.classTypeId), eq(schema.classTypes.tenantId, tenantId)))
    .get();
  if (!classType) throw invalid('That class type does not exist.');

  if (input.roomId) {
    const room = db.select().from(schema.rooms).where(and(eq(schema.rooms.id, input.roomId), eq(schema.rooms.tenantId, tenantId))).get();
    if (!room) throw invalid('That room does not exist.');
    if (room.branchId !== input.branchId) throw invalid('That room belongs to another branch.');
    if (input.capacity > room.capacity) {
      throw invalid(`This room seats ${room.capacity}. Reduce the class capacity or choose a bigger room.`);
    }
  }

  if (input.trainerId) {
    const trainer = db.select({ branchIds: schema.staff.branchIds }).from(schema.staff).where(and(eq(schema.staff.id, input.trainerId), eq(schema.staff.tenantId, tenantId))).get();
    if (!trainer) throw invalid('That trainer does not exist.');
    if (!trainer.branchIds.includes(input.branchId)) throw invalid('That trainer is not assigned to this branch.');
  }

  return classType;
}
```

Update both call sites to pass `capacity`:
- In `createSession` (current line 285): `const classType = assertResources(ctx.tenantId, { ...input, capacity: input.capacity });` — since `input` already has `branchId`, `classTypeId`, `roomId`, `trainerId`, `capacity`, a plain `assertResources(ctx.tenantId, input)` now satisfies the wider signature (input has all five fields already); no destructuring change needed, just confirm the extra `capacity` field flows through (it already exists on `SessionInput`).
- In `updateSession` (current line 384-389): change to `assertResources(ctx.tenantId, { branchId: session.branchId, classTypeId: session.classTypeId, roomId, trainerId, capacity });` (the local `capacity` variable computed a few lines above already accounts for `patch.capacity ?? session.capacity`).

Add three temporal guards to `createSession`, right after the existing `if (input.capacity < 1) throw invalid(...)` line (current line 289):

```ts
if (input.startsAt <= atMs) throw invalid('A class must start in the future.');
if (input.bookingOpensAt !== null && input.bookingOpensAt >= input.startsAt) {
  throw invalid('Booking must open before the class starts.');
}
if (input.cancelDeadlineAt !== null && input.cancelDeadlineAt >= input.startsAt) {
  throw invalid('The cancellation deadline must be before the class starts.');
}
```

- [ ] **Step 4: Require `version` on PATCH**

In `routes/admin/schedule.ts`, change `PatchBody` (current line 435):

```ts
version: z.number().int().optional(),
```
to:
```ts
version: z.number().int(),
```

(Removing `.optional()` makes it a required field — Zod will 422 a request that omits it.)

In `services/schedule.ts`'s `updateSession`, add a defense-in-depth check right after the existing cancelled-state check (current line 375, before the version-mismatch check):

```ts
if (patch.version === undefined) throw invalid('The current version is required to edit a class.');
```

- [ ] **Step 5: Run the full schedule test file**

```
pnpm -F @shark/api test -- phase5-schedule
```
Expected: all pass, including every pre-existing test — check specifically that `'rejects an edit made against a stale version'` and `'refuses to shrink a class below the people already in it'` still pass now that `version` is mandatory (they already pass `version: created.version` on every PATCH call, so they should be unaffected; confirm by reading their bodies).

- [ ] **Step 6: Run the full API suite + typecheck + build**

```
pnpm -F @shark/api typecheck && pnpm -F @shark/api test && pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/schedule.ts apps/api/src/routes/admin/schedule.ts apps/api/src/__tests__/phase5-schedule.integration.test.ts
git commit -m "fix: harden schedule validation — room capacity, timing invariants, mandatory version"
```

---

### Task 6: Live HTTP verification, PR update, merge

**Files:** none (verification + git/GitHub operations only).

- [ ] **Step 1: Full verification suite**

```bash
cd shark-fitness
pnpm -F @shark/api typecheck
pnpm -F @shark/member-pwa typecheck
pnpm -F @shark/admin-web typecheck
pnpm -F @shark/api test
pnpm build
```
All must be green before continuing.

- [ ] **Step 2: Live-verify the two riskiest flows over real HTTP**

Start the dev API (or use the already-running :8787 instance), sign in as `manager@sharkfitness.in` and `reception@sharkfitness.in`, and manually curl:
1. Staff booking a member with no active membership → expect a real refusal (402/403/409/412/422 matching the eligibility reason), not a free confirmed booking.
2. The override endpoint as reception → expect 403; as manager with a reason → expect 200, and confirm via `GET /admin/schedule/session/:id` that the roster shows the booking with `creditsUsed: 0`.
3. Two-manager override-reuse scenario against a live denial.
4. `PATCH /admin/schedule/session/:id` without `version` → expect 422.

Paste the real responses into the final report — do not claim success without this, per `docs/BUILD-PLAN.md`'s "Verify before you report."

- [ ] **Step 3: Update the PR description**

Use `gh pr edit 2 --body "..."` to append a "Stabilization" section summarizing the five fixes, the two architecture decisions (booking-override permission composition; denial-row-based override consumption), and the new test count.

- [ ] **Step 4: Push and merge**

```bash
git push origin agent/phases-4-5
gh pr view 2 --json statusCheckRollup,mergeable
```
Wait for CI to go green on the pushed commits, then:
```bash
gh pr merge 2 --merge
```
Only after explicit confirmation that every check above passed — this is a merge to `main`, ask the user first if anything is ambiguous.
