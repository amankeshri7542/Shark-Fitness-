import { and, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Role } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { requireBranch } from '../lib/context.js';
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
const TENANT_STAFF_ROLES = new Set<Role>(['owner', 'regional_manager', 'branch_manager', 'reception', 'trainer', 'accountant']);
const CERTIFICATION_WARNING_DAYS = 30;

function certificationStatus(expiresOn: string | null, atMs = now()): 'valid' | 'expiring' | 'expired' | 'no_expiry' {
  if (!expiresOn) return 'no_expiry';
  const expiry = Date.parse(`${expiresOn}T23:59:59Z`);
  if (!Number.isFinite(expiry)) return 'expired';
  if (expiry < atMs) return 'expired';
  if (expiry <= atMs + CERTIFICATION_WARNING_DAYS * 24 * 60 * 60 * 1000) return 'expiring';
  return 'valid';
}

function assertCertificationDates(certifications: Array<{ name: string; expiresOn: string | null }> | undefined): void {
  for (const certification of certifications ?? []) {
    if (!certification.expiresOn) continue;
    const parsed = Date.parse(`${certification.expiresOn}T00:00:00Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== certification.expiresOn) {
      throw invalid('Certification expiry dates must be real calendar dates.');
    }
  }
}

export function visibleCertifications(certifications: Array<{ name: string; expiresOn: string | null }>) {
  return certifications.map((cert) => ({ ...cert, status: certificationStatus(cert.expiresOn) }));
}

function assertTenantStaffRole(role: string): asserts role is Role {
  if (!TENANT_STAFF_ROLES.has(role as Role)) throw invalid('That role cannot be assigned to a tenant staff account.');
}

function assertRoleGrant(ctx: RequestContext, currentRole: string, nextRole: string): void {
  assertTenantStaffRole(nextRole);
  if (nextRole === 'owner' && ctx.role !== 'owner' && ctx.role !== 'platform_admin') {
    throw invalid('Only an owner can grant the owner role.');
  }
  if (currentRole === 'owner' && nextRole !== 'owner' && ctx.role !== 'owner' && ctx.role !== 'platform_admin') {
    throw invalid('Only an owner can change an owner role.');
  }
  if (nextRole === 'regional_manager' && ctx.role !== 'owner' && ctx.role !== 'platform_admin') {
    throw invalid('Only an owner can grant the regional manager role.');
  }
}

function assertBranchesInScope(ctx: RequestContext, branchIds: string[]): void {
  if (branchIds.length === 0) throw invalid('A staff member needs at least one branch.');
  if (!branchIds.every((branchId) => ctx.branchIds.includes(branchId))) {
    throw invalid('You cannot assign staff to a branch outside your own scope.');
  }
  const branches = db
    .select({ id: schema.branches.id, state: schema.branches.state })
    .from(schema.branches)
    .where(and(eq(schema.branches.tenantId, ctx.tenantId), inArray(schema.branches.id, branchIds)))
    .all();
  if (branches.length !== new Set(branchIds).size || branches.some((branch) => branch.state === 'archived')) {
    throw invalid('Choose active branches from this tenant.');
  }
}

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
  page?: number;
  pageSize?: number;
}

export function listStaff(ctx: RequestContext, query: StaffListQuery) {
  if (query.branchId) requireBranch(ctx, query.branchId);
  const scope = query.branchId ? [query.branchId] : scopeOf(ctx);
  if (scope.length === 0) return {
    total: 0,
    page: Math.max(1, query.page ?? 1),
    pageSize: Math.min(100, Math.max(1, query.pageSize ?? 25)),
    totalPages: 1,
    hasMore: false,
    totals: { active: 0, trainers: 0, onLeave: 0, certificationsNeedingAttention: 0 },
    items: [],
  };

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
    .where(and(...filters, eq(schema.users.tenantId, ctx.tenantId), isNull(schema.users.deletedAt)))
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

  const mapped = rows.map((row) => {
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
      certifications: visibleCertifications(row.certifications),
      assignedMemberCount,
      utilisationPct: Math.min(100, Math.round((assignedMemberCount / TRAINER_CAPACITY) * 100)),
      joinedOn: row.joinedOn,
    };
  });

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const total = mapped.length;
  const start = (page - 1) * pageSize;
  return {
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: start + pageSize < total,
    totals: {
      active: mapped.filter((item) => item.employmentStatus === 'active').length,
      trainers: mapped.filter((item) => item.role === 'trainer').length,
      onLeave: mapped.filter((item) => item.employmentStatus === 'on_leave').length,
      certificationsNeedingAttention: mapped.filter((item) =>
        item.certifications.some((cert) => cert.status === 'expired' || cert.status === 'expiring'),
      ).length,
    },
    items: mapped.slice(start, start + pageSize),
  };
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
  assertRoleGrant(ctx, 'reception', input.role);
  assertBranchesInScope(ctx, input.branchIds);

  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  return transact(() => {
    if (email) {
      const dupe = db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.email, email), isNull(schema.users.deletedAt)))
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

    return db.select().from(schema.staff).where(and(eq(schema.staff.id, staffId), eq(schema.staff.tenantId, ctx.tenantId))).get()!;
  });
}

export interface EmploymentPatch {
  name?: string;
  email?: string | null;
  phone?: string | null;
  role?: string;
  accountState?: 'active' | 'disabled' | 'invited';
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
  const user = db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, staff.userId), eq(schema.users.tenantId, ctx.tenantId), isNull(schema.users.deletedAt)))
    .get();
  if (!user) throw notFound('That staff member');

  const nextRole = patch.role ?? user.role;
  assertRoleGrant(ctx, user.role, nextRole);
  if (patch.accountState === 'disabled' && user.id === ctx.userId) {
    throw invalid('You cannot disable your own account.');
  }

  const nextBranchIds = patch.branchIds ?? staff.branchIds;
  assertBranchesInScope(ctx, nextBranchIds);
  const nextEmail = patch.email === undefined ? user.email : normalizeEmail(patch.email);
  if (nextEmail && nextEmail !== user.email) {
    const duplicate = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.tenantId, ctx.tenantId),
          eq(schema.users.email, nextEmail),
          ne(schema.users.id, user.id),
          isNull(schema.users.deletedAt),
        ),
      )
      .get();
    if (duplicate) throw conflict('Someone with that email already has an account.');
  }

  const nextAccountState = patch.accountState ?? user.accountState;
  assertCertificationDates(patch.certifications);
  const removingActiveOwner = user.role === 'owner' &&
    (nextRole !== 'owner' || nextAccountState !== 'active') &&
    user.accountState === 'active';
  if (removingActiveOwner) {
    const activeOwners = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.role, 'owner'), eq(schema.users.accountState, 'active'), isNull(schema.users.deletedAt)))
      .all();
    if (activeOwners.length <= 1) throw conflict('The final active tenant owner must remain active.');
  }

  const before = {
    employmentStatus: staff.employmentStatus,
    branchIds: staff.branchIds,
    commissionRules: staff.commissionRules,
    hourlyRateMinor: staff.hourlyRateMinor,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    accountState: user.accountState,
  };

  transact(() => {
    db.update(schema.users)
      .set({
        name: patch.name?.trim() || user.name,
        email: nextEmail,
        phone: patch.phone === undefined ? user.phone : normalizePhone(patch.phone),
        role: nextRole,
        accountState: nextAccountState,
        updatedAt: atMs,
      })
      .where(and(eq(schema.users.id, user.id), eq(schema.users.tenantId, ctx.tenantId)))
      .run();

    db.update(schema.staff)
      .set({
        employmentStatus: patch.employmentStatus ?? staff.employmentStatus,
        branchIds: nextBranchIds,
        specialties: patch.specialties ?? staff.specialties,
        certifications: patch.certifications ?? staff.certifications,
        commissionRules: patch.commissionRules ?? staff.commissionRules,
        hourlyRateMinor: patch.hourlyRateMinor !== undefined ? patch.hourlyRateMinor : staff.hourlyRateMinor,
        updatedAt: atMs,
      })
      .where(and(eq(schema.staff.id, staffId), eq(schema.staff.tenantId, ctx.tenantId)))
      .run();

    audit(ctx, {
      action: 'staff.updated',
      entityType: 'staff',
      entityId: staffId,
      branchId: staff.branchIds[0] ?? '',
      before,
      after: {
        employmentStatus: patch.employmentStatus ?? staff.employmentStatus,
        branchIds: nextBranchIds,
        commissionRules: patch.commissionRules ?? staff.commissionRules,
        hourlyRateMinor: patch.hourlyRateMinor !== undefined ? patch.hourlyRateMinor : staff.hourlyRateMinor,
        name: patch.name?.trim() || user.name,
        email: nextEmail,
        phone: patch.phone === undefined ? user.phone : normalizePhone(patch.phone),
        role: nextRole,
        accountState: nextAccountState,
      },
    });
  });

  return db.select().from(schema.staff).where(and(eq(schema.staff.id, staffId), eq(schema.staff.tenantId, ctx.tenantId))).get()!;
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
  ctx: RequestContext,
  query: { staffId?: string; branchId?: string; from: number; to: number },
) {
  if (query.branchId) requireBranch(ctx, query.branchId);
  if (query.staffId) loadStaffInScope(ctx, query.staffId);
  const scope = query.branchId ? [query.branchId] : scopeOf(ctx);
  if (scope.length === 0) return [];

  const filters = [
    eq(schema.shifts.tenantId, ctx.tenantId),
    inArray(schema.shifts.branchId, scope),
    lt(schema.shifts.startsAt, query.to),
    gt(schema.shifts.endsAt, query.from),
  ];
  if (query.staffId) filters.push(eq(schema.shifts.staffId, query.staffId));

  const rows = db.select().from(schema.shifts).where(and(...filters)).orderBy(schema.shifts.startsAt).all();
  return rows.map((shift) => {
    const conflictRow = db
      .select({ id: schema.shifts.id })
      .from(schema.shifts)
      .where(
        and(
          eq(schema.shifts.tenantId, ctx.tenantId),
          eq(schema.shifts.staffId, shift.staffId),
          ne(schema.shifts.id, shift.id),
          inArray(schema.shifts.state, [...OPEN_SHIFT_STATES]),
          lt(schema.shifts.startsAt, shift.endsAt),
          gt(schema.shifts.endsAt, shift.startsAt),
        ),
      )
      .get();
    return { ...shift, conflict: Boolean(conflictRow) };
  });
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

  requireBranch(ctx, input.branchId);
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
  transact(() => {
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
  });

  return db.select().from(schema.shifts).where(and(eq(schema.shifts.id, shiftId), eq(schema.shifts.tenantId, ctx.tenantId))).get()!;
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
  if (patch.coveredByStaffId) {
    const covering = loadStaffInScope(ctx, patch.coveredByStaffId);
    if (!covering.branchIds.includes(shift.branchId)) throw invalid('The covering staff member is not assigned to this branch.');
  }

  transact(() => {
    db.update(schema.shifts)
      .set({
      state: patch.state,
      coveredByStaffId: patch.state === 'covered' ? (patch.coveredByStaffId ?? null) : shift.coveredByStaffId,
      note: patch.note !== undefined ? patch.note : shift.note,
    })
      .where(and(eq(schema.shifts.id, shiftId), eq(schema.shifts.tenantId, ctx.tenantId)))
      .run();

    audit(ctx, {
      action: 'shift.updated',
      entityType: 'shift',
      entityId: shiftId,
      branchId: shift.branchId,
      before: { state: shift.state },
      after: { state: patch.state },
    });
  });

  return db.select().from(schema.shifts).where(and(eq(schema.shifts.id, shiftId), eq(schema.shifts.tenantId, ctx.tenantId))).get()!;
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
        eq(schema.members.tenantId, ctx.tenantId),
        eq(schema.programs.tenantId, ctx.tenantId),
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
