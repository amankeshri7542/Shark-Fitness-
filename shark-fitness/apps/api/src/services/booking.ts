import { reconcileMembershipDates } from './membership-dates.js';
import { creditBalance, restoreSpend, spendCredits } from './credit-ledger.js';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { channels, type BranchState } from '@shark/contracts';
import { branchTrades, evaluateEligibility, holdIsLive, isEntitled } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { DAY } from '../lib/time.js';
import { AppError, capacityExhausted, conflict, entitlementMissing, forbidden, precondition } from '../lib/errors.js';

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

/** Branch lifecycle is a hard boundary, not an eligibility override. Read it
 * inside the same transaction that claims the seat so a closed branch cannot
 * accept a last concurrent booking. */
export function assertBranchAcceptsBookings(tenantId: string, branchId: string): void {
  const branch = db
    .select({ state: schema.branches.state })
    .from(schema.branches)
    .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, tenantId)))
    .get();
  if (!branch || !branchTrades(branch.state as BranchState)) {
    throw precondition('This branch is not accepting new bookings right now.');
  }
}

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
  reconcileMembershipDates(memberId);
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

/** Class credits a member can spend today: unexpired lots, net of spends
 *  (services/credit-ledger.ts, decision 11). */
export function classCreditsHeld(memberId: string, today: string): number {
  return creditBalance(memberId, 'class', today).usable;
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

/** This member's offer for this class, if it is still inside its deadline. */
export function liveOfferFor(memberId: string, sessionId: string, atMs: number) {
  const offer = db
    .select()
    .from(schema.waitlistEntries)
    .where(
      and(
        eq(schema.waitlistEntries.memberId, memberId),
        eq(schema.waitlistEntries.sessionId, sessionId),
        eq(schema.waitlistEntries.state, 'offered'),
      ),
    )
    .get();
  return offer && offer.offerExpiresAt !== null && offer.offerExpiresAt > atMs ? offer : null;
}

/** Takes class credits for a booking, earliest-expiring lot first. */
export function spendClassCredits(
  tenantId: string,
  memberId: string,
  units: number,
  ref: { reason: string; refType: string; refId: string },
  today: string,
  atMs: number,
): void {
  spendCredits(tenantId, memberId, 'class', units, ref, today, atMs);
}

/** Gives back the credits a booking spent, to the lots they came from (so
 *  they keep their original expiry). Returns the units restored. */
export function restoreBookingCredits(
  tenantId: string,
  booking: { id: string; memberId: string; creditsUsed: number },
  reason: string,
  atMs: number,
): number {
  if (booking.creditsUsed <= 0) return 0;
  const ref = { refType: 'booking', refId: booking.id };
  const touched = db
    .select({ id: schema.credits.id })
    .from(schema.credits)
    .where(and(eq(schema.credits.memberId, booking.memberId), eq(schema.credits.refType, ref.refType), eq(schema.credits.refId, ref.refId)))
    .get();
  if (touched) return restoreSpend(tenantId, booking.memberId, ref, reason, atMs);

  // A booking from before the ledger recorded its spend (seeded or legacy
  // data) has nothing to point back to: return the units as they were always
  // returned, without an expiry, rather than silently keeping them.
  db.insert(schema.credits)
    .values({
      id: id('crd'),
      tenantId,
      memberId: booking.memberId,
      kind: 'class',
      delta: booking.creditsUsed,
      reason,
      refType: 'booking',
      refId: booking.id,
      expiresOn: null,
      createdAt: atMs,
      lotId: null,
      packId: null,
    })
    .run();
  return booking.creditsUsed;
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
    timeZone: branchTimeZone(session.branchId),
  });
}

const zoneCache = new Map<string, string>();

/** Server clocks run in UTC; a member reads class times in their branch's zone. */
function branchTimeZone(branchId: string): string {
  const cached = zoneCache.get(branchId);
  if (cached) return cached;
  const row = db.select({ tz: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, branchId)).get();
  const tz = row?.tz ?? 'Asia/Kolkata';
  zoneCache.set(branchId, tz);
  return tz;
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

    assertBranchAcceptsBookings(ctx.tenantId, input.session.branchId);

    // A seat held by someone who walked away is a seat.
    reapExpiredHolds(input.session.id, input.atMs);
    const fresh = sessionById(ctx.tenantId, input.session.id)!;

    const mineAlready = myBookingFor(memberId, fresh.id);
    if (mineAlready) {
      return { booking: mineAlready, replayed: true, creditsUsed: mineAlready.creditsUsed, chargeMinor: mineAlready.chargeMinor };
    }

    const member = db
      .select({ id: schema.members.id, homeBranchId: schema.members.homeBranchId })
      .from(schema.members)
      .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId)))
      .get();
    if (!member) throw entitlementMissing('That member could not be found.');

    const extraBranchIds = db
      .select({ branchId: schema.memberBranches.branchId })
      .from(schema.memberBranches)
      .where(and(eq(schema.memberBranches.tenantId, ctx.tenantId), eq(schema.memberBranches.memberId, memberId)))
      .all()
      .map((row) => row.branchId);
    const permittedBranchIds = [...new Set([member.homeBranchId, ...extraBranchIds])];

    // A live waitlist offer is a seat already counted in `booked` and held for
    // this member alone. Taking it converts the hold; it never claims a second
    // seat. An offer past its deadline is not theirs any more: the expiry job
    // (or the accept path) hands it on, and until then it still occupies the
    // seat, so it cannot be double-counted here either.
    const heldOffer = liveOfferFor(memberId, fresh.id, input.atMs);

    const standing = membershipStanding(memberId);
    const creditsHeld = classCreditsHeld(memberId, input.today);
    const eligibility = eligibilityFor(
      fresh,
      heldOffer ? fresh.booked - 1 : fresh.booked,
      {
        atMs: input.atMs,
        today: input.today,
        standing,
        branchIds: permittedBranchIds,
        creditsHeld,
        otherBookings: myBookingsAround(memberId, fresh.startsAt - DAY, fresh.endsAt + DAY),
      },
      { booked: false, waitlisted: !heldOffer && Boolean(myWaitlistFor(memberId, fresh.id)) },
    );

    if (eligibility.action !== 'book' && eligibility.action !== 'pay') throw refuse(eligibility, fresh);

    // A drop-in is money. It is never charged without an explicit yes, whether
    // that yes came from the member or from staff attesting the member agreed.
    const payingCash = eligibility.action === 'pay';
    if (payingCash && !input.acceptDropInCharge) {
      throw new AppError('PAYMENT_REQUIRED', eligibility.reason, { details: { dropInPriceMinor: fresh.dropInPriceMinor } });
    }

    if (heldOffer) {
      // The held seat becomes the booking. The entry leaves `offered` before
      // the booking row exists, so the database's seat count (live bookings
      // plus live offers) never sees the same seat twice.
      db.update(schema.waitlistEntries)
        .set({ state: 'confirmed', resolvedAt: input.atMs })
        .where(and(eq(schema.waitlistEntries.id, heldOffer.id), eq(schema.waitlistEntries.state, 'offered')))
        .run();
      db.update(schema.classSessions)
        .set({ updatedAt: input.atMs, version: sql`${schema.classSessions.version} + 1` })
        .where(eq(schema.classSessions.id, fresh.id))
        .run();
    } else {
      // The claim. Conditional on capacity, so two claims racing for the last
      // seat produce one winner and one CAPACITY_EXHAUSTED — the trigger behind
      // this is a backstop, not the mechanism (PF-SCH-003).
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
    }

    const seatNo =
      db.select({ booked: schema.classSessions.booked }).from(schema.classSessions).where(eq(schema.classSessions.id, fresh.id)).get()
        ?.booked ?? fresh.booked + 1;

    const creditsUsed = payingCash ? 0 : fresh.creditsRequired;
    const chargeMinor = payingCash ? (fresh.dropInPriceMinor ?? 0) : 0;
    // Only a place still waiting in line converts here. An offer whose deadline
    // passed but which the expiry job has not reached yet still holds its own
    // seat in `booked`; it is left `offered` so that expiry releases that seat
    // and passes it on. Confirming it here would strand the held seat for good.
    const waitingEntry = heldOffer ? null : myWaitlistFor(memberId, fresh.id);
    const stillWaiting = waitingEntry?.state === 'waiting' ? waitingEntry : null;
    const cameFromWaitlist = heldOffer !== null || stillWaiting !== null;

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
      spendClassCredits(ctx.tenantId, memberId, creditsUsed, { reason: `Booked ${fresh.name}`, refType: 'booking', refId: bookingId }, input.today, input.atMs);
    }

    // A member who was waiting and booked a seat directly (one opened after
    // the offer cut-off) leaves the queue as confirmed rather than hanging on.
    if (stillWaiting) {
      db.update(schema.waitlistEntries).set({ state: 'confirmed', resolvedAt: input.atMs }).where(eq(schema.waitlistEntries.id, stillWaiting.id)).run();
    }
    if (cameFromWaitlist) {
      audit(ctx, {
        action: 'waitlist.confirmed',
        entityType: 'waitlist_entry',
        entityId: heldOffer?.id ?? stillWaiting?.id ?? bookingId,
        entityLabel: fresh.name,
        branchId: fresh.branchId,
        after: { bookingId, fromOffer: heldOffer !== null },
      });
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

    assertBranchAcceptsBookings(ctx.tenantId, input.session.branchId);

    reapExpiredHolds(input.session.id, input.atMs);
    const fresh = sessionById(ctx.tenantId, input.session.id)!;
    if (fresh.state === 'cancelled') throw precondition('That class was cancelled.');

    const mineAlready = myBookingFor(memberId, fresh.id);
    if (mineAlready) {
      return { booking: mineAlready, replayed: true, creditsUsed: mineAlready.creditsUsed, chargeMinor: mineAlready.chargeMinor };
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
