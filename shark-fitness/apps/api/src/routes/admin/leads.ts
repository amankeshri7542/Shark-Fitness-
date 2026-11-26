import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, like, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate, queryFlag } from '../../middleware/validate.js';
import { channels, LeadStage } from '@shark/contracts';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { branchScope, requireBranch, requirePermission } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { AppError, conflict } from '../../lib/errors.js';
import { id, normalizeEmail, normalizePhone } from '../../lib/ids.js';
import { HOUR, isoDate, localTime, now } from '../../lib/time.js';
import { sessionQuery } from '../../services/booking.js';
import { enrollMember } from '../../services/member-enrollment.js';
import { goalLabel, preferredTimeLabel } from '../../services/public-site.js';
import {
  LEAD_STAGE_TRANSITIONS,
  assertValidOwner,
  canTransitionLead,
  findDuplicateLead,
  findExistingMember,
  leadSlaBreached,
  loadLeadInScope,
} from '../../services/leads.js';
import { emitIntegrationEvent } from '../../services/integration-events.js';

export const leadsRoutes = new Hono();

const ListQuery = z.object({
  q: z.string().optional(),
  stage: LeadStage.optional(),
  ownerId: z.string().optional(),
  slaBreached: queryFlag.optional(),
  /** `website` narrows to leads from the public website (forms and QR campaign links). */
  source: z.enum(['walk_in', 'web_form', 'website', 'referral', 'campaign', 'import', 'trial', 'api', 'call']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Pipeline (UX-A02). `total`/`byStage` always reflect the full filtered scope
 * (search + branch + stage + owner + SLA), never just the returned page —
 * the board groups `items` by stage, so an aggregate computed only from a
 * truncated page would silently under-count columns the caller can't see.
 * `items` is paginated after that full-scope computation; `hasMore` tells the
 * board when it isn't looking at everything, so nothing is silently omitted.
 */
leadsRoutes.get('/', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.view');
  const q = c.req.valid('query');

  const scope = branchScope(ctx);
  const filters = [eq(schema.leads.tenantId, ctx.tenantId), inArray(schema.leads.branchId, scope)];
  if (q.stage) filters.push(eq(schema.leads.stage, q.stage));
  if (q.ownerId) filters.push(eq(schema.leads.ownerId, q.ownerId));
  if (q.source) filters.push(eq(schema.leads.source, q.source));
  if (q.q) {
    const term = `%${q.q.trim().toLowerCase()}%`;
    const digits = q.q.replace(/\D/g, '');
    filters.push(
      or(
        like(sql`lower(${schema.leads.name})`, term),
        like(schema.leads.phone, term),
        like(sql`lower(${schema.leads.email})`, term),
        ...(digits.length >= 4 ? [like(sql`coalesce(${schema.leads.phoneNormalized}, '')`, `%${digits}%`)] : []),
      )!,
    );
  }
  const where = and(...filters);

  // No limit/offset here — every lead matching the filters is needed to
  // compute accurate totals and per-stage counts before pagination applies.
  const rows = db.select().from(schema.leads).where(where).orderBy(desc(schema.leads.createdAt)).all();

  const branchNames = new Map(
    db.select({ id: schema.branches.id, name: schema.branches.name }).from(schema.branches).all().map((b) => [b.id, b.name]),
  );
  // leads.ownerId stores a staff.id, not a users.id — join through staff for the name.
  const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => x !== null))];
  const owners = ownerIds.length
    ? new Map(
        db
          .select({ id: schema.staff.id, name: schema.users.name })
          .from(schema.staff)
          .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
          .where(inArray(schema.staff.id, ownerIds))
          .all()
          .map((s) => [s.id, s.name]),
      )
    : new Map<string, string>();

  const sessionLabels = trialSessionLabels(rows);
  const nowMs = now();
  const allItems = rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    source: r.source,
    campaign: r.campaign,
    stage: r.stage,
    branchId: r.branchId,
    branchName: branchNames.get(r.branchId) ?? '',
    ownerId: r.ownerId,
    ownerName: r.ownerId ? (owners.get(r.ownerId) ?? null) : null,
    expectedValueMinor: r.expectedValueMinor,
    nextActionAt: r.nextActionAt ? new Date(r.nextActionAt).toISOString() : null,
    nextActionLabel: r.nextActionLabel,
    lastTouchedAt: r.lastTouchedAt ? new Date(r.lastTouchedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    lossReason: r.lossReason,
    convertedMemberId: r.convertedMemberId,
    slaBreached: leadSlaBreached(r as { stage: LeadStage; nextActionAt: number | null; lastTouchedAt: number | null; createdAt: number }, nowMs),
    duplicateOfId: r.duplicateOfId,
    tags: r.tags,
    ...attributionOf(r),
    trial: trialOf(r, sessionLabels),
  }));

  const byStage: Record<string, number> = {};
  for (const item of allItems) byStage[item.stage] = (byStage[item.stage] ?? 0) + 1;

  const filtered = q.slaBreached ? allItems.filter((x) => x.slaBreached) : allItems;
  const total = filtered.length;
  const items = filtered.slice(q.offset, q.offset + q.limit);
  const hasMore = q.offset + items.length < total;

  return c.json({ total, byStage, items, hasMore, limit: q.limit, offset: q.offset });
});

/** Assignable owners for the lead-capture form and edit dialog — active staff
 *  in the given branch. Must be registered before `/:leadId` so "owners"
 *  isn't captured as a lead id by that route. */
leadsRoutes.get('/owners', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.view');
  const branchId = c.req.query('branchId');
  const scope = branchScope(ctx, branchId);

  const rows = db
    .select({ id: schema.staff.id, name: schema.users.name, branchIds: schema.staff.branchIds })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(
      and(
        eq(schema.staff.tenantId, ctx.tenantId),
        eq(schema.staff.employmentStatus, 'active'),
        eq(schema.users.accountState, 'active'),
      ),
    )
    .all();

  const items = rows
    .filter((row) => row.branchIds.some((candidate) => scope.includes(candidate)))
    .map((row) => ({ id: row.id, name: row.name }));
  return c.json({ items });
});

/** Detail (UX-A03): lead + timeline + duplicate candidate + existing-member check. */
leadsRoutes.get('/:leadId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.view');
  const leadId = c.req.param('leadId');
  const lead = loadLeadInScope(ctx, leadId);

  const activities = db
    .select()
    .from(schema.leadActivities)
    .where(eq(schema.leadActivities.leadId, leadId))
    .orderBy(desc(schema.leadActivities.at))
    .all();

  const branch = db.select({ name: schema.branches.name }).from(schema.branches).where(eq(schema.branches.id, lead.branchId)).get();
  // lead.ownerId stores a staff.id, not a users.id — join through staff for the name.
  const owner = lead.ownerId
    ? db
        .select({ name: schema.users.name, accountState: schema.users.accountState })
        .from(schema.staff)
        .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
        .where(eq(schema.staff.id, lead.ownerId))
        .get()
    : null;

  const duplicate = lead.duplicateOfId
    ? db.select({ id: schema.leads.id, name: schema.leads.name }).from(schema.leads).where(eq(schema.leads.id, lead.duplicateOfId)).get()
    : findDuplicateLead(ctx.tenantId, lead.phoneNormalized, lead.emailNormalized, lead.id);

  const existingMember = lead.convertedMemberId
    ? db
        .select({ id: schema.members.id, name: sql<string>`${schema.members.firstName} || ' ' || ${schema.members.lastName}` })
        .from(schema.members)
        .where(eq(schema.members.id, lead.convertedMemberId))
        .get()
    : null;

  return c.json({
    lead: {
      id: lead.id,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      source: lead.source,
      campaign: lead.campaign,
      stage: lead.stage,
      branchId: lead.branchId,
      branchName: branch?.name ?? '',
      ownerId: lead.ownerId,
      ownerName: owner?.name ?? null,
      expectedValueMinor: lead.expectedValueMinor,
      nextActionAt: lead.nextActionAt ? new Date(lead.nextActionAt).toISOString() : null,
      nextActionLabel: lead.nextActionLabel,
      lastTouchedAt: lead.lastTouchedAt ? new Date(lead.lastTouchedAt).toISOString() : null,
      createdAt: new Date(lead.createdAt).toISOString(),
      lossReason: lead.lossReason,
      convertedMemberId: lead.convertedMemberId,
      slaBreached: leadSlaBreached(lead as { stage: LeadStage; nextActionAt: number | null; lastTouchedAt: number | null; createdAt: number }, now()),
      duplicateOfId: lead.duplicateOfId,
      tags: lead.tags,
      ...attributionOf(lead),
      trial: trialOf(lead, trialSessionLabels([lead])),
      goal: goalLabel(lead.goal),
      preferredTime: preferredTimeLabel(lead.preferredTime),
      interestedPlan: lead.interestedProductId
        ? (db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(and(eq(schema.products.id, lead.interestedProductId), eq(schema.products.tenantId, ctx.tenantId))).get() ?? null)
        : null,
      referralCode: lead.referralCode,
      consents: latestConsents(lead.id),
    },
    activities: activities.map((a) => ({
      id: a.id,
      leadId: a.leadId,
      kind: a.kind,
      body: a.body,
      actorName: a.actorName,
      at: new Date(a.at).toISOString(),
      fromStage: a.fromStage,
      toStage: a.toStage,
    })),
    availableStages: LEAD_STAGE_TRANSITIONS[lead.stage as LeadStage] ?? [],
    duplicate: duplicate ? { id: duplicate.id, name: duplicate.name } : null,
    ownerUnavailable: owner ? owner.accountState !== 'active' : false,
    existingMember: existingMember ? { id: existingMember.id, name: existingMember.name } : null,
  });
});

/* — Website attribution and trial requests ————————————————————— */

type LeadRow = typeof schema.leads.$inferSelect;

/** PF-CRM-005: where the lead came from. UTM is first touch and never rewritten. */
function attributionOf(lead: LeadRow) {
  return { utm: lead.utm ?? null, referralCode: lead.referralCode };
}

/** "Spin Sprint · 2026-11-26 18:30" for each trial session the rows mention, in the branch's zone. */
function trialSessionLabels(rows: LeadRow[]): Map<string, { label: string; startsAt: string }> {
  const ids = [...new Set(rows.flatMap((r) => [r.trialSessionId, r.trialConfirmedSessionId]).filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return new Map();
  const sessions = sessionQuery()
    .where(inArray(schema.classSessions.id, ids))
    .all();
  const zones = new Map(db.select({ id: schema.branches.id, tz: schema.branches.timezone }).from(schema.branches).all().map((b) => [b.id, b.tz]));
  return new Map(
    sessions.map((session) => {
      const tz = zones.get(session.branchId) ?? 'Asia/Kolkata';
      return [session.id, { label: `${session.name} · ${isoDate(session.startsAt, tz)} ${localTime(session.startsAt, tz)}`, startsAt: new Date(session.startsAt).toISOString() }];
    }),
  );
}

function trialOf(lead: LeadRow, labels: Map<string, { label: string; startsAt: string }>) {
  if (!lead.trialRequestedAt && !lead.trialConfirmedAt) return null;
  const requested = lead.trialSessionId ? labels.get(lead.trialSessionId) : undefined;
  const confirmed = lead.trialConfirmedSessionId ? labels.get(lead.trialConfirmedSessionId) : undefined;
  return {
    requestedAt: lead.trialRequestedAt ? new Date(lead.trialRequestedAt).toISOString() : null,
    sessionId: lead.trialSessionId,
    sessionLabel: requested?.label ?? null,
    preferredTime: preferredTimeLabel(lead.trialPreferredTime),
    confirmedSessionId: lead.trialConfirmedSessionId,
    confirmedSessionLabel: confirmed?.label ?? null,
    confirmedAt: lead.trialConfirmedAt ? new Date(lead.trialConfirmedAt).toISOString() : null,
  };
}

/** The consent in force for each purpose: its latest record (ENT-PRIV-003). */
function latestConsents(leadId: string) {
  const rows = db
    .select()
    .from(schema.leadConsents)
    .where(eq(schema.leadConsents.leadId, leadId))
    .orderBy(desc(schema.leadConsents.capturedAt), desc(schema.leadConsents.id))
    .all();
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.purpose)) latest.set(row.purpose, row);
  return [...latest.values()].map((row) => ({
    purpose: row.purpose,
    granted: row.granted,
    noticeVersion: row.noticeVersion,
    source: row.source,
    capturedAt: new Date(row.capturedAt).toISOString(),
  }));
}

/** Upcoming classes at the lead's branch, for the "Confirm trial" picker. */
leadsRoutes.get('/:leadId/trial/options', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.view');
  const lead = loadLeadInScope(ctx, c.req.param('leadId'));
  const tz = db.select({ tz: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, lead.branchId)).get()?.tz ?? 'Asia/Kolkata';
  const at = now();
  const sessions = sessionQuery()
    .where(
      and(
        eq(schema.classSessions.tenantId, ctx.tenantId),
        eq(schema.classSessions.branchId, lead.branchId),
        eq(schema.classSessions.state, 'scheduled'),
        gte(schema.classSessions.startsAt, at),
        lt(schema.classSessions.startsAt, at + TRIAL_WINDOW_MS),
      ),
    )
    .orderBy(schema.classSessions.startsAt)
    .all();
  return c.json({
    items: sessions.map((s) => ({
      id: s.id,
      label: `${s.name} · ${isoDate(s.startsAt, tz)} ${localTime(s.startsAt, tz)}`,
      startsAt: new Date(s.startsAt).toISOString(),
      trainerName: s.trainerName,
      openSpots: Math.max(0, s.capacity - s.booked),
      requested: s.id === lead.trialSessionId,
    })),
  });
});

const TRIAL_WINDOW_MS = 14 * 24 * HOUR;
const TRIAL_CONFIRMABLE = new Set<string>(['new', 'contacted', 'qualified', 'trial_booked', 'nurture', 'reopened']);
const ConfirmTrialBody = z.object({ sessionId: z.string().min(1), note: z.string().max(500).optional() });

/**
 * Staff have spoken to the person and agreed a class: the lead moves to
 * `trial_booked` with that session recorded. This is the one way into
 * `trial_booked` from an earlier stage than `qualified` — the call that
 * confirms a trial is also the contact and the qualification. Nothing is
 * booked: a lead is not a member and holds no seat. The class's next action
 * becomes the trial itself, so an unattended trial shows as overdue.
 */
leadsRoutes.post('/:leadId/trial/confirm', validate('json', ConfirmTrialBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.manage');
  const leadId = c.req.param('leadId');
  const body = c.req.valid('json');
  const lead = loadLeadInScope(ctx, leadId);
  if (!TRIAL_CONFIRMABLE.has(lead.stage)) {
    throw conflict(`This lead is ${lead.stage.replace(/_/g, ' ')}. Reopen it before confirming a trial.`);
  }

  const session = sessionQuery().where(and(eq(schema.classSessions.tenantId, ctx.tenantId), eq(schema.classSessions.id, body.sessionId))).get();
  if (!session || session.branchId !== lead.branchId || session.state !== 'scheduled' || session.startsAt <= now()) {
    throw new AppError('VALIDATION_FAILED', 'Choose an upcoming class at this lead’s branch.', {
      fields: [{ path: 'sessionId', code: 'custom', message: 'Choose an upcoming class at this lead’s branch.' }],
    });
  }
  const tz = db.select({ tz: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, lead.branchId)).get()?.tz ?? 'Asia/Kolkata';
  const label = `${session.name} · ${isoDate(session.startsAt, tz)} ${localTime(session.startsAt, tz)}`;
  const at = now();

  transact(() => {
    db.update(schema.leads)
      .set({
        stage: 'trial_booked',
        trialConfirmedSessionId: session.id,
        trialConfirmedAt: at,
        nextActionAt: session.endsAt,
        nextActionLabel: `Free trial: ${label}`,
        lastTouchedAt: at,
        updatedAt: at,
      })
      .where(eq(schema.leads.id, leadId))
      .run();

    db.insert(schema.leadActivities)
      .values({
        id: id('lac'),
        tenantId: ctx.tenantId,
        leadId,
        kind: 'trial',
        body: `Free trial confirmed: ${label}.${body.note?.trim() ? ` ${body.note.trim()}` : ''}`,
        actorId: ctx.userId,
        actorName: ctx.name,
        fromStage: lead.stage,
        toStage: 'trial_booked',
        at,
      })
      .run();

    audit(ctx, {
      action: 'lead.trial_confirmed',
      entityType: 'lead',
      entityId: leadId,
      entityLabel: lead.name,
      branchId: lead.branchId,
      before: { stage: lead.stage, trialConfirmedSessionId: lead.trialConfirmedSessionId },
      after: { stage: 'trial_booked', trialConfirmedSessionId: session.id },
    });
  });

  emit({
    tenantId: ctx.tenantId,
    branchId: lead.branchId,
    channel: channels.branch(lead.branchId),
    topic: 'lead.stage_changed',
    payload: { leadId, from: lead.stage, to: 'trial_booked' },
  });

  return c.json({ ok: true, stage: 'trial_booked', sessionLabel: label });
});

/* — Mutations ——————————————————————————————————————————————— */

const CreateBody = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  source: z.enum(['walk_in', 'web_form', 'referral', 'campaign', 'import', 'trial', 'api', 'call']),
  campaign: z.string().optional(),
  branchId: z.string(),
  ownerId: z.string().optional(),
  expectedValueMinor: z.number().int().min(0).default(0),
  nextActionAt: z.string().datetime().optional(),
  nextActionLabel: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

leadsRoutes.post('/', validate('json', CreateBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.manage');
  const body = c.req.valid('json');

  requireBranch(ctx, body.branchId);

  const ownerId = body.ownerId ?? ctx.staffId;
  if (ownerId) assertValidOwner(ctx.tenantId, ownerId, body.branchId);

  const phoneNormalized = normalizePhone(body.phone);
  const emailNormalized = normalizeEmail(body.email);
  const duplicate = findDuplicateLead(ctx.tenantId, phoneNormalized, emailNormalized);

  const leadId = id('lead');
  transact(() => {
    db.insert(schema.leads)
      .values({
        id: leadId,
        tenantId: ctx.tenantId,
        branchId: body.branchId,
        name: body.name,
        phone: body.phone ?? null,
        email: body.email ?? null,
        phoneNormalized,
        emailNormalized,
        source: body.source,
        campaign: body.campaign ?? null,
        stage: 'new',
        ownerId,
        expectedValueMinor: body.expectedValueMinor,
        nextActionAt: body.nextActionAt ? Date.parse(body.nextActionAt) : null,
        nextActionLabel: body.nextActionLabel ?? null,
        lastTouchedAt: now(),
        lossReason: null,
        convertedMemberId: null,
        duplicateOfId: duplicate?.id ?? null,
        tags: body.tags,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    db.insert(schema.leadActivities)
      .values({
        id: id('lac'),
        tenantId: ctx.tenantId,
        leadId,
        kind: 'note',
        body: `Lead captured from ${body.source}${body.campaign ? ` (${body.campaign})` : ''}.`,
        actorId: ctx.userId,
        actorName: ctx.name,
        fromStage: null,
        toStage: 'new',
        at: now(),
      })
      .run();

    audit(ctx, { action: 'lead.created', entityType: 'lead', entityId: leadId, entityLabel: body.name, branchId: body.branchId });
    emitIntegrationEvent({
      tenantId: ctx.tenantId,
      branchId: body.branchId,
      type: 'lead.created',
      data: { leadId, branchId: body.branchId, source: body.source, stage: 'new', duplicateOfId: duplicate?.id ?? null },
    });
  });

  return c.json({ id: leadId, duplicateOfId: duplicate?.id ?? null }, 201);
});

const EditBody = z.object({
  ownerId: z.string().nullable().optional(),
  expectedValueMinor: z.number().int().min(0).optional(),
  nextActionAt: z.string().datetime().nullable().optional(),
  nextActionLabel: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

leadsRoutes.patch('/:leadId', validate('json', EditBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.manage');
  const leadId = c.req.param('leadId');
  const body = c.req.valid('json');

  const lead = loadLeadInScope(ctx, leadId);

  if (body.ownerId) assertValidOwner(ctx.tenantId, body.ownerId, lead.branchId);

  db.update(schema.leads)
    .set({
      ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
      ...(body.expectedValueMinor !== undefined ? { expectedValueMinor: body.expectedValueMinor } : {}),
      ...(body.nextActionAt !== undefined ? { nextActionAt: body.nextActionAt ? Date.parse(body.nextActionAt) : null } : {}),
      ...(body.nextActionLabel !== undefined ? { nextActionLabel: body.nextActionLabel } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      updatedAt: now(),
    })
    .where(eq(schema.leads.id, leadId))
    .run();

  audit(ctx, {
    action: 'lead.updated',
    entityType: 'lead',
    entityId: leadId,
    entityLabel: lead.name,
    before: { ownerId: lead.ownerId, expectedValueMinor: lead.expectedValueMinor },
    after: { ownerId: body.ownerId ?? lead.ownerId, expectedValueMinor: body.expectedValueMinor ?? lead.expectedValueMinor },
  });

  return c.json({ ok: true });
});

const StageBody = z.object({ to: LeadStage, reason: z.string().optional() });

leadsRoutes.post('/:leadId/stage', validate('json', StageBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.manage');
  const leadId = c.req.param('leadId');
  const { to, reason } = c.req.valid('json');

  const lead = loadLeadInScope(ctx, leadId);

  // "won" is reachable only through POST /:leadId/convert, which creates the
  // member atomically in the same transaction as the stage change — a bare
  // stage move must never produce a won lead with no member behind it.
  if (to === 'won') throw conflict('Use "Convert to member" to move a lead to won — a stage move alone cannot create the member.');

  const outcome = canTransitionLead({ from: lead.stage as LeadStage, to, reason });
  if (!outcome.ok) throw conflict(outcome.message);

  transact(() => {
    db.update(schema.leads)
      .set({
        stage: to,
        lastTouchedAt: now(),
        // Leaving lost/disqualified — including via reopened — always clears
        // the old reason; it no longer describes the lead's current state.
        lossReason: to === 'lost' || to === 'disqualified' ? (reason ?? null) : null,
        updatedAt: now(),
      })
      .where(eq(schema.leads.id, leadId))
      .run();

    db.insert(schema.leadActivities)
      .values({
        id: id('lac'),
        tenantId: ctx.tenantId,
        leadId,
        kind: 'stage_change',
        body: reason ?? `Moved from ${lead.stage} to ${to}.`,
        actorId: ctx.userId,
        actorName: ctx.name,
        fromStage: lead.stage,
        toStage: to,
        at: now(),
      })
      .run();

    audit(ctx, {
      action: 'lead.stage_changed',
      entityType: 'lead',
      entityId: leadId,
      entityLabel: lead.name,
      reason: reason ?? null,
      before: { stage: lead.stage },
      after: { stage: to },
    });
  });

  emit({
    tenantId: ctx.tenantId,
    branchId: lead.branchId,
    channel: channels.branch(lead.branchId),
    topic: 'lead.stage_changed',
    payload: { leadId, from: lead.stage, to },
  });

  return c.json({ ok: true, stage: to });
});

const ActivityBody = z.object({
  kind: z.enum(['note', 'call', 'message', 'email', 'tour', 'trial', 'task']),
  body: z.string().min(1),
  nextActionAt: z.string().datetime().nullable().optional(),
  nextActionLabel: z.string().nullable().optional(),
});

leadsRoutes.post('/:leadId/activities', validate('json', ActivityBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.manage');
  const leadId = c.req.param('leadId');
  const body = c.req.valid('json');

  loadLeadInScope(ctx, leadId);

  transact(() => {
    db.insert(schema.leadActivities)
      .values({
        id: id('lac'),
        tenantId: ctx.tenantId,
        leadId,
        kind: body.kind,
        body: body.body,
        actorId: ctx.userId,
        actorName: ctx.name,
        fromStage: null,
        toStage: null,
        at: now(),
      })
      .run();

    db.update(schema.leads)
      .set({
        lastTouchedAt: now(),
        ...(body.nextActionAt !== undefined ? { nextActionAt: body.nextActionAt ? Date.parse(body.nextActionAt) : null } : {}),
        ...(body.nextActionLabel !== undefined ? { nextActionLabel: body.nextActionLabel } : {}),
        updatedAt: now(),
      })
      .where(eq(schema.leads.id, leadId))
      .run();
  });

  return c.json({ ok: true });
});

/** §6.1 step: converts an open lead into a member. Creates a user + member
 *  row only — no membership/payment yet (Phase 3). The response says so. */
const CONVERTIBLE_STAGES = new Set<string>(['new', 'contacted', 'qualified', 'trial_booked', 'trial_completed', 'nurture', 'reopened']);

leadsRoutes.post('/:leadId/convert', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.manage');
  const leadId = c.req.param('leadId');

  const lead = loadLeadInScope(ctx, leadId);
  if (lead.convertedMemberId) throw conflict('This lead has already been converted.');
  // `won` is only reachable as a side effect of this endpoint — see
  // LEAD_STAGE_TRANSITIONS. Any open stage may convert: a walk-in who pays on
  // the spot should not be clicked through four pipeline stages first.
  if (!CONVERTIBLE_STAGES.has(lead.stage)) {
    throw conflict(
      lead.stage === 'won'
        ? 'This lead has already been converted.'
        : `This lead is ${lead.stage.replace(/_/g, ' ')}. Reopen it before converting.`,
    );
  }

  // Block a duplicate person rather than let a unique-index collision surface
  // as a raw 500, and rather than silently create a second record for
  // someone who already exists.
  const existingMember = findExistingMember(ctx.tenantId, lead.phoneNormalized, lead.emailNormalized);
  if (existingMember) {
    throw new AppError(
      'CONFLICT',
      `${lead.name} matches an existing member, ${existingMember.name}. Link this lead to that member instead of converting it separately.`,
      { details: { existingMemberId: existingMember.id } },
    );
  }
  if (lead.emailNormalized) {
    const orphanUser = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.email, lead.emailNormalized)))
      .get();
    if (orphanUser) throw conflict('That email is already used by another account in this gym. Resolve the conflict before converting.');
  }

  const result = transact(() => {
    const { memberId, memberNo } = enrollMember(ctx, { branchId: lead.branchId, name: lead.name, email: lead.emailNormalized, phone: lead.phone });

    db.update(schema.leads)
      .set({ stage: 'won', convertedMemberId: memberId, lastTouchedAt: now(), updatedAt: now() })
      .where(eq(schema.leads.id, leadId))
      .run();

    db.insert(schema.leadActivities)
      .values({
        id: id('lac'),
        tenantId: ctx.tenantId,
        leadId,
        kind: 'stage_change',
        body: `Converted to member ${memberNo}. Plan and payment are still pending.`,
        actorId: ctx.userId,
        actorName: ctx.name,
        fromStage: lead.stage,
        toStage: 'won',
        at: now(),
      })
      .run();

    audit(ctx, {
      action: 'lead.converted',
      entityType: 'lead',
      entityId: leadId,
      entityLabel: lead.name,
      after: { convertedMemberId: memberId, memberNo },
    });
    emitIntegrationEvent({ tenantId: ctx.tenantId, branchId: lead.branchId, type: 'lead.converted', data: { leadId, memberId, memberNo } });
    return { memberId, memberNo };
  });
  const { memberId, memberNo } = result;

  emit({
    tenantId: ctx.tenantId,
    branchId: lead.branchId,
    channel: channels.branch(lead.branchId),
    topic: 'lead.stage_changed',
    payload: { leadId, from: lead.stage, to: 'won' },
  });

  return c.json({
    ok: true,
    memberId,
    memberNo,
    message: `${lead.name} is now member ${memberNo}. Plan and payment are still pending — assign a plan from the member's profile once Billing is available.`,
  });
});
