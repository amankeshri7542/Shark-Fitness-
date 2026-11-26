import { Hono } from 'hono';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { channels } from '@shark/contracts';
import { classifyCancellation, evaluateEligibility } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requireBranch } from '../../lib/context.js';
import type { RequestContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { DAY, isoDate, localTime, now } from '../../lib/time.js';
import { conflict, notFound, precondition } from '../../lib/errors.js';
import {
  LIVE_BOOKING_STATES,
  LIVE_WAITLIST_STATES,
  claimSeat,
  classCreditsHeld,
  deadHoldCount,
  eligibilityFor,
  membershipStanding,
  myBookingsAround,
  runClaim,
  sessionById,
  sessionQuery,
  restoreBookingCredits,
  type EligibilityContext,
  type SessionRow,
} from '../../services/booking.js';
import { emitIntegrationEvent } from '../../services/integration-events.js';
import { acceptOffer, joinWaitlist, leaveWaitlist, liveWaitlistCount, offerFreedSeats, offerTerms, waitlistRank } from '../../services/waitlist.js';

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

  // Every seat being held for this member, whatever day it is on: an offer
  // must be answerable from wherever they open Book.
  const offers = db
    .select({ entry: schema.waitlistEntries })
    .from(schema.waitlistEntries)
    .where(
      and(
        eq(schema.waitlistEntries.memberId, memberId),
        eq(schema.waitlistEntries.state, 'offered'),
        gte(schema.waitlistEntries.offerExpiresAt, atMs),
      ),
    )
    .orderBy(asc(schema.waitlistEntries.offerExpiresAt))
    .all()
    .flatMap(({ entry }) => {
      const session = sessionById(ctx.tenantId, entry.sessionId);
      if (!session) return [];
      const offerTz = session.branchId === branch.id ? tz : (db.select({ tz: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, session.branchId)).get()?.tz ?? tz);
      const payingCash = session.creditsRequired > 0 && creditsHeld < session.creditsRequired && session.dropInPriceMinor !== null;
      return [
        {
          waitlistId: entry.id,
          sessionId: session.id,
          name: session.name,
          trainerName: session.trainerName ?? 'Coach',
          localDate: isoDate(session.startsAt, offerTz),
          dateLabel: new Intl.DateTimeFormat('en-GB', { timeZone: offerTz, weekday: 'long', day: 'numeric', month: 'long' }).format(session.startsAt),
          localTime: localTime(session.startsAt, offerTz),
          offerExpiresAt: new Date(entry.offerExpiresAt!).toISOString(),
          creditsRequired: payingCash ? 0 : session.creditsRequired,
          dropInPriceMinor: payingCash ? session.dropInPriceMinor : null,
        },
      ];
    });

  return c.json({
    serverNow: new Date(atMs).toISOString(),
    offers,
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
    waitlist: (() => {
      const terms = offerTerms(ctx.tenantId, branch.id);
      return {
        available: true,
        offerWindowMin: terms.offerWindowMin,
        cutoffBeforeStartMin: terms.cutoffBeforeStartMin,
        message: `When a seat opens, the first person in line is offered it and it is held for them for up to ${terms.offerWindowMin} minutes. Offers stop ${terms.cutoffBeforeStartMin} minutes before class.`,
      };
    })(),
    myBookedToday: [...myBookings.values()].length,
    items,
  });
});

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
    if (outcome.refundCredit) restoreBookingCredits(ctx.tenantId, booking, `Cancelled ${session.name}`, atMs);

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
    emitIntegrationEvent({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      type: 'class.cancelled',
      data: { bookingId: booking.id, classSessionId: session.id, memberId, cancelledBy: 'member', lateCancel: outcome.state === 'late_cancelled' },
    });

    const offers = offerFreedSeats(ctx, session.id, atMs);
    return offers[0] ?? null;
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

/* ============================================================================
   POST /waitlist — join. DELETE /waitlist/:id — leave, or decline an offer.
   POST /waitlist/:id/accept — take an offered seat.
   ========================================================================= */

function serialiseEntry(entry: typeof schema.waitlistEntries.$inferSelect) {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    memberId: entry.memberId,
    position: waitlistRank(entry.sessionId, entry.position),
    state: entry.state,
    joinedAt: new Date(entry.joinedAt).toISOString(),
    offeredAt: entry.offeredAt === null ? null : new Date(entry.offeredAt).toISOString(),
    offerExpiresAt: entry.offerExpiresAt === null ? null : new Date(entry.offerExpiresAt).toISOString(),
  };
}

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

  const entry = joinWaitlist(ctx, memberId, session, atMs);
  const terms = offerTerms(ctx.tenantId, session.branchId);
  const position = waitlistRank(entry.sessionId, entry.position);

  return c.json({
    waitlist: serialiseEntry(entry),
    waitlistCount: liveWaitlistCount(session.id),
    offerWindowMin: terms.offerWindowMin,
    creditsHeld: classCreditsHeld(memberId, today),
    message: `You are number ${position} in line. If a seat opens we hold it for you and tell you. No credit is taken unless you take the seat.`,
  });
});

scheduleRoutes.delete('/waitlist/:id', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const entryId = c.req.param('id');
  const atMs = now();

  const result = leaveWaitlist(ctx, memberId, entryId, atMs);
  const entry = db.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, entryId)).get()!;

  return c.json({
    ok: true,
    sessionId: entry.sessionId,
    waitlistCount: liveWaitlistCount(entry.sessionId),
    message: result.declinedOffer
      ? 'Seat declined. It has gone to the next person. Nothing was charged.'
      : 'You are off the waitlist. Nothing was charged.',
  });
});

const AcceptBody = z.object({
  idempotencyKey: z.string().min(8),
  acceptDropInCharge: z.boolean().default(false),
});

scheduleRoutes.post('/waitlist/:id/accept', validate('json', AcceptBody), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const body = c.req.valid('json');
  const atMs = now();

  const outcome = acceptOffer(ctx, {
    memberId,
    entryId: c.req.param('id'),
    idempotencyKey: body.idempotencyKey,
    acceptDropInCharge: body.acceptDropInCharge,
    atMs,
  });

  if (outcome.kind === 'expired') {
    throw conflict('That seat offer ran out before it was taken, so it went to the next person. Nothing was charged.', {
      reason: 'offer_expired',
    });
  }
  if (outcome.kind === 'gone') {
    throw conflict('That seat offer is no longer open. Nothing was charged.', { reason: `offer_${outcome.state}` });
  }

  const booking = outcome.result.booking;
  const session = sessionById(ctx.tenantId, booking.sessionId)!;
  const tz = db.select({ tz: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, session.branchId)).get()?.tz ?? 'Asia/Kolkata';
  return c.json({
    replayed: outcome.result.replayed,
    booking: serialiseBooking(booking),
    creditsHeld: classCreditsHeld(memberId, isoDate(atMs, tz)),
    message:
      outcome.result.creditsUsed > 0
        ? `Seat taken. ${outcome.result.creditsUsed} class ${outcome.result.creditsUsed === 1 ? 'credit was' : 'credits were'} used.`
        : outcome.result.chargeMinor > 0
          ? 'Seat taken. The drop-in is added to your account. Settle it in Billing or at reception.'
          : 'Seat taken. See you there.',
  });
});
