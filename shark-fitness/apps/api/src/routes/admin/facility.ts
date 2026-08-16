import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { channels, EquipmentStatus, WorkOrderState } from '@shark/contracts';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { requireBranch, requirePermission, type RequestContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { invalid, notFound } from '../../lib/errors.js';
import { id } from '../../lib/ids.js';
import { now } from '../../lib/time.js';
import { runIdempotently } from '../../lib/idempotency.js';

/**
 * Equipment registry, work orders and recurring facility tasks (PF-FAC).
 * The database slice predates this route and has no separate incident or
 * attachment tables, so issue and safety reports are represented by work
 * orders. The route keeps the adapter shape used by the other admin modules:
 * validate, scope, call SQLite, audit mutations and serialise dates.
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

type EquipmentStatusValue = z.infer<typeof EquipmentStatus>;
type EquipmentRow = typeof schema.equipment.$inferSelect;
type WorkOrderRow = typeof schema.workOrders.$inferSelect;
type FacilityTaskRow = typeof schema.facilityTasks.$inferSelect;

const DAY = 24 * 60 * 60 * 1000;
const SAFETY_SLA = DAY;

function scopeFor(ctx: RequestContext, branchId?: string): string[] {
  if (branchId && !ctx.branchIds.includes(branchId)) throw notFound('That branch');
  return branchId ? [branchId] : ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
}

function assertActiveBranch(ctx: RequestContext, branchId: string): void {
  requireBranch(ctx, branchId);
  const branch = db
    .select({ id: schema.branches.id, state: schema.branches.state })
    .from(schema.branches)
    .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, ctx.tenantId)))
    .get();
  if (!branch || branch.state === 'archived') throw invalid('Choose an active branch in this gym.');
}

function isoDateTime(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : new Date(value).toISOString();
}

function isoDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function nextServiceDue(row: EquipmentRow): string | null {
  const base = row.lastServicedOn ? Date.parse(`${row.lastServicedOn}T00:00:00Z`) : row.createdAt;
  if (!Number.isFinite(base)) return null;
  return isoDate(base + row.serviceIntervalDays * DAY);
}

function isOverdue(date: string | null, atMs = now()): boolean {
  if (!date) return true;
  const endOfDay = Date.parse(`${date}T23:59:59Z`);
  return Number.isFinite(endOfDay) && endOfDay < atMs;
}

function loadEquipmentInScope(ctx: RequestContext, equipmentId: string): EquipmentRow {
  const row = db
    .select()
    .from(schema.equipment)
    .where(and(eq(schema.equipment.id, equipmentId), eq(schema.equipment.tenantId, ctx.tenantId), inArray(schema.equipment.branchId, ctx.branchIds)))
    .get();
  if (!row) throw notFound('That equipment');
  return row;
}

function loadWorkOrderInScope(ctx: RequestContext, workOrderId: string): WorkOrderRow {
  const row = db
    .select()
    .from(schema.workOrders)
    .where(and(eq(schema.workOrders.id, workOrderId), eq(schema.workOrders.tenantId, ctx.tenantId), inArray(schema.workOrders.branchId, ctx.branchIds)))
    .get();
  if (!row) throw notFound('That work order');
  return row;
}

function loadTaskInScope(ctx: RequestContext, taskId: string): FacilityTaskRow {
  const row = db
    .select()
    .from(schema.facilityTasks)
    .where(and(eq(schema.facilityTasks.id, taskId), eq(schema.facilityTasks.tenantId, ctx.tenantId), inArray(schema.facilityTasks.branchId, ctx.branchIds)))
    .get();
  if (!row) throw notFound('That facility task');
  return row;
}

function assertAssignee(ctx: RequestContext, assigneeId: string | null | undefined, branchId: string): void {
  if (!assigneeId) return;
  const row = db
    .select({ accountState: schema.users.accountState, branchIds: schema.staff.branchIds })
    .from(schema.staff)
    .innerJoin(schema.users, and(eq(schema.users.id, schema.staff.userId), eq(schema.users.tenantId, ctx.tenantId)))
    .where(and(eq(schema.staff.id, assigneeId), eq(schema.staff.tenantId, ctx.tenantId)))
    .get();
  if (!row) throw invalid('That assignee does not exist in this gym.');
  if (row.accountState !== 'active') throw invalid('That assignee is not active.');
  if (!row.branchIds.includes(branchId)) throw invalid('That assignee is not assigned to this branch.');
}

function staffNames(ctx: RequestContext, staffIds: string[]): Map<string, string> {
  if (staffIds.length === 0) return new Map();
  return new Map(
    db
      .select({ id: schema.staff.id, name: schema.users.name })
      .from(schema.staff)
      .innerJoin(schema.users, and(eq(schema.users.id, schema.staff.userId), eq(schema.users.tenantId, ctx.tenantId)))
      .where(and(eq(schema.staff.tenantId, ctx.tenantId), inArray(schema.staff.id, staffIds)))
      .all()
      .map((row) => [row.id, row.name]),
  );
}

function branchNames(ctx: RequestContext, branchIds: string[]): Map<string, string> {
  if (branchIds.length === 0) return new Map();
  return new Map(
    db
      .select({ id: schema.branches.id, name: schema.branches.name })
      .from(schema.branches)
      .where(and(eq(schema.branches.tenantId, ctx.tenantId), inArray(schema.branches.id, branchIds)))
      .all()
      .map((row) => [row.id, row.name]),
  );
}

function branchStates(ctx: RequestContext, branchIds: string[]): Map<string, string> {
  if (branchIds.length === 0) return new Map();
  return new Map(
    db
      .select({ id: schema.branches.id, state: schema.branches.state })
      .from(schema.branches)
      .where(and(eq(schema.branches.tenantId, ctx.tenantId), inArray(schema.branches.id, branchIds)))
      .all()
      .map((row) => [row.id, row.state]),
  );
}

function canViewRestricted(ctx: RequestContext): boolean {
  return ['owner', 'regional_manager', 'branch_manager', 'platform_admin'].includes(ctx.role);
}

function activeWorkOrder(row: WorkOrderRow): boolean {
  return row.state !== 'done' && row.state !== 'cancelled';
}

function workOrderOverdue(row: WorkOrderRow, atMs = now()): boolean {
  return activeWorkOrder(row) && row.severity === 'safety' && row.openedAt + SAFETY_SLA < atMs;
}

function equipmentStatusForOrders(current: EquipmentStatusValue, orders: WorkOrderRow[]): EquipmentStatusValue {
  if (current === 'retired') return current;
  const open = orders.filter(activeWorkOrder);
  if (open.length === 0) return 'available';
  return open.some((row) => row.severity === 'safety') ? 'out_of_service' : 'in_maintenance';
}

function downtimeDays30(equipmentId: string, orders: WorkOrderRow[], atMs: number): number {
  const start = atMs - 30 * DAY;
  const duration = orders
    .filter((row) => row.equipmentId === equipmentId && row.state !== 'cancelled')
    .reduce((total, row) => {
      const openedAt = Math.max(start, row.openedAt);
      const closedAt = Math.min(atMs, row.closedAt ?? atMs);
      return total + Math.max(0, closedAt - openedAt);
    }, 0);
  return Math.ceil(duration / DAY);
}

function toEquipment(row: EquipmentRow, workOrders: WorkOrderRow[], branchName: string) {
  const due = nextServiceDue(row);
  return {
    id: row.id,
    name: row.name,
    assetTag: row.assetTag,
    qrIdentifier: row.assetTag,
    branchId: row.branchId,
    branchName,
    area: row.area,
    model: row.model,
    serial: row.serial,
    vendor: row.vendor,
    warrantyUntil: row.warrantyUntil,
    status: row.status,
    lastServicedOn: row.lastServicedOn,
    serviceIntervalDays: row.serviceIntervalDays,
    nextServiceDue: due,
    overdue: isOverdue(due),
    openWorkOrders: workOrders.filter((order) => order.equipmentId === row.id && activeWorkOrder(order)).length,
    downtimeDays30: downtimeDays30(row.id, workOrders, now()),
    linkedExerciseId: row.linkedExerciseId,
  };
}

function toWorkOrder(ctx: RequestContext, row: WorkOrderRow, equipmentById: Map<string, EquipmentRow>, branchName: string, names: Map<string, string>) {
  const restricted = row.severity === 'safety';
  const showDetails = !restricted || canViewRestricted(ctx);
  return {
    id: row.id,
    reference: row.reference,
    equipmentId: row.equipmentId,
    equipmentName: row.equipmentId ? equipmentById.get(row.equipmentId)?.name ?? null : null,
    branchId: row.branchId,
    branchName,
    title: row.title,
    description: showDetails ? row.description : '',
    severity: row.severity,
    state: row.state,
    reportedByName: showDetails ? row.reportedByName : 'Restricted report',
    reportedByKind: row.reportedByKind,
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeId ? names.get(row.assigneeId) ?? null : null,
    costMinor: row.costMinor,
    openedAt: new Date(row.openedAt).toISOString(),
    closedAt: isoDateTime(row.closedAt),
    overdue: workOrderOverdue(row),
    duplicateOfId: row.duplicateOfId,
    restricted,
  };
}

function toTask(row: FacilityTaskRow, branchName: string, names: Map<string, string>, branchState = 'active') {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName,
    title: row.title,
    cadence: row.cadence,
    nextDueAt: new Date(row.nextDueAt).toISOString(),
    branchState,
    overdue: branchState !== 'temporarily_closed' && row.state !== 'done' && row.nextDueAt < now(),
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeId ? names.get(row.assigneeId) ?? null : null,
    state: row.state,
    checklist: row.checklist,
    lastCompletedAt: isoDateTime(row.lastCompletedAt),
  };
}

function emptyMetrics() {
  return {
    equipmentTotal: 0,
    available: 0,
    inMaintenance: 0,
    outOfService: 0,
    retired: 0,
    overdueMaintenance: 0,
    openWorkOrders: 0,
    safetyIssues: 0,
    recurringFaults: 0,
    maintenanceCostMinor: 0,
    maintenanceCost30dMinor: 0,
    downtimeDays30: 0,
    completedWorkOrders: 0,
    workOrderCompletionPct: 0,
    totalTasks: 0,
    completedTasks: 0,
    taskCompletionPct: 0,
  };
}

function computeMetrics(equipment: EquipmentRow[], workOrders: WorkOrderRow[], tasks: FacilityTaskRow[]) {
  const atMs = now();
  const last30 = atMs - 30 * DAY;
  const byEquipment = new Map<string, number>();
  for (const order of workOrders) {
    if (order.equipmentId && order.openedAt >= atMs - 90 * DAY && order.state !== 'cancelled') {
      byEquipment.set(order.equipmentId, (byEquipment.get(order.equipmentId) ?? 0) + 1);
    }
  }
  const completedWorkOrders = workOrders.filter((row) => row.state === 'done').length;
  const completedTasks = tasks.filter((row) => row.state === 'done' || row.lastCompletedAt !== null).length;
  const totalDowntime = equipment.reduce((total, row) => total + downtimeDays30(row.id, workOrders, atMs), 0);
  return {
    equipmentTotal: equipment.length,
    available: equipment.filter((row) => row.status === 'available').length,
    inMaintenance: equipment.filter((row) => row.status === 'in_maintenance').length,
    outOfService: equipment.filter((row) => row.status === 'out_of_service').length,
    retired: equipment.filter((row) => row.status === 'retired').length,
    overdueMaintenance: equipment.filter((row) => isOverdue(nextServiceDue(row), atMs)).length,
    openWorkOrders: workOrders.filter(activeWorkOrder).length,
    safetyIssues: workOrders.filter((row) => row.severity === 'safety' && activeWorkOrder(row)).length,
    recurringFaults: [...byEquipment.values()].filter((count) => count > 1).length,
    maintenanceCostMinor: workOrders.filter((row) => row.state !== 'cancelled').reduce((sum, row) => sum + row.costMinor, 0),
    maintenanceCost30dMinor: workOrders.filter((row) => row.openedAt >= last30 && row.state !== 'cancelled').reduce((sum, row) => sum + row.costMinor, 0),
    downtimeDays30: totalDowntime,
    completedWorkOrders,
    workOrderCompletionPct: workOrders.length ? Math.round((completedWorkOrders / workOrders.length) * 100) : 0,
    totalTasks: tasks.length,
    completedTasks,
    taskCompletionPct: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0,
  };
}

function facilityView(ctx: RequestContext, query: z.infer<typeof ListQuery>) {
  const scope = scopeFor(ctx, query.branchId);
  if (scope.length === 0) {
    return { scope: { branchIds: [], branchNames: [], allBranches: true }, metrics: emptyMetrics(), equipment: [], workOrders: [], tasks: [] };
  }

  const equipmentFilters = [eq(schema.equipment.tenantId, ctx.tenantId), inArray(schema.equipment.branchId, scope)];
  if (query.status) equipmentFilters.push(eq(schema.equipment.status, query.status));
  if (query.q) {
    const term = `%${query.q.toLowerCase()}%`;
    equipmentFilters.push(or(like(sql`lower(${schema.equipment.name})`, term), like(sql`lower(${schema.equipment.assetTag})`, term), like(sql`lower(${schema.equipment.area})`, term))!);
  }
  const equipmentRows = db.select().from(schema.equipment).where(and(...equipmentFilters)).orderBy(asc(schema.equipment.name)).limit(query.limit).all();

  const workOrderFilters = [eq(schema.workOrders.tenantId, ctx.tenantId), inArray(schema.workOrders.branchId, scope)];
  if (query.workOrderState) workOrderFilters.push(eq(schema.workOrders.state, query.workOrderState));
  if (query.severity) workOrderFilters.push(eq(schema.workOrders.severity, query.severity));
  if (query.q) {
    const term = `%${query.q.toLowerCase()}%`;
    workOrderFilters.push(or(like(sql`lower(${schema.workOrders.title})`, term), like(sql`lower(${schema.workOrders.reference})`, term))!);
  }
  const workOrderRows = db.select().from(schema.workOrders).where(and(...workOrderFilters)).orderBy(desc(schema.workOrders.openedAt)).limit(query.limit).all();

  const taskFilters = [eq(schema.facilityTasks.tenantId, ctx.tenantId), inArray(schema.facilityTasks.branchId, scope)];
  if (query.taskState) taskFilters.push(eq(schema.facilityTasks.state, query.taskState));
  if (query.q) taskFilters.push(like(sql`lower(${schema.facilityTasks.title})`, `%${query.q.toLowerCase()}%`));
  const taskRows = db.select().from(schema.facilityTasks).where(and(...taskFilters)).orderBy(asc(schema.facilityTasks.nextDueAt)).limit(query.limit).all();

  const allEquipment = db.select().from(schema.equipment).where(and(eq(schema.equipment.tenantId, ctx.tenantId), inArray(schema.equipment.branchId, scope))).all();
  const allWorkOrders = db.select().from(schema.workOrders).where(and(eq(schema.workOrders.tenantId, ctx.tenantId), inArray(schema.workOrders.branchId, scope))).all();
  const allTasks = db.select().from(schema.facilityTasks).where(and(eq(schema.facilityTasks.tenantId, ctx.tenantId), inArray(schema.facilityTasks.branchId, scope))).all();
  const names = staffNames(ctx, [...new Set([...allWorkOrders.map((row) => row.assigneeId), ...allTasks.map((row) => row.assigneeId)].filter((value): value is string => Boolean(value)))]);
  const branches = branchNames(ctx, scope);
  const states = branchStates(ctx, scope);
  const equipmentById = new Map(allEquipment.map((row) => [row.id, row]));

  return {
    scope: { branchIds: scope, branchNames: scope.map((branchId) => branches.get(branchId) ?? branchId), allBranches: !ctx.activeBranchId && !query.branchId },
    metrics: computeMetrics(allEquipment, allWorkOrders, allTasks),
    equipment: equipmentRows.map((row) => toEquipment(row, allWorkOrders, branches.get(row.branchId) ?? row.branchId)),
    workOrders: workOrderRows.map((row) => toWorkOrder(ctx, row, equipmentById, branches.get(row.branchId) ?? row.branchId, names)),
    tasks: taskRows.map((row) => toTask(row, branches.get(row.branchId) ?? row.branchId, names, states.get(row.branchId) ?? 'active')),
  };
}

facilityRoutes.get('/', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  return c.json(facilityView(ctx, c.req.valid('query')));
});

facilityRoutes.get('/assignees', validate('query', AssigneeQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  const { branchId } = c.req.valid('query');
  const scope = scopeFor(ctx, branchId);
  const rows = scope.length
    ? db
        .select({ id: schema.staff.id, name: schema.users.name, branchIds: schema.staff.branchIds })
        .from(schema.staff)
        .innerJoin(schema.users, and(eq(schema.users.id, schema.staff.userId), eq(schema.users.tenantId, ctx.tenantId)))
        .where(and(eq(schema.staff.tenantId, ctx.tenantId), eq(schema.staff.employmentStatus, 'active')))
        .all()
        .filter((row) => row.branchIds.some((idValue) => scope.includes(idValue)))
        .map((row) => ({ id: row.id, name: row.name }))
    : [];
  return c.json({ items: rows });
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
  const equipment = loadEquipmentInScope(ctx, c.req.param('equipmentId'));
  const orders = db
    .select()
    .from(schema.workOrders)
    .where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.equipmentId, equipment.id), inArray(schema.workOrders.branchId, ctx.branchIds)))
    .orderBy(desc(schema.workOrders.openedAt))
    .all();
  const names = staffNames(ctx, orders.map((row) => row.assigneeId).filter((value): value is string => Boolean(value)));
  const branches = branchNames(ctx, [equipment.branchId]);
  return c.json({ equipment: toEquipment(equipment, orders, branches.get(equipment.branchId) ?? equipment.branchId), workOrders: orders.map((row) => toWorkOrder(ctx, row, new Map([[equipment.id, equipment]]), branches.get(row.branchId) ?? row.branchId, names)) });
});

facilityRoutes.get('/work-orders/:workOrderId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  const workOrder = loadWorkOrderInScope(ctx, c.req.param('workOrderId'));
  const equipment = workOrder.equipmentId ? loadEquipmentInScope(ctx, workOrder.equipmentId) : null;
  const names = staffNames(ctx, workOrder.assigneeId ? [workOrder.assigneeId] : []);
  const branches = branchNames(ctx, [workOrder.branchId]);
  return c.json({ workOrder: toWorkOrder(ctx, workOrder, equipment ? new Map([[equipment.id, equipment]]) : new Map(), branches.get(workOrder.branchId) ?? workOrder.branchId, names) });
});

facilityRoutes.get('/tasks/:taskId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.view');
  const task = loadTaskInScope(ctx, c.req.param('taskId'));
  const names = staffNames(ctx, task.assigneeId ? [task.assigneeId] : []);
  const branches = branchNames(ctx, [task.branchId]);
  const states = branchStates(ctx, [task.branchId]);
  return c.json({ task: toTask(task, branches.get(task.branchId) ?? task.branchId, names, states.get(task.branchId) ?? 'active') });
});

facilityRoutes.post('/equipment', validate('json', EquipmentBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  const body = c.req.valid('json');
  assertActiveBranch(ctx, body.branchId);
  const equipmentId = id('eqp');
  const response = runIdempotently(ctx, '/admin/facility/equipment', c.req.header('idempotency-key'), body, () => {
    transact(() => {
      db.insert(schema.equipment)
        .values({ id: equipmentId, tenantId: ctx.tenantId, branchId: body.branchId, name: body.name, assetTag: body.assetTag, area: body.area, model: body.model, serial: body.serial, vendor: body.vendor, warrantyUntil: body.warrantyUntil, status: body.status, lastServicedOn: null, serviceIntervalDays: body.serviceIntervalDays, linkedExerciseId: body.linkedExerciseId, createdAt: now() })
        .run();
      audit(ctx, { action: 'equipment.created', entityType: 'equipment', entityId: equipmentId, entityLabel: body.name, branchId: body.branchId, after: { assetTag: body.assetTag, status: body.status, area: body.area } });
    });
    return { equipment: { id: equipmentId, assetTag: body.assetTag, qrIdentifier: body.assetTag } };
  });
  return c.json(response, 201);
});

facilityRoutes.patch('/equipment/:equipmentId', validate('json', EquipmentPatch), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  const equipmentId = c.req.param('equipmentId');
  const body = c.req.valid('json');
  const equipment = loadEquipmentInScope(ctx, equipmentId);
  if (body.branchId) assertActiveBranch(ctx, body.branchId);
  const nextBranchId = body.branchId ?? equipment.branchId;
  let movedWorkOrders = 0;
  transact(() => {
    db.update(schema.equipment)
      .set({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.assetTag !== undefined ? { assetTag: body.assetTag } : {}), ...(body.branchId !== undefined ? { branchId: body.branchId } : {}), ...(body.area !== undefined ? { area: body.area } : {}), ...(body.model !== undefined ? { model: body.model } : {}), ...(body.serial !== undefined ? { serial: body.serial } : {}), ...(body.vendor !== undefined ? { vendor: body.vendor } : {}), ...(body.warrantyUntil !== undefined ? { warrantyUntil: body.warrantyUntil } : {}), ...(body.serviceIntervalDays !== undefined ? { serviceIntervalDays: body.serviceIntervalDays } : {}), ...(body.linkedExerciseId !== undefined ? { linkedExerciseId: body.linkedExerciseId } : {}), ...(body.status !== undefined ? { status: body.status } : {}), ...(body.lastServicedOn !== undefined ? { lastServicedOn: body.lastServicedOn } : {}) })
      .where(and(eq(schema.equipment.id, equipmentId), eq(schema.equipment.tenantId, ctx.tenantId), eq(schema.equipment.branchId, equipment.branchId)))
      .run();
    if (nextBranchId !== equipment.branchId) {
      const openOrders = db.select().from(schema.workOrders).where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.equipmentId, equipmentId), eq(schema.workOrders.branchId, equipment.branchId), notInArray(schema.workOrders.state, ['done', 'cancelled']))).all();
      movedWorkOrders = openOrders.length;
      for (const order of openOrders) {
        db.update(schema.workOrders).set({ branchId: nextBranchId }).where(and(eq(schema.workOrders.id, order.id), eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.branchId, equipment.branchId))).run();
        audit(ctx, { action: 'work_order.branch_transferred', entityType: 'work_order', entityId: order.id, entityLabel: order.reference, branchId: nextBranchId, before: { branchId: equipment.branchId }, after: { branchId: nextBranchId } });
      }
    }
    audit(ctx, { action: 'equipment.updated', entityType: 'equipment', entityId: equipmentId, entityLabel: equipment.name, branchId: nextBranchId, before: { branchId: equipment.branchId, status: equipment.status, lastServicedOn: equipment.lastServicedOn }, after: { branchId: nextBranchId, status: body.status ?? equipment.status, lastServicedOn: body.lastServicedOn ?? equipment.lastServicedOn } });
    if (nextBranchId !== equipment.branchId || body.status !== undefined || body.lastServicedOn !== undefined) {
      emit({ tenantId: ctx.tenantId, branchId: nextBranchId, channel: channels.branch(nextBranchId), topic: 'alert.raised', payload: { kind: 'equipment_updated', equipmentId, branchId: nextBranchId } });
    }
  });
  const updated = db.select().from(schema.equipment).where(and(eq(schema.equipment.id, equipmentId), eq(schema.equipment.tenantId, ctx.tenantId), inArray(schema.equipment.branchId, ctx.branchIds))).get();
  if (!updated) throw notFound('That equipment');
  return c.json({ equipment: { id: updated.id, branchId: updated.branchId, status: updated.status, nextServiceDue: nextServiceDue(updated) }, movedWorkOrders });
});

facilityRoutes.post('/work-orders', validate('json', WorkOrderBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  const body = c.req.valid('json');
  const equipment = body.equipmentId ? loadEquipmentInScope(ctx, body.equipmentId) : null;
  const branchId = equipment?.branchId ?? body.branchId;
  if (!branchId) throw invalid('Choose a branch or equipment for this report.');
  assertActiveBranch(ctx, branchId);
  if (body.branchId && body.branchId !== branchId) throw invalid('The report branch must match its equipment branch.');
  assertAssignee(ctx, body.assigneeId, branchId);
  const duplicate = db.select({ id: schema.workOrders.id }).from(schema.workOrders).where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.branchId, branchId), body.equipmentId ? eq(schema.workOrders.equipmentId, body.equipmentId) : sql`${schema.workOrders.equipmentId} is null`, eq(sql`lower(trim(${schema.workOrders.title}))`, body.title.toLowerCase()), notInArray(schema.workOrders.state, ['done', 'cancelled']))).orderBy(asc(schema.workOrders.openedAt)).get();
  const workOrderId = id('wrk');
  const reference = `WO-${String(now()).slice(-8)}-${workOrderId.slice(-4).toUpperCase()}`;
  const response = runIdempotently(ctx, '/admin/facility/work-orders', c.req.header('idempotency-key'), body, () => {
    transact(() => {
      db.insert(schema.workOrders).values({ id: workOrderId, tenantId: ctx.tenantId, branchId, reference, equipmentId: body.equipmentId ?? null, title: body.title, description: body.description, severity: body.severity, state: body.assigneeId ? 'assigned' : 'open', reportedById: body.reportedById ?? null, reportedByName: body.reportedByName ?? ctx.name, reportedByKind: body.reportedByKind, assigneeId: body.assigneeId ?? null, costMinor: body.costMinor, duplicateOfId: duplicate?.id ?? null, openedAt: now(), closedAt: null }).run();
      if (equipment && !duplicate) {
        const nextStatus = equipment.status === 'retired' ? 'retired' : body.severity === 'safety' ? 'out_of_service' : 'in_maintenance';
        if (nextStatus !== equipment.status) {
          db.update(schema.equipment).set({ status: nextStatus }).where(and(eq(schema.equipment.id, equipment.id), eq(schema.equipment.tenantId, ctx.tenantId), eq(schema.equipment.branchId, equipment.branchId))).run();
          audit(ctx, { action: 'equipment.status_changed', entityType: 'equipment', entityId: equipment.id, entityLabel: equipment.name, branchId, before: { status: equipment.status }, after: { status: nextStatus } });
        }
      }
      audit(ctx, { action: duplicate ? 'work_order.duplicate_reported' : 'work_order.created', entityType: 'work_order', entityId: workOrderId, entityLabel: reference, branchId, after: { equipmentId: body.equipmentId ?? null, severity: body.severity, assigneeId: body.assigneeId ?? null, duplicateOfId: duplicate?.id ?? null } });
      emit({ tenantId: ctx.tenantId, branchId, channel: channels.branch(branchId), topic: 'alert.raised', payload: { kind: body.severity === 'safety' ? 'equipment_down' : 'work_order_created', workOrderId, equipmentId: body.equipmentId ?? null } });
    });
    return { workOrder: { id: workOrderId, reference, duplicateOfId: duplicate?.id ?? null } };
  });
  return c.json(response, 201);
});

facilityRoutes.patch('/work-orders/:workOrderId', validate('json', WorkOrderPatch), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'facility.manage');
  const workOrderId = c.req.param('workOrderId');
  const body = c.req.valid('json');
  const workOrder = loadWorkOrderInScope(ctx, workOrderId);
  const equipment = workOrder.equipmentId ? loadEquipmentInScope(ctx, workOrder.equipmentId) : null;
  assertAssignee(ctx, body.assigneeId, workOrder.branchId);
  const resolutionNote = body.state === 'done' ? body.resolutionNote?.trim() : null;
  if (body.state === 'done' && !resolutionNote) throw invalid('Add a resolution note before closing this work order.');
  let equipmentStatus: EquipmentStatusValue | null = null;
  const nextState = body.state ?? (body.assigneeId && workOrder.state === 'open' ? 'assigned' : workOrder.state);
  transact(() => {
    db.update(schema.workOrders).set({ ...(body.title !== undefined ? { title: body.title } : {}), ...(body.state === 'done' && resolutionNote ? { description: `${body.description ?? workOrder.description}\n\nResolution: ${resolutionNote}` } : body.description !== undefined ? { description: body.description } : {}), ...(body.severity !== undefined ? { severity: body.severity } : {}), ...(body.state !== undefined || body.assigneeId !== undefined ? { state: nextState } : {}), ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}), ...(body.costMinor !== undefined ? { costMinor: body.costMinor } : {}), ...(body.state === 'done' || body.state === 'cancelled' ? { closedAt: now() } : body.state ? { closedAt: null } : {}) }).where(and(eq(schema.workOrders.id, workOrderId), eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.branchId, workOrder.branchId))).run();
    if (equipment && (body.state !== undefined || body.severity !== undefined)) {
      const related = db.select().from(schema.workOrders).where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.equipmentId, equipment.id), eq(schema.workOrders.branchId, equipment.branchId))).all();
      equipmentStatus = equipmentStatusForOrders(equipment.status as EquipmentStatusValue, related);
      if (equipmentStatus !== equipment.status) {
        db.update(schema.equipment).set({ status: equipmentStatus }).where(and(eq(schema.equipment.id, equipment.id), eq(schema.equipment.tenantId, ctx.tenantId), eq(schema.equipment.branchId, equipment.branchId))).run();
        audit(ctx, { action: 'equipment.status_changed', entityType: 'equipment', entityId: equipment.id, entityLabel: equipment.name, branchId: equipment.branchId, before: { status: equipment.status }, after: { status: equipmentStatus } });
      }
    }
    audit(ctx, { action: 'work_order.updated', entityType: 'work_order', entityId: workOrderId, entityLabel: workOrder.reference, branchId: workOrder.branchId, before: { state: workOrder.state, severity: workOrder.severity, assigneeId: workOrder.assigneeId, costMinor: workOrder.costMinor }, after: { state: nextState, severity: body.severity ?? workOrder.severity, assigneeId: body.assigneeId ?? workOrder.assigneeId, costMinor: body.costMinor ?? workOrder.costMinor, resolutionNote } });
    emit({ tenantId: ctx.tenantId, branchId: workOrder.branchId, channel: channels.branch(workOrder.branchId), topic: 'alert.raised', payload: { kind: 'work_order_updated', workOrderId, state: nextState } });
  });
  return c.json({ workOrder: { id: workOrderId, state: nextState, equipmentStatus, resolutionNote } });
});

function createTask(ctx: RequestContext, body: z.infer<typeof TaskBody>) {
  assertActiveBranch(ctx, body.branchId);
  assertAssignee(ctx, body.assigneeId, body.branchId);
  const taskId = id('fct');
  transact(() => {
    db.insert(schema.facilityTasks).values({ id: taskId, tenantId: ctx.tenantId, branchId: body.branchId, title: body.title, cadence: body.cadence, nextDueAt: Date.parse(body.nextDueAt), assigneeId: body.assigneeId ?? null, state: 'open', checklist: body.checklist, lastCompletedAt: null }).run();
    audit(ctx, { action: 'facility_task.created', entityType: 'facility_task', entityId: taskId, entityLabel: body.title, branchId: body.branchId, after: { cadence: body.cadence, nextDueAt: body.nextDueAt, checklistCount: body.checklist.length } });
  });
  return { task: { id: taskId } };
}

function registerTaskCreate(path: '/tasks' | '/facility-tasks'): void {
  facilityRoutes.post(path, validate('json', TaskBody), (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'facility.manage');
    const body = c.req.valid('json');
    const response = runIdempotently(ctx, `/admin/facility${path}`, c.req.header('idempotency-key'), body, () => createTask(ctx, body));
    return c.json(response, 201);
  });
}

registerTaskCreate('/tasks');
registerTaskCreate('/facility-tasks');

function registerTaskPatch(path: '/tasks/:taskId' | '/facility-tasks/:taskId'): void {
  facilityRoutes.patch(path, validate('json', TaskPatch), (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, 'facility.manage');
    const taskId = c.req.param('taskId');
    const body = c.req.valid('json');
    const task = loadTaskInScope(ctx, taskId);
    assertAssignee(ctx, body.assigneeId, task.branchId);
    transact(() => {
      db.update(schema.facilityTasks).set({ ...(body.title !== undefined ? { title: body.title } : {}), ...(body.cadence !== undefined ? { cadence: body.cadence } : {}), ...(body.nextDueAt !== undefined ? { nextDueAt: Date.parse(body.nextDueAt) } : {}), ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}), ...(body.checklist !== undefined ? { checklist: body.checklist } : {}), ...(body.state !== undefined ? { state: body.state, lastCompletedAt: body.state === 'done' ? now() : task.lastCompletedAt } : {}) }).where(and(eq(schema.facilityTasks.id, taskId), eq(schema.facilityTasks.tenantId, ctx.tenantId), eq(schema.facilityTasks.branchId, task.branchId))).run();
      audit(ctx, { action: 'facility_task.updated', entityType: 'facility_task', entityId: taskId, entityLabel: task.title, branchId: task.branchId, before: { state: task.state, assigneeId: task.assigneeId, nextDueAt: task.nextDueAt }, after: { state: body.state ?? task.state, assigneeId: body.assigneeId ?? task.assigneeId, nextDueAt: body.nextDueAt ? Date.parse(body.nextDueAt) : task.nextDueAt } });
    });
    return c.json({ task: { id: taskId, state: body.state ?? task.state } });
  });
}

registerTaskPatch('/tasks/:taskId');
registerTaskPatch('/facility-tasks/:taskId');
