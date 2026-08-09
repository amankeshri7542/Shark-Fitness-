import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { channels, PrescribedSet } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { loadStaffInScope } from './staff.js';
import { loadMemberInScope } from './members.js';

/**
 * Program builder, exercise library and trainer/program assignment
 * (PF-TRAIN). Everything the member app's `routes/member/training.ts`
 * already reads (`programs`, `programDays`, `programItems`, `assignments`)
 * is written here for the first time — no member-side file changes.
 *
 * Versioning: a program row is immutable once published (see the plan doc's
 * "Key design decisions" — `docs/superpowers/plans/2026-08-09-phase6-staff-training.md`).
 * A draft can be edited freely; publishing locks it; a new version is a new
 * row with a fresh id, copy-forward content, and `version + 1`.
 */

/* ============================================================================
   Exercise library
   ========================================================================= */

export interface ExerciseListQuery {
  q?: string;
  equipment?: string;
  archived?: boolean;
}

export function listExercises(ctx: { tenantId: string }, query: ExerciseListQuery) {
  const rows = db
    .select()
    .from(schema.exercises)
    .where(or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, ctx.tenantId)))
    .orderBy(asc(schema.exercises.name))
    .all()
    .filter((e) => (query.archived === undefined ? !e.archived : e.archived === query.archived))
    .filter((e) => !query.equipment || e.equipment === query.equipment)
    .filter((e) => !query.q || e.name.toLowerCase().includes(query.q!.toLowerCase()));

  return { total: rows.length, items: rows };
}

export interface ExerciseInput {
  slug: string;
  name: string;
  equipment: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  difficulty: string;
  instructions: string[];
  cues: string[];
  contraindications: string[];
  isUnilateral: boolean;
  usesBarbell: boolean;
  defaultRestSec: number;
  loadStepKg: number;
  mediaUrl: string | null;
}

/** Tenants may only add to the library, never edit the shared rows
 *  (`tenantId is null`) — every write here is scoped to the caller's own
 *  tenant by construction. */
export function createExercise(ctx: RequestContext, input: ExerciseInput) {
  const existing = db
    .select({ id: schema.exercises.id })
    .from(schema.exercises)
    .where(and(eq(schema.exercises.slug, input.slug), or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, ctx.tenantId))))
    .get();
  if (existing) throw conflict('An exercise with that slug already exists.');

  const exerciseId = id('exr');
  transact(() => {
    db.insert(schema.exercises)
      .values({
      id: exerciseId,
      tenantId: ctx.tenantId,
      slug: input.slug,
      name: input.name,
      aliases: [],
      equipment: input.equipment,
      primaryMuscles: input.primaryMuscles as (typeof schema.exercises.$inferInsert)['primaryMuscles'],
      secondaryMuscles: input.secondaryMuscles as (typeof schema.exercises.$inferInsert)['secondaryMuscles'],
      difficulty: input.difficulty,
      instructions: input.instructions,
      cues: input.cues,
      contraindications: input.contraindications,
      substitutionIds: [],
      isUnilateral: input.isUnilateral,
      usesBarbell: input.usesBarbell,
      defaultRestSec: input.defaultRestSec,
      loadStepKg: input.loadStepKg,
      mediaUrl: input.mediaUrl,
      archived: false,
      })
      .run();

    audit(ctx, {
      action: 'exercise.created',
      entityType: 'exercise',
      entityId: exerciseId,
      entityLabel: input.name,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      after: { slug: input.slug },
    });
  });

  return db.select().from(schema.exercises).where(and(eq(schema.exercises.id, exerciseId), eq(schema.exercises.tenantId, ctx.tenantId))).get()!;
}

/** Loads a tenant-owned exercise for editing. The shared library
 *  (`tenantId: null`) is read-only from every admin route — attempting to
 *  edit it is treated as "not found", the same as any other out-of-scope
 *  write target. */
function loadOwnExercise(ctx: { tenantId: string }, exerciseId: string) {
  const row = db
    .select()
    .from(schema.exercises)
    .where(and(eq(schema.exercises.id, exerciseId), eq(schema.exercises.tenantId, ctx.tenantId)))
    .get();
  if (!row) throw notFound('That exercise');
  return row;
}

export function updateExercise(ctx: RequestContext, exerciseId: string, patch: Partial<ExerciseInput>) {
  const exercise = loadOwnExercise(ctx, exerciseId);
  transact(() => {
    db.update(schema.exercises)
      .set({
      name: patch.name ?? exercise.name,
      equipment: patch.equipment ?? exercise.equipment,
      primaryMuscles: (patch.primaryMuscles as (typeof schema.exercises.$inferInsert)['primaryMuscles']) ?? exercise.primaryMuscles,
      secondaryMuscles: (patch.secondaryMuscles as (typeof schema.exercises.$inferInsert)['secondaryMuscles']) ?? exercise.secondaryMuscles,
      difficulty: patch.difficulty ?? exercise.difficulty,
      instructions: patch.instructions ?? exercise.instructions,
      cues: patch.cues ?? exercise.cues,
      contraindications: patch.contraindications ?? exercise.contraindications,
      isUnilateral: patch.isUnilateral ?? exercise.isUnilateral,
      usesBarbell: patch.usesBarbell ?? exercise.usesBarbell,
      defaultRestSec: patch.defaultRestSec ?? exercise.defaultRestSec,
      loadStepKg: patch.loadStepKg ?? exercise.loadStepKg,
      mediaUrl: patch.mediaUrl !== undefined ? patch.mediaUrl : exercise.mediaUrl,
      })
      .where(and(eq(schema.exercises.id, exerciseId), eq(schema.exercises.tenantId, ctx.tenantId)))
      .run();

    audit(ctx, {
      action: 'exercise.updated',
      entityType: 'exercise',
      entityId: exerciseId,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { name: exercise.name },
      after: { name: patch.name ?? exercise.name },
    });
  });

  return db.select().from(schema.exercises).where(and(eq(schema.exercises.id, exerciseId), eq(schema.exercises.tenantId, ctx.tenantId))).get()!;
}

export function archiveExercise(ctx: RequestContext, exerciseId: string) {
  const exercise = loadOwnExercise(ctx, exerciseId);
  transact(() => {
    db.update(schema.exercises).set({ archived: true }).where(and(eq(schema.exercises.id, exerciseId), eq(schema.exercises.tenantId, ctx.tenantId))).run();
    audit(ctx, {
      action: 'exercise.archived',
      entityType: 'exercise',
      entityId: exerciseId,
      entityLabel: exercise.name,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { archived: false },
      after: { archived: true },
    });
  });
  return db.select().from(schema.exercises).where(and(eq(schema.exercises.id, exerciseId), eq(schema.exercises.tenantId, ctx.tenantId))).get()!;
}

/* ============================================================================
   Programs — draft, publish, version. Tenant-wide, not branch-scoped: a
   program is a piece of intellectual property the gym owns, not a physical
   resource tied to one location.
   ========================================================================= */

export function loadProgramInScope(ctx: { tenantId: string }, programId: string): typeof schema.programs.$inferSelect {
  const row = db
    .select()
    .from(schema.programs)
    .where(and(eq(schema.programs.id, programId), eq(schema.programs.tenantId, ctx.tenantId)))
    .get();
  if (!row) throw notFound('That program');
  return row;
}

function assertDraft(program: typeof schema.programs.$inferSelect): void {
  if (program.state !== 'draft') {
    throw precondition('Published programs are read-only. Create a new version to make changes.');
  }
}

export interface ProgramListQuery {
  state?: string;
  q?: string;
  all?: boolean;
}

/** By default, one row per program "family" (grouped by name — there is no
 *  family/template id column, see the plan doc's versioning decision): the
 *  highest version. `all: true` returns every version of every program. */
export function listPrograms(ctx: { tenantId: string }, query: ProgramListQuery) {
  const rows = db
    .select()
    .from(schema.programs)
    .where(eq(schema.programs.tenantId, ctx.tenantId))
    .orderBy(desc(schema.programs.version))
    .all()
    .filter((p) => !query.state || p.state === query.state)
    .filter((p) => !query.q || p.name.toLowerCase().includes(query.q!.toLowerCase()));

  const items = query.all
    ? rows
    : [...new Map(rows.map((p) => [p.name, p])).values()].sort((a, b) => b.updatedAt - a.updatedAt);

  return { total: items.length, items };
}

function programDaysWithItems(tenantId: string, programId: string) {
  const days = db
    .select()
    .from(schema.programDays)
    .where(and(eq(schema.programDays.programId, programId), eq(schema.programDays.tenantId, tenantId)))
    .orderBy(asc(schema.programDays.week), asc(schema.programDays.dayIndex))
    .all();

  const items =
    days.length > 0
      ? db
          .select()
          .from(schema.programItems)
          .where(
            and(
              inArray(
                schema.programItems.programDayId,
                days.map((d) => d.id),
              ),
              eq(schema.programItems.tenantId, tenantId),
            ),
          )
          .orderBy(asc(schema.programItems.orderIndex))
          .all()
      : [];

  const exerciseIds = [...new Set(items.map((i) => i.exerciseId))];
  const exercises = exerciseIds.length
    ? new Map(
        db
          .select({ id: schema.exercises.id, name: schema.exercises.name })
          .from(schema.exercises)
          .where(and(inArray(schema.exercises.id, exerciseIds), or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, tenantId))))
          .all()
          .map((e) => [e.id, e.name]),
      )
    : new Map<string, string>();

  const itemsByDay = new Map<string, typeof items>();
  for (const item of items) {
    const bucket = itemsByDay.get(item.programDayId) ?? [];
    bucket.push(item);
    itemsByDay.set(item.programDayId, bucket);
  }

  return days.map((day) => ({
    id: day.id,
    week: day.week,
    dayIndex: day.dayIndex,
    label: day.label,
    focus: day.focus,
    isRest: day.isRest,
    estimatedMin: day.estimatedMin,
    items: (itemsByDay.get(day.id) ?? []).map((item) => ({
      id: item.id,
      orderIndex: item.orderIndex,
      exerciseId: item.exerciseId,
      exerciseName: exercises.get(item.exerciseId) ?? 'Exercise removed from the library',
      sets: item.sets,
      targetLabel: item.targetLabel,
      supersetGroup: item.supersetGroup,
      tempo: item.tempo,
      notes: item.notes,
      rationale: item.rationale,
      trainerLocked: item.trainerLocked,
      allowedSubstitutionIds: item.allowedSubstitutionIds,
    })),
  }));
}

export function programDetail(ctx: { tenantId: string }, programId: string) {
  const program = loadProgramInScope(ctx, programId);
  return { program, days: programDaysWithItems(ctx.tenantId, programId) };
}

export interface ProgramMetaInput {
  name: string;
  goal: string;
  daysPerWeek: number;
  weeks: number;
  description: string;
}

export function createDraftProgram(ctx: RequestContext, input: ProgramMetaInput) {
  const atMs = now();
  const programId = id('prg');
  transact(() => {
    db.insert(schema.programs)
      .values({
      id: programId,
      tenantId: ctx.tenantId,
      name: input.name,
      version: 1,
      goal: input.goal,
      daysPerWeek: input.daysPerWeek,
      weeks: input.weeks,
      authorId: ctx.staffId,
      authorName: ctx.name,
      description: input.description,
      state: 'draft',
      createdAt: atMs,
        updatedAt: atMs,
      })
      .run();

    audit(ctx, {
      action: 'program.created',
      entityType: 'program',
      entityId: programId,
      entityLabel: input.name,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      after: { name: input.name, version: 1 },
    });
  });

  return db.select().from(schema.programs).where(and(eq(schema.programs.id, programId), eq(schema.programs.tenantId, ctx.tenantId))).get()!;
}

export function updateProgramMeta(ctx: RequestContext, programId: string, patch: Partial<ProgramMetaInput>) {
  const atMs = now();
  const program = loadProgramInScope(ctx, programId);
  assertDraft(program);

  transact(() => {
    db.update(schema.programs)
      .set({
      name: patch.name ?? program.name,
      goal: patch.goal ?? program.goal,
      daysPerWeek: patch.daysPerWeek ?? program.daysPerWeek,
      weeks: patch.weeks ?? program.weeks,
      description: patch.description ?? program.description,
        updatedAt: atMs,
      })
      .where(and(eq(schema.programs.id, programId), eq(schema.programs.tenantId, ctx.tenantId)))
      .run();

    audit(ctx, {
      action: 'program.updated',
      entityType: 'program',
      entityId: programId,
      entityLabel: program.name,
      before: { name: program.name, goal: program.goal, daysPerWeek: program.daysPerWeek, weeks: program.weeks },
      after: { name: patch.name ?? program.name, goal: patch.goal ?? program.goal, daysPerWeek: patch.daysPerWeek ?? program.daysPerWeek, weeks: patch.weeks ?? program.weeks },
    });
  });

  return db.select().from(schema.programs).where(and(eq(schema.programs.id, programId), eq(schema.programs.tenantId, ctx.tenantId))).get()!;
}

/** A new version is a fresh, independent row: publishing never mutates a
 *  version anyone might already be assigned. Version numbers are the max
 *  seen so far under the same `(tenantId, name)` — the closest thing to a
 *  family key this schema has (there is no dedicated column for it). */
export function createNewVersion(ctx: RequestContext, sourceProgramId: string) {
  const atMs = now();
  const source = loadProgramInScope(ctx, sourceProgramId);
  if (source.state === 'draft') throw precondition('This program is already a draft — edit it directly.');

  const maxVersion =
    db
      .select({ max: sql<number>`max(${schema.programs.version})` })
      .from(schema.programs)
      .where(and(eq(schema.programs.tenantId, ctx.tenantId), eq(schema.programs.name, source.name)))
      .get()?.max ?? source.version;

  return transact(() => {
    const newProgramId = id('prg');
    db.insert(schema.programs)
      .values({
        id: newProgramId,
        tenantId: ctx.tenantId,
        name: source.name,
        version: maxVersion + 1,
        goal: source.goal,
        daysPerWeek: source.daysPerWeek,
        weeks: source.weeks,
        authorId: ctx.staffId,
        authorName: ctx.name,
        description: source.description,
        state: 'draft',
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();

    const sourceDays = db
      .select()
      .from(schema.programDays)
      .where(and(eq(schema.programDays.programId, sourceProgramId), eq(schema.programDays.tenantId, ctx.tenantId)))
      .all();
    const dayIdMap = new Map<string, string>();
    for (const day of sourceDays) {
      const newDayId = id('pgd');
      dayIdMap.set(day.id, newDayId);
      db.insert(schema.programDays)
        .values({
          id: newDayId,
          tenantId: ctx.tenantId,
          programId: newProgramId,
          week: day.week,
          dayIndex: day.dayIndex,
          label: day.label,
          focus: day.focus,
          isRest: day.isRest,
          estimatedMin: day.estimatedMin,
        })
        .run();
    }

    if (sourceDays.length > 0) {
      const sourceItems = db
        .select()
        .from(schema.programItems)
        .where(and(inArray(schema.programItems.programDayId, sourceDays.map((d) => d.id)), eq(schema.programItems.tenantId, ctx.tenantId)))
        .all();
      for (const item of sourceItems) {
        const newDayId = dayIdMap.get(item.programDayId);
        if (!newDayId) continue;
        db.insert(schema.programItems)
          .values({
            id: id('pgi'),
            tenantId: ctx.tenantId,
            programDayId: newDayId,
            orderIndex: item.orderIndex,
            exerciseId: item.exerciseId,
            sets: item.sets,
            targetLabel: item.targetLabel,
            supersetGroup: item.supersetGroup,
            tempo: item.tempo,
            notes: item.notes,
            rationale: item.rationale,
            trainerLocked: item.trainerLocked,
            allowedSubstitutionIds: item.allowedSubstitutionIds,
          })
          .run();
      }
    }

    audit(ctx, {
      action: 'program.new_version',
      entityType: 'program',
      entityId: newProgramId,
      entityLabel: source.name,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { sourceProgramId, version: source.version },
      after: { version: maxVersion + 1 },
    });

    return db.select().from(schema.programs).where(and(eq(schema.programs.id, newProgramId), eq(schema.programs.tenantId, ctx.tenantId))).get()!;
  });
}

/** A program with no real content publishing successfully is a trap for the
 *  first member assigned to it — refused, not silently allowed. */
export function publishProgram(ctx: RequestContext, programId: string) {
  const atMs = now();
  const program = loadProgramInScope(ctx, programId);
  assertDraft(program);

  const days = db
    .select({ id: schema.programDays.id, isRest: schema.programDays.isRest })
    .from(schema.programDays)
    .where(and(eq(schema.programDays.programId, programId), eq(schema.programDays.tenantId, ctx.tenantId)))
    .all();
  if (days.length === 0) throw invalid('Add at least one training day before publishing.');
  const trainingDays = days.filter((day) => !day.isRest);
  if (trainingDays.length === 0) throw invalid('Add at least one non-rest training day before publishing.');
  const hasItems =
    (db
      .select({ n: sql<number>`count(*)` })
      .from(schema.programItems)
      .where(
        and(inArray(schema.programItems.programDayId, trainingDays.map((d) => d.id)), eq(schema.programItems.tenantId, ctx.tenantId)),
      )
      .get()?.n ?? 0) > 0;
  if (!hasItems) throw invalid('Add at least one exercise to a training day before publishing.');

  const invalidItem = db
    .select({ exerciseId: schema.programItems.exerciseId })
    .from(schema.programItems)
    .where(and(inArray(schema.programItems.programDayId, trainingDays.map((d) => d.id)), eq(schema.programItems.tenantId, ctx.tenantId)))
    .all()
    .map((item) =>
      db
        .select({ id: schema.exercises.id })
        .from(schema.exercises)
        .where(and(eq(schema.exercises.id, item.exerciseId), or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, ctx.tenantId)), eq(schema.exercises.archived, false)))
        .get(),
    )
    .some((exercise) => !exercise);
  if (invalidItem) throw invalid('Every exercise in a published program must still be active in the catalogue.');

  transact(() => {
    db.update(schema.programs).set({ state: 'published', updatedAt: atMs }).where(and(eq(schema.programs.id, programId), eq(schema.programs.tenantId, ctx.tenantId))).run();

    audit(ctx, {
      action: 'program.published',
      entityType: 'program',
      entityId: programId,
      entityLabel: program.name,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { state: 'draft' },
      after: { state: 'published' },
    });
  });

  return db.select().from(schema.programs).where(and(eq(schema.programs.id, programId), eq(schema.programs.tenantId, ctx.tenantId))).get()!;
}

export function archiveProgram(ctx: RequestContext, programId: string) {
  const atMs = now();
  const program = loadProgramInScope(ctx, programId);
  if (program.state === 'archived') throw precondition('That program is already archived.');

  transact(() => {
    db.update(schema.programs).set({ state: 'archived', updatedAt: atMs }).where(and(eq(schema.programs.id, programId), eq(schema.programs.tenantId, ctx.tenantId))).run();

    audit(ctx, {
      action: 'program.archived',
      entityType: 'program',
      entityId: programId,
      entityLabel: program.name,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { state: program.state },
      after: { state: 'archived' },
    });
  });

  return db.select().from(schema.programs).where(and(eq(schema.programs.id, programId), eq(schema.programs.tenantId, ctx.tenantId))).get()!;
}

/* ============================================================================
   Program days and items — draft-only mutation.
   ========================================================================= */

function loadDraftDay(ctx: { tenantId: string }, dayId: string) {
  const day = db.select().from(schema.programDays).where(and(eq(schema.programDays.id, dayId), eq(schema.programDays.tenantId, ctx.tenantId))).get();
  if (!day) throw notFound('That day');
  const program = loadProgramInScope(ctx, day.programId);
  assertDraft(program);
  return { day, program };
}

export interface ProgramDayInput {
  week: number;
  dayIndex: number;
  label: string;
  focus: string;
  isRest: boolean;
  estimatedMin: number;
}

/** True upsert on `(programId, week, dayIndex)` — the schema does not enforce
 *  this uniquely, so the service does, letting the builder resubmit the same
 *  slot to edit it without tracking day ids client-side. */
export function upsertProgramDay(ctx: RequestContext, programId: string, input: ProgramDayInput) {
  const program = loadProgramInScope(ctx, programId);
  assertDraft(program);
  if (input.week > program.weeks) throw invalid('That week is outside this program.');

  const existing = db
    .select()
    .from(schema.programDays)
    .where(
      and(
        eq(schema.programDays.programId, programId),
        eq(schema.programDays.tenantId, ctx.tenantId),
        eq(schema.programDays.week, input.week),
        eq(schema.programDays.dayIndex, input.dayIndex),
      ),
    )
    .get();

  const dayId = existing?.id ?? id('pgd');
  transact(() => {
    if (existing) {
      db.update(schema.programDays)
      .set({ label: input.label, focus: input.focus, isRest: input.isRest, estimatedMin: input.estimatedMin })
      .where(and(eq(schema.programDays.id, dayId), eq(schema.programDays.tenantId, ctx.tenantId)))
      .run();
    } else {
      db.insert(schema.programDays)
        .values({
        id: dayId,
        tenantId: ctx.tenantId,
        programId,
        week: input.week,
        dayIndex: input.dayIndex,
        label: input.label,
        focus: input.focus,
        isRest: input.isRest,
        estimatedMin: input.estimatedMin,
        })
        .run();
    }

    audit(ctx, {
      action: existing ? 'program.day_updated' : 'program.day_created',
      entityType: 'program_day',
      entityId: dayId,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      after: { programId, week: input.week, dayIndex: input.dayIndex, isRest: input.isRest },
    });
  });

  return db.select().from(schema.programDays).where(and(eq(schema.programDays.id, dayId), eq(schema.programDays.tenantId, ctx.tenantId))).get()!;
}

export function deleteProgramDay(ctx: RequestContext, dayId: string) {
  const { day } = loadDraftDay(ctx, dayId);
  transact(() => {
    db.delete(schema.programItems).where(and(eq(schema.programItems.programDayId, dayId), eq(schema.programItems.tenantId, ctx.tenantId))).run();
    db.delete(schema.programDays).where(and(eq(schema.programDays.id, dayId), eq(schema.programDays.tenantId, ctx.tenantId))).run();
    audit(ctx, {
      action: 'program.day_deleted',
      entityType: 'program_day',
      entityId: day.id,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { programId: day.programId, week: day.week, dayIndex: day.dayIndex },
    });
  });
  return { ok: true, dayId: day.id };
}

export interface ProgramItemInput {
  exerciseId: string;
  sets: unknown;
  targetLabel: string;
  supersetGroup: string | null;
  tempo: string | null;
  notes: string | null;
  rationale: string | null;
  trainerLocked: boolean;
  allowedSubstitutionIds: string[];
  orderIndex?: number;
}

function assertValidSets(sets: unknown): void {
  const parsed = PrescribedSet.array().safeParse(sets);
  if (!parsed.success) throw invalid('Sets are not shaped correctly — check reps, RPE and rest values.');
  if (parsed.data.some((set) => set.repLow < 0 || set.repHigh < set.repLow || set.restSec < 0 || set.restSec > 600 || (set.targetWeightKg !== null && set.targetWeightKg < 0) || (set.targetRpe !== null && (set.targetRpe < 1 || set.targetRpe > 10)))) {
    throw invalid('Each set needs valid reps, load, RPE and rest values.');
  }
}

function validateSubstitutions(tenantId: string, exerciseIds: string[]): void {
  if (exerciseIds.length === 0) return;
  const distinct = [...new Set(exerciseIds)];
  const rows = db
    .select({ id: schema.exercises.id })
    .from(schema.exercises)
    .where(and(inArray(schema.exercises.id, distinct), or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, tenantId)), eq(schema.exercises.archived, false)))
    .all();
  if (rows.length !== distinct.length) throw invalid('Every substitution must be an active exercise in this tenant catalogue.');
}

export function addProgramItem(ctx: RequestContext, dayId: string, input: ProgramItemInput) {
  loadDraftDay(ctx, dayId);
  assertValidSets(input.sets);

  const exercise = db
    .select({ id: schema.exercises.id })
    .from(schema.exercises)
    .where(and(eq(schema.exercises.id, input.exerciseId), or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, ctx.tenantId)), eq(schema.exercises.archived, false)))
    .get();
  if (!exercise) throw notFound('That exercise');
  validateSubstitutions(ctx.tenantId, input.allowedSubstitutionIds);

  const maxOrder =
    db
      .select({ max: sql<number>`max(${schema.programItems.orderIndex})` })
      .from(schema.programItems)
      .where(and(eq(schema.programItems.programDayId, dayId), eq(schema.programItems.tenantId, ctx.tenantId)))
      .get()?.max ?? -1;

  const itemId = id('pgi');
  transact(() => {
    db.insert(schema.programItems)
      .values({
      id: itemId,
      tenantId: ctx.tenantId,
      programDayId: dayId,
      orderIndex: input.orderIndex ?? maxOrder + 1,
      exerciseId: input.exerciseId,
      sets: input.sets as (typeof schema.programItems.$inferInsert)['sets'],
      targetLabel: input.targetLabel,
      supersetGroup: input.supersetGroup,
      tempo: input.tempo,
      notes: input.notes,
      rationale: input.rationale,
      trainerLocked: input.trainerLocked,
      allowedSubstitutionIds: input.allowedSubstitutionIds,
      })
      .run();

    audit(ctx, {
      action: 'program.item_added',
      entityType: 'program_item',
      entityId: itemId,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      after: { programDayId: dayId, exerciseId: input.exerciseId, orderIndex: input.orderIndex ?? maxOrder + 1 },
    });
  });

  return db.select().from(schema.programItems).where(and(eq(schema.programItems.id, itemId), eq(schema.programItems.tenantId, ctx.tenantId))).get()!;
}

function loadDraftItem(ctx: { tenantId: string }, itemId: string) {
  const item = db.select().from(schema.programItems).where(and(eq(schema.programItems.id, itemId), eq(schema.programItems.tenantId, ctx.tenantId))).get();
  if (!item) throw notFound('That exercise in the plan');
  loadDraftDay(ctx, item.programDayId);
  return item;
}

export function updateProgramItem(ctx: RequestContext, itemId: string, patch: Partial<ProgramItemInput>) {
  const item = loadDraftItem(ctx, itemId);
  if (patch.sets !== undefined) assertValidSets(patch.sets);
  if (patch.exerciseId !== undefined) {
    const exercise = db
      .select({ id: schema.exercises.id })
      .from(schema.exercises)
      .where(and(eq(schema.exercises.id, patch.exerciseId), or(isNull(schema.exercises.tenantId), eq(schema.exercises.tenantId, ctx.tenantId)), eq(schema.exercises.archived, false)))
      .get();
    if (!exercise) throw notFound('That exercise');
  }
  if (patch.allowedSubstitutionIds !== undefined) validateSubstitutions(ctx.tenantId, patch.allowedSubstitutionIds);

  const siblings = patch.orderIndex !== undefined
    ? db
        .select({ id: schema.programItems.id, orderIndex: schema.programItems.orderIndex })
        .from(schema.programItems)
        .where(and(eq(schema.programItems.programDayId, item.programDayId), eq(schema.programItems.tenantId, ctx.tenantId)))
        .orderBy(asc(schema.programItems.orderIndex))
        .all()
    : [];
  const currentIndex = siblings.findIndex((sibling) => sibling.id === item.id);
  const requestedIndex = patch.orderIndex === undefined || currentIndex < 0
    ? currentIndex
    : Math.max(0, Math.min(siblings.length - 1, patch.orderIndex));
  const targetSibling = requestedIndex >= 0 ? siblings[requestedIndex] : undefined;
  const shouldSwap = Boolean(targetSibling && targetSibling.id !== item.id && requestedIndex !== currentIndex);

  transact(() => {
    if (shouldSwap && targetSibling) {
      db.update(schema.programItems)
        .set({ orderIndex: item.orderIndex })
        .where(and(eq(schema.programItems.id, targetSibling.id), eq(schema.programItems.tenantId, ctx.tenantId)))
        .run();
    }
    db.update(schema.programItems)
      .set({
      orderIndex: shouldSwap && targetSibling ? targetSibling.orderIndex : patch.orderIndex ?? item.orderIndex,
      exerciseId: patch.exerciseId ?? item.exerciseId,
      sets: patch.sets !== undefined ? (patch.sets as (typeof schema.programItems.$inferInsert)['sets']) : item.sets,
      targetLabel: patch.targetLabel ?? item.targetLabel,
      supersetGroup: patch.supersetGroup !== undefined ? patch.supersetGroup : item.supersetGroup,
      tempo: patch.tempo !== undefined ? patch.tempo : item.tempo,
      notes: patch.notes !== undefined ? patch.notes : item.notes,
      rationale: patch.rationale !== undefined ? patch.rationale : item.rationale,
      trainerLocked: patch.trainerLocked ?? item.trainerLocked,
      allowedSubstitutionIds: patch.allowedSubstitutionIds ?? item.allowedSubstitutionIds,
      })
      .where(and(eq(schema.programItems.id, itemId), eq(schema.programItems.tenantId, ctx.tenantId)))
      .run();

    audit(ctx, {
      action: 'program.item_updated',
      entityType: 'program_item',
      entityId: itemId,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { exerciseId: item.exerciseId, orderIndex: item.orderIndex, targetLabel: item.targetLabel },
      after: { exerciseId: patch.exerciseId ?? item.exerciseId, orderIndex: shouldSwap && targetSibling ? targetSibling.orderIndex : patch.orderIndex ?? item.orderIndex, targetLabel: patch.targetLabel ?? item.targetLabel },
    });
  });

  return db.select().from(schema.programItems).where(and(eq(schema.programItems.id, itemId), eq(schema.programItems.tenantId, ctx.tenantId))).get()!;
}

export function deleteProgramItem(ctx: RequestContext, itemId: string) {
  const item = loadDraftItem(ctx, itemId);
  transact(() => {
    db.delete(schema.programItems).where(and(eq(schema.programItems.id, itemId), eq(schema.programItems.tenantId, ctx.tenantId))).run();
    audit(ctx, {
      action: 'program.item_deleted',
      entityType: 'program_item',
      entityId: itemId,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { exerciseId: item.exerciseId, programDayId: item.programDayId },
    });
  });
  return { ok: true, itemId: item.id };
}

/* ============================================================================
   Trainer and program assignment
   ========================================================================= */

/** Sets who is coaching this member. This is the scope gate
 *  `requireAssignedMember` reads (`members.trainerId`) — until this is set, a
 *  trainer-role session cannot see the member at all. `null` unassigns. */
export function assignTrainer(ctx: RequestContext, memberId: string, trainerId: string | null) {
  const member = loadMemberInScope(ctx, memberId);

  if (trainerId) {
    const staff = loadStaffInScope(ctx, trainerId);
    const staffUser = db
      .select({ role: schema.users.role, accountState: schema.users.accountState })
      .from(schema.users)
      .where(and(eq(schema.users.id, staff.userId), eq(schema.users.tenantId, ctx.tenantId)))
      .get();
    if (!staffUser || staffUser.role !== 'trainer' || staff.employmentStatus !== 'active' || staffUser.accountState !== 'active') {
      throw invalid('That trainer is not active and cannot receive members.');
    }
    if (!staff.branchIds.includes(member.homeBranchId)) throw invalid('That trainer is not assigned to the member\'s home branch.');
  }

  const before = member.trainerId;
  transact(() => {
    db.update(schema.members)
      .set({ trainerId })
      .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId)))
      .run();

    audit(ctx, {
      action: 'member.trainer_assigned',
      entityType: 'member',
      entityId: memberId,
      entityLabel: member.memberNo,
      branchId: member.homeBranchId,
      before: { trainerId: before },
      after: { trainerId },
    });
  });

  return db.select().from(schema.members).where(eq(schema.members.id, memberId)).get()!;
}

export interface AssignProgramInput {
  memberId: string;
  programId: string;
  startsOn: string;
  trainerId?: string | null;
  replaceActive?: boolean;
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid('Choose a valid start date.');
  }
}

function activeTrainerForMember(ctx: RequestContext, member: typeof schema.members.$inferSelect, trainerId: string | null) {
  if (!trainerId) return null;
  const staff = loadStaffInScope(ctx, trainerId);
  const staffUser = db
    .select({ role: schema.users.role, accountState: schema.users.accountState })
    .from(schema.users)
    .where(and(eq(schema.users.id, staff.userId), eq(schema.users.tenantId, ctx.tenantId)))
    .get();
  if (!staffUser || staffUser.role !== 'trainer' || staff.employmentStatus !== 'active' || staffUser.accountState !== 'active') {
    throw invalid('That trainer is not active and cannot receive a program.');
  }
  if (!staff.branchIds.includes(member.homeBranchId)) throw invalid('That trainer is not assigned to the member\'s home branch.');
  return staff;
}

/** Assigning a program never edits a prior assignment's row — it is closed
 *  (`state: 'replaced'`) and a new one takes its place, so history stays
 *  intact and `assignments.programVersion` keeps meaning exactly what it
 *  said the day it was written. */
export function assignProgram(ctx: RequestContext, input: AssignProgramInput) {
  const atMs = now();
  const member = loadMemberInScope(ctx, input.memberId);
  const program = loadProgramInScope(ctx, input.programId);
  if (program.state !== 'published') throw precondition('Only a published program can be assigned.');
  assertIsoDate(input.startsOn);

  const trainerId = input.trainerId !== undefined ? input.trainerId : member.trainerId;
  if (!trainerId) throw invalid('A published program assignment needs an active trainer.');
  activeTrainerForMember(ctx, member, trainerId);

  return transact(() => {
    const activePrior = db
      .select()
      .from(schema.assignments)
      .where(
        and(
          eq(schema.assignments.memberId, input.memberId),
          eq(schema.assignments.tenantId, ctx.tenantId),
          eq(schema.assignments.state, 'active'),
        ),
      )
      .get();

    if (activePrior && !input.replaceActive) {
      throw conflict('This member already has an active program. Use the explicit replace flow to change it.');
    }

    if (activePrior) {
      db.update(schema.assignments)
        .set({ state: 'replaced', updatedAt: atMs })
        .where(eq(schema.assignments.id, activePrior.id))
        .run();
    }

    if (input.trainerId !== undefined && member.trainerId !== trainerId) {
      db.update(schema.members)
        .set({ trainerId })
        .where(and(eq(schema.members.id, member.id), eq(schema.members.tenantId, ctx.tenantId)))
        .run();
      audit(ctx, {
        action: 'member.trainer_assigned',
        entityType: 'member',
        entityId: member.id,
        entityLabel: member.memberNo,
        branchId: member.homeBranchId,
        before: { trainerId: member.trainerId },
        after: { trainerId },
      });
    }

    const assignmentId = id('asg');
    db.insert(schema.assignments)
      .values({
        id: assignmentId,
        tenantId: ctx.tenantId,
        memberId: input.memberId,
        programId: program.id,
        programVersion: program.version,
        trainerId,
        startsOn: input.startsOn,
        currentWeek: 1,
        currentBlock: 'A',
        state: 'active',
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();

    audit(ctx, {
      action: 'assignment.created',
      entityType: 'assignment',
      entityId: assignmentId,
      entityLabel: `${member.memberNo} · ${program.name}`,
      branchId: member.homeBranchId,
      before: activePrior ? { previousAssignmentId: activePrior.id, previousProgramId: activePrior.programId } : null,
      after: { programId: program.id, programVersion: program.version },
    });

    if (member.userId) {
      db.insert(schema.notifications)
        .values({
          id: id('ntf'),
          tenantId: ctx.tenantId,
          userId: member.userId,
          channel: 'in_app',
          kind: 'plan_assigned',
          title: 'Your coach set up a new plan',
          body: `${program.name} starts ${input.startsOn}.`,
          link: '/train',
          templateCode: 'assignment.created',
          state: 'sent',
          attempts: 1,
          lastError: null,
          createdAt: atMs,
          readAt: null,
        })
        .run();

      emit({
        tenantId: ctx.tenantId,
        branchId: member.homeBranchId,
        channel: channels.member(member.id),
        topic: 'notification.created',
        payload: { kind: 'plan_assigned', assignmentId },
      });
    }

    return db.select().from(schema.assignments).where(and(eq(schema.assignments.id, assignmentId), eq(schema.assignments.tenantId, ctx.tenantId))).get()!;
  });
}

function loadAssignmentInScope(ctx: { tenantId: string; branchIds: string[] }, assignmentId: string) {
  const row = db.select().from(schema.assignments).where(and(eq(schema.assignments.id, assignmentId), eq(schema.assignments.tenantId, ctx.tenantId))).get();
  if (!row) throw notFound('That assignment');
  loadMemberInScope(ctx, row.memberId);
  return row;
}

export function endAssignment(ctx: RequestContext, assignmentId: string, toState: 'paused' | 'active' | 'completed') {
  const atMs = now();
  const assignment = loadAssignmentInScope(ctx, assignmentId);
  if (assignment.state !== 'active' && assignment.state !== 'paused') {
    throw precondition('That plan is no longer active, so its state cannot change.');
  }
  if (toState === 'active') {
    const otherActive = db
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(and(eq(schema.assignments.tenantId, ctx.tenantId), eq(schema.assignments.memberId, assignment.memberId), eq(schema.assignments.state, 'active'), ne(schema.assignments.id, assignmentId)))
      .get();
    if (otherActive) throw conflict('This member already has another active program.');
  }

  transact(() => {
    db.update(schema.assignments).set({ state: toState, updatedAt: atMs }).where(and(eq(schema.assignments.id, assignmentId), eq(schema.assignments.tenantId, ctx.tenantId))).run();

    audit(ctx, {
      action: 'assignment.state_changed',
      entityType: 'assignment',
      entityId: assignmentId,
      branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
      before: { state: assignment.state },
      after: { state: toState },
    });
  });

  return db.select().from(schema.assignments).where(and(eq(schema.assignments.id, assignmentId), eq(schema.assignments.tenantId, ctx.tenantId))).get()!;
}

export function assignmentHistory(ctx: { tenantId: string; branchIds: string[] }, memberId: string) {
  loadMemberInScope(ctx, memberId);
  const rows = db
    .select({
      id: schema.assignments.id,
      programId: schema.assignments.programId,
      programVersion: schema.assignments.programVersion,
      trainerId: schema.assignments.trainerId,
      startsOn: schema.assignments.startsOn,
      currentWeek: schema.assignments.currentWeek,
      state: schema.assignments.state,
      createdAt: schema.assignments.createdAt,
      programName: schema.programs.name,
      programGoal: schema.programs.goal,
      programWeeks: schema.programs.weeks,
    })
    .from(schema.assignments)
    .innerJoin(schema.programs, eq(schema.programs.id, schema.assignments.programId))
    .where(and(eq(schema.assignments.memberId, memberId), eq(schema.assignments.tenantId, ctx.tenantId), eq(schema.programs.tenantId, ctx.tenantId)))
    .orderBy(desc(schema.assignments.createdAt))
    .all();

  return rows;
}

/** The Member 360 read model — one function `routes/admin/members.ts` calls
 *  directly rather than a second permission-checked route for data
 *  `member.view` already covers. */
export function memberTrainingSummary(ctx: { tenantId: string; branchIds: string[] }, memberId: string) {
  const active = db
    .select({
      id: schema.assignments.id,
      currentWeek: schema.assignments.currentWeek,
      currentBlock: schema.assignments.currentBlock,
      state: schema.assignments.state,
      programName: schema.programs.name,
      programVersion: schema.assignments.programVersion,
      programWeeks: schema.programs.weeks,
    })
    .from(schema.assignments)
    .innerJoin(schema.programs, eq(schema.programs.id, schema.assignments.programId))
    .where(
      and(
        eq(schema.assignments.memberId, memberId),
        eq(schema.assignments.tenantId, ctx.tenantId),
        eq(schema.assignments.state, 'active'),
        eq(schema.programs.tenantId, ctx.tenantId),
      ),
    )
    .get();

  return {
    activeAssignment: active
      ? {
          id: active.id,
          programName: active.programName,
          version: active.programVersion,
          week: active.currentWeek,
          of: active.programWeeks,
          block: active.currentBlock,
          state: active.state,
        }
      : null,
  };
}
