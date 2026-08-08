import { z } from 'zod';
import { Equipment, MuscleGroup, WorkoutState } from '../enums.js';
import { Id, IsoDate, IsoDateTime } from './identity.js';

export const Exercise = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  equipment: Equipment,
  primaryMuscles: z.array(MuscleGroup),
  secondaryMuscles: z.array(MuscleGroup),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  instructions: z.array(z.string()),
  cues: z.array(z.string()),
  /** Shown as a warning, never as a diagnosis (PF-NUTR-005, PF-AI-005). */
  contraindications: z.array(z.string()),
  substitutionIds: z.array(Id),
  isUnilateral: z.boolean(),
  /** Barbell lifts get plate maths; machines do not. */
  usesBarbell: z.boolean(),
  mediaUrl: z.string().nullable(),
  archived: z.boolean(),
});
export type Exercise = z.infer<typeof Exercise>;

export const PrescribedSet = z.object({
  setIndex: z.number().int(),
  targetWeightKg: z.number().nullable(),
  repLow: z.number().int(),
  repHigh: z.number().int(),
  targetRpe: z.number().nullable(),
  restSec: z.number().int(),
  isWarmup: z.boolean(),
});
export type PrescribedSet = z.infer<typeof PrescribedSet>;

export const ProgramItem = z.object({
  id: Id,
  orderIndex: z.number().int(),
  exerciseId: Id,
  exerciseName: z.string(),
  equipment: Equipment,
  primaryMuscles: z.array(MuscleGroup),
  usesBarbell: z.boolean(),
  targetLabel: z.string(), // "4 × 6-8 @ RPE 8"
  sets: z.array(PrescribedSet),
  supersetGroup: z.string().nullable(),
  tempo: z.string().nullable(),
  notes: z.string().nullable(),
  /** Why the coach put this here. Surfaced on UX-M07. */
  rationale: z.string().nullable(),
  /** When locked, the adaptive engine may not change it (PF-AI-005). */
  trainerLocked: z.boolean(),
  allowedSubstitutionIds: z.array(Id),
  lastPerformance: z
    .object({ weightKg: z.number(), reps: z.number().int(), at: IsoDate, label: z.string() })
    .nullable(),
});
export type ProgramItem = z.infer<typeof ProgramItem>;

export const ProgramDay = z.object({
  id: Id,
  week: z.number().int(),
  dayIndex: z.number().int(), // 0=Mon
  label: z.string(), // "Push · Chest & Shoulders"
  focus: z.string(), // "push"
  isRest: z.boolean(),
  estimatedMin: z.number().int(),
  items: z.array(ProgramItem),
});
export type ProgramDay = z.infer<typeof ProgramDay>;

export const Program = z.object({
  id: Id,
  name: z.string(),
  version: z.number().int(),
  goal: z.enum(['hypertrophy', 'strength', 'fat_loss', 'endurance', 'general', 'rehab']),
  daysPerWeek: z.number().int(),
  weeks: z.number().int(),
  authorName: z.string(),
  state: z.enum(['draft', 'published', 'archived']),
  description: z.string(),
});
export type Program = z.infer<typeof Program>;

export const Assignment = z.object({
  id: Id,
  memberId: Id,
  program: Program,
  trainerId: Id.nullable(),
  trainerName: z.string().nullable(),
  startsOn: IsoDate,
  currentWeek: z.number().int(),
  currentBlock: z.string(),
  state: z.enum(['active', 'paused', 'completed', 'replaced']),
  /** The whole assigned plan, frozen. Editing the source program creates a new
   *  version; completed history is never mutated (PF-WORK-003). */
  days: z.array(ProgramDay),
});
export type Assignment = z.infer<typeof Assignment>;

/** The adaptive engine is deterministic and versioned. This is its receipt. */
export const AdaptiveDecision = z.object({
  id: Id,
  rulesVersion: z.string(),
  createdAt: IsoDateTime,
  headline: z.string(),
  explanation: z.string(),
  inputs: z.array(z.string()),
  changes: z.array(
    z.object({
      exerciseName: z.string(),
      field: z.string(),
      from: z.string(),
      to: z.string(),
    }),
  ),
  confidence: z.enum(['low', 'medium', 'high']),
  limitations: z.string(),
  reviewedByName: z.string().nullable(),
  reviewedAt: IsoDateTime.nullable(),
  memberDecision: z.enum(['pending', 'accepted', 'declined']),
});
export type AdaptiveDecision = z.infer<typeof AdaptiveDecision>;

/* — Logging ————————————————————————————————————————————————— */

export const LoggedSet = z.object({
  /** Client-generated UUID. The sync key — resending is a no-op. */
  clientId: z.string(),
  exerciseId: Id,
  orderIndex: z.number().int(),
  setIndex: z.number().int(),
  weightKg: z.number().min(0),
  reps: z.number().int().min(0),
  rpe: z.number().min(1).max(10).nullable(),
  isWarmup: z.boolean().default(false),
  doneAt: IsoDateTime,
});
export type LoggedSet = z.infer<typeof LoggedSet>;

export const WorkoutDraft = z.object({
  clientId: z.string(),
  assignmentId: Id.nullable(),
  programDayId: Id.nullable(),
  branchId: Id.nullable(),
  title: z.string(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  state: WorkoutState,
  sets: z.array(LoggedSet),
  notes: z.string().nullable(),
  sessionRpe: z.number().min(1).max(10).nullable(),
  /** Exercise swaps made during the session, for trainer review. */
  substitutions: z.array(z.object({ fromExerciseId: Id, toExerciseId: Id, reason: z.string() })),
});
export type WorkoutDraft = z.infer<typeof WorkoutDraft>;

export const PersonalRecord = z.object({
  id: Id,
  exerciseId: Id,
  exerciseName: z.string(),
  kind: z.enum(['weight', 'reps', 'volume', 'estimated_1rm', 'time']),
  value: z.number(),
  display: z.string(),
  previousValue: z.number().nullable(),
  previousDisplay: z.string().nullable(),
  delta: z.string().nullable(),
  achievedAt: IsoDateTime,
  shared: z.boolean(),
});
export type PersonalRecord = z.infer<typeof PersonalRecord>;

export const MuscleVolume = z.object({
  muscle: MuscleGroup,
  label: z.string(),
  sets: z.number().int(),
  share: z.number(), // 0..1 of the session
});
export type MuscleVolume = z.infer<typeof MuscleVolume>;

export const WorkoutSummary = z.object({
  id: Id,
  clientId: z.string(),
  title: z.string(),
  state: WorkoutState,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  durationSec: z.number().int(),
  volumeKg: z.number(),
  totalSets: z.number().int(),
  completedSets: z.number().int(),
  exerciseCount: z.number().int(),
  xpAwarded: z.number().int(),
  personalRecords: z.array(PersonalRecord),
  muscleVolume: z.array(MuscleVolume),
  /** Raised when weekly volume jumps past a safe increase. Never shaming. */
  volumeWarning: z.string().nullable(),
  coachNote: z.string().nullable(),
});
export type WorkoutSummary = z.infer<typeof WorkoutSummary>;

/** Recovery is an estimate from logged sets and elapsed days. It is labelled
 *  as such everywhere it appears — it is not a medical measure (PF-PROG-005). */
export const RecoveryRegion = z.object({
  muscle: MuscleGroup,
  label: z.string(),
  recoveredPct: z.number().int().min(0).max(100),
  lastWorkedAt: IsoDateTime.nullable(),
  lastWorkedLabel: z.string(),
  setsLast7d: z.number().int(),
  note: z.string(),
});
export type RecoveryRegion = z.infer<typeof RecoveryRegion>;
