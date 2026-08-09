import { and, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { id, initialsOf, normalizeEmail, normalizePhone } from '../lib/ids.js';
import { now } from '../lib/time.js';

/**
 * Staff directory, employment and availability (PF-STAFF).
 *
 * No capacity column exists on `staff`, so utilisation is measured against a
 * fixed, documented constant rather than a fabricated schema field — flagged
 * here rather than silently invented.
 */
const TRAINER_CAPACITY = 30;

/** A staff member is reachable when any of their assigned branches falls
 *  inside the caller's scope. Out of scope is "not found", never "forbidden"
 *  — the same rule every other single-record load in this codebase follows. */
export function loadStaffInScope(
  ctx: { tenantId: string; branchIds: string[] },
  staffId: string,
): typeof schema.staff.$inferSelect {
  const row = db
    .select()
    .from(schema.staff)
    .where(and(eq(schema.staff.id, staffId), eq(schema.staff.tenantId, ctx.tenantId)))
    .get();
  if (!row || !row.branchIds.some((b) => ctx.branchIds.includes(b))) throw notFound('That staff member');
  return row;
}

function scopeOf(ctx: { activeBranchId: string | null; branchIds: string[] }): string[] {
  return ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
}

function assignedMemberCounts(tenantId: string, staffIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (staffIds.length === 0) return counts;
  for (const row of db
    .select({ trainerId: schema.members.trainerId, n: sql<number>`count(*)` })
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenantId), inArray(schema.members.trainerId, staffIds)))
    .groupBy(schema.members.trainerId)
    .all()) {
    if (row.trainerId) counts.set(row.trainerId, row.n);
  }
  return counts;
}

export interface StaffListQuery {
  q?: string;
  role?: string;
  employmentStatus?: string;
  branchId?: string;
}

export function listStaff(ctx: RequestContext, query: StaffListQuery) {
  const scope = query.branchId ? [query.branchId] : scopeOf(ctx);
  if (scope.length === 0) return { total: 0, items: [] };

  const filters = [eq(schema.staff.tenantId, ctx.tenantId)];
  if (query.employmentStatus) filters.push(eq(schema.staff.employmentStatus, query.employmentStatus));
  if (query.role) filters.push(eq(schema.users.role, query.role));

  const rows = db
    .select({
      id: schema.staff.id,
      userId: schema.staff.userId,
      employmentStatus: schema.staff.employmentStatus,
      branchIds: schema.staff.branchIds,
      specialties: schema.staff.specialties,
      certifications: schema.staff.certifications,
      commissionRules: schema.staff.commissionRules,
      hourlyRateMinor: schema.staff.hourlyRateMinor,
      joinedOn: schema.staff.joinedOn,
      name: schema.users.name,
      initials: schema.users.initials,
      email: schema.users.email,
      phone: schema.users.phone,
      role: schema.users.role,
    })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(and(...filters))
    .orderBy(schema.users.name)
    .all()
    .filter((row) => row.branchIds.some((b) => scope.includes(b)))
    .filter((row) => {
      if (!query.q) return true;
      const term = query.q.toLowerCase();
      return row.name.toLowerCase().includes(term) || (row.email ?? '').toLowerCase().includes(term);
    });

  const counts = assignedMemberCounts(
    ctx.tenantId,
    rows.map((r) => r.id),
  );

  const items = rows.map((row) => {
    const assignedMemberCount = counts.get(row.id) ?? 0;
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      initials: row.initials,
      email: row.email,
      phone: row.phone,
      role: row.role,
      employmentStatus: row.employmentStatus,
      branchIds: row.branchIds,
      specialties: row.specialties,
      certifications: row.certifications,
      assignedMemberCount,
      utilisationPct: Math.min(100, Math.round((assignedMemberCount / TRAINER_CAPACITY) * 100)),
      joinedOn: row.joinedOn,
    };
  });

  return { total: items.length, items };
}

export interface CreateStaffInput {
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  branchIds: string[];
  specialties: string[];
}

/** Invites a new staff account — mirrors the member-invite pattern in
 *  `routes/admin/leads.ts` exactly: an `invited` user with no password, plus
 *  the role-specific profile row. */
export function createStaffMember(ctx: RequestContext, input: CreateStaffInput) {
  const atMs = now();
  if (input.branchIds.length === 0) throw invalid('A staff member needs at least one branch.');
  if (!input.branchIds.every((b) => ctx.branchIds.includes(b))) {
    throw invalid('You cannot add staff to a branch outside your own scope.');
  }

  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  return transact(() => {
    if (email) {
      const dupe = db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.email, email)))
        .get();
      if (dupe) throw conflict('Someone with that email already has an account.');
    }

    const userId = id('usr');
    const staffId = id('stf');

    db.insert(schema.users)
      .values({
        id: userId,
        tenantId: ctx.tenantId,
        email,
        phone,
        name: input.name,
        initials: initialsOf(input.name),
        role: input.role,
        accountState: 'invited',
        passwordHash: null,
        preferences: { register: 'plain', theme: 'dark', unitSystem: 'metric', haptics: true, reducedMotion: false },
        lastSeenAt: null,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();

    db.insert(schema.staff)
      .values({
        id: staffId,
        tenantId: ctx.tenantId,
        userId,
        employmentStatus: 'active',
        branchIds: input.branchIds,
        specialties: input.specialties,
        certifications: [],
        commissionRules: [],
        hourlyRateMinor: null,
        joinedOn: new Date(atMs).toISOString().slice(0, 10),
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();

    audit(ctx, {
      action: 'staff.created',
      entityType: 'staff',
      entityId: staffId,
      entityLabel: input.name,
      branchId: input.branchIds[0]!,
      after: { role: input.role, branchIds: input.branchIds },
    });

    return db.select().from(schema.staff).where(eq(schema.staff.id, staffId)).get()!;
  });
}

export interface EmploymentPatch {
  employmentStatus?: string;
  branchIds?: string[];
  specialties?: string[];
  certifications?: Array<{ name: string; expiresOn: string | null }>;
  commissionRules?: Array<{ kind: string; ratePct: number }>;
  hourlyRateMinor?: number | null;
}

/** Employment status/roster changes never delete a staff row — history
 *  (shifts, program authorship, past assignments) stays queryable through a
 *  `former` employee exactly as it does through a `replaced` assignment. */
export function updateEmployment(ctx: RequestContext, staffId: string, patch: EmploymentPatch) {
  const atMs = now();
  const staff = loadStaffInScope(ctx, staffId);

  if (patch.branchIds && patch.branchIds.length === 0) throw invalid('A staff member needs at least one branch.');
  if (patch.branchIds && !patch.branchIds.every((b) => ctx.branchIds.includes(b))) {
    throw invalid('You cannot move staff to a branch outside your own scope.');
  }

  const before = {
    employmentStatus: staff.employmentStatus,
    branchIds: staff.branchIds,
    commissionRules: staff.commissionRules,
    hourlyRateMinor: staff.hourlyRateMinor,
  };

  transact(() => {
    db.update(schema.staff)
      .set({
        employmentStatus: patch.employmentStatus ?? staff.employmentStatus,
        branchIds: patch.branchIds ?? staff.branchIds,
        specialties: patch.specialties ?? staff.specialties,
        certifications: patch.certifications ?? staff.certifications,
        commissionRules: patch.commissionRules ?? staff.commissionRules,
        hourlyRateMinor: patch.hourlyRateMinor !== undefined ? patch.hourlyRateMinor : staff.hourlyRateMinor,
        updatedAt: atMs,
      })
      .where(eq(schema.staff.id, staffId))
      .run();

    audit(ctx, {
      action: 'staff.updated',
      entityType: 'staff',
      entityId: staffId,
      branchId: staff.branchIds[0] ?? '',
      before,
      after: {
        employmentStatus: patch.employmentStatus ?? staff.employmentStatus,
        branchIds: patch.branchIds ?? staff.branchIds,
        commissionRules: patch.commissionRules ?? staff.commissionRules,
        hourlyRateMinor: patch.hourlyRateMinor !== undefined ? patch.hourlyRateMinor : staff.hourlyRateMinor,
      },
    });
  });

  return db.select().from(schema.staff).where(eq(schema.staff.id, staffId)).get()!;
}

/* ============================================================================
   Shifts — availability. Conflict detection covers the one case the schema
   fully supports: an overlapping shift for the same person. "A branch left
   without cover" would need a roster/coverage-requirement concept that does
   not exist here, so that half of the `Shift.conflict` contract field is not
   computed — flagged, not faked.
   ========================================================================= */

const OPEN_SHIFT_STATES = ['planned', 'confirmed', 'in_progress'] as const;

export function listShifts(
  ctx: { tenantId: string; branchIds: string[]; activeBranchId: string | null },
  query: { staffId?: string; branchId?: string; from: number; to: number },
) {
  const scope = query.branchId ? [query.branchId] : scopeOf(ctx);
  if (scope.length === 0) return [];

  const filters = [
    eq(schema.shifts.tenantId, ctx.tenantId),
    inArray(schema.shifts.branchId, scope),
    lt(schema.shifts.startsAt, query.to),
    gt(schema.shifts.endsAt, query.from),
  ];
  if (query.staffId) filters.push(eq(schema.shifts.staffId, query.staffId));

  return db.select().from(schema.shifts).where(and(...filters)).orderBy(schema.shifts.startsAt).all();
}

export interface CreateShiftInput {
  staffId: string;
  branchId: string;
  startsAt: number;
  endsAt: number;
  role: string;
  note: string | null;
}

export function createShift(ctx: RequestContext, input: CreateShiftInput) {
  const atMs = now();
  if (input.endsAt <= input.startsAt) throw invalid('A shift must end after it starts.');

  const staff = loadStaffInScope(ctx, input.staffId);
  if (!staff.branchIds.includes(input.branchId)) throw invalid('That staff member is not assigned to this branch.');
  if (!ctx.branchIds.includes(input.branchId)) throw notFound('That branch');

  // Half-open overlap against every other shift this person already holds,
  // regardless of branch — the same person cannot be rostered in two places.
  const overlapping = db
    .select({ id: schema.shifts.id })
    .from(schema.shifts)
    .where(
      and(
        eq(schema.shifts.tenantId, ctx.tenantId),
        eq(schema.shifts.staffId, input.staffId),
        ne(schema.shifts.state, 'absent'),
        lt(schema.shifts.startsAt, input.endsAt),
        gt(schema.shifts.endsAt, input.startsAt),
      ),
    )
    .get();
  if (overlapping) throw conflict('That overlaps a shift this person already has.');

  const shiftId = id('sft');
  db.insert(schema.shifts)
    .values({
      id: shiftId,
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      staffId: input.staffId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      role: input.role,
      state: 'planned',
      coveredByStaffId: null,
      note: input.note,
      createdAt: atMs,
    })
    .run();

  audit(ctx, {
    action: 'shift.created',
    entityType: 'shift',
    entityId: shiftId,
    branchId: input.branchId,
    after: { staffId: input.staffId, startsAt: new Date(input.startsAt).toISOString() },
  });

  return db.select().from(schema.shifts).where(eq(schema.shifts.id, shiftId)).get()!;
}

export interface ShiftStatePatch {
  state: 'planned' | 'confirmed' | 'in_progress' | 'completed' | 'absent' | 'covered';
  coveredByStaffId?: string | null;
  note?: string | null;
}

export function updateShiftState(ctx: RequestContext, shiftId: string, patch: ShiftStatePatch) {
  const shift = db
    .select()
    .from(schema.shifts)
    .where(and(eq(schema.shifts.id, shiftId), eq(schema.shifts.tenantId, ctx.tenantId)))
    .get();
  if (!shift || !ctx.branchIds.includes(shift.branchId)) throw notFound('That shift');

  if (patch.state === 'covered' && !patch.coveredByStaffId) {
    throw invalid('Covering a shift needs who is covering it.');
  }
  if (patch.coveredByStaffId) loadStaffInScope(ctx, patch.coveredByStaffId);

  db.update(schema.shifts)
    .set({
      state: patch.state,
      coveredByStaffId: patch.state === 'covered' ? (patch.coveredByStaffId ?? null) : shift.coveredByStaffId,
      note: patch.note !== undefined ? patch.note : shift.note,
    })
    .where(eq(schema.shifts.id, shiftId))
    .run();

  audit(ctx, {
    action: 'shift.updated',
    entityType: 'shift',
    entityId: shiftId,
    branchId: shift.branchId,
    before: { state: shift.state },
    after: { state: patch.state },
  });

  return db.select().from(schema.shifts).where(eq(schema.shifts.id, shiftId)).get()!;
}

/* ============================================================================
   Workload — a trainer's currently active program assignments. Lives here
   rather than in `services/training-admin.ts` so that file can import
   `loadStaffInScope` from this one without a circular dependency the other
   way (training-admin depends on staff, never the reverse).
   ========================================================================= */

export function assignmentsForTrainer(ctx: { tenantId: string; branchIds: string[] }, trainerId: string) {
  const rows = db
    .select({
      id: schema.assignments.id,
      memberId: schema.assignments.memberId,
      programId: schema.assignments.programId,
      currentWeek: schema.assignments.currentWeek,
      startsOn: schema.assignments.startsOn,
      memberFirstName: schema.members.firstName,
      memberLastName: schema.members.lastName,
      memberNo: schema.members.memberNo,
      programName: schema.programs.name,
      programWeeks: schema.programs.weeks,
    })
    .from(schema.assignments)
    .innerJoin(schema.members, eq(schema.members.id, schema.assignments.memberId))
    .innerJoin(schema.programs, eq(schema.programs.id, schema.assignments.programId))
    .where(
      and(
        eq(schema.assignments.tenantId, ctx.tenantId),
        eq(schema.assignments.trainerId, trainerId),
        eq(schema.assignments.state, 'active'),
      ),
    )
    .all();

  return {
    activeCount: rows.length,
    members: rows.map((r) => ({
      assignmentId: r.id,
      memberId: r.memberId,
      memberNo: r.memberNo,
      name: `${r.memberFirstName} ${r.memberLastName}`,
      programName: r.programName,
      currentWeek: r.currentWeek,
      weeks: r.programWeeks,
      startsOn: r.startsOn,
    })),
  };
}
