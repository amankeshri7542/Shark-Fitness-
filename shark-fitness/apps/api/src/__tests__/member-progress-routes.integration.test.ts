import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { DAY, addDays, isoDate, now } from '../lib/time.js';
import { createMember, signIn as signInFixture, type FixtureMember } from './support/fixtures.js';
import { call, signIn, type TestSession } from './helpers/session.js';

/* ============================================================================
   Member progress routes (UX-M08, PF-PROG): the overview, recovery estimate,
   one lift's strength line, records, measurements and goals. One fixture
   member per role in the story, so nothing here moves a seeded member's
   numbers.
   ========================================================================= */

const BENCH = 'exr_barbell_bench_press';

let lifter: FixtureMember;
let other: FixtureMember;
let lifterSession: TestSession;
let otherSession: TestSession;
let today = '';

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function workout(clientId: string, startedAt: number, lifts: Array<{ weightKg: number; reps: number }>) {
  return {
    clientId,
    assignmentId: null,
    programDayId: null,
    branchId: null,
    title: 'Press day',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(startedAt + 45 * 60_000).toISOString(),
    state: 'completed',
    sets: lifts.map((lift, index) => ({
      clientId: `${clientId}-${index}`,
      exerciseId: BENCH,
      orderIndex: 0,
      setIndex: index,
      weightKg: lift.weightKg,
      reps: lift.reps,
      rpe: 8,
      isWarmup: false,
      doneAt: new Date(startedAt + (index + 1) * 4 * 60_000).toISOString(),
    })),
    notes: null,
    sessionRpe: 8,
    substitutions: [],
  };
}

beforeAll(async () => {
  lifter = createMember({ withLogin: true, firstName: 'Lifter' });
  other = createMember({ withLogin: true, firstName: 'Neighbour' });
  lifterSession = await signInFixture(lifter.email!);
  otherSession = await signInFixture(other.email!);
  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, 'br_kor')).get()!;
  today = isoDate(now(), branch.timezone);
});

afterAll(() => {
  const members = [lifter.memberId, other.memberId];
  db.delete(schema.goals).where(inArray(schema.goals.memberId, members)).run();
  db.delete(schema.measurements).where(inArray(schema.measurements.memberId, members)).run();
  db.delete(schema.personalRecords).where(inArray(schema.personalRecords.memberId, members)).run();
  db.delete(schema.workoutSets).where(inArray(schema.workoutSets.memberId, members)).run();
  db.delete(schema.workouts).where(inArray(schema.workouts.memberId, members)).run();
});

describe('empty history is reported as empty, not drawn', () => {
  it('GET /v1/member/progress shapes the requested window and says there is too little data', async () => {
    const response = await call(lifterSession, 'GET', '/v1/member/progress');
    expect(response.status).toBe(200);
    const body = await json<{
      rangeWeeks: number;
      weeklyTonnage: Array<{ value: number; partial: boolean }>;
      attendance: unknown[];
      latestMeasurement: unknown;
      goals: unknown[];
      strengthOptions: unknown[];
      insufficientData: string | null;
      newPrCount: number;
      estimateNote: string;
    }>(response);
    expect(body.rangeWeeks).toBe(12);
    expect(body.weeklyTonnage).toHaveLength(12);
    expect(body.attendance).toHaveLength(12);
    expect(body.weeklyTonnage.at(-1)?.partial).toBe(true);
    expect(body.weeklyTonnage.every((week) => week.value === 0)).toBe(true);
    expect(body).toMatchObject({ latestMeasurement: null, goals: [], strengthOptions: [], newPrCount: 0 });
    expect(body.insufficientData).toEqual(expect.any(String));
    expect(body.estimateNote).toMatch(/not a measurement of your body/);

    const narrow = await json<{ weeklyTonnage: unknown[] }>(await call(lifterSession, 'GET', '/v1/member/progress?weeks=4'));
    expect(narrow.weeklyTonnage).toHaveLength(4);
    expect((await call(lifterSession, 'GET', '/v1/member/progress?weeks=3')).status).toBe(422);
  });

  it('GET /v1/member/progress/recovery has nothing to estimate from', async () => {
    const body = await json<{ estimate: boolean; trainedCount: number; summary: string; regions: Array<{ recoveredPct: number; lastWorkedAt: string | null }> }>(
      await call(lifterSession, 'GET', '/v1/member/progress/recovery'),
    );
    expect(body.estimate).toBe(true);
    expect(body.trainedCount).toBe(0);
    expect(body.summary).toMatch(/Nothing logged in the last 90 days/);
    expect(body.regions.every((region) => region.recoveredPct === 100 && region.lastWorkedAt === null)).toBe(true);
  });

  it('is a member-only area', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    expect((await call(owner, 'GET', '/v1/member/progress')).status).toBe(403);
    expect((await call(owner, 'GET', '/v1/member/progress/records')).status).toBe(403);
  });
});

describe('POST /v1/member/progress/measurements', () => {
  it('saves a reading, corrects the same day instead of duplicating it, and flags an implausible jump', async () => {
    const earlier = addDays(today, -21);
    const first = await call(lifterSession, 'POST', '/v1/member/progress/measurements', { takenOn: earlier, weightKg: 80, waistCm: 84 });
    expect(first.status).toBe(201);
    expect(await json(first)).toMatchObject({ replaced: false, outlier: false, outlierNote: null, measurement: { takenOn: earlier, weightKg: 80, source: 'self' } });

    const corrected = await call(lifterSession, 'POST', '/v1/member/progress/measurements', { takenOn: earlier, weightKg: 80.5, waistCm: 84 });
    expect(corrected.status).toBe(200);
    expect(await json(corrected)).toMatchObject({ replaced: true, measurement: { weightKg: 80.5 } });
    expect(db.select().from(schema.measurements).where(eq(schema.measurements.memberId, lifter.memberId)).all()).toHaveLength(1);

    const jump = await call(lifterSession, 'POST', '/v1/member/progress/measurements', { takenOn: today, weightKg: 90, source: 'device' });
    expect(jump.status).toBe(201);
    const jumpBody = await json<{ outlier: boolean; outlierNote: string | null; measurement: { source: string } }>(jump);
    expect(jumpBody.outlier).toBe(true);
    expect(jumpBody.outlierNote).toMatch(/weight moved 9.5 kg in 21 days/);
    expect(jumpBody.measurement.source).toBe('device');
    expect(db.select().from(schema.measurements).where(and(eq(schema.measurements.memberId, lifter.memberId), eq(schema.measurements.takenOn, today))).get()?.outlier).toBe(true);
  });

  it('refuses a future date, an empty reading and an out-of-range number, saving nothing', async () => {
    const future = await call(lifterSession, 'POST', '/v1/member/progress/measurements', { takenOn: addDays(today, 2), weightKg: 80 });
    expect(future.status).toBe(422);
    const empty = await call(lifterSession, 'POST', '/v1/member/progress/measurements', { takenOn: addDays(today, -1) });
    expect(empty.status).toBe(422);
    const absurd = await call(lifterSession, 'POST', '/v1/member/progress/measurements', { takenOn: addDays(today, -1), weightKg: 5 });
    expect(absurd.status).toBe(422);
    expect(db.select().from(schema.measurements).where(eq(schema.measurements.memberId, lifter.memberId)).all()).toHaveLength(2);
  });

  it('feeds the overview: latest reading, trend with the outlier marked, and the delta against the baseline', async () => {
    const body = await json<{
      latestMeasurement: { takenOn: string; weightKg: number; outlier: boolean };
      measurementTrend: Array<{ at: string; value: number; estimated: boolean }>;
      bodyComposition: { comparedWith: string | null; outlier: boolean; items: Array<{ key: string; value: number | null; delta: number | null }> };
    }>(await call(lifterSession, 'GET', '/v1/member/progress'));
    expect(body.latestMeasurement).toMatchObject({ takenOn: today, weightKg: 90, outlier: true });
    expect(body.measurementTrend).toEqual([
      expect.objectContaining({ at: addDays(today, -21), value: 80.5, estimated: false }),
      expect.objectContaining({ at: today, value: 90, estimated: true }),
    ]);
    expect(body.bodyComposition.comparedWith).toBe(addDays(today, -21));
    expect(body.bodyComposition.items.find((item) => item.key === 'weightKg')).toMatchObject({ value: 90, delta: 9.5 });
    // The latest reading had no waist, so there is nothing to compare.
    expect(body.bodyComposition.items.find((item) => item.key === 'waistCm')).toMatchObject({ value: null, delta: null });
  });
});

describe('strength, recovery and records from logged sets', () => {
  beforeAll(async () => {
    const baseline = await call(lifterSession, 'POST', '/v1/member/training/workouts', workout(`p08-prog-a-${now()}`, now() - 8 * DAY, [
      { weightKg: 60, reps: 8 },
      { weightKg: 60, reps: 8 },
    ]));
    expect(baseline.status).toBe(200);
    const heavier = await call(lifterSession, 'POST', '/v1/member/training/workouts', workout(`p08-prog-b-${now()}`, now() - 2 * 60 * 60_000, [
      { weightKg: 70, reps: 5 },
      { weightKg: 70, reps: 5 },
    ]));
    expect(heavier.status).toBe(200);
  });

  it('GET /strength/:exerciseId plots the best set per week and declines to draw a trend from two weeks', async () => {
    const response = await call(lifterSession, 'GET', `/v1/member/progress/strength/${BENCH}`);
    expect(response.status).toBe(200);
    const body = await json<{
      exerciseName: string;
      metric: string;
      points: Array<{ value: number; topSetKg: number; topSetReps: number; estimated: boolean }>;
      insufficientData: string | null;
      reading: string;
      bestSet: { weightKg: number; reps: number } | null;
      currentDisplay: string;
      changeLabel: string;
    }>(response);
    expect(body).toMatchObject({ exerciseName: 'Barbell Bench Press', metric: 'estimated_1rm', bestSet: { weightKg: 70, reps: 5 }, currentDisplay: '81.7 kg' });
    expect(body.points.map((p) => [p.value, p.topSetKg, p.topSetReps])).toEqual([
      [76, 60, 8],
      [81.7, 70, 5],
    ]);
    expect(body.insufficientData).toMatch(/Only 2 weeks of Barbell Bench Press logged/);
    expect(body.reading).toBe(body.insufficientData);
    expect(body.changeLabel).toBe('+5.7 kg · 2 weeks');

    expect((await call(lifterSession, 'GET', '/v1/member/progress/strength/exr_not_real')).status).toBe(404);
    expect((await call(lifterSession, 'GET', `/v1/member/progress/strength/${BENCH}?weeks=27`)).status).toBe(422);

    const none = await json<{ points: unknown[]; insufficientData: string; bestSet: unknown }>(
      await call(otherSession, 'GET', `/v1/member/progress/strength/${BENCH}`),
    );
    expect(none.points).toEqual([]);
    expect(none.bestSet).toBeNull();
    expect(none.insufficientData).toMatch(/No working sets of Barbell Bench Press/);
  });

  it('GET /recovery estimates the chest from the last bout and counts only the last seven days', async () => {
    const body = await json<{ trainedCount: number; summary: string; regions: Array<{ muscle: string; recoveredPct: number; lastWorkedAt: string | null; setsLast7d: number }> }>(
      await call(lifterSession, 'GET', '/v1/member/progress/recovery'),
    );
    const chest = body.regions.find((region) => region.muscle === 'chest')!;
    expect(chest.lastWorkedAt).not.toBeNull();
    expect(chest.recoveredPct).toBeLessThan(100);
    expect(chest.setsLast7d).toBe(2);
    const untouched = body.regions.find((region) => region.muscle === 'hamstrings')!;
    expect(untouched).toMatchObject({ recoveredPct: 100, lastWorkedAt: null, setsLast7d: 0 });
    expect(body.trainedCount).toBe(body.regions.filter((region) => region.lastWorkedAt !== null).length);
    expect(body.trainedCount).toBeGreaterThanOrEqual(1);
    expect(body.summary).not.toMatch(/Nothing logged/);
  });

  it('GET /records lists the records the second session set, with the improvement over the first', async () => {
    const response = await call(lifterSession, 'GET', '/v1/member/progress/records');
    expect(response.status).toBe(200);
    const body = await json<{ total: number; newInLast30: number; items: Array<{ exerciseId: string; exerciseName: string; kind: string; value: number; previousValue: number | null; delta: string | null; improved: boolean; isNew: boolean }> }>(response);
    expect(body.total).toBe(body.items.length);
    const weight = body.items.find((item) => item.kind === 'weight');
    expect(weight).toMatchObject({ exerciseId: BENCH, exerciseName: 'Barbell Bench Press', value: 70, previousValue: 60, delta: '+10 kg', improved: true, isNew: true });
    expect(body.items.find((item) => item.kind === 'estimated_1rm')).toMatchObject({ value: 81.7, previousValue: 76 });
    expect(body.newInLast30).toBe(body.items.length);

    const empty = await json<{ total: number; items: unknown[] }>(await call(otherSession, 'GET', '/v1/member/progress/records'));
    expect(empty).toMatchObject({ total: 0, items: [] });
  });
});

describe('goals', () => {
  let liftGoalId = '';

  it('POST /goals creates a lift goal read from logged sets, and audits it', async () => {
    const response = await call(lifterSession, 'POST', '/v1/member/progress/goals', {
      kind: 'lift',
      title: 'Bench 100',
      baseline: 60,
      target: 100,
      unit: 'kg',
      targetDate: addDays(today, 120),
      refExerciseId: BENCH,
    });
    expect(response.status).toBe(201);
    const body = await json<{ goal: { id: string; state: string; current: number; progressPct: number; sourceNote: string; daysRemaining: number } }>(response);
    liftGoalId = body.goal.id;
    expect(body.goal).toMatchObject({ state: 'active', current: 70, progressPct: 25, sourceNote: 'Your heaviest logged working set.', daysRemaining: 120 });
    const row = db.select().from(schema.goals).where(eq(schema.goals.id, liftGoalId)).get();
    expect(row).toMatchObject({ memberId: lifter.memberId, kind: 'lift', baseline: 60, target: 100, refExerciseId: BENCH });
    expect(db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'goal.created'), eq(schema.auditLog.entityId, liftGoalId))).get()).toBeTruthy();

    const bodyweight = await json<{ goal: { current: number; sourceNote: string } }>(
      await call(lifterSession, 'POST', '/v1/member/progress/goals', { kind: 'bodyweight', title: 'Cut to 82', baseline: 90, target: 82, unit: 'kg', targetDate: addDays(today, 180) }),
    );
    expect(bodyweight.goal.current).toBe(90);
    expect(bodyweight.goal.sourceNote).toMatch(/Your latest measurement/);
  });

  it('POST /goals refuses a date that is not in the future and a target equal to the baseline', async () => {
    const before = db.select().from(schema.goals).where(eq(schema.goals.memberId, lifter.memberId)).all().length;
    const past = await call(lifterSession, 'POST', '/v1/member/progress/goals', { kind: 'event', title: 'Meet', baseline: 0, target: 1, unit: 'x', targetDate: today });
    expect(past.status).toBe(422);
    const flat = await call(lifterSession, 'POST', '/v1/member/progress/goals', { kind: 'event', title: 'Meet', baseline: 1, target: 1, unit: 'x', targetDate: addDays(today, 10) });
    expect(flat.status).toBe(422);
    const malformed = await call(lifterSession, 'POST', '/v1/member/progress/goals', { kind: 'vibes', title: 'Meet', baseline: 0, target: 1, unit: 'x', targetDate: addDays(today, 10) });
    expect(malformed.status).toBe(422);
    expect(db.select().from(schema.goals).where(eq(schema.goals.memberId, lifter.memberId)).all()).toHaveLength(before);
  });

  it('PATCH /goals/:id edits and retires a goal, audited each time, and retired goals leave the overview', async () => {
    const edited = await call(lifterSession, 'PATCH', `/v1/member/progress/goals/${liftGoalId}`, { title: 'Bench 95', target: 95 });
    expect(edited.status).toBe(200);
    expect(await json(edited)).toMatchObject({ goal: { id: liftGoalId, title: 'Bench 95', target: 95 } });
    expect(db.select().from(schema.goals).where(eq(schema.goals.id, liftGoalId)).get()).toMatchObject({ title: 'Bench 95', target: 95 });
    expect(db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'goal.updated'), eq(schema.auditLog.entityId, liftGoalId))).get()).toBeTruthy();

    const retired = await call(lifterSession, 'PATCH', `/v1/member/progress/goals/${liftGoalId}`, { state: 'retired' });
    expect(retired.status).toBe(200);
    expect(await json(retired)).toMatchObject({ goal: { state: 'retired', onTrack: true }, paceWarning: null });
    expect(db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'goal.retired'), eq(schema.auditLog.entityId, liftGoalId))).get()).toBeTruthy();

    const overview = await json<{ goals: Array<{ id: string }> }>(await call(lifterSession, 'GET', '/v1/member/progress'));
    expect(overview.goals.map((goal) => goal.id)).not.toContain(liftGoalId);
    expect(overview.goals).toHaveLength(1);
  });

  it('PATCH /goals/:id refuses another member’s goal, an empty patch and a past date on an active goal', async () => {
    const stillActive = db.select().from(schema.goals).where(and(eq(schema.goals.memberId, lifter.memberId), eq(schema.goals.state, 'active'))).get()!;
    expect((await call(otherSession, 'PATCH', `/v1/member/progress/goals/${stillActive.id}`, { title: 'Hijacked' })).status).toBe(404);
    expect((await call(lifterSession, 'PATCH', `/v1/member/progress/goals/${stillActive.id}`, {})).status).toBe(422);
    expect((await call(lifterSession, 'PATCH', `/v1/member/progress/goals/${stillActive.id}`, { targetDate: addDays(today, -1) })).status).toBe(422);
    expect(db.select().from(schema.goals).where(eq(schema.goals.id, stillActive.id)).get()).toMatchObject({ title: stillActive.title, targetDate: stillActive.targetDate });
  });
});
