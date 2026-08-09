import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
    .where(sql`(${schema.exercises.tenantId} is null or ${schema.exercises.tenantId} = ${ctx.tenantId})`)
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
  const existing = db.select({ id: schema.exercises.id }).from(schema.exercises).where(eq(schema.exercises.slug, input.slug)).get();
  if (existing) throw conflict('An exercise with that slug already exists.');

  const exerciseId = id('exr');
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

  return db.select().from(schema.exercises).where(eq(schema.exercises.id, exerciseId)).get()!;
}

/** Loads a tenant-owned exercise for editing. The shared library
 *  (`tenantId: null`) is read-only from every admin route — attempting to
 *  edit it is treated as "not found", the same as any other out-of-scope
 *  write target. */
function loadOwnExercise(ctx: { tenantId: string }, exerciseId: string) {
  const row = db.select().from(schema.exercises).where(eq(schema.exercises.id, exerciseId)).get();
  if (!row || row.tenantId !== ctx.tenantId) throw notFound('That exercise');
  return row;
}

export function updateExercise(ctx: RequestContext, exerciseId: string, patch: Partial<ExerciseInput>) {
  const exercise = loadOwnExercise(ctx, exerciseId);
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
    .where(eq(schema.exercises.id, exerciseId))
    .run();

  audit(ctx, {
    action: 'exercise.updated',
    entityType: 'exercise',
    entityId: exerciseId,
    branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
    before: { name: exercise.name },
    after: { name: patch.name ?? exercise.name },
  });

  return db.select().from(schema.exercises).where(eq(schema.exercises.id, exerciseId)).get()!;
}

export function archiveExercise(ctx: RequestContext, exerciseId: string) {
  const exercise = loadOwnExercise(ctx, exerciseId);
  db.update(schema.exercises).set({ archived: true }).where(eq(schema.exercises.id, exerciseId)).run();
  audit(ctx, {
    action: 'exercise.archived',
    entityType: 'exercise',
    entityId: exerciseId,
    entityLabel: exercise.name,
    branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
    before: { archived: false },
    after: { archived: true },
  });
  return db.select().from(schema.exercises).where(eq(schema.exercises.id, exerciseId)).get()!;
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
          .where(inArray(schema.exercises.id, exerciseIds))
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

  return db.select().from(schema.programs).where(eq(schema.programs.id, programId)).get()!;
}

export function updateProgramMeta(ctx: RequestContext, programId: string, patch: Partial<ProgramMetaInput>) {
  const atMs = now();
  const program = loadProgramInScope(ctx, programId);
  assertDraft(program);

  db.update(schema.programs)
    .set({
      name: patch.name ?? program.name,
      goal: patch.goal ?? program.goal,
      daysPerWeek: patch.daysPerWeek ?? program.daysPerWeek,
      weeks: patch.weeks ?? program.weeks,
      description: patch.description ?? program.description,
      updatedAt: atMs,
    })
    .where(eq(schema.programs.id, programId))
    .run();

  return db.select().from(schema.programs).where(eq(schema.programs.id, programId)).get()!;
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

    const sourceDays = db.select().from(schema.programDays).where(eq(schema.programDays.programId, sourceProgramId)).all();
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
        .where(
          inArray(
            schema.programItems.programDayId,
            sourceDays.map((d) => d.id),
          ),
        )
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

    return db.select().from(schema.programs).where(eq(schema.programs.id, newProgramId)).get()!;
  });
}

/** A program with no real content publishing successfully is a trap for the
 *  first member assigned to it — refused, not silently allowed. */
export function publishProgram(ctx: RequestContext, programId: string) {
  const atMs = now();
  const program = loadProgramInScope(ctx, programId);
  assertDraft(program);

  const days = db.select({ id: schema.programDays.id }).from(schema.programDays).where(
    and(eq(schema.programDays.programId, programId), eq(schema.programDays.isRest, false)),
  ).all();
  const hasItems =
    days.length > 0 &&
    (db
      .select({ n: sql<number>`count(*)` })
      .from(schema.programItems)
      .where(
        inArray(
          schema.programItems.programDayId,
          days.map((d) => d.id),
        ),
      )
      .get()?.n ?? 0) > 0;
  if (!hasItems) throw invalid('Add at least one exercise to a training day before publishing.');

  db.update(schema.programs).set({ state: 'published', updatedAt: atMs }).where(eq(schema.programs.id, programId)).run();

  audit(ctx, {
    action: 'program.published',
    entityType: 'program',
    entityId: programId,
    entityLabel: program.name,
    branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
    before: { state: 'draft' },
    after: { state: 'published' },
  });

  return db.select().from(schema.programs).where(eq(schema.programs.id, programId)).get()!;
}

export function archiveProgram(ctx: RequestContext, programId: string) {
  const atMs = now();
  const program = loadProgramInScope(ctx, programId);
  if (program.state === 'archived') throw precondition('That program is already archived.');

  db.update(schema.programs).set({ state: 'archived', updatedAt: atMs }).where(eq(schema.programs.id, programId)).run();

  audit(ctx, {
    action: 'program.archived',
    entityType: 'program',
    entityId: programId,
    entityLabel: program.name,
    branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
    before: { state: program.state },
    after: { state: 'archived' },
  });

  return db.select().from(schema.programs).where(eq(schema.programs.id, programId)).get()!;
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

  const existing = db
    .select()
    .from(schema.programDays)
    .where(
      and(
        eq(schema.programDays.programId, programId),
        eq(schema.programDays.week, input.week),
        eq(schema.programDays.dayIndex, input.dayIndex),
      ),
    )
    .get();

  const dayId = existing?.id ?? id('pgd');
  if (existing) {
    db.update(schema.programDays)
      .set({ label: input.label, focus: input.focus, isRest: input.isRest, estimatedMin: input.estimatedMin })
      .where(eq(schema.programDays.id, dayId))
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

  return db.select().from(schema.programDays).where(eq(schema.programDays.id, dayId)).get()!;
}

export function deleteProgramDay(ctx: RequestContext, dayId: string) {
  const { day } = loadDraftDay(ctx, dayId);
  transact(() => {
    db.delete(schema.programItems).where(eq(schema.programItems.programDayId, dayId)).run();
    db.delete(schema.programDays).where(eq(schema.programDays.id, dayId)).run();
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
}

export function addProgramItem(ctx: RequestContext, dayId: string, input: ProgramItemInput) {
  loadDraftDay(ctx, dayId);
  assertValidSets(input.sets);

  const exercise = db.select({ id: schema.exercises.id }).from(schema.exercises).where(eq(schema.exercises.id, input.exerciseId)).get();
  if (!exercise) throw notFound('That exercise');

  const maxOrder =
    db
      .select({ max: sql<number>`max(${schema.programItems.orderIndex})` })
      .from(schema.programItems)
      .where(eq(schema.programItems.programDayId, dayId))
      .get()?.max ?? -1;

  const itemId = id('pgi');
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

  return db.select().from(schema.programItems).where(eq(schema.programItems.id, itemId)).get()!;
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

  db.update(schema.programItems)
    .set({
      orderIndex: patch.orderIndex ?? item.orderIndex,
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
    .where(eq(schema.programItems.id, itemId))
    .run();

  return db.select().from(schema.programItems).where(eq(schema.programItems.id, itemId)).get()!;
}

export function deleteProgramItem(ctx: RequestContext, itemId: string) {
  const item = loadDraftItem(ctx, itemId);
  db.delete(schema.programItems).where(eq(schema.programItems.id, itemId)).run();
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
    const staffUser = db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, staff.userId)).get();
    if (!staffUser || staffUser.role !== 'trainer') throw invalid('That staff member is not a trainer.');
  }

  const before = member.trainerId;
  db.update(schema.members).set({ trainerId }).where(eq(schema.members.id, memberId)).run();

  audit(ctx, {
    action: 'member.trainer_assigned',
    entityType: 'member',
    entityId: memberId,
    entityLabel: member.memberNo,
    branchId: member.homeBranchId,
    before: { trainerId: before },
    after: { trainerId },
  });

  return db.select().from(schema.members).where(eq(schema.members.id, memberId)).get()!;
}

export interface AssignProgramInput {
  memberId: string;
  programId: string;
  startsOn: string;
  trainerId?: string | null;
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

  const trainerId = input.trainerId !== undefined ? input.trainerId : member.trainerId;

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

    if (activePrior) {
      db.update(schema.assignments)
        .set({ state: 'replaced', updatedAt: atMs })
        .where(eq(schema.assignments.id, activePrior.id))
        .run();
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

    return db.select().from(schema.assignments).where(eq(schema.assignments.id, assignmentId)).get()!;
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

  db.update(schema.assignments).set({ state: toState, updatedAt: atMs }).where(eq(schema.assignments.id, assignmentId)).run();

  audit(ctx, {
    action: 'assignment.state_changed',
    entityType: 'assignment',
    entityId: assignmentId,
    branchId: ctx.activeBranchId ?? ctx.branchIds[0] ?? '',
    before: { state: assignment.state },
    after: { state: toState },
  });

  return db.select().from(schema.assignments).where(eq(schema.assignments.id, assignmentId)).get()!;
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
    .where(and(eq(schema.assignments.memberId, memberId), eq(schema.assignments.tenantId, ctx.tenantId)))
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
