import { Hono } from 'hono';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { channels } from '@shark/contracts';
import {
  classifyCancellation,
  evaluateEligibility,
  holdIsLive,
  isEntitled,
  planPromotion,
  type WaitlistCandidate,
} from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requireBranch } from '../../lib/context.js';
import type { RequestContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { id } from '../../lib/ids.js';
import { DAY, MINUTE, isoDate, localTime, now } from '../../lib/time.js';
import {
  AppError,
  capacityExhausted,
  conflict,
  entitlementMissing,
  forbidden,
  notFound,
  precondition,
} from '../../lib/errors.js';

/**
 * Explore and Book (UX-M04, PF-SCH).
 *
 * Two rules shape this file.
 *
 * 1. The member never sees a button whose label disagrees with what the server
 *    will do. Every row carries a full `BookingEligibility` computed by
 *    `evaluateEligibility`, and the write paths re-run exactly the same
 *    evaluation before touching a seat — so a stale screen fails with the
 *    server's own sentence rather than a generic error.
 * 2. `class_sessions.booked` is only ever moved inside `transact()`, by a
 *    conditional UPDATE that is itself the last-seat claim (PF-SCH-003). The
 *    database trigger behind it is a backstop, not the mechanism.
 */
export const scheduleRoutes = new Hono();

/** States that occupy a seat. Cancelled rows must not block a rebooking. */
const LIVE_BOOKING_STATES = ['held', 'confirmed', 'attended'] as const;
const LIVE_WAITLIST_STATES = ['waiting', 'offered'] as const;

/** How long a promoted member has to take the seat before the next in line. */
const OFFER_WINDOW_MIN = 15;

/** Days shown in the date strip, starting today in the branch's own zone. */
const STRIP_DAYS = 7;

/* ============================================================================
   Shared reads. Every one of these filters on tenant, and the branch check
   happens once at the top of each handler via requireBranch.
   ========================================================================= */

interface SessionRow {
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

const sessionColumns = {
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

function sessionQuery() {
  return db
    .select(sessionColumns)
    .from(schema.classSessions)
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
    .leftJoin(schema.rooms, eq(schema.rooms.id, schema.classSessions.roomId))
    .leftJoin(schema.staff, eq(schema.staff.id, schema.classSessions.trainerId))
    .leftJoin(schema.users, eq(schema.users.id, schema.staff.userId));
}

function sessionById(tenantId: string, sessionId: string): SessionRow | undefined {
  return sessionQuery()
    .where(and(eq(schema.classSessions.tenantId, tenantId), eq(schema.classSessions.id, sessionId)))
    .get();
}

/** Class credits on hand. Expired grants drop out; spends never do. */
function classCreditsHeld(memberId: string, today: string): number {
  return db
    .select({ delta: schema.credits.delta, expiresOn: schema.credits.expiresOn })
    .from(schema.credits)
    .where(and(eq(schema.credits.memberId, memberId), eq(schema.credits.kind, 'class')))
    .all()
    .reduce((total, row) => total + (row.expiresOn !== null && row.expiresOn < today ? 0 : row.delta), 0);
}

interface MembershipStanding {
  entitled: boolean;
  state: string | null;
  reason: string | null;
  productName: string | null;
  allBranches: boolean;
}

/** Money and access always speak plainly — never the predator register. */
function membershipStanding(memberId: string): MembershipStanding {
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

/**
 * A held seat whose hold has lapsed is not a seat. `booked` is denormalised, so
 * read paths discount dead holds and the write paths reap them for real.
 */
function deadHoldCount(sessionIds: string[], atMs: number): Map<string, number> {
  const counts = new Map<string, number>();
  if (sessionIds.length === 0) return counts;

  const held = db
    .select({
      sessionId: schema.bookings.sessionId,
      bookedAt: schema.bookings.bookedAt,
    })
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
function reapExpiredHolds(sessionId: string, atMs: number): number {
  const held = db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.sessionId, sessionId), eq(schema.bookings.state, 'held')))
    .all();

  const at = new Date(atMs);
  let reaped = 0;
  for (const booking of held) {
    if (holdIsLive(new Date(booking.bookedAt), at)) continue;
    db.update(schema.bookings)
      .set({ state: 'cancelled', cancelledAt: atMs })
      .where(eq(schema.bookings.id, booking.id))
      .run();
    db.update(schema.classSessions)
      .set({ booked: sql`max(0, ${schema.classSessions.booked} - 1)` })
      .where(eq(schema.classSessions.id, sessionId))
      .run();
    reaped += 1;
  }
  return reaped;
}

/** My live booking in a session, if any. */
function myBookingFor(memberId: string, sessionId: string) {
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

function myWaitlistFor(memberId: string, sessionId: string) {
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
function myBookingsAround(memberId: string, fromMs: number, toMs: number) {
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

function overlapWith(
  session: { id: string; startsAt: number; endsAt: number },
  others: Array<{ sessionId: string; startsAt: number; endsAt: number }>,
): string | null {
  const clash = others.find(
    (o) => o.sessionId !== session.id && o.startsAt < session.endsAt && o.endsAt > session.startsAt,
  );
  return clash?.sessionId ?? null;
}

/* ============================================================================
   Eligibility. One function, used by the list and by every write path, so the
   button and the outcome can never disagree.
   ========================================================================= */

interface EligibilityContext {
  atMs: number;
  today: string;
  standing: MembershipStanding;
  branchIds: string[];
  creditsHeld: number;
  otherBookings: Array<{ sessionId: string; startsAt: number; endsAt: number }>;
}

function eligibilityFor(
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
 *  the member reads the same sentence whichever door they came through. */
function refuse(eligibility: ReturnType<typeof evaluateEligibility>, session: SessionRow): AppError {
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

/* ============================================================================
   Serialisation
   ========================================================================= */

function serialiseSession(
  session: SessionRow,
  args: {
    tz: string;
    branchName: string;
    effectiveBooked: number;
    waitlistCount: number;
    myBooking: { id: string; state: string; seatNo: number | null } | null;
    myWaitlist: { id: string; position: number; state: string; offerExpiresAt: number | null } | null;
    eligibility: ReturnType<typeof evaluateEligibility>;
  },
) {
  return {
    id: session.id,
    branchId: session.branchId,
    branchName: args.branchName,
    classTypeId: session.classTypeId,
    name: session.name,
    category: session.category,
    description: session.description,
    intensity: session.intensity,
    trainerId: session.trainerId,
    trainerName: session.trainerName ?? 'Coach',
    roomName: session.roomName ?? '',
    startsAt: new Date(session.startsAt).toISOString(),
    endsAt: new Date(session.endsAt).toISOString(),
    localDate: isoDate(session.startsAt, args.tz),
    localTime: localTime(session.startsAt, args.tz),
    localEndTime: localTime(session.endsAt, args.tz),
    durationMin: session.durationMin,
    capacity: session.capacity,
    booked: args.effectiveBooked,
    seatsLeft: Math.max(0, session.capacity - args.effectiveBooked),
    waitlistCount: args.waitlistCount,
    state: session.state,
    cancelledReason: session.cancelledReason,
    substituteFor: session.substituteFor,
    myBooking: args.myBooking,
    myWaitlist: args.myWaitlist
      ? {
          id: args.myWaitlist.id,
          position: args.myWaitlist.position,
          state: args.myWaitlist.state,
          offerExpiresAt:
            args.myWaitlist.offerExpiresAt === null ? null : new Date(args.myWaitlist.offerExpiresAt).toISOString(),
        }
      : null,
    eligibility: args.eligibility,
  };
}

function serialiseBooking(booking: typeof schema.bookings.$inferSelect) {
  return {
    id: booking.id,
    sessionId: booking.sessionId,
    memberId: booking.memberId,
    state: booking.state,
    seatNo: booking.seatNo,
    bookedAt: new Date(booking.bookedAt).toISOString(),
    cancelledAt: booking.cancelledAt === null ? null : new Date(booking.cancelledAt).toISOString(),
    creditsUsed: booking.creditsUsed,
    chargeMinor: booking.chargeMinor,
    cameFromWaitlist: booking.cameFromWaitlist,
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  strength: 'Strength',
  cardio: 'Cardio',
  mobility: 'Mobility',
  combat: 'Combat',
  aquatic: 'Aquatic',
  mind_body: 'Mind & body',
  other: 'Other',
};

/* ============================================================================
   Branch and day resolution
   ========================================================================= */

function resolveBranch(ctx: RequestContext, requested?: string) {
  const member = db.select().from(schema.members).where(eq(schema.members.id, ctx.memberId!)).get();
  if (!member) throw notFound('Your membership');

  const branchId = requested ?? ctx.activeBranchId ?? member.homeBranchId;
  requireBranch(ctx, branchId);

  const branch = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.tenantId, ctx.tenantId), eq(schema.branches.id, branchId)))
    .get();
  if (!branch) throw notFound('That branch');

  return { member, branch, tz: branch.timezone };
}

/** Sessions whose *branch-local* date is `date`. The UTC window is widened by a
 *  day either side and then filtered, so this holds in any zone and across a
 *  daylight-saving change (PF-SCH-005). */
function sessionsOnLocalDate(tenantId: string, branchId: string, date: string, tz: string): SessionRow[] {
  const anchor = Date.parse(`${date}T00:00:00Z`);
  return sessionQuery()
    .where(
      and(
        eq(schema.classSessions.tenantId, tenantId),
        eq(schema.classSessions.branchId, branchId),
        gte(schema.classSessions.startsAt, anchor - DAY),
        lt(schema.classSessions.startsAt, anchor + 2 * DAY),
      ),
    )
    .orderBy(asc(schema.classSessions.startsAt))
    .all()
    .filter((row) => isoDate(row.startsAt, tz) === date);
}

/* ============================================================================
   GET / — the day's schedule with a full eligibility verdict on every row.
   ========================================================================= */

const ListQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  branchId: z.string().optional(),
  category: z.string().optional(),
});

scheduleRoutes.get('/', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const query = c.req.valid('query');
  const atMs = now();

  const { branch, tz } = resolveBranch(ctx, query.branchId);
  const today = isoDate(atMs, tz);
  const date = query.date ?? today;

  /* — The date strip. Built server-side so the client never guesses a zone. — */

  const stripFrom = Date.parse(`${today}T00:00:00Z`) - DAY;
  const stripTo = stripFrom + (STRIP_DAYS + 2) * DAY;

  const stripCounts = new Map<string, number>();
  for (const row of db
    .select({ startsAt: schema.classSessions.startsAt, state: schema.classSessions.state })
    .from(schema.classSessions)
    .where(
      and(
        eq(schema.classSessions.tenantId, ctx.tenantId),
        eq(schema.classSessions.branchId, branch.id),
        gte(schema.classSessions.startsAt, stripFrom),
        lt(schema.classSessions.startsAt, stripTo),
      ),
    )
    .all()) {
    if (row.state === 'cancelled') continue;
    const day = isoDate(row.startsAt, tz);
    stripCounts.set(day, (stripCounts.get(day) ?? 0) + 1);
  }

  const days = Array.from({ length: STRIP_DAYS }, (_, offset) => {
    const dayMs = Date.parse(`${today}T12:00:00Z`) + offset * DAY;
    const dayDate = new Date(dayMs).toISOString().slice(0, 10);
    return {
      date: dayDate,
      weekday: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(dayMs),
      dayNo: Number(dayDate.slice(8, 10)),
      monthLabel: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(dayMs),
      isToday: dayDate === today,
      sessionCount: stripCounts.get(dayDate) ?? 0,
    };
  });

  /* — The day itself ————————————————————————————————————————— */

  const all = sessionsOnLocalDate(ctx.tenantId, branch.id, date, tz);
  const ids = all.map((s) => s.id);

  const holds = deadHoldCount(ids, atMs);

  const waitlistCounts = new Map<string, number>();
  if (ids.length > 0) {
    for (const row of db
      .select({ sessionId: schema.waitlistEntries.sessionId, n: sql<number>`count(*)` })
      .from(schema.waitlistEntries)
      .where(
        and(
          inArray(schema.waitlistEntries.sessionId, ids),
          inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
        ),
      )
      .groupBy(schema.waitlistEntries.sessionId)
      .all()) {
      waitlistCounts.set(row.sessionId, row.n);
    }
  }

  const myBookings = new Map<string, typeof schema.bookings.$inferSelect>();
  const myWaitlist = new Map<string, typeof schema.waitlistEntries.$inferSelect>();
  if (ids.length > 0) {
    for (const row of db
      .select()
      .from(schema.bookings)
      .where(
        and(
          eq(schema.bookings.memberId, memberId),
          inArray(schema.bookings.sessionId, ids),
          inArray(schema.bookings.state, [...LIVE_BOOKING_STATES]),
        ),
      )
      .all()) {
      myBookings.set(row.sessionId, row);
    }
    for (const row of db
      .select()
      .from(schema.waitlistEntries)
      .where(
        and(
          eq(schema.waitlistEntries.memberId, memberId),
          inArray(schema.waitlistEntries.sessionId, ids),
          inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
        ),
      )
      .all()) {
      myWaitlist.set(row.sessionId, row);
    }
  }

  const standing = membershipStanding(memberId);
  const creditsHeld = classCreditsHeld(memberId, today);

  const dayAnchor = Date.parse(`${date}T00:00:00Z`);
  const scope: EligibilityContext = {
    atMs,
    today,
    standing,
    branchIds: ctx.branchIds,
    creditsHeld,
    otherBookings: myBookingsAround(memberId, dayAnchor - DAY, dayAnchor + 2 * DAY),
  };

  const items = all
    .filter((session) => !query.category || query.category === 'all' || session.category === query.category)
    .map((session) => {
      const effectiveBooked = Math.max(0, session.booked - (holds.get(session.id) ?? 0));
      const booking = myBookings.get(session.id) ?? null;
      const waiting = myWaitlist.get(session.id) ?? null;

      return serialiseSession(session, {
        tz,
        branchName: branch.name,
        effectiveBooked,
        waitlistCount: waitlistCounts.get(session.id) ?? 0,
        myBooking: booking ? { id: booking.id, state: booking.state, seatNo: booking.seatNo } : null,
        myWaitlist: waiting
          ? {
              id: waiting.id,
              position: waitlistRank(waiting.sessionId, waiting.position),
              state: waiting.state,
              offerExpiresAt: waiting.offerExpiresAt,
            }
          : null,
        eligibility: eligibilityFor(session, effectiveBooked, scope, {
          booked: booking !== null,
          waitlisted: waiting !== null,
        }),
      });
    });

  const categoryCounts = new Map<string, number>();
  for (const session of all) {
    categoryCounts.set(session.category, (categoryCounts.get(session.category) ?? 0) + 1);
  }

  return c.json({
    branch: { id: branch.id, name: branch.name, timezone: tz },
    branches: db
      .select({ id: schema.branches.id, name: schema.branches.name })
      .from(schema.branches)
      .where(eq(schema.branches.tenantId, ctx.tenantId))
      .all()
      .filter((b) => ctx.branchIds.includes(b.id)),
    date,
    today,
    dateLabel: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(Date.parse(`${date}T12:00:00Z`)),
    days,
    category: query.category ?? 'all',
    categories: [
      { value: 'all', label: 'All', count: all.length },
      ...[...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, label: CATEGORY_LABELS[value] ?? value, count })),
    ],
    membership: {
      state: standing.state,
      entitled: standing.entitled,
      reason: standing.reason,
      productName: standing.productName,
    },
    credits: { class: creditsHeld },
    waitlist: { offerWindowMin: OFFER_WINDOW_MIN },
    myBookedToday: [...myBookings.values()].length,
    items,
  });
});

/** Position as the member reads it: rank among those still waiting, so a
 *  departure ahead of them shows as movement rather than a frozen number. */
function waitlistRank(sessionId: string, storedPosition: number): number {
  const ahead = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.waitlistEntries)
    .where(
      and(
        eq(schema.waitlistEntries.sessionId, sessionId),
        inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
        lt(schema.waitlistEntries.position, storedPosition),
      ),
    )
    .get();
  return (ahead?.n ?? 0) + 1;
}

/* ============================================================================
   POST /book — the last-seat claim.
   ========================================================================= */

const BookBody = z.object({
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(8),
  acceptDropInCharge: z.boolean().default(false),
});

scheduleRoutes.post('/book', validate('json', BookBody), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const body = c.req.valid('json');
  const atMs = now();

  const session = sessionById(ctx.tenantId, body.sessionId);
  if (!session) throw notFound('That class');
  requireBranch(ctx, session.branchId);

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, session.branchId)).get();
  const tz = branch?.timezone ?? 'Asia/Kolkata';
  const today = isoDate(atMs, tz);

  let replayed = false;

  const result = runClaim(() =>
    transact(() => {
      /* Idempotent on the body's key: a retry after a dropped response returns
         the seat that was already taken, never a second one. */
      const existing = db
        .select()
        .from(schema.bookings)
        .where(
          and(eq(schema.bookings.tenantId, ctx.tenantId), eq(schema.bookings.idempotencyKey, body.idempotencyKey)),
        )
        .get();

      if (existing) {
        if (existing.memberId !== memberId || existing.sessionId !== body.sessionId) {
          throw new AppError('IDEMPOTENCY_MISMATCH', 'That request key was already used for a different booking.');
        }
        replayed = true;
        return { booking: existing, creditsUsed: existing.creditsUsed, chargeMinor: existing.chargeMinor };
      }

      // A seat held by someone who walked away is a seat.
      reapExpiredHolds(session.id, atMs);

      const fresh = sessionById(ctx.tenantId, session.id)!;
      const mineAlready = myBookingFor(memberId, fresh.id);
      if (mineAlready) {
        replayed = true;
        return { booking: mineAlready, creditsUsed: mineAlready.creditsUsed, chargeMinor: mineAlready.chargeMinor };
      }

      const standing = membershipStanding(memberId);
      const creditsHeld = classCreditsHeld(memberId, today);
      const eligibility = eligibilityFor(fresh, fresh.booked, {
        atMs,
        today,
        standing,
        branchIds: ctx.branchIds,
        creditsHeld,
        otherBookings: myBookingsAround(memberId, fresh.startsAt - DAY, fresh.endsAt + DAY),
      }, { booked: false, waitlisted: myWaitlistFor(memberId, fresh.id) !== null });

      if (eligibility.action !== 'book' && eligibility.action !== 'pay') {
        throw refuse(eligibility, fresh);
      }

      // A drop-in is money. It is never charged without an explicit yes.
      const payingCash = eligibility.action === 'pay';
      if (payingCash && !body.acceptDropInCharge) {
        throw new AppError('PAYMENT_REQUIRED', eligibility.reason, {
          details: { dropInPriceMinor: fresh.dropInPriceMinor },
        });
      }

      /* The claim. Conditional on capacity, so two members racing for the last
         seat produce one winner and one CAPACITY_EXHAUSTED — the trigger behind
         this is a backstop, not the mechanism (PF-SCH-003). */
      const claim = db
        .update(schema.classSessions)
        .set({
          booked: sql`${schema.classSessions.booked} + 1`,
          updatedAt: atMs,
          version: sql`${schema.classSessions.version} + 1`,
        })
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
        db
          .select({ booked: schema.classSessions.booked })
          .from(schema.classSessions)
          .where(eq(schema.classSessions.id, fresh.id))
          .get()?.booked ?? fresh.booked + 1;

      const creditsUsed = payingCash ? 0 : fresh.creditsRequired;
      const chargeMinor = payingCash ? (fresh.dropInPriceMinor ?? 0) : 0;

      const bookingId = id('bkg');
      db.insert(schema.bookings)
        .values({
          id: bookingId,
          tenantId: ctx.tenantId,
          sessionId: fresh.id,
          memberId,
          state: 'confirmed',
          seatNo,
          bookedAt: atMs,
          cancelledAt: null,
          heldUntil: null,
          creditsUsed,
          chargeMinor,
          cameFromWaitlist: myWaitlistFor(memberId, fresh.id) !== null,
          idempotencyKey: body.idempotencyKey,
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
            createdAt: atMs,
          })
          .run();
      }

      // A waitlist offer that has been taken up is resolved, not left hanging.
      const waiting = myWaitlistFor(memberId, fresh.id);
      if (waiting) {
        db.update(schema.waitlistEntries)
          .set({ state: 'confirmed', resolvedAt: atMs })
          .where(eq(schema.waitlistEntries.id, waiting.id))
          .run();
      }

      audit(ctx, {
        action: 'booking.confirmed',
        entityType: 'booking',
        entityId: bookingId,
        entityLabel: `${fresh.name} · ${localTime(fresh.startsAt, tz)}`,
        branchId: fresh.branchId,
        after: { seatNo, creditsUsed, chargeMinor, sessionId: fresh.id },
      });

      emit({
        tenantId: ctx.tenantId,
        branchId: fresh.branchId,
        channel: channels.branch(fresh.branchId),
        topic: 'booking.confirmed',
        payload: {
          bookingId,
          sessionId: fresh.id,
          memberId,
          seatNo,
          booked: seatNo,
          capacity: fresh.capacity,
        },
      });

      const booking = db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).get()!;
      return { booking, creditsUsed, chargeMinor };
    }),
  );

  const after = sessionById(ctx.tenantId, session.id)!;
  const standing = membershipStanding(memberId);
  const creditsHeld = classCreditsHeld(memberId, today);

  return c.json({
    replayed,
    booking: serialiseBooking(result.booking),
    creditsHeld,
    charge:
      result.chargeMinor > 0
        ? {
            amountMinor: result.chargeMinor,
            note: 'This drop-in is added to your account. Settle it in Billing or at reception.',
          }
        : null,
    session: serialiseSession(after, {
      tz,
      branchName: branch?.name ?? '',
      effectiveBooked: after.booked,
      waitlistCount:
        db
          .select({ n: sql<number>`count(*)` })
          .from(schema.waitlistEntries)
          .where(
            and(
              eq(schema.waitlistEntries.sessionId, after.id),
              inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
            ),
          )
          .get()?.n ?? 0,
      myBooking: { id: result.booking.id, state: result.booking.state, seatNo: result.booking.seatNo },
      myWaitlist: null,
      eligibility: eligibilityFor(after, after.booked, {
        atMs,
        today,
        standing,
        branchIds: ctx.branchIds,
        creditsHeld,
        otherBookings: [],
      }, { booked: true, waitlisted: false }),
    }),
  });
});

/**
 * The database refuses an overbook whatever the service layer believes. If that
 * guard ever fires it is a real business outcome, not a fault, so it leaves here
 * as CAPACITY_EXHAUSTED rather than a 500.
 */
function runClaim<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('CAPACITY_EXHAUSTED')) throw capacityExhausted();
    if (message.includes('bookings_live_uq')) throw conflict('You already have a seat in this class.');
    if (message.includes('bookings_idem_uq')) {
      throw conflict('That booking was already recorded. Pull to refresh to see it.');
    }
    throw err;
  }
}

/* ============================================================================
   DELETE /booking/:id — cancel, then promote the waitlist.
   ========================================================================= */

scheduleRoutes.delete('/booking/:id', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const bookingId = c.req.param('id');
  const atMs = now();

  const booking = db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).get();
  if (!booking || booking.tenantId !== ctx.tenantId || booking.memberId !== memberId) {
    throw notFound('That booking');
  }
  if (!LIVE_BOOKING_STATES.includes(booking.state as 'confirmed')) {
    throw precondition('That booking is already closed.');
  }

  const session = sessionById(ctx.tenantId, booking.sessionId);
  if (!session) throw notFound('That class');

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, session.branchId)).get();
  const tz = branch?.timezone ?? 'Asia/Kolkata';

  const outcome = classifyCancellation(
    new Date(atMs),
    session.cancelDeadlineAt === null ? null : new Date(session.cancelDeadlineAt),
  );

  const promotion = transact(() => {
    db.update(schema.bookings)
      .set({ state: outcome.state, cancelledAt: atMs })
      .where(eq(schema.bookings.id, booking.id))
      .run();

    db.update(schema.classSessions)
      .set({
        booked: sql`max(0, ${schema.classSessions.booked} - 1)`,
        updatedAt: atMs,
        version: sql`${schema.classSessions.version} + 1`,
      })
      .where(eq(schema.classSessions.id, session.id))
      .run();

    // The credit comes back only when the deadline was met. That is the whole
    // point of the deadline, and the member was told the time up front.
    if (outcome.refundCredit && booking.creditsUsed > 0) {
      db.insert(schema.credits)
        .values({
          id: id('crd'),
          tenantId: ctx.tenantId,
          memberId,
          kind: 'class',
          delta: booking.creditsUsed,
          reason: `Cancelled ${session.name}`,
          refType: 'booking',
          refId: booking.id,
          expiresOn: null,
          createdAt: atMs,
        })
        .run();
    }

    audit(ctx, {
      action: outcome.state === 'late_cancelled' ? 'booking.late_cancelled' : 'booking.cancelled',
      entityType: 'booking',
      entityId: booking.id,
      entityLabel: `${session.name} · ${localTime(session.startsAt, tz)}`,
      branchId: session.branchId,
      before: { state: booking.state, creditsUsed: booking.creditsUsed },
      after: {
        state: outcome.state,
        creditsRefunded: outcome.refundCredit ? booking.creditsUsed : 0,
        feeMinor: outcome.refundCredit ? 0 : session.lateCancelFeeMinor,
      },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'booking.cancelled',
      payload: { bookingId: booking.id, sessionId: session.id, memberId, state: outcome.state },
    });

    return promoteWaitlist(ctx, session, atMs, tz);
  });

  const feeMinor = outcome.refundCredit ? 0 : session.lateCancelFeeMinor;

  return c.json({
    booking: serialiseBooking(
      db.select().from(schema.bookings).where(eq(schema.bookings.id, booking.id)).get()!,
    ),
    cancellation: {
      state: outcome.state,
      late: outcome.state === 'late_cancelled',
      creditsRefunded: outcome.refundCredit ? booking.creditsUsed : 0,
      feeMinor,
      message:
        outcome.state === 'late_cancelled'
          ? feeMinor > 0
            ? `Cancelled after the deadline, so the class credit is used and a late cancellation fee of ₹${(feeMinor / 100).toLocaleString('en-IN')} applies.`
            : 'Cancelled after the deadline, so the class credit is used. There is no fee this time.'
          : booking.creditsUsed > 0
            ? 'Cancelled in time. Your class credit is back.'
            : 'Cancelled in time. Your seat is back in the pool.',
    },
    promoted: promotion,
    creditsHeld: classCreditsHeld(memberId, isoDate(atMs, tz)),
  });
});

/**
 * Waitlist promotion (PF-SCH-002). Promotion re-checks eligibility from
 * scratch: someone whose credits or membership lapsed while they waited is
 * skipped with a reason rather than promoted into a booking that cannot work.
 */
function promoteWaitlist(
  ctx: RequestContext,
  session: SessionRow,
  atMs: number,
  tz: string,
): { memberId: string; position: number; offerExpiresAt: string; offerWindowMin: number } | null {
  const queue = db
    .select()
    .from(schema.waitlistEntries)
    .where(and(eq(schema.waitlistEntries.sessionId, session.id), eq(schema.waitlistEntries.state, 'waiting')))
    .orderBy(asc(schema.waitlistEntries.position))
    .all();

  if (queue.length === 0) return null;

  const today = isoDate(atMs, tz);

  const candidates: WaitlistCandidate[] = queue.map((entry) => {
    const standing = membershipStanding(entry.memberId);
    const creditsHeld = classCreditsHeld(entry.memberId, today);
    const clash = overlapWith(
      session,
      myBookingsAround(entry.memberId, session.startsAt - DAY, session.endsAt + DAY),
    );

    const skipReason = !standing.entitled
      ? (standing.reason ?? 'Membership no longer covers bookings')
      : session.creditsRequired > 0 && creditsHeld < session.creditsRequired
        ? 'No class credits left'
        : clash
          ? 'Already booked into an overlapping class'
          : null;

    return {
      id: entry.id,
      memberId: entry.memberId,
      position: entry.position,
      eligible: skipReason === null,
      skipReason,
    };
  });

  const plan = planPromotion(candidates, OFFER_WINDOW_MIN);

  for (const skip of plan.skipped) {
    db.update(schema.waitlistEntries)
      .set({ state: 'expired', resolvedAt: atMs })
      .where(eq(schema.waitlistEntries.id, skip.id))
      .run();
  }

  if (!plan.offer) return null;

  const offerExpiresAt = atMs + plan.offerWindowMin * MINUTE;
  db.update(schema.waitlistEntries)
    .set({ state: 'offered', offeredAt: atMs, offerExpiresAt })
    .where(eq(schema.waitlistEntries.id, plan.offer.id))
    .run();

  const promotedMember = db
    .select({ userId: schema.members.userId })
    .from(schema.members)
    .where(eq(schema.members.id, plan.offer.memberId))
    .get();

  if (promotedMember?.userId) {
    db.insert(schema.notifications)
      .values({
        id: id('ntf'),
        tenantId: ctx.tenantId,
        userId: promotedMember.userId,
        channel: 'in_app',
        kind: 'waitlist_offer',
        title: `A seat opened in ${session.name}`,
        body: `${localTime(session.startsAt, tz)} today. The seat is held for you for ${plan.offerWindowMin} minutes, then it goes to the next person.`,
        link: '/book',
        templateCode: 'waitlist.offered',
        state: 'sent',
        attempts: 1,
        lastError: null,
        createdAt: atMs,
        readAt: null,
      })
      .run();
  }

  emit({
    tenantId: ctx.tenantId,
    branchId: session.branchId,
    channel: channels.member(plan.offer.memberId),
    topic: 'waitlist.offered',
    payload: {
      sessionId: session.id,
      waitlistId: plan.offer.id,
      offerExpiresAt: new Date(offerExpiresAt).toISOString(),
      offerWindowMin: plan.offerWindowMin,
    },
  });

  return {
    memberId: plan.offer.memberId,
    position: plan.offer.position,
    offerExpiresAt: new Date(offerExpiresAt).toISOString(),
    offerWindowMin: plan.offerWindowMin,
  };
}

/* ============================================================================
   POST /waitlist — join. DELETE /waitlist/:id — leave.
   ========================================================================= */

const WaitlistBody = z.object({ sessionId: z.string().min(1) });

scheduleRoutes.post('/waitlist', validate('json', WaitlistBody), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const { sessionId } = c.req.valid('json');
  const atMs = now();

  const session = sessionById(ctx.tenantId, sessionId);
  if (!session) throw notFound('That class');
  requireBranch(ctx, session.branchId);

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, session.branchId)).get();
  const tz = branch?.timezone ?? 'Asia/Kolkata';
  const today = isoDate(atMs, tz);

  const entry = transact(() => {
    const existing = myWaitlistFor(memberId, session.id);
    if (existing) return existing;

    if (session.state === 'cancelled') throw precondition('This class was cancelled.');
    if (session.startsAt <= atMs) throw new AppError('BOOKING_WINDOW_CLOSED', 'This class has already started.');
    if (!session.waitlistEnabled) throw precondition('This class does not run a waitlist.');
    if (myBookingFor(memberId, session.id)) throw conflict('You already have a seat in this class.');

    const standing = membershipStanding(memberId);
    if (!standing.entitled) {
      throw entitlementMissing(standing.reason ?? 'Your membership does not cover bookings right now.');
    }

    reapExpiredHolds(session.id, atMs);
    const fresh = sessionById(ctx.tenantId, session.id)!;
    if (fresh.booked < fresh.capacity) {
      throw precondition('There are seats left in this class. Book one instead of waiting.');
    }

    const highest = db
      .select({ max: sql<number>`coalesce(max(${schema.waitlistEntries.position}), 0)` })
      .from(schema.waitlistEntries)
      .where(eq(schema.waitlistEntries.sessionId, session.id))
      .get();

    const entryId = id('wtl');
    db.insert(schema.waitlistEntries)
      .values({
        id: entryId,
        tenantId: ctx.tenantId,
        sessionId: session.id,
        memberId,
        position: (highest?.max ?? 0) + 1,
        state: 'waiting',
        joinedAt: atMs,
        offeredAt: null,
        offerExpiresAt: null,
        resolvedAt: null,
      })
      .run();

    emit({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'session.updated',
      payload: { sessionId: session.id, waitlistJoined: true },
    });

    return db.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, entryId)).get()!;
  });

  const waiting = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.waitlistEntries)
    .where(
      and(
        eq(schema.waitlistEntries.sessionId, session.id),
        inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
      ),
    )
    .get();

  return c.json({
    waitlist: {
      id: entry.id,
      sessionId: entry.sessionId,
      memberId: entry.memberId,
      position: waitlistRank(entry.sessionId, entry.position),
      state: entry.state,
      joinedAt: new Date(entry.joinedAt).toISOString(),
      offeredAt: entry.offeredAt === null ? null : new Date(entry.offeredAt).toISOString(),
      offerExpiresAt: entry.offerExpiresAt === null ? null : new Date(entry.offerExpiresAt).toISOString(),
    },
    waitlistCount: waiting?.n ?? 0,
    offerWindowMin: OFFER_WINDOW_MIN,
    creditsHeld: classCreditsHeld(memberId, today),
    message: `You are number ${waitlistRank(entry.sessionId, entry.position)} in line. No credit is taken unless you take the seat.`,
  });
});

scheduleRoutes.delete('/waitlist/:id', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const entryId = c.req.param('id');

  const entry = db.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, entryId)).get();
  if (!entry || entry.tenantId !== ctx.tenantId || entry.memberId !== memberId) {
    throw notFound('That waitlist place');
  }

  const session = sessionById(ctx.tenantId, entry.sessionId);

  transact(() => {
    // Removed rather than marked, so the member can rejoin the same class later.
    db.delete(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, entry.id)).run();

    if (session) {
      emit({
        tenantId: ctx.tenantId,
        branchId: session.branchId,
        channel: channels.branch(session.branchId),
        topic: 'session.updated',
        payload: { sessionId: session.id, waitlistLeft: true },
      });
    }
  });

  const waiting = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.waitlistEntries)
    .where(
      and(
        eq(schema.waitlistEntries.sessionId, entry.sessionId),
        inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
      ),
    )
    .get();

  return c.json({
    ok: true,
    sessionId: entry.sessionId,
    waitlistCount: waiting?.n ?? 0,
    message: 'You are off the waitlist. Nothing was charged.',
  });
});
