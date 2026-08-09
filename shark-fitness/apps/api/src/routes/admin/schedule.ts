import { Hono } from 'hono';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requirePermission } from '../../lib/context.js';
import { notFound } from '../../lib/errors.js';
import { DAY, MINUTE, isoDate, localTime, now } from '../../lib/time.js';
import {
  LIVE_BOOKING_STATES,
  LIVE_WAITLIST_STATES,
  bookMemberOntoSession,
  bookMemberOntoSessionOverride,
  cancelSessions,
  createSession,
  detectClashes,
  loadSessionInScope,
  markAttendance,
  releaseBooking,
  substituteTrainer,
  updateSession,
  waitlistCount,
} from '../../services/schedule.js';

/**
 * Calendar and class operations — UX-A09, PF-SCH.
 *
 * The console operates classes; it does not re-implement booking. The member
 * module owns the last-seat claim and the cancellation policy, and the two
 * staff-facing write paths here (book a member on, release a seat) go through
 * the same service helpers so the rules cannot drift apart.
 */
export const scheduleRoutes = new Hono();

function scopeOf(ctx: { activeBranchId: string | null; branchIds: string[] }): string[] {
  return ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
}

function timezoneFor(tenantId: string, branchIds: string[]): string {
  if (branchIds.length === 0) return 'Asia/Kolkata';
  return (
    db
      .select({ timezone: schema.branches.timezone })
      .from(schema.branches)
      .where(and(eq(schema.branches.tenantId, tenantId), inArray(schema.branches.id, branchIds)))
      .get()?.timezone ?? 'Asia/Kolkata'
  );
}

/* ============================================================================
   GET / — the day's grid.
   ========================================================================= */

const DayQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  trainerId: z.string().optional(),
  roomId: z.string().optional(),
  state: z.enum(['all', 'scheduled', 'cancelled', 'completed']).default('all'),
});

scheduleRoutes.get('/', validate('query', DayQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'schedule.view');

  const query = c.req.valid('query');
  const atMs = now();
  const scope = scopeOf(ctx);

  if (scope.length === 0) {
    return c.json({ date: null, days: [], items: [], totals: { sessions: 0, seats: 0, booked: 0, waitlisted: 0 } });
  }

  const tz = timezoneFor(ctx.tenantId, scope);
  const date = query.date ?? isoDate(atMs, tz);
  const anchor = Date.parse(`${date}T00:00:00Z`);

  // Widened a day either side of the UTC window, then narrowed on the
  // branch-local date, so this holds across a zone offset and a DST change.
  const rows = db
    .select({
      id: schema.classSessions.id,
      branchId: schema.classSessions.branchId,
      classTypeId: schema.classSessions.classTypeId,
      roomId: schema.classSessions.roomId,
      trainerId: schema.classSessions.trainerId,
      seriesId: schema.classSessions.seriesId,
      startsAt: schema.classSessions.startsAt,
      endsAt: schema.classSessions.endsAt,
      capacity: schema.classSessions.capacity,
      booked: schema.classSessions.booked,
      state: schema.classSessions.state,
      cancelledReason: schema.classSessions.cancelledReason,
      substituteFor: schema.classSessions.substituteFor,
      creditsRequired: schema.classSessions.creditsRequired,
      waitlistEnabled: schema.classSessions.waitlistEnabled,
      version: schema.classSessions.version,
      notes: schema.classSessions.notes,
      name: schema.classTypes.name,
      category: schema.classTypes.category,
      durationMin: schema.classTypes.durationMin,
      roomName: schema.rooms.name,
      trainerName: schema.users.name,
      branchName: schema.branches.name,
    })
    .from(schema.classSessions)
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
    .innerJoin(schema.branches, eq(schema.branches.id, schema.classSessions.branchId))
    .leftJoin(schema.rooms, eq(schema.rooms.id, schema.classSessions.roomId))
    .leftJoin(schema.staff, eq(schema.staff.id, schema.classSessions.trainerId))
    .leftJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(
      and(
        eq(schema.classSessions.tenantId, ctx.tenantId),
        inArray(schema.classSessions.branchId, scope),
        gte(schema.classSessions.startsAt, anchor - DAY),
        lt(schema.classSessions.startsAt, anchor + 2 * DAY),
      ),
    )
    .orderBy(asc(schema.classSessions.startsAt))
    .all()
    .filter((row) => isoDate(row.startsAt, tz) === date)
    .filter((row) => (query.trainerId ? row.trainerId === query.trainerId : true))
    .filter((row) => (query.roomId ? row.roomId === query.roomId : true))
    .filter((row) => (query.state === 'all' ? true : row.state === query.state));

  const waitlists = new Map<string, number>();
  for (const row of rows) waitlists.set(row.id, waitlistCount(row.id));

  const items = rows.map((row) => ({
    id: row.id,
    branchId: row.branchId,
    branchName: row.branchName,
    classTypeId: row.classTypeId,
    name: row.name,
    category: row.category,
    roomId: row.roomId,
    roomName: row.roomName ?? 'No room',
    trainerId: row.trainerId,
    trainerName: row.trainerName ?? 'Unassigned',
    seriesId: row.seriesId,
    startsAt: new Date(row.startsAt).toISOString(),
    endsAt: new Date(row.endsAt).toISOString(),
    localTime: localTime(row.startsAt, tz),
    localEndTime: localTime(row.endsAt, tz),
    durationMin: Math.round((row.endsAt - row.startsAt) / MINUTE),
    capacity: row.capacity,
    booked: row.booked,
    seatsLeft: Math.max(0, row.capacity - row.booked),
    fillPct: row.capacity > 0 ? Math.round((row.booked / row.capacity) * 100) : 0,
    waitlistCount: waitlists.get(row.id) ?? 0,
    state: row.state,
    cancelledReason: row.cancelledReason,
    substituted: row.substituteFor !== null,
    creditsRequired: row.creditsRequired,
    waitlistEnabled: row.waitlistEnabled,
    version: row.version,
    notes: row.notes,
    started: row.startsAt <= atMs,
  }));

  const live = items.filter((i) => i.state !== 'cancelled');

  return c.json({
    date,
    today: isoDate(atMs, tz),
    timezone: tz,
    dateLabel: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(Date.parse(`${date}T12:00:00Z`)),
    days: Array.from({ length: 7 }, (_, offset) => {
      const dayMs = Date.parse(`${isoDate(atMs, tz)}T12:00:00Z`) + offset * DAY;
      const dayDate = new Date(dayMs).toISOString().slice(0, 10);
      return {
        date: dayDate,
        weekday: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(dayMs),
        dayNo: Number(dayDate.slice(8, 10)),
        isToday: dayDate === isoDate(atMs, tz),
      };
    }),
    totals: {
      sessions: live.length,
      seats: live.reduce((n, i) => n + i.capacity, 0),
      booked: live.reduce((n, i) => n + i.booked, 0),
      waitlisted: live.reduce((n, i) => n + i.waitlistCount, 0),
      cancelled: items.length - live.length,
    },
    items,
  });
});

/* ============================================================================
   GET /resources — class types, rooms and trainers for the create form.
   ========================================================================= */

scheduleRoutes.get('/resources', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'schedule.view');
  const scope = scopeOf(ctx);

  return c.json({
    classTypes: db
      .select({
        id: schema.classTypes.id,
        name: schema.classTypes.name,
        category: schema.classTypes.category,
        durationMin: schema.classTypes.durationMin,
      })
      .from(schema.classTypes)
      .where(eq(schema.classTypes.tenantId, ctx.tenantId))
      .orderBy(asc(schema.classTypes.name))
      .all(),
    rooms: scope.length
      ? db
          .select({
            id: schema.rooms.id,
            name: schema.rooms.name,
            branchId: schema.rooms.branchId,
            capacity: schema.rooms.capacity,
          })
          .from(schema.rooms)
          .where(and(eq(schema.rooms.tenantId, ctx.tenantId), inArray(schema.rooms.branchId, scope)))
          .all()
      : [],
    // Role lives on the user, not the staff row, and someone who has left
    // should not appear in a "who can teach this" list.
    trainers: db
      .select({ id: schema.staff.id, name: schema.users.name, branchIds: schema.staff.branchIds })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(
        and(
          eq(schema.staff.tenantId, ctx.tenantId),
          eq(schema.staff.employmentStatus, 'active'),
          inArray(schema.users.role, ['trainer', 'branch_manager']),
        ),
      )
      .all()
      .filter((t) => t.branchIds.some((b) => scope.includes(b))),
    branches: db
      .select({ id: schema.branches.id, name: schema.branches.name })
      .from(schema.branches)
      .where(eq(schema.branches.tenantId, ctx.tenantId))
      .all()
      .filter((b) => ctx.branchIds.includes(b.id)),
  });
});

/* ============================================================================
   GET /session/:id — detail, roster and waitlist.
   ========================================================================= */

scheduleRoutes.get('/session/:id', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'schedule.view');

  const session = loadSessionInScope(ctx, c.req.param('id'));
  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, session.branchId)).get();
  const tz = branch?.timezone ?? 'Asia/Kolkata';

  const classType = db.select().from(schema.classTypes).where(eq(schema.classTypes.id, session.classTypeId)).get();
  const room = session.roomId
    ? db.select().from(schema.rooms).where(eq(schema.rooms.id, session.roomId)).get()
    : null;

  const trainerName = session.trainerId
    ? (db
        .select({ name: schema.users.name })
        .from(schema.staff)
        .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
        .where(eq(schema.staff.id, session.trainerId))
        .get()?.name ?? null)
    : null;

  const roster = db
    .select({
      id: schema.bookings.id,
      memberId: schema.bookings.memberId,
      state: schema.bookings.state,
      seatNo: schema.bookings.seatNo,
      bookedAt: schema.bookings.bookedAt,
      attendedAt: schema.bookings.attendedAt,
      cameFromWaitlist: schema.bookings.cameFromWaitlist,
      creditsUsed: schema.bookings.creditsUsed,
      memberNo: schema.members.memberNo,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      initials: schema.members.initials,
    })
    .from(schema.bookings)
    .innerJoin(schema.members, eq(schema.members.id, schema.bookings.memberId))
    .where(eq(schema.bookings.sessionId, session.id))
    .orderBy(asc(schema.bookings.seatNo))
    .all();

  const waitlist = db
    .select({
      id: schema.waitlistEntries.id,
      memberId: schema.waitlistEntries.memberId,
      position: schema.waitlistEntries.position,
      state: schema.waitlistEntries.state,
      joinedAt: schema.waitlistEntries.joinedAt,
      offerExpiresAt: schema.waitlistEntries.offerExpiresAt,
      memberNo: schema.members.memberNo,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      initials: schema.members.initials,
    })
    .from(schema.waitlistEntries)
    .innerJoin(schema.members, eq(schema.members.id, schema.waitlistEntries.memberId))
    .where(
      and(
        eq(schema.waitlistEntries.sessionId, session.id),
        inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
      ),
    )
    .orderBy(asc(schema.waitlistEntries.position))
    .all();

  const live = roster.filter((r) => LIVE_BOOKING_STATES.includes(r.state as 'confirmed'));

  return c.json({
    session: {
      id: session.id,
      branchId: session.branchId,
      branchName: branch?.name ?? '',
      name: classType?.name ?? 'Class',
      category: classType?.category ?? 'other',
      roomId: session.roomId,
      roomName: room?.name ?? 'No room',
      trainerId: session.trainerId,
      trainerName: trainerName ?? 'Unassigned',
      substituted: session.substituteFor !== null,
      seriesId: session.seriesId,
      startsAt: new Date(session.startsAt).toISOString(),
      endsAt: new Date(session.endsAt).toISOString(),
      localTime: localTime(session.startsAt, tz),
      localEndTime: localTime(session.endsAt, tz),
      durationMin: Math.round((session.endsAt - session.startsAt) / MINUTE),
      capacity: session.capacity,
      booked: session.booked,
      seatsLeft: Math.max(0, session.capacity - session.booked),
      state: session.state,
      cancelledReason: session.cancelledReason,
      creditsRequired: session.creditsRequired,
      waitlistEnabled: session.waitlistEnabled,
      notes: session.notes,
      version: session.version,
      started: session.startsAt <= now(),
    },
    counts: {
      live: live.length,
      attended: roster.filter((r) => r.state === 'attended').length,
      noShow: roster.filter((r) => r.state === 'no_show').length,
      cancelled: roster.filter((r) => r.state === 'cancelled' || r.state === 'late_cancelled').length,
      waitlisted: waitlist.length,
    },
    roster: roster.map((row) => ({
      bookingId: row.id,
      memberId: row.memberId,
      memberNo: row.memberNo,
      name: `${row.firstName} ${row.lastName}`,
      initials: row.initials,
      state: row.state,
      seatNo: row.seatNo,
      bookedAt: new Date(row.bookedAt).toISOString(),
      attendedAt: row.attendedAt === null ? null : new Date(row.attendedAt).toISOString(),
      cameFromWaitlist: row.cameFromWaitlist,
      creditsUsed: row.creditsUsed,
    })),
    waitlist: waitlist.map((row) => ({
      waitlistId: row.id,
      memberId: row.memberId,
      memberNo: row.memberNo,
      name: `${row.firstName} ${row.lastName}`,
      initials: row.initials,
      position: row.position,
      state: row.state,
      joinedAt: new Date(row.joinedAt).toISOString(),
      offerExpiresAt: row.offerExpiresAt === null ? null : new Date(row.offerExpiresAt).toISOString(),
    })),
  });
});

/* ============================================================================
   Mutations
   ========================================================================= */

const CreateBody = z.object({
  branchId: z.string().min(1),
  classTypeId: z.string().min(1),
  roomId: z.string().min(1).nullable().default(null),
  trainerId: z.string().min(1).nullable().default(null),
  startsAt: z.string().datetime(),
  durationMin: z.number().int().min(5).max(300).optional(),
  capacity: z.number().int().min(1).max(500),
  creditsRequired: z.number().int().min(0).max(10).default(0),
  dropInPriceMinor: z.number().int().min(0).nullable().default(null),
  lateCancelFeeMinor: z.number().int().min(0).default(0),
  waitlistEnabled: z.boolean().default(true),
  bookingOpensAt: z.string().datetime().nullable().default(null),
  cancelDeadlineAt: z.string().datetime().nullable().default(null),
  notes: z.string().max(500).nullable().default(null),
});

scheduleRoutes.post('/session', validate('json', CreateBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'schedule.manage');
  const body = c.req.valid('json');

  // Creating at a branch the caller cannot see must not be possible, and must
  // not confirm the branch exists either.
  if (!ctx.branchIds.includes(body.branchId)) throw notFound('That branch');

  const session = createSession(ctx, {
    ...body,
    startsAt: Date.parse(body.startsAt),
    bookingOpensAt: body.bookingOpensAt ? Date.parse(body.bookingOpensAt) : null,
    cancelDeadlineAt: body.cancelDeadlineAt ? Date.parse(body.cancelDeadlineAt) : null,
  });

  return c.json({ session: { id: session.id, version: session.version } }, 201);
});

const PatchBody = z.object({
  startsAt: z.string().datetime().optional(),
  durationMin: z.number().int().min(5).max(300).optional(),
  roomId: z.string().min(1).nullable().optional(),
  trainerId: z.string().min(1).nullable().optional(),
  capacity: z.number().int().min(1).max(500).optional(),
  notes: z.string().max(500).nullable().optional(),
  waitlistEnabled: z.boolean().optional(),
  version: z.number().int(),
});

scheduleRoutes.patch('/session/:id', validate('json', PatchBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'schedule.manage');
  const body = c.req.valid('json');

  // Built field by field rather than spread: `startsAt` crosses the wire as an
  // ISO string and must reach the service as epoch milliseconds.
  const session = updateSession(ctx, c.req.param('id'), {
    ...(body.startsAt !== undefined ? { startsAt: Date.parse(body.startsAt) } : {}),
    ...(body.durationMin !== undefined ? { durationMin: body.durationMin } : {}),
    ...(body.roomId !== undefined ? { roomId: body.roomId } : {}),
    ...(body.trainerId !== undefined ? { trainerId: body.trainerId } : {}),
    ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.waitlistEnabled !== undefined ? { waitlistEnabled: body.waitlistEnabled } : {}),
    ...(body.version !== undefined ? { version: body.version } : {}),
  });

  return c.json({ session: { id: session.id, version: session.version } });
});

const CancelBody = z.object({
  reason: z.string().trim().min(4).max(280),
  scope: z.enum(['occurrence', 'series']).default('occurrence'),
});

scheduleRoutes.post('/session/:id/cancel', validate('json', CancelBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'schedule.manage');
  const body = c.req.valid('json');
  return c.json(cancelSessions(ctx, { sessionId: c.req.param('id'), ...body }));
});

const SubstituteBody = z.object({ trainerId: z.string().min(1) });

scheduleRoutes.post('/session/:id/substitute', validate('json', SubstituteBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'schedule.manage');
  const session = substituteTrainer(ctx, c.req.param('id'), c.req.valid('json').trainerId);
  return c.json({ session: { id: session.id, trainerId: session.trainerId, version: session.version } });
});

/** Conflict preview for the create/move form, so the panel can warn before the
 *  write is attempted rather than only failing it. */
const ClashQuery = z.object({
  branchId: z.string().min(1),
  roomId: z.string().optional(),
  trainerId: z.string().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  excludeSessionId: z.string().optional(),
});

scheduleRoutes.get('/clashes', validate('query', ClashQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'schedule.view');
  const query = c.req.valid('query');
  if (!ctx.branchIds.includes(query.branchId)) throw notFound('That branch');

  return c.json({
    clashes: detectClashes(ctx.tenantId, {
      branchId: query.branchId,
      roomId: query.roomId ?? null,
      trainerId: query.trainerId ?? null,
      startsAt: Date.parse(query.startsAt),
      endsAt: Date.parse(query.endsAt),
      excludeSessionId: query.excludeSessionId,
    }),
  });
});

/* — Roster actions ————————————————————————————————————————— */

const BookBody = z.object({
  memberId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  acceptDropInCharge: z.boolean().default(false),
});

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

const BookOverrideBody = z.object({
  memberId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  reason: z.string().trim().min(4).max(280),
});

/**
 * A deliberate eligibility bypass. Requires BOTH `booking.manage_others` and
 * `schedule.manage` — reception has the first but not the second, so this is
 * a manager-and-above call, never an implicit part of ordinary staff booking.
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

const ReleaseBody = z.object({ reason: z.string().trim().max(280).nullable().default(null) });

scheduleRoutes.post('/booking/:id/release', validate('json', ReleaseBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'booking.manage_others');
  return c.json(releaseBooking(ctx, c.req.param('id'), c.req.valid('json').reason));
});

const AttendanceBody = z.object({ state: z.enum(['attended', 'no_show', 'confirmed']) });

scheduleRoutes.post('/booking/:id/attendance', validate('json', AttendanceBody), (c) => {
  const ctx = ctxOf(c);
  // Marking who turned up is an attendance action, and a trainer running the
  // class holds attendance.checkin without holding booking.manage_others.
  requirePermission(ctx, 'attendance.checkin');
  const booking = markAttendance(ctx, c.req.param('id'), c.req.valid('json').state);
  return c.json({ booking: { id: booking.id, state: booking.state, attendedAt: booking.attendedAt } });
});
