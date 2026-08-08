import { Hono } from 'hono';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { channels } from '@shark/contracts';
import {
  blocksAutomation,
  computeStreak,
  nutritionSafety,
  scanForSafety,
  type SafetyCategory,
  type SafetySignal,
} from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { id } from '../../lib/ids.js';
import { addDays, daysBetween, isoDate, now, relativeTime, startOfWeek } from '../../lib/time.js';
import { conflict, invalid, notFound, precondition } from '../../lib/errors.js';

export const habitsRoutes = new Hono();

/**
 * Habits, nutrition and recovery (UX-M09, PF-NUTR).
 *
 * Two rules shape this file.
 *
 * 1. Free text is scanned by `scanForSafety` before anything else happens to
 *    it. When it trips, the check-in is routed to a person, automation is
 *    paused, and the response carries support resources and *no advice at all*
 *    (PF-NUTR-005). There is no code path here that answers a safety signal
 *    with coaching.
 * 2. The whole nutrition and recovery module is opt-out, and turning it back on
 *    is the same one call (PF-NUTR-006). Opting out is enforced server side —
 *    macro and recovery writes are refused, not merely hidden.
 */

/* ————————————————————————————————————————————————————————————
   Shared scope
   ————————————————————————————————————————————————————————— */

interface Scope {
  memberId: string;
  tz: string;
  today: string;
  branchId: string;
  gender: 'female' | 'male' | 'unspecified';
}

function memberScope(ctx: ReturnType<typeof ctxOf>): Scope {
  const memberId = ctx.memberId!;
  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get();
  if (!member || member.tenantId !== ctx.tenantId) throw notFound('Your membership');

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, member.homeBranchId)).get();
  const tz = branch?.timezone ?? 'Asia/Kolkata';

  const gender = member.gender === 'female' ? 'female' : member.gender === 'male' ? 'male' : 'unspecified';

  return { memberId, tz, today: isoDate(now(), tz), branchId: member.homeBranchId, gender };
}

/** Seven days ending today, oldest first. Drives every dot strip on the screen. */
function lastSevenDays(today: string): string[] {
  return Array.from({ length: 7 }, (_, n) => addDays(today, n - 6));
}

const DAY_INITIAL = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function dayInitial(isoDay: string): string {
  const index = (new Date(`${isoDay}T00:00:00Z`).getUTCDay() + 6) % 7;
  return DAY_INITIAL[index] ?? '·';
}

interface HabitView {
  id: string;
  name: string;
  icon: string;
  cadence: string;
  target: number;
  unit: string;
  active: boolean;
  todayValue: number;
  done: boolean;
  streakDays: number;
  longestStreak: number;
  last7: boolean[];
  last7Days: Array<{ date: string; label: string; done: boolean; value: number }>;
}

/** One habit's card, built from its own log rows. `computeStreak` with no rest
 *  allowance is exactly a run of consecutive days, so the streak arithmetic
 *  stays in @shark/domain rather than being written twice. */
function habitView(
  habit: typeof schema.habits.$inferSelect,
  logs: Array<{ habitId: string; onDate: string; value: number }>,
  today: string,
): HabitView {
  const mine = logs.filter((l) => l.habitId === habit.id);
  const valueOn = new Map(mine.map((l) => [l.onDate, l.value]));
  const met = mine.filter((l) => l.value >= habit.target).map((l) => l.onDate);

  const streak = computeStreak({
    sessionDates: met,
    today,
    weeklyTarget: 7,
    restDaysAllowed: 0,
  });

  const week = lastSevenDays(today).map((date) => {
    const value = valueOn.get(date) ?? 0;
    return { date, label: dayInitial(date), done: value >= habit.target, value };
  });

  const todayValue = valueOn.get(today) ?? 0;

  return {
    id: habit.id,
    name: habit.name,
    icon: habit.icon,
    cadence: habit.cadence,
    target: habit.target,
    unit: habit.unit,
    active: habit.active,
    todayValue,
    done: todayValue >= habit.target,
    streakDays: streak.current,
    longestStreak: streak.longest,
    last7: week.map((d) => d.done),
    last7Days: week,
  };
}

function habitsFor(ctx: ReturnType<typeof ctxOf>, scope: Scope): HabitView[] {
  const rows = db
    .select()
    .from(schema.habits)
    .where(
      and(
        eq(schema.habits.tenantId, ctx.tenantId),
        eq(schema.habits.memberId, scope.memberId),
        eq(schema.habits.active, true),
      ),
    )
    .orderBy(schema.habits.createdAt)
    .all();

  if (rows.length === 0) return [];

  const logs = db
    .select({
      habitId: schema.habitLogs.habitId,
      onDate: schema.habitLogs.onDate,
      value: schema.habitLogs.value,
    })
    .from(schema.habitLogs)
    .where(
      and(
        eq(schema.habitLogs.memberId, scope.memberId),
        inArray(
          schema.habitLogs.habitId,
          rows.map((r) => r.id),
        ),
        gte(schema.habitLogs.onDate, addDays(scope.today, -120)),
      ),
    )
    .all();

  return rows.map((habit) => habitView(habit, logs, scope.today));
}

function metricsRow(memberId: string, onDate: string) {
  return db
    .select()
    .from(schema.dailyMetrics)
    .where(and(eq(schema.dailyMetrics.memberId, memberId), eq(schema.dailyMetrics.onDate, onDate)))
    .get();
}

function targetsRow(memberId: string) {
  return db
    .select()
    .from(schema.nutritionTargets)
    .where(eq(schema.nutritionTargets.memberId, memberId))
    .get();
}

function serialiseMetrics(row: ReturnType<typeof metricsRow>, onDate: string, waterTargetMl: number) {
  return {
    onDate,
    waterMl: row?.waterMl ?? 0,
    waterTargetMl,
    sleepMin: row?.sleepMin ?? null,
    steps: row?.steps ?? null,
    kcal: row?.kcal ?? null,
    proteinG: row?.proteinG ?? null,
    carbsG: row?.carbsG ?? null,
    fatG: row?.fatG ?? null,
    mood: row?.mood ?? null,
    energy: row?.energy ?? null,
    soreness: row?.soreness ?? null,
    lastSource: row?.lastSource ?? null,
    duplicateSource: row?.duplicateSource ?? null,
    logged: row !== undefined,
  };
}

/** The member's coach, when there is one. Every safety path needs a person's
 *  name to put on the response — "someone will read this" is weaker. */
function coachFor(ctx: ReturnType<typeof ctxOf>, memberId: string) {
  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get();

  const name = member?.trainerId
    ? (db
        .select({ name: schema.users.name })
        .from(schema.staff)
        .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
        .where(eq(schema.staff.id, member.trainerId))
        .get()?.name ?? null)
    : null;

  const conversation = db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.tenantId, ctx.tenantId),
        eq(schema.conversations.memberId, memberId),
        eq(schema.conversations.kind, 'coach'),
      ),
    )
    .orderBy(desc(schema.conversations.lastMessageAt))
    .get();

  return { name, staffId: member?.trainerId ?? null, conversationId: conversation?.id ?? null };
}

/* ————————————————————————————————————————————————————————————
   Safety response. Process, not advice.
   ————————————————————————————————————————————————————————— */

interface Resource {
  title: string;
  detail: string;
  contact: string | null;
}

/** Support routes shown alongside an escalation. Every entry points at a human
 *  or a published public service. None of them tell the member what to do about
 *  their body — that is the whole point. */
function resourcesFor(categories: SafetyCategory[], branchPhone: string | null, branchName: string): Resource[] {
  const out: Resource[] = [];
  const push = (r: Resource): void => {
    if (!out.some((existing) => existing.title === r.title)) out.push(r);
  };

  for (const category of categories) {
    if (category === 'injury' || category === 'pregnancy') {
      push({
        title: 'Your coach reads this before your next session',
        detail: 'Nothing in your plan moves until they have.',
        contact: null,
      });
      push({
        title: 'Reception can put you in touch with a physio',
        detail: `${branchName} keeps a list of practices the gym works with.`,
        contact: branchPhone,
      });
    }
    if (category === 'medical') {
      push({
        title: 'Speak to a doctor',
        detail: 'Gym staff are not medical professionals and will not advise you here.',
        contact: null,
      });
      push({
        title: 'Emergency services',
        detail: 'If this is happening now, call for help rather than waiting for a reply.',
        contact: '112',
      });
    }
    if (category === 'disordered_eating') {
      push({
        title: 'A person is reading this, not a program',
        detail: 'No calorie or macro suggestion will be sent to you in reply.',
        contact: null,
      });
      push({
        title: 'Tele-MANAS — free, confidential, 24/7',
        detail: "India's national mental health helpline. You do not need a referral.",
        contact: '14416',
      });
    }
    if (category === 'distress') {
      push({
        title: 'Tele-MANAS — free, confidential, 24/7',
        detail: "India's national mental health helpline. You do not need a referral.",
        contact: '14416',
      });
      push({
        title: 'Emergency services',
        detail: 'If you are in danger right now, this is the fastest route to help.',
        contact: '112',
      });
    }
  }

  push({
    title: `Talk to someone at ${branchName}`,
    detail: 'Reception can find a manager or your coach in person.',
    contact: branchPhone,
  });

  return out;
}

function nextStepsFor(categories: SafetyCategory[], paused: boolean, coachName: string | null): string[] {
  const steps: string[] = [
    `${coachName ?? 'A coach'} sees this check-in flagged for a human to read. It is not answered automatically.`,
  ];
  if (paused) {
    steps.push('Automatic changes to your plan are paused until a person has read it.');
  }
  if (categories.includes('injury') || categories.includes('pregnancy')) {
    steps.push('Your next session stays as it is. Nothing gets heavier on its own.');
  }
  steps.push('You can add anything else you want them to know in the message thread.');
  steps.push('You can delete this check-in from your record by asking reception.');
  return steps;
}

const SAFETY_HEADLINE = 'A person will read this';

const SAFETY_BODY =
  'Thanks for writing that down. This check-in has gone to a coach instead of into an automated response, ' +
  'and nothing about your plan changes until they have read it.';

/* ————————————————————————————————————————————————————————————
   GET / — habits, today's metrics, nutrition targets
   ————————————————————————————————————————————————————————— */

habitsRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const scope = memberScope(ctx);

  const targets = targetsRow(scope.memberId);
  const optedOut = targets !== undefined && !targets.enabled;
  const nutritionEnabled = targets?.enabled ?? false;
  const waterTargetMl = targets?.waterTargetMl ?? 3000;

  const habits = habitsFor(ctx, scope);
  const today = metricsRow(scope.memberId, scope.today);

  const recent = lastSevenDays(scope.today).map((date) => {
    const row = metricsRow(scope.memberId, date);
    return {
      date,
      label: dayInitial(date),
      waterMl: row?.waterMl ?? 0,
      sleepMin: row?.sleepMin ?? null,
      steps: row?.steps ?? null,
    };
  });

  // The stored flag is what a coach saw when they set the target; recomputing
  // catches a bodyweight that has moved since. Either one is shown.
  const bodyweightKg =
    db
      .select({ w: schema.measurements.weightKg })
      .from(schema.measurements)
      .where(eq(schema.measurements.memberId, scope.memberId))
      .orderBy(desc(schema.measurements.takenOn))
      .get()?.w ?? null;

  const computedFlag = nutritionSafety({
    kcal: targets?.kcal ?? null,
    sex: scope.gender,
    bodyweightKg,
    proteinG: targets?.proteinG ?? null,
  });

  const weekStart = startOfWeek(scope.today);
  const checkIn = db
    .select()
    .from(schema.weeklyCheckIns)
    .where(
      and(eq(schema.weeklyCheckIns.memberId, scope.memberId), eq(schema.weeklyCheckIns.weekStart, weekStart)),
    )
    .get();

  const coach = coachFor(ctx, scope.memberId);

  return c.json({
    today: {
      date: scope.today,
      weekStart,
      label: new Intl.DateTimeFormat('en-GB', {
        timeZone: scope.tz,
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      }).format(now()),
    },
    optedOut,
    module: {
      nutritionEnabled,
      /** Never configured is not the same as switched off, and the screen says so. */
      configured: targets !== undefined,
    },
    habits,
    summary: {
      total: habits.length,
      doneToday: habits.filter((h) => h.done).length,
      bestStreak: habits.reduce((best, h) => Math.max(best, h.streakDays), 0),
    },
    metrics: serialiseMetrics(today, scope.today, waterTargetMl),
    recent,
    nutrition: {
      enabled: nutritionEnabled,
      kcal: targets?.kcal ?? null,
      proteinG: targets?.proteinG ?? null,
      carbsG: targets?.carbsG ?? null,
      fatG: targets?.fatG ?? null,
      waterTargetMl,
      setByName: targets?.setByName ?? null,
      setOn: targets ? new Date(targets.updatedAt).toISOString() : null,
      safetyFlag: targets?.safetyFlag ?? computedFlag,
      exclusions: targets?.exclusions ?? [],
      allergies: targets?.allergies ?? [],
      disclaimer:
        'General guidance from your coach, not medical or dietetic advice. Tell them if anything here does not suit you.',
    },
    checkIn: checkIn
      ? {
          id: checkIn.id,
          weekStart: checkIn.weekStart,
          submitted: checkIn.submittedAt !== null,
          submittedAt: checkIn.submittedAt ? new Date(checkIn.submittedAt).toISOString() : null,
          safetyEscalated: checkIn.safetyEscalated,
        }
      : { id: null, weekStart, submitted: false, submittedAt: null, safetyEscalated: false },
    coach,
  });
});

/* ————————————————————————————————————————————————————————————
   POST /log — one habit, one day. Idempotent.
   ————————————————————————————————————————————————————————— */

const HabitLogBody = z.object({
  habitId: z.string().min(1),
  onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value: z.number().min(0).max(1_000_000),
  clientId: z.string().min(1).max(120),
});

habitsRoutes.post('/log', validate('json', HabitLogBody), (c) => {
  const ctx = ctxOf(c);
  const scope = memberScope(ctx);
  const input = c.req.valid('json');

  const habit = db
    .select()
    .from(schema.habits)
    .where(
      and(
        eq(schema.habits.id, input.habitId),
        eq(schema.habits.memberId, scope.memberId),
        eq(schema.habits.tenantId, ctx.tenantId),
      ),
    )
    .get();
  if (!habit) throw notFound('That habit');
  if (!habit.active) throw precondition('That habit is switched off, so it cannot be logged.');

  if (input.onDate > scope.today) {
    throw invalid('You cannot log a habit for a day that has not happened yet.');
  }
  if (daysBetween(input.onDate, scope.today) > 7) {
    throw invalid('You can fill in the last seven days. Anything older is left as it was.');
  }

  const duplicate = transact(() => {
    // The client id is the idempotency key: a replayed queue entry is a no-op.
    const replay = db
      .select()
      .from(schema.habitLogs)
      .where(
        and(eq(schema.habitLogs.memberId, scope.memberId), eq(schema.habitLogs.clientId, input.clientId)),
      )
      .get();
    if (replay) return true;

    // One row per habit per day. A second log for the same day corrects the
    // first rather than stacking, because the value is absolute, not a delta.
    const existing = db
      .select()
      .from(schema.habitLogs)
      .where(and(eq(schema.habitLogs.habitId, habit.id), eq(schema.habitLogs.onDate, input.onDate)))
      .get();

    if (existing) {
      db.update(schema.habitLogs)
        .set({ value: input.value, clientId: input.clientId, loggedAt: now() })
        .where(eq(schema.habitLogs.id, existing.id))
        .run();
      return false;
    }

    db.insert(schema.habitLogs)
      .values({
        id: id('hbl'),
        tenantId: ctx.tenantId,
        habitId: habit.id,
        memberId: scope.memberId,
        onDate: input.onDate,
        value: input.value,
        clientId: input.clientId,
        loggedAt: now(),
      })
      .run();
    return false;
  });

  const logs = db
    .select({
      habitId: schema.habitLogs.habitId,
      onDate: schema.habitLogs.onDate,
      value: schema.habitLogs.value,
    })
    .from(schema.habitLogs)
    .where(
      and(
        eq(schema.habitLogs.memberId, scope.memberId),
        eq(schema.habitLogs.habitId, habit.id),
        gte(schema.habitLogs.onDate, addDays(scope.today, -120)),
      ),
    )
    .all();

  return c.json({ ok: true, duplicate, habit: habitView(habit, logs, scope.today) });
});

/* ————————————————————————————————————————————————————————————
   POST /metrics — today's water, sleep, steps, macros, recovery
   ————————————————————————————————————————————————————————— */

const MetricsBody = z.object({
  onDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  waterMl: z.number().int().min(0).max(20_000).optional(),
  sleepMin: z.number().int().min(0).max(1_440).optional(),
  steps: z.number().int().min(0).max(200_000).optional(),
  kcal: z.number().int().min(0).max(15_000).optional(),
  proteinG: z.number().int().min(0).max(1_000).optional(),
  carbsG: z.number().int().min(0).max(2_000).optional(),
  fatG: z.number().int().min(0).max(1_000).optional(),
  mood: z.number().int().min(1).max(5).optional(),
  energy: z.number().int().min(1).max(5).optional(),
  soreness: z.number().int().min(1).max(5).optional(),
  /** Which integration wrote this. Absent means the member typed it. */
  source: z.enum(['manual', 'health_connect', 'apple_health', 'google_fit', 'wearable']).default('manual'),
});

const MODULE_FIELDS = ['kcal', 'proteinG', 'carbsG', 'fatG', 'mood', 'energy', 'soreness'] as const;

habitsRoutes.post('/metrics', validate('json', MetricsBody), (c) => {
  const ctx = ctxOf(c);
  const scope = memberScope(ctx);
  const body = c.req.valid('json');
  const onDate = body.onDate ?? scope.today;

  if (onDate > scope.today) {
    throw invalid('You cannot record a day that has not happened yet.');
  }
  if (daysBetween(onDate, scope.today) > 7) {
    throw invalid('You can fill in the last seven days. Anything older is left as it was.');
  }

  const targets = targetsRow(scope.memberId);
  const optedOut = targets !== undefined && !targets.enabled;

  // The opt-out is enforced here, not just hidden in the app.
  if (optedOut && MODULE_FIELDS.some((field) => body[field] !== undefined)) {
    throw precondition(
      'Nutrition and recovery tracking is switched off for your account. Turn it back on to record these.',
    );
  }

  const existing = metricsRow(scope.memberId, onDate);
  const integration = body.source !== 'manual';

  // Two sources claiming the same day is a real event, not an error. Keep what
  // is already there, flag it, and let the member settle it (PF-NUTR edge case).
  const collision =
    integration && existing !== undefined && existing.lastSource !== null && existing.lastSource !== 'manual';

  const patch = {
    waterMl: body.waterMl ?? existing?.waterMl ?? 0,
    sleepMin: body.sleepMin ?? existing?.sleepMin ?? null,
    steps: body.steps ?? existing?.steps ?? null,
    kcal: body.kcal ?? existing?.kcal ?? null,
    proteinG: body.proteinG ?? existing?.proteinG ?? null,
    carbsG: body.carbsG ?? existing?.carbsG ?? null,
    fatG: body.fatG ?? existing?.fatG ?? null,
    mood: body.mood ?? existing?.mood ?? null,
    energy: body.energy ?? existing?.energy ?? null,
    soreness: body.soreness ?? existing?.soreness ?? null,
  };

  transact(() => {
    if (!existing) {
      db.insert(schema.dailyMetrics)
        .values({
          id: id('dmt'),
          tenantId: ctx.tenantId,
          memberId: scope.memberId,
          onDate,
          ...patch,
          lastSource: body.source,
          duplicateSource: null,
          updatedAt: now(),
        })
        .run();
      return;
    }

    db.update(schema.dailyMetrics)
      .set({
        ...(collision ? {} : patch),
        lastSource: collision ? existing.lastSource : body.source,
        // A manual write is the member settling the clash, so it clears the flag.
        duplicateSource: collision ? existing.lastSource : integration ? existing.duplicateSource : null,
        updatedAt: now(),
      })
      .where(eq(schema.dailyMetrics.id, existing.id))
      .run();
  });

  const waterTargetMl = targets?.waterTargetMl ?? 3000;
  return c.json({
    ok: true,
    duplicate: collision,
    duplicateNote: collision
      ? `${labelForSource(existing?.lastSource ?? null)} already sent this day. Your existing figures are kept until you change them.`
      : null,
    metrics: serialiseMetrics(metricsRow(scope.memberId, onDate), onDate, waterTargetMl),
  });
});

function labelForSource(source: string | null): string {
  if (source === 'health_connect') return 'Health Connect';
  if (source === 'apple_health') return 'Apple Health';
  if (source === 'google_fit') return 'Google Fit';
  if (source === 'wearable') return 'Your watch';
  return 'Another source';
}

/* ————————————————————————————————————————————————————————————
   GET /check-in — this week's, plus the last one a coach answered
   ————————————————————————————————————————————————————————— */

const SCALES = [
  { key: 'adherence', label: 'Plan followed', low: 'Hardly any', high: 'All of it' },
  { key: 'energy', label: 'Energy', low: 'Flat', high: 'Full' },
  { key: 'hunger', label: 'Hunger', low: 'Settled', high: 'Constant' },
  { key: 'sleep', label: 'Sleep', low: 'Broken', high: 'Solid' },
  { key: 'soreness', label: 'Soreness', low: 'None', high: 'Heavy' },
  { key: 'mood', label: 'Mood', low: 'Low', high: 'Good' },
] as const;

function serialiseCheckIn(row: typeof schema.weeklyCheckIns.$inferSelect) {
  return {
    id: row.id,
    weekStart: row.weekStart,
    adherence: row.adherence,
    energy: row.energy,
    hunger: row.hunger,
    sleep: row.sleep,
    soreness: row.soreness,
    mood: row.mood,
    note: row.note,
    submitted: row.submittedAt !== null,
    submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : null,
    submittedRelative: row.submittedAt ? relativeTime(row.submittedAt) : null,
    coachReply: row.coachReply,
    coachRepliedAt: row.coachRepliedAt ? new Date(row.coachRepliedAt).toISOString() : null,
    safetyEscalated: row.safetyEscalated,
    safetySignals: row.safetySignals,
  };
}

habitsRoutes.get('/check-in', (c) => {
  const ctx = ctxOf(c);
  const scope = memberScope(ctx);
  const weekStart = startOfWeek(scope.today);

  const targets = targetsRow(scope.memberId);
  const optedOut = targets !== undefined && !targets.enabled;

  const current = db
    .select()
    .from(schema.weeklyCheckIns)
    .where(
      and(eq(schema.weeklyCheckIns.memberId, scope.memberId), eq(schema.weeklyCheckIns.weekStart, weekStart)),
    )
    .get();

  const previous = db
    .select()
    .from(schema.weeklyCheckIns)
    .where(eq(schema.weeklyCheckIns.memberId, scope.memberId))
    .orderBy(desc(schema.weeklyCheckIns.weekStart))
    .all()
    .find((row) => row.weekStart !== weekStart && row.submittedAt !== null);

  const coach = coachFor(ctx, scope.memberId);

  return c.json({
    optedOut,
    weekStart,
    weekLabel: `${formatDay(weekStart)} – ${formatDay(addDays(weekStart, 6))}`,
    scales: SCALES,
    checkIn: current ? serialiseCheckIn(current) : null,
    previous: previous ? serialiseCheckIn(previous) : null,
    coach,
    /** Shown before anything is typed, so the member knows who reads it. */
    privacyNote: `Your coach${coach.name ? ` (${coach.name})` : ''} reads this. It is not posted anywhere and it is not scored.`,
  });
});

function formatDay(isoDay: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    Date.parse(`${isoDay}T00:00:00Z`),
  );
}

/* ————————————————————————————————————————————————————————————
   POST /check-in — submit. Free text is scanned first.
   ————————————————————————————————————————————————————————— */

const CheckInBody = z.object({
  weekStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  adherence: z.number().int().min(1).max(5),
  energy: z.number().int().min(1).max(5),
  hunger: z.number().int().min(1).max(5),
  sleep: z.number().int().min(1).max(5),
  soreness: z.number().int().min(1).max(5),
  mood: z.number().int().min(1).max(5),
  note: z.string().max(2_000).default(''),
});

habitsRoutes.post('/check-in', validate('json', CheckInBody), (c) => {
  const ctx = ctxOf(c);
  const scope = memberScope(ctx);
  const body = c.req.valid('json');
  const weekStart = body.weekStart ?? startOfWeek(scope.today);

  if (weekStart > startOfWeek(scope.today)) {
    throw invalid('That week has not started yet.');
  }

  const targets = targetsRow(scope.memberId);
  if (targets !== undefined && !targets.enabled) {
    throw precondition(
      'Nutrition and recovery tracking is switched off for your account. Turn it back on to send a check-in.',
    );
  }

  const existing = db
    .select()
    .from(schema.weeklyCheckIns)
    .where(
      and(eq(schema.weeklyCheckIns.memberId, scope.memberId), eq(schema.weeklyCheckIns.weekStart, weekStart)),
    )
    .get();

  if (existing?.coachReply) {
    throw conflict('Your coach has already replied to this week. Send them a message instead.');
  }

  /* The scan happens before anything is written and before any response text
     is chosen. Nothing downstream may answer a signal with coaching. */
  const signals: SafetySignal[] = scanForSafety(body.note);
  const categories = [...new Set(signals.map((s) => s.category))];
  const escalated = signals.length > 0;
  const paused = blocksAutomation(signals);

  const coach = coachFor(ctx, scope.memberId);
  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, scope.branchId)).get();

  const checkInId = existing?.id ?? id('wci');
  let ticketReference: string | null = null;

  transact(() => {
    const values = {
      adherence: body.adherence,
      energy: body.energy,
      hunger: body.hunger,
      sleep: body.sleep,
      soreness: body.soreness,
      mood: body.mood,
      note: body.note,
      submittedAt: now(),
      safetyEscalated: escalated,
      safetySignals: categories,
    };

    if (existing) {
      db.update(schema.weeklyCheckIns)
        .set(values)
        .where(eq(schema.weeklyCheckIns.id, existing.id))
        .run();
    } else {
      db.insert(schema.weeklyCheckIns)
        .values({
          id: checkInId,
          tenantId: ctx.tenantId,
          memberId: scope.memberId,
          weekStart,
          coachReply: null,
          coachRepliedAt: null,
          ...values,
        })
        .run();
    }

    if (!escalated) return;

    /* Route it to a person. The ticket is the staff-side handle; the member's
       words stay in the check-in row rather than being copied into a subject
       line that shows up in list views. */
    ticketReference = `SAF-${Math.floor(now() / 1000) % 100000}`;
    const ticketId = id('tkt');

    db.insert(schema.tickets)
      .values({
        id: ticketId,
        tenantId: ctx.tenantId,
        branchId: scope.branchId,
        memberId: scope.memberId,
        reference: ticketReference,
        category: 'wellbeing',
        subject: 'Weekly check-in flagged for a person to read',
        priority: categories.includes('distress') || categories.includes('medical') ? 'urgent' : 'high',
        state: 'open',
        assigneeId: coach.staffId,
        slaDueAt: now() + 4 * 60 * 60 * 1000,
        resolution: null,
        anonymous: false,
        escalated: true,
        openedAt: now(),
        lastUpdateAt: now(),
        closedAt: null,
      })
      .run();

    if (coach.staffId) {
      const coachUserId = db
        .select({ userId: schema.staff.userId })
        .from(schema.staff)
        .where(eq(schema.staff.id, coach.staffId))
        .get()?.userId;

      if (coachUserId) {
        db.insert(schema.notifications)
          .values({
            id: id('ntf'),
            tenantId: ctx.tenantId,
            userId: coachUserId,
            channel: 'in_app',
            kind: 'safety',
            title: 'A check-in needs you to read it',
            body: 'A weekly check-in was flagged for a person. It has not been answered automatically.',
            link: `/members/${scope.memberId}`,
            templateCode: null,
            state: 'sent',
            attempts: 1,
            lastError: null,
            createdAt: now(),
            readAt: null,
          })
          .run();
      }
    }

    // The free text never leaves the check-in row. Only the categories do.
    audit(ctx, {
      action: 'checkin.safety_escalated',
      entityType: 'weekly_check_in',
      entityId: checkInId,
      entityLabel: `Week of ${weekStart}`,
      branchId: scope.branchId,
      after: { safetyEscalated: true, categories, ticketReference, automationPaused: paused },
    });
  });

  if (escalated) {
    emit({
      tenantId: ctx.tenantId,
      branchId: scope.branchId,
      channel: channels.branch(scope.branchId),
      topic: 'alert.raised',
      payload: {
        kind: 'safety_check_in',
        memberId: scope.memberId,
        categories,
        automationPaused: paused,
        reference: ticketReference,
      },
    });
  }

  const saved = db.select().from(schema.weeklyCheckIns).where(eq(schema.weeklyCheckIns.id, checkInId)).get();

  return c.json({
    ok: true,
    checkIn: saved ? serialiseCheckIn(saved) : null,
    coach,
    /* On a signal the response is process and support only. There is
       deliberately no guidance field to fill in here. */
    safety: escalated
      ? {
          escalated: true,
          categories,
          automationPaused: paused,
          headline: SAFETY_HEADLINE,
          body: SAFETY_BODY,
          whatHappensNext: nextStepsFor(categories, paused, coach.name),
          resources: resourcesFor(categories, branch?.phone ?? null, branch?.name ?? 'the gym'),
          reference: ticketReference,
        }
      : null,
    acknowledgement: escalated
      ? null
      : `Sent. ${coach.name ?? 'Your coach'} reads these and will reply here.`,
  });
});

/* ————————————————————————————————————————————————————————————
   POST /opt-out — and back in, through the same door
   ————————————————————————————————————————————————————————— */

const OptOutBody = z.object({
  optedOut: z.boolean(),
  reason: z.string().max(500).optional(),
});

habitsRoutes.post('/opt-out', validate('json', OptOutBody), (c) => {
  const ctx = ctxOf(c);
  const scope = memberScope(ctx);
  const { optedOut, reason } = c.req.valid('json');

  const existing = targetsRow(scope.memberId);
  const wasOptedOut = existing !== undefined && !existing.enabled;

  transact(() => {
    if (existing) {
      db.update(schema.nutritionTargets)
        .set({ enabled: !optedOut, updatedAt: now() })
        .where(eq(schema.nutritionTargets.id, existing.id))
        .run();
    } else {
      db.insert(schema.nutritionTargets)
        .values({
          id: id('ntr'),
          tenantId: ctx.tenantId,
          memberId: scope.memberId,
          enabled: !optedOut,
          kcal: null,
          proteinG: null,
          carbsG: null,
          fatG: null,
          waterTargetMl: 3000,
          setById: null,
          setByName: null,
          safetyFlag: null,
          exclusions: [],
          allergies: [],
          updatedAt: now(),
        })
        .run();
    }

    audit(ctx, {
      action: optedOut ? 'nutrition.opted_out' : 'nutrition.opted_in',
      entityType: 'nutrition_targets',
      entityId: scope.memberId,
      entityLabel: 'Nutrition and recovery module',
      reason: reason ?? null,
      branchId: scope.branchId,
      before: { optedOut: wasOptedOut },
      after: { optedOut },
    });
  });

  return c.json({
    ok: true,
    optedOut,
    message: optedOut
      ? 'Nutrition and recovery are off. Your habits and training are unaffected, and what you have already recorded is kept. You can turn this back on any time.'
      : 'Nutrition and recovery are back on. Nothing was lost while it was off.',
  });
});
