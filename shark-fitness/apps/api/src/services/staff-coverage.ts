import { and, asc, eq, gt, gte, inArray, lt, ne } from 'drizzle-orm';
import { db, schema, transact } from '../db/client.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, isoDate, now } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { detectClashes, loadSessionInScope, substituteTrainer } from './schedule.js';
import { loadStaffInScope } from './staff.js';

/**
 * Trainer absence and cover (PF-STAFF).
 *
 * Substituting a coach on one class already worked. What did not exist was the
 * workflow around it: a manager had to already know which classes were
 * affected, and had to already know who could take them. Nothing recorded that
 * a trainer was off, nothing listed the damage, and "who can cover this?" was
 * answered by memory.
 *
 * Three rules this module holds to.
 *
 * **Nothing is rescheduled on the member's behalf.** Recording an absence
 * changes no class and moves no booking. It produces a list of what is
 * affected and leaves every decision to a person, because the alternative —
 * quietly moving people's Tuesday evening — is worse than the gap it fills.
 *
 * **Eligibility is a hard gate plus a ranking, and the two are kept apart.**
 * A trainer at another branch, or already teaching, or themselves away, cannot
 * cover: that is a refusal. A trainer whose specialities do not match the
 * class is merely a poorer fit: that is a sort order and a note, not a
 * refusal. Gyms cover classes with whoever is free, and a system that refuses
 * on speciality would simply be worked around.
 *
 * **The original coach keeps the attribution.** `class_sessions.substitute_for`
 * records who was scheduled, and only the first substitution writes it — the
 * class was Nikhil's, and three cover swaps later it should still say so.
 */

export type UnavailabilityRow = typeof schema.staffUnavailability.$inferSelect;

/** `staff` carries employment, `users` carries the person. Audit labels want
 *  the person. */
function staffName(userId: string): string {
  return (
    db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId)).get()?.name ??
    'Unknown'
  );
}

export type UnavailabilityReason = 'sick' | 'leave' | 'training' | 'other';

/* ============================================================================
   Absence records
   ========================================================================= */

/** Whether a member of staff is away for any part of `[startsAt, endsAt)`.
 *
 *  Half-open on both sides, so a class starting exactly when an absence ends
 *  is not a clash. */
export function isUnavailable(
  tenantId: string,
  staffId: string,
  startsAt: number,
  endsAt: number,
): UnavailabilityRow | null {
  return (
    db
      .select()
      .from(schema.staffUnavailability)
      .where(
        and(
          eq(schema.staffUnavailability.tenantId, tenantId),
          eq(schema.staffUnavailability.staffId, staffId),
          eq(schema.staffUnavailability.state, 'active'),
          lt(schema.staffUnavailability.startsAt, endsAt),
          gt(schema.staffUnavailability.endsAt, startsAt),
        ),
      )
      .get() ?? null
  );
}

export interface MarkUnavailableInput {
  staffId: string;
  startsAt: number;
  endsAt: number;
  reason: UnavailabilityReason;
  note: string | null;
}

export function markUnavailable(ctx: RequestContext, input: MarkUnavailableInput) {
  requirePermission(ctx, 'staff.manage');
  const atMs = now();
  const staff = loadStaffInScope(ctx, input.staffId);

  if (input.endsAt <= input.startsAt) throw invalid('An absence must end after it starts.');
  if (input.endsAt - input.startsAt > 366 * DAY) throw invalid('Record an absence of up to a year at a time.');

  const unavailabilityId = id('sun');

  transact(() => {
    db.insert(schema.staffUnavailability)
      .values({
        id: unavailabilityId,
        tenantId: ctx.tenantId,
        staffId: input.staffId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason,
        note: input.note,
        state: 'active',
        createdByUserId: ctx.userId,
        withdrawnAt: null,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();

    audit(ctx, {
      action: 'staff.marked_unavailable',
      entityType: 'staff',
      entityId: input.staffId,
      entityLabel: staffName(staff.userId),
      branchId: staff.branchIds[0] ?? null,
      after: {
        from: new Date(input.startsAt).toISOString(),
        to: new Date(input.endsAt).toISOString(),
        reason: input.reason,
      },
    });
  });

  // Deliberately returned with the record: the manager's next question is
  // always "what does that break?", and answering it in the same response is
  // what stops the absence being recorded and then forgotten.
  return {
    unavailability: db
      .select()
      .from(schema.staffUnavailability)
      .where(eq(schema.staffUnavailability.id, unavailabilityId))
      .get()!,
    impact: coverageImpact(ctx, input.staffId, { from: input.startsAt, to: input.endsAt }),
  };
}

export function withdrawUnavailability(ctx: RequestContext, unavailabilityId: string) {
  requirePermission(ctx, 'staff.manage');
  const atMs = now();

  const row = db
    .select()
    .from(schema.staffUnavailability)
    .where(
      and(
        eq(schema.staffUnavailability.id, unavailabilityId),
        eq(schema.staffUnavailability.tenantId, ctx.tenantId),
      ),
    )
    .get();
  if (!row) throw notFound('That absence');
  // Scope check through the staff record, so an absence for somebody at
  // another branch is not found rather than forbidden.
  const staff = loadStaffInScope(ctx, row.staffId);
  if (row.state !== 'active') throw precondition('That absence has already been withdrawn.');

  transact(() => {
    db.update(schema.staffUnavailability)
      .set({ state: 'withdrawn', withdrawnAt: atMs, updatedAt: atMs })
      .where(eq(schema.staffUnavailability.id, unavailabilityId))
      .run();

    audit(ctx, {
      action: 'staff.availability_restored',
      entityType: 'staff',
      entityId: row.staffId,
      entityLabel: staffName(staff.userId),
      branchId: staff.branchIds[0] ?? null,
      before: { state: 'active' },
      after: { state: 'withdrawn' },
    });
  });

  // Withdrawing an absence deliberately does *not* undo any substitution it
  // led to. Those classes were re-staffed and the members were told; putting
  // the original coach back silently would be a second unannounced change.
  return { ok: true as const, substitutionsUnchanged: true as const };
}

export function listUnavailability(ctx: RequestContext, staffId: string) {
  requirePermission(ctx, 'staff.view');
  loadStaffInScope(ctx, staffId);

  return {
    unavailability: db
      .select()
      .from(schema.staffUnavailability)
      .where(
        and(
          eq(schema.staffUnavailability.tenantId, ctx.tenantId),
          eq(schema.staffUnavailability.staffId, staffId),
        ),
      )
      .orderBy(asc(schema.staffUnavailability.startsAt))
      .all(),
  };
}

/* ============================================================================
   What an absence breaks
   ========================================================================= */

export interface CoverageImpact {
  staffId: string;
  from: number;
  to: number;
  /** Group classes. These can be covered by a substitute. */
  sessions: Array<{
    sessionId: string;
    seriesId: string | null;
    className: string;
    branchId: string;
    startsAt: number;
    endsAt: number;
    localDate: string;
    booked: number;
    capacity: number;
    covered: boolean;
  }>;
  /**
   * One-to-one appointments. Listed but never auto-covered: the member chose
   * this trainer, and swapping them without asking is exactly the silent
   * reschedule this workflow refuses to do.
   */
  appointments: Array<{
    appointmentId: string;
    memberId: string;
    memberName: string;
    branchId: string;
    startsAt: number;
    endsAt: number;
    kind: string;
  }>;
  /** Desk/floor shifts, which are a rota problem rather than a class problem. */
  shifts: Array<{ shiftId: string; branchId: string; startsAt: number; endsAt: number; role: string }>;
}

export function coverageImpact(
  ctx: RequestContext,
  staffId: string,
  window: { from: number; to: number },
): CoverageImpact {
  requirePermission(ctx, 'staff.view');
  const staff = loadStaffInScope(ctx, staffId);
  const scope = branchScope(ctx);
  const atMs = now();
  // Only the future is an operational problem. A class that has already run
  // needed cover at the time, not now.
  const from = Math.max(window.from, atMs);

  const sessions = db
    .select({
      session: schema.classSessions,
      className: schema.classTypes.name,
    })
    .from(schema.classSessions)
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
    .where(
      and(
        eq(schema.classSessions.tenantId, ctx.tenantId),
        eq(schema.classSessions.trainerId, staffId),
        ne(schema.classSessions.state, 'cancelled'),
        gte(schema.classSessions.startsAt, from),
        lt(schema.classSessions.startsAt, window.to),
      ),
    )
    .orderBy(asc(schema.classSessions.startsAt))
    .all()
    .filter((row) => scope.includes(row.session.branchId));

  const appointments = db
    .select({
      appointment: schema.appointments,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
    })
    .from(schema.appointments)
    .innerJoin(schema.members, eq(schema.members.id, schema.appointments.memberId))
    .where(
      and(
        eq(schema.appointments.tenantId, ctx.tenantId),
        eq(schema.appointments.trainerId, staffId),
        ne(schema.appointments.state, 'cancelled'),
        gte(schema.appointments.startsAt, from),
        lt(schema.appointments.startsAt, window.to),
      ),
    )
    .orderBy(asc(schema.appointments.startsAt))
    .all()
    .filter((row) => scope.includes(row.appointment.branchId));

  const shifts = db
    .select()
    .from(schema.shifts)
    .where(
      and(
        eq(schema.shifts.tenantId, ctx.tenantId),
        eq(schema.shifts.staffId, staffId),
        ne(schema.shifts.state, 'cancelled'),
        gte(schema.shifts.startsAt, from),
        lt(schema.shifts.startsAt, window.to),
      ),
    )
    .orderBy(asc(schema.shifts.startsAt))
    .all()
    .filter((row) => scope.includes(row.branchId));

  void staff;

  return {
    staffId,
    from,
    to: window.to,
    sessions: sessions.map((row) => ({
      sessionId: row.session.id,
      seriesId: row.session.seriesId,
      className: row.className,
      branchId: row.session.branchId,
      startsAt: row.session.startsAt,
      endsAt: row.session.endsAt,
      localDate: isoDate(row.session.startsAt, branchTimeZone(ctx.tenantId, row.session.branchId)),
      booked: row.session.booked,
      capacity: row.session.capacity,
      // A class already re-staffed away from this trainer will not appear at
      // all; this flag catches the reverse — cover assigned *to* them.
      covered: row.session.substituteFor !== null,
    })),
    appointments: appointments.map((row) => ({
      appointmentId: row.appointment.id,
      memberId: row.appointment.memberId,
      memberName: `${row.firstName} ${row.lastName}`.trim(),
      branchId: row.appointment.branchId,
      startsAt: row.appointment.startsAt,
      endsAt: row.appointment.endsAt,
      kind: row.appointment.kind,
    })),
    shifts: shifts.map((row) => ({
      shiftId: row.id,
      branchId: row.branchId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      role: row.role,
    })),
  };
}

/* ============================================================================
   Who can cover
   ========================================================================= */

export interface SubstituteCandidate {
  staffId: string;
  name: string;
  /** Hard gate. False means the assign call would be refused. */
  eligible: boolean;
  /** Why not, when `eligible` is false. */
  blockedReason: string | null;
  /** Specialities that overlap the class. Advisory — this is the sort key. */
  matchingSpecialties: string[];
  /** Certifications that have lapsed. Advisory, and surfaced rather than
   *  silently ignored, because "who covered that class" is a question that
   *  gets asked after an incident. */
  expiredCertifications: string[];
  /** Classes this trainer is already teaching that day, for context. */
  sessionsThatDay: number;
}

/** Whether a trainer's free-text specialities describe this class.
 *
 *  Deliberately a loose token overlap against the class name and category
 *  rather than a lookup table. Specialities are typed by whoever set the
 *  trainer up ("HIIT", "Pre/post-natal"), and a table mapping them to class
 *  types would be stale the first time a gym invents a class. Advisory
 *  anyway — this ranks candidates, it never removes one. */
function specialtyOverlap(specialties: string[], className: string, category: string): string[] {
  const haystack = `${className} ${category}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const tokens = new Set(haystack.split(' ').filter(Boolean));
  return specialties.filter((specialty) =>
    specialty
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
      .some((word) => tokens.has(word) || haystack.includes(word)),
  );
}

export function eligibleSubstitutes(ctx: RequestContext, sessionId: string): {
  session: { id: string; className: string; startsAt: number; endsAt: number; trainerId: string | null };
  candidates: SubstituteCandidate[];
} {
  requirePermission(ctx, 'schedule.view');
  const session = loadSessionInScope(ctx, sessionId);
  const classType = db
    .select()
    .from(schema.classTypes)
    .where(eq(schema.classTypes.id, session.classTypeId))
    .get()!;

  const today = isoDate(session.startsAt, branchTimeZone(ctx.tenantId, session.branchId));

  const staff = db
    .select({ staff: schema.staff, name: schema.users.name, role: schema.users.role })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(eq(schema.staff.tenantId, ctx.tenantId))
    .all();

  const candidates: SubstituteCandidate[] = [];

  for (const row of staff) {
    if (row.staff.id === session.trainerId) continue;
    // A coach is somebody who coaches. Reception is not a candidate to teach
    // Cage Boxing, and offering them would be noise rather than an option.
    if (row.role !== 'trainer') continue;

    let blockedReason: string | null = null;
    if (row.staff.employmentStatus !== 'active') {
      blockedReason = 'Not currently employed.';
    } else if (!row.staff.branchIds.includes(session.branchId)) {
      blockedReason = 'Not assigned to this branch.';
    } else if (isUnavailable(ctx.tenantId, row.staff.id, session.startsAt, session.endsAt)) {
      blockedReason = 'Away on this date.';
    } else {
      const clashes = detectClashes(ctx.tenantId, {
        branchId: session.branchId,
        roomId: null,
        trainerId: row.staff.id,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        excludeSessionId: session.id,
      });
      if (clashes.length > 0) blockedReason = `Already teaching ${clashes[0]!.name}.`;
    }

    const sessionsThatDay = db
      .select()
      .from(schema.classSessions)
      .where(
        and(
          eq(schema.classSessions.tenantId, ctx.tenantId),
          eq(schema.classSessions.trainerId, row.staff.id),
          ne(schema.classSessions.state, 'cancelled'),
        ),
      )
      .all()
      .filter(
        (other) => isoDate(other.startsAt, branchTimeZone(ctx.tenantId, other.branchId)) === today,
      ).length;

    candidates.push({
      staffId: row.staff.id,
      name: row.name,
      eligible: blockedReason === null,
      blockedReason,
      matchingSpecialties: specialtyOverlap(row.staff.specialties, classType.name, classType.category),
      expiredCertifications: row.staff.certifications
        .filter((cert) => cert.expiresOn !== null && cert.expiresOn < isoDate(session.startsAt, 'UTC'))
        .map((cert) => cert.name),
      sessionsThatDay,
    });
  }

  // Eligible first, then best speciality match, then whoever is least loaded
  // that day — the order a manager would pick in.
  candidates.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.matchingSpecialties.length !== b.matchingSpecialties.length) {
      return b.matchingSpecialties.length - a.matchingSpecialties.length;
    }
    if (a.expiredCertifications.length !== b.expiredCertifications.length) {
      return a.expiredCertifications.length - b.expiredCertifications.length;
    }
    return a.sessionsThatDay - b.sessionsThatDay;
  });

  return {
    session: {
      id: session.id,
      className: classType.name,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      trainerId: session.trainerId,
    },
    candidates,
  };
}

/**
 * Assign cover for one class.
 *
 * A thin wrapper over `substituteTrainer` that adds the one check the class
 * path cannot make on its own: the replacement must not themselves be away.
 * Everything else — the branch check, the clash check, the original-trainer
 * attribution, the notification to everybody booked, the audit row — is the
 * existing path, so cover assigned from here behaves exactly like a
 * substitution made from the calendar.
 */
export function assignCover(ctx: RequestContext, sessionId: string, substituteStaffId: string) {
  requirePermission(ctx, 'schedule.manage');
  const session = loadSessionInScope(ctx, sessionId);

  const away = isUnavailable(ctx.tenantId, substituteStaffId, session.startsAt, session.endsAt);
  if (away) {
    throw invalid('That trainer is also away at this time. Pick somebody else, or withdraw their absence first.');
  }

  const updated = substituteTrainer(ctx, sessionId, substituteStaffId);
  return {
    session: {
      id: updated.id,
      trainerId: updated.trainerId,
      /** Preserved deliberately: the class was theirs, and it still says so. */
      substituteFor: updated.substituteFor,
      version: updated.version,
    },
  };
}

/** Every absence overlapping a window, for the coverage board. */
export function coverageBoard(ctx: RequestContext, window: { from: number; to: number }) {
  requirePermission(ctx, 'staff.view');
  const scope = branchScope(ctx);

  const rows = db
    .select({ absence: schema.staffUnavailability, staff: schema.staff, name: schema.users.name })
    .from(schema.staffUnavailability)
    .innerJoin(schema.staff, eq(schema.staff.id, schema.staffUnavailability.staffId))
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(
      and(
        eq(schema.staffUnavailability.tenantId, ctx.tenantId),
        eq(schema.staffUnavailability.state, 'active'),
        lt(schema.staffUnavailability.startsAt, window.to),
        gt(schema.staffUnavailability.endsAt, window.from),
      ),
    )
    .orderBy(asc(schema.staffUnavailability.startsAt))
    .all()
    .filter((row) => row.staff.branchIds.some((branchId) => scope.includes(branchId)));

  const sessionCounts = new Map<string, number>();
  if (rows.length > 0) {
    const affected = db
      .select({ trainerId: schema.classSessions.trainerId, startsAt: schema.classSessions.startsAt })
      .from(schema.classSessions)
      .where(
        and(
          eq(schema.classSessions.tenantId, ctx.tenantId),
          inArray(schema.classSessions.trainerId, rows.map((row) => row.staff.id)),
          ne(schema.classSessions.state, 'cancelled'),
          gte(schema.classSessions.startsAt, Math.max(window.from, now())),
          lt(schema.classSessions.startsAt, window.to),
        ),
      )
      .all();
    for (const row of rows) {
      sessionCounts.set(
        row.absence.id,
        affected.filter(
          (session) =>
            session.trainerId === row.staff.id &&
            session.startsAt >= row.absence.startsAt &&
            session.startsAt < row.absence.endsAt,
        ).length,
      );
    }
  }

  return {
    absences: rows.map((row) => ({
      id: row.absence.id,
      staffId: row.staff.id,
      name: row.name,
      reason: row.absence.reason,
      note: row.absence.note,
      startsAt: row.absence.startsAt,
      endsAt: row.absence.endsAt,
      /** Classes still pointing at the absent trainer inside the absence.
       *  Zero means it is all covered; this is the number a manager works
       *  down to. */
      uncoveredSessions: sessionCounts.get(row.absence.id) ?? 0,
    })),
  };
}
