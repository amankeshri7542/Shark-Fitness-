import { Hono } from 'hono';
import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { MuscleGroup } from '@shark/contracts';
import {
  MUSCLE_LABEL,
  estimate1rm,
  goalPaceWarning,
  recoveryNote,
  recoveryPct,
} from '@shark/domain';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { audit } from '../../lib/audit.js';
import { id } from '../../lib/ids.js';
import { invalid, notFound } from '../../lib/errors.js';
import {
  DAY,
  HOUR,
  addDays,
  daysBetween,
  isoDate,
  now,
  relativeTime,
  startOfWeek,
} from '../../lib/time.js';

export const progressRoutes = new Hono();

/**
 * Member progress (UX-M08, PF-PROG).
 *
 * Two rules shape this file.
 *
 * 1. Nothing here is presented as a measurement of the body. Recovery, one-rep
 *    maxes and body composition are arithmetic on sets the member typed in, and
 *    every one of them ships the sentence that says so (PF-PROG-005).
 * 2. A thin week is reported as a thin week. Where there is not enough history
 *    to draw an honest line, the payload says `insufficientData` and the screen
 *    prints that instead of a confident curve.
 */

/* ============================================================================
   Scope + small helpers
   ========================================================================= */

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const round1 = (n: number): number => Math.round(n * 10) / 10;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Scope {
  memberId: string;
  tz: string;
  today: string;
  weeklyTarget: number;
  holidays: string[];
  unitSystem: 'metric' | 'imperial';
  branchName: string;
}

function scopeOf(c: Parameters<Parameters<Hono['get']>[1]>[0]): Scope {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;

  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get();
  if (!member) throw notFound('Your membership');

  const branch = db
    .select()
    .from(schema.branches)
    .where(eq(schema.branches.id, member.homeBranchId))
    .get();

  const streak = db
    .select()
    .from(schema.streaksTable)
    .where(eq(schema.streaksTable.memberId, memberId))
    .get();

  const user = db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).get();
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get();

  const tz = branch?.timezone ?? tenant?.timezone ?? 'Asia/Kolkata';
  const preferred = (user?.preferences as { unitSystem?: string } | undefined)?.unitSystem;

  return {
    memberId,
    tz,
    today: isoDate(now(), tz),
    weeklyTarget: streak?.weeklyTarget ?? 4,
    holidays: branch?.holidays ?? [],
    unitSystem: preferred === 'imperial' ? 'imperial' : 'metric',
    branchName: branch?.name ?? '',
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "4 Aug" — short enough for a 12-column axis, unambiguous in a tooltip. */
function dayLabel(isoDay: string): string {
  const [, m, d] = isoDay.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`;
}

interface Week {
  start: string;
  end: string;
  label: string;
  current: boolean;
}

function weekWindow(today: string, count: number): Week[] {
  const thisWeek = startOfWeek(today);
  const out: Week[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = addDays(thisWeek, -7 * i);
    out.push({ start, end: addDays(start, 6), label: dayLabel(start), current: i === 0 });
  }
  return out;
}

/** Days the branch was shut inside a week, counting only days already past —
 *  a holiday later this week has not cost anyone a session yet. */
function closedDaysIn(week: Week, holidays: string[], today: string): number {
  return holidays.filter((h) => h >= week.start && h <= week.end && h <= today).length;
}

type ExerciseMuscles = { name: string; primary: MuscleGroup[]; secondary: MuscleGroup[] };

function exerciseIndex(tenantId: string): Map<string, ExerciseMuscles> {
  const rows = db
    .select({
      id: schema.exercises.id,
      name: schema.exercises.name,
      primaryMuscles: schema.exercises.primaryMuscles,
      secondaryMuscles: schema.exercises.secondaryMuscles,
    })
    .from(schema.exercises)
    .where(or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, tenantId)))
    .all();

  return new Map(
    rows.map((r) => [r.id, { name: r.name, primary: r.primaryMuscles, secondary: r.secondaryMuscles }]),
  );
}

/* ============================================================================
   GET / — the overview
   ========================================================================= */

const RangeQuery = z.object({
  weeks: z.coerce.number().int().min(4).max(26).optional().default(12),
});

progressRoutes.get('/', zValidator('query', RangeQuery), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(c);
  const { weeks: rangeWeeks } = c.req.valid('query');

  const weeks = weekWindow(scope.today, rangeWeeks);
  const windowStart = Date.parse(`${weeks[0]!.start}T00:00:00Z`) - 2 * DAY;

  /* — Sessions, bucketed into the branch's own weeks ————————— */

  const sessions = db
    .select({
      startedAt: schema.workouts.startedAt,
      volumeKg: schema.workouts.volumeKg,
      totalSets: schema.workouts.totalSets,
    })
    .from(schema.workouts)
    .where(
      and(
        eq(schema.workouts.memberId, scope.memberId),
        eq(schema.workouts.state, 'completed'),
        gte(schema.workouts.startedAt, windowStart),
      ),
    )
    .all();

  const buckets = new Map<string, { tonnage: number; sessions: number; sets: number }>();
  for (const w of weeks) buckets.set(w.start, { tonnage: 0, sessions: 0, sets: 0 });
  for (const s of sessions) {
    const key = startOfWeek(isoDate(s.startedAt, scope.tz));
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.tonnage += s.volumeKg;
    bucket.sessions += 1;
    bucket.sets += s.totalSets;
  }

  const weekly = weeks.map((w) => {
    const b = buckets.get(w.start)!;
    const closed = closedDaysIn(w, scope.holidays, scope.today);
    return {
      ...w,
      tonnage: Math.round(b.tonnage),
      sessions: b.sessions,
      sets: b.sets,
      closedDays: closed,
      planned: Math.max(0, scope.weeklyTarget - closed),
    };
  });

  const weeklyTonnage = weekly.map((w) => ({
    label: w.label,
    at: w.start,
    value: w.tonnage,
    // A week still in progress, or one with a single session, under-reports.
    // Flagging it is cheaper than letting the chart imply a slump.
    estimated: w.current || (w.sessions > 0 && w.sessions < 2),
    partial: w.current,
    sessions: w.sessions,
    branchClosed: w.closedDays > 0,
  }));

  const attendance = weekly.map((w) => ({
    weekStart: w.start,
    label: w.label,
    sessions: w.sessions,
    planned: w.planned,
    branchClosed: w.closedDays > 0,
  }));

  /* — Headline numbers. All computed off complete weeks only. ——— */

  const complete = weekly.filter((w) => !w.current);
  const recent4 = complete.slice(-4);
  const prior4 = complete.slice(-8, -4);

  const sum = (rows: typeof complete, pick: (w: (typeof complete)[number]) => number): number =>
    rows.reduce((total, w) => total + pick(w), 0);

  const recentTonnage = sum(recent4, (w) => w.tonnage);
  const priorTonnage = sum(prior4, (w) => w.tonnage);
  const tonnageChangePct =
    priorTonnage > 0 ? Math.round(((recentTonnage - priorTonnage) / priorTonnage) * 100) : 0;

  const plannedRecent = sum(recent4, (w) => w.planned);
  const doneRecent = sum(recent4, (w) => w.sessions);
  const adherencePct = plannedRecent > 0 ? Math.round((doneRecent / plannedRecent) * 100) : 0;

  const last8 = complete.slice(-8);
  const averageSessionsPerWeek = last8.length > 0 ? round1(sum(last8, (w) => w.sessions) / last8.length) : 0;

  const newPrCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.personalRecords)
      .where(
        and(
          eq(schema.personalRecords.memberId, scope.memberId),
          isNull(schema.personalRecords.retiredAt),
          gte(schema.personalRecords.achievedAt, now() - 30 * DAY),
        ),
      )
      .get()?.n ?? 0;

  /* — Measurements ————————————————————————————————————————— */

  const measurements = db
    .select()
    .from(schema.measurements)
    .where(eq(schema.measurements.memberId, scope.memberId))
    .orderBy(desc(schema.measurements.takenOn))
    .limit(26)
    .all();

  const latest = measurements[0] ?? null;

  const measurementTrend = [...measurements]
    .reverse()
    .filter((m) => m.weightKg !== null)
    .map((m) => ({
      label: dayLabel(m.takenOn),
      at: m.takenOn,
      value: m.weightKg!,
      estimated: m.outlier,
    }));

  // Compare against the reading closest to eight weeks back rather than the
  // oldest on file, so the delta always covers the same span.
  const comparisonDate = addDays(scope.today, -56);
  const baselineRow =
    measurements.find((m) => m.takenOn <= comparisonDate) ?? measurements.at(-1) ?? null;

  const compositionItems: Array<{
    key: string;
    label: string;
    value: number | null;
    unit: string;
    delta: number | null;
    lowerIsBetter: boolean;
  }> = [
    { key: 'weightKg', label: 'Weight', unit: 'kg', lowerIsBetter: false },
    { key: 'bodyFatPct', label: 'Body fat', unit: '%', lowerIsBetter: true },
    { key: 'leanMassKg', label: 'Lean mass', unit: 'kg', lowerIsBetter: false },
    { key: 'waistCm', label: 'Waist', unit: 'cm', lowerIsBetter: true },
  ].map((spec) => {
    const value = (latest?.[spec.key as 'weightKg'] ?? null) as number | null;
    const before =
      baselineRow && baselineRow.id !== latest?.id
        ? ((baselineRow[spec.key as 'weightKg'] ?? null) as number | null)
        : null;
    return {
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      lowerIsBetter: spec.lowerIsBetter,
      value,
      delta: value !== null && before !== null ? round1(value - before) : null,
    };
  });

  /* — Goals ————————————————————————————————————————————————— */

  const goalRows = db
    .select()
    .from(schema.goals)
    .where(and(eq(schema.goals.memberId, scope.memberId), sql`${schema.goals.state} != 'retired'`))
    .orderBy(desc(schema.goals.createdAt))
    .all();

  const goals = goalRows.map((g) =>
    serialiseGoal(g, {
      scope,
      latestWeightKg: latest?.weightKg ?? null,
      latestTakenOn: latest?.takenOn ?? null,
      sessionsPerWeek: recent4.length > 0 ? round1(doneRecent / recent4.length) : 0,
    }),
  );

  /* — Honesty gate ————————————————————————————————————————— */

  const loggedWeeks = complete.filter((w) => w.sessions > 0).length;
  const totalSessions = sum(complete, (w) => w.sessions);

  const insufficientData =
    totalSessions < 4 || loggedWeeks < 3
      ? totalSessions === 0
        ? `No sessions logged in the last ${rangeWeeks} weeks, so there is no trend to draw yet. Log a session and this fills in.`
        : `Only ${totalSessions} ${totalSessions === 1 ? 'session' : 'sessions'} across ${loggedWeeks} ${loggedWeeks === 1 ? 'week' : 'weeks'}. That is too little to call a trend, so the numbers below are counts rather than a direction.`
      : null;

  /* — What a strength chart could be drawn for ——————————————— */

  const setRows = db
    .select({
      exerciseId: schema.workoutSets.exerciseId,
      n: sql<number>`count(*)`,
      lastAt: sql<number>`max(${schema.workoutSets.doneAt})`,
    })
    .from(schema.workoutSets)
    .where(
      and(
        eq(schema.workoutSets.memberId, scope.memberId),
        eq(schema.workoutSets.isWarmup, false),
        gte(schema.workoutSets.doneAt, windowStart),
      ),
    )
    .groupBy(schema.workoutSets.exerciseId)
    .all();

  const library = exerciseIndex(ctx.tenantId);

  const strengthOptions = setRows
    .filter((r) => r.n >= 4)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
    .map((r) => ({
      exerciseId: r.exerciseId,
      exerciseName: library.get(r.exerciseId)?.name ?? 'Exercise',
      workingSets: r.n,
      lastLoggedAt: new Date(r.lastAt).toISOString(),
    }))
    .sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));

  return c.json({
    rangeWeeks,
    unitSystem: scope.unitSystem,
    branchName: scope.branchName,
    generatedAt: new Date(now()).toISOString(),
    tonnageChangePct,
    adherencePct,
    newPrCount,
    weeklyTonnage,
    attendance,
    averageSessionsPerWeek,
    weeklyTarget: scope.weeklyTarget,
    latestMeasurement: latest ? serialiseMeasurement(latest) : null,
    measurementTrend,
    bodyComposition: {
      takenOn: latest?.takenOn ?? null,
      source: latest?.source ?? null,
      outlier: latest?.outlier ?? false,
      comparedWith: baselineRow && baselineRow.id !== latest?.id ? baselineRow.takenOn : null,
      items: compositionItems,
    },
    goals,
    strengthOptions,
    insufficientData,
    estimateNote:
      'Tonnage, adherence and body composition come from what you logged. They are a record of your input, not a measurement of your body.',
  });
});

/* ============================================================================
   GET /recovery — an estimate, and it says so everywhere
   ========================================================================= */

/** Where each group sits on the two body diagrams. `other` groups are listed
 *  as rows instead of drawn, so nothing is silently dropped. */
const MUSCLE_SIDE: Record<MuscleGroup, 'front' | 'back' | 'other'> = {
  chest: 'front',
  front_delt: 'front',
  side_delt: 'other',
  rear_delt: 'other',
  lats: 'back',
  traps: 'back',
  upper_back: 'other',
  lower_back: 'other',
  biceps: 'front',
  triceps: 'back',
  forearms: 'other',
  core: 'front',
  glutes: 'back',
  quads: 'front',
  hamstrings: 'back',
  calves: 'back',
  cardio: 'other',
};

const ALL_MUSCLES = Object.keys(MUSCLE_SIDE) as MuscleGroup[];

progressRoutes.get('/recovery', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(c);
  const library = exerciseIndex(ctx.tenantId);
  const at = now();

  // 90 days is enough to answer "when did I last touch this" for anything a
  // member would still call recent; older than that reads as "not logged".
  const sets = db
    .select({
      workoutId: schema.workoutSets.workoutId,
      exerciseId: schema.workoutSets.exerciseId,
      doneAt: schema.workoutSets.doneAt,
    })
    .from(schema.workoutSets)
    .where(
      and(
        eq(schema.workoutSets.memberId, scope.memberId),
        eq(schema.workoutSets.isWarmup, false),
        gte(schema.workoutSets.doneAt, at - 90 * DAY),
      ),
    )
    .all();

  const regions = ALL_MUSCLES.map((muscle) => {
    const touching = sets
      .map((s) => {
        const ex = library.get(s.exerciseId);
        if (!ex) return null;
        // A secondary mover takes half the stimulus of a direct one.
        const weight = ex.primary.includes(muscle) ? 1 : ex.secondary.includes(muscle) ? 0.5 : 0;
        return weight > 0 ? { ...s, weight } : null;
      })
      .filter((s): s is { workoutId: string; exerciseId: string; doneAt: number; weight: number } => s !== null);

    if (touching.length === 0) {
      return {
        muscle,
        label: MUSCLE_LABEL[muscle],
        side: MUSCLE_SIDE[muscle],
        recoveredPct: 100,
        lastWorkedAt: null,
        lastWorkedLabel: 'Not logged',
        setsLast7d: 0,
        note: recoveryNote(muscle, 100, 0),
      };
    }

    const lastAt = Math.max(...touching.map((s) => s.doneAt));
    const lastWorkoutId = touching.find((s) => s.doneAt === lastAt)!.workoutId;

    // Recovery runs from the last bout, not from a week's running total.
    const boutSets = touching
      .filter((s) => s.workoutId === lastWorkoutId)
      .reduce((total, s) => total + s.weight, 0);

    const weighted7d = touching
      .filter((s) => s.doneAt >= at - 7 * DAY)
      .reduce((total, s) => total + s.weight, 0);

    const hoursSince = (at - lastAt) / HOUR;
    const pct = recoveryPct({ muscle, weightedSets: boutSets, hoursSince });
    const setsLast7d = Math.round(weighted7d);

    return {
      muscle,
      label: MUSCLE_LABEL[muscle],
      side: MUSCLE_SIDE[muscle],
      recoveredPct: pct,
      lastWorkedAt: new Date(lastAt).toISOString(),
      lastWorkedLabel: relativeTime(lastAt, at),
      setsLast7d,
      note: recoveryNote(muscle, pct, setsLast7d),
    };
  });

  const worked = regions.filter((r) => r.lastWorkedAt !== null);

  return c.json({
    estimate: true,
    computedAt: new Date(at).toISOString(),
    disclaimer:
      'An estimate from the sets you logged and the hours since. It does not know how you slept, ate or feel, and it is not a medical measure.',
    regions,
    trainedCount: worked.length,
    // The one line the screen leads with, so the reading is never just a colour.
    summary:
      worked.length === 0
        ? 'Nothing logged in the last 90 days, so there is nothing to estimate from.'
        : (() => {
            const lowest = [...worked].sort((a, b) => a.recoveredPct - b.recoveredPct)[0]!;
            return lowest.recoveredPct >= 85
              ? 'Everything you have trained recently is back. Nothing is being held back by recovery today.'
              : `${lowest.label} is the least recovered at about ${lowest.recoveredPct}%. Everything else is further along.`;
          })(),
  });
});

/* ============================================================================
   GET /strength/:exerciseId — one lift, explained not just plotted
   ========================================================================= */

progressRoutes.get('/strength/:exerciseId', zValidator('query', RangeQuery), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(c);
  const exerciseId = c.req.param('exerciseId');
  const { weeks: rangeWeeks } = c.req.valid('query');

  const exercise = db
    .select()
    .from(schema.exercises)
    .where(
      and(
        eq(schema.exercises.id, exerciseId),
        or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, ctx.tenantId)),
      ),
    )
    .get();
  if (!exercise) throw notFound('That exercise');

  const weeks = weekWindow(scope.today, rangeWeeks);
  const windowStart = Date.parse(`${weeks[0]!.start}T00:00:00Z`) - 2 * DAY;

  const sets = db
    .select({
      weightKg: schema.workoutSets.weightKg,
      reps: schema.workoutSets.reps,
      doneAt: schema.workoutSets.doneAt,
    })
    .from(schema.workoutSets)
    .where(
      and(
        eq(schema.workoutSets.memberId, scope.memberId),
        eq(schema.workoutSets.exerciseId, exerciseId),
        eq(schema.workoutSets.isWarmup, false),
        gte(schema.workoutSets.doneAt, windowStart),
      ),
    )
    .all();

  interface Best {
    e1rm: number;
    weightKg: number;
    reps: number;
    doneAt: number;
    workingSets: number;
  }

  const bestByWeek = new Map<string, Best>();
  for (const s of sets) {
    const e1rm = estimate1rm(s.weightKg, s.reps);
    const key = startOfWeek(isoDate(s.doneAt, scope.tz));
    if (!weeks.some((w) => w.start === key)) continue;
    const current = bestByWeek.get(key);
    const workingSets = (current?.workingSets ?? 0) + 1;
    // Sets past twelve reps get no estimate — Epley stops meaning anything
    // there and a made-up point is worse than a missing one.
    if (e1rm === null) {
      if (current) current.workingSets = workingSets;
      continue;
    }
    if (!current || e1rm > current.e1rm) {
      bestByWeek.set(key, { e1rm, weightKg: s.weightKg, reps: s.reps, doneAt: s.doneAt, workingSets });
    } else {
      current.workingSets = workingSets;
    }
  }

  const points = weeks
    .map((w) => {
      const best = bestByWeek.get(w.start);
      if (!best) return null;
      return {
        label: w.label,
        at: w.start,
        value: round1(best.e1rm),
        // One working set, or a set past eight reps, makes the estimate soft.
        estimated: best.workingSets < 2 || best.reps > 8,
        topSetKg: best.weightKg,
        topSetReps: best.reps,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const first = points[0] ?? null;
  const last = points.at(-1) ?? null;
  const change = first && last ? round1(last.value - first.value) : 0;
  const changePct = first && last && first.value > 0 ? Math.round((change / first.value) * 100) : 0;

  const insufficientData =
    points.length < 3
      ? points.length === 0
        ? `No working sets of ${exercise.name} in the last ${rangeWeeks} weeks. Log a few and a trend appears here.`
        : `Only ${points.length} ${points.length === 1 ? 'week' : 'weeks'} of ${exercise.name} logged. Three weeks is the least that says anything, so the points below are shown without a trend line.`
      : null;

  const reading = insufficientData
    ? insufficientData
    : change > 0.5
      ? `Your estimated one-rep max is up ${change} kg — about ${changePct}% — across ${points.length} logged weeks. Estimated from your heaviest logged set each week, not from a tested max.`
      : change < -0.5
        ? `Your estimated one-rep max is down ${Math.abs(change)} kg across ${points.length} logged weeks. A dip after a hard block or a break is normal; tell your coach if it keeps going.`
        : `Holding steady across ${points.length} logged weeks. Estimated from your heaviest logged set each week, not from a tested max.`;

  return c.json({
    exerciseId,
    exerciseName: exercise.name,
    metric: 'estimated_1rm' as const,
    unit: 'kg',
    rangeWeeks,
    points,
    currentDisplay: last ? `${last.value} kg` : '—',
    changeLabel:
      !first || !last || points.length < 2
        ? 'Not enough logged weeks'
        : change === 0
          ? `No change · ${points.length} weeks`
          : `${change > 0 ? '+' : '−'}${Math.abs(change)} kg · ${points.length} weeks`,
    reading,
    insufficientData,
    bestSet: last ? { weightKg: last.topSetKg, reps: last.topSetReps } : null,
    estimateNote:
      'One-rep maxes here are calculated from the weight and reps you logged (Epley). They are an estimate, not a tested max.',
  });
});

/* ============================================================================
   GET /records
   ========================================================================= */

function fmtKg(n: number): string {
  return `${Math.round(n * 10) / 10} kg`;
}

function fmtSeconds(n: number): string {
  const m = Math.floor(n / 60);
  return m > 0 ? `${m}:${String(Math.round(n % 60)).padStart(2, '0')}` : `${Math.round(n)}s`;
}

progressRoutes.get('/records', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(c);
  const library = exerciseIndex(ctx.tenantId);

  const rows = db
    .select()
    .from(schema.personalRecords)
    .where(
      and(eq(schema.personalRecords.memberId, scope.memberId), isNull(schema.personalRecords.retiredAt)),
    )
    .orderBy(desc(schema.personalRecords.achievedAt))
    .all();

  const items = rows.map((r) => {
    const previous = r.previousValue;
    // Time records improve downwards. Every other kind improves upwards.
    const lowerIsBetter = r.kind === 'time';
    const raw = previous === null ? null : r.value - previous;
    const improved = raw === null ? true : lowerIsBetter ? raw < 0 : raw > 0;

    let delta: string | null = null;
    if (raw !== null && raw !== 0) {
      const magnitude = Math.abs(raw);
      delta =
        r.kind === 'reps'
          ? `${improved ? '+' : '−'}${Math.round(magnitude)} reps`
          : r.kind === 'time'
            ? `${fmtSeconds(magnitude)} ${improved ? 'faster' : 'slower'}`
            : `${improved ? '+' : '−'}${fmtKg(magnitude).replace(' kg', '')} kg`;
    }

    return {
      id: r.id,
      exerciseId: r.exerciseId,
      exerciseName: library.get(r.exerciseId)?.name ?? 'Exercise',
      kind: r.kind,
      value: r.value,
      display: r.display,
      previousValue: previous,
      previousDisplay: r.previousDisplay,
      delta,
      improved,
      achievedAt: new Date(r.achievedAt).toISOString(),
      achievedLabel: relativeTime(r.achievedAt),
      isNew: r.achievedAt >= now() - 30 * DAY,
      shared: r.shared,
    };
  });

  return c.json({
    items,
    total: items.length,
    newInLast30: items.filter((i) => i.isNew).length,
  });
});

/* ============================================================================
   POST /measurements — flags an implausible jump instead of drawing it
   ========================================================================= */

const optionalNumber = (min: number, max: number) =>
  z.number().min(min).max(max).nullable().optional();

const MeasurementInput = z.object({
  takenOn: z.string().regex(ISO_DATE, 'Use a date like 2026-08-08.'),
  weightKg: optionalNumber(20, 400),
  bodyFatPct: optionalNumber(1, 70),
  leanMassKg: optionalNumber(10, 200),
  chestCm: optionalNumber(30, 250),
  waistCm: optionalNumber(30, 250),
  hipsCm: optionalNumber(30, 250),
  armCm: optionalNumber(10, 100),
  thighCm: optionalNumber(20, 150),
  source: z.enum(['self', 'trainer', 'device', 'assessment']).optional().default('self'),
});

type MeasurementRow = typeof schema.measurements.$inferSelect;

function serialiseMeasurement(row: MeasurementRow) {
  return {
    id: row.id,
    takenOn: row.takenOn,
    weightKg: row.weightKg,
    bodyFatPct: row.bodyFatPct,
    leanMassKg: row.leanMassKg,
    chestCm: row.chestCm,
    waistCm: row.waistCm,
    hipsCm: row.hipsCm,
    armCm: row.armCm,
    thighCm: row.thighCm,
    source: row.source,
    outlier: row.outlier,
  };
}

/**
 * Outlier detection. Conservative on purpose: it marks a reading so the chart
 * can show it as suspect, and it never rejects or silently corrects one. A
 * member who really did drop four kilos in a week gets to keep the number.
 */
function detectOutlier(
  next: { weightKg?: number | null; bodyFatPct?: number | null; waistCm?: number | null },
  previous: MeasurementRow | null,
  takenOn: string,
): string | null {
  if (!previous) return null;
  const days = Math.max(1, Math.abs(daysBetween(previous.takenOn, takenOn)));
  const weeks = Math.max(0.5, days / 7);
  const reasons: string[] = [];

  if (next.weightKg != null && previous.weightKg != null) {
    const perWeek = Math.abs(next.weightKg - previous.weightKg) / weeks;
    const cap = Math.max(1.5, previous.weightKg * 0.02);
    if (perWeek > cap) {
      reasons.push(
        `weight moved ${round1(Math.abs(next.weightKg - previous.weightKg))} kg in ${days} ${days === 1 ? 'day' : 'days'}`,
      );
    }
  }
  if (next.bodyFatPct != null && previous.bodyFatPct != null) {
    if (Math.abs(next.bodyFatPct - previous.bodyFatPct) / weeks > 1.5) {
      reasons.push(
        `body fat moved ${round1(Math.abs(next.bodyFatPct - previous.bodyFatPct))} points in ${days} ${days === 1 ? 'day' : 'days'}`,
      );
    }
  }
  if (next.waistCm != null && previous.waistCm != null) {
    if (Math.abs(next.waistCm - previous.waistCm) / weeks > 4) {
      reasons.push(`waist moved ${round1(Math.abs(next.waistCm - previous.waistCm))} cm in ${days} ${days === 1 ? 'day' : 'days'}`);
    }
  }

  if (reasons.length === 0) return null;
  return `Saved, and flagged for a second look: ${reasons.join(', ')}. Scales and tapes disagree with each other all the time — check the entry, and the trend line will skip it until you confirm.`;
}

progressRoutes.post('/measurements', zValidator('json', MeasurementInput), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(c);
  const body = c.req.valid('json');

  if (body.takenOn > scope.today) {
    throw invalid('A measurement cannot be dated in the future.', [
      { path: 'takenOn', code: 'future_date', message: 'Pick today or an earlier date.' },
    ]);
  }

  const values = {
    weightKg: body.weightKg ?? null,
    bodyFatPct: body.bodyFatPct ?? null,
    leanMassKg: body.leanMassKg ?? null,
    chestCm: body.chestCm ?? null,
    waistCm: body.waistCm ?? null,
    hipsCm: body.hipsCm ?? null,
    armCm: body.armCm ?? null,
    thighCm: body.thighCm ?? null,
  };

  if (Object.values(values).every((v) => v === null)) {
    throw invalid('Add at least one number before saving.', [
      { path: 'weightKg', code: 'empty', message: 'Enter a weight or one of the tape measurements.' },
    ]);
  }

  const previous = db
    .select()
    .from(schema.measurements)
    .where(
      and(
        eq(schema.measurements.memberId, scope.memberId),
        sql`${schema.measurements.takenOn} < ${body.takenOn}`,
      ),
    )
    .orderBy(desc(schema.measurements.takenOn))
    .get();

  const outlierNote = detectOutlier(values, previous ?? null, body.takenOn);

  const existing = db
    .select()
    .from(schema.measurements)
    .where(
      and(eq(schema.measurements.memberId, scope.memberId), eq(schema.measurements.takenOn, body.takenOn)),
    )
    .get();

  // Re-logging the same day corrects the entry rather than colliding with it —
  // a typo is the commonest reason anyone opens this form twice.
  const rowId = existing?.id ?? id('msr');

  if (existing) {
    db.update(schema.measurements)
      .set({ ...values, source: body.source, outlier: outlierNote !== null })
      .where(eq(schema.measurements.id, existing.id))
      .run();
  } else {
    db.insert(schema.measurements)
      .values({
        id: rowId,
        tenantId: ctx.tenantId,
        memberId: scope.memberId,
        takenOn: body.takenOn,
        ...values,
        source: body.source,
        outlier: outlierNote !== null,
        createdAt: now(),
      })
      .run();
  }

  const saved = db.select().from(schema.measurements).where(eq(schema.measurements.id, rowId)).get()!;

  return c.json(
    {
      measurement: serialiseMeasurement(saved),
      replaced: Boolean(existing),
      outlier: saved.outlier,
      outlierNote,
      unitSystem: scope.unitSystem,
    },
    existing ? 200 : 201,
  );
});

/* ============================================================================
   Goals
   ========================================================================= */

type GoalRow = typeof schema.goals.$inferSelect;
type GoalKind = 'lift' | 'bodyweight' | 'attendance' | 'habit' | 'measurement' | 'event';

interface GoalContext {
  scope: Scope;
  latestWeightKg: number | null;
  latestTakenOn: string | null;
  sessionsPerWeek: number;
}

/** What the member has actually reached, and where that number came from. A
 *  progress bar with no stated source is a number nobody can argue with. */
function currentFor(goal: GoalRow, gc: GoalContext): { current: number; sourceNote: string } {
  if (goal.kind === 'lift' && goal.refExerciseId) {
    const best = db
      .select({ top: sql<number | null>`max(${schema.workoutSets.weightKg})` })
      .from(schema.workoutSets)
      .where(
        and(
          eq(schema.workoutSets.memberId, gc.scope.memberId),
          eq(schema.workoutSets.exerciseId, goal.refExerciseId),
          eq(schema.workoutSets.isWarmup, false),
        ),
      )
      .get();
    if (best?.top != null) {
      return { current: best.top, sourceNote: 'Your heaviest logged working set.' };
    }
    return { current: goal.baseline, sourceNote: 'No working sets logged for this lift yet.' };
  }

  if (goal.kind === 'bodyweight' && gc.latestWeightKg !== null) {
    return {
      current: gc.latestWeightKg,
      sourceNote: `Your latest measurement${gc.latestTakenOn ? `, ${dayLabel(gc.latestTakenOn)}` : ''}.`,
    };
  }

  if (goal.kind === 'attendance') {
    return {
      current: gc.sessionsPerWeek,
      sourceNote: 'Average sessions a week over the last four full weeks.',
    };
  }

  return {
    current: goal.baseline,
    sourceNote: 'Not tracked automatically. Your coach updates this one.',
  };
}

function serialiseGoal(goal: GoalRow, gc: GoalContext) {
  const { current, sourceNote } = currentFor(goal, gc);
  const span = goal.target - goal.baseline;
  const moved = current - goal.baseline;
  const progressPct = span === 0 ? 100 : clamp(Math.round((moved / span) * 100), 0, 100);

  const daysRemaining = daysBetween(gc.scope.today, goal.targetDate);
  const createdOn = isoDate(goal.createdAt, gc.scope.tz);
  const totalDays = Math.max(1, daysBetween(createdOn, goal.targetDate));
  const elapsedDays = clamp(daysBetween(createdOn, gc.scope.today), 0, totalDays);
  const expectedPct = Math.round((elapsedDays / totalDays) * 100);

  const coachName = goal.coachId
    ? (db
        .select({ name: schema.users.name })
        .from(schema.staff)
        .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
        .where(eq(schema.staff.id, goal.coachId))
        .get()?.name ?? null)
    : null;

  return {
    id: goal.id,
    kind: goal.kind as GoalKind,
    title: goal.title,
    baseline: goal.baseline,
    target: goal.target,
    current: round1(current),
    unit: goal.unit,
    targetDate: goal.targetDate,
    state: goal.state,
    coachName,
    progressPct,
    expectedPct,
    daysRemaining,
    // Eight points of slack: a goal is not "off track" because a member took a
    // rest week at the right time.
    onTrack: goal.state !== 'active' ? true : progressPct + 8 >= expectedPct,
    sourceNote,
    paceWarning:
      goal.state === 'active'
        ? goalPaceWarning({
            kind: goal.kind as GoalKind,
            baseline: current,
            target: goal.target,
            daysRemaining,
          })
        : null,
  };
}

function goalContext(scope: Scope): GoalContext {
  const latest = db
    .select()
    .from(schema.measurements)
    .where(eq(schema.measurements.memberId, scope.memberId))
    .orderBy(desc(schema.measurements.takenOn))
    .get();

  const weeks = weekWindow(scope.today, 5).filter((w) => !w.current);
  const from = Date.parse(`${weeks[0]!.start}T00:00:00Z`) - 2 * DAY;

  const sessions = db
    .select({ startedAt: schema.workouts.startedAt })
    .from(schema.workouts)
    .where(
      and(
        eq(schema.workouts.memberId, scope.memberId),
        eq(schema.workouts.state, 'completed'),
        gte(schema.workouts.startedAt, from),
      ),
    )
    .all()
    .filter((s) => {
      const key = startOfWeek(isoDate(s.startedAt, scope.tz));
      return weeks.some((w) => w.start === key);
    });

  return {
    scope,
    latestWeightKg: latest?.weightKg ?? null,
    latestTakenOn: latest?.takenOn ?? null,
    sessionsPerWeek: weeks.length > 0 ? round1(sessions.length / weeks.length) : 0,
  };
}

const GoalInput = z.object({
  kind: z.enum(['lift', 'bodyweight', 'attendance', 'habit', 'measurement', 'event']),
  title: z.string().trim().min(2).max(80),
  baseline: z.number(),
  target: z.number(),
  unit: z.string().trim().min(1).max(16),
  targetDate: z.string().regex(ISO_DATE, 'Use a date like 2026-12-31.'),
  refExerciseId: z.string().nullable().optional(),
});

progressRoutes.post('/goals', zValidator('json', GoalInput), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(c);
  const body = c.req.valid('json');

  const daysRemaining = daysBetween(scope.today, body.targetDate);
  if (daysRemaining <= 0) {
    throw invalid('Pick a target date in the future.', [
      { path: 'targetDate', code: 'past_date', message: 'The date has to be after today.' },
    ]);
  }
  if (body.baseline === body.target) {
    throw invalid('The target has to differ from where you are starting.', [
      { path: 'target', code: 'no_change', message: 'Set a target above or below the baseline.' },
    ]);
  }

  // Advisory, never a block. The member keeps the goal; they just see the
  // arithmetic before they commit to it (PF-PROG edge case: unsafe goal).
  const paceWarning = goalPaceWarning({
    kind: body.kind,
    baseline: body.baseline,
    target: body.target,
    daysRemaining,
  });

  const goalId = id('gol');
  const at = now();

  db.insert(schema.goals)
    .values({
      id: goalId,
      tenantId: ctx.tenantId,
      memberId: scope.memberId,
      kind: body.kind,
      title: body.title,
      baseline: body.baseline,
      target: body.target,
      unit: body.unit,
      targetDate: body.targetDate,
      state: 'active',
      coachId: null,
      refExerciseId: body.refExerciseId ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  audit(ctx, {
    action: 'goal.created',
    entityType: 'goal',
    entityId: goalId,
    entityLabel: body.title,
    after: { kind: body.kind, baseline: body.baseline, target: body.target, targetDate: body.targetDate },
  });

  const saved = db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).get()!;

  return c.json({ goal: serialiseGoal(saved, goalContext(scope)), paceWarning }, 201);
});

const GoalPatch = z
  .object({
    title: z.string().trim().min(2).max(80).optional(),
    target: z.number().optional(),
    targetDate: z.string().regex(ISO_DATE, 'Use a date like 2026-12-31.').optional(),
    state: z.enum(['active', 'achieved', 'missed', 'paused', 'retired']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

progressRoutes.patch('/goals/:id', zValidator('json', GoalPatch), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(c);
  const goalId = c.req.param('id');
  const patch = c.req.valid('json');

  const goal = db
    .select()
    .from(schema.goals)
    .where(and(eq(schema.goals.id, goalId), eq(schema.goals.memberId, scope.memberId)))
    .get();
  if (!goal) throw notFound('That goal');

  const targetDate = patch.targetDate ?? goal.targetDate;
  if (patch.targetDate && daysBetween(scope.today, patch.targetDate) <= 0 && (patch.state ?? goal.state) === 'active') {
    throw invalid('Pick a target date in the future, or park the goal instead.', [
      { path: 'targetDate', code: 'past_date', message: 'The date has to be after today.' },
    ]);
  }

  const next = {
    title: patch.title ?? goal.title,
    target: patch.target ?? goal.target,
    targetDate,
    state: patch.state ?? goal.state,
  };

  db.update(schema.goals)
    .set({ ...next, updatedAt: now() })
    .where(eq(schema.goals.id, goalId))
    .run();

  audit(ctx, {
    action: patch.state === 'retired' ? 'goal.retired' : 'goal.updated',
    entityType: 'goal',
    entityId: goalId,
    entityLabel: next.title,
    before: { title: goal.title, target: goal.target, targetDate: goal.targetDate, state: goal.state },
    after: next,
  });

  const saved = db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).get()!;
  const serialised = serialiseGoal(saved, goalContext(scope));

  return c.json({ goal: serialised, paceWarning: serialised.paceWarning });
});
