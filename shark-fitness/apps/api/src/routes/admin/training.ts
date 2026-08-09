import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { Equipment, MuscleGroup, PrescribedSet } from '@shark/contracts';
import { requirePermission } from '../../lib/context.js';
import { ctxOf } from '../../middleware/index.js';
import {
  addProgramItem,
  archiveExercise,
  archiveProgram,
  assignProgram,
  assignTrainer,
  assignmentHistory,
  createDraftProgram,
  createExercise,
  createNewVersion,
  deleteProgramDay,
  deleteProgramItem,
  listExercises,
  listPrograms,
  programDetail,
  publishProgram,
  updateExercise,
  updateProgramItem,
  updateProgramMeta,
  upsertProgramDay,
  endAssignment,
} from '../../services/training-admin.js';

/**
 * Program builder, exercise library and trainer/program assignment
 * (PF-TRAIN). Route files are thin adapters — every rule lives in
 * `services/training-admin.ts`.
 */
export const trainingRoutes = new Hono();

/* ============================================================================
   Exercise library
   ========================================================================= */

const ExerciseListQuery = z.object({
  q: z.string().optional(),
  equipment: Equipment.optional(),
  archived: z.coerce.boolean().optional(),
});

trainingRoutes.get('/exercises', validate('query', ExerciseListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.view');
  return c.json(listExercises(ctx, c.req.valid('query')));
});

const ExerciseBody = z.object({
  slug: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  equipment: Equipment,
  primaryMuscles: z.array(MuscleGroup).min(1),
  secondaryMuscles: z.array(MuscleGroup).default([]),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).default('intermediate'),
  instructions: z.array(z.string()).default([]),
  cues: z.array(z.string()).default([]),
  contraindications: z.array(z.string()).default([]),
  isUnilateral: z.boolean().default(false),
  usesBarbell: z.boolean().default(false),
  defaultRestSec: z.number().int().min(0).max(600).default(90),
  loadStepKg: z.number().min(0.5).max(25).default(2.5),
  mediaUrl: z.string().url().nullable().default(null),
});

trainingRoutes.post('/exercises', validate('json', ExerciseBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const exercise = createExercise(ctx, c.req.valid('json'));
  return c.json({ exercise: { id: exercise.id } }, 201);
});

trainingRoutes.patch('/exercises/:exerciseId', validate('json', ExerciseBody.partial()), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const exercise = updateExercise(ctx, c.req.param('exerciseId'), c.req.valid('json'));
  return c.json({ exercise: { id: exercise.id } });
});

trainingRoutes.post('/exercises/:exerciseId/archive', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const exercise = archiveExercise(ctx, c.req.param('exerciseId'));
  return c.json({ exercise: { id: exercise.id, archived: exercise.archived } });
});

/* ============================================================================
   Programs
   ========================================================================= */

const ProgramListQuery = z.object({
  state: z.enum(['draft', 'published', 'archived']).optional(),
  q: z.string().optional(),
  all: z.coerce.boolean().optional(),
});

trainingRoutes.get('/programs', validate('query', ProgramListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.view');
  return c.json(listPrograms(ctx, c.req.valid('query')));
});

trainingRoutes.get('/programs/:programId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.view');
  return c.json(programDetail(ctx, c.req.param('programId')));
});

const ProgramMetaBody = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.enum(['hypertrophy', 'strength', 'fat_loss', 'endurance', 'general', 'rehab']),
  daysPerWeek: z.number().int().min(1).max(7),
  weeks: z.number().int().min(1).max(52),
  description: z.string().max(2000).default(''),
});

trainingRoutes.post('/programs', validate('json', ProgramMetaBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const program = createDraftProgram(ctx, c.req.valid('json'));
  return c.json({ program: { id: program.id, version: program.version } }, 201);
});

trainingRoutes.patch('/programs/:programId', validate('json', ProgramMetaBody.partial()), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const program = updateProgramMeta(ctx, c.req.param('programId'), c.req.valid('json'));
  return c.json({ program: { id: program.id } });
});

trainingRoutes.post('/programs/:programId/publish', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const program = publishProgram(ctx, c.req.param('programId'));
  return c.json({ program: { id: program.id, state: program.state } });
});

trainingRoutes.post('/programs/:programId/archive', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const program = archiveProgram(ctx, c.req.param('programId'));
  return c.json({ program: { id: program.id, state: program.state } });
});

trainingRoutes.post('/programs/:programId/version', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const program = createNewVersion(ctx, c.req.param('programId'));
  return c.json({ program: { id: program.id, version: program.version } }, 201);
});

/* — Days and items ————————————————————————————————————————— */

const DayBody = z.object({
  week: z.number().int().min(1),
  dayIndex: z.number().int().min(0).max(6),
  label: z.string().trim().min(1).max(80),
  focus: z.string().trim().min(1).max(40),
  isRest: z.boolean().default(false),
  estimatedMin: z.number().int().min(0).max(240).default(45),
});

trainingRoutes.post('/programs/:programId/days', validate('json', DayBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const day = upsertProgramDay(ctx, c.req.param('programId'), c.req.valid('json'));
  return c.json({ day: { id: day.id } }, 201);
});

trainingRoutes.delete('/days/:dayId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  return c.json(deleteProgramDay(ctx, c.req.param('dayId')));
});

const ItemBody = z.object({
  exerciseId: z.string().min(1),
  sets: PrescribedSet.array().min(1),
  targetLabel: z.string().trim().min(1).max(60),
  supersetGroup: z.string().nullable().default(null),
  tempo: z.string().max(20).nullable().default(null),
  notes: z.string().max(500).nullable().default(null),
  rationale: z.string().max(500).nullable().default(null),
  trainerLocked: z.boolean().default(false),
  allowedSubstitutionIds: z.array(z.string()).default([]),
});

trainingRoutes.post('/days/:dayId/items', validate('json', ItemBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const item = addProgramItem(ctx, c.req.param('dayId'), c.req.valid('json'));
  return c.json({ item: { id: item.id } }, 201);
});

trainingRoutes.patch('/items/:itemId', validate('json', ItemBody.partial()), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  const item = updateProgramItem(ctx, c.req.param('itemId'), c.req.valid('json'));
  return c.json({ item: { id: item.id } });
});

trainingRoutes.delete('/items/:itemId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.program.manage');
  return c.json(deleteProgramItem(ctx, c.req.param('itemId')));
});

/* ============================================================================
   Trainer and program assignment
   ========================================================================= */

const AssignTrainerBody = z.object({ memberId: z.string().min(1), trainerId: z.string().nullable() });

trainingRoutes.post('/assign-trainer', validate('json', AssignTrainerBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.assign');
  const body = c.req.valid('json');
  const member = assignTrainer(ctx, body.memberId, body.trainerId);
  return c.json({ member: { id: member.id, trainerId: member.trainerId } });
});

const AssignProgramBody = z.object({
  memberId: z.string().min(1),
  programId: z.string().min(1),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  trainerId: z.string().nullable().optional(),
});

trainingRoutes.post('/assign-program', validate('json', AssignProgramBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.assign');
  const assignment = assignProgram(ctx, c.req.valid('json'));
  return c.json({ assignment: { id: assignment.id, state: assignment.state } }, 201);
});

const StateBody = z.object({ state: z.enum(['active', 'paused', 'completed']) });

trainingRoutes.post('/assignments/:assignmentId/state', validate('json', StateBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.assign');
  const assignment = endAssignment(ctx, c.req.param('assignmentId'), c.req.valid('json').state);
  return c.json({ assignment: { id: assignment.id, state: assignment.state } });
});

trainingRoutes.get('/assignments/member/:memberId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'training.view');
  const items = assignmentHistory(ctx, c.req.param('memberId'));
  return c.json({
    items: items.map((a) => ({
      id: a.id,
      programId: a.programId,
      programName: a.programName,
      programGoal: a.programGoal,
      programVersion: a.programVersion,
      programWeeks: a.programWeeks,
      trainerId: a.trainerId,
      startsOn: a.startsOn,
      currentWeek: a.currentWeek,
      state: a.state,
      createdAt: new Date(a.createdAt).toISOString(),
    })),
  });
});
