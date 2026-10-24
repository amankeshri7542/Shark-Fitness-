import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { DAY, HOUR, now } from '../lib/time.js';

/* ============================================================================
   Trainer absence and cover (PF-STAFF).

   Substituting a coach on one class already worked. The workflow around it did
   not: nothing recorded that a trainer was off, nothing listed what that
   broke, and "who can cover this?" was answered from memory.

   What these tests hold to:

   - recording an absence moves nobody's booking;
   - the affected list is derived from the absence, so a class created after it
     is still covered;
   - a substitute who is themselves away is refused;
   - the original coach keeps the attribution through repeated swaps;
   - everybody booked is told, in-app, truthfully;
   - a trainer at another branch is not offered, and cannot be assigned.

   Every row this suite creates it deletes in `afterAll` — the seed is shared.
   ========================================================================= */

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

const OWNER = 'owner@sharkfitness.in';

function trainerIdFor(email: string): string {
  return db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(eq(schema.users.email, email))
    .get()!.id;
}

let rehan = '';
let nikhil = '';
let priya = '';
let classTypeId = '';
let roomId = '';
const createdSessionIds: string[] = [];
const createdAbsenceIds: string[] = [];

/** A class this suite owns, well clear of the seeded grid so it cannot clash
 *  with it or be picked up by another suite's "any session" query. */
function makeSession(trainerId: string | null, startsAt: number, capacity = 10): string {
  const sessionId = id('ses');
  db.insert(schema.classSessions)
    .values({
      id: sessionId,
      tenantId: 'ten_shark',
      branchId: 'br_kor',
      classTypeId,
      roomId,
      trainerId,
      seriesId: null,
      occurrenceDate: null,
      startsAt,
      endsAt: startsAt + 45 * 60_000,
      capacity,
      booked: 0,
      state: 'scheduled',
      bookingOpensAt: null,
      cancelDeadlineAt: null,
      creditsRequired: 0,
      dropInPriceMinor: null,
      lateCancelFeeMinor: 0,
      waitlistEnabled: true,
      cancelledReason: null,
      substituteFor: null,
      notes: null,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  createdSessionIds.push(sessionId);
  return sessionId;
}

beforeAll(() => {
  rehan = trainerIdFor('rehan@sharkfitness.in');
  nikhil = trainerIdFor('nikhil@sharkfitness.in');
  priya = trainerIdFor('priya@sharkfitness.in');
  classTypeId = db
    .select({ id: schema.classTypes.id })
    .from(schema.classTypes)
    .where(eq(schema.classTypes.name, 'Strength Clinic'))
    .get()!.id;
  roomId = id('rom');
  db.insert(schema.rooms)
    .values({ id: roomId, tenantId: 'ten_shark', branchId: 'br_kor', name: 'Coverage Test Studio', capacity: 30 })
    .run();
});

afterAll(() => {
  if (createdSessionIds.length > 0) {
    db.delete(schema.bookings).where(inArray(schema.bookings.sessionId, createdSessionIds)).run();
    db.delete(schema.classSessions).where(inArray(schema.classSessions.id, createdSessionIds)).run();
  }
  if (createdAbsenceIds.length > 0) {
    db.delete(schema.staffUnavailability)
      .where(inArray(schema.staffUnavailability.id, createdAbsenceIds))
      .run();
  }
  db.delete(schema.rooms).where(eq(schema.rooms.id, roomId)).run();
  // Any absence this suite created through the API, caught by staff id.
  db.delete(schema.staffUnavailability)
    .where(inArray(schema.staffUnavailability.staffId, [rehan, nikhil, priya]))
    .run();
});

async function markAway(
  session: Session,
  staffId: string,
  fromMs: number,
  toMs: number,
  reason = 'sick',
): Promise<Record<string, unknown>> {
  const response = await app.request(`/v1/admin/staff/${staffId}/unavailability`, {
    method: 'POST',
    headers: headers(session, true),
    body: JSON.stringify({
      startsAt: new Date(fromMs).toISOString(),
      endsAt: new Date(toMs).toISOString(),
      reason,
      note: null,
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as Record<string, unknown>;
  const absenceId = (body.unavailability as { id: string }).id;
  createdAbsenceIds.push(absenceId);
  return body;
}

describe('marking a trainer unavailable', () => {
  it('lists the affected classes and changes none of them', async () => {
    const owner = await signIn(OWNER);
    const start = now() + 3 * DAY;
    const sessionId = makeSession(rehan, start + 10 * HOUR);

    // A member with a real seat on it.
    const member = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.homeBranchId, 'br_kor'), eq(schema.members.lifecycle, 'active')))
      .get()!;
    const bookingId = id('bkg');
    db.insert(schema.bookings)
      .values({
        id: bookingId,
        tenantId: 'ten_shark',
        sessionId,
        memberId: member.id,
        state: 'confirmed',
        seatNo: 1,
        bookedAt: now(),
        cancelledAt: null,
        heldUntil: null,
        creditsUsed: 0,
        chargeMinor: 0,
        cameFromWaitlist: false,
        idempotencyKey: id('idem'),
        attendedAt: null,
      })
      .run();

    const before = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).get()!;

    const body = await markAway(owner, rehan, start, start + 2 * DAY);
    const impact = body.impact as { sessions: Array<{ sessionId: string; booked: number }> };
    expect(impact.sessions.map((row) => row.sessionId)).toContain(sessionId);

    // Nothing moved. This is the whole point: the absence is a fact, not an action.
    const after = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).get()!;
    expect(after.trainerId).toBe(before.trainerId);
    expect(after.startsAt).toBe(before.startsAt);
    expect(after.state).toBe('scheduled');
    expect(db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId)).get()!.state).toBe('confirmed');
  });

  it('covers a class created after the absence was recorded', async () => {
    const owner = await signIn(OWNER);
    const start = now() + 20 * DAY;
    await markAway(owner, nikhil, start, start + 2 * DAY, 'leave');

    // Created afterwards — a stored list of session ids would miss this.
    const late = makeSession(nikhil, start + 6 * HOUR);

    const response = await app.request(
      `/v1/admin/staff/${nikhil}/coverage?from=${encodeURIComponent(new Date(start).toISOString())}` +
        `&to=${encodeURIComponent(new Date(start + 2 * DAY).toISOString())}`,
      { headers: headers(owner) },
    );
    expect(response.status).toBe(200);
    const impact = (await response.json()) as { sessions: Array<{ sessionId: string }> };
    expect(impact.sessions.map((row) => row.sessionId)).toContain(late);
  });

  it('never reports a class that has already run', async () => {
    const owner = await signIn(OWNER);
    const past = now() - 5 * DAY;
    makeSession(priya, past + HOUR);

    const response = await app.request(
      `/v1/admin/staff/${priya}/coverage?from=${encodeURIComponent(new Date(past).toISOString())}` +
        `&to=${encodeURIComponent(new Date(now() + DAY).toISOString())}`,
      { headers: headers(owner) },
    );
    const impact = (await response.json()) as { sessions: Array<{ startsAt: number }> };
    for (const row of impact.sessions) expect(row.startsAt).toBeGreaterThan(now());
  });
});

describe('choosing a substitute', () => {
  it('offers eligible trainers first and says why the others are out', async () => {
    const owner = await signIn(OWNER);
    const start = now() + 40 * DAY;
    const sessionId = makeSession(rehan, start + 9 * HOUR);

    // Nikhil is teaching something else at exactly this time.
    makeSession(nikhil, start + 9 * HOUR);
    // Priya is away.
    await markAway(owner, priya, start, start + DAY, 'training');

    const response = await app.request(`/v1/admin/schedule/session/${sessionId}/substitutes`, {
      headers: headers(owner),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      candidates: Array<{ staffId: string; eligible: boolean; blockedReason: string | null }>;
    };

    const byId = new Map(body.candidates.map((row) => [row.staffId, row]));
    // The class's own trainer is not a candidate to substitute for themselves.
    expect(byId.has(rehan)).toBe(false);
    expect(byId.get(nikhil)!.eligible).toBe(false);
    expect(byId.get(nikhil)!.blockedReason).toMatch(/already teaching/i);
    expect(byId.get(priya)!.eligible).toBe(false);
    expect(byId.get(priya)!.blockedReason).toMatch(/away/i);
  });

  it('ranks a trainer whose specialities match the class above one whose do not', async () => {
    const owner = await signIn(OWNER);
    const start = now() + 44 * DAY;
    // Strength Clinic: Rehan's specialities are Strength/Hypertrophy/Powerlifting.
    const sessionId = makeSession(null, start + 9 * HOUR);

    const response = await app.request(`/v1/admin/schedule/session/${sessionId}/substitutes`, {
      headers: headers(owner),
    });
    const body = (await response.json()) as {
      candidates: Array<{ staffId: string; eligible: boolean; matchingSpecialties: string[] }>;
    };

    const eligible = body.candidates.filter((row) => row.eligible);
    expect(eligible.length).toBeGreaterThan(1);
    // Ranking, not gating: everyone free is still offered.
    expect(eligible[0]!.staffId).toBe(rehan);
    expect(eligible[0]!.matchingSpecialties).toContain('Strength');
    expect(eligible.some((row) => row.matchingSpecialties.length === 0)).toBe(true);
  });

  it('refuses a substitute who is themselves away', async () => {
    const owner = await signIn(OWNER);
    const start = now() + 48 * DAY;
    const sessionId = makeSession(rehan, start + 9 * HOUR);
    await markAway(owner, priya, start, start + DAY);

    const response = await app.request(`/v1/admin/schedule/session/${sessionId}/substitute`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ trainerId: priya }),
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toMatch(/also away/i);

    // And the class still belongs to whoever it belonged to.
    expect(
      db.select().from(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).get()!.trainerId,
    ).toBe(rehan);
  });

  it('assigns cover, tells everybody booked, and keeps the original coach on record', async () => {
    const owner = await signIn(OWNER);
    const start = now() + 52 * DAY;
    const sessionId = makeSession(rehan, start + 9 * HOUR);

    const member = db
      .select({ id: schema.members.id, userId: schema.members.userId })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.homeBranchId, 'br_kor'),
          eq(schema.members.lifecycle, 'active'),
          ne(schema.members.userId, ''),
        ),
      )
      .get()!;
    db.insert(schema.bookings)
      .values({
        id: id('bkg'),
        tenantId: 'ten_shark',
        sessionId,
        memberId: member.id,
        state: 'confirmed',
        seatNo: 1,
        bookedAt: now(),
        cancelledAt: null,
        heldUntil: null,
        creditsUsed: 0,
        chargeMinor: 0,
        cameFromWaitlist: false,
        idempotencyKey: id('idem'),
        attendedAt: null,
      })
      .run();

    const notificationsBefore = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, member.userId!), eq(schema.notifications.kind, 'session_changed')))
      .all().length;

    const first = await app.request(`/v1/admin/schedule/session/${sessionId}/substitute`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ trainerId: priya }),
    });
    expect(first.status).toBe(200);

    // A second swap. `substitute_for` must still name the *original* coach.
    const second = await app.request(`/v1/admin/schedule/session/${sessionId}/substitute`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ trainerId: nikhil }),
    });
    expect(second.status).toBe(200);

    const row = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).get()!;
    expect(row.trainerId).toBe(nikhil);
    expect(row.substituteFor).toBe(rehan);

    // The member was told each time, in-app, and nothing about their seat moved.
    const notificationsAfter = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, member.userId!), eq(schema.notifications.kind, 'session_changed')))
      .all();
    expect(notificationsAfter.length).toBe(notificationsBefore + 2);
    expect(
      db.select().from(schema.bookings).where(eq(schema.bookings.sessionId, sessionId)).get()!.state,
    ).toBe('confirmed');

    // Audited, both times.
    expect(
      db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.entityId, sessionId), eq(schema.auditLog.action, 'session.substituted')))
        .all().length,
    ).toBe(2);
  });

  it('does not offer or accept a trainer from another branch', async () => {
    const owner = await signIn(OWNER);
    const start = now() + 56 * DAY;

    // A trainer this suite owns, assigned to Indiranagar only.
    const outsiderUser = id('usr');
    const outsider = id('stf');
    db.insert(schema.users)
      .values({
        id: outsiderUser,
        tenantId: 'ten_shark',
        email: `${outsiderUser}@coverage.test`,
        phone: null,
        name: 'Indiranagar Only',
        initials: 'IO',
        role: 'trainer',
        accountState: 'active',
        passwordHash: null,
        preferences: {},
        lastSeenAt: null,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      })
      .run();
    db.insert(schema.staff)
      .values({
        id: outsider,
        tenantId: 'ten_shark',
        userId: outsiderUser,
        employmentStatus: 'active',
        branchIds: ['br_ind'],
        specialties: ['Strength'],
        certifications: [],
        commissionRules: [],
        hourlyRateMinor: null,
        joinedOn: '2026-01-01',
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    try {
      const sessionId = makeSession(rehan, start + 9 * HOUR);

      const listed = await app.request(`/v1/admin/schedule/session/${sessionId}/substitutes`, {
        headers: headers(owner),
      });
      const body = (await listed.json()) as {
        candidates: Array<{ staffId: string; eligible: boolean; blockedReason: string | null }>;
      };
      const entry = body.candidates.find((row) => row.staffId === outsider)!;
      expect(entry.eligible).toBe(false);
      expect(entry.blockedReason).toMatch(/branch/i);

      const assign = await app.request(`/v1/admin/schedule/session/${sessionId}/substitute`, {
        method: 'POST',
        headers: headers(owner, true),
        body: JSON.stringify({ trainerId: outsider }),
      });
      expect(assign.status).toBe(422);
    } finally {
      db.delete(schema.staff).where(eq(schema.staff.id, outsider)).run();
      db.delete(schema.users).where(eq(schema.users.id, outsiderUser)).run();
    }
  });
});

describe('withdrawing an absence', () => {
  it('restores availability without undoing the cover it caused', async () => {
    const owner = await signIn(OWNER);
    const start = now() + 60 * DAY;
    const sessionId = makeSession(rehan, start + 9 * HOUR);
    const body = await markAway(owner, rehan, start, start + DAY);
    const absenceId = (body.unavailability as { id: string }).id;

    await app.request(`/v1/admin/schedule/session/${sessionId}/substitute`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ trainerId: priya }),
    });

    const response = await app.request(`/v1/admin/staff/unavailability/${absenceId}`, {
      method: 'DELETE',
      headers: headers(owner, true),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { substitutionsUnchanged: boolean }).toMatchObject({
      substitutionsUnchanged: true,
    });

    // Priya still has the class. Silently handing it back would be a second
    // unannounced change to a class members were already told about.
    const row = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).get()!;
    expect(row.trainerId).toBe(priya);
    expect(row.substituteFor).toBe(rehan);

    // Rehan is bookable again.
    const later = makeSession(null, start + 12 * HOUR);
    const substitutes = await app.request(`/v1/admin/schedule/session/${later}/substitutes`, {
      headers: headers(owner),
    });
    const candidates = (await substitutes.json()) as { candidates: Array<{ staffId: string; eligible: boolean }> };
    expect(candidates.candidates.find((row) => row.staffId === rehan)!.eligible).toBe(true);
  });

  it('refuses an absence belonging to a branch the caller cannot see', async () => {
    const owner = await signIn(OWNER);
    // br_kor only. Every seeded trainer covers all three branches, so this
    // test has to build its own out-of-scope subject — otherwise it asserts
    // nothing, which is how a scoping gap survives a green suite.
    const manager = await signIn('manager@sharkfitness.in');

    const outsiderUser = id('usr');
    const outsider = id('stf');
    db.insert(schema.users)
      .values({
        id: outsiderUser,
        tenantId: 'ten_shark',
        email: `${outsiderUser}@coverage.test`,
        phone: null,
        name: 'HSR Only Coach',
        initials: 'HO',
        role: 'trainer',
        accountState: 'active',
        passwordHash: null,
        preferences: {},
        lastSeenAt: null,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      })
      .run();
    db.insert(schema.staff)
      .values({
        id: outsider,
        tenantId: 'ten_shark',
        userId: outsiderUser,
        employmentStatus: 'active',
        branchIds: ['br_hsr'],
        specialties: [],
        certifications: [],
        commissionRules: [],
        hourlyRateMinor: null,
        joinedOn: '2026-01-01',
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    try {
      const start = now() + 70 * DAY;
      const body = await markAway(owner, outsider, start, start + DAY);
      const absenceId = (body.unavailability as { id: string }).id;

      // The authorisation sequence is permission, then tenant, then branch —
      // and the two answers differ on purpose.
      //
      // Withdrawing needs `staff.manage`, which a branch manager does not
      // hold, so it is refused on the permission before scope is ever
      // consulted: 403, and it reveals nothing about whether the absence
      // exists because the answer is the same for any id.
      const withdraw = await app.request(`/v1/admin/staff/unavailability/${absenceId}`, {
        method: 'DELETE',
        headers: headers(manager, true),
      });
      expect(withdraw.status).toBe(403);

      // Reading coverage needs `staff.view`, which they *do* hold — so this
      // one reaches the scope test, and there the answer must be "not found".
      // A 403 here would confirm a coach exists at a branch they cannot see.
      const read = await app.request(`/v1/admin/staff/${outsider}/coverage`, { headers: headers(manager) });
      expect(read.status).toBe(404);

      // The owner, who holds all three branches, still reaches both.
      expect(
        (await app.request(`/v1/admin/staff/${outsider}/coverage`, { headers: headers(owner) })).status,
      ).toBe(200);
    } finally {
      db.delete(schema.staffUnavailability)
        .where(eq(schema.staffUnavailability.staffId, outsider))
        .run();
      db.delete(schema.staff).where(eq(schema.staff.id, outsider)).run();
      db.delete(schema.users).where(eq(schema.users.id, outsiderUser)).run();
    }
  });
});
