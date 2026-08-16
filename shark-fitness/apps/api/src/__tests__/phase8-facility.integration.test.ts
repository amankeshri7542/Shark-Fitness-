import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

interface Session {
  cookie: string;
  csrfToken: string;
}

interface EquipmentResponse {
  equipment: { id: string; branchId?: string; area?: string; status?: string };
}

interface WorkOrderResponse {
  workOrder: { id: string; reference?: string; duplicateOfId?: string | null; state?: string; overdue?: boolean; description?: string };
}

interface TaskResponse {
  task: { id: string; state?: string; branchState?: string; overdue?: boolean };
}

const cache = new Map<string, Session>();
let uniqueCounter = 0;

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const get = (session: Session, path: string) => app.request(path, { headers: headers(session) });
const post = (session: Session, path: string, body: unknown, key?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { ...headers(session, true), ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
const patch = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(session, true), body: JSON.stringify(body) });

function tenantId(): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

function staffId(email: string): string {
  return db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(and(eq(schema.staff.tenantId, tenantId()), eq(schema.users.email, email)))
    .get()!.id;
}

function uniqueTag(prefix = 'P8'): string {
  uniqueCounter += 1;
  return `${prefix}-${now()}-${uniqueCounter}`;
}

function equipmentBody(branchId = 'br_kor') {
  const assetTag = uniqueTag();
  return {
    name: `Phase 8 asset ${assetTag}`,
    assetTag,
    branchId,
    area: 'Strength floor',
    model: 'Test model',
    serial: uniqueTag('SERIAL'),
    vendor: 'Test vendor',
    warrantyUntil: null,
    serviceIntervalDays: 30,
    linkedExerciseId: null,
    status: 'available',
  };
}

async function createEquipment(owner: Session, branchId = 'br_kor'): Promise<string> {
  const response = await post(owner, '/v1/admin/facility/equipment', equipmentBody(branchId), uniqueTag('equipment-key'));
  expect(response.status).toBe(201);
  return ((await response.json()) as EquipmentResponse).equipment.id;
}

async function createWorkOrder(owner: Session, equipmentId: string, title = uniqueTag('issue'), severity = 'medium'): Promise<string> {
  const response = await post(owner, '/v1/admin/facility/work-orders', {
    equipmentId,
    title,
    description: 'Reported during the Phase 8 integration test.',
    severity,
    reportedByKind: 'staff',
    assigneeId: null,
    costMinor: 12500,
  }, uniqueTag('work-order-key'));
  expect(response.status).toBe(201);
  return ((await response.json()) as WorkOrderResponse).workOrder.id;
}

describe('Phase 8 — equipment and facility operations', () => {
  it('creates, lists, updates and audits equipment with metrics', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const body = equipmentBody();
    const created = await post(owner, '/v1/admin/facility/equipment', body, uniqueTag('equipment-key'));
    expect(created.status).toBe(201);
    const equipmentId = ((await created.json()) as EquipmentResponse).equipment.id;

    const list = await get(owner, `/v1/admin/facility/equipment?q=${encodeURIComponent(body.assetTag)}`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { metrics: { equipmentTotal: number }; items: Array<{ id: string; assetTag: string }> };
    expect(listBody.items.some((item) => item.id === equipmentId && item.assetTag === body.assetTag)).toBe(true);
    expect(listBody.metrics.equipmentTotal).toBeGreaterThan(0);

    const updated = await patch(owner, `/v1/admin/facility/equipment/${equipmentId}`, { area: 'Recovery floor' });
    expect(updated.status).toBe(200);
    const detail = await get(owner, `/v1/admin/facility/equipment/${equipmentId}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as EquipmentResponse).equipment.area).toBe('Recovery floor');

    const actions = db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, 'equipment'), eq(schema.auditLog.entityId, equipmentId)))
      .all()
      .map((row) => row.action);
    expect(actions).toContain('equipment.created');
    expect(actions).toContain('equipment.updated');
  });

  it('creates, assigns and resolves a work order only with a resolution note', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const equipmentId = await createEquipment(owner);
    const workOrderId = await createWorkOrder(owner, equipmentId);

    const assigned = await patch(owner, `/v1/admin/facility/work-orders/${workOrderId}`, { assigneeId: staffId('rehan@sharkfitness.in') });
    expect(assigned.status).toBe(200);
    expect(((await assigned.json()) as WorkOrderResponse).workOrder.state).toBe('assigned');

    const withoutNote = await patch(owner, `/v1/admin/facility/work-orders/${workOrderId}`, { state: 'done' });
    expect(withoutNote.status).toBe(422);

    const resolved = await patch(owner, `/v1/admin/facility/work-orders/${workOrderId}`, {
      state: 'done',
      resolutionNote: 'Replaced the bearing and verified the machine under load.',
      costMinor: 18500,
    });
    expect(resolved.status).toBe(200);

    const detail = await get(owner, `/v1/admin/facility/work-orders/${workOrderId}`);
    expect(detail.status).toBe(200);
    const detailBody = ((await detail.json()) as WorkOrderResponse).workOrder;
    expect(detailBody.state).toBe('done');
    expect(detailBody.description).toContain('Resolution: Replaced the bearing');
    const equipment = await get(owner, `/v1/admin/facility/equipment/${equipmentId}`);
    expect(((await equipment.json()) as EquipmentResponse).equipment.status).toBe('available');
  });

  it('refuses every facility mutation to a facility viewer without manage permission', async () => {
    const viewer = await signIn('rehan@sharkfitness.in');
    const owner = await signIn('owner@sharkfitness.in');
    const equipmentId = await createEquipment(owner);
    const workOrderId = await createWorkOrder(owner, equipmentId);
    const taskId = ((await (await post(owner, '/v1/admin/facility/tasks', {
      branchId: 'br_kor',
      title: uniqueTag('task'),
      cadence: 'daily',
      nextDueAt: new Date(now() + 86_400_000).toISOString(),
      assigneeId: null,
      checklist: ['Inspect floor'],
    }, uniqueTag('task-key'))).json()) as TaskResponse).task.id;

    expect((await post(viewer, '/v1/admin/facility/equipment', equipmentBody())).status).toBe(403);
    expect((await patch(viewer, `/v1/admin/facility/equipment/${equipmentId}`, { area: 'No access' })).status).toBe(403);
    expect((await post(viewer, '/v1/admin/facility/work-orders', { equipmentId, title: uniqueTag('viewer-issue') })).status).toBe(403);
    expect((await patch(viewer, `/v1/admin/facility/work-orders/${workOrderId}`, { title: 'No access' })).status).toBe(403);
    expect((await post(viewer, '/v1/admin/facility/tasks', { branchId: 'br_kor', title: uniqueTag('viewer-task'), cadence: 'daily', nextDueAt: new Date(now() + 86_400_000).toISOString(), checklist: ['No access'] })).status).toBe(403);
    expect((await patch(viewer, `/v1/admin/facility/tasks/${taskId}`, { title: 'No access' })).status).toBe(403);
  });

  it('returns a branch-out-of-scope equipment record as 404, not 403', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const manager = await signIn('manager@sharkfitness.in');
    const equipmentId = await createEquipment(owner, 'br_ind');

    expect((await get(manager, `/v1/admin/facility/equipment/${equipmentId}`)).status).toBe(404);
    expect((await get(manager, '/v1/admin/facility/equipment?branchId=br_ind')).status).toBe(404);
  });

  it('returns a cross-tenant equipment record as 404', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const equipmentId = id('eqp');
    db.insert(schema.equipment).values({
      id: equipmentId,
      tenantId: id('ten'),
      branchId: 'br_kor',
      name: 'Other tenant asset',
      assetTag: uniqueTag('OTHER'),
      area: 'Other floor',
      model: '',
      serial: '',
      vendor: '',
      warrantyUntil: null,
      status: 'available',
      lastServicedOn: null,
      serviceIntervalDays: 90,
      linkedExerciseId: null,
      createdAt: now(),
    }).run();

    expect((await get(owner, `/v1/admin/facility/equipment/${equipmentId}`)).status).toBe(404);
  });

  it('moves an equipment asset and its open work order together', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const equipmentId = await createEquipment(owner, 'br_kor');
    const workOrderId = await createWorkOrder(owner, equipmentId);

    const moved = await patch(owner, `/v1/admin/facility/equipment/${equipmentId}`, { branchId: 'br_hsr' });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as EquipmentResponse).equipment.branchId).toBe('br_hsr');

    const detail = await get(owner, `/v1/admin/facility/equipment/${equipmentId}`);
    const detailBody = (await detail.json()) as { equipment: { branchId: string }; workOrders: Array<{ id: string; branchId: string }> };
    expect(detailBody.equipment.branchId).toBe('br_hsr');
    expect(detailBody.workOrders.find((order) => order.id === workOrderId)?.branchId).toBe('br_hsr');
  });

  it('keeps an overdue safety order open and marks it overdue', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const equipmentId = await createEquipment(owner);
    const workOrderId = await createWorkOrder(owner, equipmentId, uniqueTag('safety'), 'safety');
    db.update(schema.workOrders).set({ openedAt: now() - 3 * 86_400_000 }).where(and(eq(schema.workOrders.id, workOrderId), eq(schema.workOrders.tenantId, tenantId()))).run();

    const detail = await get(owner, `/v1/admin/facility/work-orders/${workOrderId}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as WorkOrderResponse;
    expect(body.workOrder.state).toBe('open');
    expect(body.workOrder.overdue).toBe(true);

    const equipment = await get(owner, `/v1/admin/facility/equipment/${equipmentId}`);
    expect(((await equipment.json()) as EquipmentResponse).equipment.status).toBe('out_of_service');
  });

  it('keeps a recurring task visible without overdue escalation while its branch is temporarily closed', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const taskResponse = await post(owner, '/v1/admin/facility/tasks', {
      branchId: 'br_hsr',
      title: uniqueTag('closed-branch-task'),
      cadence: 'daily',
      nextDueAt: new Date(now() - 86_400_000).toISOString(),
      assigneeId: null,
      checklist: ['Inspect the closed floor'],
    }, uniqueTag('task-key'));
    expect(taskResponse.status).toBe(201);
    const taskId = ((await taskResponse.json()) as TaskResponse).task.id;
    const branch = db.select({ state: schema.branches.state }).from(schema.branches).where(and(eq(schema.branches.id, 'br_hsr'), eq(schema.branches.tenantId, tenantId()))).get()!;
    db.update(schema.branches).set({ state: 'temporarily_closed' }).where(and(eq(schema.branches.id, 'br_hsr'), eq(schema.branches.tenantId, tenantId()))).run();

    try {
      const detail = await get(owner, `/v1/admin/facility/tasks/${taskId}`);
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as TaskResponse;
      expect(body.task.branchState).toBe('temporarily_closed');
      expect(body.task.overdue).toBe(false);
    } finally {
      db.update(schema.branches).set({ state: branch.state }).where(and(eq(schema.branches.id, 'br_hsr'), eq(schema.branches.tenantId, tenantId()))).run();
    }
  });

  it('links duplicate issue reports to the original open fault', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const equipmentId = await createEquipment(owner);
    const title = uniqueTag('duplicate-fault');
    const first = await post(owner, '/v1/admin/facility/work-orders', { equipmentId, title, description: 'The same fault was first reported.', severity: 'medium' }, uniqueTag('work-order-key'));
    const firstId = ((await first.json()) as WorkOrderResponse).workOrder.id;
    const second = await post(owner, '/v1/admin/facility/work-orders', { equipmentId, title: ` ${title.toUpperCase()} `, description: 'A second report describes the same fault.', severity: 'medium' }, uniqueTag('work-order-key'));
    expect(second.status).toBe(201);
    expect(((await second.json()) as WorkOrderResponse).workOrder.duplicateOfId).toBe(firstId);
  });

  it('restricts sensitive safety details to management roles', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const viewer = await signIn('rehan@sharkfitness.in');
    const equipmentId = await createEquipment(owner);
    const response = await post(owner, '/v1/admin/facility/work-orders', {
      equipmentId,
      title: uniqueTag('sensitive-safety'),
      description: 'Member disclosed sensitive personal information at the scene.',
      severity: 'safety',
      reportedByName: 'Sensitive member report',
      reportedByKind: 'member',
    }, uniqueTag('work-order-key'));
    const workOrderId = ((await response.json()) as WorkOrderResponse).workOrder.id;

    const restricted = await get(viewer, `/v1/admin/facility/work-orders/${workOrderId}`);
    const restrictedBody = (await restricted.json()) as WorkOrderResponse;
    expect(restrictedBody.workOrder.description).toBe('');

    const visible = await get(owner, `/v1/admin/facility/work-orders/${workOrderId}`);
    expect(((await visible.json()) as WorkOrderResponse).workOrder.description).toContain('sensitive personal information');
  });

  it('shows overdue maintenance while keeping the equipment available', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const equipmentId = await createEquipment(owner);
    const serviced = await patch(owner, `/v1/admin/facility/equipment/${equipmentId}`, { lastServicedOn: '2020-01-01', status: 'available' });
    expect(serviced.status).toBe(200);

    const list = await get(owner, '/v1/admin/facility/equipment?status=available');
    const item = ((await list.json()) as { items: Array<{ id: string; status: string; overdue: boolean }> }).items.find((entry) => entry.id === equipmentId);
    expect(item).toMatchObject({ id: equipmentId, status: 'available', overdue: true });
  });

  it('excludes out-of-service equipment from available equipment reads', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const equipmentId = await createEquipment(owner);
    const updated = await patch(owner, `/v1/admin/facility/equipment/${equipmentId}`, { status: 'out_of_service' });
    expect(updated.status).toBe(200);

    const available = await get(owner, '/v1/admin/facility/equipment?status=available');
    expect(((await available.json()) as { items: Array<{ id: string }> }).items.some((item) => item.id === equipmentId)).toBe(false);
  });

  it('creates and completes a recurring checklist task', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const created = await post(owner, '/v1/admin/facility/tasks', {
      branchId: 'br_kor',
      title: uniqueTag('checklist'),
      cadence: 'weekly',
      nextDueAt: new Date(now() + 86_400_000).toISOString(),
      assigneeId: staffId('rehan@sharkfitness.in'),
      checklist: ['Inspect equipment', 'Record hazards'],
    }, uniqueTag('task-key'));
    expect(created.status).toBe(201);
    const taskId = ((await created.json()) as TaskResponse).task.id;
    const completed = await patch(owner, `/v1/admin/facility/tasks/${taskId}`, { state: 'done' });
    expect(completed.status).toBe(200);
    expect(((await completed.json()) as TaskResponse).task.state).toBe('done');
  });
});
