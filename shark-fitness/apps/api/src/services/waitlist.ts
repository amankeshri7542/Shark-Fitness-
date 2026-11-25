import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { offerExpiresAt } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { AppError, conflict, entitlementMissing, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, isoDate, localTime, now } from '../lib/time.js';
import { policyValue } from '../lib/policy.js';
import { branchTimeZone } from '../lib/branch-time.js';
import {
  LIVE_WAITLIST_STATES,
  assertBranchAcceptsBookings,
  claimSeat,
  classCreditsHeld,
  membershipStanding,
  myBookingFor,
  myBookingsAround,
  overlapWith,
  reapExpiredHolds,
  runClaim,
  sessionById,
  type ClaimSeatResult,
  type SessionRow,
} from './booking.js';

/**
 * The waitlist (PF-SCH-002, PRD 01 scenario 3, decision 12). One engine, used
 * by the member app, the console and the scheduler.
 *
 * The rule that makes it safe: **an offer is a seat.** When a seat frees up
 * and the first eligible member in line is offered it, `class_sessions.booked`
 * goes up by one in the same transaction, so the held seat cannot be booked by
 * anyone else while the offer stands. Accepting converts the hold into a
 * booking without touching `booked`; declining or letting it run out gives the
 * seat back and offers it to the next member. The database checks the same
 * arithmetic independently (live bookings + live offers ≤ capacity, triggers in
 * `db/migrate.ts`), so a service bug cannot oversell a class either.
 *
 * Order is FIFO by `position`, which is assigned once at join and never
 * renumbered; every join, offer, skip, accept, decline, expiry and withdrawal
 * writes an audit row, so the queue's history can be replayed from the log.
 */

export const OFFER_WINDOW_DEFAULT_MIN = 30;
export const OFFER_CUTOFF_DEFAULT_MIN = 60;

export interface OfferTerms {
  offerWindowMin: number;
  cutoffBeforeStartMin: number;
}

/** Tenant default with branch override (Settings → Policies). */
export function offerTerms(tenantId: string, branchId: string): OfferTerms {
  return {
    offerWindowMin: Number(policyValue(tenantId, branchId, 'waitlistOfferMinutes', OFFER_WINDOW_DEFAULT_MIN)),
    cutoffBeforeStartMin: Number(policyValue(tenantId, branchId, 'waitlistOfferCutoffMinutes', OFFER_CUTOFF_DEFAULT_MIN)),
  };
}

export interface OfferMade {
  waitlistId: string;
  memberId: string;
  position: number;
  offerExpiresAt: string;
}

type Entry = typeof schema.waitlistEntries.$inferSelect;

/** The scheduler and the queue act for the gym, not for a person. */
function systemContext(tenantId: string): RequestContext {
  return {
    requestId: id('job'),
    sessionId: 'system',
    authMethod: 'reader',
    tenantId,
    userId: 'system',
    memberId: null,
    staffId: null,
    role: 'owner',
    name: 'Waitlist',
    branchIds: [],
    activeBranchId: null,
    permissions: [],
    ip: 'system',
    userAgent: 'scheduler',
    impersonatorId: null,
  };
}

function notifyMember(
  tenantId: string,
  memberId: string,
  message: { kind: string; title: string; body: string; templateCode: string },
  atMs: number,
): void {
  const member = db.select({ userId: schema.members.userId }).from(schema.members).where(eq(schema.members.id, memberId)).get();
  if (!member?.userId) return;
  // In-app always. Push is P04's channel: the integration wires
  // `waitlist.offered` to it (see P05 notes, Integration).
  db.insert(schema.notifications)
    .values({
      id: id('ntf'),
      tenantId,
      userId: member.userId,
      channel: 'in_app',
      kind: message.kind,
      title: message.title,
      body: message.body,
      link: '/book',
      templateCode: message.templateCode,
      state: 'sent',
      attempts: 1,
      lastError: null,
      createdAt: atMs,
      readAt: null,
    })
    .run();
}

function permittedBranches(tenantId: string, memberId: string): string[] {
  const member = db
    .select({ homeBranchId: schema.members.homeBranchId })
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, tenantId)))
    .get();
  if (!member) return [];
  const extra = db
    .select({ branchId: schema.memberBranches.branchId })
    .from(schema.memberBranches)
    .where(and(eq(schema.memberBranches.tenantId, tenantId), eq(schema.memberBranches.memberId, memberId)))
    .all()
    .map((row) => row.branchId);
  return [...new Set([member.homeBranchId, ...extra])];
}

/** Why this member cannot be offered the seat now, or null when they can.
 *  Promotion re-checks from scratch: a member whose membership lapsed while
 *  they waited is skipped, not handed a seat they cannot use. */
function promotionBlock(tenantId: string, session: SessionRow, entry: Entry, atMs: number): string | null {
  const standing = membershipStanding(entry.memberId);
  if (!standing.entitled) return standing.reason ?? 'Membership no longer covers bookings';
  if (!permittedBranches(tenantId, entry.memberId).includes(session.branchId)) {
    return 'Membership does not include this branch';
  }
  const today = isoDate(atMs, branchTimeZone(tenantId, session.branchId));
  if (session.creditsRequired > 0 && session.dropInPriceMinor === null) {
    if (classCreditsHeld(entry.memberId, today) < session.creditsRequired) return 'No class credits left';
  }
  const clash = overlapWith(session, myBookingsAround(entry.memberId, session.startsAt - DAY, session.endsAt + DAY));
  if (clash) return 'Already booked into an overlapping class';
  return null;
}

/**
 * Offers every free seat in this class to the next eligible members in line.
 * Call inside the transaction that freed the seat (a cancellation, a release,
 * a capacity increase, a declined or expired offer). Returns the offers made.
 */
export function offerFreedSeats(ctx: RequestContext, sessionId: string, atMs: number): OfferMade[] {
  const made: OfferMade[] = [];
  const tenantId = ctx.tenantId;

  for (;;) {
    const session = sessionById(tenantId, sessionId);
    if (!session || session.state === 'cancelled' || !session.waitlistEnabled) return made;
    if (session.booked >= session.capacity) return made;

    const terms = offerTerms(tenantId, session.branchId);
    const deadline = offerExpiresAt(atMs, session.startsAt, terms.offerWindowMin, terms.cutoffBeforeStartMin);
    // Too close to class for anyone to act on an offer: the seat stays open
    // for whoever books it first, and the queue stays as it is.
    if (deadline === null) return made;

    const next = db
      .select()
      .from(schema.waitlistEntries)
      .where(and(eq(schema.waitlistEntries.sessionId, sessionId), eq(schema.waitlistEntries.state, 'waiting')))
      .orderBy(asc(schema.waitlistEntries.position))
      .get();
    if (!next) return made;

    const tz = branchTimeZone(tenantId, session.branchId);
    const block = promotionBlock(tenantId, session, next, atMs);
    if (block) {
      db.update(schema.waitlistEntries).set({ state: 'skipped', resolvedAt: atMs }).where(eq(schema.waitlistEntries.id, next.id)).run();
      audit(ctx, {
        action: 'waitlist.skipped',
        entityType: 'waitlist_entry',
        entityId: next.id,
        entityLabel: session.name,
        branchId: session.branchId,
        reason: block,
        before: { state: 'waiting', position: next.position },
        after: { state: 'skipped' },
      });
      notifyMember(
        tenantId,
        next.memberId,
        {
          kind: 'waitlist_skipped',
          title: `A seat opened in ${session.name}, but you could not take it`,
          body: `${block}. You have left the waitlist for ${localTime(session.startsAt, tz)}. Reception can help.`,
          templateCode: 'waitlist.skipped',
        },
        atMs,
      );
      continue;
    }

    // The hold. Conditional, exactly like a booking claim.
    const hold = db
      .update(schema.classSessions)
      .set({ booked: sql`${schema.classSessions.booked} + 1`, updatedAt: atMs, version: sql`${schema.classSessions.version} + 1` })
      .where(
        and(
          eq(schema.classSessions.id, sessionId),
          sql`${schema.classSessions.booked} < ${schema.classSessions.capacity}`,
          sql`${schema.classSessions.state} != 'cancelled'`,
        ),
      )
      .run();
    if (hold.changes === 0) return made;

    db.update(schema.waitlistEntries)
      .set({ state: 'offered', offeredAt: atMs, offerExpiresAt: deadline })
      .where(and(eq(schema.waitlistEntries.id, next.id), eq(schema.waitlistEntries.state, 'waiting')))
      .run();

    const minutes = Math.round((deadline - atMs) / 60_000);
    audit(ctx, {
      action: 'waitlist.offered',
      entityType: 'waitlist_entry',
      entityId: next.id,
      entityLabel: session.name,
      branchId: session.branchId,
      before: { state: 'waiting', position: next.position },
      after: { state: 'offered', offerExpiresAt: new Date(deadline).toISOString() },
    });
    notifyMember(
      tenantId,
      next.memberId,
      {
        kind: 'waitlist_offer',
        title: `A seat opened in ${session.name}`,
        body: `${localTime(session.startsAt, tz)} on ${isoDate(session.startsAt, tz)}. It is held for you until ${localTime(deadline, tz)} (${minutes} minutes). After that it goes to the next person.`,
        templateCode: 'waitlist.offered',
      },
      atMs,
    );
    emit({
      tenantId,
      branchId: session.branchId,
      channel: channels.member(next.memberId),
      topic: 'waitlist.offered',
      payload: { sessionId, waitlistId: next.id, offerExpiresAt: new Date(deadline).toISOString() },
    });
    emit({
      tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'waitlist.promoted',
      payload: { sessionId, memberId: next.memberId, waitlistId: next.id },
    });

    made.push({ waitlistId: next.id, memberId: next.memberId, position: next.position, offerExpiresAt: new Date(deadline).toISOString() });
  }
}

/** Gives an offered seat back to the pool. Call inside a transaction. */
function releaseHold(sessionId: string, atMs: number): void {
  db.update(schema.classSessions)
    .set({ booked: sql`max(0, ${schema.classSessions.booked} - 1)`, updatedAt: atMs, version: sql`${schema.classSessions.version} + 1` })
    .where(eq(schema.classSessions.id, sessionId))
    .run();
}

/** Ends one offer (expired, declined) and passes the seat on. Inside a
 *  transaction; a no-op if the entry is no longer offered. */
function endOffer(ctx: RequestContext, entry: Entry, outcome: 'expired' | 'declined', atMs: number): OfferMade[] {
  const ended = db
    .update(schema.waitlistEntries)
    .set({ state: outcome, resolvedAt: atMs })
    .where(and(eq(schema.waitlistEntries.id, entry.id), eq(schema.waitlistEntries.state, 'offered')))
    .run();
  if (ended.changes === 0) return [];
  releaseHold(entry.sessionId, atMs);

  const session = sessionById(entry.tenantId, entry.sessionId);
  audit(ctx, {
    action: outcome === 'expired' ? 'waitlist.offer_expired' : 'waitlist.declined',
    entityType: 'waitlist_entry',
    entityId: entry.id,
    entityLabel: session?.name ?? 'Class',
    branchId: session?.branchId ?? null,
    before: { state: 'offered' },
    after: { state: outcome },
  });
  if (outcome === 'expired' && session) {
    notifyMember(
      entry.tenantId,
      entry.memberId,
      {
        kind: 'waitlist_offer_expired',
        title: `The seat in ${session.name} has passed on`,
        body: 'The offer ran out before it was taken, so it went to the next person. Nothing was charged.',
        templateCode: 'waitlist.offer_expired',
      },
      atMs,
    );
  }
  if (session) {
    emit({
      tenantId: entry.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'session.updated',
      payload: { sessionId: session.id, waitlistOffer: outcome },
    });
  }
  return offerFreedSeats(ctx, entry.sessionId, atMs);
}

/** The member's view of where they stand: rank among those still in line. */
export function waitlistRank(sessionId: string, storedPosition: number): number {
  const ahead = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.waitlistEntries)
    .where(
      and(
        eq(schema.waitlistEntries.sessionId, sessionId),
        inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
        sql`${schema.waitlistEntries.position} < ${storedPosition}`,
      ),
    )
    .get();
  return (ahead?.n ?? 0) + 1;
}

export function liveWaitlistCount(sessionId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.waitlistEntries)
      .where(and(eq(schema.waitlistEntries.sessionId, sessionId), inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES])))
      .get()?.n ?? 0
  );
}

/* ============================================================================
   Member actions
   ========================================================================= */

/** Join the line for a full class. Idempotent: joining twice is one place. */
export function joinWaitlist(ctx: RequestContext, memberId: string, session: SessionRow, atMs: number): Entry {
  return transact(() => {
    const live = db
      .select()
      .from(schema.waitlistEntries)
      .where(
        and(
          eq(schema.waitlistEntries.memberId, memberId),
          eq(schema.waitlistEntries.sessionId, session.id),
          inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
        ),
      )
      .get();
    if (live) return live;

    assertBranchAcceptsBookings(ctx.tenantId, session.branchId);
    if (session.state === 'cancelled') throw precondition('This class was cancelled.');
    if (session.startsAt <= atMs) throw new AppError('BOOKING_WINDOW_CLOSED', 'This class has already started.');
    if (!session.waitlistEnabled) throw precondition('This class does not run a waitlist.');
    if (myBookingFor(memberId, session.id)) throw conflict('You already have a seat in this class.');

    const standing = membershipStanding(memberId);
    if (!standing.entitled) throw entitlementMissing(standing.reason ?? 'Your membership does not cover bookings right now.');

    reapExpiredHolds(session.id, atMs);
    const fresh = sessionById(ctx.tenantId, session.id)!;
    if (fresh.booked < fresh.capacity) throw precondition('There are seats left in this class. Book one instead of waiting.');

    // Positions only ever grow, so the order is the order people joined in,
    // even for someone who left and came back (they go to the back).
    const highest = db
      .select({ max: sql<number>`coalesce(max(${schema.waitlistEntries.position}), 0)` })
      .from(schema.waitlistEntries)
      .where(eq(schema.waitlistEntries.sessionId, session.id))
      .get();
    const position = (highest?.max ?? 0) + 1;

    // One row per member per class (`waitlist_uq`); a rejoin reuses it.
    const previous = db
      .select()
      .from(schema.waitlistEntries)
      .where(and(eq(schema.waitlistEntries.memberId, memberId), eq(schema.waitlistEntries.sessionId, session.id)))
      .get();
    const entryId = previous?.id ?? id('wtl');
    if (previous) {
      db.update(schema.waitlistEntries)
        .set({ position, state: 'waiting', joinedAt: atMs, offeredAt: null, offerExpiresAt: null, resolvedAt: null })
        .where(eq(schema.waitlistEntries.id, previous.id))
        .run();
    } else {
      db.insert(schema.waitlistEntries)
        .values({
          id: entryId,
          tenantId: ctx.tenantId,
          sessionId: session.id,
          memberId,
          position,
          state: 'waiting',
          joinedAt: atMs,
          offeredAt: null,
          offerExpiresAt: null,
          resolvedAt: null,
        })
        .run();
    }

    audit(ctx, {
      action: 'waitlist.joined',
      entityType: 'waitlist_entry',
      entityId: entryId,
      entityLabel: session.name,
      branchId: session.branchId,
      after: { state: 'waiting', position },
    });
    emit({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'session.updated',
      payload: { sessionId: session.id, waitlistJoined: true },
    });

    return db.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, entryId)).get()!;
  });
}

function loadOwnEntry(ctx: RequestContext, memberId: string, entryId: string): Entry {
  const entry = db.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, entryId)).get();
  if (!entry || entry.tenantId !== ctx.tenantId || entry.memberId !== memberId) throw notFound('That waitlist place');
  return entry;
}

/** Leave the line, or turn down a seat that was offered. Either way nothing is
 *  charged; a declined seat goes straight to the next member. */
export function leaveWaitlist(ctx: RequestContext, memberId: string, entryId: string, atMs: number): { offered: OfferMade[]; declinedOffer: boolean } {
  return transact(() => {
    const entry = loadOwnEntry(ctx, memberId, entryId);
    if (entry.state === 'offered') {
      return { offered: endOffer(ctx, entry, 'declined', atMs), declinedOffer: true };
    }
    if (entry.state === 'waiting') {
      db.update(schema.waitlistEntries)
        .set({ state: 'declined', resolvedAt: atMs })
        .where(and(eq(schema.waitlistEntries.id, entry.id), eq(schema.waitlistEntries.state, 'waiting')))
        .run();
      const session = sessionById(ctx.tenantId, entry.sessionId);
      audit(ctx, {
        action: 'waitlist.left',
        entityType: 'waitlist_entry',
        entityId: entry.id,
        entityLabel: session?.name ?? 'Class',
        branchId: session?.branchId ?? null,
        before: { state: 'waiting', position: entry.position },
        after: { state: 'declined' },
      });
      if (session) {
        emit({
          tenantId: ctx.tenantId,
          branchId: session.branchId,
          channel: channels.branch(session.branchId),
          topic: 'session.updated',
          payload: { sessionId: session.id, waitlistLeft: true },
        });
      }
    }
    return { offered: [], declinedOffer: false };
  });
}

export type AcceptOutcome =
  | { kind: 'confirmed'; result: ClaimSeatResult }
  | { kind: 'expired' }
  | { kind: 'gone'; state: string };

/**
 * Take an offered seat. Re-checks membership, branch, the booking window and
 * credits through the same claim as any booking, then converts the hold.
 * Racing the expiry job, exactly one of the two wins: both run inside a write
 * transaction and both require the entry still to be `offered`.
 */
export function acceptOffer(
  ctx: RequestContext,
  input: { memberId: string; entryId: string; idempotencyKey: string; acceptDropInCharge: boolean; atMs: number },
): AcceptOutcome {
  const outcome = transact((): AcceptOutcome => {
    const entry = loadOwnEntry(ctx, input.memberId, input.entryId);
    const session = sessionById(ctx.tenantId, entry.sessionId);
    if (!session) throw notFound('That class');

    if (entry.state === 'confirmed') {
      const booking = myBookingFor(input.memberId, session.id);
      if (booking) return { kind: 'confirmed', result: { booking, replayed: true, creditsUsed: booking.creditsUsed, chargeMinor: booking.chargeMinor } };
    }
    if (entry.state !== 'offered') return { kind: 'gone', state: entry.state };
    if (entry.offerExpiresAt === null || entry.offerExpiresAt <= input.atMs) {
      endOffer(ctx, entry, 'expired', input.atMs);
      return { kind: 'expired' };
    }

    const today = isoDate(input.atMs, branchTimeZone(ctx.tenantId, session.branchId));
    const result = runClaim(() =>
      claimSeat(ctx, {
        session,
        memberId: input.memberId,
        idempotencyKey: input.idempotencyKey,
        acceptDropInCharge: input.acceptDropInCharge,
        bookedByStaff: false,
        today,
        atMs: input.atMs,
      }),
    );
    return { kind: 'confirmed', result };
  });
  return outcome;
}

/* ============================================================================
   The scheduler: offers that ran out pass on.
   ========================================================================= */

export function expireWaitlistOffers(atMs = now()): { offersExpired: number; offersMade: number } {
  const stale = db
    .select()
    .from(schema.waitlistEntries)
    .where(and(eq(schema.waitlistEntries.state, 'offered'), lte(schema.waitlistEntries.offerExpiresAt, atMs)))
    .all();

  let offersExpired = 0;
  let offersMade = 0;
  for (const entry of stale) {
    transact(() => {
      const current = db.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.id, entry.id)).get();
      if (!current || current.state !== 'offered') return;
      offersExpired += 1;
      offersMade += endOffer(systemContext(entry.tenantId), current, 'expired', atMs).length;
    });
  }
  return { offersExpired, offersMade };
}

/* ============================================================================
   Capacity changes from the console.
   ========================================================================= */

export interface CapacityOutcome {
  offered: OfferMade[];
  withdrawnOffers: number;
  /** Live bookings above the new capacity. Nothing is cancelled; staff decide. */
  overbookedBy: number;
}

/**
 * Called inside `updateSession`'s transaction after the capacity is written.
 * More seats: offer them. Fewer seats: take back offers that no longer fit
 * (newest first; the member goes back to waiting in their original place),
 * and if confirmed bookings alone exceed the class, cancel nobody — record it
 * and let the dashboard raise it until a person sorts it out.
 */
export function applyCapacityChange(ctx: RequestContext, sessionId: string, before: number, after: number, atMs: number): CapacityOutcome {
  const out: CapacityOutcome = { offered: [], withdrawnOffers: 0, overbookedBy: 0 };
  if (after > before) {
    out.offered = offerFreedSeats(ctx, sessionId, atMs);
    return out;
  }

  const session = sessionById(ctx.tenantId, sessionId)!;
  let excess = session.booked - after;
  if (excess <= 0) return out;

  const offers = db
    .select()
    .from(schema.waitlistEntries)
    .where(and(eq(schema.waitlistEntries.sessionId, sessionId), eq(schema.waitlistEntries.state, 'offered')))
    .orderBy(desc(schema.waitlistEntries.position))
    .all();
  const tz = branchTimeZone(ctx.tenantId, session.branchId);
  for (const offer of offers) {
    if (excess <= 0) break;
    db.update(schema.waitlistEntries)
      .set({ state: 'waiting', offeredAt: null, offerExpiresAt: null })
      .where(and(eq(schema.waitlistEntries.id, offer.id), eq(schema.waitlistEntries.state, 'offered')))
      .run();
    releaseHold(sessionId, atMs);
    audit(ctx, {
      action: 'waitlist.offer_withdrawn',
      entityType: 'waitlist_entry',
      entityId: offer.id,
      entityLabel: session.name,
      branchId: session.branchId,
      reason: 'Class capacity reduced',
      before: { state: 'offered' },
      after: { state: 'waiting', position: offer.position },
    });
    notifyMember(
      ctx.tenantId,
      offer.memberId,
      {
        kind: 'waitlist_offer_withdrawn',
        title: `The seat offer for ${session.name} was withdrawn`,
        body: `The class at ${localTime(session.startsAt, tz)} was made smaller, so the seat no longer exists. You are still on the waitlist in the same place. Nothing was charged.`,
        templateCode: 'waitlist.offer_withdrawn',
      },
      atMs,
    );
    out.withdrawnOffers += 1;
    excess -= 1;
  }

  if (excess > 0) {
    out.overbookedBy = excess;
    audit(ctx, {
      action: 'session.overbooked',
      entityType: 'class_session',
      entityId: sessionId,
      entityLabel: session.name,
      branchId: session.branchId,
      reason: 'Capacity set below confirmed bookings. Nobody was cancelled.',
      after: { capacity: after, booked: session.booked - out.withdrawnOffers, overbookedBy: excess },
    });
    emit({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'alert.raised',
      payload: { kind: 'overbooked_class', sessionId, capacity: after, overbookedBy: excess },
    });
  }
  return out;
}
