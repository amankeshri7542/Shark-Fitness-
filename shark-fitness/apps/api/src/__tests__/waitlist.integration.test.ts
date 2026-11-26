import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { db, schema, sqlite } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { expireWaitlistOffers } from '../services/waitlist.js';
import {
  TENANT,
  createClassSession,
  createMember,
  get,
  post,
  send,
  signIn,
  signInMember,
  type FixtureMember,
  type Session,
} from './support/fixtures.js';

/**
 * The waitlist (P05; PF-SCH-002/003; PRD 01 scenario 3; PRD 02 §14.2;
 * decision 12). The seat-hold arithmetic is checked three ways in every test
 * that moves seats: the denormalised `booked` counter, the rows themselves,
 * and the database triggers that refuse to let the two disagree with capacity.
 */

const LIVE = ['held', 'confirmed', 'attended'];
const startedAt = now();
let owner: Session;

beforeAll(async () => {
  db.update(schema.branches).set({ state: 'active' }).run();
  owner = await signIn('owner@sharkfitness.in');
});

function sessionRow(sessionId: string) {
  return db.select().from(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).get()!;
}

function liveBookings(sessionId: string) {
  return db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.sessionId, sessionId), inArray(schema.bookings.state, LIVE)))
    .all();
}

function entries(sessionId: string) {
  return db.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.sessionId, sessionId)).all();
}

function entryOf(sessionId: string, memberId: string) {
  return entries(sessionId).find((row) => row.memberId === memberId);
}

/** Confirmed plus held never exceeds capacity, and `booked` says the same. */
function expectSeatsConsistent(sessionId: string): void {
  const row = sessionRow(sessionId);
  const offered = entries(sessionId).filter((e) => e.state === 'offered').length;
  const live = liveBookings(sessionId).length;
  expect(row.booked).toBe(live + offered);
  expect(live + offered).toBeLessThanOrEqual(Math.max(row.capacity, live));
}

async function members(n: number, label: string): Promise<Array<FixtureMember & { session: Session }>> {
  const out: Array<FixtureMember & { session: Session }> = [];
  for (let i = 0; i < n; i += 1) {
    const member = createMember({ withLogin: true, firstName: `${label}${i}` });
    out.push({ ...member, session: await signInMember(member) });
  }
  return out;
}

const book = (session: Session, sessionId: string, key = `bk-${id('k')}`) =>
  post(session, '/v1/member/schedule/book', { sessionId, idempotencyKey: key });

const join = (session: Session, sessionId: string) => post(session, '/v1/member/schedule/waitlist', { sessionId });

const accept = (session: Session, entryId: string, key = `acc-${id('k')}`) =>
  post(session, `/v1/member/schedule/waitlist/${entryId}/accept`, { idempotencyKey: key });

async function bookingIdOf(session: Session, sessionId: string): Promise<string> {
  const response = await book(session, sessionId);
  expect(response.status).toBe(200);
  return ((await response.json()) as { booking: { id: string } }).booking.id;
}

describe('last seat under contention (PRD 01 scenario 3)', () => {
  it('20 members racing for one seat: exactly one CONFIRMED, nineteen WAITING in a stable order', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const crowd = await members(20, 'Race');

    // What a member's phone does: try to book; if the class is full, join the line.
    const results = await Promise.all(
      crowd.map(async (member) => {
        const booked = await book(member.session, sessionId);
        if (booked.status === 200) return 'confirmed' as const;
        expect(booked.status).toBe(409);
        const refusal = (await booked.json()) as { error: { code: string; message: string } };
        expect(refusal.error, refusal.error.message).toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
        const joined = await join(member.session, sessionId);
        expect(joined.status).toBe(200);
        return 'waiting' as const;
      }),
    );

    expect(results.filter((r) => r === 'confirmed')).toHaveLength(1);
    expect(results.filter((r) => r === 'waiting')).toHaveLength(19);
    expect(liveBookings(sessionId)).toHaveLength(1);
    expect(sessionRow(sessionId).booked).toBe(1);

    const queue = entries(sessionId).filter((e) => e.state === 'waiting');
    expect(queue).toHaveLength(19);
    // Distinct positions: the order is total and auditable.
    expect(new Set(queue.map((e) => e.position)).size).toBe(19);
    const joins = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'waitlist.joined'), gte(schema.auditLog.at, startedAt)))
      .all()
      .filter((row) => queue.some((e) => e.id === row.entityId));
    expect(joins).toHaveLength(19);
  });

  it('the member sees their place in line, and joining twice is still one place', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const [first, second] = await members(2, 'Place');
    await bookingIdOf(first!.session, sessionId);

    const joined = await join(second!.session, sessionId);
    const body = (await joined.json()) as { waitlist: { position: number; state: string }; message: string };
    expect(body.waitlist).toMatchObject({ position: 1, state: 'waiting' });
    expect(body.message).toContain('number 1 in line');
    expect((await join(second!.session, sessionId)).status).toBe(200);
    expect(entries(sessionId)).toHaveLength(1);

    const list = await get(second!.session, `/v1/member/schedule?date=${new Date(sessionRow(sessionId).startsAt).toISOString().slice(0, 10)}`);
    const day = (await list.json()) as { items: Array<{ id: string; myWaitlist: { position: number } | null }>; waitlist: { available: boolean } };
    expect(day.waitlist.available).toBe(true);
  });

  it('refuses to join a class that still has seats', async () => {
    const sessionId = createClassSession({ capacity: 2 });
    const [member] = await members(1, 'Early');
    const response = await join(member!.session, sessionId);
    expect(response.status).toBe(412);
  });
});

describe('offers hold the seat', () => {
  it('a cancellation offers the seat to the first in line and holds it against everyone else', async () => {
    const sessionId = createClassSession({ capacity: 2 });
    const [a, b, w1, w2, outsider] = await members(5, 'Hold');
    const bookingA = await bookingIdOf(a!.session, sessionId);
    await bookingIdOf(b!.session, sessionId);
    await join(w1!.session, sessionId);
    await join(w2!.session, sessionId);

    const cancelled = await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);
    expect(cancelled.status).toBe(200);
    const body = (await cancelled.json()) as { promoted: { memberId: string; offerExpiresAt: string } | null };
    expect(body.promoted?.memberId).toBe(w1!.memberId);

    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('offered');
    expect(entryOf(sessionId, w2!.memberId)?.state).toBe('waiting');
    expect(sessionRow(sessionId).booked).toBe(2);
    expectSeatsConsistent(sessionId);

    // Nobody else can take the held seat: not a member, not the desk.
    const sneak = await book(outsider!.session, sessionId);
    expect(sneak.status).toBe(409);
    const desk = await post(owner, `/v1/admin/schedule/session/${sessionId}/book`, { memberId: outsider!.memberId, idempotencyKey: `desk-${id('k')}` });
    expect(desk.status).toBe(409);
    const comp = await post(owner, `/v1/admin/schedule/session/${sessionId}/book-override`, {
      memberId: outsider!.memberId,
      idempotencyKey: `comp-${id('k')}`,
      reason: 'Trying to comp a held seat',
    });
    expect(comp.status).toBe(409);
    expectSeatsConsistent(sessionId);

    // The offer is in the member's notifications and on their schedule.
    const note = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, w1!.userId!), eq(schema.notifications.kind, 'waitlist_offer')))
      .get();
    expect(note?.body).toContain('held for you');

    // Accepting converts the hold; `booked` does not move.
    const entryId = entryOf(sessionId, w1!.memberId)!.id;
    const taken = await accept(w1!.session, entryId);
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { booking: { cameFromWaitlist: boolean } }).booking.cameFromWaitlist).toBe(true);
    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('confirmed');
    expect(liveBookings(sessionId)).toHaveLength(2);
    expect(sessionRow(sessionId).booked).toBe(2);
    expectSeatsConsistent(sessionId);

    // Accepting again replays the same booking.
    const again = await accept(w1!.session, entryId);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(liveBookings(sessionId)).toHaveLength(2);
  });

  it('the database refuses a booking row or an offer beyond capacity even if the service is bypassed', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const [a, w1, w2] = await members(3, 'Guard');
    await bookingIdOf(a!.session, sessionId);
    await join(w1!.session, sessionId);
    await join(w2!.session, sessionId);

    expect(() =>
      db.insert(schema.bookings)
        .values({
          id: id('bkg'),
          tenantId: TENANT,
          sessionId,
          memberId: w2!.memberId,
          state: 'confirmed',
          seatNo: 2,
          bookedAt: now(),
          cancelledAt: null,
          heldUntil: null,
          creditsUsed: 0,
          chargeMinor: 0,
          cameFromWaitlist: false,
          idempotencyKey: `raw-${id('k')}`,
          attendedAt: null,
        })
        .run(),
    ).toThrow(/CAPACITY_EXHAUSTED/);

    const entry = entryOf(sessionId, w1!.memberId)!;
    expect(() =>
      db.update(schema.waitlistEntries).set({ state: 'offered', offerExpiresAt: now() + 60_000 }).where(eq(schema.waitlistEntries.id, entry.id)).run(),
    ).toThrow(/CAPACITY_EXHAUSTED/);

    expect(() => sqlite.prepare('update class_sessions set booked = booked + 1 where id = ?').run(sessionId)).toThrow(/CAPACITY_EXHAUSTED/);
    expectSeatsConsistent(sessionId);
  });

  it('declining passes the seat straight to the next member', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const [a, w1, w2] = await members(3, 'Decline');
    const bookingA = await bookingIdOf(a!.session, sessionId);
    await join(w1!.session, sessionId);
    await join(w2!.session, sessionId);
    await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);

    const offered = entryOf(sessionId, w1!.memberId)!;
    expect(offered.state).toBe('offered');
    const declined = await send(w1!.session, 'DELETE', `/v1/member/schedule/waitlist/${offered.id}`);
    expect(declined.status).toBe(200);
    expect(((await declined.json()) as { message: string }).message).toContain('next person');

    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('declined');
    expect(entryOf(sessionId, w2!.memberId)?.state).toBe('offered');
    expect(sessionRow(sessionId).booked).toBe(1);
    expectSeatsConsistent(sessionId);
  });

  it('a lapsed offer passes on when the scheduler runs, and accepting it afterwards is refused plainly', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const [a, w1, w2] = await members(3, 'Lapse');
    const bookingA = await bookingIdOf(a!.session, sessionId);
    await join(w1!.session, sessionId);
    await join(w2!.session, sessionId);
    await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);
    const offered = entryOf(sessionId, w1!.memberId)!;

    const summary = expireWaitlistOffers(offered.offerExpiresAt! + 1);
    expect(summary.offersExpired).toBeGreaterThanOrEqual(1);
    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('expired');
    expect(entryOf(sessionId, w2!.memberId)?.state).toBe('offered');
    expectSeatsConsistent(sessionId);

    const late = await accept(w1!.session, offered.id);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { message: string } }).error.message).toContain('Nothing was charged');
    expect(liveBookings(sessionId)).toHaveLength(0);
  });

  it('an accept that arrives after the deadline but before the job expires it there and then', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const [a, w1, w2] = await members(3, 'Deadline');
    const bookingA = await bookingIdOf(a!.session, sessionId);
    await join(w1!.session, sessionId);
    await join(w2!.session, sessionId);
    await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);
    const offered = entryOf(sessionId, w1!.memberId)!;
    db.update(schema.waitlistEntries).set({ offerExpiresAt: now() - 1 }).where(eq(schema.waitlistEntries.id, offered.id)).run();

    const late = await accept(w1!.session, offered.id);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { details?: { reason: string } } }).error.details?.reason).toBe('offer_expired');
    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('expired');
    expect(entryOf(sessionId, w2!.memberId)?.state).toBe('offered');
    expectSeatsConsistent(sessionId);
  });

  it('booking another open seat with a lapsed, unprocessed offer does not strand the held seat', async () => {
    const sessionId = createClassSession({ capacity: 2 });
    const [a, b, w1] = await members(3, 'Stale');
    const bookingA = await bookingIdOf(a!.session, sessionId);
    const bookingB = await bookingIdOf(b!.session, sessionId);
    await join(w1!.session, sessionId);
    await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);
    const offered = entryOf(sessionId, w1!.memberId)!;
    expect(offered.state).toBe('offered');

    // The offer runs out, the job has not run yet, and a second seat opens
    // with nobody else in line to offer it to.
    db.update(schema.waitlistEntries).set({ offerExpiresAt: now() - 1 }).where(eq(schema.waitlistEntries.id, offered.id)).run();
    await send(b!.session, 'DELETE', `/v1/member/schedule/booking/${bookingB}`);
    expectSeatsConsistent(sessionId);

    // The member books the open seat directly.
    expect((await book(w1!.session, sessionId)).status).toBe(200);
    expectSeatsConsistent(sessionId);

    // Once the job runs, the counter and the rows still agree.
    expireWaitlistOffers(now() + 1);
    expectSeatsConsistent(sessionId);
    expect(liveBookings(sessionId).filter((row) => row.memberId === w1!.memberId)).toHaveLength(1);
  });

  it('accept racing expiry produces exactly one outcome, every time', async () => {
    for (let round = 0; round < 8; round += 1) {
      const sessionId = createClassSession({ capacity: 1 });
      const [a, w1, w2] = await members(3, `Race${round}x`);
      const bookingA = await bookingIdOf(a!.session, sessionId);
      await join(w1!.session, sessionId);
      await join(w2!.session, sessionId);
      await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);
      const offered = entryOf(sessionId, w1!.memberId)!;

      // The deadline lands a few milliseconds from now, so which side wins
      // varies by round. Whichever does, there is one outcome.
      const deadline = now() + (round % 4) * 3;
      db.update(schema.waitlistEntries).set({ offerExpiresAt: deadline }).where(eq(schema.waitlistEntries.id, offered.id)).run();
      const [acceptResponse] = await Promise.all([
        accept(w1!.session, offered.id),
        new Promise<void>((resolve) => setTimeout(() => {
          expireWaitlistOffers(deadline + 1);
          resolve();
        }, round % 3)),
      ]);

      const state = entryOf(sessionId, w1!.memberId)!.state;
      const mine = liveBookings(sessionId).filter((b) => b.memberId === w1!.memberId);
      if (acceptResponse.status === 200) {
        expect(state).toBe('confirmed');
        expect(mine).toHaveLength(1);
        expect(entryOf(sessionId, w2!.memberId)?.state).toBe('waiting');
      } else {
        expect(acceptResponse.status).toBe(409);
        expect(state).toBe('expired');
        expect(mine).toHaveLength(0);
        expect(entryOf(sessionId, w2!.memberId)?.state).toBe('offered');
      }
      expectSeatsConsistent(sessionId);
      expect(sessionRow(sessionId).booked).toBe(1);
    }
  });
});

describe('promotion re-checks eligibility', () => {
  it('skips a member whose membership ended while they waited, and offers the next one', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const [a, lapsed, next] = await members(3, 'Skip');
    const bookingA = await bookingIdOf(a!.session, sessionId);
    await join(lapsed!.session, sessionId);
    await join(next!.session, sessionId);

    db.update(schema.memberships)
      .set({ state: 'expired', endsOn: '2026-01-31' })
      .where(eq(schema.memberships.id, lapsed!.membershipId!))
      .run();

    await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);
    expect(entryOf(sessionId, lapsed!.memberId)?.state).toBe('skipped');
    expect(entryOf(sessionId, next!.memberId)?.state).toBe('offered');
    const skipped = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'waitlist.skipped'), eq(schema.auditLog.entityId, entryOf(sessionId, lapsed!.memberId)!.id)))
      .get();
    expect(skipped?.reason).toBeTruthy();
    expectSeatsConsistent(sessionId);
  });

  it('accepting re-checks credits: no credits, no seat, and the offer stands', async () => {
    const sessionId = createClassSession({ capacity: 1, creditsRequired: 1 });
    const [a, w1] = await members(2, 'Credit');
    for (const m of [a!, w1!]) {
      db.insert(schema.credits)
        .values({ id: id('crd'), tenantId: TENANT, memberId: m.memberId, kind: 'class', delta: 1, reason: 'Test grant', refType: 'test', refId: null, expiresOn: null, createdAt: now() })
        .run();
    }
    const bookingA = await bookingIdOf(a!.session, sessionId);
    await join(w1!.session, sessionId);
    await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);
    const offered = entryOf(sessionId, w1!.memberId)!;
    expect(offered.state).toBe('offered');

    // The credit is spent elsewhere before they accept.
    db.insert(schema.credits)
      .values({ id: id('crd'), tenantId: TENANT, memberId: w1!.memberId, kind: 'class', delta: -1, reason: 'Spent elsewhere', refType: 'test', refId: null, expiresOn: null, createdAt: now() })
      .run();

    const refused = await accept(w1!.session, offered.id);
    expect(refused.status).toBe(402);
    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('offered');
    expect(liveBookings(sessionId)).toHaveLength(0);
    expectSeatsConsistent(sessionId);
  });

  it('makes no offer inside the cut-off before class; the seat is simply open', async () => {
    const sessionId = createClassSession({ capacity: 1, startsInMs: 45 * 60_000, cancelDeadlineBeforeMs: 0 });
    const [a, w1, walkIn] = await members(3, 'Cutoff');
    const bookingA = await bookingIdOf(a!.session, sessionId);
    await join(w1!.session, sessionId);
    await send(a!.session, 'DELETE', `/v1/member/schedule/booking/${bookingA}`);

    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('waiting');
    expect(sessionRow(sessionId).booked).toBe(0);
    expect((await book(walkIn!.session, sessionId)).status).toBe(200);
  });
});

describe('capacity changes from the console', () => {
  async function patchCapacity(sessionId: string, capacity: number) {
    const response = await send(owner, 'PATCH', `/v1/admin/schedule/session/${sessionId}`, { capacity, version: sessionRow(sessionId).version });
    return { status: response.status, body: (await response.json()) as { capacity: { overbookedBy: number; withdrawnOffers: number; offersMade: number; message: string | null } } };
  }

  it('reducing capacity below bookings cancels nobody and raises a staff alert', async () => {
    const sessionId = createClassSession({ capacity: 3 });
    const crowd = await members(3, 'Shrink');
    for (const m of crowd) await bookingIdOf(m.session, sessionId);

    const { status, body } = await patchCapacity(sessionId, 1);
    expect(status).toBe(200);
    expect(body.capacity.overbookedBy).toBe(2);
    expect(body.capacity.message).toContain('Nobody was cancelled');
    expect(liveBookings(sessionId)).toHaveLength(3);
    expect(sessionRow(sessionId).capacity).toBe(1);

    const audit = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'session.overbooked'), eq(schema.auditLog.entityId, sessionId)))
      .get();
    expect(audit).toBeTruthy();

    const dashboard = await get(owner, '/v1/admin/dashboard');
    const alerts = ((await dashboard.json()) as { alerts: Array<{ kind: string; actionTo: string }> }).alerts;
    expect(alerts.some((a) => a.kind === 'overbooked_class')).toBe(true);

    // A cancellation still gives a seat back while the class is over capacity.
    const one = liveBookings(sessionId)[0]!;
    const member = crowd.find((m) => m.memberId === one.memberId)!;
    expect((await send(member.session, 'DELETE', `/v1/member/schedule/booking/${one.id}`)).status).toBe(200);
    expect(sessionRow(sessionId).booked).toBe(2);
    // And nobody new gets in while it is over.
    const [late] = await members(1, 'ShrinkLate');
    expect((await book(late!.session, sessionId)).status).toBe(409);
  });

  it('reducing capacity withdraws offers that no longer fit; the member keeps their place', async () => {
    const sessionId = createClassSession({ capacity: 3 });
    const [a, b, c, w1] = await members(4, 'Withdraw');
    await bookingIdOf(a!.session, sessionId);
    await bookingIdOf(b!.session, sessionId);
    const bookingC = await bookingIdOf(c!.session, sessionId);
    await join(w1!.session, sessionId);
    await send(c!.session, 'DELETE', `/v1/member/schedule/booking/${bookingC}`);
    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('offered');

    const { body } = await patchCapacity(sessionId, 2);
    expect(body.capacity).toMatchObject({ withdrawnOffers: 1, overbookedBy: 0 });
    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('waiting');
    expect(sessionRow(sessionId).booked).toBe(2);
    expectSeatsConsistent(sessionId);
  });

  it('raising capacity offers the new seats to the line, in order', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const [a, w1, w2, w3] = await members(4, 'Grow');
    await bookingIdOf(a!.session, sessionId);
    for (const w of [w1!, w2!, w3!]) await join(w.session, sessionId);

    const { body } = await patchCapacity(sessionId, 3);
    expect(body.capacity.offersMade).toBe(2);
    expect(entryOf(sessionId, w1!.memberId)?.state).toBe('offered');
    expect(entryOf(sessionId, w2!.memberId)?.state).toBe('offered');
    expect(entryOf(sessionId, w3!.memberId)?.state).toBe('waiting');
    expect(sessionRow(sessionId).booked).toBe(3);
    expectSeatsConsistent(sessionId);
  });

  it('staff releasing a seat offers it too, and the roster shows the live offer', async () => {
    const sessionId = createClassSession({ capacity: 1 });
    const [a, w1] = await members(2, 'Release');
    const bookingA = await bookingIdOf(a!.session, sessionId);
    await join(w1!.session, sessionId);

    const released = await post(owner, `/v1/admin/schedule/booking/${bookingA}/release`, { reason: 'Injury' });
    expect(released.status).toBe(200);
    expect(((await released.json()) as { promoted: { memberId: string } | null }).promoted?.memberId).toBe(w1!.memberId);

    const roster = await get(owner, `/v1/admin/schedule/session/${sessionId}`);
    const detail = (await roster.json()) as { waitlist: Array<{ memberId: string; state: string; offerExpiresAt: string | null }> };
    expect(detail.waitlist[0]).toMatchObject({ memberId: w1!.memberId, state: 'offered' });
    expect(detail.waitlist[0]!.offerExpiresAt).not.toBeNull();
  });
});
