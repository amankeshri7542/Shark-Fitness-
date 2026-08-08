import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { MuscleGroup, PrescribedSet } from '@shark/contracts';

export const exercises = sqliteTable(
  'exercises',
  {
    id: text('id').primaryKey(),
    /** Null for the shared library; set for a tenant's own additions. */
    tenantId: text('tenant_id'),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull(),
    equipment: text('equipment').notNull(),
    primaryMuscles: text('primary_muscles', { mode: 'json' }).$type<MuscleGroup[]>().notNull(),
    secondaryMuscles: text('secondary_muscles', { mode: 'json' }).$type<MuscleGroup[]>().notNull(),
    difficulty: text('difficulty').notNull().default('intermediate'),
    instructions: text('instructions', { mode: 'json' }).$type<string[]>().notNull(),
    cues: text('cues', { mode: 'json' }).$type<string[]>().notNull(),
    contraindications: text('contraindications', { mode: 'json' }).$type<string[]>().notNull(),
    substitutionIds: text('substitution_ids', { mode: 'json' }).$type<string[]>().notNull(),
    isUnilateral: integer('is_unilateral', { mode: 'boolean' }).notNull().default(false),
    usesBarbell: integer('uses_barbell', { mode: 'boolean' }).notNull().default(false),
    defaultRestSec: integer('default_rest_sec').notNull().default(90),
    loadStepKg: real('load_step_kg').notNull().default(2.5),
    mediaUrl: text('media_url'),
    /** Archived exercises stay resolvable — history must not break (PF-WORK). */
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({ slugUq: uniqueIndex('exercises_slug_uq').on(t.slug) }),
);

export const programs = sqliteTable(
  'programs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    goal: text('goal').notNull(),
    daysPerWeek: integer('days_per_week').notNull(),
    weeks: integer('weeks').notNull(),
    authorId: text('author_id'),
    authorName: text('author_name').notNull(),
    description: text('description').notNull().default(''),
    state: text('state').notNull().default('published'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byTenant: index('programs_tenant_idx').on(t.tenantId, t.state) }),
);

export const programDays = sqliteTable(
  'program_days',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    programId: text('program_id').notNull(),
    week: integer('week').notNull(),
    dayIndex: integer('day_index').notNull(),
    label: text('label').notNull(),
    focus: text('focus').notNull(),
    isRest: integer('is_rest', { mode: 'boolean' }).notNull().default(false),
    estimatedMin: integer('estimated_min').notNull().default(45),
  },
  (t) => ({ byProgram: index('program_days_idx').on(t.programId, t.week, t.dayIndex) }),
);

export const programItems = sqliteTable(
  'program_items',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    programDayId: text('program_day_id').notNull(),
    orderIndex: integer('order_index').notNull(),
    exerciseId: text('exercise_id').notNull(),
    sets: text('sets', { mode: 'json' }).$type<PrescribedSet[]>().notNull(),
    targetLabel: text('target_label').notNull(),
    supersetGroup: text('superset_group'),
    tempo: text('tempo'),
    notes: text('notes'),
    rationale: text('rationale'),
    trainerLocked: integer('trainer_locked', { mode: 'boolean' }).notNull().default(false),
    allowedSubstitutionIds: text('allowed_substitution_ids', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (t) => ({ byDay: index('program_items_idx').on(t.programDayId, t.orderIndex) }),
);

export const assignments = sqliteTable(
  'assignments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    programId: text('program_id').notNull(),
    programVersion: integer('program_version').notNull(),
    trainerId: text('trainer_id'),
    startsOn: text('starts_on').notNull(),
    currentWeek: integer('current_week').notNull().default(1),
    currentBlock: text('current_block').notNull().default('A'),
    state: text('state').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byMember: index('assignments_member_idx').on(t.memberId, t.state) }),
);

/** Per-member overrides on top of the assigned program: adaptive load changes
 *  and accepted substitutions, without mutating the program itself. */
export const assignmentOverrides = sqliteTable(
  'assignment_overrides',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    assignmentId: text('assignment_id').notNull(),
    programItemId: text('program_item_id').notNull(),
    week: integer('week').notNull(),
    loadKg: real('load_kg'),
    substituteExerciseId: text('substitute_exercise_id'),
    reason: text('reason').notNull(),
    source: text('source').notNull().default('adaptive'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('assignment_override_uq').on(t.assignmentId, t.programItemId, t.week) }),
);

export const workouts = sqliteTable(
  'workouts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    memberId: text('member_id').notNull(),
    assignmentId: text('assignment_id'),
    programDayId: text('program_day_id'),
    /** Client-generated. Resyncing the same workout is a no-op (PF-WORK-005). */
    clientId: text('client_id').notNull(),
    title: text('title').notNull(),
    state: text('state').notNull().default('in_progress'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    durationSec: integer('duration_sec').notNull().default(0),
    volumeKg: real('volume_kg').notNull().default(0),
    totalSets: integer('total_sets').notNull().default(0),
    notes: text('notes'),
    sessionRpe: real('session_rpe'),
    substitutions: text('substitutions', { mode: 'json' })
      .$type<Array<{ fromExerciseId: string; toExerciseId: string; reason: string }>>()
      .notNull(),
    coachNote: text('coach_note'),
    reviewedByTrainerAt: integer('reviewed_by_trainer_at'),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => ({
    clientUq: uniqueIndex('workouts_client_uq').on(t.memberId, t.clientId),
    byMember: index('workouts_member_idx').on(t.memberId, t.startedAt),
  }),
);

export const workoutSets = sqliteTable(
  'workout_sets',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workoutId: text('workout_id').notNull(),
    memberId: text('member_id').notNull(),
    clientId: text('client_id').notNull(),
    exerciseId: text('exercise_id').notNull(),
    orderIndex: integer('order_index').notNull(),
    setIndex: integer('set_index').notNull(),
    weightKg: real('weight_kg').notNull(),
    reps: integer('reps').notNull(),
    rpe: real('rpe'),
    isWarmup: integer('is_warmup', { mode: 'boolean' }).notNull().default(false),
    doneAt: integer('done_at').notNull(),
  },
  (t) => ({
    clientUq: uniqueIndex('workout_sets_client_uq').on(t.memberId, t.clientId),
    byWorkout: index('workout_sets_workout_idx').on(t.workoutId, t.orderIndex, t.setIndex),
    byExercise: index('workout_sets_exercise_idx').on(t.memberId, t.exerciseId, t.doneAt),
  }),
);

export const personalRecords = sqliteTable(
  'personal_records',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    exerciseId: text('exercise_id').notNull(),
    kind: text('kind').notNull(),
    value: real('value').notNull(),
    display: text('display').notNull(),
    previousValue: real('previous_value'),
    previousDisplay: text('previous_display'),
    workoutSetId: text('workout_set_id'),
    achievedAt: integer('achieved_at').notNull(),
    shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
    /** Set when the source set was later deleted; the PR is retired, not erased. */
    retiredAt: integer('retired_at'),
  },
  (t) => ({ byMember: index('prs_member_idx').on(t.memberId, t.exerciseId, t.kind) }),
);

export const adaptiveDecisions = sqliteTable(
  'adaptive_decisions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    assignmentId: text('assignment_id').notNull(),
    programItemId: text('program_item_id'),
    rulesVersion: text('rules_version').notNull(),
    headline: text('headline').notNull(),
    explanation: text('explanation').notNull(),
    inputs: text('inputs', { mode: 'json' }).$type<string[]>().notNull(),
    changes: text('changes', { mode: 'json' })
      .$type<Array<{ exerciseName: string; field: string; from: string; to: string }>>()
      .notNull(),
    confidence: text('confidence').notNull(),
    limitations: text('limitations').notNull(),
    reviewedById: text('reviewed_by_id'),
    reviewedByName: text('reviewed_by_name'),
    reviewedAt: integer('reviewed_at'),
    memberDecision: text('member_decision').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byMember: index('adaptive_member_idx').on(t.memberId, t.createdAt) }),
);

/* ——— Progress ————————————————————————————————————————————— */

export const measurements = sqliteTable(
  'measurements',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    takenOn: text('taken_on').notNull(),
    weightKg: real('weight_kg'),
    bodyFatPct: real('body_fat_pct'),
    leanMassKg: real('lean_mass_kg'),
    chestCm: real('chest_cm'),
    waistCm: real('waist_cm'),
    hipsCm: real('hips_cm'),
    armCm: real('arm_cm'),
    thighCm: real('thigh_cm'),
    source: text('source').notNull().default('self'),
    outlier: integer('outlier', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('measurements_uq').on(t.memberId, t.takenOn) }),
);

export const goals = sqliteTable(
  'goals',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    baseline: real('baseline').notNull(),
    target: real('target').notNull(),
    unit: text('unit').notNull(),
    targetDate: text('target_date').notNull(),
    state: text('state').notNull().default('active'),
    coachId: text('coach_id'),
    refExerciseId: text('ref_exercise_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byMember: index('goals_member_idx').on(t.memberId, t.state) }),
);

export const assessments = sqliteTable(
  'assessments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    template: text('template').notNull(),
    trainerId: text('trainer_id'),
    values: text('values', { mode: 'json' })
      .$type<Array<{ label: string; value: string; unit: string | null }>>()
      .notNull(),
    /** Never included in a member-scoped serialisation. */
    trainerOnly: text('trainer_only', { mode: 'json' })
      .$type<Array<{ label: string; value: string }>>()
      .notNull(),
    memberNote: text('member_note'),
    takenAt: integer('taken_at').notNull(),
  },
  (t) => ({ byMember: index('assessments_member_idx').on(t.memberId, t.takenAt) }),
);

export const progressPhotos = sqliteTable(
  'progress_photos',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    takenOn: text('taken_on').notNull(),
    pose: text('pose').notNull(),
    storageKey: text('storage_key'),
    visibility: text('visibility').notNull().default('private'),
    consentGiven: integer('consent_given', { mode: 'boolean' }).notNull().default(false),
    /** Metadata row exists before the upload lands, so a failed upload is a
     *  visible pending state rather than a silent gap (UX-M08). */
    pending: integer('pending', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({ byMember: index('photos_member_idx').on(t.memberId, t.takenOn) }),
);

export const habits = sqliteTable(
  'habits',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    name: text('name').notNull(),
    icon: text('icon').notNull().default('dot'),
    cadence: text('cadence').notNull().default('daily'),
    target: real('target').notNull(),
    unit: text('unit').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byMember: index('habits_member_idx').on(t.memberId, t.active) }),
);

export const habitLogs = sqliteTable(
  'habit_logs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    habitId: text('habit_id').notNull(),
    memberId: text('member_id').notNull(),
    onDate: text('on_date').notNull(),
    value: real('value').notNull(),
    clientId: text('client_id').notNull(),
    loggedAt: integer('logged_at').notNull(),
  },
  (t) => ({
    uq: uniqueIndex('habit_logs_uq').on(t.habitId, t.onDate),
    clientUq: uniqueIndex('habit_logs_client_uq').on(t.memberId, t.clientId),
  }),
);

export const dailyMetrics = sqliteTable(
  'daily_metrics',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    onDate: text('on_date').notNull(),
    waterMl: integer('water_ml').notNull().default(0),
    sleepMin: integer('sleep_min'),
    steps: integer('steps'),
    kcal: integer('kcal'),
    proteinG: integer('protein_g'),
    carbsG: integer('carbs_g'),
    fatG: integer('fat_g'),
    mood: integer('mood'),
    energy: integer('energy'),
    soreness: integer('soreness'),
    /** Which integration last wrote this day, so a duplicate import is visible. */
    lastSource: text('last_source'),
    duplicateSource: text('duplicate_source'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('daily_metrics_uq').on(t.memberId, t.onDate) }),
);

export const nutritionTargets = sqliteTable('nutrition_targets', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  memberId: text('member_id').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  kcal: integer('kcal'),
  proteinG: integer('protein_g'),
  carbsG: integer('carbs_g'),
  fatG: integer('fat_g'),
  waterTargetMl: integer('water_target_ml').notNull().default(3000),
  setById: text('set_by_id'),
  setByName: text('set_by_name'),
  safetyFlag: text('safety_flag'),
  exclusions: text('exclusions', { mode: 'json' }).$type<string[]>().notNull(),
  allergies: text('allergies', { mode: 'json' }).$type<string[]>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const weeklyCheckIns = sqliteTable(
  'weekly_check_ins',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    weekStart: text('week_start').notNull(),
    adherence: integer('adherence'),
    energy: integer('energy'),
    hunger: integer('hunger'),
    sleep: integer('sleep'),
    soreness: integer('soreness'),
    mood: integer('mood'),
    note: text('note').notNull().default(''),
    submittedAt: integer('submitted_at'),
    coachReply: text('coach_reply'),
    coachRepliedAt: integer('coach_replied_at'),
    safetyEscalated: integer('safety_escalated', { mode: 'boolean' }).notNull().default(false),
    safetySignals: text('safety_signals', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (t) => ({ uq: uniqueIndex('weekly_checkins_uq').on(t.memberId, t.weekStart) }),
);
