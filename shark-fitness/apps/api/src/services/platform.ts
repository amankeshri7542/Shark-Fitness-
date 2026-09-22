import { and, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type {
  EntitlementsInput,
  ImpersonateInput,
  ImpersonationSession,
  PlatformHealth,
  TenantDetail,
  TenantMeter,
  TenantStatus,
  TenantStatusInput,
  TenantSummary,
} from '@shark/contracts';
import {
  IMPERSONATION_MINUTES,
  TENANT_STATUSES,
  archiveBlockers,
  canImpersonate,
  canTransitionTenant,
  impersonationRemaining,
  meterHealth,
  meterPercent,
  nextTenantStatuses,
  suspensionNotice,
} from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound, precondition } from '../lib/errors.js';
import { now } from '../lib/time.js';
import { scheduledJobs } from '../jobs/scheduler.js';
import { createSession, revokeSession } from './auth.js';
import type { RequestContext } from '../lib/context.js';

/**
 * Platform administration (PF-PLAT-001…006).
 *
 * **This module is the only place in the product that reads across tenants.**
 * Every other service filters on `ctx.tenantId` and there is no code path
 * through them that does not. That is a property worth being able to state
 * plainly, so the cross-tenant reads are confined here, behind the
 * `platformOnly` middleware, and nothing outside imports from this file.
 *
 * Three rules run through it.
 *
 * **Support access is borrowed, never held.** An impersonated session carries
 * the target's authority and none of the operator's: it cannot reach this
 * module, cannot start a second impersonation, and expires on a clock it
 * cannot extend. The permissions are stripped in `resolveSession` as well as
 * refused at the door, because a route that forgets its guard should still
 * find nothing to use.
 *
 * **Every action here is audited into the tenant it acted on**, not into a
 * private platform log. The gym can read what support did to it, under the
 * operator's own name, with the reason they gave. A support tool whose
 * activity only the vendor can see is a tool nobody should agree to.
 *
 * **Immutability is not a permission** (PF-PLAT-006). There is no path here to
 * edit an invoice, a ledger row or an audit entry. The append-only triggers do
 * not check who is asking, and this module deliberately offers nothing that
 * would want them to.
 */

/* ——— Reading ————————————————————————————————————————————— */

const iso = (ms: number): string => new Date(ms).toISOString();

const one = (v: number | undefined): number => v ?? 0;

function metersFor(tenantId: string): TenantMeter[] {
  const period = new Date(now()).toISOString().slice(0, 7);
  return db
    .select()
    .from(schema.usageMeters)
    .where(and(eq(schema.usageMeters.tenantId, tenantId), eq(schema.usageMeters.period, period)))
    .all()
    .map((row) => ({
      meter: row.meter,
      period: row.period,
      used: row.used,
      limit: row.limitValue,
      health: meterHealth(row.used, row.limitValue),
      percent: meterPercent(row.used, row.limitValue),
    }));
}

function countsFor(tenantId: string) {
  const branches = db.select({ state: schema.branches.state }).from(schema.branches).where(eq(schema.branches.tenantId, tenantId)).all();
  return {
    branches: branches.length,
    activeBranches: branches.filter((b) => b.state === 'active').length,
    members: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.members)
        .where(and(eq(schema.members.tenantId, tenantId), isNull(schema.members.deletedAt))).get()?.n,
    ),
    staff: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.staff)
        .where(and(eq(schema.staff.tenantId, tenantId), ne(schema.staff.employmentStatus, 'former'))).get()?.n,
    ),
    checkIns30d: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.checkIns)
        .where(and(eq(schema.checkIns.tenantId, tenantId), gt(schema.checkIns.enteredAt, now() - 30 * 86_400_000))).get()?.n,
    ),
  };
}

function toSummary(row: typeof schema.tenants.$inferSelect): TenantSummary {
  const status = row.status as TenantStatus;
  const rules = TENANT_STATUSES[status];
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    legalName: row.legalName,
    plan: row.plan,
    status,
    statusMeaning: rules.meaning,
    operational: rules.operational,
    billable: rules.billable,
    currency: row.currency,
    createdAt: iso(row.createdAt),
    counts: countsFor(row.id),
    metersNeedingAttention: metersFor(row.id).filter((m) => m.health === 'approaching' || m.health === 'exceeded'),
  };
}

/**
 * Every customer.
 *
 * The operator's own tenant is excluded: it holds the platform staff, has no
 * gyms, and showing an operator its own record in a list titled "customers" is
 * a confusion with no upside. `kind` marks it explicitly rather than the list
 * inferring it from a slug.
 */
export function listTenants(_ctx: RequestContext): { items: TenantSummary[] } {
  const rows = db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.kind, 'customer'))
    .orderBy(schema.tenants.displayName)
    .all();
  return { items: rows.map(toSummary) };
}

function tenantRow(tenantId: string) {
  const row = db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  if (!row) throw notFound('That gym');
  if (row.kind !== 'customer') throw notFound('That gym');
  return row;
}

function archiveFacts(tenantId: string, atMs = now()): {
  legalHolds: number;
  liveClassesNow: number;
  unpaidMinor: number;
} {
  return {
    legalHolds: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.users)
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.accountState, 'legal_hold'))).get()?.n,
    ),
    liveClassesNow: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.classSessions)
        .where(and(
          eq(schema.classSessions.tenantId, tenantId),
          eq(schema.classSessions.state, 'scheduled'),
          sql`${schema.classSessions.startsAt} <= ${atMs}`,
          sql`${schema.classSessions.endsAt} >= ${atMs}`,
        )).get()?.n,
    ),
    // Receivables are immutable accounting history, not a reason to leave a
    // customer tenant operational forever. Return the actual balance in the
    // refusal details so offboarding can resolve it deliberately.
    unpaidMinor: one(
      db.select({ n: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}), 0)` })
        .from(schema.invoices)
        .where(and(
          eq(schema.invoices.tenantId, tenantId),
          eq(schema.invoices.voided, false),
          sql`${schema.invoices.voided} = 0 and ${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`,
        )).get()?.n,
    ),
  };
}

export function tenantDetail(_ctx: RequestContext, tenantId: string): TenantDetail {
  const row = tenantRow(tenantId);
  const status = row.status as TenantStatus;

  const insideNow = one(
    db.select({ n: sql<number>`count(*)` }).from(schema.checkIns)
      .where(and(eq(schema.checkIns.tenantId, tenantId), eq(schema.checkIns.decision, 'granted'), isNull(schema.checkIns.exitedAt))).get()?.n,
  );
  const liveClasses = one(
    db.select({ n: sql<number>`count(*)` }).from(schema.classSessions)
      .where(and(
        eq(schema.classSessions.tenantId, tenantId),
        eq(schema.classSessions.state, 'scheduled'),
        sql`${schema.classSessions.startsAt} <= ${now()}`,
        sql`${schema.classSessions.endsAt} >= ${now()}`,
      )).get()?.n,
  );

  return {
    ...toSummary(row),
    timezone: row.timezone,
    locale: row.locale,
    featureFlags: row.featureFlags ?? {},
    quotas: row.quotas ?? {},
    meters: metersFor(tenantId),
    nextStatuses: nextTenantStatuses(status),
    legalHolds: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.users)
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.accountState, 'legal_hold'))).get()?.n,
    ),
    suspensionNotice: suspensionNotice(liveClasses, insideNow),
    owners: db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.users.role, accountState: schema.users.accountState })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), inArray(schema.users.role, ['owner', 'regional_manager'])))
      .all(),
    recentActions: db
      .select({ at: schema.auditLog.at, actorName: schema.auditLog.actorName, action: schema.auditLog.action, reason: schema.auditLog.reason })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId), sql`${schema.auditLog.action} like 'platform.%' or ${schema.auditLog.action} like 'support.%'`))
      .orderBy(desc(schema.auditLog.at))
      .limit(20)
      .all()
      .map((r) => ({ at: iso(r.at), actorName: r.actorName, action: r.action, reason: r.reason })),
  };
}

export function platformHealth(_ctx: RequestContext): PlatformHealth {
  const tenants = db.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.kind, 'customer')).all();
  const byStatus = (status: string): number => tenants.filter((t) => t.status === status).length;

  const attention: PlatformHealth['metersNeedingAttention'] = [];
  for (const row of db.select().from(schema.tenants).where(eq(schema.tenants.kind, 'customer')).all()) {
    for (const meter of metersFor(row.id)) {
      if (meter.health === 'approaching' || meter.health === 'exceeded') {
        attention.push({ ...meter, tenantId: row.id, tenantName: row.displayName });
      }
    }
  }

  return {
    computedAt: iso(now()),
    tenants: {
      total: tenants.length,
      active: byStatus('active'),
      trial: byStatus('trial'),
      suspended: byStatus('suspended'),
      archived: byStatus('archived'),
    },
    members: one(db.select({ n: sql<number>`count(*)` }).from(schema.members).where(isNull(schema.members.deletedAt)).get()?.n),
    checkIns24h: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.checkIns).where(gt(schema.checkIns.enteredAt, now() - 86_400_000)).get()?.n,
    ),
    jobs: scheduledJobs(),
    outboxPending: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.outboxEvents).where(isNull(schema.outboxEvents.deliveredAt)).get()?.n,
    ),
    activeSupportSessions: one(
      db.select({ n: sql<number>`count(*)` }).from(schema.sessions)
        .where(and(
          sql`${schema.sessions.impersonatorId} is not null`,
          isNull(schema.sessions.revokedAt),
          gt(schema.sessions.impersonationExpiresAt, now()),
        )).get()?.n,
    ),
    metersNeedingAttention: attention,
  };
}

/* ——— Writing ————————————————————————————————————————— */

export function setTenantStatus(ctx: RequestContext, tenantId: string, input: TenantStatusInput): TenantDetail {
  const row = tenantRow(tenantId);
  const from = row.status as TenantStatus;

  const transition = canTransitionTenant(from, input.status);
  if (!transition.ok) throw precondition(transition.message);

  if (input.status === 'archived') {
    const facts = archiveFacts(tenantId);
    const blockers = archiveBlockers(facts);
    // A hold is placed by somebody outside this product. Support clearing it by
    // offboarding the tenant is the exact failure PF-PLAT-005 names, so this
    // refusal has no acknowledgement path at all.
    if (!blockers.ok) throw conflict(blockers.message, facts);
  }

  transact(() => {
    db.update(schema.tenants).set({ status: input.status, updatedAt: now() }).where(eq(schema.tenants.id, tenantId)).run();

    // Suspension and offboarding end every live session in that gym. Leaving
    // them signed in would make "suspended" mean "suspended at next login",
    // which is not what anybody suspending a tenant intends.
    if (!TENANT_STATUSES[input.status].operational) {
      db.update(schema.sessions).set({ revokedAt: now() })
        .where(and(eq(schema.sessions.tenantId, tenantId), isNull(schema.sessions.revokedAt))).run();
    }

    auditIntoTenant(ctx, tenantId, {
      action: `platform.tenant.${input.status}`,
      entityType: 'tenant',
      entityId: tenantId,
      entityLabel: row.displayName,
      reason: input.reason,
      before: { status: from },
      after: { status: input.status, approvedBy: input.approvedBy ?? null },
    });
  });

  return tenantDetail(ctx, tenantId);
}

export function setEntitlements(ctx: RequestContext, tenantId: string, input: EntitlementsInput): TenantDetail {
  const row = tenantRow(tenantId);

  const nextFlags = { ...(row.featureFlags ?? {}), ...(input.featureFlags ?? {}) };
  const nextQuotas = { ...(row.quotas ?? {}), ...(input.quotas ?? {}) };

  transact(() => {
    db.update(schema.tenants)
      .set({ plan: input.plan ?? row.plan, featureFlags: nextFlags, quotas: nextQuotas, updatedAt: now() })
      .where(eq(schema.tenants.id, tenantId))
      .run();

    // Quotas are what the meters are read against, so raising one has to reach
    // the meter rows or the console keeps reporting the old ceiling.
    for (const [meter, limitValue] of Object.entries(input.quotas ?? {})) {
      const key = METER_FOR_QUOTA[meter];
      if (!key) continue;
      db.update(schema.usageMeters).set({ limitValue, updatedAt: now() })
        .where(and(eq(schema.usageMeters.tenantId, tenantId), eq(schema.usageMeters.meter, key))).run();
    }

    auditIntoTenant(ctx, tenantId, {
      action: 'platform.entitlements.updated',
      entityType: 'tenant',
      entityId: tenantId,
      entityLabel: row.displayName,
      reason: input.reason,
      before: { plan: row.plan, featureFlags: row.featureFlags ?? {}, quotas: row.quotas ?? {} },
      after: { plan: input.plan ?? row.plan, featureFlags: nextFlags, quotas: nextQuotas },
    });
  });

  return tenantDetail(ctx, tenantId);
}

/** Quota keys are what a contract is written in; meter keys are what the
 *  product counts. They are not the same words and never have been. */
const METER_FOR_QUOTA: Record<string, string> = {
  smsPerMonth: 'sms',
  videoMinutesPerMonth: 'video_minutes',
  aiCallsPerMonth: 'ai_calls',
};

/* ——— Support access (PF-PLAT-004) ————————————————————————— */

export function startImpersonation(
  ctx: RequestContext,
  input: ImpersonateInput,
  ip: string,
  userAgent: string,
): { session: ImpersonationSession; token: string } {
  const target = db.select().from(schema.users).where(eq(schema.users.id, input.userId)).get();
  if (!target) throw notFound('That account');

  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, target.tenantId)).get();
  if (!tenant) throw notFound('That gym');

  const outcome = canImpersonate({
    actorRole: ctx.role,
    actorIsImpersonating: ctx.impersonatorId !== null,
    targetRole: target.role,
    targetTenantStatus: tenant.status as TenantStatus,
    targetAccountState: target.accountState,
    reason: input.reason,
  });
  if (!outcome.ok) throw forbidden(outcome.message);

  const created = createSession(target.id, target.tenantId, ip, userAgent, ctx.userId);
  const expiresAt = now() + IMPERSONATION_MINUTES * 60_000;

  // Into the gym's own audit log, under the operator's name, with the stated
  // reason. A support tool whose activity only the vendor can see is a tool
  // nobody should agree to.
  auditIntoTenant(ctx, target.tenantId, {
    action: 'support.impersonation.started',
    entityType: 'user',
    entityId: target.id,
    entityLabel: target.name,
    reason: input.reason,
    after: { operator: ctx.name, operatorId: ctx.userId, expiresAt: iso(expiresAt), minutes: IMPERSONATION_MINUTES },
  });

  return {
    token: created.token,
    session: {
      tenantId: tenant.id,
      tenantName: tenant.displayName,
      userId: target.id,
      userName: target.name,
      role: target.role,
      expiresAt: iso(expiresAt),
      minutesRemaining: IMPERSONATION_MINUTES,
    },
  };
}

/**
 * Ends a support session.
 *
 * Called *by the impersonated session itself* — the banner's exit button — so
 * this is the one platform-adjacent operation an impersonated caller may
 * perform. It revokes their own session and nothing else, which is why it does
 * not sit behind `platformOnly`.
 */
export function endImpersonation(ctx: RequestContext): { ok: true } {
  if (!ctx.impersonatorId) throw precondition('This is not a support session.');

  const operator = db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, ctx.impersonatorId)).get();

  auditIntoTenant(ctx, ctx.tenantId, {
    action: 'support.impersonation.ended',
    entityType: 'user',
    entityId: ctx.userId,
    entityLabel: ctx.name,
    after: { operator: operator?.name ?? ctx.impersonatorId, operatorId: ctx.impersonatorId },
  });

  revokeSession(ctx.sessionId);
  return { ok: true };
}

/** The banner's contents, or null when this is an ordinary session. */
export function impersonationBanner(ctx: RequestContext) {
  if (!ctx.impersonatorId) return null;
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, ctx.sessionId)).get();
  const operator = db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, ctx.impersonatorId)).get();
  const tenant = db.select({ displayName: schema.tenants.displayName }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get();
  const expiresAt = session?.impersonationExpiresAt ?? null;

  return {
    active: true as const,
    operatorName: operator?.name ?? 'Platform support',
    tenantName: tenant?.displayName ?? '',
    userName: ctx.name,
    minutesRemaining: impersonationRemaining(expiresAt, now()),
    expiresAt: expiresAt ? iso(expiresAt) : iso(now()),
  };
}

/* ——— Audit ————————————————————————————————————————————— */

/**
 * Writes into the tenant that was acted on, not the operator's own.
 *
 * `audit()` records `ctx.tenantId`, which for a platform operator is the
 * platform's tenant — exactly the wrong place. The gym has to be able to read
 * what was done to it.
 */
function auditIntoTenant(
  ctx: RequestContext,
  tenantId: string,
  input: Parameters<typeof audit>[1],
): void {
  audit({ ...ctx, tenantId, activeBranchId: null }, input);
}
