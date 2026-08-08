import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { WorkoutDraft, type MuscleGroup, type PrescribedSet } from '@shark/contracts';
import {
  MUSCLE_LABEL,
  RULES_VERSION,
  XP_AWARDS,
  adaptLoad,
  applyDailyCap,
  computeStreak,
  estimate1rm,
  levelFor,
  muscleShare,
  platesPerSide,
  recoveryNote,
  recoveryPct,
  sessionVolumeKg,
  volumeWarning,
  type AdaptiveResult,
  type XpAward,
} from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requireBranch, type RequestContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { id as newId } from '../../lib/ids.js';
import { DAY, HOUR, addDays, isoDate, now, relativeTime, startOfWeek } from '../../lib/time.js';
import { conflict, forbidden, notFound, precondition } from '../../lib/errors.js';

/**
 * Member training (UX-M07, PF-WORK).
 *
 * Two jobs live here. The read side answers "what am I doing, and why does it
 * say that?" — the plan, the exercise detail, and the receipt for every
 * adaptive change. The write side is workout persistence: an idempotent sync
 * that the offline logger can replay as often as it likes without double-paying
 * XP or minting a second personal record (PF-WORK-005).
 *
 * Every number the member sees is derived by @shark/domain. Nothing in this
 * file decides a load, a level or a streak on its own.
 */
export const trainingRoutes = new Hono();

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/* ============================================================================
   Shared lookups
   ========================================================================= */

type ExerciseRow = typeof schema.exercises.$inferSelect;
type WorkoutSetRow = typeof schema.workoutSets.$inferSelect;

interface MemberScope {
  memberId: string;
  tenantId: string;
  branchId: string;
  timezone: string;
  today: string;
}

function scopeOf(ctx: RequestContext): MemberScope {
  const memberId = ctx.memberId!;
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) throw notFound('Your membership');

  const branch = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.id, member.homeBranchId), eq(schema.branches.tenantId, ctx.tenantId)))
    .get();
  const timezone = branch?.timezone ?? 'Asia/Kolkata';

  return {
    memberId,
    tenantId: ctx.tenantId,
    branchId: member.homeBranchId,
    timezone,
    today: isoDate(now(), timezone),
  };
}

/** The shared library plus this tenant's own additions. Archived rows stay
 *  resolvable so history never breaks (PF-WORK edge case). */
function exercisesByIds(tenantId: string, ids: string[]): Map<string, ExerciseRow> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = db
    .select()
    .from(schema.exercises)
    .where(
      and(
        inArray(schema.exercises.id, unique),
        sql`(${schema.exercises.tenantId} is null or ${schema.exercises.tenantId} = ${tenantId})`,
      ),
    )
    .all();
  return new Map(rows.map((r) => [r.id, r]));
}

function activeAssignment(scope: MemberScope) {
  return db
    .select()
    .from(schema.assignments)
    .where(
      and(
        eq(schema.assignments.memberId, scope.memberId),
        eq(schema.assignments.tenantId, scope.tenantId),
        eq(schema.assignments.state, 'active'),
      ),
    )
    .orderBy(desc(schema.assignments.createdAt))
    .get();
}

function trainerNameOf(staffId: string | null): string | null {
  if (!staffId) return null;
  return (
    db
      .select({ name: schema.users.name })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.staff.id, staffId))
      .get()?.name ?? null
  );
}

/* ============================================================================
   Recovery — an estimate from logged sets and elapsed time, nothing more.
   Labelled as an estimate everywhere it surfaces (PF-PROG-005).
   ========================================================================= */

interface MuscleState {
  muscle: MuscleGroup;
  label: string;
  weightedSets: number;
  setsLast7d: number;
  hoursSince: number;
  lastWorkedAt: number | null;
  recoveredPct: number;
  note: string;
}

function recoveryMap(scope: MemberScope): Map<MuscleGroup, MuscleState> {
  const since = now() - 7 * DAY;
  const rows = db
    .select({
      doneAt: schema.workoutSets.doneAt,
      primary: schema.exercises.primaryMuscles,
      secondary: schema.exercises.secondaryMuscles,
    })
    .from(schema.workoutSets)
    .innerJoin(schema.exercises, eq(schema.exercises.id, schema.workoutSets.exerciseId))
    .where(
      and(
        eq(schema.workoutSets.memberId, scope.memberId),
        eq(schema.workoutSets.tenantId, scope.tenantId),
        eq(schema.workoutSets.isWarmup, false),
        gte(schema.workoutSets.doneAt, since),
      ),
    )
    .all();

  const tally = new Map<MuscleGroup, { weighted: number; direct: number; last: number }>();
  const bump = (muscle: MuscleGroup, weight: number, at: number, direct: boolean): void => {
    const entry = tally.get(muscle) ?? { weighted: 0, direct: 0, last: 0 };
    entry.weighted += weight;
    if (direct) entry.direct += 1;
    entry.last = Math.max(entry.last, at);
    tally.set(muscle, entry);
  };

  for (const row of rows) {
    for (const m of row.primary) bump(m, 1, row.doneAt, true);
    for (const m of row.secondary) bump(m, 0.5, row.doneAt, false);
  }

  const out = new Map<MuscleGroup, MuscleState>();
  for (const [muscle, entry] of tally) {
    const hoursSince = (now() - entry.last) / HOUR;
    const pct = recoveryPct({ muscle, weightedSets: entry.weighted, hoursSince });
    out.set(muscle, {
      muscle,
      label: MUSCLE_LABEL[muscle],
      weightedSets: Math.round(entry.weighted * 10) / 10,
      setsLast7d: entry.direct,
      hoursSince: Math.round(hoursSince),
      lastWorkedAt: entry.last,
      recoveredPct: pct,
      note: recoveryNote(muscle, pct, entry.direct),
    });
  }
  return out;
}

function recoveredFor(map: Map<MuscleGroup, MuscleState>, muscles: MuscleGroup[]): MuscleState | null {
  let worst: MuscleState | null = null;
  for (const m of muscles) {
    const state = map.get(m);
    if (!state) continue;
    if (!worst || state.recoveredPct < worst.recoveredPct) worst = state;
  }
  return worst;
}

/* ============================================================================
   Lift history
   ========================================================================= */

interface LiftSession {
  workoutId: string;
  at: string;
  atLabel: string;
  startedAt: number;
  workingSets: number;
  topSetKg: number;
  topSetReps: number;
  rpe: number | null;
  volumeKg: number;
  estimated1rm: number | null;
}

function liftHistory(scope: MemberScope, exerciseId: string, limit = 12): LiftSession[] {
  const rows = db
    .select({
      workoutId: schema.workoutSets.workoutId,
      weightKg: schema.workoutSets.weightKg,
      reps: schema.workoutSets.reps,
      rpe: schema.workoutSets.rpe,
      isWarmup: schema.workoutSets.isWarmup,
      doneAt: schema.workoutSets.doneAt,
    })
    .from(schema.workoutSets)
    .where(
      and(
        eq(schema.workoutSets.memberId, scope.memberId),
        eq(schema.workoutSets.tenantId, scope.tenantId),
        eq(schema.workoutSets.exerciseId, exerciseId),
      ),
    )
    .orderBy(desc(schema.workoutSets.doneAt))
    .limit(limit * 12)
    .all();

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = grouped.get(row.workoutId) ?? [];
    bucket.push(row);
    grouped.set(row.workoutId, bucket);
  }

  const sessions: LiftSession[] = [];
  for (const [workoutId, sets] of grouped) {
    const working = sets.filter((s) => !s.isWarmup && s.reps > 0);
    if (working.length === 0) continue;
    const top = working.reduce((best, s) => (s.weightKg > best.weightKg ? s : best), working[0]!);
    const startedAt = Math.min(...working.map((s) => s.doneAt));
    sessions.push({
      workoutId,
      at: isoDate(startedAt, scope.timezone),
      atLabel: relativeTime(startedAt),
      startedAt,
      workingSets: working.length,
      topSetKg: top.weightKg,
      topSetReps: top.reps,
      rpe: top.rpe,
      volumeKg: sessionVolumeKg(working.map((s) => ({ weightKg: s.weightKg, reps: s.reps, isWarmup: false }))),
      estimated1rm: estimate1rm(top.weightKg, top.reps),
    });
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

function lastPerformanceOf(sessions: LiftSession[]): {
  weightKg: number;
  reps: number;
  at: string;
  atLabel: string;
  label: string;
} | null {
  const last = sessions[0];
  if (!last) return null;
  return {
    weightKg: last.topSetKg,
    reps: last.topSetReps,
    at: last.at,
    atLabel: last.atLabel,
    label: last.topSetKg > 0 ? `${last.topSetKg} kg × ${last.topSetReps}` : `${last.topSetReps} reps`,
  };
}

/* ============================================================================
   Prescription helpers
   ========================================================================= */

interface OverrideRow {
  loadKg: number | null;
  substituteExerciseId: string | null;
  reason: string;
  source: string;
}

function overridesFor(scope: MemberScope, assignmentId: string, week: number): Map<string, OverrideRow> {
  const rows = db
    .select()
    .from(schema.assignmentOverrides)
    .where(
      and(
        eq(schema.assignmentOverrides.assignmentId, assignmentId),
        eq(schema.assignmentOverrides.tenantId, scope.tenantId),
        eq(schema.assignmentOverrides.week, week),
      ),
    )
    .all();
  return new Map(
    rows.map((r) => [
      r.programItemId,
      { loadKg: r.loadKg, substituteExerciseId: r.substituteExerciseId, reason: r.reason, source: r.source },
    ]),
  );
}

function targetKgOf(sets: PrescribedSet[]): number {
  const working = sets.filter((s) => !s.isWarmup);
  return working.reduce((best, s) => Math.max(best, s.targetWeightKg ?? 0), 0);
}

function plateLabelFor(exercise: ExerciseRow | undefined, targetKg: number): string | null {
  if (!exercise?.usesBarbell || targetKg <= 0) return null;
  const plates = platesPerSide(targetKg);
  return plates ? `${plates.label} per side` : 'Not loadable with standard plates';
}

function adaptiveFor(
  scope: MemberScope,
  exercise: ExerciseRow,
  sets: PrescribedSet[],
  trainerLocked: boolean,
  reportedInjury: boolean,
  recovery: Map<MuscleGroup, MuscleState>,
): AdaptiveResult {
  const history = liftHistory(scope, exercise.id, 6);
  const working = sets.filter((s) => !s.isWarmup);
  const first = working[0];
  const muscleState = recoveredFor(recovery, exercise.primaryMuscles);

  return adaptLoad({
    exerciseId: exercise.id,
    exerciseName: exercise.name,
    history: history.slice(0, 3).map((h) => ({
      topSetKg: h.topSetKg,
      reps: h.topSetReps,
      rpe: h.rpe,
      hitAllSets: h.workingSets >= working.length,
      at: h.at,
    })),
    prescribedKg: targetKgOf(sets),
    repLow: first?.repLow ?? 8,
    repHigh: first?.repHigh ?? 12,
    targetRpe: first?.targetRpe ?? 8,
    loadStepKg: exercise.loadStepKg,
    trainerLocked,
    recoveredPct: muscleState?.recoveredPct ?? 100,
    daysSinceLastSession: history[0] ? Math.floor((now() - history[0].startedAt) / DAY) : 999,
    reportedInjury,
  });
}

/** The member flagged an injury on their most recent weekly check-in. The
 *  adaptive engine treats that as a hard gate — nothing gets increased. */
function hasReportedInjury(scope: MemberScope): boolean {
  const row = db
    .select()
    .from(schema.weeklyCheckIns)
    .where(
      and(
        eq(schema.weeklyCheckIns.memberId, scope.memberId),
        eq(schema.weeklyCheckIns.tenantId, scope.tenantId),
      ),
    )
    .orderBy(desc(schema.weeklyCheckIns.weekStart))
    .get();
  if (!row) return false;
  return row.safetyEscalated || row.safetySignals.some((s) => s.toLowerCase().includes('injur'));
}

/* ============================================================================
   GET /plan — the assigned plan, the week, and why it says what it says.
   ========================================================================= */

trainingRoutes.get('/plan', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const assignment = activeAssignment(scope);

  const weekStart = startOfWeek(scope.today);
  const todayIndex = Math.max(0, DAY_NAMES.indexOf(
    new Intl.DateTimeFormat('en-GB', { timeZone: scope.timezone, weekday: 'short' }).format(now()) as 'Mon',
  ));

  /* Completed sessions this week, so the day strip shows what actually
     happened rather than what was scheduled. */
  const weekWorkouts = db
    .select({
      id: schema.workouts.id,
      clientId: schema.workouts.clientId,
      title: schema.workouts.title,
      startedAt: schema.workouts.startedAt,
      state: schema.workouts.state,
      volumeKg: schema.workouts.volumeKg,
      totalSets: schema.workouts.totalSets,
    })
    .from(schema.workouts)
    .where(
      and(
        eq(schema.workouts.memberId, scope.memberId),
        eq(schema.workouts.tenantId, scope.tenantId),
        gte(schema.workouts.startedAt, Date.parse(`${weekStart}T00:00:00Z`) - DAY),
      ),
    )
    .orderBy(desc(schema.workouts.startedAt))
    .all();

  const doneByDate = new Map<string, (typeof weekWorkouts)[number]>();
  for (const w of weekWorkouts) {
    if (w.state !== 'completed') continue;
    const date = isoDate(w.startedAt, scope.timezone);
    if (!doneByDate.has(date)) doneByDate.set(date, w);
  }
  const openWorkout = weekWorkouts.find((w) => w.state === 'in_progress') ?? null;

  if (!assignment) {
    return c.json({
      assignment: null,
      program: null,
      week: { number: 0, block: '', startsOn: weekStart, days: [], setsThisWeek: 0, setsLastWeek: 0, volumeWarning: null },
      today: null,
      adaptive: null,
      explanation: null,
      muscleSplit: [],
      resume: openWorkout ? { clientId: openWorkout.clientId, title: openWorkout.title } : null,
    });
  }

  const program = db
    .select()
    .from(schema.programs)
    .where(and(eq(schema.programs.id, assignment.programId), eq(schema.programs.tenantId, scope.tenantId)))
    .get();

  const days = db
    .select()
    .from(schema.programDays)
    .where(
      and(
        eq(schema.programDays.programId, assignment.programId),
        eq(schema.programDays.tenantId, scope.tenantId),
        eq(schema.programDays.week, assignment.currentWeek),
      ),
    )
    .orderBy(schema.programDays.dayIndex)
    .all();

  const itemsByDay = new Map<string, Array<typeof schema.programItems.$inferSelect>>();
  if (days.length > 0) {
    const rows = db
      .select()
      .from(schema.programItems)
      .where(
        and(
          inArray(schema.programItems.programDayId, days.map((d) => d.id)),
          eq(schema.programItems.tenantId, scope.tenantId),
        ),
      )
      .orderBy(schema.programItems.orderIndex)
      .all();
    for (const row of rows) {
      const bucket = itemsByDay.get(row.programDayId) ?? [];
      bucket.push(row);
      itemsByDay.set(row.programDayId, bucket);
    }
  }

  const overrides = overridesFor(scope, assignment.id, assignment.currentWeek);
  const allExerciseIds = [...itemsByDay.values()].flat().flatMap((i) => [
    i.exerciseId,
    ...(overrides.get(i.id)?.substituteExerciseId ? [overrides.get(i.id)!.substituteExerciseId!] : []),
  ]);
  const exercises = exercisesByIds(scope.tenantId, allExerciseIds);

  const weekDays = Array.from({ length: 7 }, (_, dayIndex) => {
    const date = addDays(weekStart, dayIndex);
    const day = days.find((d) => d.dayIndex === dayIndex) ?? null;
    const done = doneByDate.get(date) ?? null;
    const items = day ? (itemsByDay.get(day.id) ?? []) : [];

    const state: 'done' | 'today' | 'planned' | 'rest' = done
      ? 'done'
      : day?.isRest || !day
        ? 'rest'
        : dayIndex === todayIndex
          ? 'today'
          : 'planned';

    return {
      dayIndex,
      dayName: DAY_NAMES[dayIndex]!,
      date,
      programDayId: day?.id ?? null,
      label: day?.label ?? 'Rest',
      focus: day?.focus ?? 'rest',
      isRest: day?.isRest ?? true,
      estimatedMin: day?.estimatedMin ?? 0,
      exerciseCount: items.length,
      setCount: items.reduce((total, i) => total + i.sets.filter((s) => !s.isWarmup).length, 0),
      state,
      isToday: dayIndex === todayIndex,
      past: dayIndex < todayIndex,
      completed: done
        ? { clientId: done.clientId, title: done.title, volumeKg: Math.round(done.volumeKg), totalSets: done.totalSets }
        : null,
    };
  });

  /* — Today ————————————————————————————————————————————————— */

  const todayDay = days.find((d) => d.dayIndex === todayIndex) ?? null;
  const todayItems = todayDay ? (itemsByDay.get(todayDay.id) ?? []) : [];
  const recovery = recoveryMap(scope);
  const injury = hasReportedInjury(scope);

  const items = todayItems.map((item) => {
    const override = overrides.get(item.id) ?? null;
    const baseExercise = exercises.get(item.exerciseId);
    const substitute = override?.substituteExerciseId ? exercises.get(override.substituteExerciseId) : undefined;
    const exercise = substitute ?? baseExercise;

    const sets: PrescribedSet[] = override?.loadKg
      ? item.sets.map((s) => (s.isWarmup ? s : { ...s, targetWeightKg: override.loadKg }))
      : item.sets;
    const targetKg = targetKgOf(sets);

    const history = liftHistory(scope, exercise?.id ?? item.exerciseId, 6);
    const decision = exercise
      ? adaptiveFor(scope, exercise, sets, item.trainerLocked, injury, recovery)
      : null;
    const muscleState = exercise ? recoveredFor(recovery, exercise.primaryMuscles) : null;

    return {
      id: item.id,
      orderIndex: item.orderIndex,
      exerciseId: exercise?.id ?? item.exerciseId,
      exerciseName: exercise?.name ?? 'Exercise removed from the library',
      equipment: exercise?.equipment ?? 'bodyweight',
      primaryMuscles: exercise?.primaryMuscles ?? [],
      muscleLabels: (exercise?.primaryMuscles ?? []).map((m) => MUSCLE_LABEL[m]),
      usesBarbell: exercise?.usesBarbell ?? false,
      mediaUrl: exercise?.mediaUrl ?? null,
      archived: exercise?.archived ?? false,
      targetLabel: item.targetLabel,
      sets,
      targetKg,
      plateLabel: plateLabelFor(exercise, targetKg),
      restSec: sets[0]?.restSec ?? exercise?.defaultRestSec ?? 90,
      supersetGroup: item.supersetGroup,
      tempo: item.tempo,
      notes: item.notes,
      rationale: item.rationale,
      trainerLocked: item.trainerLocked,
      allowedSubstitutionIds: item.allowedSubstitutionIds,
      substitutedFrom:
        substitute && baseExercise ? { exerciseId: baseExercise.id, exerciseName: baseExercise.name, reason: override!.reason } : null,
      lastPerformance: lastPerformanceOf(history),
      recovery: muscleState
        ? { muscle: muscleState.muscle, label: muscleState.label, recoveredPct: muscleState.recoveredPct, note: muscleState.note }
        : null,
      adaptive: decision
        ? {
            changed: decision.changed,
            headline: decision.headline,
            explanation: decision.explanation,
            newLoadKg: decision.newLoadKg,
            confidence: decision.confidence,
            requiresTrainerReview: decision.requiresTrainerReview,
          }
        : null,
    };
  });

  const muscleSplit = muscleShare(
    todayItems.flatMap((item) => {
      const exercise = exercises.get(overrides.get(item.id)?.substituteExerciseId ?? item.exerciseId);
      if (!exercise) return [];
      return item.sets
        .filter((s) => !s.isWarmup)
        .map(() => ({ primary: exercise.primaryMuscles, secondary: exercise.secondaryMuscles }));
    }),
  ).map((m) => ({ muscle: m.muscle, label: MUSCLE_LABEL[m.muscle], sets: m.sets, share: m.share }));

  /* — Weekly volume, flagged only when it jumps ————————————————— */

  const setsIn = (fromIso: string, toIso: string): number =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.workoutSets)
      .where(
        and(
          eq(schema.workoutSets.memberId, scope.memberId),
          eq(schema.workoutSets.tenantId, scope.tenantId),
          eq(schema.workoutSets.isWarmup, false),
          gte(schema.workoutSets.doneAt, Date.parse(`${fromIso}T00:00:00Z`)),
          sql`${schema.workoutSets.doneAt} < ${Date.parse(`${toIso}T00:00:00Z`)}`,
        ),
      )
      .get()?.n ?? 0;

  const setsThisWeek = setsIn(weekStart, addDays(weekStart, 7));
  const setsLastWeek = setsIn(addDays(weekStart, -7), weekStart);

  /* — "Why this week changed" ————————————————————————————————— */

  const pending = db
    .select()
    .from(schema.adaptiveDecisions)
    .where(
      and(
        eq(schema.adaptiveDecisions.memberId, scope.memberId),
        eq(schema.adaptiveDecisions.tenantId, scope.tenantId),
      ),
    )
    .orderBy(desc(schema.adaptiveDecisions.createdAt))
    .get();

  const liveChanges = items
    .filter((i) => i.adaptive?.changed)
    .map((i) => ({
      exerciseName: i.exerciseName,
      field: 'Top set load',
      from: `${i.targetKg} kg`,
      to: `${i.adaptive!.newLoadKg} kg`,
    }));

  const explanation = pending
    ? {
        decisionId: pending.id,
        headline: pending.headline,
        body: pending.explanation,
        inputs: pending.inputs,
        changes: pending.changes,
        confidence: pending.confidence,
        limitations: pending.limitations,
        rulesVersion: pending.rulesVersion,
        reviewedByName: pending.reviewedByName,
        reviewedAt: pending.reviewedAt ? new Date(pending.reviewedAt).toISOString() : null,
        reviewedLabel: pending.reviewedAt ? relativeTime(pending.reviewedAt) : null,
        memberDecision: pending.memberDecision as 'pending' | 'accepted' | 'declined',
        decidable: pending.memberDecision === 'pending',
      }
    : {
        decisionId: null,
        headline: liveChanges.length > 0 ? 'Loads adjusted from your last sessions' : 'Nothing changed this week',
        body:
          liveChanges.length > 0
            ? 'The rules below moved the loads for the exercises listed. Your coach can override any of them.'
            : 'Your recent sessions landed on target, so the prescription holds. Log RPE and the rules will adjust next week.',
        inputs: ['last 3 sessions per lift', 'logged RPE', 'set completion', 'recovery estimate'],
        changes: liveChanges,
        confidence: 'medium' as const,
        limitations:
          'Estimates from what you logged. They do not know how you slept, ate or feel. Tell your coach if anything hurts.',
        rulesVersion: RULES_VERSION,
        reviewedByName: trainerNameOf(assignment.trainerId),
        reviewedAt: null,
        reviewedLabel: null,
        memberDecision: 'accepted' as const,
        decidable: false,
      };

  return c.json({
    assignment: {
      id: assignment.id,
      startsOn: assignment.startsOn,
      currentWeek: assignment.currentWeek,
      currentBlock: assignment.currentBlock,
      state: assignment.state,
      trainerName: trainerNameOf(assignment.trainerId),
      programVersion: assignment.programVersion,
    },
    program: program
      ? {
          id: program.id,
          name: program.name,
          version: program.version,
          goal: program.goal,
          daysPerWeek: program.daysPerWeek,
          weeks: program.weeks,
          authorName: program.authorName,
          description: program.description,
        }
      : null,
    week: {
      number: assignment.currentWeek,
      of: program?.weeks ?? assignment.currentWeek,
      block: assignment.currentBlock,
      startsOn: weekStart,
      days: weekDays,
      setsThisWeek,
      setsLastWeek,
      volumeWarning: volumeWarning(setsThisWeek, setsLastWeek),
    },
    today: todayDay
      ? {
          programDayId: todayDay.id,
          date: scope.today,
          label: todayDay.label,
          focus: todayDay.focus,
          isRest: todayDay.isRest,
          estimatedMin: todayDay.estimatedMin,
          done: doneByDate.has(scope.today),
          items,
        }
      : null,
    adaptive: pending && pending.memberDecision === 'pending'
      ? {
          id: pending.id,
          headline: pending.headline,
          explanation: pending.explanation,
          rulesVersion: pending.rulesVersion,
          reviewedByName: pending.reviewedByName,
        }
      : null,
    explanation,
    muscleSplit,
    injuryHold: injury,
    resume: openWorkout ? { clientId: openWorkout.clientId, title: openWorkout.title } : null,
  });
});

/* ============================================================================
   GET /exercise/:exerciseId — technique, prescription, alternatives, history.
   ========================================================================= */

trainingRoutes.get('/exercise/:exerciseId', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const exerciseId = c.req.param('exerciseId');

  const exercise = exercisesByIds(scope.tenantId, [exerciseId]).get(exerciseId);
  if (!exercise) throw notFound('That exercise');

  const assignment = activeAssignment(scope);
  const recovery = recoveryMap(scope);
  const injury = hasReportedInjury(scope);

  /* Where this lift sits in the member's own plan, if it does at all. */
  let prescription: {
    programItemId: string;
    programDayId: string;
    dayLabel: string;
    dayIndex: number;
    week: number;
    targetLabel: string;
    sets: PrescribedSet[];
    targetKg: number;
    plateLabel: string | null;
    restSec: number;
    tempo: string | null;
    notes: string | null;
    rationale: string | null;
    trainerLocked: boolean;
    supersetGroup: string | null;
    allowedSubstitutionIds: string[];
    isToday: boolean;
  } | null = null;

  if (assignment) {
    const row = db
      .select({ item: schema.programItems, day: schema.programDays })
      .from(schema.programItems)
      .innerJoin(schema.programDays, eq(schema.programDays.id, schema.programItems.programDayId))
      .where(
        and(
          eq(schema.programDays.programId, assignment.programId),
          eq(schema.programDays.week, assignment.currentWeek),
          eq(schema.programItems.exerciseId, exerciseId),
          eq(schema.programItems.tenantId, scope.tenantId),
        ),
      )
      .orderBy(schema.programDays.dayIndex)
      .get();

    if (row) {
      const override = overridesFor(scope, assignment.id, assignment.currentWeek).get(row.item.id) ?? null;
      const sets: PrescribedSet[] = override?.loadKg
        ? row.item.sets.map((s) => (s.isWarmup ? s : { ...s, targetWeightKg: override.loadKg }))
        : row.item.sets;
      const targetKg = targetKgOf(sets);
      const todayIndex = Math.max(0, DAY_NAMES.indexOf(
        new Intl.DateTimeFormat('en-GB', { timeZone: scope.timezone, weekday: 'short' }).format(now()) as 'Mon',
      ));
      prescription = {
        programItemId: row.item.id,
        programDayId: row.day.id,
        dayLabel: row.day.label,
        dayIndex: row.day.dayIndex,
        week: assignment.currentWeek,
        targetLabel: row.item.targetLabel,
        sets,
        targetKg,
        plateLabel: plateLabelFor(exercise, targetKg),
        restSec: sets[0]?.restSec ?? exercise.defaultRestSec,
        tempo: row.item.tempo,
        notes: row.item.notes,
        rationale: row.item.rationale,
        trainerLocked: row.item.trainerLocked,
        supersetGroup: row.item.supersetGroup,
        allowedSubstitutionIds: row.item.allowedSubstitutionIds,
        isToday: row.day.dayIndex === todayIndex,
      };
    }
  }

  /* Alternatives: what the coach allowed on this item, falling back to the
     library's own list when the lift is not in the current plan. */
  const substitutionIds = prescription?.allowedSubstitutionIds.length
    ? prescription.allowedSubstitutionIds
    : exercise.substitutionIds;
  const substitutes = exercisesByIds(scope.tenantId, substitutionIds);
  const alternatives = substitutionIds
    .map((subId) => substitutes.get(subId))
    .filter((e): e is ExerciseRow => Boolean(e) && !e!.archived)
    .map((e) => ({
      id: e.id,
      name: e.name,
      equipment: e.equipment,
      difficulty: e.difficulty,
      primaryMuscles: e.primaryMuscles,
      muscleLabels: e.primaryMuscles.map((m) => MUSCLE_LABEL[m]),
      usesBarbell: e.usesBarbell,
      mediaUrl: e.mediaUrl,
      sameMuscles: e.primaryMuscles.some((m) => exercise.primaryMuscles.includes(m)),
    }));

  const history = liftHistory(scope, exerciseId, 12);
  const trend = history
    .filter((h) => h.estimated1rm !== null)
    .map((h) => ({ at: h.at, atLabel: h.atLabel, value: h.estimated1rm! }))
    .reverse();

  const best1rm = trend.reduce((best, p) => Math.max(best, p.value), 0);
  const firstPoint = trend[0];
  const lastPoint = trend.at(-1);

  const records = db
    .select()
    .from(schema.personalRecords)
    .where(
      and(
        eq(schema.personalRecords.memberId, scope.memberId),
        eq(schema.personalRecords.tenantId, scope.tenantId),
        eq(schema.personalRecords.exerciseId, exerciseId),
        isNull(schema.personalRecords.retiredAt),
      ),
    )
    .orderBy(desc(schema.personalRecords.achievedAt))
    .all()
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      value: r.value,
      display: r.display,
      previousDisplay: r.previousDisplay,
      achievedAt: new Date(r.achievedAt).toISOString(),
      achievedLabel: relativeTime(r.achievedAt),
    }));

  const muscleState = recoveredFor(recovery, exercise.primaryMuscles);
  const decision = prescription
    ? adaptiveFor(scope, exercise, prescription.sets, prescription.trainerLocked, injury, recovery)
    : null;

  return c.json({
    exercise: {
      id: exercise.id,
      slug: exercise.slug,
      name: exercise.name,
      aliases: exercise.aliases,
      equipment: exercise.equipment,
      difficulty: exercise.difficulty,
      primaryMuscles: exercise.primaryMuscles,
      primaryLabels: exercise.primaryMuscles.map((m) => MUSCLE_LABEL[m]),
      secondaryMuscles: exercise.secondaryMuscles,
      secondaryLabels: exercise.secondaryMuscles.map((m) => MUSCLE_LABEL[m]),
      instructions: exercise.instructions,
      cues: exercise.cues,
      contraindications: exercise.contraindications,
      isUnilateral: exercise.isUnilateral,
      usesBarbell: exercise.usesBarbell,
      defaultRestSec: exercise.defaultRestSec,
      loadStepKg: exercise.loadStepKg,
      archived: exercise.archived,
    },
    media: {
      url: exercise.mediaUrl,
      available: Boolean(exercise.mediaUrl),
      /* Instructions and cues carry the technique when video does not load. */
      fallback: 'Demonstration video is not available. The steps and cues below carry the same technique.',
    },
    prescription,
    /** "Why this is in your plan" — the coach's own words, never generated. */
    rationale: prescription?.rationale ?? null,
    trainerLocked: prescription?.trainerLocked ?? false,
    lockNote: prescription?.trainerLocked
      ? 'Your coach has locked this exercise. Loads and swaps stay as written until they change it. Message them if it is not working.'
      : null,
    alternatives,
    canSubstitute: Boolean(prescription) && !prescription!.trainerLocked && alternatives.length > 0,
    recovery: muscleState
      ? {
          muscle: muscleState.muscle,
          label: muscleState.label,
          recoveredPct: muscleState.recoveredPct,
          setsLast7d: muscleState.setsLast7d,
          note: muscleState.note,
        }
      : null,
    adaptive: decision
      ? {
          changed: decision.changed,
          headline: decision.headline,
          explanation: decision.explanation,
          newLoadKg: decision.newLoadKg,
          inputs: decision.inputs,
          confidence: decision.confidence,
          limitations: decision.limitations,
          rulesVersion: decision.rulesVersion,
        }
      : null,
    history: history.map((h) => ({
      at: h.at,
      atLabel: h.atLabel,
      workingSets: h.workingSets,
      topSetKg: h.topSetKg,
      topSetReps: h.topSetReps,
      rpe: h.rpe,
      volumeKg: h.volumeKg,
      estimated1rm: h.estimated1rm,
      label: h.topSetKg > 0 ? `${h.topSetKg} kg × ${h.topSetReps}` : `${h.topSetReps} reps`,
    })),
    estimated1rm: {
      current: lastPoint?.value ?? null,
      best: best1rm > 0 ? best1rm : null,
      points: trend,
      deltaKg: firstPoint && lastPoint ? Math.round((lastPoint.value - firstPoint.value) * 10) / 10 : null,
      note: 'Estimated from your logged top set (Epley). Sets above 12 reps are not estimated.',
    },
    personalRecords: records,
    injuryHold: injury,
  });
});

/* ============================================================================
   POST /adaptive/:id/decision — accept or decline a pending change.
   ========================================================================= */

const DecisionInput = z.object({
  decision: z.enum(['accepted', 'declined']),
  note: z.string().max(500).optional(),
});

trainingRoutes.post('/adaptive/:id/decision', validate('json', DecisionInput), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const decisionId = c.req.param('id');
  const { decision, note } = c.req.valid('json');

  const row = db
    .select()
    .from(schema.adaptiveDecisions)
    .where(
      and(
        eq(schema.adaptiveDecisions.id, decisionId),
        eq(schema.adaptiveDecisions.memberId, scope.memberId),
        eq(schema.adaptiveDecisions.tenantId, scope.tenantId),
      ),
    )
    .get();
  if (!row) throw notFound('That plan change');
  if (row.memberDecision !== 'pending') {
    throw conflict(`You already ${row.memberDecision} this change.`);
  }

  const assignment = db
    .select()
    .from(schema.assignments)
    .where(and(eq(schema.assignments.id, row.assignmentId), eq(schema.assignments.tenantId, scope.tenantId)))
    .get();

  transact(() => {
    db.update(schema.adaptiveDecisions)
      .set({ memberDecision: decision })
      .where(eq(schema.adaptiveDecisions.id, decisionId))
      .run();

    // Accepting writes a per-member override rather than editing the program,
    // so a coach's source plan and everyone else's copy are untouched.
    if (decision === 'accepted' && assignment && row.programItemId) {
      const item = db
        .select()
        .from(schema.programItems)
        .where(eq(schema.programItems.id, row.programItemId))
        .get();
      const loadChange = row.changes.find((ch) => ch.field.toLowerCase().includes('load'));
      const loadKg = loadChange ? Number.parseFloat(loadChange.to) : null;

      if (item && loadKg !== null && Number.isFinite(loadKg)) {
        const existing = db
          .select()
          .from(schema.assignmentOverrides)
          .where(
            and(
              eq(schema.assignmentOverrides.assignmentId, assignment.id),
              eq(schema.assignmentOverrides.programItemId, row.programItemId),
              eq(schema.assignmentOverrides.week, assignment.currentWeek),
            ),
          )
          .get();

        if (existing) {
          db.update(schema.assignmentOverrides)
            .set({ loadKg, reason: row.headline, source: 'adaptive' })
            .where(eq(schema.assignmentOverrides.id, existing.id))
            .run();
        } else {
          db.insert(schema.assignmentOverrides)
            .values({
              id: newId('aov'),
              tenantId: scope.tenantId,
              assignmentId: assignment.id,
              programItemId: row.programItemId,
              week: assignment.currentWeek,
              loadKg,
              substituteExerciseId: null,
              reason: row.headline,
              source: 'adaptive',
              createdAt: now(),
            })
            .run();
        }
      }
    }

    audit(ctx, {
      action: `adaptive.${decision}`,
      entityType: 'adaptive_decision',
      entityId: decisionId,
      entityLabel: row.headline,
      reason: note ?? null,
      branchId: scope.branchId,
      before: { memberDecision: row.memberDecision },
      after: { memberDecision: decision },
    });
  });

  return c.json({
    ok: true,
    id: decisionId,
    memberDecision: decision,
    message:
      decision === 'accepted'
        ? 'Applied to this week. Your coach can see it and change it any time.'
        : 'Left as it was. Your coach will see that you declined and why.',
  });
});

/* ============================================================================
   POST /substitute — record an allowed swap for a program item.
   ========================================================================= */

const SubstituteInput = z.object({
  programItemId: z.string().min(1),
  toExerciseId: z.string().min(1),
  reason: z.string().min(1).max(200),
});

trainingRoutes.post('/substitute', validate('json', SubstituteInput), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const { programItemId, toExerciseId, reason } = c.req.valid('json');

  const assignment = activeAssignment(scope);
  if (!assignment) throw precondition('You do not have a plan assigned, so there is nothing to substitute.');

  const row = db
    .select({ item: schema.programItems, day: schema.programDays })
    .from(schema.programItems)
    .innerJoin(schema.programDays, eq(schema.programDays.id, schema.programItems.programDayId))
    .where(
      and(
        eq(schema.programItems.id, programItemId),
        eq(schema.programItems.tenantId, scope.tenantId),
        eq(schema.programDays.programId, assignment.programId),
      ),
    )
    .get();
  if (!row) throw notFound('That exercise in your plan');

  if (row.item.trainerLocked) {
    throw forbidden('Your coach has locked this exercise. Message them if you need an alternative.');
  }

  const allowed = row.item.allowedSubstitutionIds.length
    ? row.item.allowedSubstitutionIds
    : (exercisesByIds(scope.tenantId, [row.item.exerciseId]).get(row.item.exerciseId)?.substitutionIds ?? []);

  if (!allowed.includes(toExerciseId)) {
    throw forbidden('That is not one of the alternatives your coach allowed for this exercise.');
  }

  const found = exercisesByIds(scope.tenantId, [row.item.exerciseId, toExerciseId]);
  const from = found.get(row.item.exerciseId);
  const to = found.get(toExerciseId);
  if (!to || to.archived) throw notFound('That alternative');

  transact(() => {
    const existing = db
      .select()
      .from(schema.assignmentOverrides)
      .where(
        and(
          eq(schema.assignmentOverrides.assignmentId, assignment.id),
          eq(schema.assignmentOverrides.programItemId, programItemId),
          eq(schema.assignmentOverrides.week, assignment.currentWeek),
        ),
      )
      .get();

    if (existing) {
      db.update(schema.assignmentOverrides)
        .set({ substituteExerciseId: toExerciseId, reason, source: 'member' })
        .where(eq(schema.assignmentOverrides.id, existing.id))
        .run();
    } else {
      db.insert(schema.assignmentOverrides)
        .values({
          id: newId('aov'),
          tenantId: scope.tenantId,
          assignmentId: assignment.id,
          programItemId,
          week: assignment.currentWeek,
          loadKg: null,
          substituteExerciseId: toExerciseId,
          reason,
          source: 'member',
          createdAt: now(),
        })
        .run();
    }

    audit(ctx, {
      action: 'plan.substituted',
      entityType: 'program_item',
      entityId: programItemId,
      entityLabel: `${from?.name ?? 'Exercise'} → ${to.name}`,
      reason,
      branchId: scope.branchId,
      before: { exerciseId: row.item.exerciseId, exerciseName: from?.name ?? null },
      after: { exerciseId: toExerciseId, exerciseName: to.name },
    });
  });

  return c.json({
    ok: true,
    programItemId,
    week: assignment.currentWeek,
    from: from ? { id: from.id, name: from.name } : null,
    to: { id: to.id, name: to.name },
    message: `Swapped to ${to.name} for this week. Your coach can see the swap and the reason.`,
  });
});

/* ============================================================================
   Workout persistence (PF-WORK-004/005).

   The logger owns the screen; this owns the truth. Sync is keyed on the
   client-generated id, so replaying the same draft after a reconnect updates
   the same rows, recomputes the same totals, and pays XP exactly once.
   ========================================================================= */

interface SummaryPr {
  id: string;
  exerciseId: string;
  exerciseName: string;
  kind: 'weight' | 'estimated_1rm';
  value: number;
  display: string;
  previousValue: number | null;
  previousDisplay: string | null;
  delta: string | null;
  achievedAt: string;
  shared: boolean;
}

function summarise(scope: MemberScope, workoutId: string) {
  const workout = db
    .select()
    .from(schema.workouts)
    .where(and(eq(schema.workouts.id, workoutId), eq(schema.workouts.memberId, scope.memberId)))
    .get();
  if (!workout) throw notFound('That workout');

  const sets = db
    .select()
    .from(schema.workoutSets)
    .where(eq(schema.workoutSets.workoutId, workoutId))
    .orderBy(schema.workoutSets.orderIndex, schema.workoutSets.setIndex)
    .all();

  const exercises = exercisesByIds(scope.tenantId, sets.map((s) => s.exerciseId));
  const working = sets.filter((s) => !s.isWarmup && s.reps > 0);

  const split = muscleShare(
    working.flatMap((s) => {
      const e = exercises.get(s.exerciseId);
      return e ? [{ primary: e.primaryMuscles, secondary: e.secondaryMuscles }] : [];
    }),
  ).map((m) => ({ muscle: m.muscle, label: MUSCLE_LABEL[m.muscle], sets: m.sets, share: m.share }));

  const setIds = sets.map((s) => s.id);
  const prs: SummaryPr[] = (
    setIds.length > 0
      ? db
          .select()
          .from(schema.personalRecords)
          .where(
            and(
              eq(schema.personalRecords.memberId, scope.memberId),
              inArray(schema.personalRecords.workoutSetId, setIds),
              isNull(schema.personalRecords.retiredAt),
            ),
          )
          .all()
      : []
  ).map((r) => ({
    id: r.id,
    exerciseId: r.exerciseId,
    exerciseName: exercises.get(r.exerciseId)?.name ?? 'Exercise',
    kind: r.kind as 'weight' | 'estimated_1rm',
    value: r.value,
    display: r.display,
    previousValue: r.previousValue,
    previousDisplay: r.previousDisplay,
    delta:
      r.previousValue !== null ? `+${Math.round((r.value - r.previousValue) * 10) / 10} kg` : null,
    achievedAt: new Date(r.achievedAt).toISOString(),
    shared: r.shared,
  }));

  const refIds = [workoutId, ...prs.map((p) => p.id)];
  const xpAwarded =
    db
      .select({ total: sql<number>`coalesce(sum(${schema.xpLedger.delta}), 0)` })
      .from(schema.xpLedger)
      .where(
        and(
          eq(schema.xpLedger.memberId, scope.memberId),
          inArray(schema.xpLedger.refId, refIds),
        ),
      )
      .get()?.total ?? 0;

  const weekStart = startOfWeek(isoDate(workout.startedAt, scope.timezone));
  const setsBetween = (fromIso: string, toIso: string): number =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.workoutSets)
      .where(
        and(
          eq(schema.workoutSets.memberId, scope.memberId),
          eq(schema.workoutSets.isWarmup, false),
          gte(schema.workoutSets.doneAt, Date.parse(`${fromIso}T00:00:00Z`)),
          sql`${schema.workoutSets.doneAt} < ${Date.parse(`${toIso}T00:00:00Z`)}`,
        ),
      )
      .get()?.n ?? 0;

  const byExercise = [...new Map(working.map((s) => [s.exerciseId, s])).keys()].map((exerciseId) => {
    const own = working.filter((s) => s.exerciseId === exerciseId);
    const top = own.reduce((best, s) => (s.weightKg > best.weightKg ? s : best), own[0]!);
    return {
      exerciseId,
      exerciseName: exercises.get(exerciseId)?.name ?? 'Exercise',
      sets: own.length,
      topSetKg: top.weightKg,
      topSetReps: top.reps,
      volumeKg: sessionVolumeKg(own.map((s) => ({ weightKg: s.weightKg, reps: s.reps, isWarmup: false }))),
      estimated1rm: estimate1rm(top.weightKg, top.reps),
    };
  });

  return {
    id: workout.id,
    clientId: workout.clientId,
    title: workout.title,
    state: workout.state,
    startedAt: new Date(workout.startedAt).toISOString(),
    finishedAt: workout.finishedAt ? new Date(workout.finishedAt).toISOString() : null,
    durationSec: workout.durationSec,
    volumeKg: workout.volumeKg,
    totalSets: workout.totalSets,
    completedSets: working.length,
    exerciseCount: new Set(working.map((s) => s.exerciseId)).size,
    xpAwarded,
    personalRecords: prs,
    muscleVolume: split,
    volumeWarning: volumeWarning(
      setsBetween(weekStart, addDays(weekStart, 7)),
      setsBetween(addDays(weekStart, -7), weekStart),
    ),
    coachNote: workout.coachNote,
    sessionRpe: workout.sessionRpe,
    notes: workout.notes,
    substitutions: workout.substitutions,
    byExercise,
  };
}

trainingRoutes.post('/workouts', validate('json', WorkoutDraft), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const draft = c.req.valid('json');

  if (draft.branchId) requireBranch(ctx, draft.branchId);

  const startedAt = Date.parse(draft.startedAt);
  const finishedAt = draft.finishedAt ? Date.parse(draft.finishedAt) : null;
  if (!Number.isFinite(startedAt)) throw precondition('That session has no valid start time.');

  const exercises = exercisesByIds(scope.tenantId, draft.sets.map((s) => s.exerciseId));
  const missing = draft.sets.find((s) => !exercises.has(s.exerciseId));
  if (missing) throw notFound('One of the exercises in that session');

  const working = draft.sets.filter((s) => !s.isWarmup && s.reps > 0);
  const volumeKg = sessionVolumeKg(
    working.map((s) => ({ weightKg: s.weightKg, reps: s.reps, isWarmup: false })),
  );

  const result = transact(() => {
    const existing = db
      .select()
      .from(schema.workouts)
      .where(and(eq(schema.workouts.memberId, scope.memberId), eq(schema.workouts.clientId, draft.clientId)))
      .get();

    const workoutId = existing?.id ?? newId('wko');
    const durationSec = finishedAt
      ? Math.max(0, Math.round((finishedAt - startedAt) / 1000))
      : (existing?.durationSec ?? 0);

    const row = {
      tenantId: scope.tenantId,
      branchId: draft.branchId ?? scope.branchId,
      memberId: scope.memberId,
      assignmentId: draft.assignmentId,
      programDayId: draft.programDayId,
      clientId: draft.clientId,
      title: draft.title,
      state: draft.state,
      startedAt,
      finishedAt,
      durationSec,
      volumeKg,
      totalSets: draft.sets.length,
      notes: draft.notes,
      sessionRpe: draft.sessionRpe,
      substitutions: draft.substitutions,
      syncedAt: now(),
    };

    if (existing) {
      db.update(schema.workouts).set(row).where(eq(schema.workouts.id, workoutId)).run();
    } else {
      db.insert(schema.workouts).values({ id: workoutId, coachNote: null, reviewedByTrainerAt: null, ...row }).run();
    }

    /* — Sets. The draft is the whole session, so anything it no longer
         carries was deleted on the phone and goes here too. ————— */

    const stored = db
      .select()
      .from(schema.workoutSets)
      .where(eq(schema.workoutSets.workoutId, workoutId))
      .all();
    const storedByClientId = new Map(stored.map((s) => [s.clientId, s]));
    const incoming = new Set(draft.sets.map((s) => s.clientId));

    for (const set of draft.sets) {
      const doneAt = Date.parse(set.doneAt);
      const values = {
        tenantId: scope.tenantId,
        workoutId,
        memberId: scope.memberId,
        clientId: set.clientId,
        exerciseId: set.exerciseId,
        orderIndex: set.orderIndex,
        setIndex: set.setIndex,
        weightKg: set.weightKg,
        reps: set.reps,
        rpe: set.rpe,
        isWarmup: set.isWarmup,
        doneAt: Number.isFinite(doneAt) ? doneAt : startedAt,
      };
      const prior = storedByClientId.get(set.clientId);
      if (prior) {
        db.update(schema.workoutSets).set(values).where(eq(schema.workoutSets.id, prior.id)).run();
      } else {
        db.insert(schema.workoutSets).values({ id: newId('wst'), ...values }).run();
      }
    }

    for (const set of stored) {
      if (!incoming.has(set.clientId)) {
        db.delete(schema.workoutSets).where(eq(schema.workoutSets.id, set.id)).run();
      }
    }

    const savedSets = db
      .select()
      .from(schema.workoutSets)
      .where(eq(schema.workoutSets.workoutId, workoutId))
      .all();

    /* — Personal records. Only against work the member has actually done
         before; a first attempt is a baseline, not a record. ————— */

    const newRecords: Array<{ id: string; exerciseName: string; kind: string; display: string }> = [];

    if (draft.state === 'completed') {
      const byExercise = new Map<string, WorkoutSetRow[]>();
      for (const s of savedSets) {
        if (s.isWarmup || s.reps <= 0 || s.weightKg <= 0) continue;
        const bucket = byExercise.get(s.exerciseId) ?? [];
        bucket.push(s);
        byExercise.set(s.exerciseId, bucket);
      }

      for (const [exerciseId, sets] of byExercise) {
        const exercise = exercises.get(exerciseId);
        if (!exercise) continue;

        const priorSets = db
          .select({ weightKg: schema.workoutSets.weightKg, reps: schema.workoutSets.reps })
          .from(schema.workoutSets)
          .where(
            and(
              eq(schema.workoutSets.memberId, scope.memberId),
              eq(schema.workoutSets.exerciseId, exerciseId),
              eq(schema.workoutSets.isWarmup, false),
              ne(schema.workoutSets.workoutId, workoutId),
            ),
          )
          .all();

        if (priorSets.length === 0) continue;

        const priorRecords = db
          .select()
          .from(schema.personalRecords)
          .where(
            and(
              eq(schema.personalRecords.memberId, scope.memberId),
              eq(schema.personalRecords.exerciseId, exerciseId),
              isNull(schema.personalRecords.retiredAt),
            ),
          )
          .all();

        const bestPrior = (kind: 'weight' | 'estimated_1rm'): number => {
          const fromSets = priorSets.reduce((best, s) => {
            const value = kind === 'weight' ? s.weightKg : (estimate1rm(s.weightKg, s.reps) ?? 0);
            return Math.max(best, value);
          }, 0);
          const fromRecords = priorRecords
            .filter((r) => r.kind === kind)
            .reduce((best, r) => Math.max(best, r.value), 0);
          return Math.max(fromSets, fromRecords);
        };

        const candidates: Array<{ kind: 'weight' | 'estimated_1rm'; set: WorkoutSetRow; value: number }> = [];

        const heaviest = sets.reduce((best, s) => (s.weightKg > best.weightKg ? s : best), sets[0]!);
        candidates.push({ kind: 'weight', set: heaviest, value: heaviest.weightKg });

        let bestEstimate: { set: WorkoutSetRow; value: number } | null = null;
        for (const s of sets) {
          const estimate = estimate1rm(s.weightKg, s.reps);
          if (estimate !== null && (!bestEstimate || estimate > bestEstimate.value)) {
            bestEstimate = { set: s, value: estimate };
          }
        }
        if (bestEstimate) candidates.push({ kind: 'estimated_1rm', set: bestEstimate.set, value: bestEstimate.value });

        for (const candidate of candidates) {
          const previous = bestPrior(candidate.kind);
          if (previous <= 0 || candidate.value <= previous) continue;

          // A resync must not mint the record twice.
          const already = db
            .select({ id: schema.personalRecords.id })
            .from(schema.personalRecords)
            .where(
              and(
                eq(schema.personalRecords.memberId, scope.memberId),
                eq(schema.personalRecords.exerciseId, exerciseId),
                eq(schema.personalRecords.kind, candidate.kind),
                eq(schema.personalRecords.workoutSetId, candidate.set.id),
              ),
            )
            .get();
          if (already) continue;

          const display =
            candidate.kind === 'weight'
              ? `${candidate.value} kg × ${candidate.set.reps}`
              : `${candidate.value} kg est. 1RM`;
          const prId = newId('prc');

          db.insert(schema.personalRecords)
            .values({
              id: prId,
              tenantId: scope.tenantId,
              memberId: scope.memberId,
              exerciseId,
              kind: candidate.kind,
              value: candidate.value,
              display,
              previousValue: previous,
              previousDisplay: `${Math.round(previous * 10) / 10} kg`,
              workoutSetId: candidate.set.id,
              achievedAt: candidate.set.doneAt,
              shared: false,
              retiredAt: null,
            })
            .run();

          newRecords.push({ id: prId, exerciseName: exercise.name, kind: candidate.kind, display });
        }
      }
    }

    /* — XP. Flat awards, daily cap, one payment per source event. ————— */

    if (draft.state === 'completed') {
      const plannedItems = draft.programDayId
        ? db
            .select()
            .from(schema.programItems)
            .where(eq(schema.programItems.programDayId, draft.programDayId))
            .all()
        : [];
      const asPlanned =
        plannedItems.length > 0 &&
        plannedItems.every((item) => {
          const prescribed = item.sets.filter((s) => !s.isWarmup).length;
          const logged = savedSets.filter(
            (s) => s.exerciseId === item.exerciseId && !s.isWarmup && s.reps > 0,
          ).length;
          return logged >= prescribed;
        });

      const wanted: XpAward[] = [
        { delta: XP_AWARDS.workout_completed, reason: 'workout_completed', refType: 'workout', refId: workoutId },
        ...(asPlanned
          ? [
              {
                delta: XP_AWARDS.workout_completed_as_planned,
                reason: 'workout_completed_as_planned' as const,
                refType: 'workout',
                refId: workoutId,
              },
            ]
          : []),
        ...newRecords.map((pr) => ({
          delta: XP_AWARDS.personal_record,
          reason: 'personal_record' as const,
          refType: 'personal_record',
          refId: pr.id,
        })),
      ];

      const unpaid = wanted.filter(
        (award) =>
          !db
            .select({ id: schema.xpLedger.id })
            .from(schema.xpLedger)
            .where(
              and(
                eq(schema.xpLedger.memberId, scope.memberId),
                eq(schema.xpLedger.reason, award.reason),
                eq(schema.xpLedger.refType, award.refType),
                eq(schema.xpLedger.refId, award.refId),
                eq(schema.xpLedger.isCorrection, false),
              ),
            )
            .get(),
      );

      const dayStart = Date.parse(`${scope.today}T00:00:00Z`) - 5.5 * HOUR;
      const alreadyToday =
        db
          .select({ total: sql<number>`coalesce(sum(${schema.xpLedger.delta}), 0)` })
          .from(schema.xpLedger)
          .where(
            and(
              eq(schema.xpLedger.memberId, scope.memberId),
              gte(schema.xpLedger.at, dayStart),
              sql`${schema.xpLedger.delta} > 0`,
            ),
          )
          .get()?.total ?? 0;

      for (const award of applyDailyCap(unpaid, alreadyToday)) {
        db.insert(schema.xpLedger)
          .values({
            id: newId('xpl'),
            tenantId: scope.tenantId,
            memberId: scope.memberId,
            delta: award.delta,
            reason: award.reason,
            refType: award.refType,
            refId: award.refId,
            isCorrection: false,
            at: now(),
          })
          .run();
      }
    }

    /* — Streak ————————————————————————————————————————————————— */

    const sessionDates = db
      .select({ startedAt: schema.workouts.startedAt })
      .from(schema.workouts)
      .where(
        and(
          eq(schema.workouts.memberId, scope.memberId),
          eq(schema.workouts.tenantId, scope.tenantId),
          eq(schema.workouts.state, 'completed'),
        ),
      )
      .orderBy(desc(schema.workouts.startedAt))
      .limit(180)
      .all()
      .map((r) => isoDate(r.startedAt, scope.timezone));

    const streakRow = db
      .select()
      .from(schema.streaksTable)
      .where(eq(schema.streaksTable.memberId, scope.memberId))
      .get();

    const streak = computeStreak({
      sessionDates,
      today: scope.today,
      weeklyTarget: streakRow?.weeklyTarget ?? 4,
      restDaysAllowed: streakRow?.restDaysAllowed ?? 2,
    });

    if (streakRow) {
      db.update(schema.streaksTable)
        .set({
          current: streak.current,
          longest: Math.max(streak.longest, streakRow.longest),
          lastSessionOn: streak.lastSessionOn,
          updatedAt: now(),
        })
        .where(eq(schema.streaksTable.memberId, scope.memberId))
        .run();
    } else {
      db.insert(schema.streaksTable)
        .values({
          memberId: scope.memberId,
          tenantId: scope.tenantId,
          current: streak.current,
          longest: streak.longest,
          weeklyTarget: 4,
          restDaysAllowed: 2,
          lastSessionOn: streak.lastSessionOn,
          updatedAt: now(),
        })
        .run();
    }

    const xpTotal =
      db
        .select({ total: sql<number>`coalesce(sum(${schema.xpLedger.delta}), 0)` })
        .from(schema.xpLedger)
        .where(eq(schema.xpLedger.memberId, scope.memberId))
        .get()?.total ?? 0;

    /* Events are written inside the transaction, so a listener that never
       runs still leaves the row behind for replay. */
    emit({
      tenantId: scope.tenantId,
      branchId: draft.branchId ?? scope.branchId,
      channel: `member:${scope.memberId}`,
      topic: 'workout.synced',
      payload: {
        workoutId,
        clientId: draft.clientId,
        state: draft.state,
        volumeKg,
        totalSets: draft.sets.length,
      },
    });

    for (const pr of newRecords) {
      emit({
        tenantId: scope.tenantId,
        branchId: draft.branchId ?? scope.branchId,
        channel: `member:${scope.memberId}`,
        topic: 'pr.achieved',
        payload: { workoutId, exerciseName: pr.exerciseName, kind: pr.kind, display: pr.display },
      });
    }

    return { workoutId, streak, level: levelFor(xpTotal) };
  });

  return c.json(
    {
      ok: true,
      workoutId: result.workoutId,
      clientId: draft.clientId,
      summary: summarise(scope, result.workoutId),
      streak: {
        current: result.streak.current,
        longest: result.streak.longest,
        thisWeek: result.streak.thisWeek,
        week: result.streak.week,
        atRisk: result.streak.atRisk,
      },
      level: result.level,
    },
    200,
  );
});

trainingRoutes.get('/workouts/:clientId', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const clientId = c.req.param('clientId');

  const workout = db
    .select()
    .from(schema.workouts)
    .where(
      and(
        eq(schema.workouts.memberId, scope.memberId),
        eq(schema.workouts.tenantId, scope.tenantId),
        eq(schema.workouts.clientId, clientId),
      ),
    )
    .get();
  if (!workout) throw notFound('That session');

  const sets = db
    .select()
    .from(schema.workoutSets)
    .where(eq(schema.workoutSets.workoutId, workout.id))
    .orderBy(schema.workoutSets.orderIndex, schema.workoutSets.setIndex)
    .all();

  const exercises = exercisesByIds(scope.tenantId, sets.map((s) => s.exerciseId));

  return c.json({
    workout: {
      id: workout.id,
      clientId: workout.clientId,
      title: workout.title,
      state: workout.state,
      assignmentId: workout.assignmentId,
      programDayId: workout.programDayId,
      branchId: workout.branchId,
      startedAt: new Date(workout.startedAt).toISOString(),
      finishedAt: workout.finishedAt ? new Date(workout.finishedAt).toISOString() : null,
      notes: workout.notes,
      sessionRpe: workout.sessionRpe,
      substitutions: workout.substitutions,
      coachNote: workout.coachNote,
      reviewedByTrainerAt: workout.reviewedByTrainerAt
        ? new Date(workout.reviewedByTrainerAt).toISOString()
        : null,
      syncedAt: new Date(workout.syncedAt).toISOString(),
      sets: sets.map((s) => ({
        clientId: s.clientId,
        exerciseId: s.exerciseId,
        exerciseName: exercises.get(s.exerciseId)?.name ?? 'Exercise',
        orderIndex: s.orderIndex,
        setIndex: s.setIndex,
        weightKg: s.weightKg,
        reps: s.reps,
        rpe: s.rpe,
        isWarmup: s.isWarmup,
        doneAt: new Date(s.doneAt).toISOString(),
      })),
    },
    summary: summarise(scope, workout.id),
  });
});
