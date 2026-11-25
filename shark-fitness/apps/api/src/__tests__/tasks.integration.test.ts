import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { DAY, now } from '../lib/time.js';
import { generateTasks } from '../services/tasks.js';
import { jobsForTest } from '../jobs/scheduler.js';
import { call, memberIdFor, signIn, staffIdFor, type TestSession } from './helpers/session.js';

/* ============================================================================
   Tasks (P07 AC4; PF-DASH-005, PF-SUP-004).
   ========================================================================= */

const TENANT = 'ten_shark';
let owner: TestSession;
let manager: TestSession; // br_kor only
let reception: TestSession; // br_kor only
let trainer: TestSession;
const paymentId = id('pay');
const workOrderId = id('wko');
const leadId = id('led');
const createdTaskIds: string[] = [];

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

beforeAll(async () => {
  [owner, manager, reception, trainer] = await Promise.all([
    signIn('owner@sharkfitness.in'),
    signIn('manager@sharkfitness.in'),
    signIn('reception@sharkfitness.in'),
    signIn('rehan@sharkfitness.in'),
  ]);
  const at = now();
  const memberId = memberIdFor('aman@sharkfitness.in');
  db.insert(schema.payments)
    .values({
      id: paymentId,
      tenantId: TENANT,
      branchId: 'br_kor',
      invoiceId: null,
      memberId,
      method: 'card',
      state: 'failed',
      amountMinor: 150_000,
      currency: 'INR',
      provider: null,
      providerRef: null,
      idempotencyKey: `p07-task-${paymentId}`,
      recordedById: null,
      recordedByName: null,
      failureReason: 'Card declined',
      note: null,
      createdAt: at - DAY,
      settledAt: null,
    })
    .run();
  db.insert(schema.workOrders)
    .values({
      id: workOrderId,
      tenantId: TENANT,
      branchId: 'br_ind',
      reference: 'WO-P07',
      equipmentId: null,
      title: 'Frayed cable on lat pulldown',
      description: '',
      severity: 'safety',
      state: 'open',
      reportedById: null,
      reportedByName: 'Test',
      reportedByKind: 'staff',
      assigneeId: null,
      costMinor: 0,
      duplicateOfId: null,
      openedAt: at - DAY,
      closedAt: null,
    })
    .run();
  db.insert(schema.leads)
    .values({
      id: leadId,
      tenantId: TENANT,
      branchId: 'br_kor',
      name: 'Kavya P07 Lead',
      phone: null,
      email: null,
      phoneNormalized: null,
      emailNormalized: null,
      source: 'walk_in',
      campaign: null,
      stage: 'contacted',
      ownerId: staffIdFor('reception@sharkfitness.in'),
      expectedValueMinor: 0,
      nextActionAt: at - 2 * DAY,
      nextActionLabel: 'Call back about the trial',
      lastTouchedAt: at - 3 * DAY,
      lossReason: null,
      convertedMemberId: null,
      duplicateOfId: null,
      tags: [],
      createdAt: at - 5 * DAY,
      updatedAt: at - 3 * DAY,
    })
    .run();
});

afterAll(() => {
  db.delete(schema.tasks).where(inArray(schema.tasks.sourceId, [paymentId, workOrderId, leadId])).run();
  if (createdTaskIds.length) db.delete(schema.tasks).where(inArray(schema.tasks.id, createdTaskIds)).run();
  db.delete(schema.tasks).where(like(schema.tasks.title, 'P07 test:%')).run();
  db.delete(schema.payments).where(eq(schema.payments.id, paymentId)).run();
  db.delete(schema.workOrders).where(eq(schema.workOrders.id, workOrderId)).run();
  db.delete(schema.leads).where(eq(schema.leads.id, leadId)).run();
});

const generatedFor = (sourceId: string) =>
  db.select().from(schema.tasks).where(and(eq(schema.tasks.tenantId, TENANT), eq(schema.tasks.sourceId, sourceId))).all();

describe('generated from operational alerts', () => {
  it('creates one task per alert and never duplicates it across scheduler runs', async () => {
    const first = generateTasks();
    expect(first.created).toBeGreaterThanOrEqual(3);
    const second = generateTasks();
    expect(second.created).toBe(0);
    // Through the real scheduler wrapper (job_runs row and all) as well.
    await jobsForTest.execute('generate-tasks');

    expect(generatedFor(paymentId)).toHaveLength(1);
    expect(generatedFor(workOrderId)).toHaveLength(1);
    expect(generatedFor(leadId)).toHaveLength(1);

    expect(generatedFor(paymentId)[0]).toMatchObject({ source: 'failed_payment', priority: 'high', branchId: 'br_kor', status: 'open' });
    expect(generatedFor(workOrderId)[0]).toMatchObject({ source: 'safety_work_order', priority: 'urgent', branchId: 'br_ind' });
    const leadTask = generatedFor(leadId)[0]!;
    expect(leadTask).toMatchObject({ source: 'lead_sla', link: `/leads/${leadId}`, assigneeStaffId: staffIdFor('reception@sharkfitness.in') });
    // The assignee hears about it.
    const note = db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.dedupeKey, `task:${leadTask.id}:${leadTask.assigneeStaffId}`)).get();
    expect(note?.state).toBe('sent');
  });
});

describe('branch scope', () => {
  it('404s a task outside the caller’s branches, for reads and writes', async () => {
    const indTask = generatedFor(workOrderId)[0]!;
    expect((await call(owner, 'GET', `/v1/admin/tasks/${indTask.id}`)).status).toBe(200);
    expect((await call(manager, 'GET', `/v1/admin/tasks/${indTask.id}`)).status).toBe(404);
    expect((await call(manager, 'PATCH', `/v1/admin/tasks/${indTask.id}`, { priority: 'low' })).status).toBe(404);
    expect((await call(manager, 'POST', `/v1/admin/tasks/${indTask.id}/complete`, { outcome: 'Fixed it' })).status).toBe(404);
    const list = await json<{ items: Array<{ id: string }> }>(await call(manager, 'GET', '/v1/admin/tasks?view=open'));
    expect(list.items.some((t) => t.id === indTask.id)).toBe(false);
  });

  it('assigns only to staff who work at the task’s branch', async () => {
    const korTask = generatedFor(paymentId)[0]!;
    const indOnly = await call(owner, 'PATCH', `/v1/admin/tasks/${korTask.id}`, { assigneeStaffId: 'stf_not_real' });
    expect(indOnly.status).toBe(422);
    const ok = await call(manager, 'PATCH', `/v1/admin/tasks/${korTask.id}`, { assigneeStaffId: staffIdFor('reception@sharkfitness.in') });
    expect(ok.status).toBe(200);
    expect((await json<{ task: { assignee: { name: string } } }>(ok)).task.assignee).not.toBeNull();
  });

  it('lets a trainer work their own tasks but not hand tasks to others', async () => {
    const own = await call(trainer, 'POST', '/v1/admin/tasks', { branchId: 'br_kor', title: 'P07 test: plan for Aman' });
    expect(own.status).toBe(201);
    createdTaskIds.push((await json<{ task: { id: string } }>(own)).task.id);
    const handOff = await call(trainer, 'POST', '/v1/admin/tasks', {
      branchId: 'br_kor',
      title: 'P07 test: for reception',
      assigneeStaffId: staffIdFor('reception@sharkfitness.in'),
    });
    expect(handOff.status).toBe(403);
    const mine = await json<{ items: Array<{ title: string }> }>(await call(trainer, 'GET', '/v1/admin/tasks?view=open'));
    expect(mine.items.map((t) => t.title)).toContain('P07 test: plan for Aman');
    expect(mine.items.some((t) => t.title.startsWith('Payment failed'))).toBe(false);
  });
});

describe('finishing a task', () => {
  it('requires an outcome and records it', async () => {
    const created = await json<{ task: { id: string } }>(
      await call(reception, 'POST', '/v1/admin/tasks', {
        branchId: 'br_kor',
        title: 'P07 test: call Aman about locker',
        memberId: memberIdFor('aman@sharkfitness.in'),
        priority: 'high',
        dueAt: new Date(now() + DAY).toISOString(),
      }),
    );
    createdTaskIds.push(created.task.id);

    expect((await call(reception, 'POST', `/v1/admin/tasks/${created.task.id}/complete`, { outcome: '' })).status).toBe(422);
    const done = await call(reception, 'POST', `/v1/admin/tasks/${created.task.id}/complete`, { outcome: 'Spoke to him; locker 14 renewed.' });
    expect(done.status).toBe(200);
    expect((await json<{ task: { status: string; outcome: string; completedAt: string } }>(done)).task).toMatchObject({
      status: 'done',
      outcome: 'Spoke to him; locker 14 renewed.',
      completedAt: expect.any(String),
    });
    const audit = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, created.task.id), eq(schema.auditLog.action, 'task.completed'))).get();
    expect(audit).toBeDefined();
    expect((await call(reception, 'PATCH', `/v1/admin/tasks/${created.task.id}`, { priority: 'low' })).status).toBe(422);
  });
});

describe('the status strip', () => {
  it('counts exactly the open tasks assigned to me', async () => {
    for (const title of ['P07 test: one', 'P07 test: two']) {
      const r = await json<{ task: { id: string } }>(await call(reception, 'POST', '/v1/admin/tasks', { branchId: 'br_kor', title }));
      createdTaskIds.push(r.task.id);
    }
    const summary = await json<{ mine: number; mineOverdue: number; toActOn: number }>(await call(reception, 'GET', '/v1/admin/tasks/summary'));
    const mine = await json<{ items: Array<{ status: string; overdue: boolean }> }>(await call(reception, 'GET', '/v1/admin/tasks?view=mine'));
    expect(summary.mine).toBe(mine.items.length);
    expect(summary.mineOverdue).toBe(mine.items.filter((t) => t.overdue).length);
    expect(summary.mine).toBeGreaterThanOrEqual(3);

    const managerSummary = await json<{ toActOn: number }>(await call(manager, 'GET', '/v1/admin/tasks/summary'));
    const open = await json<{ items: Array<{ source: string }> }>(await call(manager, 'GET', '/v1/admin/tasks?view=open'));
    expect(managerSummary.toActOn).toBe(open.items.filter((t) => t.source !== 'manual').length);
  });
});
