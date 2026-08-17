import { Hono } from 'hono';
import { z } from 'zod';
import { EquipmentStatus, WorkOrderState } from '@shark/contracts';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission } from '../../lib/context.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  createEquipment,
  createFacilityTask,
  createWorkOrder,
  equipmentDetail,
  facilityView,
  listAssignees,
  returnEquipmentToService,
  taskDetail,
  updateEquipment,
  updateFacilityTask,
  updateWorkOrder,
  workOrderDetail,
} from '../../services/facility.js';

/**
 * Equipment registry, work orders and recurring facility tasks (PF-FAC). Route
 * files are thin adapters — every rule lives in `services/facility.ts`.
 */
export const facilityRoutes = new Hono();

const Severity = z.enum(['low', 'medium', 'high', 'safety']);
const TaskState = z.enum(['open', 'done', 'skipped']);
const Cadence = z.enum(['once', 'daily', 'weekly', 'monthly', 'quarterly']);
const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, 'Use a real calendar date.');

const ListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: EquipmentStatus.optional(),
  workOrderState: WorkOrderState.optional(),
  severity: Severity.optional(),
  taskState: TaskState.optional(),
  branchId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(250),
});

const AssigneeQuery = z.object({ branchId: z.string().min(1).optional() });

const EquipmentBody = z.object({
  name: z.string().trim().min(1).max(120),
  assetTag: z.string().trim().min(1).max(80),
  branchId: z.string().min(1),
  area: z.string().trim().min(1).max(80),
  model: z.string().trim().max(120).default(''),
  serial: z.string().trim().max(120).default(''),
  vendor: z.string().trim().max(120).default(''),
  warrantyUntil: CalendarDate.nullable().default(null),
  serviceIntervalDays: z.number().int().min(1).max(3650).default(90),
  linkedExerciseId: z.string().nullable().default(null),
  status: EquipmentStatus.default('available'),
});

const EquipmentPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  assetTag: z.string().trim().min(1).max(80).optional(),
  branchId: z.string().min(1).optional(),
  area: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().max(120).optional(),
  serial: z.string().trim().max(120).optional(),
  vendor: z.string().trim().max(120).optional(),
  warrantyUntil: CalendarDate.nullable().optional(),
  serviceIntervalDays: z.number().int().min(1).max(3650).optional(),
  linkedExerciseId: z.string().nullable().optional(),
  status: EquipmentStatus.optional(),
  lastServicedOn: CalendarDate.nullable().optional(),
});

const ReturnToServiceBody = z.object({
  note: z.string().trim().min(1).max(4000),
});

const WorkOrderBody = z.object({
  branchId: z.string().min(1).optional(),
  equipmentId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).default(''),
  severity: Severity.default('medium'),
  reportedById: z.string().nullable().optional(),
  reportedByName: z.string().trim().min(1).max(120).optional(),
  reportedByKind: z.enum(['member', 'staff', 'system']).default('staff'),
  assigneeId: z.string().nullable().optional(),
  costMinor: z.number().int().min(0).max(100_000_000).default(0),
});

const WorkOrderPatch = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  resolutionNote: z.string().trim().max(4000).optional(),
  severity: Severity.optional(),
  state: WorkOrderState.optional(),
  assigneeId: z.string().nullable().optional(),
  costMinor: z.number().int().min(0).max(100_000_000).optional(),
});

const TaskBody = z.object({
  branchId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  cadence: Cadence,
  nextDueAt: z.string().datetime(),
  assigneeId: z.string().nullable().optional(),
  checklist: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
});

const TaskPatch = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  cadence: Cadence.optional(),
  nextDueAt: z.string().datetime().optional(),
  assigneeId: z.string().nullable().optional(),
  checklist: z.array(z.string().trim().min(1).max(200)).min(1).max(50).optional(),
  state: TaskState.optional(),
});

/* ------------------------------------------------------------------ reads */

facilityRoutes.get('/', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  return c.json(facilityView(ctx, c.req.valid('query')));
});

facilityRoutes.get('/assignees', validate('query', AssigneeQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  return c.json(listAssignees(ctx, c.req.valid('query').branchId));
});

facilityRoutes.get('/equipment', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  const view = facilityView(ctx, c.req.valid('query'));
  return c.json({ scope: view.scope, metrics: view.metrics, items: view.equipment });
});

facilityRoutes.get('/work-orders', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  const view = facilityView(ctx, c.req.valid('query'));
  return c.json({ scope: view.scope, metrics: view.metrics, items: view.workOrders });
});

facilityRoutes.get('/tasks', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  const view = facilityView(ctx, c.req.valid('query'));
  return c.json({ scope: view.scope, metrics: view.metrics, items: view.tasks });
});

facilityRoutes.get('/equipment/:equipmentId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  return c.json(equipmentDetail(ctx, c.req.param('equipmentId')));
});

facilityRoutes.get('/work-orders/:workOrderId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  return c.json(workOrderDetail(ctx, c.req.param('workOrderId')));
});

facilityRoutes.get('/tasks/:taskId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  return c.json(taskDetail(ctx, c.req.param('taskId')));
});

/* -------------------------------------------------------------- equipment */

facilityRoutes.post('/equipment', validate('json', EquipmentBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  const body = c.req.valid('json');
  const response = runIdempotently(ctx, '/admin/facility/equipment', c.req.header('idempotency-key'), body, () => createEquipment(ctx, body));
  return c.json(response, 201);
});

facilityRoutes.patch('/equipment/:equipmentId', validate('json', EquipmentPatch), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  return c.json(updateEquipment(ctx, c.req.param('equipmentId'), c.req.valid('json')));
});

facilityRoutes.post('/equipment/:equipmentId/return-to-service', validate('json', ReturnToServiceBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  return c.json(returnEquipmentToService(ctx, c.req.param('equipmentId'), c.req.valid('json').note));
});

/* ------------------------------------------------------------ work orders */

facilityRoutes.post('/work-orders', validate('json', WorkOrderBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  const body = c.req.valid('json');
  const response = runIdempotently(ctx, '/admin/facility/work-orders', c.req.header('idempotency-key'), body, () => createWorkOrder(ctx, body));
  return c.json(response, 201);
});

facilityRoutes.patch('/work-orders/:workOrderId', validate('json', WorkOrderPatch), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  return c.json(updateWorkOrder(ctx, c.req.param('workOrderId'), c.req.valid('json')));
});

/* ------------------------------------------------------------------ tasks */

/** The screen and the seed data both reach for `/facility-tasks`; keep both. */
function registerTaskCreate(path: '/tasks' | '/facility-tasks'): void {
  facilityRoutes.post(path, validate('json', TaskBody), (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'facility.manage');
    const body = c.req.valid('json');
    const response = runIdempotently(ctx, `/admin/facility${path}`, c.req.header('idempotency-key'), body, () => createFacilityTask(ctx, body));
    return c.json(response, 201);
  });
}

function registerTaskPatch(path: '/tasks/:taskId' | '/facility-tasks/:taskId'): void {
  facilityRoutes.patch(path, validate('json', TaskPatch), (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'facility.manage');
    return c.json(updateFacilityTask(ctx, c.req.param('taskId'), c.req.valid('json')));
  });
}

registerTaskCreate('/tasks');
registerTaskCreate('/facility-tasks');
registerTaskPatch('/tasks/:taskId');
registerTaskPatch('/facility-tasks/:taskId');
