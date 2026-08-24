import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { BranchState } from '@shark/contracts';
import {
  TRIGGERS,
  TENANT_STATUSES,
  branchTrades,
  dedupeKey,
  decideSend,
  estimateCostMinor,
  inQuietHours,
  isMetered,
  matches,
  renderTemplate,
  templateVariables,
  triggerSpec,
  validateConditions,
  type Condition,
  type SendFacts,
  type TenantStatus,
} from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { branchPolicy } from '../lib/policy.js';
import {
  DAY,
  HOUR,
  MINUTE,
  addDays,
  daysBetween,
  isoDate,
  localClockOnDay,
  localMinutes,
  nextLocalDayRange,
  now,
} from '../lib/time.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';

/**
 * Automations — event-triggered messaging (PF-COMM-003…006).
 *
 * Four decisions shape the module.
 *
 * **Planning and sending are separate functions, and a dry run only has the
 * first.** `planRun` decides what would happen to whom; `commitRun` is the only
 * thing that writes a notification. A dry run never receives a reference to
 * `commitRun`, so "dry run" is not a flag somebody could forget to check — it
 * is the absence of the capability. That is what the PRD's "structurally
 * incapable of sending" has to mean to be worth anything.
 *
 * **Every decision is recorded, especially the ones not to send.** "Why did my
 * member not get the renewal reminder" is the question this module gets asked,
 * and an execution log holding only successes cannot answer it. Suppressions
 * carry the reason in the operator's words.
 *
 * **A duplicate send is refused by the database, not by remembering to check.**
 * `automation_runs` has a partial unique index on `(automation_id, event_key)
 * WHERE outcome = 'sent'`. A race between two scheduler ticks loses at the
 * insert rather than producing two messages.
 *
 * **Quiet hours are the branch's** (PF-TEN-003). A chain with a gym in Dubai
 * and a gym in Bengaluru does not have one evening, and the settings screen
 * lets each branch hold its own window.
 */

/* ——— Shapes ————————————————————————————————————————————— */

export interface AudienceSubject {
  memberId: string;
  userId: string | null;
  branchId: string;
  branchName: string;
  branchState: BranchState;
  branchTimezone: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Variables this trigger offers for this subject. */
  variables: Record<string, string | number | null>;
  /** Fields the conditions may test. */
  facts: Record<string, unknown>;
  /** Distinguishes two classes on the same day for a per-occurrence trigger. */
  occurrenceId?: string;
}

export interface PlannedAction {
  subject: AudienceSubject;
  channel: string;
  templateCode: string | null;
  templateVersion: number | null;
  delayMin: number;
  eventKey: string;
  decision: ReturnType<typeof decideSend>;
  /** The message as the member would read it. Empty when it could not render. */
  preview: string;
}

/* ——— Consent ————————————————————————————————————————————— */

/** Which recorded consent a channel needs. In-app and push are the product
 *  itself rather than marketing, and are covered by the terms. */
const CONSENT_PURPOSE: Record<string, string | null> = {
  sms: 'marketing_sms',
  whatsapp: 'marketing_whatsapp',
  email: 'marketing_email',
  in_app: null,
  push: null,
};

function hasConsent(tenantId: string, userId: string | null, channel: string): boolean {
  const purpose = CONSENT_PURPOSE[channel];
  if (purpose === null || purpose === undefined) return true;
  if (!userId) return false;
  const row = db
    .select({ granted: schema.consents.granted })
    .from(schema.consents)
    .where(and(eq(schema.consents.tenantId, tenantId), eq(schema.consents.userId, userId), eq(schema.consents.purpose, purpose)))
    .get();
  // Absence is refusal. A gym that never asked has not been told yes.
  return row?.granted === true;
}

function hasActiveAccount(tenantId: string, userId: string | null): boolean {
  if (!userId) return false;
  return db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(
      eq(schema.users.id, userId),
      eq(schema.users.tenantId, tenantId),
      eq(schema.users.accountState, 'active'),
      isNull(schema.users.deletedAt),
    ))
    .get() !== undefined;
}

/* ——— Quota ————————————————————————————————————————————— */

function quotaRemaining(tenantId: string, channel: string): number | null {
  if (!isMetered(channel)) return null;
  const meter = channel === 'sms' ? 'sms' : channel;
  const row = db
    .select()
    .from(schema.usageMeters)
    .where(and(
      eq(schema.usageMeters.tenantId, tenantId),
      eq(schema.usageMeters.meter, meter),
      eq(schema.usageMeters.period, isoDate(now(), 'UTC').slice(0, 7)),
    ))
    .get();
  if (!row || row.limitValue <= 0) return null;
  return Math.max(0, row.limitValue - row.used);
}

/* ——— Audience ————————————————————————————————————————— */

const branchesOf = (tenantId: string, branchIds?: string[]) =>
  new Map(
    db
      .select()
      .from(schema.branches)
      .where(
        branchIds && branchIds.length > 0
          ? and(eq(schema.branches.tenantId, tenantId), inArray(schema.branches.id, branchIds))
          : eq(schema.branches.tenantId, tenantId),
      )
      .all()
      .map((b) => [b.id, b]),
  );

/**
 * Who this trigger is about, right now.
 *
 * Each arm is a plain query rather than a generic rule engine. Five triggers
 * with five readable queries is a thing somebody can debug at 06:00; one
 * query builder covering all five is not, and the abstraction would have to be
 * rewritten for the sixth anyway.
 */
export function audienceFor(tenantId: string, trigger: string, atMs: number, scopedBranchIds?: string[]): AudienceSubject[] {
  if (scopedBranchIds?.length === 0) return [];
  const branches = branchesOf(tenantId, scopedBranchIds);
  const tenant = db.select({ displayName: schema.tenants.displayName }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  const gymName = tenant?.displayName ?? '';

  const base = (member: typeof schema.members.$inferSelect, branchId = member.homeBranchId): AudienceSubject | null => {
    const branch = branches.get(branchId);
    if (!branch) return null;
    return {
      memberId: member.id,
      userId: member.userId,
      branchId: branch.id,
      branchName: branch.name,
      branchState: branch.state as BranchState,
      branchTimezone: branch.timezone,
      name: `${member.firstName} ${member.lastName}`,
      email: member.email,
      phone: member.phone,
      variables: {
        firstName: member.firstName,
        lastName: member.lastName,
        memberNo: member.memberNo,
        branchName: branch.name,
        gymName,
      },
      facts: { branchId: branch.id },
    };
  };

  const liveMembers = () =>
    db
      .select()
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId), isNull(schema.members.deletedAt), isNull(schema.members.mergedIntoId)))
      .all();

  if (trigger === 'membership.expiring') {
    const out: AudienceSubject[] = [];
    const rows = db
      .select({ member: schema.members, membership: schema.memberships })
      .from(schema.memberships)
      .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
      .where(and(
        eq(schema.memberships.tenantId, tenantId),
        eq(schema.members.tenantId, tenantId),
        eq(schema.memberships.state, 'active'),
        sql`${schema.memberships.endsOn} is not null`,
        isNull(schema.members.deletedAt),
        isNull(schema.members.mergedIntoId),
      ))
      .all();
    for (const row of rows) {
      const subject = base(row.member);
      if (!subject || !row.membership.endsOn) continue;
      const daysLeft = daysBetween(isoDate(atMs, subject.branchTimezone), row.membership.endsOn);
      if (daysLeft < 0) continue;
      subject.variables = { ...subject.variables, endsOn: row.membership.endsOn, daysLeft, productName: row.membership.productName };
      subject.facts = { ...subject.facts, daysLeft, productName: row.membership.productName, autoRenew: row.membership.autoRenew };
      out.push(subject);
    }
    return out;
  }

  if (trigger === 'membership.payment_failed') {
    const out: AudienceSubject[] = [];
    const rows = db
      .select({ member: schema.members, invoice: schema.invoices, payment: schema.payments })
      .from(schema.payments)
      .innerJoin(schema.invoices, eq(schema.invoices.id, schema.payments.invoiceId))
      .innerJoin(schema.members, eq(schema.members.id, schema.payments.memberId))
      .where(and(
        eq(schema.payments.tenantId, tenantId),
        eq(schema.invoices.tenantId, tenantId),
        eq(schema.members.tenantId, tenantId),
        eq(schema.payments.state, 'failed'),
        eq(schema.invoices.voided, false),
        sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
        sql`${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`,
        isNull(schema.members.deletedAt),
        isNull(schema.members.mergedIntoId),
      ))
      .all();
    for (const row of rows) {
      const subject = base(row.member, row.payment.branchId ?? row.invoice.branchId);
      if (!subject) continue;
      const amountDue = row.payment.amountMinor;
      subject.occurrenceId = row.payment.id;
      subject.variables = { ...subject.variables, amountDue: (amountDue / 100).toFixed(2), invoiceNumber: row.invoice.number, graceEndsOn: row.invoice.dueOn };
      subject.facts = { ...subject.facts, amountDue };
      out.push(subject);
    }
    return out;
  }

  if (trigger === 'member.joined') {
    return liveMembers()
      .map((member) => {
        const subject = base(member);
        if (!subject) return null;
        if (member.joinedOn !== isoDate(atMs, subject.branchTimezone)) return null;
        subject.variables = { ...subject.variables, joinedOn: member.joinedOn, productName: null };
        subject.facts = { ...subject.facts, productName: null };
        return subject;
      })
      .filter((s): s is AudienceSubject => s !== null);
  }

  if (trigger === 'member.inactive') {
    return liveMembers()
      .map((member) => {
        const subject = base(member);
        if (!subject) return null;
        const daysSinceVisit = member.lastVisitAt === null
          ? null
          : daysBetween(isoDate(member.lastVisitAt, subject.branchTimezone), isoDate(atMs, subject.branchTimezone));
        subject.variables = {
          ...subject.variables,
          daysSinceVisit,
          lastVisitOn: member.lastVisitAt ? isoDate(member.lastVisitAt, subject.branchTimezone) : null,
        };
        subject.facts = { ...subject.facts, daysSinceVisit };
        return subject;
      })
      .filter((s): s is AudienceSubject => s !== null);
  }

  if (trigger === 'class.tomorrow') {
    const out: AudienceSubject[] = [];
    for (const branch of branches.values()) {
      const { from, to } = nextLocalDayRange(atMs, branch.timezone);
      const rows = db
        .select({
          member: schema.members,
          sessionId: schema.classSessions.id,
          branchId: schema.classSessions.branchId,
          startsAt: schema.classSessions.startsAt,
          className: schema.classTypes.name,
        })
        .from(schema.bookings)
        .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
        .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
        .innerJoin(schema.members, eq(schema.members.id, schema.bookings.memberId))
        .where(and(
          eq(schema.classSessions.tenantId, tenantId),
          eq(schema.classTypes.tenantId, tenantId),
          eq(schema.bookings.tenantId, tenantId),
          eq(schema.members.tenantId, tenantId),
          eq(schema.classSessions.branchId, branch.id),
          eq(schema.classSessions.state, 'scheduled'),
          gte(schema.classSessions.startsAt, from),
          lt(schema.classSessions.startsAt, to),
          sql`(
            ${schema.bookings.state} = 'confirmed'
            or (${schema.bookings.state} = 'held' and ${schema.bookings.heldUntil} > ${atMs})
          )`,
          isNull(schema.members.deletedAt),
          isNull(schema.members.mergedIntoId),
        ))
        .all();
      for (const row of rows) {
        const subject = base(row.member, row.branchId);
        if (!subject) continue;
        subject.occurrenceId = row.sessionId;
        subject.variables = {
          ...subject.variables,
          className: row.className,
          startsAt: new Date(row.startsAt).toISOString(),
          trainerName: null,
          roomName: null,
        };
        subject.facts = { ...subject.facts, className: row.className, branchId: row.branchId };
        out.push(subject);
      }
    }
    return out;
  }

  return [];
}

/* ——— Planning ————————————————————————————————————————— */

type AutomationRow = typeof schema.automations.$inferSelect;

type AutomationAction = AutomationRow['actions'][number];

function tenantBranchIds(tenantId: string): string[] {
  return db
    .select({ id: schema.branches.id })
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, tenantId))
    .all()
    .map((row) => row.id);
}

function storedScope(automation: AutomationRow): string[] {
  return automation.branchIds ?? tenantBranchIds(automation.tenantId);
}

function automationScope(ctx: RequestContext, automation: AutomationRow): string[] {
  const stored = storedScope(automation);
  if (!stored.every((branchId) => ctx.branchIds.includes(branchId))) throw notFound('That automation');
  const requestScope = new Set(branchScope(ctx));
  if (!stored.some((branchId) => requestScope.has(branchId))) throw notFound('That automation');
  // A selected branch filters which rule entities are visible; it must not
  // shrink the rule itself. Preview/manual run and the scheduler therefore use
  // the same durable scope.
  return stored;
}

function automationInTenant(ctx: RequestContext, automationId: string): AutomationRow {
  const row = db
    .select()
    .from(schema.automations)
    .where(and(eq(schema.automations.id, automationId), eq(schema.automations.tenantId, ctx.tenantId)))
    .get();
  if (!row) throw notFound('That automation');
  automationScope(ctx, row);
  return row;
}

function templateFor(
  tenantId: string,
  code: string | null,
  templateId?: string | null,
  templateVersion?: number | null,
) {
  if (!code) return null;
  const conditions = [eq(schema.messageTemplates.tenantId, tenantId), eq(schema.messageTemplates.code, code)];
  if (templateId) conditions.push(eq(schema.messageTemplates.id, templateId));
  if (templateVersion !== null && templateVersion !== undefined) {
    conditions.push(eq(schema.messageTemplates.version, templateVersion));
  }
  return db
    .select()
    .from(schema.messageTemplates)
    .where(and(...conditions))
    .orderBy(desc(schema.messageTemplates.version))
    .get() ?? null;
}

/**
 * What would happen, to whom, and why.
 *
 * Pure with respect to the outbound world: this reads, decides and returns.
 * It writes nothing and has no way to. Everything that could send lives in
 * `commitRun`, which a dry run never calls.
 */
export function planRun(ctx: RequestContext, automation: AutomationRow, atMs: number): PlannedAction[] {
  const spec = triggerSpec(automation.trigger);
  if (!spec) throw invalid(`${automation.trigger} is not a trigger this product knows.`);

  const action = automation.actions[0];
  if (!action) return [];

  const template = templateFor(ctx.tenantId, action.templateCode, action.templateId, action.templateVersion);
  const channel = action.kind;
  const remaining = quotaRemaining(ctx.tenantId, channel);
  let budget = remaining;

  const audience = audienceFor(ctx.tenantId, automation.trigger, atMs, automationScope(ctx, automation)).filter((subject) =>
    matches(automation.conditions as Condition[], subject.facts),
  );

  return audience.map((subject) => {
    const day = isoDate(atMs, subject.branchTimezone);
    const eventKey = dedupeKey(automation.trigger, subject.memberId, { day, occurrenceId: subject.occurrenceId });

    const rendered = template
      ? renderTemplate(template.body, subject.variables, spec.variables)
      : { text: '', missing: ['template'], unknown: [] };

    const alreadySent = db
      .select({ id: schema.automationDeliveries.id })
      .from(schema.automationDeliveries)
      .where(and(
        eq(schema.automationDeliveries.automationId, automation.id),
        eq(schema.automationDeliveries.eventKey, eventKey),
      ))
      .get() !== undefined || db
      .select({ id: schema.automationRuns.id })
      .from(schema.automationRuns)
      .where(and(
        eq(schema.automationRuns.automationId, automation.id),
        eq(schema.automationRuns.eventKey, eventKey),
        eq(schema.automationRuns.outcome, 'sent'),
      ))
      .get() !== undefined;

    // The branch's own window, in the branch's own clock (PF-TEN-003).
    const quiet = automation.quietHours ?? {
      from: String(branchPolicy(ctx.tenantId, subject.branchId, 'quietHoursFrom', '21:00').value),
      to: String(branchPolicy(ctx.tenantId, subject.branchId, 'quietHoursTo', '08:00').value),
    };

    const facts: SendFacts = {
      automationState: automation.state,
      channel,
      hasConsent: hasConsent(ctx.tenantId, subject.userId, channel),
      hasDestination: channel === 'sms' || channel === 'whatsapp' ? Boolean(subject.phone) : channel === 'email' ? Boolean(subject.email) : Boolean(subject.userId),
      accountActive: hasActiveAccount(ctx.tenantId, subject.userId),
      providerAvailable: channel === 'in_app',
      branchTrades: branchTrades(subject.branchState),
      inQuietHours: inQuietHours(quiet.from, quiet.to, localMinutes(atMs, subject.branchTimezone)),
      alreadySent,
      quotaRemaining: budget,
      missingVariables: rendered.missing,
      unknownVariables: rendered.unknown,
    };

    const decision = decideSend(facts);
    // A plan that ignores its own budget promises more than it can deliver.
    if (decision.send && budget !== null) budget -= 1;

    return {
      subject,
      channel,
      templateCode: action.templateCode,
      templateVersion: template?.version ?? action.templateVersion ?? null,
      delayMin: action.delayMin,
      eventKey,
      decision,
      preview: rendered.text,
    };
  });
}

/* ——— Committing ————————————————————————————————————————— */

/**
 * The only function in this module that sends anything.
 *
 * Refuses outright for an automation in dry run or not active. That is
 * belt-and-braces over the caller — `runAutomation` does not reach here for a
 * dry run — but a second reader of this file should not have to trace the
 * caller to know whether this can fire.
 */
type ExecutionOutcome = 'sent' | 'queued' | 'suppressed' | 'failed';

interface ExecutionResult {
  planned: PlannedAction;
  outcome: ExecutionOutcome;
  reason: string;
}

const MAX_DELIVERY_ATTEMPTS = 3;
const STALE_DELIVERY_LOCK_MS = 5 * MINUTE;

function clockMinutes(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function quietHoursEndAt(
  atMs: number,
  timeZone: string,
  quiet: { from: string; to: string },
): number {
  const start = clockMinutes(quiet.from);
  const end = clockMinutes(quiet.to);
  const current = localMinutes(atMs, timeZone);
  let targetDay = isoDate(atMs, timeZone);
  if (start > end && current >= start) targetDay = addDays(targetDay, 1);

  const candidate = localClockOnDay(targetDay, quiet.to, timeZone);
  if (candidate > atMs) return candidate;

  // During an autumn clock fold, the first occurrence of the quiet-hours end
  // can precede `atMs` while the repeated local minute is quiet again. Find the
  // next real minute outside the window rather than waiting a fixed 24 hours.
  const firstProbe = Math.ceil((atMs + 1) / MINUTE) * MINUTE;
  for (let probe = firstProbe; probe <= atMs + 26 * HOUR; probe += MINUTE) {
    if (!inQuietHours(quiet.from, quiet.to, localMinutes(probe, timeZone))) return probe;
  }
  throw new RangeError(`Could not resolve the end of quiet hours in ${timeZone}.`);
}

function commitRun(
  ctx: RequestContext,
  automation: AutomationRow,
  plan: PlannedAction[],
  atMs: number,
  source: 'manual' | 'scheduler',
): ExecutionResult[] {
  if (automation.dryRun) throw precondition('This automation is in dry run and cannot send.');
  if (automation.state !== 'active') throw precondition('This automation is not running.');

  const results: ExecutionResult[] = [];
  for (const planned of plan) {
    const runId = id('aur');
    const heldForQuietHours = planned.decision.code === 'quiet_hours';
    if (!planned.decision.send && !heldForQuietHours) {
      db.insert(schema.automationRuns)
        .values(runRow(ctx, automation, planned, 'suppressed', planned.decision.reason, null, null, atMs, runId))
        .run();
      results.push({ planned, outcome: 'suppressed', reason: planned.decision.reason });
      continue;
    }

    const deliveryId = id('adl');
    const quiet = automation.quietHours ?? {
      from: String(branchPolicy(ctx.tenantId, planned.subject.branchId, 'quietHoursFrom', '21:00').value),
      to: String(branchPolicy(ctx.tenantId, planned.subject.branchId, 'quietHoursTo', '08:00').value),
    };
    const delayedUntil = atMs + planned.delayMin * MINUTE;
    const dueAt = heldForQuietHours
      ? Math.max(delayedUntil, quietHoursEndAt(atMs, planned.subject.branchTimezone, quiet))
      : delayedUntil;
    const queuedReason = heldForQuietHours
      ? 'Held durably until quiet hours end at this branch.'
      : planned.delayMin > 0
        ? `Queued for ${planned.delayMin} minutes.`
        : 'Queued for delivery.';
    try {
      transact(() => {
        // The durable delivery row reserves the event while it is queued. If
        // two scheduler/manual runs overlap, this insert is the authority and
        // only one of them can own the logical event.
        db.insert(schema.automationDeliveries)
          .values({
            id: deliveryId,
            tenantId: ctx.tenantId,
            automationId: automation.id,
            branchId: planned.subject.branchId,
            memberId: planned.subject.memberId,
            userId: planned.subject.userId!,
            eventKey: planned.eventKey,
            channel: planned.channel,
            templateCode: planned.templateCode,
            templateVersion: planned.templateVersion,
            title: automation.name,
            body: planned.preview,
            dueAt,
            state: 'queued',
            attempts: 0,
            lastAttemptAt: null,
            lockedAt: null,
            lastError: null,
            notificationId: null,
            source,
            actorUserId: source === 'manual' ? ctx.userId : null,
            createdAt: atMs,
            updatedAt: atMs,
          })
          .run();
        db.insert(schema.automationRuns)
          .values(runRow(
            ctx,
            automation,
            planned,
            'queued',
            queuedReason,
            deliveryId,
            null,
            atMs,
            runId,
          ))
          .run();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const duplicate = message.includes('UNIQUE constraint failed');
      db.insert(schema.automationRuns)
        .values(runRow(
          ctx, automation, planned,
          duplicate ? 'suppressed' : 'failed',
          duplicate ? 'Already queued or sent for this event.' : message.slice(0, 200),
          null, null, atMs, id('aur'),
        ))
        .run();
      results.push({
        planned,
        outcome: duplicate ? 'suppressed' : 'failed',
        reason: duplicate ? 'Already queued or sent for this event.' : message.slice(0, 200),
      });
      continue;
    }

    if (dueAt > atMs) {
      results.push({ planned, outcome: 'queued', reason: queuedReason });
    } else {
      const processed = processDelivery(deliveryId, atMs);
      results.push({ planned, outcome: processed.outcome, reason: processed.reason });
    }
  }
  return results;
}

function runRow(
  ctx: RequestContext,
  automation: AutomationRow,
  planned: PlannedAction,
  outcome: string,
  reason: string,
  deliveryId: string | null,
  notificationId: string | null,
  atMs: number,
  runId: string,
) {
  return {
    id: runId,
    tenantId: ctx.tenantId,
    automationId: automation.id,
    branchId: planned.subject.branchId,
    memberId: planned.subject.memberId,
    userId: planned.subject.userId,
    trigger: automation.trigger,
    eventKey: planned.eventKey,
    outcome,
    reason,
    channel: planned.channel,
    templateCode: planned.templateCode,
    deliveryId,
    notificationId,
    at: atMs,
  };
}

type DeliveryDisposition =
  | { kind: 'hold'; dueAt: number; reason: string }
  | { kind: 'suppress'; reason: string }
  | null;

function deliveryDisposition(
  delivery: typeof schema.automationDeliveries.$inferSelect,
  atMs: number,
): DeliveryDisposition {
  const tenant = db
    .select({ status: schema.tenants.status })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, delivery.tenantId))
    .get();
  if (!tenant || !TENANT_STATUSES[tenant.status as TenantStatus]?.operational) {
    return { kind: 'suppress', reason: 'The gym is suspended or archived. Nothing was sent.' };
  }

  const automation = db
    .select()
    .from(schema.automations)
    .where(and(
      eq(schema.automations.id, delivery.automationId),
      eq(schema.automations.tenantId, delivery.tenantId),
    ))
    .get();
  if (!automation || automation.state !== 'active' || automation.dryRun) {
    return { kind: 'suppress', reason: 'The automation was paused or returned to rehearsal before delivery.' };
  }
  if (!storedScope(automation).includes(delivery.branchId)) {
    return { kind: 'suppress', reason: 'The branch is no longer in this automation’s scope.' };
  }

  const branch = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.id, delivery.branchId), eq(schema.branches.tenantId, delivery.tenantId)))
    .get();
  if (!branch || !branchTrades(branch.state as BranchState)) {
    return { kind: 'suppress', reason: 'Their branch is closed or archived.' };
  }
  const member = db
    .select({ userId: schema.members.userId, lastVisitAt: schema.members.lastVisitAt })
    .from(schema.members)
    .where(and(
      eq(schema.members.id, delivery.memberId),
      eq(schema.members.tenantId, delivery.tenantId),
      isNull(schema.members.deletedAt),
      isNull(schema.members.mergedIntoId),
    ))
    .get();
  if (!member || member.userId !== delivery.userId) {
    return { kind: 'suppress', reason: 'The member record is no longer active or belongs to a different account.' };
  }
  if (!hasConsent(delivery.tenantId, delivery.userId, delivery.channel)) {
    return { kind: 'suppress', reason: `This member withdrew consent for ${delivery.channel} messages before delivery.` };
  }
  if (!hasActiveAccount(delivery.tenantId, delivery.userId)) {
    return { kind: 'suppress', reason: 'The member account is no longer active.' };
  }
  if (delivery.channel !== 'in_app') {
    return { kind: 'suppress', reason: `No ${delivery.channel} delivery provider is configured. Nothing was sent.` };
  }

  // A delayed message is still about the event that existed when it was
  // queued. Rebuild that event at its original evaluation time so a cancelled
  // class, recovered payment, renewed membership, changed condition, or
  // otherwise stale message cannot slip through merely because its row exists.
  const subject = audienceFor(delivery.tenantId, automation.trigger, delivery.createdAt, [delivery.branchId])
    .filter((candidate) => matches(automation.conditions as Condition[], candidate.facts))
    .find((candidate) => {
      if (candidate.memberId !== delivery.memberId || candidate.userId !== delivery.userId) return false;
      const eventKey = dedupeKey(automation.trigger, candidate.memberId, {
        day: isoDate(delivery.createdAt, candidate.branchTimezone),
        occurrenceId: candidate.occurrenceId,
      });
      return eventKey === delivery.eventKey;
    });
  if (!subject) {
    return { kind: 'suppress', reason: 'The triggering record changed, so this queued message no longer applies.' };
  }

  if (automation.trigger === 'member.inactive' && member.lastVisitAt !== null && member.lastVisitAt > delivery.createdAt) {
    return { kind: 'suppress', reason: 'The member visited after this inactivity message was queued, so it no longer applies.' };
  }
  if (automation.trigger === 'membership.expiring') {
    const endsOn = subject.variables.endsOn;
    if (typeof endsOn !== 'string' || daysBetween(isoDate(atMs, subject.branchTimezone), endsOn) < 0) {
      return { kind: 'suppress', reason: 'The membership is no longer awaiting expiry, so this queued message no longer applies.' };
    }
  }
  if (automation.trigger === 'class.tomorrow') {
    const booking = subject.occurrenceId
      ? db
        .select({
          bookingState: schema.bookings.state,
          heldUntil: schema.bookings.heldUntil,
          sessionState: schema.classSessions.state,
          startsAt: schema.classSessions.startsAt,
        })
        .from(schema.bookings)
        .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
        .where(and(
          eq(schema.bookings.tenantId, delivery.tenantId),
          eq(schema.bookings.memberId, delivery.memberId),
          eq(schema.bookings.sessionId, subject.occurrenceId),
          eq(schema.classSessions.tenantId, delivery.tenantId),
          eq(schema.classSessions.branchId, delivery.branchId),
        ))
        .get()
      : undefined;
    const bookingStillValid = booking?.bookingState === 'confirmed' ||
      (booking?.bookingState === 'held' && booking.heldUntil !== null && booking.heldUntil > atMs);
    if (!booking || booking.sessionState !== 'scheduled' || booking.startsAt <= atMs || !bookingStillValid) {
      return { kind: 'suppress', reason: 'The class booking no longer applies, so this queued reminder was not sent.' };
    }
  }

  const spec = triggerSpec(automation.trigger);
  const template = templateFor(delivery.tenantId, delivery.templateCode, null, delivery.templateVersion);
  if (!spec || !template) {
    return { kind: 'suppress', reason: 'The pinned message template is no longer available.' };
  }
  const rendered = renderTemplate(template.body, subject.variables, spec.variables);
  if (rendered.missing.length > 0 || rendered.unknown.length > 0 || rendered.text !== delivery.body) {
    return { kind: 'suppress', reason: 'The triggering record changed, so the queued message copy is no longer current.' };
  }

  const automationQuiet = automation.quietHours ?? {
    from: String(branchPolicy(delivery.tenantId, delivery.branchId, 'quietHoursFrom', '21:00').value),
    to: String(branchPolicy(delivery.tenantId, delivery.branchId, 'quietHoursTo', '08:00').value),
  };
  if (inQuietHours(automationQuiet.from, automationQuiet.to, localMinutes(atMs, branch.timezone))) {
    return {
      kind: 'hold',
      dueAt: quietHoursEndAt(atMs, branch.timezone, automationQuiet),
      reason: 'Held durably until quiet hours end at this branch.',
    };
  }
  return null;
}

function finishDelivery(
  deliveryId: string,
  outcome: 'sent' | 'suppressed' | 'failed',
  reason: string,
  atMs: number,
  notificationId: string | null,
): void {
  db.update(schema.automationDeliveries)
    .set({
      state: outcome,
      lockedAt: null,
      lastError: reason || null,
      notificationId,
      updatedAt: atMs,
    })
    .where(eq(schema.automationDeliveries.id, deliveryId))
    .run();
  db.update(schema.automationRuns)
    .set({ outcome, reason, notificationId })
    .where(eq(schema.automationRuns.deliveryId, deliveryId))
    .run();
}

function processDelivery(deliveryId: string, atMs: number): { outcome: ExecutionOutcome; reason: string } {
  const claimed = db.update(schema.automationDeliveries)
    .set({
      state: 'processing',
      attempts: sql`${schema.automationDeliveries.attempts} + 1`,
      lastAttemptAt: atMs,
      lockedAt: atMs,
      updatedAt: atMs,
    })
    .where(and(
      eq(schema.automationDeliveries.id, deliveryId),
      eq(schema.automationDeliveries.state, 'queued'),
      lte(schema.automationDeliveries.dueAt, atMs),
    ))
    .run();
  if (claimed.changes === 0) return { outcome: 'queued', reason: 'Already claimed or not due yet.' };

  let delivery: typeof schema.automationDeliveries.$inferSelect | undefined;
  try {
    delivery = db
      .select()
      .from(schema.automationDeliveries)
      .where(eq(schema.automationDeliveries.id, deliveryId))
      .get();
    if (!delivery) throw new Error('The claimed delivery disappeared.');

    const disposition = deliveryDisposition(delivery, atMs);
    if (disposition?.kind === 'hold') {
      transact(() => {
        db.update(schema.automationDeliveries)
          .set({
            state: 'queued',
            attempts: sql`max(${schema.automationDeliveries.attempts} - 1, 0)`,
            dueAt: disposition.dueAt,
            lockedAt: null,
            lastError: disposition.reason,
            updatedAt: atMs,
          })
          .where(eq(schema.automationDeliveries.id, deliveryId))
          .run();
        db.update(schema.automationRuns)
          .set({ outcome: 'queued', reason: disposition.reason })
          .where(eq(schema.automationRuns.deliveryId, deliveryId))
          .run();
      });
      return { outcome: 'queued', reason: disposition.reason };
    }
    if (disposition?.kind === 'suppress') {
      transact(() => finishDelivery(deliveryId, 'suppressed', disposition.reason, atMs, null));
      return { outcome: 'suppressed', reason: disposition.reason };
    }

    const notificationId = id('ntf');
    const current = delivery;
    transact(() => {
      db.insert(schema.notifications)
        .values({
          id: notificationId,
          tenantId: current.tenantId,
          userId: current.userId,
          channel: 'in_app',
          kind: 'automation',
          title: current.title,
          body: current.body,
          link: null,
          templateCode: current.templateCode,
          state: 'sent',
          attempts: current.attempts,
          lastError: null,
          createdAt: atMs,
          readAt: null,
        })
        .run();
      finishDelivery(deliveryId, 'sent', '', atMs, notificationId);
    });
    return { outcome: 'sent', reason: '' };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    const attempts = delivery?.attempts ?? db
      .select({ attempts: schema.automationDeliveries.attempts })
      .from(schema.automationDeliveries)
      .where(eq(schema.automationDeliveries.id, deliveryId))
      .get()?.attempts ?? MAX_DELIVERY_ATTEMPTS;
    const retry = attempts < MAX_DELIVERY_ATTEMPTS;
    const reason = retry
      ? `${message} Retry ${attempts + 1} of ${MAX_DELIVERY_ATTEMPTS} is queued.`
      : `${message} Delivery stopped after ${MAX_DELIVERY_ATTEMPTS} attempts.`;
    transact(() => {
      db.update(schema.automationDeliveries)
        .set({
          state: retry ? 'queued' : 'failed',
          dueAt: retry ? atMs + attempts * HOUR : (delivery?.dueAt ?? atMs),
          lockedAt: null,
          lastError: reason,
          updatedAt: atMs,
        })
        .where(eq(schema.automationDeliveries.id, deliveryId))
        .run();
      db.update(schema.automationRuns)
        .set({ outcome: 'failed', reason })
        .where(eq(schema.automationRuns.deliveryId, deliveryId))
        .run();
    });
    return { outcome: 'failed', reason };
  }
}

/** Processes due work through the one existing scheduler. Safe to call after a
 * restart: stale claims are released, while the event-level unique key keeps
 * overlapping ticks from creating a second delivery. */
export function processDueDeliveries(atMs = now(), limit = 100): { processed: number; sent: number; failed: number } {
  db.update(schema.automationDeliveries)
    .set({ state: 'queued', lockedAt: null, dueAt: atMs, updatedAt: atMs })
    .where(and(
      eq(schema.automationDeliveries.state, 'processing'),
      lte(schema.automationDeliveries.lockedAt, atMs - STALE_DELIVERY_LOCK_MS),
    ))
    .run();

  const due = db
    .select({ id: schema.automationDeliveries.id })
    .from(schema.automationDeliveries)
    .where(and(eq(schema.automationDeliveries.state, 'queued'), lte(schema.automationDeliveries.dueAt, atMs)))
    .orderBy(schema.automationDeliveries.dueAt)
    .limit(limit)
    .all();
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const result = processDelivery(row.id, atMs);
    if (result.outcome === 'sent') sent += 1;
    if (result.outcome === 'failed') failed += 1;
  }
  return { processed: due.length, sent, failed };
}

/* ——— Running ————————————————————————————————————————— */

export interface RunSummary {
  automationId: string;
  dryRun: boolean;
  considered: number;
  /** Decisions that pass every current rule in a preview/rehearsal. */
  wouldSend: number;
  sent: number;
  queued: number;
  suppressed: number;
  failed: number;
  /** Why the suppressed ones were suppressed, counted. */
  bySuppression: Array<{ code: string; reason: string; count: number }>;
  estimatedCostMinor: number;
}

/**
 * Runs an automation.
 *
 * A dry run never touches `commitRun`. It records what it *would* have done
 * so the log shows a rehearsal alongside the real thing, and consumes no
 * dedupe key — so turning the automation on afterwards still sends.
 */
export function runAutomation(ctx: RequestContext, automationId: string, atMs = now()): RunSummary {
  requirePermission(ctx, 'automation.manage');
  const automation = automationInTenant(ctx, automationId);
  const plan = planRun(ctx, automation, atMs);
  const dryRun = automation.dryRun || automation.state !== 'active';

  let results: ExecutionResult[] = [];
  if (dryRun) {
    for (const planned of plan) {
      db.insert(schema.automationRuns)
        .values(runRow(
          ctx, automation, planned, 'dry_run',
          planned.decision.send ? 'Would have sent.' : planned.decision.reason,
          null, null, atMs, id('aur'),
        ))
        .run();
    }
  } else {
    results = commitRun(ctx, automation, plan, atMs, 'manual');
  }

  db.update(schema.automations)
    .set({ lastRunAt: atMs, updatedAt: atMs })
    .where(eq(schema.automations.id, automation.id))
    .run();

  return summarise(automation, plan, dryRun, results);
}

function summarise(
  automation: AutomationRow,
  plan: PlannedAction[],
  dryRun: boolean,
  results: ExecutionResult[] = [],
): RunSummary {
  const sending = plan.filter((p) => p.decision.send);
  const suppressed = dryRun
    ? plan.filter((p) => !p.decision.send).map((planned) => ({ planned, outcome: 'suppressed' as const, reason: planned.decision.reason }))
    : results.filter((result) => result.outcome === 'suppressed');
  const grouped = new Map<string, { code: string; reason: string; count: number }>();
  for (const result of suppressed) {
    const code = result.planned.decision.code ?? (result.reason.includes('queued or sent') ? 'already_sent' : 'suppressed');
    const entry = grouped.get(code) ?? { code, reason: result.reason, count: 0 };
    entry.count += 1;
    grouped.set(code, entry);
  }
  return {
    automationId: automation.id,
    dryRun,
    considered: plan.length,
    wouldSend: sending.length,
    sent: dryRun ? 0 : results.filter((result) => result.outcome === 'sent').length,
    queued: dryRun ? 0 : results.filter((result) => result.outcome === 'queued').length,
    suppressed: suppressed.length,
    failed: dryRun ? 0 : results.filter((result) => result.outcome === 'failed').length,
    bySuppression: [...grouped.values()].sort((a, b) => b.count - a.count),
    estimatedCostMinor: estimateCostMinor(
      plan[0]?.channel ?? 'in_app',
      dryRun ? sending.length : results.filter((result) => result.outcome === 'sent' || result.outcome === 'queued').length,
    ),
  };
}

/**
 * What a run would do, without recording anything at all.
 *
 * The audience preview (PF-COMM-004). Distinct from a dry run: a dry run is a
 * rehearsal that appears in the log, this is a look before you commit to even
 * rehearsing.
 */
export function previewRun(ctx: RequestContext, automationId: string, atMs = now()) {
  requirePermission(ctx, 'automation.manage');
  const automation = automationInTenant(ctx, automationId);
  const plan = planRun(ctx, automation, atMs);
  const sending = plan.filter((p) => p.decision.send);
  return {
    summary: summarise(automation, plan, true),
    channel: plan[0]?.channel ?? (automation.actions[0]?.kind ?? 'in_app'),
    metered: isMetered(plan[0]?.channel ?? ''),
    estimatedCostMinor: estimateCostMinor(plan[0]?.channel ?? 'in_app', sending.length),
    recipients: sending.slice(0, 25).map((p) => ({
      memberId: p.subject.memberId,
      name: p.subject.name,
      branchName: p.subject.branchName,
      preview: p.preview,
    })),
    suppressed: plan
      .filter((p) => !p.decision.send)
      .slice(0, 25)
      .map((p) => ({ memberId: p.subject.memberId, name: p.subject.name, code: p.decision.code, reason: p.decision.reason })),
  };
}

/* ——— The scheduler's entry point ————————————————————————— */

/**
 * Runs every active, non-dry-run automation for every tenant.
 *
 * Called by the one existing scheduler (`jobs/scheduler.ts`). This module does
 * not own a timer: a second scheduler is a second thing to reason about when
 * something sends twice, and the answer to "which one fired?" should never be
 * "both".
 */
export function runDueAutomations(atMs = now()): { ran: number; sent: number } {
  let ran = 0;
  const failures: Error[] = [];
  const deliveries = processDueDeliveries(atMs);
  let sent = deliveries.sent;
  if (deliveries.failed > 0) {
    failures.push(new Error(`${deliveries.failed} queued automation delivery attempt${deliveries.failed === 1 ? '' : 's'} failed.`));
  }
  const rows = db
    .select()
    .from(schema.automations)
    .where(and(eq(schema.automations.state, 'active'), eq(schema.automations.dryRun, false)))
    .all();

  for (const automation of rows) {
    const tenant = db
      .select({ status: schema.tenants.status })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, automation.tenantId))
      .get();
    if (!tenant || !TENANT_STATUSES[tenant.status as TenantStatus]?.operational) continue;
    const ctx = systemContext(automation.tenantId);
    try {
      const plan = planRun(ctx, automation, atMs);
      const results = commitRun(ctx, automation, plan, atMs, 'scheduler');
      db.update(schema.automations)
        .set({ lastRunAt: atMs, updatedAt: atMs })
        .where(eq(schema.automations.id, automation.id))
        .run();
      ran += 1;
      sent += results.filter((result) => result.outcome === 'sent').length;
      const failed = results.filter((result) => result.outcome === 'failed').length;
      if (failed > 0) {
        failures.push(new Error(`Automation ${automation.id} had ${failed} failed delivery attempt${failed === 1 ? '' : 's'}.`));
      }
    } catch (error) {
      console.error(`[automations] ${automation.id} failed`, error);
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(new Error(`Automation ${automation.id} failed: ${detail}`));
    }
  }
  if (failures.length > 0) {
    const detail = failures.map((failure) => failure.message).join(' ');
    throw new AggregateError(
      failures,
      `${failures.length} automation run${failures.length === 1 ? '' : 's'} failed. ${detail}`,
    );
  }
  return { ran, sent };
}

/** The scheduler acts for the tenant, not for a person. Named so, so an audit
 *  row from a job is never mistaken for somebody's decision. */
function systemContext(tenantId: string): RequestContext {
  return {
    requestId: id('job'), sessionId: 'system', authMethod: 'reader', tenantId,
    userId: 'system', memberId: null, staffId: null, role: 'owner', name: 'Automations',
    branchIds: db.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.tenantId, tenantId)).all().map((b) => b.id),
    activeBranchId: null, permissions: ['automation.manage'], ip: 'system', userAgent: 'scheduler', impersonatorId: null,
  };
}

/* ——— CRUD ————————————————————————————————————————————— */

export function listAutomations(ctx: RequestContext) {
  requirePermission(ctx, 'automation.manage');
  const requestScope = new Set(branchScope(ctx));
  const rows = db
    .select()
    .from(schema.automations)
    .where(eq(schema.automations.tenantId, ctx.tenantId))
    .orderBy(schema.automations.name)
    .all()
    .filter((row) => {
      const scope = storedScope(row);
      return scope.every((branchId) => ctx.branchIds.includes(branchId)) && scope.some((branchId) => requestScope.has(branchId));
    });

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      trigger: row.trigger,
      triggerLabel: triggerSpec(row.trigger)?.label ?? row.trigger,
      state: row.state,
      dryRun: row.dryRun,
      channel: row.actions[0]?.kind ?? 'in_app',
      providerAvailable: (row.actions[0]?.kind ?? 'in_app') === 'in_app',
      templateCode: row.actions[0]?.templateCode ?? null,
      templateVersion: row.actions[0]?.templateVersion ?? null,
      delayMin: row.actions[0]?.delayMin ?? 0,
      branchIds: row.branchIds,
      conditions: row.conditions,
      quietHours: row.quietHours,
      runsLast30: db
        .select({ n: sql<number>`count(*)` })
        .from(schema.automationRuns)
        .where(and(
          eq(schema.automationRuns.automationId, row.id),
          eq(schema.automationRuns.outcome, 'sent'),
          gte(schema.automationRuns.at, now() - 30 * DAY),
        ))
        .get()?.n ?? 0,
      lastRunAt: row.lastRunAt ? new Date(row.lastRunAt).toISOString() : null,
    })),
    triggers: TRIGGERS.map((t) => ({ ...t, variables: [...t.variables], fields: [...t.fields] })),
  };
}

export interface AutomationInput {
  name: string;
  description?: string;
  trigger: string;
  conditions: Condition[];
  channel: string;
  templateCode: string | null;
  delayMin: number;
  branchIds?: string[] | null;
  quietHours?: { from: string; to: string } | null;
}

function validate(ctx: RequestContext, input: AutomationInput, action: AutomationAction): void {
  const spec = triggerSpec(input.trigger);
  if (!spec) throw invalid(`${input.trigger} is not a trigger this product knows.`);

  const outcome = validateConditions(input.trigger, input.conditions);
  if (!outcome.ok) throw invalid(outcome.message);
  if (!Number.isInteger(input.delayMin) || input.delayMin < 0 || input.delayMin > 7 * 24 * 60) {
    throw invalid('Delay must be a whole number of minutes from 0 to 10080.');
  }
  if (input.quietHours && ![input.quietHours.from, input.quietHours.to].every((clock) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock))) {
    throw invalid('Quiet hours must use a real 24-hour time from 00:00 to 23:59.');
  }

  if (input.templateCode) {
    const template = templateFor(ctx.tenantId, input.templateCode, action.templateId, action.templateVersion);
    if (!template) throw invalid('That template does not exist.');
    if (template.channel !== input.channel) {
      throw invalid(`That message is for ${template.channel}, not ${input.channel}. Choose a message for this channel.`);
    }
    const used = templateVariables(template.body);
    const unknown = used.filter((v) => !spec.variables.includes(v));
    // Caught here rather than at send time: an operator who saves a rule and
    // discovers a month later that every run was suppressed has been let down
    // by the form, not by the engine.
    if (unknown.length > 0) {
      throw invalid(
        `"${template.code}" uses ${unknown.join(', ')}, which "${spec.label}" does not provide. It offers ${spec.variables.join(', ')}.`,
      );
    }
  }
}

function writeScope(ctx: RequestContext, requested: string[] | null | undefined): string[] | null {
  const tenantBranches = tenantBranchIds(ctx.tenantId);
  const ceiling = new Set(branchScope(ctx));
  const desired = requested === undefined
    ? [...ceiling]
    : requested === null
      ? tenantBranches
      : [...new Set(requested)];
  if (desired.length === 0) throw invalid('Choose at least one branch for this automation.');
  if (!desired.every((branchId) => tenantBranches.includes(branchId) && ceiling.has(branchId))) {
    throw notFound('That branch');
  }
  return desired.length === tenantBranches.length && tenantBranches.every((branchId) => desired.includes(branchId))
    ? null
    : desired;
}

function pinnedAction(ctx: RequestContext, input: AutomationInput): AutomationAction {
  const template = templateFor(ctx.tenantId, input.templateCode);
  return {
    kind: input.channel,
    templateCode: input.templateCode,
    templateId: template?.id ?? null,
    templateVersion: template?.version ?? null,
    delayMin: input.delayMin,
  };
}

function updatedAction(ctx: RequestContext, input: AutomationInput, existing?: AutomationAction): AutomationAction {
  const hasDurablePin = input.templateCode === null ||
    (existing?.templateId !== null && existing?.templateId !== undefined &&
      existing.templateVersion !== null && existing.templateVersion !== undefined);
  const sameTemplate = existing !== undefined &&
    existing.kind === input.channel &&
    existing.templateCode === input.templateCode &&
    hasDurablePin;
  if (!sameTemplate) return pinnedAction(ctx, input);
  return {
    ...existing,
    delayMin: input.delayMin,
  };
}

export function createAutomation(ctx: RequestContext, input: AutomationInput) {
  requirePermission(ctx, 'automation.manage');
  const action = pinnedAction(ctx, input);
  validate(ctx, input, action);

  const automationId = id('atm');
  const atMs = now();
  transact(() => {
    db.insert(schema.automations)
      .values({
        id: automationId,
        tenantId: ctx.tenantId,
        name: input.name,
        trigger: input.trigger,
        description: input.description ?? '',
        conditions: input.conditions,
        actions: [action],
        branchIds: writeScope(ctx, input.branchIds),
        quietHours: input.quietHours ?? null,
        // New automations rehearse. An automation that starts messaging the
        // moment it is saved is one nobody got to check.
        state: 'draft',
        dryRun: true,
        runsLast30: 0,
        lastRunAt: null,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
    audit(ctx, { action: 'automation.created', entityType: 'automation', entityId: automationId, entityLabel: input.name, after: { trigger: input.trigger, channel: input.channel } });
  });
  return { automation: listAutomations(ctx).items.find((a) => a.id === automationId)! };
}

export function updateAutomation(ctx: RequestContext, automationId: string, input: Partial<AutomationInput> & { state?: string; dryRun?: boolean }) {
  requirePermission(ctx, 'automation.manage');
  const existing = automationInTenant(ctx, automationId);

  const merged: AutomationInput = {
    name: input.name ?? existing.name,
    description: input.description ?? existing.description,
    trigger: input.trigger ?? existing.trigger,
    conditions: input.conditions ?? (existing.conditions as Condition[]),
    channel: input.channel ?? existing.actions[0]?.kind ?? 'in_app',
    templateCode: input.templateCode !== undefined ? input.templateCode : (existing.actions[0]?.templateCode ?? null),
    delayMin: input.delayMin ?? existing.actions[0]?.delayMin ?? 0,
    branchIds: input.branchIds !== undefined ? input.branchIds : existing.branchIds,
    quietHours: input.quietHours !== undefined ? input.quietHours : existing.quietHours,
  };
  const action = updatedAction(ctx, merged, existing.actions[0]);
  validate(ctx, merged, action);

  const nextState = input.state ?? existing.state;

  /*
   * Going live and changing the rule cannot happen in one request.
   *
   * An operator turns off dry run *because they read the preview*. If the same
   * call also moves the trigger, the conditions, the channel or the template,
   * the audience they approved is not the audience that will be messaged —
   * and they will not find out until the members do. Two requests: change it,
   * look at it again, then let it send.
   */
  const changesTheRule =
    (input.trigger !== undefined && input.trigger !== existing.trigger) ||
    (input.conditions !== undefined && JSON.stringify(input.conditions) !== JSON.stringify(existing.conditions)) ||
    JSON.stringify(action) !== JSON.stringify(existing.actions[0]) ||
    (input.quietHours !== undefined && JSON.stringify(input.quietHours) !== JSON.stringify(existing.quietHours)) ||
    (input.branchIds !== undefined && JSON.stringify(input.branchIds) !== JSON.stringify(existing.branchIds));

  if (changesTheRule && input.dryRun === false) {
    throw conflict('Save the change first, look at who it reaches, then let it send.');
  }
  // Any audience/delivery change invalidates the preview that made a live rule
  // safe. The edit is saved, but the rule returns to rehearsal automatically.
  const nextDryRun = changesTheRule ? true : (input.dryRun ?? existing.dryRun);
  const nextScope = writeScope(ctx, merged.branchIds);

  transact(() => {
    db.update(schema.automations)
      .set({
        name: merged.name,
        description: merged.description ?? '',
        trigger: merged.trigger,
        conditions: merged.conditions,
        actions: [action],
        branchIds: nextScope,
        quietHours: merged.quietHours ?? null,
        state: nextState,
        dryRun: nextDryRun,
        updatedAt: now(),
      })
      .where(and(eq(schema.automations.id, automationId), eq(schema.automations.tenantId, ctx.tenantId)))
      .run();
    audit(ctx, {
      action: 'automation.updated', entityType: 'automation', entityId: automationId, entityLabel: merged.name,
      before: { state: existing.state, dryRun: existing.dryRun },
      after: { state: nextState, dryRun: nextDryRun },
    });
  });

  return { automation: listAutomations(ctx).items.find((a) => a.id === automationId)! };
}

/* ——— History (PF-COMM-005) ————————————————————————————— */

export function runHistory(ctx: RequestContext, filters: { automationId?: string; outcome?: string; limit?: number }) {
  requirePermission(ctx, 'automation.manage');
  const scope = branchScope(ctx);
  const conditions = [
    eq(schema.automationRuns.tenantId, ctx.tenantId),
    inArray(schema.automationRuns.branchId, scope),
  ];
  if (filters.automationId) {
    automationInTenant(ctx, filters.automationId);
    conditions.push(eq(schema.automationRuns.automationId, filters.automationId));
  }
  if (filters.outcome) conditions.push(eq(schema.automationRuns.outcome, filters.outcome));

  const names = new Map(
    db.select({ id: schema.automations.id, name: schema.automations.name }).from(schema.automations).where(eq(schema.automations.tenantId, ctx.tenantId)).all().map((a) => [a.id, a.name]),
  );
  const members = new Map(
    db.select({ id: schema.members.id, firstName: schema.members.firstName, lastName: schema.members.lastName })
      .from(schema.members).where(eq(schema.members.tenantId, ctx.tenantId)).all()
      .map((m) => [m.id, `${m.firstName} ${m.lastName}`]),
  );

  const rows = db
    .select()
    .from(schema.automationRuns)
    .where(and(...conditions))
    .orderBy(desc(schema.automationRuns.at))
    .limit(Math.min(filters.limit ?? 100, 200))
    .all();

  const deliveryIds = rows.flatMap((row) => row.deliveryId ? [row.deliveryId] : []);
  const deliveries = new Map(
    deliveryIds.length === 0
      ? []
      : db
        .select()
        .from(schema.automationDeliveries)
        .where(and(
          eq(schema.automationDeliveries.tenantId, ctx.tenantId),
          inArray(schema.automationDeliveries.branchId, scope),
          inArray(schema.automationDeliveries.id, deliveryIds),
        ))
        .all()
        .map((delivery) => [delivery.id, delivery] as const),
  );

  return {
    items: rows.map((row) => {
      const delivery = row.deliveryId ? deliveries.get(row.deliveryId) : undefined;
      return {
        id: row.id,
        at: new Date(row.at).toISOString(),
        automationId: row.automationId,
        automationName: names.get(row.automationId) ?? row.automationId,
        memberName: row.memberId ? (members.get(row.memberId) ?? null) : null,
        memberId: row.memberId,
        outcome: row.outcome,
        reason: row.reason,
        channel: row.channel,
        dueAt: row.deliveryId ? new Date(delivery?.dueAt ?? row.at).toISOString() : null,
        attempts: delivery?.attempts ?? 0,
        lastAttemptAt: delivery?.lastAttemptAt ? new Date(delivery.lastAttemptAt).toISOString() : null,
      };
    }),
  };
}

/* ——— Templates (PF-COMM-003) ————————————————————————————— */

export function listTemplates(ctx: RequestContext) {
  requirePermission(ctx, 'automation.manage');
  return {
    items: db
      .select()
      .from(schema.messageTemplates)
      .where(eq(schema.messageTemplates.tenantId, ctx.tenantId))
      .orderBy(schema.messageTemplates.code)
      .all()
      .map((row) => ({
        id: row.id,
        code: row.code,
        channel: row.channel,
        version: row.version,
        subject: row.subject,
        body: row.body,
        variables: templateVariables(row.body),
      })),
  };
}

export function saveTemplate(ctx: RequestContext, input: { code: string; channel: string; subject: string | null; body: string }) {
  requirePermission(ctx, 'automation.manage');
  const existing = db
    .select()
    .from(schema.messageTemplates)
    .where(and(eq(schema.messageTemplates.tenantId, ctx.tenantId), eq(schema.messageTemplates.code, input.code)))
    .orderBy(desc(schema.messageTemplates.version))
    .get();

  const templateId = id('tpl');
  const variables = templateVariables(input.body);
  transact(() => {
    // A new version rather than an edit (PF-COMM-003). A message already sent
    // was sent under the words that existed then, and rewriting the row makes
    // the delivery log describe something that never happened.
    db.insert(schema.messageTemplates)
      .values({
        id: templateId,
        tenantId: ctx.tenantId,
        code: input.code,
        channel: input.channel,
        version: (existing?.version ?? 0) + 1,
        locale: 'en',
        subject: input.subject,
        body: input.body,
        variables,
        updatedAt: now(),
      })
      .run();
    audit(ctx, { action: 'template.saved', entityType: 'template', entityId: templateId, entityLabel: input.code, after: { version: (existing?.version ?? 0) + 1, variables } });
  });

  return { template: { id: templateId, code: input.code, channel: input.channel, version: (existing?.version ?? 0) + 1, subject: input.subject, body: input.body, variables } };
}
