import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { DAY, addDays, isoDate, localTime, now } from '../lib/time.js';
import {
  extendActiveSeries,
  generateOccurrences,
  occurrenceDates,
  weekdayOf,
  type SeriesRow,
} from '../services/schedule-series.js';

/* ============================================================================
   Recurring classes (PF-SCH).

   `class_sessions.series_id` used to be a free-text key with no row behind it:
   the occurrences existed and the rule did not. "Cancel the rest of the
   series" meant "every future row sharing this string", and there was nothing
   to edit, extend or reason about.

   What these tests hold to:

   - generating twice produces one timetable, not two;
   - a series holds its *wall clock* across a DST transition, rather than its
     UTC offset;
   - nothing that has already happened is ever rewritten;
   - a class somebody has booked is never silently moved;
   - room and trainer conflicts still bind, per occurrence;
   - a series at another branch or another tenant is not found.

   This suite owns every row it creates — including a branch in a DST zone,
   which the seed has none of — and deletes them in `afterAll`. The seed is a
   shared fixture.
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
const MANAGER = 'manager@sharkfitness.in';
const TZ = 'Asia/Kolkata';

const createdSeriesIds: string[] = [];
let classTypeId = '';
let roomId = '';
let trainerId = '';

/** A date at least a week out, on a known weekday, so the tests never race
 *  midnight or land on today. */
function upcoming(weekday: number, weeksAhead = 1): string {
  let day = addDays(isoDate(now(), TZ), 7 * weeksAhead);
  for (let i = 0; i < 7; i += 1) {
    if (weekdayOf(day) === weekday) return day;
    day = addDays(day, 1);
  }
  throw new Error('unreachable');
}

beforeAll(() => {
  classTypeId = db
    .select({ id: schema.classTypes.id })
    .from(schema.classTypes)
    .where(eq(schema.classTypes.tenantId, 'ten_shark'))
    .get()!.id;
  // A room this suite owns, so its capacity and its clashes are its own.
  roomId = id('rom');
  db.insert(schema.rooms)
    .values({ id: roomId, tenantId: 'ten_shark', branchId: 'br_kor', name: 'Series Test Studio', capacity: 30 })
    .run();
  trainerId = db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(eq(schema.users.email, 'rehan@sharkfitness.in'))
    .get()!.id;
});

afterAll(() => {
  const ids = [...createdSeriesIds];
  if (ids.length > 0) {
    const sessions = db
      .select({ id: schema.classSessions.id })
      .from(schema.classSessions)
      .where(inArray(schema.classSessions.seriesId, ids))
      .all()
      .map((row) => row.id);
    if (sessions.length > 0) {
      db.delete(schema.bookings).where(inArray(schema.bookings.sessionId, sessions)).run();
      db.delete(schema.waitlistEntries).where(inArray(schema.waitlistEntries.sessionId, sessions)).run();
      db.delete(schema.classSessions).where(inArray(schema.classSessions.id, sessions)).run();
    }
    db.delete(schema.classSeries).where(inArray(schema.classSeries.id, ids)).run();
  }
  db.delete(schema.rooms).where(eq(schema.rooms.id, roomId)).run();
});

async function createSeries(
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request('/v1/admin/schedule/series', {
    method: 'POST',
    headers: headers(session, true),
    body: JSON.stringify({
      branchId: 'br_kor',
      classTypeId,
      roomId,
      trainerId,
      weekdays: [1, 3],
      startDate: upcoming(1),
      startTime: '14:30',
      durationMin: 45,
      capacity: 12,
      ...overrides,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  const seriesId = (body.series as { id?: string } | undefined)?.id;
  if (seriesId) createdSeriesIds.push(seriesId);
  return { status: response.status, body };
}

function occurrencesOf(seriesId: string) {
  return db
    .select()
    .from(schema.classSessions)
    .where(eq(schema.classSessions.seriesId, seriesId))
    .orderBy(schema.classSessions.startsAt)
    .all();
}

describe('series generation', () => {
  it('creates one occurrence per selected weekday and none in the past', async () => {
    const owner = await signIn(OWNER);
    const { status, body } = await createSeries(owner);
    expect(status).toBe(201);

    const seriesId = (body.series as { id: string }).id;
    const rows = occurrencesOf(seriesId);
    expect(rows.length).toBeGreaterThan(0);

    // Every occurrence falls on a chosen weekday, in the future, at the
    // requested branch-local clock time.
    for (const row of rows) {
      expect([1, 3]).toContain(weekdayOf(row.occurrenceDate!));
      expect(row.startsAt).toBeGreaterThan(now());
      expect(localTime(row.startsAt, TZ)).toBe('14:30');
      expect(row.capacity).toBe(12);
    }

    // And each date appears exactly once.
    const dates = rows.map((row) => row.occurrenceDate);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('is idempotent: regenerating adds nothing and duplicates nothing', async () => {
    const owner = await signIn(OWNER);
    const { body } = await createSeries(owner, { startTime: '15:30' });
    const seriesId = (body.series as { id: string }).id;

    const before = occurrencesOf(seriesId).map((row) => row.id).sort();
    const series = db.select().from(schema.classSeries).where(eq(schema.classSeries.id, seriesId)).get()!;

    const second = generateOccurrences(series);
    const third = generateOccurrences(series);

    expect(second.created).toEqual([]);
    expect(third.created).toEqual([]);
    expect(second.skippedExisting.length).toBeGreaterThan(0);

    const after = occurrencesOf(seriesId).map((row) => row.id).sort();
    expect(after).toEqual(before);
  });

  it('refuses a duplicate occurrence at the database, not just in the service', async () => {
    const owner = await signIn(OWNER);
    const { body } = await createSeries(owner, { startTime: '16:30' });
    const seriesId = (body.series as { id: string }).id;
    const existing = occurrencesOf(seriesId)[0]!;

    // The service checks first; this proves the index is what actually holds,
    // so a second writer cannot produce a second Tuesday.
    expect(() =>
      db
        .insert(schema.classSessions)
        .values({ ...existing, id: id('ses') })
        .run(),
    ).toThrow(/UNIQUE|constraint/i);
  });

  it('skips an occurrence whose room is already taken and says which', async () => {
    const owner = await signIn(OWNER);
    const clashDay = upcoming(1, 2);

    // A one-off class occupying the room on one of the series' days.
    const blocker = await app.request('/v1/admin/schedule/session', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({
        branchId: 'br_kor',
        classTypeId,
        roomId,
        trainerId: null,
        startsAt: new Date(Date.parse(`${clashDay}T17:30:00+05:30`)).toISOString(),
        durationMin: 45,
        capacity: 5,
      }),
    });
    expect(blocker.status).toBe(201);
    const blockerId = ((await blocker.json()) as { session: { id: string } }).session.id;

    const { body } = await createSeries(owner, { startTime: '17:30', startDate: upcoming(1), weekdays: [1] });
    const generation = body.generation as { created: string[]; skippedConflict: Array<{ date: string; reason: string }> };

    expect(generation.skippedConflict.map((row) => row.date)).toContain(clashDay);
    expect(generation.skippedConflict.find((row) => row.date === clashDay)!.reason).toMatch(/room/i);
    // The rest of the series still generated — one busy week does not kill it.
    expect(generation.created.length).toBeGreaterThan(0);
    expect(generation.created).not.toContain(clashDay);

    db.delete(schema.bookings).where(eq(schema.bookings.sessionId, blockerId)).run();
    db.delete(schema.classSessions).where(eq(schema.classSessions.id, blockerId)).run();
  });
});

describe('series editing', () => {
  it('applies a whole-series change forward and leaves booked classes alone', async () => {
    const owner = await signIn(OWNER);
    const { body } = await createSeries(owner, { startTime: '13:15' });
    const seriesId = (body.series as { id: string }).id;

    const occurrences = occurrencesOf(seriesId);
    const booked = occurrences[1]!;

    // Put a real member on the second occurrence.
    const member = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.homeBranchId, 'br_kor'), eq(schema.members.lifecycle, 'active')))
      .get()!;
    db.insert(schema.bookings)
      .values({
        id: id('bkg'),
        tenantId: 'ten_shark',
        sessionId: booked.id,
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

    const patch = await app.request(`/v1/admin/schedule/series/${seriesId}`, {
      method: 'PATCH',
      headers: headers(owner, true),
      body: JSON.stringify({ capacity: 20, scope: 'series' }),
    });
    expect(patch.status).toBe(200);

    const after = occurrencesOf(seriesId);
    const stillBooked = after.find((row) => row.id === booked.id);

    // The booked occurrence survived, untouched, at its original capacity.
    expect(stillBooked).toBeTruthy();
    expect(stillBooked!.capacity).toBe(booked.capacity);

    // Everything unbooked was regenerated at the new capacity.
    const regenerated = after.filter((row) => row.id !== booked.id);
    expect(regenerated.length).toBeGreaterThan(0);
    for (const row of regenerated) expect(row.capacity).toBe(20);
  });

  it('splits the series on "this and future" and leaves earlier occurrences under the old rule', async () => {
    const owner = await signIn(OWNER);
    const { body } = await createSeries(owner, { startTime: '11:15' });
    const seriesId = (body.series as { id: string }).id;

    const occurrences = occurrencesOf(seriesId);
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
    const pivot = occurrences[2]!;

    const patch = await app.request(`/v1/admin/schedule/series/${seriesId}`, {
      method: 'PATCH',
      headers: headers(owner, true),
      body: JSON.stringify({ startTime: '12:15', scope: 'this_and_future', fromSessionId: pivot.id }),
    });
    expect(patch.status).toBe(200);
    const result = (await patch.json()) as { successorSeriesId: string };
    expect(result.successorSeriesId).toBeTruthy();
    createdSeriesIds.push(result.successorSeriesId);

    // The old series is closed the day before the pivot and points at its heir.
    const old = db.select().from(schema.classSeries).where(eq(schema.classSeries.id, seriesId)).get()!;
    expect(old.endDate).toBe(addDays(pivot.occurrenceDate!, -1));
    expect(old.supersededBySeriesId).toBe(result.successorSeriesId);

    // Occurrences before the pivot still describe the old rule.
    for (const row of occurrencesOf(seriesId)) {
      expect(row.occurrenceDate! < pivot.occurrenceDate!).toBe(true);
      expect(localTime(row.startsAt, TZ)).toBe('11:15');
    }

    // The successor's occurrences carry the new time, from the pivot on.
    const successorRows = occurrencesOf(result.successorSeriesId);
    expect(successorRows.length).toBeGreaterThan(0);
    for (const row of successorRows) {
      expect(row.occurrenceDate! >= pivot.occurrenceDate!).toBe(true);
      expect(localTime(row.startsAt, TZ)).toBe('12:15');
    }
  });
});

describe('series cancellation', () => {
  it('cancels every remaining occurrence and stops the series generating', async () => {
    const owner = await signIn(OWNER);
    const { body } = await createSeries(owner, { startTime: '10:15' });
    const seriesId = (body.series as { id: string }).id;
    const before = occurrencesOf(seriesId).length;
    expect(before).toBeGreaterThan(0);

    const response = await app.request(`/v1/admin/schedule/series/${seriesId}/cancel`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Studio floor is being replaced.', scope: 'series' }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { cancelledSessions: string[]; seriesState: string };
    expect(result.cancelledSessions.length).toBe(before);
    expect(result.seriesState).toBe('cancelled');

    for (const row of occurrencesOf(seriesId)) expect(row.state).toBe('cancelled');

    // A cancelled series must not come back to life on the next job tick.
    const series = db.select().from(schema.classSeries).where(eq(schema.classSeries.id, seriesId)).get()!;
    expect(generateOccurrences(series).created).toEqual([]);
    extendActiveSeries();
    for (const row of occurrencesOf(seriesId)) expect(row.state).toBe('cancelled');
  });

  it('cancels from one occurrence onwards and leaves the earlier ones standing', async () => {
    const owner = await signIn(OWNER);
    const { body } = await createSeries(owner, { startTime: '09:15' });
    const seriesId = (body.series as { id: string }).id;

    const occurrences = occurrencesOf(seriesId);
    const pivot = occurrences[2]!;

    const response = await app.request(`/v1/admin/schedule/series/${seriesId}/cancel`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Coach on leave from here.', scope: 'future', fromSessionId: pivot.id }),
    });
    expect(response.status).toBe(200);

    for (const row of occurrencesOf(seriesId)) {
      const expected = row.occurrenceDate! >= pivot.occurrenceDate! ? 'cancelled' : 'scheduled';
      expect(`${row.occurrenceDate}:${row.state}`).toBe(`${row.occurrenceDate}:${expected}`);
    }
  });

  it('never touches an occurrence that has already run', async () => {
    const owner = await signIn(OWNER);
    const { body } = await createSeries(owner, { startTime: '08:15' });
    const seriesId = (body.series as { id: string }).id;

    // Backdate one occurrence to yesterday and mark it completed — the shape a
    // class that has happened actually has.
    const first = occurrencesOf(seriesId)[0]!;
    db.update(schema.classSessions)
      .set({ startsAt: now() - DAY, endsAt: now() - DAY + 45 * 60_000, state: 'completed' })
      .where(eq(schema.classSessions.id, first.id))
      .run();

    await app.request(`/v1/admin/schedule/series/${seriesId}/cancel`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Cancelling the whole thing.', scope: 'series' }),
    });

    const historical = db
      .select()
      .from(schema.classSessions)
      .where(eq(schema.classSessions.id, first.id))
      .get()!;
    expect(historical.state).toBe('completed');
    expect(historical.cancelledReason).toBeNull();
  });
});

describe('series isolation', () => {
  it('hides a series at a branch the caller cannot see, as not found', async () => {
    const owner = await signIn(OWNER);
    const manager = await signIn(MANAGER);

    // The manager holds br_kor only. Build the series at br_ind.
    const indRoom = db
      .select({ id: schema.rooms.id })
      .from(schema.rooms)
      .where(eq(schema.rooms.branchId, 'br_ind'))
      .get()!;
    const created = await app.request('/v1/admin/schedule/series', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({
        branchId: 'br_ind',
        classTypeId,
        roomId: indRoom.id,
        trainerId: null,
        weekdays: [5],
        startDate: upcoming(5),
        startTime: '07:45',
        durationMin: 45,
        capacity: 8,
      }),
    });
    expect(created.status).toBe(201);
    const seriesId = ((await created.json()) as { series: { id: string } }).series.id;
    createdSeriesIds.push(seriesId);

    // Not found rather than forbidden — a 403 confirms it exists.
    const read = await app.request(`/v1/admin/schedule/series/${seriesId}`, { headers: headers(manager) });
    expect(read.status).toBe(404);

    const cancel = await app.request(`/v1/admin/schedule/series/${seriesId}/cancel`, {
      method: 'POST',
      headers: headers(manager, true),
      body: JSON.stringify({ reason: 'Should not be possible.', scope: 'series' }),
    });
    expect(cancel.status).toBe(404);

    // And it is absent from the manager's list while present in the owner's.
    const managerList = await app.request('/v1/admin/schedule/series', { headers: headers(manager) });
    expect(((await managerList.json()) as { series: Array<{ id: string }> }).series.map((row) => row.id))
      .not.toContain(seriesId);
    const ownerList = await app.request('/v1/admin/schedule/series', { headers: headers(owner) });
    expect(((await ownerList.json()) as { series: Array<{ id: string }> }).series.map((row) => row.id))
      .toContain(seriesId);
  });

  it('refuses to build a series at a branch outside the caller’s scope', async () => {
    const manager = await signIn(MANAGER);
    const response = await app.request('/v1/admin/schedule/series', {
      method: 'POST',
      headers: headers(manager, true),
      body: JSON.stringify({
        branchId: 'br_ind',
        classTypeId,
        roomId: null,
        trainerId: null,
        weekdays: [2],
        startDate: upcoming(2),
        startTime: '06:45',
        durationMin: 45,
        capacity: 8,
      }),
    });
    expect(response.status).toBe(404);
  });
});

/* ============================================================================
   DST.

   Every branch in the seed is Asia/Kolkata, which has no DST — so this is the
   one class of scheduling bug the rest of the suite structurally cannot see.
   These tests build their own branch in America/New_York and drive the
   generator directly, with an injected clock, across both transitions.

   The bug being guarded against is the obvious implementation: generate the
   first occurrence, then add 7 × 24 hours for each week after. That is correct
   in Kolkata and wrong for half the year everywhere else — "Wednesday 18:30"
   silently becomes 17:30 in spring and 19:30 in autumn.
   ========================================================================= */

const DST_BRANCH = 'br_dst_probe';
const DST_TZ = 'America/New_York';

function seriesRow(overrides: Partial<SeriesRow>): SeriesRow {
  const seriesId = id('ser');
  createdSeriesIds.push(seriesId);
  const row = {
    id: seriesId,
    tenantId: 'ten_shark',
    branchId: DST_BRANCH,
    classTypeId,
    roomId: null,
    trainerId: null,
    frequency: 'weekly',
    interval: 1,
    weekdays: [2],
    startDate: '2027-03-01',
    endDate: '2027-03-31',
    occurrenceCount: null,
    startTime: '18:30',
    durationMin: 45,
    capacity: 10,
    creditsRequired: 0,
    dropInPriceMinor: null,
    lateCancelFeeMinor: 0,
    waitlistEnabled: true,
    bookingOpensMinBefore: null,
    cancelDeadlineMinBefore: null,
    notes: null,
    state: 'active',
    generatedThrough: null,
    supersedesSeriesId: null,
    supersededBySeriesId: null,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  } as SeriesRow;
  db.insert(schema.classSeries).values(row).run();
  return row;
}

describe('a series holds its wall clock across a DST transition', () => {
  beforeAll(() => {
    db.insert(schema.branches)
      .values({
        id: DST_BRANCH,
        tenantId: 'ten_shark',
        name: 'DST Probe',
        slug: 'dst-probe',
        addressLine: '1 Test Way',
        city: 'New York',
        timezone: DST_TZ,
        capacity: 50,
        opensMinutes: 5 * 60,
        closesMinutes: 23 * 60,
        state: 'active',
        amenities: [],
        holidays: [],
        phone: null,
        email: null,
        hours: null,
        policy: {},
        stateChangedAt: null,
        stateNote: null,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  });

  afterAll(() => {
    db.delete(schema.branches).where(eq(schema.branches.id, DST_BRANCH)).run();
  });

  it('keeps 18:30 local across the spring-forward boundary', () => {
    // US spring forward 2027 is Sunday 14 March. Wednesdays either side of it.
    const series = seriesRow({ weekdays: [2], startDate: '2027-03-01', endDate: '2027-03-31' });
    const result = generateOccurrences(series, {
      throughDay: '2027-03-31',
      atMs: Date.parse('2027-02-25T00:00:00Z'),
    });
    expect(result.created).toEqual(['2027-03-03', '2027-03-10', '2027-03-17', '2027-03-24', '2027-03-31']);

    const rows = occurrencesOf(series.id);
    for (const row of rows) expect(localTime(row.startsAt, DST_TZ)).toBe('18:30');

    // The proof it is not 7 × 24h arithmetic: the gap across the transition is
    // an hour shorter than the gaps either side of it.
    const byDate = new Map(rows.map((row) => [row.occurrenceDate!, row.startsAt]));
    const beforeGap = byDate.get('2027-03-10')! - byDate.get('2027-03-03')!;
    const acrossGap = byDate.get('2027-03-17')! - byDate.get('2027-03-10')!;
    expect(beforeGap).toBe(7 * DAY);
    expect(acrossGap).toBe(7 * DAY - 60 * 60 * 1000);
  });

  it('keeps 18:30 local across the autumn fold, where the week is 25 hours longer', () => {
    // US fall back 2027 is Sunday 7 November.
    const series = seriesRow({ weekdays: [2], startDate: '2027-11-01', endDate: '2027-11-30' });
    generateOccurrences(series, {
      throughDay: '2027-11-30',
      atMs: Date.parse('2027-10-25T00:00:00Z'),
    });

    const rows = occurrencesOf(series.id);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) expect(localTime(row.startsAt, DST_TZ)).toBe('18:30');

    const byDate = new Map(rows.map((row) => [row.occurrenceDate!, row.startsAt]));
    expect(byDate.get('2027-11-10')! - byDate.get('2027-11-03')!).toBe(7 * DAY + 60 * 60 * 1000);
  });

  it('resolves a start time that the spring-forward gap deletes', () => {
    // 02:30 does not exist on 14 March 2027 in New York — the clock jumps
    // 02:00 to 03:00. A series scheduled then must still produce a real
    // instant rather than throwing or landing on the previous day.
    const series = seriesRow({
      // 14 March 2027 is a Sunday.
      weekdays: [6],
      startDate: '2027-03-08',
      endDate: '2027-03-21',
      startTime: '02:30',
    });
    const result = generateOccurrences(series, {
      throughDay: '2027-03-21',
      atMs: Date.parse('2027-03-01T00:00:00Z'),
    });
    expect(result.created).toContain('2027-03-14');

    const skipped = occurrencesOf(series.id).find((row) => row.occurrenceDate === '2027-03-14')!;
    // Still on the right calendar day in the branch's own zone, which is the
    // property that actually matters to a timetable.
    expect(isoDate(skipped.startsAt, DST_TZ)).toBe('2027-03-14');
    // And at the first real local minute at or after the requested one.
    expect(localTime(skipped.startsAt, DST_TZ)).toBe('03:00');
  });

  it('counts occurrences from the start of the series, not from the generation window', () => {
    const series = seriesRow({
      weekdays: [0, 2, 4],
      startDate: '2027-03-01',
      endDate: null,
      occurrenceCount: 5,
    });
    // A far horizon must not produce a sixth class.
    expect(occurrenceDates(series, '2027-12-31')).toEqual([
      '2027-03-01', '2027-03-03', '2027-03-05', '2027-03-08', '2027-03-10',
    ]);
    // And a near horizon truncates without changing the count for later.
    expect(occurrenceDates(series, '2027-03-04')).toEqual(['2027-03-01', '2027-03-03']);
  });

  it('honours a fortnightly interval from the week the series starts', () => {
    const series = seriesRow({
      weekdays: [0],
      interval: 2,
      startDate: '2027-03-01',
      endDate: '2027-04-30',
    });
    expect(occurrenceDates(series, '2027-04-30')).toEqual([
      '2027-03-01', '2027-03-15', '2027-03-29', '2027-04-12', '2027-04-26',
    ]);
  });
});
