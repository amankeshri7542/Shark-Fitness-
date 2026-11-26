import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { DAY, now } from '../lib/time.js';
import { createMember, signIn as signInFixture, type FixtureMember } from './support/fixtures.js';
import { call, signIn, staffIdFor, type TestSession } from './helpers/session.js';

/* ============================================================================
   Member training routes (PF-TRAIN, PF-WORK): the exercise library, one
   exercise in the member's plan, swaps, adaptive decisions and workout sync.
   Every member here is a fixture built for this file, so XP, streaks and
   records written by a sync never touch a seeded member another suite reads.
   ========================================================================= */

const TENANT = 'ten_shark';
const BENCH = 'exr_barbell_bench_press';
const DB_BENCH = 'exr_dumbbell_bench_press';
const SQUAT = 'exr_barbell_back_squat';
const LEG_PRESS = 'exr_leg_press';
const PUSH_UP = 'exr_push_up';

let owner: TestSession;
let athlete: FixtureMember;
let other: FixtureMember;
let athleteSession: TestSession;
let otherSession: TestSession;
let programId = '';
let otherProgramId = '';
let benchItemId = '';
let squatItemId = '';
let legPressItemId = '';
let foreignItemId = '';
let assignmentId = '';
const decisionIds: string[] = [];

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const sets = (weightKg: number) => [
  { setIndex: 0, targetWeightKg: weightKg, repLow: 6, repHigh: 8, targetRpe: 8, restSec: 120, isWarmup: false },
  { setIndex: 1, targetWeightKg: weightKg, repLow: 6, repHigh: 8, targetRpe: 8, restSec: 120, isWarmup: false },
];

async function buildProgram(name: string, items: Array<{ exerciseId: string; locked?: boolean; subs?: string[]; rationale?: string }>) {
  const created = await call(owner, 'POST', '/v1/admin/training/programs', { name, goal: 'strength', daysPerWeek: 1, weeks: 4, description: '' });
  expect(created.status).toBe(201);
  const pid = (await json<{ program: { id: string } }>(created)).program.id;
  const day = await call(owner, 'POST', `/v1/admin/training/programs/${pid}/days`, { week: 1, dayIndex: 0, label: 'Day A', focus: 'Full body' });
  expect(day.status).toBe(201);
  const dayId = (await json<{ day: { id: string } }>(day)).day.id;
  const itemIds: string[] = [];
  for (const item of items) {
    const added = await call(owner, 'POST', `/v1/admin/training/days/${dayId}/items`, {
      exerciseId: item.exerciseId,
      sets: sets(60),
      targetLabel: '2 × 6-8 @ RPE 8',
      trainerLocked: item.locked ?? false,
      allowedSubstitutionIds: item.subs ?? [],
      rationale: item.rationale ?? null,
    });
    expect(added.status).toBe(201);
    itemIds.push((await json<{ item: { id: string } }>(added)).item.id);
  }
  expect((await call(owner, 'POST', `/v1/admin/training/programs/${pid}/publish`)).status).toBe(200);
  return { pid, itemIds };
}

function draft(clientId: string, startedAt: number, lifts: Array<{ exerciseId: string; weightKg: number; reps: number; isWarmup?: boolean }>, state = 'completed') {
  return {
    clientId,
    assignmentId: null,
    programDayId: null,
    branchId: null,
    title: 'Upper body',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: state === 'completed' ? new Date(startedAt + 50 * 60_000).toISOString() : null,
    state,
    sets: lifts.map((lift, index) => ({
      clientId: `${clientId}-set-${index}`,
      exerciseId: lift.exerciseId,
      orderIndex: 0,
      setIndex: index,
      weightKg: lift.weightKg,
      reps: lift.reps,
      rpe: 8,
      isWarmup: lift.isWarmup ?? false,
      doneAt: new Date(startedAt + (index + 1) * 5 * 60_000).toISOString(),
    })),
    notes: null,
    sessionRpe: 8,
    substitutions: [],
  };
}

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  athlete = createMember({ withLogin: true, firstName: 'Trainee' });
  other = createMember({ withLogin: true, firstName: 'Bystander' });
  athleteSession = await signInFixture(athlete.email!);
  otherSession = await signInFixture(other.email!);

  const built = await buildProgram(`P08 member plan ${now()}`, [
    { exerciseId: BENCH, subs: [DB_BENCH], rationale: 'Main press for the block.' },
    { exerciseId: SQUAT, locked: true, subs: ['exr_goblet_squat'] },
    { exerciseId: LEG_PRESS },
  ]);
  programId = built.pid;
  [benchItemId, squatItemId, legPressItemId] = built.itemIds as [string, string, string];

  const foreign = await buildProgram(`P08 unassigned plan ${now()}`, [{ exerciseId: BENCH, subs: [DB_BENCH] }]);
  otherProgramId = foreign.pid;
  foreignItemId = foreign.itemIds[0]!;

  const assigned = await call(owner, 'POST', '/v1/admin/training/assign-program', {
    memberId: athlete.memberId,
    programId,
    startsOn: '2026-01-05',
    trainerId: staffIdFor('rehan@sharkfitness.in'),
  });
  expect(assigned.status).toBe(201);
  assignmentId = (await json<{ assignment: { id: string } }>(assigned)).assignment.id;
});

afterAll(() => {
  const members = [athlete.memberId, other.memberId];
  db.delete(schema.assignmentOverrides).where(eq(schema.assignmentOverrides.assignmentId, assignmentId)).run();
  if (decisionIds.length) db.delete(schema.adaptiveDecisions).where(inArray(schema.adaptiveDecisions.id, decisionIds)).run();
  db.delete(schema.personalRecords).where(inArray(schema.personalRecords.memberId, members)).run();
  db.delete(schema.workoutSets).where(inArray(schema.workoutSets.memberId, members)).run();
  db.delete(schema.workouts).where(inArray(schema.workouts.memberId, members)).run();
  db.update(schema.assignments).set({ state: 'completed' }).where(eq(schema.assignments.id, assignmentId)).run();
  for (const pid of [programId, otherProgramId]) {
    db.update(schema.programs).set({ state: 'archived' }).where(eq(schema.programs.id, pid)).run();
  }
});

describe('GET /v1/member/training/exercises', () => {
  it('lists the active library with the member’s own last working set, and hides archived exercises', async () => {
    const archivedSlug = `p08-archived-${now()}`;
    const created = await call(owner, 'POST', '/v1/admin/training/exercises', {
      slug: archivedSlug,
      name: `P08 Archived Lift ${now()}`,
      equipment: 'barbell',
      primaryMuscles: ['chest'],
    });
    expect(created.status).toBe(201);
    const archivedId = (await json<{ exercise: { id: string } }>(created)).exercise.id;
    expect((await call(owner, 'POST', `/v1/admin/training/exercises/${archivedId}/archive`)).status).toBe(200);

    const before = await json<{ items: Array<{ id: string; name: string; lastPerformance: { label: string } | null }> }>(
      await call(otherSession, 'GET', '/v1/member/training/exercises'),
    );
    const ids = before.items.map((item) => item.id);
    expect(ids).toContain(BENCH);
    expect(ids).not.toContain(archivedId);
    expect(before.items.find((item) => item.id === BENCH)?.lastPerformance).toBeNull();

    const synced = await call(otherSession, 'POST', '/v1/member/training/workouts', draft(`p08-lib-${now()}`, now() - 2 * DAY, [
      { exerciseId: BENCH, weightKg: 20, reps: 12, isWarmup: true },
      { exerciseId: BENCH, weightKg: 55, reps: 8 },
      { exerciseId: PUSH_UP, weightKg: 0, reps: 15 },
    ]));
    expect(synced.status).toBe(200);

    const after = await json<{ items: Array<{ id: string; lastPerformance: { weightKg: number; reps: number; label: string } | null }> }>(
      await call(otherSession, 'GET', '/v1/member/training/exercises'),
    );
    expect(after.items.find((item) => item.id === BENCH)?.lastPerformance).toEqual({ weightKg: 55, reps: 8, label: '55 kg × 8' });
    expect(after.items.find((item) => item.id === PUSH_UP)?.lastPerformance?.label).toBe('15 reps');
  });

  it('is a member-only area', async () => {
    expect((await call(owner, 'GET', '/v1/member/training/exercises')).status).toBe(403);
  });
});

describe('GET /v1/member/training/exercise/:exerciseId', () => {
  it('shows where the lift sits in the member’s plan, with the coach’s rationale and allowed swaps', async () => {
    const body = await json<{
      exercise: { id: string; name: string; primaryMuscles: string[] };
      prescription: { programItemId: string; week: number; targetLabel: string; trainerLocked: boolean; allowedSubstitutionIds: string[] } | null;
      rationale: string | null;
      alternatives: Array<{ id: string }>;
      canSubstitute: boolean;
      lockNote: string | null;
    }>(await call(athleteSession, 'GET', `/v1/member/training/exercise/${BENCH}`));
    expect(body.exercise).toMatchObject({ id: BENCH, name: 'Barbell Bench Press', primaryMuscles: ['chest'] });
    expect(body.prescription).toMatchObject({ programItemId: benchItemId, week: 1, targetLabel: '2 × 6-8 @ RPE 8', trainerLocked: false });
    expect(body.rationale).toBe('Main press for the block.');
    expect(body.alternatives.map((a) => a.id)).toEqual([DB_BENCH]);
    expect(body.canSubstitute).toBe(true);
    expect(body.lockNote).toBeNull();
  });

  it('says a locked lift cannot be swapped, and has no prescription for a member without a plan', async () => {
    const locked = await json<{ trainerLocked: boolean; canSubstitute: boolean; lockNote: string | null }>(
      await call(athleteSession, 'GET', `/v1/member/training/exercise/${SQUAT}`),
    );
    expect(locked.trainerLocked).toBe(true);
    expect(locked.canSubstitute).toBe(false);
    expect(locked.lockNote).toMatch(/locked/);

    const planless = await json<{ prescription: unknown; canSubstitute: boolean }>(
      await call(otherSession, 'GET', `/v1/member/training/exercise/${BENCH}`),
    );
    expect(planless.prescription).toBeNull();
    expect(planless.canSubstitute).toBe(false);
  });

  it('answers 404 for an exercise outside the library', async () => {
    const response = await call(athleteSession, 'GET', '/v1/member/training/exercise/exr_does_not_exist');
    expect(response.status).toBe(404);
  });
});

describe('POST /v1/member/training/substitute', () => {
  it('records an allowed swap as a per-member override for this week, with an audit row', async () => {
    const response = await call(athleteSession, 'POST', '/v1/member/training/substitute', {
      programItemId: benchItemId,
      toExerciseId: DB_BENCH,
      reason: 'Shoulder feels better with dumbbells',
    });
    expect(response.status).toBe(200);
    const body = await json<{ ok: boolean; week: number; from: { id: string }; to: { id: string; name: string } }>(response);
    expect(body).toMatchObject({ ok: true, week: 1, from: { id: BENCH }, to: { id: DB_BENCH, name: 'Dumbbell Bench Press' } });

    const override = db
      .select()
      .from(schema.assignmentOverrides)
      .where(and(eq(schema.assignmentOverrides.assignmentId, assignmentId), eq(schema.assignmentOverrides.programItemId, benchItemId)))
      .all();
    expect(override).toHaveLength(1);
    expect(override[0]).toMatchObject({ week: 1, substituteExerciseId: DB_BENCH, source: 'member', reason: 'Shoulder feels better with dumbbells' });

    const auditRow = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'plan.substituted'), eq(schema.auditLog.entityId, benchItemId)))
      .get();
    expect(auditRow?.reason).toBe('Shoulder feels better with dumbbells');
  });

  it('refuses a locked item, an alternative the coach did not allow, an item outside the plan, and a member with no plan', async () => {
    const locked = await call(athleteSession, 'POST', '/v1/member/training/substitute', { programItemId: squatItemId, toExerciseId: 'exr_goblet_squat', reason: 'Knee' });
    expect(locked.status).toBe(403);

    const notAllowed = await call(athleteSession, 'POST', '/v1/member/training/substitute', { programItemId: benchItemId, toExerciseId: SQUAT, reason: 'Bored' });
    expect(notAllowed.status).toBe(403);

    const foreign = await call(athleteSession, 'POST', '/v1/member/training/substitute', { programItemId: foreignItemId, toExerciseId: DB_BENCH, reason: 'Trying' });
    expect(foreign.status).toBe(404);

    const planless = await call(otherSession, 'POST', '/v1/member/training/substitute', { programItemId: benchItemId, toExerciseId: DB_BENCH, reason: 'Trying' });
    expect(planless.status).toBe(412);

    const invalid = await call(athleteSession, 'POST', '/v1/member/training/substitute', { programItemId: benchItemId, toExerciseId: DB_BENCH, reason: '' });
    expect(invalid.status).toBe(422);

    const overrides = db.select().from(schema.assignmentOverrides).where(eq(schema.assignmentOverrides.assignmentId, assignmentId)).all();
    expect(overrides.map((o) => o.programItemId)).toEqual([benchItemId]);
  });
});

describe('POST /v1/member/training/adaptive/:id/decision', () => {
  function pendingDecision(memberId: string): string {
    const decisionId = id('adp');
    decisionIds.push(decisionId);
    db.insert(schema.adaptiveDecisions)
      .values({
        id: decisionId,
        tenantId: TENANT,
        memberId,
        assignmentId,
        programItemId: legPressItemId,
        rulesVersion: 'test',
        headline: 'Leg press up 2.5 kg',
        explanation: 'Every set hit the top of the range last week.',
        inputs: ['last week: 2 × 8 @ 60 kg'],
        changes: [{ exerciseName: 'Leg Press', field: 'Load', from: '60', to: '62.5' }],
        confidence: 'medium',
        limitations: 'Based on two sessions.',
        reviewedById: null,
        reviewedByName: null,
        reviewedAt: null,
        memberDecision: 'pending',
        createdAt: now(),
      })
      .run();
    return decisionId;
  }

  it('accepting writes a load override for this week only and audits the decision; a second answer is a conflict', async () => {
    const decisionId = pendingDecision(athlete.memberId);
    const response = await call(athleteSession, 'POST', `/v1/member/training/adaptive/${decisionId}/decision`, { decision: 'accepted', note: 'Feels good' });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: true, id: decisionId, memberDecision: 'accepted' });

    expect(db.select().from(schema.adaptiveDecisions).where(eq(schema.adaptiveDecisions.id, decisionId)).get()?.memberDecision).toBe('accepted');
    const override = db
      .select()
      .from(schema.assignmentOverrides)
      .where(and(eq(schema.assignmentOverrides.assignmentId, assignmentId), eq(schema.assignmentOverrides.programItemId, legPressItemId)))
      .get();
    expect(override).toMatchObject({ week: 1, loadKg: 62.5, source: 'adaptive', substituteExerciseId: null });
    // The coach's source plan is untouched.
    const item = db.select().from(schema.programItems).where(eq(schema.programItems.id, legPressItemId)).get();
    expect(item?.sets.every((set) => set.targetWeightKg === 60)).toBe(true);

    const auditRow = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'adaptive.accepted'), eq(schema.auditLog.entityId, decisionId)))
      .get();
    expect(auditRow?.reason).toBe('Feels good');

    // The exercise view now prescribes the overridden load.
    const detail = await json<{ prescription: { targetKg: number } }>(await call(athleteSession, 'GET', `/v1/member/training/exercise/${LEG_PRESS}`));
    expect(detail.prescription.targetKg).toBe(62.5);

    const again = await call(athleteSession, 'POST', `/v1/member/training/adaptive/${decisionId}/decision`, { decision: 'declined' });
    expect(again.status).toBe(409);
  });

  it('declining leaves the plan alone; another member’s decision is 404; a bad decision value is 422', async () => {
    const decisionId = pendingDecision(athlete.memberId);
    const overridesBefore = db.select().from(schema.assignmentOverrides).where(eq(schema.assignmentOverrides.assignmentId, assignmentId)).all();

    expect((await call(otherSession, 'POST', `/v1/member/training/adaptive/${decisionId}/decision`, { decision: 'accepted' })).status).toBe(404);
    expect((await call(athleteSession, 'POST', `/v1/member/training/adaptive/${decisionId}/decision`, { decision: 'maybe' })).status).toBe(422);

    const declined = await call(athleteSession, 'POST', `/v1/member/training/adaptive/${decisionId}/decision`, { decision: 'declined' });
    expect(declined.status).toBe(200);
    expect(await json(declined)).toMatchObject({ memberDecision: 'declined' });
    expect(db.select().from(schema.assignmentOverrides).where(eq(schema.assignmentOverrides.assignmentId, assignmentId)).all()).toEqual(overridesBefore);
  });
});

describe('POST /v1/member/training/workouts and GET /workouts/:clientId', () => {
  it('syncs a session, replays idempotently on the client id, and reads it back', async () => {
    const clientId = `p08-sync-${now()}`;
    const startedAt = now() - 3 * 60 * 60_000;
    const first = draft(clientId, startedAt, [
      { exerciseId: BENCH, weightKg: 20, reps: 10, isWarmup: true },
      { exerciseId: BENCH, weightKg: 60, reps: 8 },
      { exerciseId: BENCH, weightKg: 60, reps: 7 },
    ]);
    const response = await call(athleteSession, 'POST', '/v1/member/training/workouts', first);
    expect(response.status).toBe(200);
    const body = await json<{ ok: boolean; workoutId: string; clientId: string; summary: { state: string; totalSets: number; completedSets: number; volumeKg: number; durationSec: number; byExercise: Array<{ exerciseId: string; sets: number; topSetKg: number }> } }>(response);
    expect(body).toMatchObject({ ok: true, clientId });
    expect(body.summary).toMatchObject({ state: 'completed', totalSets: 3, completedSets: 2, volumeKg: 60 * 8 + 60 * 7, durationSec: 50 * 60 });
    expect(body.summary.byExercise).toEqual([expect.objectContaining({ exerciseId: BENCH, sets: 2, topSetKg: 60 })]);

    // Replaying the same draft with one set dropped updates the same workout.
    const replay = await call(athleteSession, 'POST', '/v1/member/training/workouts', { ...first, sets: first.sets.slice(0, 2), notes: 'Cut short' });
    expect(replay.status).toBe(200);
    expect((await json<{ workoutId: string }>(replay)).workoutId).toBe(body.workoutId);
    expect(db.select().from(schema.workouts).where(and(eq(schema.workouts.memberId, athlete.memberId), eq(schema.workouts.clientId, clientId))).all()).toHaveLength(1);
    expect(db.select().from(schema.workoutSets).where(eq(schema.workoutSets.workoutId, body.workoutId)).all()).toHaveLength(2);

    const read = await call(athleteSession, 'GET', `/v1/member/training/workouts/${clientId}`);
    expect(read.status).toBe(200);
    const readBody = await json<{ workout: { id: string; notes: string | null; state: string; sets: Array<{ clientId: string; exerciseName: string; weightKg: number; isWarmup: boolean }> }; summary: { id: string } }>(read);
    expect(readBody.workout).toMatchObject({ id: body.workoutId, notes: 'Cut short', state: 'completed' });
    expect(readBody.workout.sets.map((s) => [s.clientId, s.exerciseName, s.weightKg, s.isWarmup])).toEqual([
      [`${clientId}-set-0`, 'Barbell Bench Press', 20, true],
      [`${clientId}-set-1`, 'Barbell Bench Press', 60, false],
    ]);
    expect(readBody.summary.id).toBe(body.workoutId);
  });

  it('records a personal record only against earlier work', async () => {
    const latest = db.select().from(schema.personalRecords).where(eq(schema.personalRecords.memberId, athlete.memberId)).all();
    expect(latest).toHaveLength(0); // a first attempt is a baseline

    const heavier = await call(athleteSession, 'POST', '/v1/member/training/workouts', draft(`p08-pr-${now()}`, now() - 60 * 60_000, [
      { exerciseId: BENCH, weightKg: 70, reps: 5 },
      { exerciseId: BENCH, weightKg: 70, reps: 5 },
    ]));
    expect(heavier.status).toBe(200);
    const summary = (await json<{ summary: { personalRecords: Array<{ kind: string; value: number; previousValue: number | null }> } }>(heavier)).summary;
    expect(summary.personalRecords).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'weight', value: 70, previousValue: 60 })]));
    const stored = db
      .select()
      .from(schema.personalRecords)
      .where(and(eq(schema.personalRecords.memberId, athlete.memberId), eq(schema.personalRecords.kind, 'weight')))
      .orderBy(desc(schema.personalRecords.achievedAt))
      .get();
    expect(stored).toMatchObject({ exerciseId: BENCH, value: 70, previousValue: 60 });
  });

  it('refuses an unknown exercise and a malformed draft, and keeps sessions private to their member', async () => {
    const badClientId = `p08-bad-${now()}`;
    const unknown = await call(athleteSession, 'POST', '/v1/member/training/workouts', draft(badClientId, now(), [{ exerciseId: 'exr_not_real', weightKg: 10, reps: 5 }]));
    expect(unknown.status).toBe(404);
    expect(db.select().from(schema.workouts).where(eq(schema.workouts.clientId, badClientId)).all()).toHaveLength(0);

    const malformed = await call(athleteSession, 'POST', '/v1/member/training/workouts', { ...draft(`p08-bad2-${now()}`, now(), []), state: 'paused' });
    expect(malformed.status).toBe(422);

    const mine = db.select().from(schema.workouts).where(eq(schema.workouts.memberId, athlete.memberId)).get()!;
    expect((await call(otherSession, 'GET', `/v1/member/training/workouts/${mine.clientId}`)).status).toBe(404);
    expect((await call(athleteSession, 'GET', '/v1/member/training/workouts/never-synced')).status).toBe(404);
  });
});
