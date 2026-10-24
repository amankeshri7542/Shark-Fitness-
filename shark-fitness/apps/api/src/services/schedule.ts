import { and, asc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { classifyCancellation, planPromotion, type WaitlistCandidate } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { conflict, invalid, notFound, precondition, staleVersion } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { MINUTE, isoDate, localTime, now } from '../lib/time.js';
import { LIVE_BOOKING_STATES, LIVE_WAITLIST_STATES, claimSeat, claimSeatOverride, runClaim, sessionById } from './booking.js';
import { loadMemberInScope } from './members.js';
import { branchTimeZone } from '../lib/branch-time.js';

/**
 * Class operations from the console (PF-SCH, UX-A09).
 *
 * Session CRUD, clashes, cancellation, waitlist promotion and attendance are
 * the operator's own side of the room. Booking a member onto a class is not —
 * that claim is canonical and shared with the member app via
 * `services/booking.ts`'s `claimSeat`, so a seat taken from the desk behaves
 * exactly like a seat taken from the phone: same entitlement checks, same
 * credit/charge accounting, same idempotency. `bookMemberOntoSession` below is
 * a thin adapter over that shared claim.
 */

export { LIVE_BOOKING_STATES, LIVE_WAITLIST_STATES };

const OFFER_WINDOW_MIN = 15;

export interface SessionRow {
  id: string;
  tenantId: string;
  branchId: string;
  classTypeId: string;
  roomId: string | null;
  trainerId: string | null;
  seriesId: string | null;
  startsAt: number;
  endsAt: number;
  capacity: number;
  booked: number;
  state: string;
  cancelledReason: string | null;
  substituteFor: string | null;
  version: number;
  notes: string | null;
}

/* ============================================================================
   Scoped loads
   ========================================================================= */

/** A session outside the caller's branches is "not found" — a 403 would
 *  confirm a class exists at a branch they cannot see. */
export function loadSessionInScope(
  ctx: { tenantId: string; branchIds: string[] },
  sessionId: string,
): typeof schema.classSessions.$inferSelect {
  const session = db
    .select()
    .from(schema.classSessions)
    .where(and(eq(schema.classSessions.id, sessionId), eq(schema.classSessions.tenantId, ctx.tenantId)))
    .get();
  if (!session || !ctx.branchIds.includes(session.branchId)) throw notFound('That class');
  return session;
}

export function loadBookingInScope(
  ctx: { tenantId: string; branchIds: string[] },
  bookingId: string,
): { booking: typeof schema.bookings.$inferSelect; session: typeof schema.classSessions.$inferSelect } {
  const booking = db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.tenantId, ctx.tenantId)))
    .get();
  if (!booking) throw notFound('That booking');
  const session = loadSessionInScope(ctx, booking.sessionId);
  return { booking, session };
}

/* ============================================================================
   Conflicts — UX-A09 lists a conflict panel, and "room conflict" is a
   mandatory state. A room or a trainer cannot be in two places at once.
   ========================================================================= */

export interface Clash {
  kind: 'room' | 'trainer';
  sessionId: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

export function detectClashes(
  tenantId: string,
  input: {
    branchId: string;
    roomId: string | null;
    trainerId: string | null;
    startsAt: number;
    endsAt: number;
    excludeSessionId?: string;
  },
): Clash[] {
  if (input.endsAt <= input.startsAt) return [];

  const overlapping = db
    .select({
      id: schema.classSessions.id,
      roomId: schema.classSessions.roomId,
      trainerId: schema.classSessions.trainerId,
      startsAt: schema.classSessions.startsAt,
      endsAt: schema.classSessions.endsAt,
      name: schema.classTypes.name,
    })
    .from(schema.classSessions)
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
    .where(
      and(
        eq(schema.classSessions.tenantId, tenantId),
        ne(schema.classSessions.state, 'cancelled'),
        // Half-open overlap: a class ending exactly as another starts is fine.
        lt(schema.classSessions.startsAt, input.endsAt),
        gt(schema.classSessions.endsAt, input.startsAt),
        input.excludeSessionId ? ne(schema.classSessions.id, input.excludeSessionId) : undefined,
      ),
    )
    .all();

  const clashes: Clash[] = [];
  for (const row of overlapping) {
    // A room belongs to one branch, so a room clash is implicitly branch-local.
    if (input.roomId && row.roomId === input.roomId) {
      clashes.push({
        kind: 'room',
        sessionId: row.id,
        name: row.name,
        startsAt: new Date(row.startsAt).toISOString(),
        endsAt: new Date(row.endsAt).toISOString(),
      });
    }
    // A trainer clash spans branches: one person cannot cover two sites at once.
    if (input.trainerId && row.trainerId === input.trainerId) {
      clashes.push({
        kind: 'trainer',
        sessionId: row.id,
        name: row.name,
        startsAt: new Date(row.startsAt).toISOString(),
        endsAt: new Date(row.endsAt).toISOString(),
      });
    }
  }
  return clashes;
}

/** Seats that count right now. Cancelled bookings must not hold a seat. */
export function liveBookingCount(sessionId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.bookings)
      .where(and(eq(schema.bookings.sessionId, sessionId), inArray(schema.bookings.state, [...LIVE_BOOKING_STATES])))
      .get()?.n ?? 0
  );
}

export function waitlistCount(sessionId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.waitlistEntries)
      .where(
        and(
          eq(schema.waitlistEntries.sessionId, sessionId),
          inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
        ),
      )
      .get()?.n ?? 0
  );
}

/* ============================================================================
   Notification. PF-SCH-004 requires the people in a class to be told when it
   changes underneath them.
   ========================================================================= */

function notifyBookedMembers(
  ctx: RequestContext,
  session: { id: string; branchId: string },
  message: { kind: string; title: string; body: string; templateCode: string },
  atMs: number,
): number {
  const recipients = db
    .select({ userId: schema.members.userId, memberId: schema.members.id })
    .from(schema.bookings)
    .innerJoin(schema.members, eq(schema.members.id, schema.bookings.memberId))
    .where(
      and(eq(schema.bookings.sessionId, session.id), inArray(schema.bookings.state, [...LIVE_BOOKING_STATES])),
    )
    .all();

  let sent = 0;
  for (const row of recipients) {
    if (!row.userId) continue;
    db.insert(schema.notifications)
      .values({
        id: id('ntf'),
        tenantId: ctx.tenantId,
        userId: row.userId,
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
    sent += 1;
  }
  return sent;
}

/* ============================================================================
   Create and move
   ========================================================================= */

export interface SessionInput {
  branchId: string;
  classTypeId: string;
  roomId: string | null;
  trainerId: string | null;
  startsAt: number;
  durationMin?: number;
  capacity: number;
  creditsRequired: number;
  dropInPriceMinor: number | null;
  lateCancelFeeMinor: number;
  waitlistEnabled: boolean;
  bookingOpensAt: number | null;
  cancelDeadlineAt: number | null;
  notes: string | null;
}

function assertResources(
  tenantId: string,
  input: { branchId: string; classTypeId: string; roomId: string | null; trainerId: string | null; capacity: number },
) {
  const classType = db
    .select()
    .from(schema.classTypes)
    .where(and(eq(schema.classTypes.id, input.classTypeId), eq(schema.classTypes.tenantId, tenantId)))
    .get();
  if (!classType) throw invalid('That class type does not exist.');

  if (input.roomId) {
    const room = db
      .select()
      .from(schema.rooms)
      .where(and(eq(schema.rooms.id, input.roomId), eq(schema.rooms.tenantId, tenantId)))
      .get();
    if (!room) throw invalid('That room does not exist.');
    if (room.branchId !== input.branchId) throw invalid('That room belongs to another branch.');
    if (input.capacity > room.capacity) {
      throw invalid(`This room seats ${room.capacity}. Reduce the class capacity or choose a bigger room.`);
    }
  }

  if (input.trainerId) {
    const trainer = db
      .select({ branchIds: schema.staff.branchIds })
      .from(schema.staff)
      .where(and(eq(schema.staff.id, input.trainerId), eq(schema.staff.tenantId, tenantId)))
      .get();
    if (!trainer) throw invalid('That trainer does not exist.');
    if (!trainer.branchIds.includes(input.branchId)) throw invalid('That trainer is not assigned to this branch.');
  }

  return classType;
}

export function createSession(ctx: RequestContext, input: SessionInput) {
  const atMs = now();
  const classType = assertResources(ctx.tenantId, input);

  const endsAt = input.startsAt + (input.durationMin ?? classType.durationMin) * MINUTE;
  if (endsAt <= input.startsAt) throw invalid('A class must end after it starts.');
  if (input.capacity < 1) throw invalid('A class needs at least one seat.');
  if (input.startsAt <= atMs) throw invalid('A class must start in the future.');
  if (input.bookingOpensAt !== null && input.bookingOpensAt >= input.startsAt) {
    throw invalid('Booking must open before the class starts.');
  }
  if (input.cancelDeadlineAt !== null && input.cancelDeadlineAt >= input.startsAt) {
    throw invalid('The cancellation deadline must be before the class starts.');
  }

  const clashes = detectClashes(ctx.tenantId, {
    branchId: input.branchId,
    roomId: input.roomId,
    trainerId: input.trainerId,
    startsAt: input.startsAt,
    endsAt,
  });
  if (clashes.length > 0) {
    throw conflict(
      clashes[0]!.kind === 'room'
        ? `That room is already taken by ${clashes[0]!.name} at this time.`
        : `That trainer is already teaching ${clashes[0]!.name} at this time.`,
    );
  }

  const sessionId = id('ses');

  transact(() => {
    db.insert(schema.classSessions)
      .values({
        id: sessionId,
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        classTypeId: input.classTypeId,
        roomId: input.roomId,
        trainerId: input.trainerId,
        seriesId: null,
        startsAt: input.startsAt,
        endsAt,
        capacity: input.capacity,
        booked: 0,
        state: 'scheduled',
        bookingOpensAt: input.bookingOpensAt,
        cancelDeadlineAt: input.cancelDeadlineAt,
        creditsRequired: input.creditsRequired,
        dropInPriceMinor: input.dropInPriceMinor,
        lateCancelFeeMinor: input.lateCancelFeeMinor,
        waitlistEnabled: input.waitlistEnabled,
        cancelledReason: null,
        substituteFor: null,
        notes: input.notes,
        version: 1,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();

    audit(ctx, {
      action: 'session.created',
      entityType: 'class_session',
      entityId: sessionId,
      entityLabel: classType.name,
      branchId: input.branchId,
      after: { startsAt: new Date(input.startsAt).toISOString(), capacity: input.capacity },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      channel: channels.branch(input.branchId),
      topic: 'session.updated',
      payload: { sessionId, created: true },
    });
  });

  return db.select().from(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).get()!;
}

export interface SessionPatch {
  startsAt?: number;
  durationMin?: number;
  roomId?: string | null;
  trainerId?: string | null;
  capacity?: number;
  notes?: string | null;
  waitlistEnabled?: boolean;
  /** Optimistic concurrency: two managers editing the same class must not
   *  silently overwrite each other (UX-A09 conflict handling). */
  version?: number;
}

export function updateSession(ctx: RequestContext, sessionId: string, patch: SessionPatch) {
  const atMs = now();
  const session = loadSessionInScope(ctx, sessionId);
  if (session.state === 'cancelled') throw precondition('That class was cancelled and cannot be edited.');
  // Concurrency protection cannot be optional: every edit must carry the
  // version it read, or a manager looking at a stale screen could overwrite
  // someone else's change without either of them ever seeing STALE_VERSION.
  if (patch.version === undefined) throw invalid('The current version is required to edit a class.');
  if (patch.version !== session.version) throw staleVersion();

  const startsAt = patch.startsAt ?? session.startsAt;
  const endsAt = patch.durationMin !== undefined ? startsAt + patch.durationMin * MINUTE : startsAt + (session.endsAt - session.startsAt);
  const roomId = patch.roomId !== undefined ? patch.roomId : session.roomId;
  const trainerId = patch.trainerId !== undefined ? patch.trainerId : session.trainerId;
  const capacity = patch.capacity ?? session.capacity;

  assertResources(ctx.tenantId, {
    branchId: session.branchId,
    classTypeId: session.classTypeId,
    roomId,
    trainerId,
    capacity,
  });

  // Shrinking a class below the people already in it would silently strand
  // someone with a seat that no longer exists (Compliance PRD edge case
  // "Class capacity is reduced below current bookings").
  const live = liveBookingCount(session.id);
  if (capacity < live) {
    throw conflict(
      `${live} ${live === 1 ? 'person is' : 'people are'} already booked. Move them first, or keep at least ${live} ${live === 1 ? 'seat' : 'seats'}.`,
    );
  }

  const clashes = detectClashes(ctx.tenantId, {
    branchId: session.branchId,
    roomId,
    trainerId,
    startsAt,
    endsAt,
    excludeSessionId: session.id,
  });
  if (clashes.length > 0) {
    throw conflict(
      clashes[0]!.kind === 'room'
        ? `That room is already taken by ${clashes[0]!.name} at this time.`
        : `That trainer is already teaching ${clashes[0]!.name} at this time.`,
    );
  }

  const moved = startsAt !== session.startsAt || endsAt !== session.endsAt;
  const roomChanged = roomId !== session.roomId;

  const tz = branchTimeZone(ctx.tenantId, session.branchId);

  transact(() => {
    db.update(schema.classSessions)
      .set({
        startsAt,
        endsAt,
        roomId,
        trainerId,
        capacity,
        notes: patch.notes !== undefined ? patch.notes : session.notes,
        waitlistEnabled: patch.waitlistEnabled ?? session.waitlistEnabled,
        updatedAt: atMs,
        version: sql`${schema.classSessions.version} + 1`,
      })
      .where(eq(schema.classSessions.id, session.id))
      .run();

    audit(ctx, {
      action: 'session.updated',
      entityType: 'class_session',
      entityId: session.id,
      branchId: session.branchId,
      before: {
        startsAt: new Date(session.startsAt).toISOString(),
        roomId: session.roomId,
        trainerId: session.trainerId,
        capacity: session.capacity,
      },
      after: {
        startsAt: new Date(startsAt).toISOString(),
        roomId,
        trainerId,
        capacity,
      },
    });

    if (moved || roomChanged) {
      notifyBookedMembers(
        ctx,
        session,
        {
          kind: 'session_changed',
          title: 'Your class has changed',
          body: moved
            ? `It now starts at ${localTime(startsAt, tz)}. Your seat has moved with it.`
            : 'It has moved to a different room. Your seat has moved with it.',
          templateCode: 'session.changed',
        },
        atMs,
      );
    }

    emit({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'session.updated',
      payload: { sessionId: session.id, moved, roomChanged },
    });
  });

  return db.select().from(schema.classSessions).where(eq(schema.classSessions.id, session.id)).get()!;
}

/* ============================================================================
   Substitution — PF-SCH-004. The original trainer is retained so the roster
   still says who was meant to teach.
   ========================================================================= */

export function substituteTrainer(ctx: RequestContext, sessionId: string, trainerId: string) {
  const atMs = now();
  const session = loadSessionInScope(ctx, sessionId);
  if (session.state === 'cancelled') throw precondition('That class was cancelled.');
  if (session.trainerId === trainerId) throw precondition('That trainer is already teaching this class.');

  assertResources(ctx.tenantId, {
    branchId: session.branchId,
    classTypeId: session.classTypeId,
    roomId: session.roomId,
    trainerId,
    capacity: session.capacity,
  });

  const clashes = detectClashes(ctx.tenantId, {
    branchId: session.branchId,
    roomId: null,
    trainerId,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    excludeSessionId: session.id,
  });
  if (clashes.length > 0) throw conflict(`That trainer is already teaching ${clashes[0]!.name} at this time.`);

  const replacement = db
    .select({ name: schema.users.name })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(eq(schema.staff.id, trainerId))
    .get();

  transact(() => {
    db.update(schema.classSessions)
      .set({
        trainerId,
        // Only the first substitution records who was originally scheduled.
        substituteFor: session.substituteFor ?? session.trainerId,
        updatedAt: atMs,
        version: sql`${schema.classSessions.version} + 1`,
      })
      .where(eq(schema.classSessions.id, session.id))
      .run();

    audit(ctx, {
      action: 'session.substituted',
      entityType: 'class_session',
      entityId: session.id,
      branchId: session.branchId,
      before: { trainerId: session.trainerId },
      after: { trainerId },
    });

    notifyBookedMembers(
      ctx,
      session,
      {
        kind: 'session_changed',
        title: 'A different coach is taking your class',
        body: `${replacement?.name ?? 'Another coach'} is covering. Everything else is the same.`,
        templateCode: 'session.substituted',
      },
      atMs,
    );

    emit({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'session.updated',
      payload: { sessionId: session.id, substituted: true, trainerId },
    });
  });

  return db.select().from(schema.classSessions).where(eq(schema.classSessions.id, session.id)).get()!;
}

/* ============================================================================
   Cancellation
   ========================================================================= */

export interface CancelResult {
  cancelled: string[];
  bookingsReleased: number;
  creditsReturned: number;
  notified: number;
}

/**
 * Cancelling a class is the gym's decision, not the member's, so everyone in it
 * is made whole regardless of the cancellation deadline: seats released, credits
 * returned, waitlist closed, and every affected member told. The late-cancel
 * policy deliberately does not apply here.
 */
export function cancelSessions(
  ctx: RequestContext,
  input: { sessionId: string; reason: string; scope: 'occurrence' | 'series' },
): CancelResult {
  const atMs = now();
  const reason = input.reason.trim();
  if (reason.length < 4) throw invalid('Cancelling a class needs a reason of at least 4 characters.');

  const anchor = loadSessionInScope(ctx, input.sessionId);
  if (anchor.state === 'cancelled') throw precondition('That class is already cancelled.');

  // `class_sessions.seriesId` carries a stable series key but there is no series
  // table, so "the rest of the series" means the future occurrences sharing that
  // key. Past occurrences are history and are left alone.
  const targets =
    input.scope === 'series' && anchor.seriesId
      ? db
          .select()
          .from(schema.classSessions)
          .where(
            and(
              eq(schema.classSessions.tenantId, ctx.tenantId),
              eq(schema.classSessions.seriesId, anchor.seriesId),
              ne(schema.classSessions.state, 'cancelled'),
              gt(schema.classSessions.startsAt, atMs),
            ),
          )
          .all()
          .filter((row) => ctx.branchIds.includes(row.branchId))
      : [anchor];

  const result: CancelResult = { cancelled: [], bookingsReleased: 0, creditsReturned: 0, notified: 0 };

  transact(() => {
    for (const session of targets) {
      const bookings = db
        .select()
        .from(schema.bookings)
        .where(
          and(eq(schema.bookings.sessionId, session.id), inArray(schema.bookings.state, [...LIVE_BOOKING_STATES])),
        )
        .all();

      result.notified += notifyBookedMembers(
        ctx,
        session,
        {
          kind: 'session_cancelled',
          title: 'Your class was cancelled',
          body: `${reason} Any class credit you used has been returned.`,
          templateCode: 'session.cancelled',
        },
        atMs,
      );

      for (const booking of bookings) {
        db.update(schema.bookings)
          .set({ state: 'cancelled', cancelledAt: atMs })
          .where(eq(schema.bookings.id, booking.id))
          .run();
        result.bookingsReleased += 1;

        if (booking.creditsUsed > 0) {
          db.insert(schema.credits)
            .values({
              id: id('crd'),
              tenantId: ctx.tenantId,
              memberId: booking.memberId,
              kind: 'class',
              delta: booking.creditsUsed,
              reason: 'Class cancelled by the gym',
              refType: 'booking',
              refId: booking.id,
              expiresOn: null,
              createdAt: atMs,
            })
            .run();
          result.creditsReturned += booking.creditsUsed;
        }
      }

      // Nobody is waiting for a class that is not running.
      db.update(schema.waitlistEntries)
        .set({ state: 'expired', resolvedAt: atMs })
        .where(
          and(
            eq(schema.waitlistEntries.sessionId, session.id),
            inArray(schema.waitlistEntries.state, [...LIVE_WAITLIST_STATES]),
          ),
        )
        .run();

      db.update(schema.classSessions)
        .set({
          state: 'cancelled',
          cancelledReason: reason,
          booked: 0,
          updatedAt: atMs,
          version: sql`${schema.classSessions.version} + 1`,
        })
        .where(eq(schema.classSessions.id, session.id))
        .run();

      audit(ctx, {
        action: 'session.cancelled',
        entityType: 'class_session',
        entityId: session.id,
        reason,
        branchId: session.branchId,
        before: { state: session.state, booked: session.booked },
        after: { state: 'cancelled', bookingsReleased: bookings.length },
      });

      emit({
        tenantId: ctx.tenantId,
        branchId: session.branchId,
        channel: channels.branch(session.branchId),
        topic: 'session.cancelled',
        payload: { sessionId: session.id, reason, released: bookings.length },
      });

      result.cancelled.push(session.id);
    }
  });

  return result;
}

/* ============================================================================
   Roster — staff booking, releasing a seat, and marking attendance.
   ========================================================================= */

/**
 * Staff booking a member on from the desk. A thin adapter over the canonical
 * `claimSeat` — the exact same eligibility checks, credit spend and drop-in
 * charge accounting as the member's own booking, so this can never again be a
 * back door to a free, unentitled seat.
 */
export function bookMemberOntoSession(
  ctx: RequestContext,
  input: { sessionId: string; memberId: string; idempotencyKey: string; acceptDropInCharge: boolean },
) {
  const atMs = now();
  const member = loadMemberInScope(ctx, input.memberId);
  const session = sessionById(ctx.tenantId, input.sessionId);
  if (!session || !ctx.branchIds.includes(session.branchId)) throw notFound('That class');

  const tz = branchTimeZone(ctx.tenantId, session.branchId);
  const today = isoDate(atMs, tz);

  return runClaim(() =>
    claimSeat(ctx, {
      session,
      memberId: member.id,
      idempotencyKey: input.idempotencyKey,
      acceptDropInCharge: input.acceptDropInCharge,
      bookedByStaff: true,
      today,
      atMs,
    }),
  );
}

/**
 * A deliberate eligibility bypass — comping a seat regardless of membership,
 * credits, booking window or conflicts. Gated at the route layer by requiring
 * BOTH `booking.manage_others` and `schedule.manage` together (no new
 * permission constant: `packages/domain` is DO-NOT-EDIT foundation), so
 * ordinary staff booking never silently becomes an override.
 */
export function bookMemberOntoSessionOverride(
  ctx: RequestContext,
  input: { sessionId: string; memberId: string; idempotencyKey: string; reason: string },
) {
  const atMs = now();
  const member = loadMemberInScope(ctx, input.memberId);
  const session = sessionById(ctx.tenantId, input.sessionId);
  if (!session || !ctx.branchIds.includes(session.branchId)) throw notFound('That class');

  return runClaim(() =>
    claimSeatOverride(ctx, {
      session,
      memberId: member.id,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      atMs,
    }),
  );
}

export function releaseBooking(ctx: RequestContext, bookingId: string, reason: string | null) {
  const atMs = now();
  const { booking, session } = loadBookingInScope(ctx, bookingId);
  if (!LIVE_BOOKING_STATES.includes(booking.state as 'confirmed')) {
    throw precondition('That booking is already closed.');
  }

  // Staff releasing a seat uses the same deadline policy as the member, so a
  // desk cancellation is not a way to dodge a late-cancellation charge.
  const outcome = classifyCancellation(
    new Date(atMs),
    session.cancelDeadlineAt === null ? null : new Date(session.cancelDeadlineAt),
  );

  const promoted = transact(() => {
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

    if (outcome.refundCredit && booking.creditsUsed > 0) {
      db.insert(schema.credits)
        .values({
          id: id('crd'),
          tenantId: ctx.tenantId,
          memberId: booking.memberId,
          kind: 'class',
          delta: booking.creditsUsed,
          reason: 'Booking cancelled at the desk',
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
      reason,
      branchId: session.branchId,
      before: { state: booking.state },
      after: { state: outcome.state, byStaff: true },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'booking.cancelled',
      payload: { bookingId: booking.id, sessionId: session.id, memberId: booking.memberId, state: outcome.state },
    });

    return promoteFromWaitlist(ctx, session, atMs);
  });

  return { state: outcome.state, creditsReturned: outcome.refundCredit ? booking.creditsUsed : 0, promoted };
}

/**
 * Waitlist promotion. Re-checks eligibility from scratch, so someone whose
 * membership lapsed while they waited is skipped rather than promoted into a
 * booking that cannot work (PF-SCH-002).
 *
 * The offer is announced on the branch channel as well as the member's own.
 * The scheduler publishes `waitlist.promoted` to `channels.session(...)`, which
 * no client is authorised to subscribe to, so a console listening for seat
 * movement would never hear it.
 */
export function promoteFromWaitlist(
  ctx: RequestContext,
  session: { id: string; branchId: string; creditsRequired: number },
  atMs: number,
): { memberId: string; offerExpiresAt: string } | null {
  const queue = db
    .select()
    .from(schema.waitlistEntries)
    .where(and(eq(schema.waitlistEntries.sessionId, session.id), eq(schema.waitlistEntries.state, 'waiting')))
    .orderBy(asc(schema.waitlistEntries.position))
    .all();
  if (queue.length === 0) return null;

  const candidates: WaitlistCandidate[] = queue.map((entry) => {
    const membership = db
      .select({ state: schema.memberships.state })
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.memberId, entry.memberId), sql`${schema.memberships.state} in ('active','grace')`),
      )
      .get();

    return {
      id: entry.id,
      memberId: entry.memberId,
      position: entry.position,
      eligible: Boolean(membership),
      skipReason: membership ? null : 'Membership no longer covers bookings',
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

  const member = db
    .select({ userId: schema.members.userId })
    .from(schema.members)
    .where(eq(schema.members.id, plan.offer.memberId))
    .get();

  if (member?.userId) {
    db.insert(schema.notifications)
      .values({
        id: id('ntf'),
        tenantId: ctx.tenantId,
        userId: member.userId,
        channel: 'in_app',
        kind: 'waitlist_offer',
        title: 'A seat opened up',
        body: `The seat is held for you for ${plan.offerWindowMin} minutes, then it goes to the next person.`,
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
    payload: { sessionId: session.id, offerExpiresAt: new Date(offerExpiresAt).toISOString() },
  });

  emit({
    tenantId: ctx.tenantId,
    branchId: session.branchId,
    channel: channels.branch(session.branchId),
    topic: 'waitlist.promoted',
    payload: { sessionId: session.id, memberId: plan.offer.memberId },
  });

  return { memberId: plan.offer.memberId, offerExpiresAt: new Date(offerExpiresAt).toISOString() };
}

/**
 * Class attendance (PF-ATT "class attendance"). `bookings.attendedAt` exists and
 * nothing wrote it until now. Marking is reversible, because a roster is
 * corrected constantly while a class is running.
 */
export function markAttendance(
  ctx: RequestContext,
  bookingId: string,
  state: 'attended' | 'no_show' | 'confirmed',
) {
  const atMs = now();
  const { booking, session } = loadBookingInScope(ctx, bookingId);

  if (booking.state === 'cancelled' || booking.state === 'late_cancelled') {
    throw precondition('That booking was cancelled, so there is nobody to mark.');
  }
  if (session.startsAt > atMs && (state === 'no_show' || state === 'attended')) {
    throw precondition('That class has not started yet.');
  }

  transact(() => {
    db.update(schema.bookings)
      .set({ state, attendedAt: state === 'attended' ? atMs : null })
      .where(eq(schema.bookings.id, booking.id))
      .run();

    audit(ctx, {
      action: 'booking.attendance_marked',
      entityType: 'booking',
      entityId: booking.id,
      branchId: session.branchId,
      before: { state: booking.state },
      after: { state },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      channel: channels.branch(session.branchId),
      topic: 'session.updated',
      payload: { sessionId: session.id, bookingId: booking.id, attendance: state },
    });
  });

  return db.select().from(schema.bookings).where(eq(schema.bookings.id, booking.id)).get()!;
}
