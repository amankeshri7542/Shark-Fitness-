import { Hono } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  MfaResetInput,
  STAFF_IDLE_TIMEOUT_MINUTES,
  SecuritySettingsPatch,
  type SecuritySettings,
  type StaffMfaRow,
} from '@shark/contracts';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { audit } from '../../lib/audit.js';
import { requirePermission } from '../../lib/context.js';
import { forbidden } from '../../lib/errors.js';
import { requireFreshAuth } from '../../lib/step-up.js';
import { now } from '../../lib/time.js';
import { loadStaffInScope } from '../../services/staff.js';
import { MFA_MANDATORY_ROLES, mfaRequirement, resetMfaFor } from '../../services/mfa.js';

/**
 * Settings → Security (PRD 04 ENT-IAM-001/003). Mounted at `/v1/admin/security`.
 *
 * The gym decides two things: whether every member of staff must use two-step
 * sign-in (owners, regional managers and platform staff always must), and how
 * long a staff session may sit idle. Owners can also clear a colleague's lost
 * authenticator; their own goes through platform support.
 */
export const securityRoutes = new Hono();

function settingsFor(tenantId: string): SecuritySettings {
  const policy = (db.select({ policy: schema.tenants.policy }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()?.policy ??
    {}) as Record<string, unknown>;
  const minutes = Number(policy.staffIdleTimeoutMinutes);
  return {
    requireMfaForStaff: policy.requireMfaForStaff === true,
    staffIdleTimeoutMinutes:
      Number.isInteger(minutes) && minutes >= STAFF_IDLE_TIMEOUT_MINUTES.min && minutes <= STAFF_IDLE_TIMEOUT_MINUTES.max
        ? minutes
        : STAFF_IDLE_TIMEOUT_MINUTES.default,
    mandatoryRoles: [...MFA_MANDATORY_ROLES],
  };
}

securityRoutes.get('/settings', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'settings.manage');
  return c.json(settingsFor(ctx.tenantId));
});

/** Loosening or tightening sign-in rules is a security change: step-up first. */
securityRoutes.patch('/settings', validate('json', SecuritySettingsPatch), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'settings.manage');
  requireFreshAuth(ctx, 'settings.security');
  const patch = c.req.valid('json');
  transact(() => {
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get()!;
    const before = settingsFor(ctx.tenantId);
    const policy = { ...(tenant.policy ?? {}), ...patch };
    db.update(schema.tenants).set({ policy, updatedAt: now() }).where(eq(schema.tenants.id, ctx.tenantId)).run();
    audit(ctx, {
      action: 'settings.security_updated',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      entityLabel: tenant.displayName,
      before: { requireMfaForStaff: before.requireMfaForStaff, staffIdleTimeoutMinutes: before.staffIdleTimeoutMinutes },
      after: { requireMfaForStaff: patch.requireMfaForStaff ?? before.requireMfaForStaff, staffIdleTimeoutMinutes: patch.staffIdleTimeoutMinutes ?? before.staffIdleTimeoutMinutes },
    });
  });
  return c.json(settingsFor(ctx.tenantId));
});

/** Who has two-step sign-in, who must, and whose factor is locked. */
securityRoutes.get('/staff-mfa', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'staff.manage');
  const staff = db
    .select({ id: schema.staff.id, userId: schema.staff.userId, branchIds: schema.staff.branchIds })
    .from(schema.staff)
    .where(eq(schema.staff.tenantId, ctx.tenantId))
    .all()
    .filter((row) => row.branchIds.some((branchId) => ctx.branchIds.includes(branchId)));
  const userIds = staff.map((row) => row.userId).filter((value): value is string => Boolean(value));
  const users = userIds.length
    ? db.select().from(schema.users).where(and(inArray(schema.users.id, userIds), isNull(schema.users.deletedAt))).all()
    : [];
  const factors = userIds.length ? db.select().from(schema.userMfa).where(inArray(schema.userMfa.userId, userIds)).all() : [];
  const at = now();
  const items: StaffMfaRow[] = staff
    .map((row) => {
      const user = users.find((candidate) => candidate.id === row.userId);
      if (!user) return null;
      const factor = factors.find((candidate) => candidate.userId === user.id);
      return {
        staffId: row.id,
        userId: user.id,
        name: user.name,
        role: user.role,
        enrolled: Boolean(factor?.confirmedAt),
        required: mfaRequirement(user).required,
        enrolledAt: factor?.confirmedAt ? new Date(factor.confirmedAt).toISOString() : null,
        lockedUntil: factor?.lockedUntil && factor.lockedUntil > at ? new Date(factor.lockedUntil).toISOString() : null,
      };
    })
    .filter((row): row is StaffMfaRow => row !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ items });
});

/**
 * Owner-assisted reset for a colleague who lost their phone. Only an owner,
 * never for themselves (that is platform support's job), with a reason that
 * goes into the audit log. The colleague is signed out everywhere and meets
 * the enrolment gate at their next sign-in.
 */
securityRoutes.post('/staff/:staffId/mfa/reset', validate('json', MfaResetInput), (c) => {
  const ctx = ctxOf(c);
  if (ctx.role !== 'owner') throw forbidden('Only the gym owner can reset someone’s two-step sign-in.');
  const staff = loadStaffInScope(ctx, c.req.param('staffId'));
  if (staff.userId === ctx.userId) {
    throw forbidden('You cannot reset your own two-step sign-in. Contact Shark Fitness support, who will check it is you.');
  }
  requireFreshAuth(ctx, 'staff.mfa_reset');
  const user = db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, staff.userId ?? ''), eq(schema.users.tenantId, ctx.tenantId)))
    .get();
  if (!user) throw forbidden('That person has no sign-in account.');
  transact(() => resetMfaFor(ctx, user, c.req.valid('json').reason, 'owner'));
  return c.json({ ok: true });
});
