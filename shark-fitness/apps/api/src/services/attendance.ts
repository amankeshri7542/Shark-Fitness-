import { and, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import type { AccessDecision } from '@shark/contracts';
import { DENIAL_COPY, decideAccess, occupancyLabel } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, HOUR, isoDate, localMinutes, now } from '../lib/time.js';
import { loadMemberInScope, memberBranchIds } from './members.js';

/**
 * Front desk attendance (PF-ATT).
 *
 * The door reader path lives in `services/access.ts` and is deliberately left
 * alone. This module is the *staffed* counterpart: a person at a desk vouching
 * for a member who has no working phone, a supervisor overriding a refusal, and
 * the manual close of a session someone forgot to tap out of.
 *
 * Both paths run the same `decideAccess` rule set, so the desk and the turnstile
 * can never disagree about whether a member is entitled to be inside. What
 * differs is only the evidence: the reader trusts a signed rotating token, the
 * desk trusts a named member of staff — which is why every desk action is
 * audited with the actor and, for an override, a mandatory reason.
 */

/** An open visit older than this is stale; the cron closes it. Matches
 *  `scanSignedPass` and the Command Center so all three count the same room. */
const OPEN_SESSION_WINDOW = 6 * HOUR;

/** A denial can only be overridden while it is still the situation in front of
 *  you. Waving someone in against a refusal from this morning is not an
 *  override, it is a fabricated entry. */
const OVERRIDE_WINDOW = 30 * 60_000;

/**
 * A retry of the *same* desk action, rather than a second visit.
 *
 * `check_ins` has no idempotency-key column and the schema is fixed, so the
 * natural key is the open visit itself: a repeat check-in for a member who
 * entered moments ago is the dropped-response retry (02:731 requires check-in
 * to be idempotent), and returns the original row. Beyond this window the same
 * call means something different — they really are already inside — and is
 * refused so the desk taps them out instead of double-counting the room.
 */
const CHECK_IN_REPLAY_WINDOW = 2 * 60_000;

/**
 * `decideAccess` returns `overridable` alongside each decision; this mirrors
 * that judgement for a decision already persisted on a row. A replayed token is
 * the one refusal staff must never wave through — the fix is to open the app,
 * not to trust a screenshot (see `packages/domain/src/access.ts`).
 */
const NON_OVERRIDABLE: readonly AccessDecision[] = ['denied_token_replayed'];

export function isOverridable(decision: string): boolean {
  return decision !== 'granted' && !NON_OVERRIDABLE.includes(decision as AccessDecision);
}

/* ============================================================================
   Scoped loads. A branch-scope violation is indistinguishable from a missing
   record, because a 403 would confirm the record exists somewhere the caller
   cannot see.
   ========================================================================= */

export function loadBranchInScope(
  ctx: { tenantId: string; branchIds: string[] },
  branchId: string,
): typeof schema.branches.$inferSelect {
  const branch = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, ctx.tenantId)))
    .get();
  if (!branch || !ctx.branchIds.includes(branch.id)) throw notFound('That branch');
  return branch;
}

export function loadCheckInInScope(
  ctx: { tenantId: string; branchIds: string[] },
  checkInId: string,
): typeof schema.checkIns.$inferSelect {
  const row = db
    .select()
    .from(schema.checkIns)
    .where(and(eq(schema.checkIns.id, checkInId), eq(schema.checkIns.tenantId, ctx.tenantId)))
    .get();
  if (!row || !ctx.branchIds.includes(row.branchId)) throw notFound('That check-in');
  return row;
}

/* ============================================================================
   Occupancy
   ========================================================================= */

export interface BranchOccupancy {
  branchId: string;
  branchName: string;
  inside: number;
  capacity: number;
  label: 'quiet' | 'steady' | 'busy' | 'peak';
}

/** People currently inside, per branch. Counts only granted visits that have
 *  not been tapped out and are inside the stale window. */
export function occupancyByBranch(tenantId: string, branchIds: string[], atMs: number): BranchOccupancy[] {
  if (branchIds.length === 0) return [];

  const branches = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.tenantId, tenantId), inArray(schema.branches.id, branchIds)))
    .all();

  const counts = new Map<string, number>();
  for (const row of db
    .select({ branchId: schema.checkIns.branchId, n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        inArray(schema.checkIns.branchId, branchIds),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, atMs - OPEN_SESSION_WINDOW),
      ),
    )
    .groupBy(schema.checkIns.branchId)
    .all()) {
    counts.set(row.branchId, row.n);
  }

  return branches
    .map((branch) => {
      const inside = counts.get(branch.id) ?? 0;
      return {
        branchId: branch.id,
        branchName: branch.name,
        inside,
        capacity: branch.capacity,
        label: occupancyLabel(inside, branch.capacity),
      };
    })
    .sort((a, b) => a.branchName.localeCompare(b.branchName));
}

/** 24 branch-local buckets of today's arrivals. Index is the hour. */
export function hourlyArrivals(tenantId: string, branchIds: string[], atMs: number, tz: string): number[] {
  const hourly = Array.from({ length: 24 }, () => 0);
  if (branchIds.length === 0) return hourly;

  const today = isoDate(atMs, tz);
  // Widened a day either side then filtered on the branch-local date, so this
  // holds across a zone offset and a daylight-saving change.
  const anchor = Date.parse(`${today}T00:00:00Z`);

  for (const row of db
    .select({ enteredAt: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        inArray(schema.checkIns.branchId, branchIds),
        eq(schema.checkIns.decision, 'granted'),
        gte(schema.checkIns.enteredAt, anchor - DAY),
        lt(schema.checkIns.enteredAt, anchor + 2 * DAY),
      ),
    )
    .all()) {
    if (isoDate(row.enteredAt, tz) !== today) continue;
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(row.enteredAt),
    );
    if (hour >= 0 && hour < 24) hourly[hour] = (hourly[hour] ?? 0) + 1;
  }
  return hourly;
}

/** The member's open visit at any branch, if they are inside right now. */
export function openVisitFor(tenantId: string, memberId: string, atMs: number) {
  return db
    .select()
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        eq(schema.checkIns.memberId, memberId),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, atMs - OPEN_SESSION_WINDOW),
      ),
    )
    .orderBy(desc(schema.checkIns.enteredAt))
    .get();
}

/* ============================================================================
   The shared decision. Identical inputs to the reader path, so a member refused
   at the turnstile is refused at the desk for the same stated reason.
   ========================================================================= */

interface DeskDecision {
  decision: AccessDecision;
  granted: boolean;
  message: string | null;
  outstandingMinor: number;
  graceEndsOn: string | null;
  membershipState: string | null;
}

function decideForDesk(
  tenantId: string,
  member: typeof schema.members.$inferSelect,
  branch: typeof schema.branches.$inferSelect,
  atMs: number,
  opts: { ignoreAntiPassback?: boolean } = {},
): DeskDecision {
  const membership = db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.tenantId, tenantId),
        eq(schema.memberships.memberId, member.id),
        sql`${schema.memberships.state} != 'cancelled'`,
      ),
    )
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  const outstanding = db
    .select({ total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}), 0)` })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.tenantId, tenantId),
        eq(schema.invoices.memberId, member.id),
        sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
      ),
    )
    .get();

  const inside = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        eq(schema.checkIns.branchId, branch.id),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, atMs - OPEN_SESSION_WINDOW),
      ),
    )
    .get()?.n ?? 0;

  const lastCheckIn = db
    .select({ enteredAt: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        eq(schema.checkIns.memberId, member.id),
        eq(schema.checkIns.decision, 'granted'),
      ),
    )
    .orderBy(desc(schema.checkIns.enteredAt))
    .get();

  const policy = (db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()?.policy ??
    {}) as Record<string, unknown>;

  const outcome = decideAccess({
    membershipState: (membership?.state ?? 'expired') as 'active',
    permittedBranchIds: memberBranchIds(member),
    branchId: branch.id,
    nowMinutes: localMinutes(atMs, branch.timezone),
    opensMinutes: branch.opensMinutes,
    closesMinutes: branch.closesMinutes,
    windowStartMin: membership?.productSnapshot.access.windowStartMin ?? null,
    windowEndMin: membership?.productSnapshot.access.windowEndMin ?? null,
    outstandingMinor: outstanding?.total ?? 0,
    graceAllowsEntry: Boolean(policy.graceAllowsEntry),
    occupancy: inside,
    capacity: branch.capacity,
    // The desk is not presenting a token at all. Staff identity is the evidence,
    // so the token checks are satisfied rather than skipped.
    tokenValid: true,
    tokenReplayed: false,
    secondsSinceLastCheckIn:
      opts.ignoreAntiPassback || !lastCheckIn ? null : Math.round((atMs - lastCheckIn.enteredAt) / 1000),
    antiPassbackSeconds: Number(policy.antiPassbackSeconds ?? 90),
    alreadyInside: false,
  });

  return {
    decision: outcome.decision,
    granted: outcome.granted,
    message: outcome.granted ? null : DENIAL_COPY[outcome.decision as keyof typeof DENIAL_COPY],
    outstandingMinor: outstanding?.total ?? 0,
    graceEndsOn: membership?.graceEndsOn ?? null,
    membershipState: membership?.state ?? null,
  };
}

/** Visits recorded for this member, ever. Drives the "visit #N" stamp. */
function nextVisitNumber(tenantId: string, memberId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        eq(schema.checkIns.memberId, memberId),
        eq(schema.checkIns.decision, 'granted'),
      ),
    )
    .get();
  return (row?.n ?? 0) + 1;
}

/** Occupancy is a derived number, so it is re-read after the write rather than
 *  incremented optimistically, and announced on the branch channel. Without
 *  this the only producer of `occupancy.changed` is the six-hourly stale-close
 *  cron, which would leave a live floor view looking frozen. */
function announceOccupancy(tenantId: string, branchId: string, atMs: number): BranchOccupancy | null {
  const snapshot = occupancyByBranch(tenantId, [branchId], atMs)[0] ?? null;
  if (!snapshot) return null;
  emit({
    tenantId,
    branchId,
    channel: channels.branch(branchId),
    topic: 'occupancy.changed',
    payload: {
      branchId,
      inside: snapshot.inside,
      capacity: snapshot.capacity,
      label: snapshot.label,
    },
  });
  return snapshot;
}

export interface DeskCheckInResult {
  granted: boolean;
  decision: AccessDecision;
  checkInId: string | null;
  at: string;
  visitNumber: number | null;
  message: string | null;
  /** Named to match the `ScanResult` contract, which is the shape the console
   *  renders. `decideAccess` computes this as `overridable`. */
  canOverride: boolean;
  /** True when this call returned an existing visit instead of opening one. */
  replayed: boolean;
  member: { id: string; memberNo: string; name: string };
  branch: { id: string; name: string };
  occupancy: BranchOccupancy | null;
  outstandingMinor: number;
  graceEndsOn: string | null;
}

/**
 * PF-ATT-003 — a staffed check-in. The member is identified by the desk rather
 * than by a token, but the entitlement decision is unchanged: a refusal is
 * still recorded as a refusal, and it takes a separate, permissioned override
 * to turn one into an entry.
 */
export function manualCheckIn(
  ctx: RequestContext,
  input: { memberId: string; branchId: string; method?: 'staff' | 'kiosk' },
): DeskCheckInResult {
  const atMs = now();
  const member = loadMemberInScope(ctx, input.memberId);
  const branch = loadBranchInScope(ctx, input.branchId);

  // Someone already inside cannot enter again — that would double-count the
  // room. A repeat within the replay window is the same action retried and
  // returns the original visit; anything older is a genuine "already inside",
  // and the desk is told where so they can tap them out instead.
  const open = openVisitFor(ctx.tenantId, member.id, atMs);
  if (open) {
    if (atMs - open.enteredAt <= CHECK_IN_REPLAY_WINDOW && open.branchId === branch.id) {
      return {
        granted: true,
        decision: 'granted',
        checkInId: open.id,
        at: new Date(open.enteredAt).toISOString(),
        visitNumber: open.visitNumber,
        message: null,
        canOverride: false,
        replayed: true,
        member: { id: member.id, memberNo: member.memberNo, name: `${member.firstName} ${member.lastName}` },
        branch: { id: branch.id, name: branch.name },
        occupancy: occupancyByBranch(ctx.tenantId, [branch.id], atMs)[0] ?? null,
        outstandingMinor: 0,
        graceEndsOn: null,
      };
    }
    throw conflict(
      `${member.firstName} ${member.lastName} is already checked in at ${branchNameOf(ctx.tenantId, open.branchId)}.`,
    );
  }

  const verdict = decideForDesk(ctx.tenantId, member, branch, atMs);
  const checkInId = id('chk');
  const visitNumber = verdict.granted ? nextVisitNumber(ctx.tenantId, member.id) : null;

  transact(() => {
    db.insert(schema.checkIns)
      .values({
        id: checkInId,
        tenantId: ctx.tenantId,
        branchId: branch.id,
        memberId: member.id,
        method: input.method ?? 'staff',
        decision: verdict.decision,
        enteredAt: atMs,
        exitedAt: null,
        autoClosed: false,
        overrideById: null,
        overrideByName: null,
        overrideReason: null,
        visitNumber,
      })
      .run();

    if (verdict.granted) {
      db.update(schema.members).set({ lastVisitAt: atMs }).where(eq(schema.members.id, member.id)).run();
    }

    audit(ctx, {
      action: verdict.granted ? 'attendance.checked_in' : 'attendance.denied',
      entityType: 'member',
      entityId: member.id,
      entityLabel: member.memberNo,
      reason: verdict.granted ? null : verdict.decision,
      branchId: branch.id,
      after: { checkInId, method: input.method ?? 'staff', decision: verdict.decision },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: branch.id,
      channel: channels.branch(branch.id),
      topic: verdict.granted ? 'attendance.checked_in' : 'attendance.denied',
      payload: {
        memberId: member.id,
        memberNo: member.memberNo,
        decision: verdict.decision,
        checkInId,
        method: input.method ?? 'staff',
      },
    });
  });

  const occupancy = verdict.granted ? announceOccupancy(ctx.tenantId, branch.id, atMs) : null;

  return {
    granted: verdict.granted,
    decision: verdict.decision,
    checkInId,
    at: new Date(atMs).toISOString(),
    visitNumber,
    message: verdict.message,
    canOverride: !verdict.granted && isOverridable(verdict.decision),
    replayed: false,
    member: { id: member.id, memberNo: member.memberNo, name: `${member.firstName} ${member.lastName}` },
    branch: { id: branch.id, name: branch.name },
    occupancy: occupancy ?? occupancyByBranch(ctx.tenantId, [branch.id], atMs)[0] ?? null,
    outstandingMinor: verdict.outstandingMinor,
    graceEndsOn: verdict.graceEndsOn,
  };
}

function branchNameOf(tenantId: string, branchId: string): string {
  return (
    db
      .select({ name: schema.branches.name })
      .from(schema.branches)
      .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, tenantId)))
      .get()?.name ?? 'another branch'
  );
}

/**
 * PF-ATT-004 — a supervised override. The refusal stays on the record; a second
 * row records the entry, who authorised it and why. Nothing is edited away.
 */
export function overrideCheckIn(
  ctx: RequestContext,
  input: { checkInId: string; reason: string },
): DeskCheckInResult {
  const atMs = now();
  const reason = input.reason.trim();
  if (reason.length < 4) throw invalid('An override needs a reason of at least 4 characters.');

  const denial = loadCheckInInScope(ctx, input.checkInId);

  if (denial.decision === 'granted') throw precondition('That entry was already allowed.');
  if (!isOverridable(denial.decision)) {
    throw precondition('A reused code cannot be overridden. Ask the member to open the app for a fresh one.');
  }
  if (atMs - denial.enteredAt > OVERRIDE_WINDOW) {
    throw precondition('That refusal is too old to override. Check the member in again.');
  }
  if (!denial.memberId) throw precondition('That refusal is not linked to a member.');

  // Consumption lives on the denial row itself, so it is exact (tied to this
  // one refusal, not a time-window heuristic matched against a member) and
  // actor-independent by construction — whichever manager asks, the second
  // attempt sees the same row already marked.
  if (denial.overrideById) throw conflict('That refusal has already been overridden.');

  const member = loadMemberInScope(ctx, denial.memberId);
  const branch = loadBranchInScope(ctx, denial.branchId);

  const open = openVisitFor(ctx.tenantId, member.id, atMs);
  if (open) throw conflict(`${member.firstName} ${member.lastName} is already checked in.`);

  const checkInId = id('chk');
  const visitNumber = nextVisitNumber(ctx.tenantId, member.id);

  transact(() => {
    db.insert(schema.checkIns)
      .values({
        id: checkInId,
        tenantId: ctx.tenantId,
        branchId: branch.id,
        memberId: member.id,
        method: 'staff',
        decision: 'granted',
        enteredAt: atMs,
        exitedAt: null,
        autoClosed: false,
        overrideById: ctx.staffId ?? ctx.userId,
        overrideByName: ctx.name,
        overrideReason: reason,
        visitNumber,
      })
      .run();

    // The refusal is preserved verbatim — decision and enteredAt untouched —
    // but annotated with who resolved it and how, so it can never be
    // consumed a second time regardless of who asks.
    db.update(schema.checkIns)
      .set({ overrideById: ctx.staffId ?? ctx.userId, overrideByName: ctx.name, overrideReason: reason })
      .where(eq(schema.checkIns.id, denial.id))
      .run();

    db.update(schema.members).set({ lastVisitAt: atMs }).where(eq(schema.members.id, member.id)).run();

    audit(ctx, {
      action: 'attendance.override',
      entityType: 'member',
      entityId: member.id,
      entityLabel: member.memberNo,
      reason,
      branchId: branch.id,
      before: { checkInId: denial.id, decision: denial.decision },
      after: { checkInId, decision: 'granted', overrideBy: ctx.name },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: branch.id,
      channel: channels.branch(branch.id),
      topic: 'attendance.checked_in',
      payload: {
        memberId: member.id,
        memberNo: member.memberNo,
        decision: 'granted',
        checkInId,
        overrode: denial.id,
        overrideReason: reason,
      },
    });
  });

  const occupancy = announceOccupancy(ctx.tenantId, branch.id, atMs);

  return {
    granted: true,
    decision: 'granted',
    checkInId,
    at: new Date(atMs).toISOString(),
    visitNumber,
    message: null,
    canOverride: false,
    replayed: false,
    member: { id: member.id, memberNo: member.memberNo, name: `${member.firstName} ${member.lastName}` },
    branch: { id: branch.id, name: branch.name },
    occupancy,
    outstandingMinor: 0,
    graceEndsOn: null,
  };
}

export interface CheckOutResult {
  checkInId: string;
  replayed: boolean;
  exitedAt: string;
  durationMin: number;
  member: { id: string; memberNo: string; name: string } | null;
  occupancy: BranchOccupancy | null;
}

/**
 * Manual tap-out. Idempotent on purpose: a desk that clicks twice, or retries
 * after a dropped response, must not produce a second exit or a negative
 * occupancy — the second call returns the first result with `replayed`.
 */
export function manualCheckOut(ctx: RequestContext, input: { checkInId: string }): CheckOutResult {
  const atMs = now();
  const visit = loadCheckInInScope(ctx, input.checkInId);

  if (visit.decision !== 'granted') throw precondition('That entry was refused, so there is nothing to close.');

  const member = visit.memberId
    ? db.select().from(schema.members).where(eq(schema.members.id, visit.memberId)).get()
    : null;

  const memberSummary = member
    ? { id: member.id, memberNo: member.memberNo, name: `${member.firstName} ${member.lastName}` }
    : null;

  if (visit.exitedAt !== null) {
    return {
      checkInId: visit.id,
      replayed: true,
      exitedAt: new Date(visit.exitedAt).toISOString(),
      durationMin: Math.max(0, Math.round((visit.exitedAt - visit.enteredAt) / 60_000)),
      member: memberSummary,
      occupancy: occupancyByBranch(ctx.tenantId, [visit.branchId], atMs)[0] ?? null,
    };
  }

  transact(() => {
    db.update(schema.checkIns)
      .set({ exitedAt: atMs, autoClosed: false })
      .where(and(eq(schema.checkIns.id, visit.id), isNull(schema.checkIns.exitedAt)))
      .run();

    audit(ctx, {
      action: 'attendance.checked_out',
      entityType: 'member',
      entityId: visit.memberId ?? visit.id,
      entityLabel: memberSummary?.memberNo ?? '',
      branchId: visit.branchId,
      before: { checkInId: visit.id, exitedAt: null },
      after: { checkInId: visit.id, exitedAt: new Date(atMs).toISOString() },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: visit.branchId,
      channel: channels.branch(visit.branchId),
      topic: 'attendance.checked_out',
      payload: { memberId: visit.memberId, checkInId: visit.id },
    });
  });

  const occupancy = announceOccupancy(ctx.tenantId, visit.branchId, atMs);

  return {
    checkInId: visit.id,
    replayed: false,
    exitedAt: new Date(atMs).toISOString(),
    durationMin: Math.max(0, Math.round((atMs - visit.enteredAt) / 60_000)),
    member: memberSummary,
    occupancy,
  };
}

/**
 * Mass checkout — the facility-emergency path (Compliance PRD "Facility
 * emergency requires mass checkout and class cancellation"; acceptance
 * scenario 9).
 *
 * Evacuating a building is not a routine correction, so it carries the same
 * mandatory reason as an override and writes one audit row per person closed:
 * a fire marshal's roll call has to be reconstructable afterwards, and a single
 * summary row would not survive that. Closed sessions are flagged `autoClosed`
 * to keep them out of genuine visit-duration statistics.
 */
export function closeAllVisits(
  ctx: RequestContext,
  input: { branchId: string; reason: string },
): { branchId: string; closed: number; reason: string; occupancy: BranchOccupancy | null } {
  const atMs = now();
  const reason = input.reason.trim();
  if (reason.length < 4) throw invalid('Closing the floor needs a reason of at least 4 characters.');

  const branch = loadBranchInScope(ctx, input.branchId);

  const open = db
    .select()
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, ctx.tenantId),
        eq(schema.checkIns.branchId, branch.id),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, atMs - OPEN_SESSION_WINDOW),
      ),
    )
    .all();

  if (open.length === 0) {
    return { branchId: branch.id, closed: 0, reason, occupancy: occupancyByBranch(ctx.tenantId, [branch.id], atMs)[0] ?? null };
  }

  transact(() => {
    for (const visit of open) {
      db.update(schema.checkIns)
        .set({ exitedAt: atMs, autoClosed: true })
        .where(and(eq(schema.checkIns.id, visit.id), isNull(schema.checkIns.exitedAt)))
        .run();

      audit(ctx, {
        action: 'attendance.checked_out',
        entityType: 'member',
        entityId: visit.memberId ?? visit.id,
        entityLabel: visit.id,
        reason,
        branchId: branch.id,
        before: { checkInId: visit.id, exitedAt: null },
        after: { checkInId: visit.id, exitedAt: new Date(atMs).toISOString(), massCheckout: true },
      });
    }

    emit({
      tenantId: ctx.tenantId,
      branchId: branch.id,
      channel: channels.branch(branch.id),
      topic: 'attendance.checked_out',
      payload: { branchId: branch.id, massCheckout: true, closed: open.length, reason },
    });
  });

  return {
    branchId: branch.id,
    closed: open.length,
    reason,
    occupancy: announceOccupancy(ctx.tenantId, branch.id, atMs),
  };
}
