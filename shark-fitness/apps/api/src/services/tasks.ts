import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { TENANT_STATUSES, type TenantStatus } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, HOUR, isoDate, now, relativeTime } from '../lib/time.js';
import { leadSlaBreached } from './leads.js';
import { queueNotification } from './notifications/service.js';
import type { LeadStage } from '@shark/contracts';

/**
 * Tasks — the staff work queue (P07; PF-DASH-005 member-risk tasks, PF-SUP-004).
 *
 * Two ways a task appears: someone creates one, or the generator turns an
 * operational alert into a named piece of work for a named person. Generated
 * tasks carry a `generationKey`; the unique index on (tenant, key) means a
 * second scheduler run, or two overlapping ticks, cannot open the same
 * follow-up twice — the database refuses it.
 *
 * Scope: a task belongs to a branch. Outside the caller's branches it is not
 * found. People who can manage tasks see the branch's queue; everyone else
 * sees what is assigned to them or what they created.
 */

export const TASK_SOURCES = ['manual', 'lead_sla', 'failed_payment', 'member_risk', 'safety_work_order', 'waitlist_offer'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

type Task = typeof schema.tasks.$inferSelect;

const SOURCE_LABEL: Record<TaskSource, string> = {
  manual: 'Created by staff',
  lead_sla: 'Lead past its follow-up time',
  failed_payment: 'Failed payment',
  member_risk: 'Member at risk of leaving',
  safety_work_order: 'Safety issue on the floor',
  waitlist_offer: 'Waitlist offer not answered',
};

/* ——— Generation ————————————————————————————————————————————— */

interface Candidate {
  tenantId: string;
  branchId: string;
  source: TaskSource;
  sourceType: string;
  sourceId: string;
  generationKey: string;
  title: string;
  detail: string;
  memberId: string | null;
  leadId: string | null;
  link: string;
  assigneeStaffId: string | null;
  priority: TaskPriority;
  dueAt: number;
}

function memberName(m: { firstName: string; lastName: string }): string {
  return `${m.firstName} ${m.lastName}`.trim();
}

function candidatesFor(tenantId: string, atMs: number): Candidate[] {
  const out: Candidate[] = [];

  // Leads past their follow-up (PF-CRM-006).
  for (const lead of db
    .select()
    .from(schema.leads)
    .where(and(eq(schema.leads.tenantId, tenantId), sql`${schema.leads.stage} not in ('won','lost','disqualified')`))
    .all()) {
    if (!leadSlaBreached({ stage: lead.stage as LeadStage, nextActionAt: lead.nextActionAt, lastTouchedAt: lead.lastTouchedAt, createdAt: lead.createdAt }, atMs)) continue;
    out.push({
      tenantId,
      branchId: lead.branchId,
      source: 'lead_sla',
      sourceType: 'lead',
      sourceId: lead.id,
      // One follow-up per missed action: a new next-action date is a new promise.
      generationKey: `lead_sla:${lead.id}:${lead.nextActionAt ?? 'stale'}`,
      title: `Follow up ${lead.name}`,
      detail: lead.nextActionLabel ? `Missed: ${lead.nextActionLabel}.` : 'No contact for three days.',
      memberId: null,
      leadId: lead.id,
      link: `/leads/${lead.id}`,
      assigneeStaffId: lead.ownerId,
      priority: 'high',
      dueAt: atMs,
    });
  }

  // Failed payments in the last fortnight.
  for (const row of db
    .select({ payment: schema.payments, member: schema.members })
    .from(schema.payments)
    .innerJoin(schema.members, eq(schema.members.id, schema.payments.memberId))
    .where(and(eq(schema.payments.tenantId, tenantId), eq(schema.payments.state, 'failed'), gte(schema.payments.createdAt, atMs - 14 * DAY)))
    .all()) {
    out.push({
      tenantId,
      branchId: row.payment.branchId ?? row.member.homeBranchId,
      source: 'failed_payment',
      sourceType: 'payment',
      sourceId: row.payment.id,
      generationKey: `failed_payment:${row.payment.id}`,
      title: `Payment failed: ${memberName(row.member)}`,
      detail: row.payment.failureReason ? `Reason given: ${row.payment.failureReason}.` : 'Get in touch before the grace period runs out.',
      memberId: row.member.id,
      leadId: null,
      link: `/members/${row.member.id}`,
      assigneeStaffId: null,
      priority: 'high',
      dueAt: atMs + 24 * HOUR,
    });
  }

  // Members at high risk of leaving: one call a month, by their coach if they have one.
  const month = isoDate(atMs, 'UTC').slice(0, 7);
  for (const member of db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenantId), gte(schema.members.riskScore, 55), sql`${schema.members.deletedAt} is null`))
    .all()) {
    out.push({
      tenantId,
      branchId: member.homeBranchId,
      source: 'member_risk',
      sourceType: 'member',
      sourceId: member.id,
      generationKey: `member_risk:${member.id}:${month}`,
      title: `Call ${memberName(member)}`,
      detail: member.riskReasons?.length ? `Why: ${member.riskReasons.join('; ')}.` : 'Their attendance and payments suggest they may leave.',
      memberId: member.id,
      leadId: null,
      link: `/members/${member.id}`,
      assigneeStaffId: member.trainerId,
      priority: 'normal',
      dueAt: atMs + 3 * DAY,
    });
  }

  // Safety work orders still open.
  for (const order of db
    .select()
    .from(schema.workOrders)
    .where(and(eq(schema.workOrders.tenantId, tenantId), eq(schema.workOrders.severity, 'safety'), sql`${schema.workOrders.state} in ('open','assigned','in_progress','blocked')`))
    .all()) {
    out.push({
      tenantId,
      branchId: order.branchId,
      source: 'safety_work_order',
      sourceType: 'work_order',
      sourceId: order.id,
      generationKey: `safety_work_order:${order.id}`,
      title: `Make safe: ${order.title}`,
      detail: `${order.reference}. Take it out of use or fix it before members reach it.`,
      memberId: null,
      leadId: null,
      link: '/equipment?severity=safety',
      assigneeStaffId: order.assigneeId,
      priority: 'urgent',
      dueAt: atMs + 2 * HOUR,
    });
  }

  // Waitlist offers left hanging past their window.
  for (const row of db
    .select({ entry: schema.waitlistEntries, session: schema.classSessions, member: schema.members })
    .from(schema.waitlistEntries)
    .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.waitlistEntries.sessionId))
    .innerJoin(schema.members, eq(schema.members.id, schema.waitlistEntries.memberId))
    .where(
      and(
        eq(schema.waitlistEntries.tenantId, tenantId),
        eq(schema.waitlistEntries.state, 'offered'),
        isNotNull(schema.waitlistEntries.offerExpiresAt),
        lt(schema.waitlistEntries.offerExpiresAt, atMs),
        gte(schema.classSessions.startsAt, atMs),
      ),
    )
    .all()) {
    out.push({
      tenantId,
      branchId: row.session.branchId,
      source: 'waitlist_offer',
      sourceType: 'waitlist_entry',
      sourceId: row.entry.id,
      generationKey: `waitlist_offer:${row.entry.id}`,
      title: `Waitlist seat not answered: ${memberName(row.member)}`,
      detail: 'Their offer ran out without an answer. Call them or offer the seat to the next person.',
      memberId: row.member.id,
      leadId: null,
      link: '/schedule',
      assigneeStaffId: null,
      priority: 'high',
      dueAt: Math.min(row.session.startsAt, atMs + HOUR),
    });
  }

  return out;
}

/**
 * A generated task goes to the person its source names (lead owner, coach,
 * work-order assignee) only if they can still act on it: an active account at
 * that branch. Otherwise it waits unassigned in the open queue, where a
 * manager sees it, instead of under the "My tasks" of someone who has left.
 */
function canHoldTask(tenantId: string, branchId: string, staffId: string | null): boolean {
  if (!staffId) return false;
  const row = db
    .select({ branchIds: schema.staff.branchIds, employment: schema.staff.employmentStatus, state: schema.users.accountState, role: schema.users.role })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(and(eq(schema.staff.id, staffId), eq(schema.staff.tenantId, tenantId)))
    .get();
  return Boolean(
    row &&
      row.state === 'active' &&
      row.employment === 'active' &&
      row.branchIds.includes(branchId) &&
      !['platform_admin', 'platform_support'].includes(row.role),
  );
}

/** The scheduler job. Idempotent: the unique generation key refuses repeats. */
export function generateTasks(atMs = now()): { created: number; considered: number } {
  let created = 0;
  let considered = 0;
  const tenants = db.select({ id: schema.tenants.id, status: schema.tenants.status, kind: schema.tenants.kind }).from(schema.tenants).all();
  for (const tenant of tenants) {
    if (tenant.kind !== 'customer' || !TENANT_STATUSES[tenant.status as TenantStatus]?.operational) continue;
    const candidates = candidatesFor(tenant.id, atMs);
    considered += candidates.length;
    transact(() => {
      for (const c of candidates) {
        const taskId = id('tsk');
        const assigneeStaffId = canHoldTask(c.tenantId, c.branchId, c.assigneeStaffId) ? c.assigneeStaffId : null;
        const result = db
          .insert(schema.tasks)
          .values({
            id: taskId,
            tenantId: c.tenantId,
            branchId: c.branchId,
            title: c.title,
            detail: c.detail,
            source: c.source,
            sourceType: c.sourceType,
            sourceId: c.sourceId,
            generationKey: c.generationKey,
            memberId: c.memberId,
            leadId: c.leadId,
            link: c.link,
            assigneeStaffId,
            createdByUserId: null,
            priority: c.priority,
            status: 'open',
            dueAt: c.dueAt,
            outcome: null,
            completedAt: null,
            completedByUserId: null,
            createdAt: atMs,
            updatedAt: atMs,
          })
          .onConflictDoNothing()
          .run();
        if (result.changes > 0) {
          created += 1;
          notifyAssignee(c.tenantId, c.branchId, assigneeStaffId, taskId, c.title, null, atMs);
        }
      }
    });
  }
  return { created, considered };
}

function notifyAssignee(
  tenantId: string,
  branchId: string,
  staffId: string | null,
  taskId: string,
  title: string,
  assignedByUserId: string | null,
  atMs: number,
): void {
  if (!staffId) return;
  const userId = db.select({ userId: schema.staff.userId }).from(schema.staff).where(eq(schema.staff.id, staffId)).get()?.userId;
  if (!userId || userId === assignedByUserId) return;
  queueNotification(
    {
      tenantId,
      userId,
      branchId,
      channel: 'in_app',
      purpose: 'operational',
      source: 'task',
      sourceId: taskId,
      dedupeKey: `task:${taskId}:${staffId}`,
      kind: 'task',
      title: 'A task is waiting for you',
      body: title,
      link: `/tasks?task=${taskId}`,
    },
    atMs,
  );
}

/* ——— Reading ——————————————————————————————————————————————— */

function canManage(ctx: RequestContext): boolean {
  return ctx.permissions.includes('task.manage');
}

/** A task in the caller's scope, or 404. */
export function loadTaskInScope(ctx: RequestContext, taskId: string): Task {
  requirePermission(ctx, 'task.view');
  const task = db.select().from(schema.tasks).where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.tenantId, ctx.tenantId))).get();
  if (!task || !branchScope(ctx).includes(task.branchId)) throw notFound('That task');
  if (!canManage(ctx) && task.assigneeStaffId !== ctx.staffId && task.createdByUserId !== ctx.userId) throw notFound('That task');
  return task;
}

function staffNames(ids: Array<string | null>): Map<string, string> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!unique.length) return new Map();
  return new Map(
    db
      .select({ id: schema.staff.id, name: schema.users.name })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(inArray(schema.staff.id, unique))
      .all()
      .map((r) => [r.id, r.name] as const),
  );
}

function view(task: Task, names: Map<string, string>, atMs: number) {
  const open = task.status === 'open' || task.status === 'in_progress';
  return {
    id: task.id,
    branchId: task.branchId,
    title: task.title,
    detail: task.detail,
    source: task.source as TaskSource,
    sourceLabel: SOURCE_LABEL[task.source as TaskSource] ?? task.source,
    memberId: task.memberId,
    leadId: task.leadId,
    link: task.link,
    assignee: task.assigneeStaffId ? { staffId: task.assigneeStaffId, name: names.get(task.assigneeStaffId) ?? 'Staff member' } : null,
    priority: task.priority as TaskPriority,
    status: task.status as TaskStatus,
    dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : null,
    dueRelative: task.dueAt ? relativeTime(task.dueAt, atMs) : null,
    overdue: open && task.dueAt !== null && task.dueAt < atMs,
    outcome: task.outcome,
    completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
    createdAt: new Date(task.createdAt).toISOString(),
  };
}

export function taskDetail(ctx: RequestContext, taskId: string) {
  const task = loadTaskInScope(ctx, taskId);
  return { task: view(task, staffNames([task.assigneeStaffId]), now()) };
}

export type TaskView = 'mine' | 'open' | 'done';

export function listTasks(ctx: RequestContext, viewName: TaskView, source?: TaskSource) {
  requirePermission(ctx, 'task.view');
  const atMs = now();
  const scope = branchScope(ctx);
  const mineOnly = viewName === 'mine' || !canManage(ctx);
  const rows = db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.tenantId, ctx.tenantId),
        inArray(schema.tasks.branchId, scope),
        viewName === 'done' ? inArray(schema.tasks.status, ['done', 'cancelled']) : inArray(schema.tasks.status, ['open', 'in_progress']),
        mineOnly
          ? viewName === 'mine'
            ? eq(schema.tasks.assigneeStaffId, ctx.staffId ?? '')
            : or(eq(schema.tasks.assigneeStaffId, ctx.staffId ?? ''), eq(schema.tasks.createdByUserId, ctx.userId))
          : undefined,
        source ? eq(schema.tasks.source, source) : undefined,
      ),
    )
    .orderBy(viewName === 'done' ? desc(schema.tasks.completedAt) : sql`case ${schema.tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`, schema.tasks.dueAt)
    .limit(300)
    .all();
  const names = staffNames(rows.map((r) => r.assigneeStaffId));
  return { items: rows.map((r) => view(r, names, atMs)), canManage: canManage(ctx) };
}

/** The status strip: my open tasks and the alert-born work waiting in scope. */
export function taskSummary(ctx: RequestContext) {
  requirePermission(ctx, 'task.view');
  const atMs = now();
  const scope = branchScope(ctx);
  const open = inArray(schema.tasks.status, ['open', 'in_progress']);
  const count = (where: ReturnType<typeof and>) =>
    db.select({ n: sql<number>`count(*)` }).from(schema.tasks).where(where).get()?.n ?? 0;
  const base = and(eq(schema.tasks.tenantId, ctx.tenantId), inArray(schema.tasks.branchId, scope), open);
  return {
    mine: count(and(base, eq(schema.tasks.assigneeStaffId, ctx.staffId ?? ''))),
    mineOverdue: count(and(base, eq(schema.tasks.assigneeStaffId, ctx.staffId ?? ''), lt(schema.tasks.dueAt, atMs))),
    /** Generated from an operational alert and not yet done — what the strip calls "to act on". */
    toActOn: canManage(ctx) ? count(and(base, sql`${schema.tasks.source} != 'manual'`)) : 0,
  };
}

/** Staff who can take a task at a branch. */
export function assignableStaff(ctx: RequestContext, branchId: string) {
  requirePermission(ctx, 'task.view');
  if (!branchScope(ctx).includes(branchId)) throw notFound('That branch');
  return {
    items: db
      .select({ staffId: schema.staff.id, name: schema.users.name, role: schema.users.role, branchIds: schema.staff.branchIds })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.staff.tenantId, ctx.tenantId), eq(schema.users.accountState, 'active')))
      .all()
      .filter((s) => s.branchIds.includes(branchId) && !['platform_admin', 'platform_support'].includes(s.role))
      .map((s) => ({ staffId: s.staffId, name: s.name, role: s.role })),
  };
}

function assertAssignable(ctx: RequestContext, branchId: string, staffId: string | null): void {
  if (!staffId) {
    // Unassigning drops a task off everyone's "My tasks": a manager's call.
    if (!canManage(ctx)) throw forbidden('Only a manager can leave a task with nobody.');
    return;
  }
  if (!canManage(ctx) && staffId !== ctx.staffId) throw forbidden('Only a manager can give a task to someone else.');
  const ok = assignableStaff(ctx, branchId).items.some((s) => s.staffId === staffId);
  if (!ok) throw invalid('That person does not work at this branch.');
}

/* ——— Writing ——————————————————————————————————————————————— */

export interface TaskInput {
  branchId: string;
  title: string;
  detail?: string;
  assigneeStaffId?: string | null;
  priority?: TaskPriority;
  dueAt?: string | null;
  memberId?: string | null;
  leadId?: string | null;
  link?: string | null;
}

export function createTask(ctx: RequestContext, input: TaskInput) {
  requirePermission(ctx, 'task.view');
  if (!branchScope(ctx).includes(input.branchId)) throw notFound('That branch');
  const assignee = input.assigneeStaffId === undefined ? ctx.staffId : input.assigneeStaffId;
  assertAssignable(ctx, input.branchId, assignee);
  if (input.memberId) {
    const member = db.select({ branch: schema.members.homeBranchId }).from(schema.members).where(and(eq(schema.members.id, input.memberId), eq(schema.members.tenantId, ctx.tenantId))).get();
    if (!member || !branchScope(ctx).includes(member.branch)) throw notFound('That member');
  }
  if (input.leadId) {
    const lead = db.select({ branch: schema.leads.branchId }).from(schema.leads).where(and(eq(schema.leads.id, input.leadId), eq(schema.leads.tenantId, ctx.tenantId))).get();
    if (!lead || !branchScope(ctx).includes(lead.branch)) throw notFound('That lead');
  }
  const atMs = now();
  const taskId = id('tsk');
  transact(() => {
    db.insert(schema.tasks)
      .values({
        id: taskId,
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        title: input.title.trim(),
        detail: input.detail?.trim() ?? '',
        source: 'manual',
        sourceType: null,
        sourceId: null,
        generationKey: null,
        memberId: input.memberId ?? null,
        leadId: input.leadId ?? null,
        link: input.link ?? (input.memberId ? `/members/${input.memberId}` : input.leadId ? `/leads/${input.leadId}` : null),
        assigneeStaffId: assignee ?? null,
        createdByUserId: ctx.userId,
        priority: input.priority ?? 'normal',
        status: 'open',
        dueAt: input.dueAt ? Date.parse(input.dueAt) : null,
        outcome: null,
        completedAt: null,
        completedByUserId: null,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
    audit(ctx, {
      action: 'task.created',
      entityType: 'task',
      entityId: taskId,
      entityLabel: input.title.trim(),
      branchId: input.branchId,
      after: { assigneeStaffId: assignee ?? null, priority: input.priority ?? 'normal' },
    });
    notifyAssignee(ctx.tenantId, input.branchId, assignee ?? null, taskId, input.title.trim(), ctx.userId, atMs);
  });
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
  return { task: view(task, staffNames([task.assigneeStaffId]), atMs) };
}

export interface TaskPatch {
  title?: string;
  detail?: string;
  assigneeStaffId?: string | null;
  priority?: TaskPriority;
  status?: 'open' | 'in_progress' | 'cancelled';
  dueAt?: string | null;
}

export function updateTask(ctx: RequestContext, taskId: string, patch: TaskPatch) {
  const task = loadTaskInScope(ctx, taskId);
  if (task.status === 'done') throw invalid('A finished task cannot be changed. Create a new one.');
  if (patch.assigneeStaffId !== undefined && patch.assigneeStaffId !== task.assigneeStaffId) {
    assertAssignable(ctx, task.branchId, patch.assigneeStaffId);
  }
  if (patch.status === 'cancelled' && !canManage(ctx) && task.createdByUserId !== ctx.userId) {
    throw forbidden('Only a manager can cancel a task someone else set.');
  }
  const atMs = now();
  const next = {
    title: patch.title?.trim() ?? task.title,
    detail: patch.detail?.trim() ?? task.detail,
    assigneeStaffId: patch.assigneeStaffId === undefined ? task.assigneeStaffId : patch.assigneeStaffId,
    priority: patch.priority ?? task.priority,
    status: patch.status ?? task.status,
    dueAt: patch.dueAt === undefined ? task.dueAt : patch.dueAt ? Date.parse(patch.dueAt) : null,
  };
  transact(() => {
    db.update(schema.tasks).set({ ...next, updatedAt: atMs }).where(eq(schema.tasks.id, task.id)).run();
    audit(ctx, {
      action: 'task.updated',
      entityType: 'task',
      entityId: task.id,
      entityLabel: next.title,
      branchId: task.branchId,
      before: { assigneeStaffId: task.assigneeStaffId, priority: task.priority, status: task.status, dueAt: task.dueAt },
      after: { assigneeStaffId: next.assigneeStaffId, priority: next.priority, status: next.status, dueAt: next.dueAt },
    });
    if (next.assigneeStaffId !== task.assigneeStaffId) {
      notifyAssignee(ctx.tenantId, task.branchId, next.assigneeStaffId, task.id, next.title, ctx.userId, atMs);
    }
  });
  const updated = db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get()!;
  return { task: view(updated, staffNames([updated.assigneeStaffId]), atMs) };
}

/** Done means done *with an outcome*: what happened is the point of the task. */
export function completeTask(ctx: RequestContext, taskId: string, outcome: string) {
  const task = loadTaskInScope(ctx, taskId);
  if (task.status === 'done') throw invalid('That task is already done.');
  if (task.status === 'cancelled') throw invalid('That task was cancelled.');
  const text = outcome.trim();
  if (text.length < 3) throw invalid('Say what happened, so the next person knows.');
  const atMs = now();
  transact(() => {
    db.update(schema.tasks)
      .set({ status: 'done', outcome: text, completedAt: atMs, completedByUserId: ctx.userId, updatedAt: atMs })
      .where(eq(schema.tasks.id, task.id))
      .run();
    audit(ctx, {
      action: 'task.completed',
      entityType: 'task',
      entityId: task.id,
      entityLabel: task.title,
      branchId: task.branchId,
      before: { status: task.status },
      after: { status: 'done', outcome: text },
    });
  });
  const done = db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get()!;
  return { task: view(done, staffNames([done.assigneeStaffId]), atMs) };
}
