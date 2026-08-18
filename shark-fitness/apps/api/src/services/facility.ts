import { and, asc, desc, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm';
import { channels, type EquipmentStatus } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import { requireBranch, type RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

/**
 * Equipment registry, work orders and recurring facility tasks (PF-FAC).
 *
 * The database slice predates this service and has no separate incident or
 * attachment tables, so issue and safety reports are represented by work
 * orders. Route files are thin adapters — every rule lives here.
 *
 * Two rules are load-bearing and easy to lose in a refactor:
 *
 *  1. Moving an asset between branches carries its open work orders with it,
 *     but a technician is scoped to branches. An assignee who does not cover
 *     the destination is cleared rather than left in an assignment they cannot
 *     act on (`clearInvalidAssignees`).
 *  2. `out_of_service` is a safety hold, not a derived status. Closing the last
 *     safety work order never returns an asset to service on its own; only an
 *     explicit, authorised return-to-service does (`returnEquipmentToService`).
 */

export type EquipmentStatusValue = EquipmentStatus;
type EquipmentRow = typeof schema.equipment.$inferSelect;
type WorkOrderRow = typeof schema.workOrders.$inferSelect;
type FacilityTaskRow = typeof schema.facilityTasks.$inferSelect;

const DAY = 24 * 60 * 60 * 1000;
const SAFETY_SLA = DAY;

/**
 * Roles trusted with safety-restricted detail and with returning an asset to
 * service. Today this is coextensive with `facility.manage`, but the safety
 * authority is stated independently of the permission matrix so that widening
 * `facility.manage` cannot silently widen who may clear a safety hold.
 */
const MANAGEMENT_ROLES = ['owner', 'regional_manager', 'branch_manager', 'platform_admin'];

/* ------------------------------------------------------------------ scope */

export function scopeFor(ctx: RequestContext, branchId?: string): string[] {
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

function canViewRestricted(ctx: RequestContext): boolean {
  return MANAGEMENT_ROLES.includes(ctx.role);
}

/* ------------------------------------------------------------- formatting */

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

/* ------------------------------------------------------------------ loads */

export function loadEquipmentInScope(ctx: RequestContext, equipmentId: string): EquipmentRow {
  const row = db
    .select()
    .from(schema.equipment)
    .where(and(eq(schema.equipment.id, equipmentId), eq(schema.equipment.tenantId, ctx.tenantId), inArray(schema.equipment.branchId, ctx.branchIds)))
    .get();
  if (!row) throw notFound('That equipment');
  return row;
}

export function loadWorkOrderInScope(ctx: RequestContext, workOrderId: string): WorkOrderRow {
  const row = db
    .select()
    .from(schema.workOrders)
    .where(and(eq(schema.workOrders.id, workOrderId), eq(schema.workOrders.tenantId, ctx.tenantId), inArray(schema.workOrders.branchId, ctx.branchIds)))
    .get();
  if (!row) throw notFound('That work order');
  return row;
}

export function loadTaskInScope(ctx: RequestContext, taskId: string): FacilityTaskRow {
  const row = db
    .select()
    .from(schema.facilityTasks)
    .where(and(eq(schema.facilityTasks.id, taskId), eq(schema.facilityTasks.tenantId, ctx.tenantId), inArray(schema.facilityTasks.branchId, ctx.branchIds)))
    .get();
  if (!row) throw notFound('That facility task');
  return row;
}

function workOrdersForEquipment(ctx: RequestContext, equipment: EquipmentRow): WorkOrderRow[] {
  return db
    .select()
    .from(schema.workOrders)
    .where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.equipmentId, equipment.id), eq(schema.workOrders.branchId, equipment.branchId)))
    .orderBy(desc(schema.workOrders.openedAt))
    .all();
}

/* ------------------------------------------------------------- assignees */

/**
 * Branch membership for staff ids, without throwing. The transfer path needs to
 * ask "is this assignee still valid?" rather than assert it.
 */
function staffBranchMembership(ctx: RequestContext, staffIds: string[]): Map<string, string[]> {
  if (staffIds.length === 0) return new Map();
  return new Map(
    db
      .select({ id: schema.staff.id, branchIds: schema.staff.branchIds, accountState: schema.users.accountState })
      .from(schema.staff)
      .innerJoin(schema.users, and(eq(schema.users.id, schema.staff.userId), eq(schema.users.tenantId, ctx.tenantId)))
      .where(and(eq(schema.staff.tenantId, ctx.tenantId), inArray(schema.staff.id, staffIds)))
      .all()
      .map((row) => [row.id, row.accountState === 'active' ? row.branchIds : []]),
  );
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

/* ------------------------------------------------------- work order rules */

function activeWorkOrder(row: WorkOrderRow): boolean {
  return row.state !== 'done' && row.state !== 'cancelled';
}

function workOrderOverdue(row: WorkOrderRow, atMs = now()): boolean {
  return activeWorkOrder(row) && row.severity === 'safety' && row.openedAt + SAFETY_SLA < atMs;
}

/**
 * Status implied by the work orders on an asset.
 *
 * `out_of_service` is deliberately sticky: an asset that reached it is under a
 * safety hold and only `returnEquipmentToService` may lift it. Recovering to
 * `available` on the close of the last work order is exactly the bug this
 * guards — a machine that hurt someone must not come back because a ticket was
 * ticked shut.
 */
function equipmentStatusForOrders(current: EquipmentStatusValue, orders: WorkOrderRow[]): EquipmentStatusValue {
  if (current === 'retired') return current;
  const open = orders.filter(activeWorkOrder);
  if (open.some((row) => row.severity === 'safety')) return 'out_of_service';
  if (current === 'out_of_service') return 'out_of_service';
  return open.length === 0 ? 'available' : 'in_maintenance';
}

/**
 * Whether an asset has ever carried a safety fault.
 *
 * This is what separates a genuine safety hold from ordinary administrative
 * downtime. An asset pulled off the floor for a relocation was never a safety
 * case, and making that reversal as ceremonious as clearing an injury would
 * teach operators to read the ceremony as noise — which is how a real hold gets
 * waved through later.
 */
function hasSafetyHistory(orders: WorkOrderRow[]): boolean {
  return orders.some((row) => row.severity === 'safety');
}

/**
 * Work that was under way but has nobody on it.
 *
 * A branch transfer clears an assignee who cannot reach the destination, and
 * `in_progress` / `blocked` deliberately keep their state — resetting them to
 * `open` would throw away the fact that the job was started. The cost is an
 * order that reads as live but is nobody's, so it is flagged rather than left
 * to be noticed.
 */
function needsReassignment(row: WorkOrderRow): boolean {
  return activeWorkOrder(row) && !row.assigneeId && (row.state === 'in_progress' || row.state === 'blocked');
}

/** Why an asset may not be returned to service yet, in reader-facing words. */
function returnToServiceBlocker(orders: WorkOrderRow[]): string | null {
  if (orders.some((row) => activeWorkOrder(row) && row.severity === 'safety')) {
    return 'Close the open safety work order before returning this asset to service.';
  }
  if (orders.some((row) => row.state === 'blocked')) {
    return 'A blocked work order still stands against this asset. Resolve it before returning it to service.';
  }
  return null;
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

/* ------------------------------------------------------------ serialisers */

function toEquipment(row: EquipmentRow, workOrders: WorkOrderRow[], branchName: string) {
  const due = nextServiceDue(row);
  const mine = workOrders.filter((order) => order.equipmentId === row.id);
  const outOfService = row.status === 'out_of_service';
  const safetyHold = outOfService && hasSafetyHistory(mine);
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
    openWorkOrders: mine.filter(activeWorkOrder).length,
    downtimeDays30: downtimeDays30(row.id, workOrders, now()),
    linkedExerciseId: row.linkedExerciseId,
    outOfService,
    safetyHold,
    returnBlockedReason: outOfService ? returnToServiceBlocker(mine) : null,
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
    needsReassignment: needsReassignment(row),
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

/* ---------------------------------------------------------------- metrics */

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

/* ------------------------------------------------------------------ reads */

export interface FacilityListQuery {
  q?: string;
  status?: EquipmentStatusValue;
  workOrderState?: string;
  severity?: string;
  taskState?: string;
  branchId?: string;
  limit: number;
}

export function facilityView(ctx: RequestContext, query: FacilityListQuery) {
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

export function listAssignees(ctx: RequestContext, branchId?: string) {
  const scope = scopeFor(ctx, branchId);
  if (scope.length === 0) return { items: [] };
  const items = db
    .select({ id: schema.staff.id, name: schema.users.name, branchIds: schema.staff.branchIds })
    .from(schema.staff)
    .innerJoin(schema.users, and(eq(schema.users.id, schema.staff.userId), eq(schema.users.tenantId, ctx.tenantId)))
    .where(and(eq(schema.staff.tenantId, ctx.tenantId), eq(schema.staff.employmentStatus, 'active')))
    .all()
    .filter((row) => row.branchIds.some((idValue) => scope.includes(idValue)))
    .map((row) => ({ id: row.id, name: row.name }));
  return { items };
}

export function equipmentDetail(ctx: RequestContext, equipmentId: string) {
  const equipment = loadEquipmentInScope(ctx, equipmentId);
  const orders = db
    .select()
    .from(schema.workOrders)
    .where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.equipmentId, equipment.id), inArray(schema.workOrders.branchId, ctx.branchIds)))
    .orderBy(desc(schema.workOrders.openedAt))
    .all();
  const names = staffNames(ctx, orders.map((row) => row.assigneeId).filter((value): value is string => Boolean(value)));
  const branches = branchNames(ctx, [equipment.branchId]);
  return {
    equipment: toEquipment(equipment, orders, branches.get(equipment.branchId) ?? equipment.branchId),
    workOrders: orders.map((row) => toWorkOrder(ctx, row, new Map([[equipment.id, equipment]]), branches.get(row.branchId) ?? row.branchId, names)),
  };
}

export function workOrderDetail(ctx: RequestContext, workOrderId: string) {
  const workOrder = loadWorkOrderInScope(ctx, workOrderId);
  const equipment = workOrder.equipmentId ? loadEquipmentInScope(ctx, workOrder.equipmentId) : null;
  const names = staffNames(ctx, workOrder.assigneeId ? [workOrder.assigneeId] : []);
  const branches = branchNames(ctx, [workOrder.branchId]);
  return { workOrder: toWorkOrder(ctx, workOrder, equipment ? new Map([[equipment.id, equipment]]) : new Map(), branches.get(workOrder.branchId) ?? workOrder.branchId, names) };
}

export function taskDetail(ctx: RequestContext, taskId: string) {
  const task = loadTaskInScope(ctx, taskId);
  const names = staffNames(ctx, task.assigneeId ? [task.assigneeId] : []);
  const branches = branchNames(ctx, [task.branchId]);
  const states = branchStates(ctx, [task.branchId]);
  return { task: toTask(task, branches.get(task.branchId) ?? task.branchId, names, states.get(task.branchId) ?? 'active') };
}

/* -------------------------------------------------------------- equipment */

export interface CreateEquipmentInput {
  name: string;
  assetTag: string;
  branchId: string;
  area: string;
  model: string;
  serial: string;
  vendor: string;
  warrantyUntil: string | null;
  serviceIntervalDays: number;
  linkedExerciseId: string | null;
  status: EquipmentStatusValue;
}

export function createEquipment(ctx: RequestContext, input: CreateEquipmentInput) {
  assertActiveBranch(ctx, input.branchId);
  const equipmentId = id('eqp');
  transact(() => {
    db.insert(schema.equipment)
      .values({ id: equipmentId, tenantId: ctx.tenantId, branchId: input.branchId, name: input.name, assetTag: input.assetTag, area: input.area, model: input.model, serial: input.serial, vendor: input.vendor, warrantyUntil: input.warrantyUntil, status: input.status, lastServicedOn: null, serviceIntervalDays: input.serviceIntervalDays, linkedExerciseId: input.linkedExerciseId, createdAt: now() })
      .run();
    audit(ctx, { action: 'equipment.created', entityType: 'equipment', entityId: equipmentId, entityLabel: input.name, branchId: input.branchId, after: { assetTag: input.assetTag, status: input.status, area: input.area } });
  });
  return { equipment: { id: equipmentId, assetTag: input.assetTag, qrIdentifier: input.assetTag } };
}

export interface EquipmentPatchInput {
  name?: string;
  assetTag?: string;
  branchId?: string;
  area?: string;
  model?: string;
  serial?: string;
  vendor?: string;
  warrantyUntil?: string | null;
  serviceIntervalDays?: number;
  linkedExerciseId?: string | null;
  status?: EquipmentStatusValue;
  lastServicedOn?: string | null;
}

/**
 * Open work orders follow their asset across a branch move. An assignee is
 * scoped to branches, so anyone who does not cover the destination is cleared
 * and the clearance audited — an assignment nobody can act on is worse than an
 * unassigned order, because the queue looks handled.
 */
function clearInvalidAssignees(ctx: RequestContext, orders: WorkOrderRow[], fromBranchId: string, toBranchId: string): number {
  const assigneeIds = [...new Set(orders.map((row) => row.assigneeId).filter((value): value is string => Boolean(value)))];
  if (assigneeIds.length === 0) return 0;
  const membership = staffBranchMembership(ctx, assigneeIds);
  let cleared = 0;
  for (const order of orders) {
    if (!order.assigneeId) continue;
    if ((membership.get(order.assigneeId) ?? []).includes(toBranchId)) continue;
    // An order that was only 'assigned' because of this person goes back to the
    // open queue. Work genuinely under way keeps its state and is re-staffed.
    const nextState = order.state === 'assigned' ? 'open' : order.state;
    db.update(schema.workOrders)
      .set({ assigneeId: null, state: nextState })
      .where(and(eq(schema.workOrders.id, order.id), eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.branchId, toBranchId)))
      .run();
    audit(ctx, {
      action: 'work_order.assignee_cleared',
      entityType: 'work_order',
      entityId: order.id,
      entityLabel: order.reference,
      branchId: toBranchId,
      reason: 'The assignee does not cover the destination branch after an equipment transfer.',
      before: { assigneeId: order.assigneeId, state: order.state, branchId: fromBranchId },
      after: { assigneeId: null, state: nextState, branchId: toBranchId },
    });
    cleared += 1;
  }
  return cleared;
}

export function updateEquipment(ctx: RequestContext, equipmentId: string, patch: EquipmentPatchInput) {
  const equipment = loadEquipmentInScope(ctx, equipmentId);
  if (patch.branchId) assertActiveBranch(ctx, patch.branchId);
  const nextBranchId = patch.branchId ?? equipment.branchId;

  // Lifting a safety hold is an explicit, authorised act — it may not ride in on
  // a general field update. Assets that were only ever administratively down
  // carry no such history and stay a plain edit.
  if (patch.status === 'available' && equipment.status === 'out_of_service' && hasSafetyHistory(workOrdersForEquipment(ctx, equipment))) {
    throw invalid('This asset is under a safety hold. Use return to service to bring it back, so the safety check is recorded.');
  }

  let movedWorkOrders = 0;
  let unassignedWorkOrders = 0;
  transact(() => {
    db.update(schema.equipment)
      .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.assetTag !== undefined ? { assetTag: patch.assetTag } : {}), ...(patch.branchId !== undefined ? { branchId: patch.branchId } : {}), ...(patch.area !== undefined ? { area: patch.area } : {}), ...(patch.model !== undefined ? { model: patch.model } : {}), ...(patch.serial !== undefined ? { serial: patch.serial } : {}), ...(patch.vendor !== undefined ? { vendor: patch.vendor } : {}), ...(patch.warrantyUntil !== undefined ? { warrantyUntil: patch.warrantyUntil } : {}), ...(patch.serviceIntervalDays !== undefined ? { serviceIntervalDays: patch.serviceIntervalDays } : {}), ...(patch.linkedExerciseId !== undefined ? { linkedExerciseId: patch.linkedExerciseId } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.lastServicedOn !== undefined ? { lastServicedOn: patch.lastServicedOn } : {}) })
      .where(and(eq(schema.equipment.id, equipmentId), eq(schema.equipment.tenantId, ctx.tenantId), eq(schema.equipment.branchId, equipment.branchId)))
      .run();

    if (nextBranchId !== equipment.branchId) {
      const openOrders = db.select().from(schema.workOrders).where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.equipmentId, equipmentId), eq(schema.workOrders.branchId, equipment.branchId), notInArray(schema.workOrders.state, ['done', 'cancelled']))).all();
      movedWorkOrders = openOrders.length;
      for (const order of openOrders) {
        db.update(schema.workOrders).set({ branchId: nextBranchId }).where(and(eq(schema.workOrders.id, order.id), eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.branchId, equipment.branchId))).run();
        audit(ctx, { action: 'work_order.branch_transferred', entityType: 'work_order', entityId: order.id, entityLabel: order.reference, branchId: nextBranchId, before: { branchId: equipment.branchId }, after: { branchId: nextBranchId } });
      }
      unassignedWorkOrders = clearInvalidAssignees(ctx, openOrders, equipment.branchId, nextBranchId);
    }

    audit(ctx, { action: 'equipment.updated', entityType: 'equipment', entityId: equipmentId, entityLabel: equipment.name, branchId: nextBranchId, before: { branchId: equipment.branchId, status: equipment.status, lastServicedOn: equipment.lastServicedOn }, after: { branchId: nextBranchId, status: patch.status ?? equipment.status, lastServicedOn: patch.lastServicedOn ?? equipment.lastServicedOn } });
    if (nextBranchId !== equipment.branchId || patch.status !== undefined || patch.lastServicedOn !== undefined) {
      emit({ tenantId: ctx.tenantId, branchId: nextBranchId, channel: channels.branch(nextBranchId), topic: 'alert.raised', payload: { kind: 'equipment_updated', equipmentId, branchId: nextBranchId } });
    }
  });

  const updated = db.select().from(schema.equipment).where(and(eq(schema.equipment.id, equipmentId), eq(schema.equipment.tenantId, ctx.tenantId), inArray(schema.equipment.branchId, ctx.branchIds))).get();
  if (!updated) throw notFound('That equipment');
  return { equipment: { id: updated.id, branchId: updated.branchId, status: updated.status, nextServiceDue: nextServiceDue(updated) }, movedWorkOrders, unassignedWorkOrders };
}

/**
 * Brings an out-of-service asset back.
 *
 * An asset with safety history is a safety hold: it additionally requires a
 * management role, checked here against `ctx.role` rather than against
 * `facility.manage`, so that widening that permission later cannot silently
 * widen who may clear a hold. Ordinary administrative downtime needs only
 * `facility.manage` and the note.
 *
 * Either way it refuses while blocking or open safety work stands, and the
 * resulting status is re-derived from whatever work remains — an asset with an
 * open routine order comes back as `in_maintenance`, not `available`.
 */
export function returnEquipmentToService(ctx: RequestContext, equipmentId: string, note: string) {
  const equipment = loadEquipmentInScope(ctx, equipmentId);
  if (equipment.status === 'retired') throw invalid('That asset is retired. Restore it before returning it to service.');
  if (equipment.status !== 'out_of_service') throw invalid('That asset is not out of service.');

  const orders = workOrdersForEquipment(ctx, equipment);
  if (hasSafetyHistory(orders) && !canViewRestricted(ctx)) {
    throw forbidden('Only a manager or owner can lift a safety hold.');
  }
  const blocker = returnToServiceBlocker(orders);
  if (blocker) throw invalid(blocker);

  const open = orders.filter(activeWorkOrder);
  const nextStatus: EquipmentStatusValue = open.length === 0 ? 'available' : 'in_maintenance';
  transact(() => {
    db.update(schema.equipment)
      .set({ status: nextStatus })
      .where(and(eq(schema.equipment.id, equipment.id), eq(schema.equipment.tenantId, ctx.tenantId), eq(schema.equipment.branchId, equipment.branchId)))
      .run();
    audit(ctx, {
      action: 'equipment.returned_to_service',
      entityType: 'equipment',
      entityId: equipment.id,
      entityLabel: equipment.name,
      branchId: equipment.branchId,
      reason: note,
      before: { status: equipment.status },
      after: { status: nextStatus },
    });
    emit({ tenantId: ctx.tenantId, branchId: equipment.branchId, channel: channels.branch(equipment.branchId), topic: 'alert.raised', payload: { kind: 'equipment_returned_to_service', equipmentId: equipment.id, branchId: equipment.branchId } });
  });
  // `nextStatus` is only ever 'available' or 'in_maintenance' here, so the hold
  // is lifted by construction.
  return { equipment: { id: equipment.id, status: nextStatus, outOfService: false, safetyHold: false } };
}

/* ------------------------------------------------------------ work orders */

export interface CreateWorkOrderInput {
  branchId?: string;
  equipmentId?: string | null;
  title: string;
  description: string;
  severity: string;
  reportedById?: string | null;
  reportedByName?: string;
  reportedByKind: string;
  assigneeId?: string | null;
  costMinor: number;
}

export function createWorkOrder(ctx: RequestContext, input: CreateWorkOrderInput) {
  const equipment = input.equipmentId ? loadEquipmentInScope(ctx, input.equipmentId) : null;
  const branchId = equipment?.branchId ?? input.branchId;
  if (!branchId) throw invalid('Choose a branch or equipment for this report.');
  assertActiveBranch(ctx, branchId);
  if (input.branchId && input.branchId !== branchId) throw invalid('The report branch must match its equipment branch.');
  assertAssignee(ctx, input.assigneeId, branchId);

  const duplicate = db
    .select({ id: schema.workOrders.id })
    .from(schema.workOrders)
    .where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.branchId, branchId), input.equipmentId ? eq(schema.workOrders.equipmentId, input.equipmentId) : sql`${schema.workOrders.equipmentId} is null`, eq(sql`lower(trim(${schema.workOrders.title}))`, input.title.toLowerCase()), notInArray(schema.workOrders.state, ['done', 'cancelled'])))
    .orderBy(asc(schema.workOrders.openedAt))
    .get();

  const workOrderId = id('wrk');
  const reference = `WO-${String(now()).slice(-8)}-${workOrderId.slice(-4).toUpperCase()}`;
  transact(() => {
    db.insert(schema.workOrders).values({ id: workOrderId, tenantId: ctx.tenantId, branchId, reference, equipmentId: input.equipmentId ?? null, title: input.title, description: input.description, severity: input.severity, state: input.assigneeId ? 'assigned' : 'open', reportedById: input.reportedById ?? null, reportedByName: input.reportedByName ?? ctx.name, reportedByKind: input.reportedByKind, assigneeId: input.assigneeId ?? null, costMinor: input.costMinor, duplicateOfId: duplicate?.id ?? null, openedAt: now(), closedAt: null }).run();
    if (equipment && !duplicate) {
      const nextStatus = equipment.status === 'retired' ? 'retired' : input.severity === 'safety' ? 'out_of_service' : equipment.status === 'out_of_service' ? 'out_of_service' : 'in_maintenance';
      if (nextStatus !== equipment.status) {
        db.update(schema.equipment).set({ status: nextStatus }).where(and(eq(schema.equipment.id, equipment.id), eq(schema.equipment.tenantId, ctx.tenantId), eq(schema.equipment.branchId, equipment.branchId))).run();
        audit(ctx, { action: 'equipment.status_changed', entityType: 'equipment', entityId: equipment.id, entityLabel: equipment.name, branchId, before: { status: equipment.status }, after: { status: nextStatus } });
      }
    }
    audit(ctx, { action: duplicate ? 'work_order.duplicate_reported' : 'work_order.created', entityType: 'work_order', entityId: workOrderId, entityLabel: reference, branchId, after: { equipmentId: input.equipmentId ?? null, severity: input.severity, assigneeId: input.assigneeId ?? null, duplicateOfId: duplicate?.id ?? null } });
    emit({ tenantId: ctx.tenantId, branchId, channel: channels.branch(branchId), topic: 'alert.raised', payload: { kind: input.severity === 'safety' ? 'equipment_down' : 'work_order_created', workOrderId, equipmentId: input.equipmentId ?? null } });
  });
  return { workOrder: { id: workOrderId, reference, duplicateOfId: duplicate?.id ?? null } };
}

export interface WorkOrderPatchInput {
  title?: string;
  description?: string;
  resolutionNote?: string;
  severity?: string;
  state?: string;
  assigneeId?: string | null;
  costMinor?: number;
}

export function updateWorkOrder(ctx: RequestContext, workOrderId: string, patch: WorkOrderPatchInput) {
  const workOrder = loadWorkOrderInScope(ctx, workOrderId);
  const equipment = workOrder.equipmentId ? loadEquipmentInScope(ctx, workOrder.equipmentId) : null;
  assertAssignee(ctx, patch.assigneeId, workOrder.branchId);
  const resolutionNote = patch.state === 'done' ? patch.resolutionNote?.trim() : null;
  if (patch.state === 'done' && !resolutionNote) throw invalid('Add a resolution note before closing this work order.');

  let equipmentStatus: EquipmentStatusValue | null = null;
  const nextState = patch.state ?? (patch.assigneeId && workOrder.state === 'open' ? 'assigned' : workOrder.state);
  transact(() => {
    db.update(schema.workOrders).set({ ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.state === 'done' && resolutionNote ? { description: `${patch.description ?? workOrder.description}\n\nResolution: ${resolutionNote}` } : patch.description !== undefined ? { description: patch.description } : {}), ...(patch.severity !== undefined ? { severity: patch.severity } : {}), ...(patch.state !== undefined || patch.assigneeId !== undefined ? { state: nextState } : {}), ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}), ...(patch.costMinor !== undefined ? { costMinor: patch.costMinor } : {}), ...(patch.state === 'done' || patch.state === 'cancelled' ? { closedAt: now() } : patch.state ? { closedAt: null } : {}) }).where(and(eq(schema.workOrders.id, workOrderId), eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.branchId, workOrder.branchId))).run();

    if (equipment && (patch.state !== undefined || patch.severity !== undefined)) {
      const related = db.select().from(schema.workOrders).where(and(eq(schema.workOrders.tenantId, ctx.tenantId), eq(schema.workOrders.equipmentId, equipment.id), eq(schema.workOrders.branchId, equipment.branchId))).all();
      equipmentStatus = equipmentStatusForOrders(equipment.status as EquipmentStatusValue, related);
      if (equipmentStatus !== equipment.status) {
        db.update(schema.equipment).set({ status: equipmentStatus }).where(and(eq(schema.equipment.id, equipment.id), eq(schema.equipment.tenantId, ctx.tenantId), eq(schema.equipment.branchId, equipment.branchId))).run();
        audit(ctx, { action: 'equipment.status_changed', entityType: 'equipment', entityId: equipment.id, entityLabel: equipment.name, branchId: equipment.branchId, before: { status: equipment.status }, after: { status: equipmentStatus } });
      }
    }
    audit(ctx, { action: 'work_order.updated', entityType: 'work_order', entityId: workOrderId, entityLabel: workOrder.reference, branchId: workOrder.branchId, before: { state: workOrder.state, severity: workOrder.severity, assigneeId: workOrder.assigneeId, costMinor: workOrder.costMinor }, after: { state: nextState, severity: patch.severity ?? workOrder.severity, assigneeId: patch.assigneeId ?? workOrder.assigneeId, costMinor: patch.costMinor ?? workOrder.costMinor, resolutionNote } });
    emit({ tenantId: ctx.tenantId, branchId: workOrder.branchId, channel: channels.branch(workOrder.branchId), topic: 'alert.raised', payload: { kind: 'work_order_updated', workOrderId, state: nextState } });
  });
  return { workOrder: { id: workOrderId, state: nextState, equipmentStatus, resolutionNote } };
}

/* ---------------------------------------------------------------- tasks */

export interface CreateTaskInput {
  branchId: string;
  title: string;
  cadence: string;
  nextDueAt: string;
  assigneeId?: string | null;
  checklist: string[];
}

export function createFacilityTask(ctx: RequestContext, input: CreateTaskInput) {
  assertActiveBranch(ctx, input.branchId);
  assertAssignee(ctx, input.assigneeId, input.branchId);
  const taskId = id('fct');
  transact(() => {
    db.insert(schema.facilityTasks).values({ id: taskId, tenantId: ctx.tenantId, branchId: input.branchId, title: input.title, cadence: input.cadence, nextDueAt: Date.parse(input.nextDueAt), assigneeId: input.assigneeId ?? null, state: 'open', checklist: input.checklist, lastCompletedAt: null }).run();
    audit(ctx, { action: 'facility_task.created', entityType: 'facility_task', entityId: taskId, entityLabel: input.title, branchId: input.branchId, after: { cadence: input.cadence, nextDueAt: input.nextDueAt, checklistCount: input.checklist.length } });
  });
  return { task: { id: taskId } };
}

export interface TaskPatchInput {
  title?: string;
  cadence?: string;
  nextDueAt?: string;
  assigneeId?: string | null;
  checklist?: string[];
  state?: string;
}

export function updateFacilityTask(ctx: RequestContext, taskId: string, patch: TaskPatchInput) {
  const task = loadTaskInScope(ctx, taskId);
  assertAssignee(ctx, patch.assigneeId, task.branchId);
  transact(() => {
    db.update(schema.facilityTasks).set({ ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}), ...(patch.nextDueAt !== undefined ? { nextDueAt: Date.parse(patch.nextDueAt) } : {}), ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}), ...(patch.checklist !== undefined ? { checklist: patch.checklist } : {}), ...(patch.state !== undefined ? { state: patch.state, lastCompletedAt: patch.state === 'done' ? now() : task.lastCompletedAt } : {}) }).where(and(eq(schema.facilityTasks.id, taskId), eq(schema.facilityTasks.tenantId, ctx.tenantId), eq(schema.facilityTasks.branchId, task.branchId))).run();
    audit(ctx, { action: 'facility_task.updated', entityType: 'facility_task', entityId: taskId, entityLabel: task.title, branchId: task.branchId, before: { state: task.state, assigneeId: task.assigneeId, nextDueAt: task.nextDueAt }, after: { state: patch.state ?? task.state, assigneeId: patch.assigneeId ?? task.assigneeId, nextDueAt: patch.nextDueAt ? Date.parse(patch.nextDueAt) : task.nextDueAt } });
  });
  return { task: { id: taskId, state: patch.state ?? task.state } };
}
