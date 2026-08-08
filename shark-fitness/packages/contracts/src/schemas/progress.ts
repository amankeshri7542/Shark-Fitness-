import { z } from 'zod';
import { GoalState, Visibility } from '../enums.js';
import { Id, IsoDate, IsoDateTime } from './identity.js';

export const Measurement = z.object({
  id: Id,
  takenOn: IsoDate,
  weightKg: z.number().nullable(),
  bodyFatPct: z.number().nullable(),
  leanMassKg: z.number().nullable(),
  chestCm: z.number().nullable(),
  waistCm: z.number().nullable(),
  hipsCm: z.number().nullable(),
  armCm: z.number().nullable(),
  thighCm: z.number().nullable(),
  source: z.enum(['self', 'trainer', 'device', 'assessment']),
  /** Flagged when a value moves further than a plausible physiological
   *  change, so the chart can mark it rather than silently distorting. */
  outlier: z.boolean(),
});
export type Measurement = z.infer<typeof Measurement>;

export const Goal = z.object({
  id: Id,
  kind: z.enum(['lift', 'bodyweight', 'attendance', 'habit', 'measurement', 'event']),
  title: z.string(),
  baseline: z.number(),
  target: z.number(),
  current: z.number(),
  unit: z.string(),
  targetDate: IsoDate,
  state: GoalState,
  coachName: z.string().nullable(),
  progressPct: z.number().int().min(0).max(100),
  onTrack: z.boolean(),
  /** Set when the pace required is not safely achievable. Advisory, not a block. */
  paceWarning: z.string().nullable(),
});
export type Goal = z.infer<typeof Goal>;

export const TrendPoint = z.object({
  label: z.string(),
  at: IsoDate,
  value: z.number(),
  /** Marks weeks with too little data to be meaningful. */
  estimated: z.boolean(),
});
export type TrendPoint = z.infer<typeof TrendPoint>;

export const StrengthTrend = z.object({
  exerciseId: Id,
  exerciseName: z.string(),
  metric: z.enum(['estimated_1rm', 'top_set', 'volume']),
  unit: z.string(),
  points: z.array(TrendPoint),
  currentDisplay: z.string(),
  changeLabel: z.string(),
  /** Plain-language reading of the trend. Explained, not just plotted. */
  reading: z.string(),
});
export type StrengthTrend = z.infer<typeof StrengthTrend>;

export const AttendanceWeek = z.object({
  weekStart: IsoDate,
  label: z.string(),
  sessions: z.number().int(),
  planned: z.number().int(),
  /** True when the gym itself was shut — a gap that is not the member's doing
   *  and must not count against a risk score (PF-SUP edge case). */
  branchClosed: z.boolean(),
});
export type AttendanceWeek = z.infer<typeof AttendanceWeek>;

export const ProgressOverview = z.object({
  tonnageChangePct: z.number(),
  adherencePct: z.number().int(),
  newPrCount: z.number().int(),
  weeklyTonnage: z.array(TrendPoint),
  attendance: z.array(AttendanceWeek),
  averageSessionsPerWeek: z.number(),
  latestMeasurement: Measurement.nullable(),
  measurementTrend: z.array(TrendPoint),
  goals: z.array(Goal),
  /** Set when there is not enough history to say anything honest yet. */
  insufficientData: z.string().nullable(),
});
export type ProgressOverview = z.infer<typeof ProgressOverview>;

export const ProgressPhoto = z.object({
  id: Id,
  takenOn: IsoDate,
  pose: z.enum(['front', 'side', 'back']),
  url: z.string().nullable(),
  visibility: Visibility,
  consentGiven: z.boolean(),
  /** True while the metadata row exists but the upload has not landed. */
  pending: z.boolean(),
});
export type ProgressPhoto = z.infer<typeof ProgressPhoto>;

export const Assessment = z.object({
  id: Id,
  template: z.string(),
  takenAt: IsoDateTime,
  trainerName: z.string().nullable(),
  values: z.array(z.object({ label: z.string(), value: z.string(), unit: z.string().nullable() })),
  /** Present only for staff tokens. */
  trainerOnly: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  memberNote: z.string().nullable(),
});
export type Assessment = z.infer<typeof Assessment>;

/* — Habits, nutrition, recovery (UX-M09) ————————————————————— */

export const Habit = z.object({
  id: Id,
  name: z.string(),
  icon: z.string(),
  cadence: z.enum(['daily', 'weekly']),
  target: z.number(),
  unit: z.string(),
  active: z.boolean(),
  todayValue: z.number(),
  streakDays: z.number().int(),
  last7: z.array(z.boolean()).length(7),
});
export type Habit = z.infer<typeof Habit>;

export const HabitLogInput = z.object({
  habitId: Id,
  onDate: IsoDate,
  value: z.number().min(0),
  clientId: z.string(),
});
export type HabitLogInput = z.infer<typeof HabitLogInput>;

export const NutritionTargets = z.object({
  enabled: z.boolean(),
  kcal: z.number().int().nullable(),
  proteinG: z.number().int().nullable(),
  carbsG: z.number().int().nullable(),
  fatG: z.number().int().nullable(),
  setByName: z.string().nullable(),
  /** Server-side guard. A coach cannot silently set an unsafe deficit. */
  safetyFlag: z.string().nullable(),
  exclusions: z.array(z.string()),
  allergies: z.array(z.string()),
});
export type NutritionTargets = z.infer<typeof NutritionTargets>;

export const DailyMetrics = z.object({
  onDate: IsoDate,
  waterMl: z.number().int(),
  waterTargetMl: z.number().int(),
  sleepMin: z.number().int().nullable(),
  steps: z.number().int().nullable(),
  kcal: z.number().int().nullable(),
  proteinG: z.number().int().nullable(),
  mood: z.number().int().min(1).max(5).nullable(),
  energy: z.number().int().min(1).max(5).nullable(),
  soreness: z.number().int().min(1).max(5).nullable(),
  /** Set when a health integration delivered the same day twice. */
  duplicateSource: z.string().nullable(),
});
export type DailyMetrics = z.infer<typeof DailyMetrics>;

export const WeeklyCheckIn = z.object({
  id: Id,
  weekStart: IsoDate,
  adherence: z.number().int().min(1).max(5),
  energy: z.number().int().min(1).max(5),
  hunger: z.number().int().min(1).max(5),
  sleep: z.number().int().min(1).max(5),
  soreness: z.number().int().min(1).max(5),
  mood: z.number().int().min(1).max(5),
  note: z.string(),
  submittedAt: IsoDateTime.nullable(),
  coachReply: z.string().nullable(),
  coachRepliedAt: IsoDateTime.nullable(),
  /** Raised when free text suggests injury or disordered eating. Routes to a
   *  human and shows support resources; never auto-coaches (PF-NUTR-005). */
  safetyEscalated: z.boolean(),
});
export type WeeklyCheckIn = z.infer<typeof WeeklyCheckIn>;
