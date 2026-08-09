import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gt, inArray, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { now } from '../lib/time.js';

interface Session { cookie: string; csrfToken: string }
const cache = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const get = (session: Session, path: string) => app.request(path, { headers: headers(session) });
const post = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: headers(session, true), body: JSON.stringify(body) });
const patch = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(session, true), body: JSON.stringify(body) });

function tenantId(): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

let classTypeId = '';
let roomKor = '';
let trainerId = '';

beforeAll(() => {
  classTypeId = db.select({ id: schema.classTypes.id }).from(schema.classTypes).get()!.id;
  roomKor = db
    .select({ id: schema.rooms.id })
    .from(schema.rooms)
    .where(eq(schema.rooms.branchId, 'br_kor'))
    .get()!.id;
  trainerId = db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(eq(schema.users.role, 'trainer'))
    .get()!.id;
});

/** A far-future slot, so these tests never collide with the seeded weekly grid. */
let slotCursor = 0;
function futureSlot(): { startsAt: string; endsAt: string; ms: number } {
  slotCursor += 1;
  const ms = now() + (400 + slotCursor) * 24 * 3_600_000;
  return { startsAt: new Date(ms).toISOString(), endsAt: new Date(ms + 45 * 60_000).toISOString(), ms };
}

async function createSession(
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; version: number; startsAt: string }> {
  const slot = futureSlot();
  const response = await post(session, '/v1/admin/schedule/session', {
    branchId: 'br_kor',
    classTypeId,
    roomId: roomKor,
    trainerId,
    startsAt: slot.startsAt,
    durationMin: 45,
    capacity: 2,
    ...overrides,
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { session: { id: string; version: number } };
  return { ...body.session, startsAt: slot.startsAt };
}

function idleMember(branchId: string, exclude: string[] = []): { id: string } {
  const row = db
    .select({ id: schema.members.id })
    .from(schema.members)
    .innerJoin(schema.memberships, eq(schema.memberships.memberId, schema.members.id))
    .where(
      and(
        eq(schema.members.homeBranchId, branchId),
        eq(schema.memberships.state, 'active'),
        exclude.length ? notInArray(schema.members.id, exclude) : undefined,
      ),
    )
    .get();
  if (!row) throw new Error(`no active member at ${branchId}`);
  return row;
}

describe('Phase 5 — classes, schedule and waitlists', () => {
  it('creates a session and refuses a clashing room or trainer', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager);
    expect(created.id).toBeTruthy();

    // Same room, same time.
    const clashRoom = await post(manager, '/v1/admin/schedule/session', {
      branchId: 'br_kor',
      classTypeId,
      roomId: roomKor,
      trainerId: null,
      startsAt: created.startsAt,
      durationMin: 45,
      capacity: 5,
    });
    expect(clashRoom.status).toBe(409);
    expect(((await clashRoom.json()) as { error: { message: string } }).error.message).toContain('room');

    // Different room, same trainer, same time.
    const otherRoom = db
      .select({ id: schema.rooms.id })
      .from(schema.rooms)
      .where(and(eq(schema.rooms.branchId, 'br_kor'), sql`${schema.rooms.id} != ${roomKor}`))
      .get()!;

    const clashTrainer = await post(manager, '/v1/admin/schedule/session', {
      branchId: 'br_kor',
      classTypeId,
      roomId: otherRoom.id,
      trainerId,
      startsAt: created.startsAt,
      durationMin: 45,
      capacity: 5,
    });
    expect(clashTrainer.status).toBe(409);
    expect(((await clashTrainer.json()) as { error: { message: string } }).error.message).toContain('trainer');
  });

  it('reports clashes before the write is attempted', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager);

    const response = await get(
      manager,
      `/v1/admin/schedule/clashes?branchId=br_kor&roomId=${roomKor}` +
        `&startsAt=${encodeURIComponent(created.startsAt)}` +
        `&endsAt=${encodeURIComponent(new Date(Date.parse(created.startsAt) + 45 * 60_000).toISOString())}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { clashes: Array<{ kind: string; sessionId: string }> };
    expect(body.clashes.some((c) => c.kind === 'room' && c.sessionId === created.id)).toBe(true);
  });

  it('books a member onto a class, is idempotent, and refuses once full', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager, { capacity: 1 });
    const member = idleMember('br_kor');
    const other = idleMember('br_kor', [member.id]);

    const key = `test-book-${created.id}`;
    const first = await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: member.id,
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { replayed: boolean; booking: { id: string } };
    expect(firstBody.replayed).toBe(false);

    // Same key again is the same seat, not a second one.
    const retry = await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: member.id,
      idempotencyKey: key,
    });
    const retryBody = (await retry.json()) as { replayed: boolean; booking: { id: string } };
    expect(retryBody.replayed).toBe(true);
    expect(retryBody.booking.id).toBe(firstBody.booking.id);

    // Capacity is 1, so the next person cannot get in.
    const full = await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: other.id,
      idempotencyKey: `test-book-${created.id}-2`,
    });
    expect(full.status).toBe(409);

    const session = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, created.id)).get();
    expect(session?.booked).toBe(1);
  });

  it('refuses to shrink a class below the people already in it', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager, { capacity: 3 });
    const member = idleMember('br_kor');

    await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: member.id,
      idempotencyKey: `test-shrink-${created.id}`,
    });

    const response = await patch(manager, `/v1/admin/schedule/session/${created.id}`, { capacity: 0 });
    // capacity 0 fails validation; 1 is the meaningful business case below.
    expect([409, 422]).toContain(response.status);

    const created2 = await createSession(manager, { capacity: 3 });
    const m1 = idleMember('br_kor');
    const m2 = idleMember('br_kor', [m1.id]);
    await post(manager, `/v1/admin/schedule/session/${created2.id}/book`, {
      memberId: m1.id,
      idempotencyKey: `s2-${created2.id}-a`,
    });
    await post(manager, `/v1/admin/schedule/session/${created2.id}/book`, {
      memberId: m2.id,
      idempotencyKey: `s2-${created2.id}-b`,
    });

    const shrink = await patch(manager, `/v1/admin/schedule/session/${created2.id}`, { capacity: 1 });
    expect(shrink.status).toBe(409);
    expect(((await shrink.json()) as { error: { message: string } }).error.message).toContain('already booked');
  });

  it('rejects an edit made against a stale version', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager);

    const ok = await patch(manager, `/v1/admin/schedule/session/${created.id}`, {
      capacity: 4,
      version: created.version,
    });
    expect(ok.status).toBe(200);

    // The same version again is now behind the row.
    const stale = await patch(manager, `/v1/admin/schedule/session/${created.id}`, {
      capacity: 6,
      version: created.version,
    });
    expect(stale.status).toBe(409);
  });

  it('cancels a class, returns credits, releases seats and notifies the room', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager, { capacity: 5 });
    const member = idleMember('br_kor');

    await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: member.id,
      idempotencyKey: `cancel-${created.id}`,
    });

    // A credit-bearing seat, so the refund path is exercised.
    db.update(schema.bookings)
      .set({ creditsUsed: 1 })
      .where(and(eq(schema.bookings.sessionId, created.id), eq(schema.bookings.memberId, member.id)))
      .run();

    const before = db
      .select({ n: sql<number>`coalesce(sum(${schema.credits.delta}), 0)` })
      .from(schema.credits)
      .where(and(eq(schema.credits.memberId, member.id), eq(schema.credits.kind, 'class')))
      .get();

    const response = await post(manager, `/v1/admin/schedule/session/${created.id}/cancel`, {
      reason: 'Studio floor being resurfaced',
      scope: 'occurrence',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      cancelled: string[];
      bookingsReleased: number;
      creditsReturned: number;
      notified: number;
    };
    expect(body.cancelled).toContain(created.id);
    expect(body.bookingsReleased).toBe(1);
    expect(body.creditsReturned).toBe(1);
    expect(body.notified).toBeGreaterThan(0);

    const session = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, created.id)).get();
    expect(session?.state).toBe('cancelled');
    expect(session?.booked).toBe(0);

    // The credit came back even though the cancellation deadline had passed —
    // the gym cancelled, not the member.
    const after = db
      .select({ n: sql<number>`coalesce(sum(${schema.credits.delta}), 0)` })
      .from(schema.credits)
      .where(and(eq(schema.credits.memberId, member.id), eq(schema.credits.kind, 'class')))
      .get();
    expect(after!.n).toBe(before!.n + 1);
  });

  it('substitutes a trainer and keeps who was originally scheduled', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager);

    const replacement = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.users.role, 'trainer'), sql`${schema.staff.id} != ${trainerId}`))
      .get();
    if (!replacement) return;

    const response = await post(manager, `/v1/admin/schedule/session/${created.id}/substitute`, {
      trainerId: replacement.id,
    });
    expect(response.status).toBe(200);

    const session = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, created.id)).get();
    expect(session?.trainerId).toBe(replacement.id);
    expect(session?.substituteFor).toBe(trainerId);
  });

  it('marks attendance and refuses a no-show before the class has run', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager, { capacity: 4 });
    const member = idleMember('br_kor');

    const booked = await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: member.id,
      idempotencyKey: `attend-${created.id}`,
    });
    const { booking } = (await booked.json()) as { booking: { id: string } };

    // The class is in the future, so nobody can have failed to turn up yet.
    const early = await post(manager, `/v1/admin/schedule/booking/${booking.id}/attendance`, { state: 'no_show' });
    expect(early.status).toBe(412);

    const marked = await post(manager, `/v1/admin/schedule/booking/${booking.id}/attendance`, { state: 'attended' });
    expect(marked.status).toBe(200);

    const row = db.select().from(schema.bookings).where(eq(schema.bookings.id, booking.id)).get();
    expect(row?.state).toBe('attended');
    expect(row?.attendedAt).not.toBeNull();
  });

  it('releases a seat from the desk and promotes the waitlist', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager, { capacity: 1 });
    const seated = idleMember('br_kor');
    const waiting = idleMember('br_kor', [seated.id]);

    const booked = await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: seated.id,
      idempotencyKey: `release-${created.id}`,
    });
    const { booking } = (await booked.json()) as { booking: { id: string } };

    db.insert(schema.waitlistEntries)
      .values({
        id: `wtl_test_${created.id}`,
        tenantId: tenantId(),
        sessionId: created.id,
        memberId: waiting.id,
        position: 1,
        state: 'waiting',
        joinedAt: now(),
        offeredAt: null,
        offerExpiresAt: null,
        resolvedAt: null,
      })
      .run();

    const response = await post(manager, `/v1/admin/schedule/booking/${booking.id}/release`, { reason: 'Injury' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { promoted: { memberId: string } | null };
    expect(body.promoted?.memberId).toBe(waiting.id);

    const entry = db
      .select()
      .from(schema.waitlistEntries)
      .where(eq(schema.waitlistEntries.id, `wtl_test_${created.id}`))
      .get();
    expect(entry?.state).toBe('offered');

    const session = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, created.id)).get();
    expect(session?.booked).toBe(0);
  });

  it('hides a class at another branch behind a 404', async () => {
    // Reception and branch_manager are scoped to br_kor.
    const manager = await signIn('manager@sharkfitness.in');
    const foreign = db
      .select({ id: schema.classSessions.id })
      .from(schema.classSessions)
      .where(and(eq(schema.classSessions.branchId, 'br_ind'), gt(schema.classSessions.startsAt, now())))
      .get()!;

    const detail = await get(manager, `/v1/admin/schedule/session/${foreign.id}`);
    expect(detail.status).toBe(404);

    const cancel = await post(manager, `/v1/admin/schedule/session/${foreign.id}/cancel`, {
      reason: 'Should not be possible',
    });
    expect(cancel.status).toBe(404);

    const create = await post(manager, '/v1/admin/schedule/session', {
      branchId: 'br_ind',
      classTypeId,
      roomId: null,
      trainerId: null,
      startsAt: futureSlot().startsAt,
      capacity: 5,
    });
    expect(create.status).toBe(404);
  });

  it('lets reception read the schedule but not change it', async () => {
    const reception = await signIn('reception@sharkfitness.in');

    const day = await get(reception, '/v1/admin/schedule');
    expect(day.status).toBe(200);
    const body = (await day.json()) as { items: Array<{ branchId: string }>; totals: { sessions: number } };
    expect(body.items.every((i) => i.branchId === 'br_kor')).toBe(true);

    // schedule.manage is not a reception permission.
    const create = await post(reception, '/v1/admin/schedule/session', {
      branchId: 'br_kor',
      classTypeId,
      roomId: null,
      trainerId: null,
      startsAt: futureSlot().startsAt,
      capacity: 5,
    });
    expect(create.status).toBe(403);
  });

  it('returns a roster with the waitlist in queue order', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const created = await createSession(manager, { capacity: 3 });
    const member = idleMember('br_kor');

    await post(manager, `/v1/admin/schedule/session/${created.id}/book`, {
      memberId: member.id,
      idempotencyKey: `roster-${created.id}`,
    });

    const response = await get(manager, `/v1/admin/schedule/session/${created.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { capacity: number; booked: number };
      counts: { live: number };
      roster: Array<{ memberId: string; state: string }>;
      waitlist: unknown[];
    };
    expect(body.session.booked).toBe(1);
    expect(body.counts.live).toBe(1);
    expect(body.roster[0]?.memberId).toBe(member.id);
  });

  it('cancels a whole future series without touching classes that already ran', async () => {
    const owner = await signIn('owner@sharkfitness.in');

    const seriesSession = db
      .select()
      .from(schema.classSessions)
      .where(
        and(
          eq(schema.classSessions.branchId, 'br_kor'),
          gt(schema.classSessions.startsAt, now()),
          eq(schema.classSessions.state, 'scheduled'),
          isNotNull(schema.classSessions.seriesId),
        ),
      )
      .get()!;

    const pastBefore = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.classSessions)
      .where(
        and(
          eq(schema.classSessions.seriesId, seriesSession.seriesId!),
          lte(schema.classSessions.startsAt, now()),
          eq(schema.classSessions.state, 'completed'),
        ),
      )
      .get();

    const response = await post(owner, `/v1/admin/schedule/session/${seriesSession.id}/cancel`, {
      reason: 'Coach on leave for the rest of the block',
      scope: 'series',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cancelled: string[] };
    expect(body.cancelled.length).toBeGreaterThan(1);

    const remainingFuture = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.classSessions)
      .where(
        and(
          eq(schema.classSessions.seriesId, seriesSession.seriesId!),
          gt(schema.classSessions.startsAt, now()),
          inArray(schema.classSessions.state, ['scheduled']),
        ),
      )
      .get();
    expect(remainingFuture?.n).toBe(0);

    // History is left alone.
    const pastAfter = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.classSessions)
      .where(
        and(
          eq(schema.classSessions.seriesId, seriesSession.seriesId!),
          lte(schema.classSessions.startsAt, now()),
          eq(schema.classSessions.state, 'completed'),
        ),
      )
      .get();
    expect(pastAfter?.n).toBe(pastBefore?.n);
  });
});
