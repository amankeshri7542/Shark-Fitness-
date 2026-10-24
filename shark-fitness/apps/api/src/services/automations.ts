import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { BranchState } from '@shark/contracts';
import {
  TRIGGERS,
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
} from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { branchPolicy } from '../lib/policy.js';
import { DAY, isoDate, localMinutes, now } from '../lib/time.js';
import { requirePermission, type RequestContext } from '../lib/context.js';

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

const branchesOf = (tenantId: string) =>
  new Map(
    db.select().from(schema.branches).where(eq(schema.branches.tenantId, tenantId)).all().map((b) => [b.id, b]),
  );

/**
 * Who this trigger is about, right now.
 *
 * Each arm is a plain query rather than a generic rule engine. Five triggers
 * with five readable queries is a thing somebody can debug at 06:00; one
 * query builder covering all five is not, and the abstraction would have to be
 * rewritten for the sixth anyway.
 */
export function audienceFor(tenantId: string, trigger: string, atMs: number): AudienceSubject[] {
  const branches = branchesOf(tenantId);
  const tenant = db.select({ displayName: schema.tenants.displayName }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  const gymName = tenant?.displayName ?? '';

  const base = (member: typeof schema.members.$inferSelect): AudienceSubject | null => {
    const branch = branches.get(member.homeBranchId);
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
        eq(schema.memberships.state, 'active'),
        sql`${schema.memberships.endsOn} is not null`,
        isNull(schema.members.deletedAt),
      ))
      .all();
    for (const row of rows) {
      const subject = base(row.member);
      if (!subject || !row.membership.endsOn) continue;
      const daysLeft = Math.ceil((Date.parse(`${row.membership.endsOn}T00:00:00Z`) - atMs) / DAY);
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
      .select({ member: schema.members, invoice: schema.invoices })
      .from(schema.invoices)
      .innerJoin(schema.members, eq(schema.members.id, schema.invoices.memberId))
      .where(and(
        eq(schema.invoices.tenantId, tenantId),
        eq(schema.invoices.voided, false),
        sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
        sql`${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`,
        isNull(schema.members.deletedAt),
      ))
      .all();
    for (const row of rows) {
      const subject = base(row.member);
      if (!subject) continue;
      const amountDue = row.invoice.totalMinor - row.invoice.paidMinor;
      subject.occurrenceId = row.invoice.id;
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
        const daysSinceVisit = member.lastVisitAt === null ? null : Math.floor((atMs - member.lastVisitAt) / DAY);
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
    const from = atMs + DAY;
    const to = atMs + 2 * DAY;
    const rows = db
      .select({
        member: schema.members,
        sessionId: schema.classSessions.id,
        startsAt: schema.classSessions.startsAt,
        className: schema.classTypes.name,
      })
      .from(schema.bookings)
      .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
      .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
      .innerJoin(schema.members, eq(schema.members.id, schema.bookings.memberId))
      .where(and(
        eq(schema.classSessions.tenantId, tenantId),
        eq(schema.classSessions.state, 'scheduled'),
        gte(schema.classSessions.startsAt, from),
        lt(schema.classSessions.startsAt, to),
        sql`${schema.bookings.state} in ('held','confirmed')`,
        isNull(schema.members.deletedAt),
      ))
      .all();
    const out: AudienceSubject[] = [];
    for (const row of rows) {
      const subject = base(row.member);
      if (!subject) continue;
      subject.occurrenceId = row.sessionId;
      subject.variables = {
        ...subject.variables,
        className: row.className,
        startsAt: new Date(row.startsAt).toISOString(),
        trainerName: null,
        roomName: null,
      };
      subject.facts = { ...subject.facts, className: row.className };
      out.push(subject);
    }
    return out;
  }

  return [];
}

/* ——— Planning ————————————————————————————————————————— */

type AutomationRow = typeof schema.automations.$inferSelect;

function automationInTenant(ctx: RequestContext, automationId: string): AutomationRow {
  const row = db
    .select()
    .from(schema.automations)
    .where(and(eq(schema.automations.id, automationId), eq(schema.automations.tenantId, ctx.tenantId)))
    .get();
  if (!row) throw notFound('That automation');
  return row;
}

function templateFor(tenantId: string, code: string | null) {
  if (!code) return null;
  return db
    .select()
    .from(schema.messageTemplates)
    .where(and(eq(schema.messageTemplates.tenantId, tenantId), eq(schema.messageTemplates.code, code)))
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

  const template = templateFor(ctx.tenantId, action.templateCode);
  const channel = action.kind;
  const day = isoDate(atMs, 'UTC');
  const remaining = quotaRemaining(ctx.tenantId, channel);
  let budget = remaining;

  const audience = audienceFor(ctx.tenantId, automation.trigger, atMs).filter((subject) =>
    matches(automation.conditions as Condition[], subject.facts),
  );

  return audience.map((subject) => {
    const eventKey = dedupeKey(automation.trigger, subject.memberId, { day, occurrenceId: subject.occurrenceId });

    const rendered = template
      ? renderTemplate(template.body, subject.variables, spec.variables)
      : { text: '', missing: ['template'], unknown: [] };

    const alreadySent =
      db
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

    return { subject, channel, templateCode: action.templateCode, eventKey, decision, preview: rendered.text };
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
function commitRun(ctx: RequestContext, automation: AutomationRow, plan: PlannedAction[], atMs: number): void {
  if (automation.dryRun) throw precondition('This automation is in dry run and cannot send.');
  if (automation.state !== 'active') throw precondition('This automation is not running.');

  for (const planned of plan) {
    const runId = id('aur');
    if (!planned.decision.send) {
      db.insert(schema.automationRuns).values(runRow(ctx, automation, planned, 'suppressed', planned.decision.reason, null, atMs, runId)).run();
      continue;
    }

    try {
      transact(() => {
        const notificationId = id('ntf');
        // The dedupe row goes in first. If a concurrent tick already sent this
        // event the unique index aborts here, before a message exists.
        db.insert(schema.automationRuns)
          .values(runRow(ctx, automation, planned, 'sent', '', notificationId, atMs, runId))
          .run();

        db.insert(schema.notifications)
          .values({
            id: notificationId,
            tenantId: ctx.tenantId,
            userId: planned.subject.userId!,
            channel: planned.channel,
            kind: 'automation',
            title: automation.name,
            body: planned.preview,
            link: null,
            templateCode: planned.templateCode,
            state: 'sent',
            attempts: 1,
            lastError: null,
            createdAt: atMs,
            readAt: null,
          })
          .run();

        if (isMetered(planned.channel)) {
          db.update(schema.usageMeters)
            .set({ used: sql`${schema.usageMeters.used} + 1`, updatedAt: atMs })
            .where(and(
              eq(schema.usageMeters.tenantId, ctx.tenantId),
              eq(schema.usageMeters.meter, planned.channel),
              eq(schema.usageMeters.period, isoDate(atMs, 'UTC').slice(0, 7)),
            ))
            .run();
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A unique-index abort means another tick got there first. That is the
      // guard doing its job, not a failure worth alarming anybody about.
      const duplicate = message.includes('UNIQUE constraint failed');
      db.insert(schema.automationRuns)
        .values(runRow(
          ctx, automation, planned,
          duplicate ? 'suppressed' : 'failed',
          duplicate ? 'Already sent for this event.' : message.slice(0, 200),
          null, atMs, id('aur'),
        ))
        .run();
    }
  }
}

function runRow(
  ctx: RequestContext,
  automation: AutomationRow,
  planned: PlannedAction,
  outcome: string,
  reason: string,
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
    notificationId,
    at: atMs,
  };
}

/* ——— Running ————————————————————————————————————————— */

export interface RunSummary {
  automationId: string;
  dryRun: boolean;
  considered: number;
  sent: number;
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

  if (dryRun) {
    for (const planned of plan) {
      db.insert(schema.automationRuns)
        .values(runRow(
          ctx, automation, planned, 'dry_run',
          planned.decision.send ? 'Would have sent.' : planned.decision.reason,
          null, atMs, id('aur'),
        ))
        .run();
    }
  } else {
    commitRun(ctx, automation, plan, atMs);
  }

  db.update(schema.automations)
    .set({ lastRunAt: atMs, runsLast30: automation.runsLast30 + plan.filter((p) => p.decision.send).length, updatedAt: atMs })
    .where(eq(schema.automations.id, automation.id))
    .run();

  return summarise(automation, plan, dryRun);
}

function summarise(automation: AutomationRow, plan: PlannedAction[], dryRun: boolean): RunSummary {
  const sending = plan.filter((p) => p.decision.send);
  const suppressed = plan.filter((p) => !p.decision.send);
  const grouped = new Map<string, { code: string; reason: string; count: number }>();
  for (const p of suppressed) {
    const code = p.decision.code ?? 'unknown';
    const entry = grouped.get(code) ?? { code, reason: p.decision.reason, count: 0 };
    entry.count += 1;
    grouped.set(code, entry);
  }
  return {
    automationId: automation.id,
    dryRun,
    considered: plan.length,
    sent: dryRun ? 0 : sending.length,
    suppressed: suppressed.length,
    failed: 0,
    bySuppression: [...grouped.values()].sort((a, b) => b.count - a.count),
    estimatedCostMinor: estimateCostMinor(plan[0]?.channel ?? 'in_app', sending.length),
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
  let sent = 0;
  const rows = db
    .select()
    .from(schema.automations)
    .where(and(eq(schema.automations.state, 'active'), eq(schema.automations.dryRun, false)))
    .all();

  for (const automation of rows) {
    const ctx = systemContext(automation.tenantId);
    try {
      const plan = planRun(ctx, automation, atMs);
      commitRun(ctx, automation, plan, atMs);
      db.update(schema.automations)
        .set({ lastRunAt: atMs, runsLast30: automation.runsLast30 + plan.filter((p) => p.decision.send).length, updatedAt: atMs })
        .where(eq(schema.automations.id, automation.id))
        .run();
      ran += 1;
      sent += plan.filter((p) => p.decision.send).length;
    } catch (error) {
      console.error(`[automations] ${automation.id} failed`, error);
    }
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
  const rows = db
    .select()
    .from(schema.automations)
    .where(eq(schema.automations.tenantId, ctx.tenantId))
    .orderBy(schema.automations.name)
    .all();

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
      templateCode: row.actions[0]?.templateCode ?? null,
      conditions: row.conditions,
      quietHours: row.quietHours,
      runsLast30: row.runsLast30,
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
  quietHours?: { from: string; to: string } | null;
}

function validate(ctx: RequestContext, input: AutomationInput): void {
  const spec = triggerSpec(input.trigger);
  if (!spec) throw invalid(`${input.trigger} is not a trigger this product knows.`);

  const outcome = validateConditions(input.trigger, input.conditions);
  if (!outcome.ok) throw invalid(outcome.message);

  if (input.templateCode) {
    const template = templateFor(ctx.tenantId, input.templateCode);
    if (!template) throw invalid('That template does not exist.');
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

export function createAutomation(ctx: RequestContext, input: AutomationInput) {
  requirePermission(ctx, 'automation.manage');
  validate(ctx, input);

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
        actions: [{ kind: input.channel, templateCode: input.templateCode, delayMin: 0 }],
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
    quietHours: input.quietHours !== undefined ? input.quietHours : existing.quietHours,
  };
  validate(ctx, merged);

  const nextState = input.state ?? existing.state;
  const nextDryRun = input.dryRun ?? existing.dryRun;

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
    (input.channel !== undefined && input.channel !== (existing.actions[0]?.kind ?? '')) ||
    (input.templateCode !== undefined && input.templateCode !== (existing.actions[0]?.templateCode ?? null));

  if (existing.dryRun && nextDryRun === false && changesTheRule) {
    throw conflict('Save the change first, look at who it reaches, then let it send.');
  }

  transact(() => {
    db.update(schema.automations)
      .set({
        name: merged.name,
        description: merged.description ?? '',
        trigger: merged.trigger,
        conditions: merged.conditions,
        actions: [{ kind: merged.channel, templateCode: merged.templateCode, delayMin: 0 }],
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
  const conditions = [eq(schema.automationRuns.tenantId, ctx.tenantId)];
  if (filters.automationId) conditions.push(eq(schema.automationRuns.automationId, filters.automationId));
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

  return {
    items: rows.map((row) => ({
      id: row.id,
      at: new Date(row.at).toISOString(),
      automationId: row.automationId,
      automationName: names.get(row.automationId) ?? row.automationId,
      memberName: row.memberId ? (members.get(row.memberId) ?? null) : null,
      memberId: row.memberId,
      outcome: row.outcome,
      reason: row.reason,
      channel: row.channel,
    })),
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
