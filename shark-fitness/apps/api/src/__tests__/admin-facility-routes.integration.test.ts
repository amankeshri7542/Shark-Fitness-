import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { DAY, now } from '../lib/time.js';
import { call, signIn, staffIdFor, type TestSession } from './helpers/session.js';

/* ============================================================================
   Facility board reads and recurring-task creation (PF-FAC).

   GET /v1/admin/facility, /assignees, /tasks, /work-orders and
   POST /v1/admin/facility/facility-tasks. Every row this file reads is one it
   inserted (with a unique marker in the title, matched through `q`), and
   every row is removed again afterwards.
   ========================================================================= */

const TENANT = 'ten_shark';
const MARK = `fac${now().toString(36)}`;
let owner: TestSession;
let manager: TestSession; // br_kor only
let reception: TestSession;
let trainer: TestSession;
let accountant: TestSession;
let member: TestSession;

const safetyOrderId = id('wko');
const doneOrderId = id('wko');
const korOrderId = id('wko');
const overdueTaskId = id('fct');
const korTaskId = id('fct');
const createdTaskIds: string[] = [];

interface FacilityView {
  scope: { branchIds: string[]; branchNames: string[]; allBranches: boolean };
  metrics: Record<string, number>;
  equipment: Array<{ id: string; branchId: string }>;
  workOrders: WorkOrder[];
  tasks: Task[];
}
interface WorkOrder {
  id: string;
  branchId: string;
  branchName: string;
  title: string;
  description: string;
  severity: string;
  state: string;
  reportedByName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  restricted: boolean;
  closedAt: string | null;
}
interface Task {
  id: string;
  branchId: string;
  branchName: string;
  title: string;
  cadence: string;
  nextDueAt: string;
  overdue: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  state: string;
  checklist: string[];
}
interface Listing<T> {
  scope: FacilityView['scope'];
  metrics: Record<string, number>;
  items: T[];
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function workOrder(input: { id: string; branchId: string; title: string; severity: string; state: string; assigneeId?: string | null }) {
  const at = now();
  db.insert(schema.workOrders)
    .values({
      id: input.id,
      tenantId: TENANT,
      branchId: input.branchId,
      reference: `WO-${input.id.slice(-6)}`,
      equipmentId: null,
      title: input.title,
      description: 'Cable sheath split near the pulley; member reported it.',
      severity: input.severity,
      state: input.state,
      reportedById: null,
      reportedByName: 'Floor Member',
      reportedByKind: 'member',
      assigneeId: input.assigneeId ?? null,
      costMinor: 2_500,
      duplicateOfId: null,
      openedAt: at - DAY,
      closedAt: input.state === 'done' ? at - 3_600_000 : null,
    })
    .run();
}

beforeAll(async () => {
  [owner, manager, reception, trainer, accountant, member] = await Promise.all([
    signIn('owner@sharkfitness.in'),
    signIn('manager@sharkfitness.in'),
    signIn('reception@sharkfitness.in'),
    signIn('rehan@sharkfitness.in'),
    signIn('accounts@sharkfitness.in'),
    signIn('aman@sharkfitness.in'),
  ]);
  const rehan = staffIdFor('rehan@sharkfitness.in');
  workOrder({ id: safetyOrderId, branchId: 'br_ind', title: `${MARK} safety cable`, severity: 'safety', state: 'open', assigneeId: rehan });
  workOrder({ id: doneOrderId, branchId: 'br_ind', title: `${MARK} fixed bench`, severity: 'low', state: 'done' });
  workOrder({ id: korOrderId, branchId: 'br_kor', title: `${MARK} kor mirror`, severity: 'medium', state: 'open' });
  db.insert(schema.facilityTasks)
    .values([
      { id: overdueTaskId, tenantId: TENANT, branchId: 'br_ind', title: `${MARK} weekly rack check`, cadence: 'weekly', nextDueAt: now() - 2 * DAY, assigneeId: rehan, state: 'open', checklist: ['Pins', 'Hooks'], lastCompletedAt: null },
      { id: korTaskId, tenantId: TENANT, branchId: 'br_kor', title: `${MARK} daily mop`, cadence: 'daily', nextDueAt: now() + DAY, assigneeId: null, state: 'open', checklist: ['Mop'], lastCompletedAt: null },
    ])
    .run();
});

afterAll(() => {
  db.delete(schema.workOrders).where(inArray(schema.workOrders.id, [safetyOrderId, doneOrderId, korOrderId])).run();
  db.delete(schema.facilityTasks).where(inArray(schema.facilityTasks.id, [overdueTaskId, korTaskId, ...createdTaskIds])).run();
});

describe('GET /v1/admin/facility — the combined board', () => {
  it('gives the owner every branch, with the work orders and tasks inserted here', async () => {
    const response = await call(owner, 'GET', `/v1/admin/facility?q=${MARK}`);
    expect(response.status).toBe(200);
    const view = await json<FacilityView>(response);
    expect(view.scope.allBranches).toBe(true);
    expect(view.scope.branchIds).toEqual(expect.arrayContaining(['br_kor', 'br_ind', 'br_hsr']));
    expect(view.scope.branchNames).toContain('Indiranagar Reef');
    expect(view.workOrders.map((row) => row.id).sort()).toEqual([safetyOrderId, doneOrderId, korOrderId].sort());
    expect(view.tasks.map((row) => row.id).sort()).toEqual([overdueTaskId, korTaskId].sort());
    // Metrics are computed over the whole scope, not the `q` filter.
    expect(view.metrics.safetyIssues).toBeGreaterThanOrEqual(1);
    expect(view.metrics.openWorkOrders).toBeGreaterThanOrEqual(2);
    expect(view.metrics.totalTasks).toBeGreaterThanOrEqual(2);

    const safety = view.workOrders.find((row) => row.id === safetyOrderId)!;
    expect(safety).toMatchObject({
      branchId: 'br_ind',
      branchName: 'Indiranagar Reef',
      severity: 'safety',
      restricted: true,
      description: 'Cable sheath split near the pulley; member reported it.',
      reportedByName: 'Floor Member',
      assigneeId: staffIdFor('rehan@sharkfitness.in'),
      assigneeName: 'Rehan Ahmed',
    });
  });

  it('keeps a branch manager to their branch and hides the other branch on request', async () => {
    const response = await call(manager, 'GET', `/v1/admin/facility?q=${MARK}`);
    expect(response.status).toBe(200);
    const view = await json<FacilityView>(response);
    expect(view.scope.branchIds).toEqual(['br_kor']);
    expect(view.workOrders.map((row) => row.id)).toEqual([korOrderId]);
    expect(view.tasks.map((row) => row.id)).toEqual([korTaskId]);
    expect(view.equipment.every((row) => row.branchId === 'br_kor')).toBe(true);

    const elsewhere = await call(manager, 'GET', '/v1/admin/facility?branchId=br_ind');
    expect(elsewhere.status).toBe(404);
  });

  it('redacts a safety report for a trainer, who may view but is not management', async () => {
    const response = await call(trainer, 'GET', `/v1/admin/facility?q=${MARK}&severity=safety`);
    expect(response.status).toBe(200);
    const view = await json<FacilityView>(response);
    expect(view.workOrders.map((row) => row.id)).toEqual([safetyOrderId]);
    expect(view.workOrders[0]).toMatchObject({ restricted: true, description: '', reportedByName: 'Restricted report' });
  });

  it('refuses roles without facility.view and members', async () => {
    for (const session of [reception, accountant, member]) {
      const response = await call(session, 'GET', '/v1/admin/facility');
      expect(response.status).toBe(403);
    }
  });
});

describe('GET /v1/admin/facility/work-orders and /tasks — the filtered lists', () => {
  it('filters work orders by state and severity inside the caller scope', async () => {
    const all = await call(owner, 'GET', `/v1/admin/facility/work-orders?q=${MARK}&branchId=br_ind`);
    expect(all.status).toBe(200);
    const listing = await json<Listing<WorkOrder>>(all);
    expect(listing.scope).toMatchObject({ branchIds: ['br_ind'], allBranches: false });
    expect(listing.items.map((row) => row.id).sort()).toEqual([safetyOrderId, doneOrderId].sort());
    expect(listing.items.find((row) => row.id === doneOrderId)!.closedAt).not.toBeNull();

    const done = await json<Listing<WorkOrder>>(await call(owner, 'GET', `/v1/admin/facility/work-orders?q=${MARK}&workOrderState=done`));
    expect(done.items.map((row) => row.id)).toEqual([doneOrderId]);

    const safety = await json<Listing<WorkOrder>>(await call(owner, 'GET', `/v1/admin/facility/work-orders?q=${MARK}&severity=safety`));
    expect(safety.items.map((row) => row.id)).toEqual([safetyOrderId]);

    const managerView = await json<Listing<WorkOrder>>(await call(manager, 'GET', `/v1/admin/facility/work-orders?q=${MARK}`));
    expect(managerView.items.map((row) => row.id)).toEqual([korOrderId]);
  });

  it('refuses an unknown severity and a role without facility.view', async () => {
    const invalid = await call(owner, 'GET', '/v1/admin/facility/work-orders?severity=catastrophic');
    expect(invalid.status).toBe(422);
    expect((await json<{ error: { code: string } }>(invalid)).error.code).toBe('VALIDATION_FAILED');
    expect((await call(reception, 'GET', '/v1/admin/facility/work-orders')).status).toBe(403);
  });

  it('lists tasks with their checklist, assignee and an overdue flag for a past due date', async () => {
    const response = await call(owner, 'GET', `/v1/admin/facility/tasks?q=${MARK}`);
    expect(response.status).toBe(200);
    const listing = await json<Listing<Task>>(response);
    // Ordered by next due date: the overdue one first.
    expect(listing.items.map((row) => row.id)).toEqual([overdueTaskId, korTaskId]);
    expect(listing.items[0]).toMatchObject({
      branchId: 'br_ind',
      cadence: 'weekly',
      overdue: true,
      state: 'open',
      checklist: ['Pins', 'Hooks'],
      assigneeName: 'Rehan Ahmed',
    });
    expect(listing.items[1]).toMatchObject({ branchId: 'br_kor', overdue: false, assigneeId: null, assigneeName: null });

    const doneOnly = await json<Listing<Task>>(await call(owner, 'GET', `/v1/admin/facility/tasks?q=${MARK}&taskState=done`));
    expect(doneOnly.items).toEqual([]);

    const managerView = await json<Listing<Task>>(await call(manager, 'GET', `/v1/admin/facility/tasks?q=${MARK}`));
    expect(managerView.items.map((row) => row.id)).toEqual([korTaskId]);
    expect((await call(manager, 'GET', '/v1/admin/facility/tasks?branchId=br_hsr')).status).toBe(404);
    expect((await call(accountant, 'GET', '/v1/admin/facility/tasks')).status).toBe(403);
  });
});

describe('GET /v1/admin/facility/assignees', () => {
  it('lists active staff assigned to the branch asked about', async () => {
    const response = await call(owner, 'GET', '/v1/admin/facility/assignees?branchId=br_ind');
    expect(response.status).toBe(200);
    const { items } = await json<{ items: Array<{ id: string; name: string }> }>(response);
    const ids = items.map((row) => row.id);
    expect(ids).toContain(staffIdFor('rehan@sharkfitness.in'));
    expect(ids).toContain(staffIdFor('owner@sharkfitness.in'));
    // The branch manager and reception hold br_kor only.
    expect(ids).not.toContain(staffIdFor('manager@sharkfitness.in'));
    expect(ids).not.toContain(staffIdFor('reception@sharkfitness.in'));
    expect(items.find((row) => row.id === staffIdFor('rehan@sharkfitness.in'))!.name).toBe('Rehan Ahmed');
  });

  it("answers within the manager's own branch and refuses another branch and other roles", async () => {
    const own = await json<{ items: Array<{ id: string }> }>(await call(manager, 'GET', '/v1/admin/facility/assignees'));
    expect(own.items.map((row) => row.id)).toEqual(expect.arrayContaining([staffIdFor('manager@sharkfitness.in'), staffIdFor('reception@sharkfitness.in')]));
    expect((await call(manager, 'GET', '/v1/admin/facility/assignees?branchId=br_ind')).status).toBe(404);
    expect((await call(reception, 'GET', '/v1/admin/facility/assignees')).status).toBe(403);
  });
});

describe('POST /v1/admin/facility/facility-tasks', () => {
  const dueAt = new Date(now() + 10 * DAY).toISOString();
  const body = (overrides: Record<string, unknown> = {}) => ({
    branchId: 'br_ind',
    title: `${MARK} quarterly fire drill`,
    cadence: 'quarterly',
    nextDueAt: dueAt,
    assigneeId: staffIdFor('rehan@sharkfitness.in'),
    checklist: ['Alarm test', 'Exit signage'],
    ...overrides,
  });

  it('creates an open task, audits it, and replays the same response for the same key', async () => {
    const key = `${MARK}-create`;
    const payload = body();
    const response = await call(owner, 'POST', '/v1/admin/facility/facility-tasks', payload, { 'idempotency-key': key });
    expect(response.status).toBe(201);
    const { task } = await json<{ task: { id: string } }>(response);
    createdTaskIds.push(task.id);

    const row = db.select().from(schema.facilityTasks).where(eq(schema.facilityTasks.id, task.id)).get()!;
    expect(row).toMatchObject({
      tenantId: TENANT,
      branchId: 'br_ind',
      cadence: 'quarterly',
      state: 'open',
      assigneeId: staffIdFor('rehan@sharkfitness.in'),
      checklist: ['Alarm test', 'Exit signage'],
      lastCompletedAt: null,
    });
    const auditRow = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, task.id), eq(schema.auditLog.action, 'facility_task.created')))
      .get();
    expect(auditRow).toMatchObject({ entityType: 'facility_task', branchId: 'br_ind', actorRole: 'owner', entityLabel: `${MARK} quarterly fire drill` });

    const replay = await call(owner, 'POST', '/v1/admin/facility/facility-tasks', payload, { 'idempotency-key': key });
    expect(replay.status).toBe(201);
    expect((await json<{ task: { id: string } }>(replay)).task.id).toBe(task.id);
    expect(db.select().from(schema.facilityTasks).where(eq(schema.facilityTasks.title, `${MARK} quarterly fire drill`)).all()).toHaveLength(1);

    // The new task is on the board straight away.
    const listing = await json<Listing<Task>>(await call(owner, 'GET', `/v1/admin/facility/tasks?q=${encodeURIComponent(`${MARK} quarterly`)}`));
    expect(listing.items.map((item) => item.id)).toEqual([task.id]);
  });

  it('lets a branch manager create at their own branch only', async () => {
    const own = await call(manager, 'POST', '/v1/admin/facility/facility-tasks', body({ branchId: 'br_kor', title: `${MARK} kor towels`, assigneeId: staffIdFor('reception@sharkfitness.in') }));
    expect(own.status).toBe(201);
    createdTaskIds.push((await json<{ task: { id: string } }>(own)).task.id);

    const other = await call(manager, 'POST', '/v1/admin/facility/facility-tasks', body({ title: `${MARK} not mine` }));
    expect(other.status).toBe(403);
    expect(db.select().from(schema.facilityTasks).where(eq(schema.facilityTasks.title, `${MARK} not mine`)).get()).toBeUndefined();
  });

  it('refuses an assignee who does not work at the branch, an empty checklist, and roles without facility.manage', async () => {
    const wrongAssignee = await call(owner, 'POST', '/v1/admin/facility/facility-tasks', body({ title: `${MARK} wrong assignee`, assigneeId: staffIdFor('manager@sharkfitness.in') }));
    expect(wrongAssignee.status).toBe(422);
    expect((await json<{ error: { message: string } }>(wrongAssignee)).error.message).toMatch(/not assigned to this branch/);

    const emptyChecklist = await call(owner, 'POST', '/v1/admin/facility/facility-tasks', body({ title: `${MARK} empty`, checklist: [] }));
    expect(emptyChecklist.status).toBe(422);

    for (const session of [trainer, reception]) {
      const response = await call(session, 'POST', '/v1/admin/facility/facility-tasks', body({ title: `${MARK} refused` }));
      expect(response.status).toBe(403);
    }
    expect(
      db.select().from(schema.facilityTasks).where(inArray(schema.facilityTasks.title, [`${MARK} wrong assignee`, `${MARK} empty`, `${MARK} refused`])).all(),
    ).toEqual([]);
  });
});
