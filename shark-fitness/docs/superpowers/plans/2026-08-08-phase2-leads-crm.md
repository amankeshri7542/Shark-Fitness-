# Phase 2 — Lead & Sales CRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, phase-by-phase, per user direction) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `leads.ts` / `Leads.tsx` / `LeadDetail.tsx` stubs with a working Lead & Sales CRM — pipeline board, lead detail with activity timeline, and lead-to-member conversion — closing the first two legs of the priority business journey (Lead → Member registration). Membership/payment assignment is explicitly deferred to Phase 3; conversion creates a member record only and says so.

**Architecture:** `apps/api/src/routes/admin/leads.ts` becomes a thin Hono adapter (matches `routes/admin/members.ts`). A new `apps/api/src/services/leads.ts` holds the one piece of business logic that has no home in `@shark/domain` (which is DO-NOT-EDIT and has no lead-stage-transition equivalent): the stage-transition graph, duplicate lookup, and SLA-breach computation. Frontend: `Leads.tsx` is a stage-board (UX-A02), `LeadDetail.tsx` is a single-record view with a timeline and an `ActionSheet`-style modal for stage moves and conversion (UX-A03), both built from `apps/admin-web/src/ui/console.tsx` primitives exactly as `Members.tsx`/`MemberDetail.tsx` already do.

**Tech Stack:** Hono, Drizzle ORM (better-sqlite3), Zod (`@shark/contracts`), Vitest (`apps/api/src/__tests__`), React 18, TanStack Router/Query, `@shark/domain` permissions.

## Global Constraints

- Every query filters on `ctx.tenantId`; branch-scoped queries also check `ctx.branchIds`/`ctx.activeBranchId` (BUILD-PLAN.md).
- Never import `zValidator` directly — always `validate(target, schema)` from `middleware/validate.js`.
- Any write that changes a lead's stage or converts it to a member calls `audit(ctx, {...})` inside the same `transact()` as the DB write.
- Stage changes emit `topic: 'lead.stage_changed'` via `emit()` from `lib/events.js`.
- Do not edit `packages/contracts`, `packages/domain`, `apps/api/src/db/schema`, `apps/api/src/app.ts`, `apps/admin-web/src/router.tsx` — all already wired for this slice (`leadsRoutes` mounted at `/v1/admin/leads`, `/leads` and `/leads/$leadId` routes registered).
- Money is integer minor units. Timestamps are epoch milliseconds via `now()` from `lib/time.js`. IDs via `id(prefix)` from `lib/ids.js` (`id('lead')`, `id('lac')` for activities, `id('mbr')`/`id('usr')` for conversion).
- Frontend: no raw divs for structure — `Panel`/`Seam`/`Chip`/`Button`/`Field`/`EmptyState`/`ErrorState`/`PermissionState`/`Skeleton` from `ui/console.tsx`, `Page` from `ui/shell.tsx`. Gate `Leads.tsx` on `usePermission('lead.view')`; gate mutating actions on `lead.manage`.
- The `LeadStage` enum (`packages/contracts/src/enums.ts:146-158`) is canonical: `new | contacted | qualified | trial_booked | trial_completed | nurture | won | lost | disqualified | reopened`. Do not use the PRD §4.3 prose labels (`New/Contacted/Appointment booked/...`) — they describe intent, the enum is what's implemented.
- Known, accepted limitations (do not silently work around with fabricated fields): no lead-level consent storage (log as a `leadActivities` note if consent must be recorded), no first-class "offer" entity (log as a `leadActivities` note), no per-lead task list (single `nextActionAt`/`nextActionLabel` only).

---

## File structure

- Create: `apps/api/src/services/leads.ts` — stage-transition graph, dedup lookup, SLA-breach helper. Pure functions + one DB-touching lookup.
- Modify: `apps/api/src/routes/admin/leads.ts` — replace the 7-line stub with the full route set.
- Create: `apps/api/src/__tests__/leads.integration.test.ts` — integration tests against the running Hono `app`, following `phase1.integration.test.ts`'s `signIn()`/`browserHeaders()` pattern.
- Modify: `apps/admin-web/src/screens/Leads.tsx` — replace the stub with the pipeline board/list.
- Modify: `apps/admin-web/src/screens/LeadDetail.tsx` — replace the stub with the detail view.

---

### Task 1: Lead service — stage transitions, dedup, SLA

**Files:**
- Create: `apps/api/src/services/leads.ts`
- Test: `apps/api/src/__tests__/leads.integration.test.ts` (stage-transition cases live in the route-level integration test, not a separate unit-test file — this repo has no `services/*.test.ts` precedent; `members.ts`'s equivalent logic (`canTransition` from `@shark/domain`) is only exercised via `phase1.integration.test.ts`-style route tests)

**Interfaces:**
- Produces: `LEAD_STAGE_TRANSITIONS: Record<LeadStage, LeadStage[]>`, `canTransitionLead(input: { from: LeadStage; to: LeadStage; reason?: string }): { ok: true } | { ok: false; message: string }`, `findDuplicateLead(tenantId: string, phoneNormalized: string | null, emailNormalized: string | null, excludeLeadId?: string): { id: string; name: string } | null`, `leadSlaBreached(lead: { stage: LeadStage; nextActionAt: number | null; lastTouchedAt: number | null; createdAt: number }, nowMs: number): boolean`.
- Consumes: `db`, `schema` from `../db/client.js`; `LeadStage` type from `@shark/contracts`.

- [ ] **Step 1: Write the service**

```typescript
// apps/api/src/services/leads.ts
import { and, eq, ne, or } from 'drizzle-orm';
import type { LeadStage } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { DAY } from '../lib/time.js';

/**
 * Canonical lead pipeline (PRD "Lead state machine"). `packages/domain` has no
 * equivalent — leads didn't exist when that package was written — so this
 * lives here rather than as a reimplementation inside the route handler.
 */
export const LEAD_STAGE_TRANSITIONS: Record<LeadStage, LeadStage[]> = {
  new: ['contacted', 'lost', 'disqualified'],
  contacted: ['qualified', 'nurture', 'lost', 'disqualified'],
  qualified: ['trial_booked', 'nurture', 'lost', 'disqualified'],
  trial_booked: ['trial_completed', 'nurture', 'lost', 'disqualified'],
  trial_completed: ['won', 'nurture', 'lost', 'disqualified'],
  nurture: ['contacted', 'qualified', 'trial_booked', 'lost', 'disqualified'],
  won: [],
  lost: ['reopened'],
  disqualified: ['reopened'],
  reopened: ['contacted', 'qualified', 'nurture'],
};

const REASON_REQUIRED: LeadStage[] = ['lost', 'disqualified'];

export function canTransitionLead(input: {
  from: LeadStage;
  to: LeadStage;
  reason?: string;
}): { ok: true } | { ok: false; message: string } {
  if (input.from === input.to) return { ok: false, message: 'Already in that stage.' };
  const allowed = LEAD_STAGE_TRANSITIONS[input.from] ?? [];
  if (!allowed.includes(input.to)) {
    return { ok: false, message: `A lead cannot move from ${input.from} to ${input.to} directly.` };
  }
  if (REASON_REQUIRED.includes(input.to) && !input.reason?.trim()) {
    return { ok: false, message: 'A reason is required to mark a lead lost or disqualified.' };
  }
  return { ok: true };
}

/** Same-tenant phone/email match, excluding the lead itself. First-touch
 *  attribution is preserved by the caller — this only *detects*, never merges. */
export function findDuplicateLead(
  tenantId: string,
  phoneNormalized: string | null,
  emailNormalized: string | null,
  excludeLeadId?: string,
): { id: string; name: string } | null {
  if (!phoneNormalized && !emailNormalized) return null;
  const matches = [
    phoneNormalized ? eq(schema.leads.phoneNormalized, phoneNormalized) : null,
    emailNormalized ? eq(schema.leads.emailNormalized, emailNormalized) : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  const row = db
    .select({ id: schema.leads.id, name: schema.leads.name })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.tenantId, tenantId),
        or(...matches),
        excludeLeadId ? ne(schema.leads.id, excludeLeadId) : undefined,
      ),
    )
    .get();

  return row ?? null;
}

const SLA_STALE_DAYS = 3;

/** PF-CRM-006: a lead is breaching SLA if it has an overdue next action, or
 *  has never been touched within the stale window and isn't in a terminal state. */
export function leadSlaBreached(
  lead: { stage: LeadStage; nextActionAt: number | null; lastTouchedAt: number | null; createdAt: number },
  nowMs: number,
): boolean {
  if (['won', 'lost', 'disqualified'].includes(lead.stage)) return false;
  if (lead.nextActionAt !== null) return lead.nextActionAt < nowMs;
  const lastTouch = lead.lastTouchedAt ?? lead.createdAt;
  return nowMs - lastTouch > SLA_STALE_DAYS * DAY;
}
```

- [ ] **Step 2: Typecheck the new file in isolation**

Run: `pnpm -F @shark/api typecheck`
Expected: no errors referencing `services/leads.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/leads.ts
git commit -m "feat(api): add lead stage-transition and dedup service"
```

---

### Task 2: `GET /v1/admin/leads` — pipeline list + `GET /:leadId` — detail

**Files:**
- Modify: `apps/api/src/routes/admin/leads.ts`

**Interfaces:**
- Consumes: `canTransitionLead`, `findDuplicateLead`, `leadSlaBreached` from `../../services/leads.js`; `requirePermission` from `../../lib/context.js`; `Lead`/`LeadActivity` shapes from `packages/contracts/src/schemas/ops.ts:12-49` (response must match these field-for-field since the frontend types against them).
- Produces: `leadsRoutes` (Hono instance), exported as before (`export const leadsRoutes = new Hono();`) — signature app.ts already imports must not change.

- [ ] **Step 1: Replace the stub with imports, list, and detail handlers**

```typescript
// apps/api/src/routes/admin/leads.ts
import { Hono } from 'hono';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { channels, LeadStage } from '@shark/contracts';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requirePermission } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { conflict, notFound } from '../../lib/errors.js';
import { id, initialsOf, normalizeEmail, normalizePhone } from '../../lib/ids.js';
import { now } from '../../lib/time.js';
import { LEAD_STAGE_TRANSITIONS, canTransitionLead, findDuplicateLead, leadSlaBreached } from '../../services/leads.js';

export const leadsRoutes = new Hono();

const ListQuery = z.object({
  q: z.string().optional(),
  stage: LeadStage.optional(),
  ownerId: z.string().optional(),
  slaBreached: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Pipeline (UX-A02). Returns every lead in scope plus a per-stage count so
 *  the board can render columns without a second round trip. */
leadsRoutes.get('/', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.view');
  const q = c.req.valid('query');

  const scope = ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
  const filters = [eq(schema.leads.tenantId, ctx.tenantId), inArray(schema.leads.branchId, scope)];
  if (q.stage) filters.push(eq(schema.leads.stage, q.stage));
  if (q.ownerId) filters.push(eq(schema.leads.ownerId, q.ownerId));
  if (q.q) {
    const term = `%${q.q.toLowerCase()}%`;
    filters.push(
      or(
        like(sql`lower(${schema.leads.name})`, term),
        like(schema.leads.phone, term),
        like(sql`lower(${schema.leads.email})`, term),
      )!,
    );
  }
  const where = and(...filters);

  const rows = db.select().from(schema.leads).where(where).orderBy(desc(schema.leads.createdAt)).limit(q.limit).offset(q.offset).all();

  const branchNames = new Map(db.select({ id: schema.branches.id, name: schema.branches.name }).from(schema.branches).all().map((b) => [b.id, b.name]));
  const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => x !== null))];
  const owners = ownerIds.length
    ? new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ownerIds)).all().map((u) => [u.id, u.name]))
    : new Map<string, string>();

  const nowMs = now();
  const items = rows.map((r) => ({
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
    slaBreached: leadSlaBreached(r, nowMs),
    duplicateOfId: r.duplicateOfId,
    tags: r.tags,
  }));

  const filtered = q.slaBreached ? items.filter((x) => x.slaBreached) : items;
  const byStage: Record<string, number> = {};
  for (const item of items) byStage[item.stage] = (byStage[item.stage] ?? 0) + 1;

  return c.json({ total: filtered.length, byStage, items: filtered });
});

/** Detail (UX-A03): lead + timeline + duplicate candidate + existing-member check. */
leadsRoutes.get('/:leadId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.view');
  const leadId = c.req.param('leadId');

  const lead = db.select().from(schema.leads).where(and(eq(schema.leads.id, leadId), eq(schema.leads.tenantId, ctx.tenantId))).get();
  if (!lead) throw notFound('That lead');

  const activities = db.select().from(schema.leadActivities).where(eq(schema.leadActivities.leadId, leadId)).orderBy(desc(schema.leadActivities.at)).all();

  const branch = db.select({ name: schema.branches.name }).from(schema.branches).where(eq(schema.branches.id, lead.branchId)).get();
  const owner = lead.ownerId ? db.select({ name: schema.users.name, accountState: schema.users.accountState }).from(schema.users).where(eq(schema.users.id, lead.ownerId)).get() : null;

  const duplicate = lead.duplicateOfId
    ? db.select({ id: schema.leads.id, name: schema.leads.name }).from(schema.leads).where(eq(schema.leads.id, lead.duplicateOfId)).get()
    : findDuplicateLead(ctx.tenantId, lead.phoneNormalized, lead.emailNormalized, lead.id);

  const existingMember = lead.convertedMemberId
    ? db.select({ id: schema.members.id, name: sql<string>`${schema.members.firstName} || ' ' || ${schema.members.lastName}` }).from(schema.members).where(eq(schema.members.id, lead.convertedMemberId)).get()
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
      slaBreached: leadSlaBreached(lead, now()),
      duplicateOfId: lead.duplicateOfId,
      tags: lead.tags,
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
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @shark/api typecheck`
Expected: no errors in `routes/admin/leads.ts` (the file still lacks the POST/PATCH handlers added in Task 3, which is fine — Hono routes are additive).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/admin/leads.ts
git commit -m "feat(api): add lead pipeline list and detail endpoints"
```

---

### Task 3: Lead mutations — create, edit, stage move, activity log, convert

**Files:**
- Modify: `apps/api/src/routes/admin/leads.ts` (append to the file built in Task 2)

**Interfaces:**
- Produces: `POST /`, `PATCH /:leadId`, `POST /:leadId/stage`, `POST /:leadId/activities`, `POST /:leadId/convert` on `leadsRoutes`.
- Consumes: `transact` from `../../db/client.js`; `id`, `initialsOf`, `normalizeEmail`, `normalizePhone` from `../../lib/ids.js` (already imported in Task 2).

- [ ] **Step 1: Append the mutation handlers**

```typescript
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
        ownerId: body.ownerId ?? ctx.userId,
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

  const lead = db.select().from(schema.leads).where(and(eq(schema.leads.id, leadId), eq(schema.leads.tenantId, ctx.tenantId))).get();
  if (!lead) throw notFound('That lead');

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

  const lead = db.select().from(schema.leads).where(and(eq(schema.leads.id, leadId), eq(schema.leads.tenantId, ctx.tenantId))).get();
  if (!lead) throw notFound('That lead');

  const outcome = canTransitionLead({ from: lead.stage as LeadStage, to, reason });
  if (!outcome.ok) throw conflict(outcome.message);

  transact(() => {
    db.update(schema.leads)
      .set({ stage: to, lastTouchedAt: now(), lossReason: to === 'lost' || to === 'disqualified' ? (reason ?? null) : lead.lossReason, updatedAt: now() })
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

  const lead = db.select().from(schema.leads).where(and(eq(schema.leads.id, leadId), eq(schema.leads.tenantId, ctx.tenantId))).get();
  if (!lead) throw notFound('That lead');

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

/** §6.1 step: converts a qualified lead into a member. Creates a user + member
 *  row only — no membership/payment yet (Phase 3). The response says so. */
leadsRoutes.post('/:leadId/convert', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'lead.manage');
  const leadId = c.req.param('leadId');

  const lead = db.select().from(schema.leads).where(and(eq(schema.leads.id, leadId), eq(schema.leads.tenantId, ctx.tenantId))).get();
  if (!lead) throw notFound('That lead');
  if (lead.convertedMemberId) throw conflict('This lead has already been converted.');

  const nameParts = lead.name.trim().split(/\s+/);
  const firstName = nameParts[0] ?? lead.name;
  const lastName = nameParts.slice(1).join(' ') || '—';

  const memberNoRow = db
    .select({ max: sql<number>`max(cast(substr(${schema.members.memberNo}, 4) as integer))` })
    .from(schema.members)
    .where(eq(schema.members.tenantId, ctx.tenantId))
    .get();
  const memberNo = `SF-${(memberNoRow?.max ?? 40000) + 1}`;

  const userId = id('usr');
  const memberId = id('mbr');

  transact(() => {
    db.insert(schema.users)
      .values({
        id: userId,
        tenantId: ctx.tenantId,
        email: lead.emailNormalized,
        phone: lead.phone,
        name: lead.name,
        initials: initialsOf(lead.name),
        role: 'member',
        accountState: 'active',
        passwordHash: null,
        preferences: { register: 'predator', theme: 'dark', unitSystem: 'metric', haptics: true, reducedMotion: false },
        lastSeenAt: null,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    db.insert(schema.members)
      .values({
        id: memberId,
        tenantId: ctx.tenantId,
        userId,
        homeBranchId: lead.branchId,
        memberNo,
        firstName,
        lastName,
        initials: initialsOf(lead.name),
        email: lead.emailNormalized,
        phone: lead.phone,
        phoneNormalized: lead.phoneNormalized,
        emailNormalized: lead.emailNormalized,
        dob: null,
        gender: null,
        addressLine: null,
        emergencyContact: null,
        lifecycle: 'trial',
        tags: [],
        trainerId: null,
        guardianId: null,
        corporateSponsorId: null,
        memberNotes: null,
        staffNotes: null,
        riskScore: null,
        riskReasons: null,
        joinedOn: new Date(now()).toISOString().slice(0, 10),
        lastVisitAt: null,
        mergedIntoId: null,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

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
  });

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
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @shark/api typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke test against the running API**

Run (API must be running on :8787 per docs/BUILD-PLAN.md):
```bash
TOKEN_COOKIE=$(curl -s -i -X POST localhost:8787/v1/auth/password \
  -H 'content-type: application/json' -H 'origin: http://localhost:5173' \
  -d '{"tenantSlug":"shark","email":"reception@sharkfitness.in","password":"shark1234"}' \
  | grep -i '^set-cookie' | sed -E 's/set-cookie: ([^;]+);.*/\1/')
curl -s localhost:8787/v1/admin/leads -H "cookie: $TOKEN_COOKIE" -H 'origin: http://localhost:5173' | head -c 500
```
Expected: a JSON body with `total`, `byStage`, `items` — 34 seeded leads should appear (per the earlier audit's finding that `seed.ts` already seeds 34 leads across every stage). Paste the real response into the phase report; do not claim it works without doing this.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/admin/leads.ts
git commit -m "feat(api): add lead create, edit, stage-move, activity-log, and convert endpoints"
```

---

### Task 4: Integration tests

**Files:**
- Create: `apps/api/src/__tests__/leads.integration.test.ts`

**Interfaces:**
- Consumes: `app` from `../app.js`, `db`/`schema`/`sqlite` from `../db/client.js` — same imports as `phase1.integration.test.ts`. Reuse its `signIn()`/`browserHeaders()` helpers by copying them into this file (the existing test file doesn't export them — grep confirmed no shared test-utils module exists yet; duplicating a ~15-line helper is consistent with the current one-file-per-feature test convention, not worth a new shared module for this phase).

- [ ] **Step 1: Write the test file**

```typescript
// apps/api/src/__tests__/leads.integration.test.ts
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}

async function signIn(email = 'reception@sharkfitness.in'): Promise<BrowserSession> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const setCookie = response.headers.get('set-cookie') ?? '';
  const session = setCookie.match(/shark_session=([^;,]+)/)?.[1];
  return { cookie: `shark_session=${session}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
}

function headers(session: BrowserSession, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

describe('admin leads', () => {
  it('lists seeded leads scoped to the tenant', async () => {
    const session = await signIn();
    const response = await app.request('/v1/admin/leads', { headers: headers(session) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; items: Array<{ stage: string }> };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((l) => typeof l.stage === 'string')).toBe(true);
  });

  it('creates a lead, detects a duplicate, and rejects an illegal stage jump', async () => {
    const session = await signIn();
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
    const branch = db.select().from(schema.branches).where(eq(schema.branches.tenantId, tenant.id)).get()!;

    const create = await app.request('/v1/admin/leads', {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({
        name: 'Integration Test Lead',
        phone: '+91 9000000001',
        source: 'walk_in',
        branchId: branch.id,
        expectedValueMinor: 500000,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };

    const dupe = await app.request('/v1/admin/leads', {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ name: 'Same Person Again', phone: '+91 9000000001', source: 'call', branchId: branch.id }),
    });
    expect(dupe.status).toBe(201);
    const dupeBody = (await dupe.json()) as { duplicateOfId: string | null };
    expect(dupeBody.duplicateOfId).toBe(created.id);

    const illegalJump = await app.request(`/v1/admin/leads/${created.id}/stage`, {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ to: 'won' }),
    });
    expect(illegalJump.status).toBe(409);

    const legalMove = await app.request(`/v1/admin/leads/${created.id}/stage`, {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ to: 'contacted' }),
    });
    expect(legalMove.status).toBe(200);
  });

  it('converts a lead to a member and blocks a second conversion', async () => {
    const session = await signIn();
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
    const branch = db.select().from(schema.branches).where(eq(schema.branches.tenantId, tenant.id)).get()!;

    const create = await app.request('/v1/admin/leads', {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ name: 'Convert Me', phone: '+91 9000000099', source: 'trial', branchId: branch.id }),
    });
    const { id: leadId } = (await create.json()) as { id: string };

    const convert = await app.request(`/v1/admin/leads/${leadId}/convert`, { method: 'POST', headers: headers(session, true) });
    expect(convert.status).toBe(200);
    const converted = (await convert.json()) as { memberId: string; memberNo: string; message: string };
    expect(converted.memberNo).toMatch(/^SF-\d+$/);
    expect(converted.message).toMatch(/pending/i);

    const member = db.select().from(schema.members).where(eq(schema.members.id, converted.memberId)).get();
    expect(member?.lifecycle).toBe('trial');

    const secondConvert = await app.request(`/v1/admin/leads/${leadId}/convert`, { method: 'POST', headers: headers(session, true) });
    expect(secondConvert.status).toBe(409);
  });

  it('rejects lead access for a role without lead.view', async () => {
    // trainer role does not have lead.view per packages/domain/src/permissions.ts
    const session = await signIn('rehan@sharkfitness.in');
    const response = await app.request('/v1/admin/leads', { headers: headers(session) });
    expect(response.status).toBe(403);
  });
});
```

Before writing this, confirm `rehan@sharkfitness.in` is actually a trainer-role account (docs/BUILD-PLAN.md lists it as a demo staff account but doesn't state the role) — check `apps/api/src/db/seed.ts`'s staff-seeding block; if it's a different role, substitute whichever seeded account has role `trainer`.

- [ ] **Step 2: Run the test file**

Run: `pnpm -F @shark/api test -- leads.integration`
Expected: all four tests pass. If the duplicate/permission assumptions don't match actual seed data, fix the test against reality — do not weaken the assertions to make them pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/leads.integration.test.ts
git commit -m "test(api): add lead pipeline, conversion, and permission integration tests"
```

---

### Task 5: `Leads.tsx` — pipeline board

**Files:**
- Modify: `apps/admin-web/src/screens/Leads.tsx`

**Interfaces:**
- Consumes: `GET /admin/leads` response shape from Task 2 (`{ total, byStage, items: LeadRow[] }`); `usePermission` from `../lib/store`; `api` from `../lib/api`; `Page` from `../ui/shell`; `Panel, Seam, Chip, Button, Field, EmptyState, ErrorState, PermissionState, Skeleton, cx` from `../ui/console`.
- Produces: default export `LeadsScreen` (signature unchanged — `router.tsx` imports it as `import LeadsScreen from './screens/Leads'`).

- [ ] **Step 1: Replace the stub**

```tsx
// apps/admin-web/src/screens/Leads.tsx
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, EmptyState, ErrorState, Field, Panel, PermissionState, Seam, Skeleton, cx, type Tone } from '../ui/console';

interface LeadRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string;
  stage: string;
  branchName: string;
  ownerName: string | null;
  expectedValueMinor: number;
  nextActionLabel: string | null;
  slaBreached: boolean;
  duplicateOfId: string | null;
  convertedMemberId: string | null;
}

interface LeadsPayload {
  total: number;
  byStage: Record<string, number>;
  items: LeadRow[];
}

const STAGES = ['new', 'contacted', 'qualified', 'trial_booked', 'trial_completed', 'nurture', 'won', 'lost', 'disqualified'] as const;

const STAGE_TONE: Record<string, Tone> = {
  new: 'neutral',
  contacted: 'accent',
  qualified: 'accent',
  trial_booked: 'accent',
  trial_completed: 'accent',
  nurture: 'warn',
  won: 'good',
  lost: 'bad',
  disqualified: 'bad',
  reopened: 'neutral',
};

export default function LeadsScreen() {
  const canView = usePermission('lead.view');
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['leads', search],
    queryFn: () => api<LeadsPayload>(`/admin/leads${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`),
    enabled: canView,
  });

  if (!canView) {
    return (
      <Page title="Leads">
        <PermissionState what="The lead pipeline" />
      </Page>
    );
  }

  if (isLoading) {
    return (
      <Page title="Leads" kicker="Loading">
        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </Page>
    );
  }

  if (error || !data) {
    return (
      <Page title="Leads">
        <ErrorState title="Could not load the pipeline" body="The API did not answer. Nothing has changed." onRetry={() => void refetch()} />
      </Page>
    );
  }

  const breachCount = data.items.filter((l) => l.slaBreached).length;

  return (
    <Page
      title="Leads"
      kicker={`${data.total} in view`}
      actions={<span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">{breachCount > 0 ? `${breachCount} overdue` : 'All on schedule'}</span>}
    >
      <div className="border-b border-line p-3.5">
        <Field label="Search" placeholder="Name, phone or email" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[320px]" />
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          title="No leads yet"
          body={search ? 'Nothing matches that search.' : 'Capture your first lead to start the pipeline.'}
          action={search ? <Button variant="outline" onClick={() => setSearch('')}>Clear search</Button> : undefined}
        />
      ) : (
        <div className="grid min-w-0 grid-flow-col auto-cols-[260px] gap-px overflow-x-auto bg-line">
          {STAGES.map((stage) => {
            const items = data.items.filter((l) => l.stage === stage);
            return (
              <Panel key={stage} title={`${stage.replace(/_/g, ' ')} · ${data.byStage[stage] ?? 0}`} className="bg-hull">
                <ul className="flex flex-col gap-2 p-2.5">
                  {items.map((lead) => (
                    <li key={lead.id}>
                      <Link to="/leads/$leadId" params={{ leadId: lead.id }} className="block border border-line-strong p-2.5 hover:border-sonar">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[13px]">{lead.name}</span>
                          {lead.slaBreached ? <Chip tone="bad">overdue</Chip> : null}
                        </div>
                        <div className="mt-1 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-45">
                          {lead.branchName} · {lead.source.replace(/_/g, ' ')}
                        </div>
                        {lead.duplicateOfId ? <Chip tone="warn" className="mt-1.5">possible duplicate</Chip> : null}
                        {lead.nextActionLabel ? <div className="mt-1.5 text-[11px] text-foam-65">{lead.nextActionLabel}</div> : null}
                      </Link>
                    </li>
                  ))}
                  {items.length === 0 ? <li className="p-2 text-[11px] text-foam-35">Empty</li> : null}
                </ul>
              </Panel>
            );
          })}
        </div>
      )}
    </Page>
  );
}
```

Note: this renders every non-terminal-plus-lost/disqualified stage as a column, including `won`/`lost`/`disqualified` so a rep can see recent outcomes; it deliberately excludes `reopened` as a column (it's a transient state that immediately moves elsewhere per `LEAD_STAGE_TRANSITIONS`) — if that reads oddly once real data is in front of you, adjust, but don't silently drop the `slaBreached`/duplicate/empty-state requirements from UX-A02 while doing so.

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @shark/admin-web typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin-web/src/screens/Leads.tsx
git commit -m "feat(admin-web): build the lead pipeline board"
```

---

### Task 6: `LeadDetail.tsx` — detail view with stage-move and convert actions

**Files:**
- Modify: `apps/admin-web/src/screens/LeadDetail.tsx`

**Interfaces:**
- Consumes: `GET /admin/leads/:leadId` response shape from Task 2; `POST /admin/leads/:leadId/stage`, `POST /admin/leads/:leadId/activities`, `POST /admin/leads/:leadId/convert` from Task 3. Router param name: confirm against `apps/admin-web/src/router.tsx` — `leadDetailRoute` uses `path: '/leads/$leadId'`, so `useParams({ from: '/console/leads/$leadId' })` (same pattern as `MemberDetail.tsx:85`).

- [ ] **Step 1: Replace the stub**

```tsx
// apps/admin-web/src/screens/LeadDetail.tsx
import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, Display, ErrorState, Field, Label, Panel, PermissionState, Seam, Skeleton, cx, type Tone } from '../ui/console';

interface Activity {
  id: string;
  kind: string;
  body: string;
  actorName: string;
  at: string;
  fromStage: string | null;
  toStage: string | null;
}

interface Detail {
  lead: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    source: string;
    stage: string;
    branchName: string;
    ownerName: string | null;
    expectedValueMinor: number;
    nextActionLabel: string | null;
    lossReason: string | null;
    convertedMemberId: string | null;
    slaBreached: boolean;
    tags: string[];
  };
  activities: Activity[];
  availableStages: string[];
  duplicate: { id: string; name: string } | null;
  ownerUnavailable: boolean;
  existingMember: { id: string; name: string } | null;
}

const STAGE_TONE: Record<string, Tone> = { won: 'good', lost: 'bad', disqualified: 'bad', nurture: 'warn' };

export default function LeadDetailScreen() {
  const { leadId } = useParams({ from: '/console/leads/$leadId' });
  const queryClient = useQueryClient();
  const canManage = usePermission('lead.manage');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError, refetch } = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => api<Detail>(`/admin/leads/${leadId}`),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const moveStage = useMutation({
    mutationFn: (to: string) => api(`/admin/leads/${leadId}/stage`, { method: 'POST', body: { to } }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  const logActivity = useMutation({
    mutationFn: () => api(`/admin/leads/${leadId}/activities`, { method: 'POST', body: { kind: 'note', body: note } }),
    onSuccess: () => {
      setNote('');
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  const convert = useMutation({
    mutationFn: () => api<{ memberId: string; message: string }>(`/admin/leads/${leadId}/convert`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  if (isLoading) {
    return (
      <Page title="Lead" kicker="Loading">
        <Skeleton className="m-4 h-64" />
      </Page>
    );
  }

  if (loadError || !data) {
    return (
      <Page title="Lead">
        <ErrorState title="Could not load this lead" body="The API did not answer. Nothing has changed." onRetry={() => void refetch()} />
      </Page>
    );
  }

  const { lead } = data;

  return (
    <Page title={lead.name} kicker={`${lead.branchName} · ${lead.source.replace(/_/g, ' ')}`}>
      <Seam className="border-b border-line" direction="y">
        <div className="flex flex-wrap items-center gap-2 p-3.5">
          <Chip tone={STAGE_TONE[lead.stage] ?? 'accent'}>{lead.stage.replace(/_/g, ' ')}</Chip>
          {lead.slaBreached ? <Chip tone="bad">follow-up overdue</Chip> : null}
          {data.duplicate ? (
            <Chip tone="warn">
              possible duplicate of{' '}
              <Link to="/leads/$leadId" params={{ leadId: data.duplicate.id }} className="underline">
                {data.duplicate.name}
              </Link>
            </Chip>
          ) : null}
          {data.ownerUnavailable ? <Chip tone="warn">owner unavailable</Chip> : null}
        </div>

        {data.existingMember ? (
          <Panel tone="good">
            <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">
              This lead is already a member.{' '}
              <Link to="/members/$memberId" params={{ memberId: data.existingMember.id }} className="underline">
                Open {data.existingMember.name}'s profile
              </Link>
              .
            </p>
          </Panel>
        ) : null}

        <Panel title="Contact">
          <div className="grid grid-cols-2 gap-3 p-3.5 text-[13px]">
            <div>
              <Label>Phone</Label>
              <div className="mt-1">{lead.phone ?? '—'}</div>
            </div>
            <div>
              <Label>Email</Label>
              <div className="mt-1">{lead.email ?? '—'}</div>
            </div>
            <div>
              <Label>Owner</Label>
              <div className="mt-1">{lead.ownerName ?? 'Unassigned'}</div>
            </div>
            <div>
              <Label>Expected value</Label>
              <div className="mt-1">₹{(lead.expectedValueMinor / 100).toLocaleString('en-IN')}</div>
            </div>
          </div>
        </Panel>

        {canManage && !lead.convertedMemberId ? (
          <Panel title="Actions">
            <div className="flex flex-wrap gap-2 p-3.5">
              {data.availableStages
                .filter((s) => !['lost', 'disqualified'].includes(s))
                .map((s) => (
                  <Button key={s} variant="outline" disabled={moveStage.isPending} onClick={() => moveStage.mutate(s)}>
                    Move to {s.replace(/_/g, ' ')}
                  </Button>
                ))}
              {data.availableStages.includes('lost') ? (
                <Button variant="danger" disabled={moveStage.isPending} onClick={() => moveStage.mutate('lost')}>
                  Mark lost
                </Button>
              ) : null}
              {lead.stage === 'trial_completed' || lead.stage === 'won' ? (
                <Button variant="cta" disabled={convert.isPending} onClick={() => convert.mutate()}>
                  {convert.isPending ? 'Converting…' : 'Convert to member'}
                </Button>
              ) : null}
            </div>
            {convert.isSuccess ? (
              <Panel tone="good">
                <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">{convert.data.message}</p>
              </Panel>
            ) : null}
            {error ? (
              <Panel tone="bad">
                <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">{error}</p>
              </Panel>
            ) : null}
          </Panel>
        ) : null}

        <Panel title="Timeline">
          {canManage ? (
            <div className="flex gap-2 border-b border-line p-3.5">
              <Field label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} className="flex-1" />
              <Button
                variant="outline"
                disabled={!note.trim() || logActivity.isPending}
                onClick={() => logActivity.mutate()}
                className="self-end"
              >
                Log
              </Button>
            </div>
          ) : null}
          <ul className="flex flex-col gap-0 divide-y divide-line">
            {data.activities.length === 0 ? (
              <li className="p-3.5 text-[12px] text-foam-45">No activity yet.</li>
            ) : (
              data.activities.map((a) => (
                <li key={a.id} className="p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.1em] text-foam-45">{a.kind.replace(/_/g, ' ')}</span>
                    <span className="text-[11px] text-foam-35">{new Date(a.at).toLocaleString('en-GB')}</span>
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed">{a.body}</p>
                  <p className="mt-1 text-[11px] text-foam-45">{a.actorName}</p>
                </li>
              ))
            )}
          </ul>
        </Panel>
      </Seam>
    </Page>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @shark/admin-web typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin-web/src/screens/LeadDetail.tsx
git commit -m "feat(admin-web): build the lead detail screen with stage moves and conversion"
```

---

### Task 7: Full verification pass

- [ ] **Step 1: Typecheck every workspace**

Run: `pnpm -F @shark/api typecheck && pnpm -F @shark/member-pwa typecheck && pnpm -F @shark/admin-web typecheck`
Expected: all pass with zero errors.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm -F @shark/api test`
Expected: all tests pass, including the 4 new lead tests and the existing `phase1.integration.test.ts` + domain package's 101 tests (if `test` is wired at the root, otherwise also run `pnpm -F @shark/domain test`).

- [ ] **Step 3: Build every app**

Run: `pnpm -F @shark/api build && pnpm -F @shark/member-pwa build && pnpm -F @shark/admin-web build`
Expected: all succeed.

- [ ] **Step 4: Manual UI smoke test**

Start the API and admin-web dev servers, sign in as `owner@sharkfitness.in` / `shark1234`, navigate to `/leads`, confirm the board renders seeded leads across stages, open a lead, move its stage, log a note, and (on a `trial_completed` lead) convert it and confirm the resulting member appears at `/members/:id`.

- [ ] **Step 5: Final commit for the phase**

```bash
git add -A
git commit -m "chore: verify phase 2 (typecheck, tests, build) passes"
```
