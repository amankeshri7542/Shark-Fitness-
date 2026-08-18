import { Hono } from 'hono';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { channels } from '@shark/contracts';
import { classifyCancellation, evaluateEligibility, planPromotion, type WaitlistCandidate } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requireBranch } from '../../lib/context.js';
import type { RequestContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { id } from '../../lib/ids.js';
import { DAY, MINUTE, isoDate, localTime, now } from '../../lib/time.js';
import { AppError, conflict, entitlementMissing, notFound, precondition } from '../../lib/errors.js';
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
  sessionQuery,
  type EligibilityContext,
  type SessionRow,
} from '../../services/booking.js';

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
 *    database trigger behind it is a backstop, not the mechanism. Both this
 *    claim and staff booking a member on from the desk share the exact same
 *    engine — see `services/booking.ts`'s `claimSeat`.
 */
export const scheduleRoutes = new Hono();

/** How long a promoted member has to take the seat before the next in line. */
const OFFER_WINDOW_MIN = 15;

/** Days shown in the date strip, starting today in the branch's own zone. */
const STRIP_DAYS = 7;

/* ============================================================================
   Shared reads. Every one of these filters on tenant, and the branch check
   happens once at the top of each handler via requireBranch.
   ========================================================================= */

/* Session reads, eligibility and the transactional claim are shared with
   staff booking via services/booking.ts — see the imports above. */

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

  const after = sessionById(ctx.tenantId, session.id)!;
  const standing = membershipStanding(memberId);
  const creditsHeld = classCreditsHeld(memberId, today);

  return c.json({
    replayed: result.replayed,
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
