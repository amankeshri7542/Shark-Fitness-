import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import type { RequestContext } from '../lib/context.js';
import { constantTimeEqual, hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { forbidden, invalid } from '../lib/errors.js';
import { id, token } from '../lib/ids.js';
import { MINUTE, now } from '../lib/time.js';
import { disconnectUser } from '../realtime/hub.js';
import { OPERATIONAL_TENANT_STATUSES, resolveSessionById, revokeAccountChallenges } from './auth.js';
import { loadMemberInScope } from './members.js';
import { loadStaffInScope } from './staff.js';

const freshPassword = z.string().min(1).max(128);
const verifiedHandoff = {
  currentPassword: freshPassword,
  identityVerified: z.literal(true),
  reason: z.string().trim().min(10).max(500),
};
export const IssueRecoveryInput = z.union([
  z.object({ memberId: z.string().min(1).max(128), ...verifiedHandoff }).strict(),
  z.object({ staffId: z.string().min(1).max(128), ...verifiedHandoff }).strict(),
]);
export const RedeemRecoveryInput = z.object({
  recoveryId: z.string().min(1).max(128),
  token: z.string().min(32).max(256),
  password: z.string().min(12).max(128),
}).strict();

/** Call inside the write transaction; route must also use actor-based rate limiting. */
export function requireFreshOwner(ctx: RequestContext, password: string): void {
  const live = resolveSessionById(ctx.sessionId);
  const owner = db.select().from(schema.users).where(and(eq(schema.users.id, ctx.userId), eq(schema.users.tenantId, ctx.tenantId))).get();
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get();
  if (ctx.impersonatorId || ctx.role !== 'owner' || !live || live.impersonatorId || live.role !== 'owner' ||
      live.userId !== ctx.userId || live.tenantId !== ctx.tenantId || tenant?.kind !== 'customer' || !owner?.passwordHash) {
    throw forbidden('Only the gym owner, signed in directly, can authorize this change.');
  }
  if (!freshPassword.safeParse(password).success || !verifyPassword(password, owner.passwordHash)) {
    throw forbidden('Re-enter your current owner password to authorize this change.');
  }
}

const recoverableRoles = new Set(['member', 'regional_manager', 'branch_manager', 'reception', 'trainer', 'accountant']);
type User = typeof schema.users.$inferSelect;
function eligibleAccount(tenantId: string, userId: string | null): User {
  const user = userId ? db.select().from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.tenantId, tenantId))).get() : undefined;
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  if (!user || user.deletedAt !== null || user.accountState !== 'active' || !user.passwordHash || !user.email ||
      !recoverableRoles.has(user.role) || tenant?.kind !== 'customer' || !OPERATIONAL_TENANT_STATUSES.includes(tenant.status as typeof OPERATIONAL_TENANT_STATUSES[number])) {
    throw invalid('This account is not eligible for recovery. New accounts need first-time activation; disabled and owner accounts cannot use this process.');
  }
  if (user.role === 'member') {
    const member = db.select().from(schema.members).where(and(eq(schema.members.tenantId, tenantId), eq(schema.members.userId, user.id), isNull(schema.members.deletedAt))).get();
    if (!member || member.mergedIntoId !== null) throw invalid('This member account is not eligible for recovery.');
  } else {
    const staff = db.select().from(schema.staff).where(and(eq(schema.staff.tenantId, tenantId), eq(schema.staff.userId, user.id))).get();
    if (!staff || staff.employmentStatus !== 'active') throw invalid('Only currently employed staff accounts are eligible for recovery.');
  }
  return user;
}

// Changing login identity, credentials or authority invalidates an outstanding handoff.
function identityHash(user: User): string {
  return hashToken(JSON.stringify([user.email, user.phone, user.role, user.passwordHash, user.updatedAt]));
}

export function issueAccountRecovery(ctx: RequestContext, input: z.infer<typeof IssueRecoveryInput>) {
  const body = IssueRecoveryInput.parse(input);
  return transact(() => {
    requireFreshOwner(ctx, body.currentPassword);
    const userId = 'memberId' in body ? loadMemberInScope(ctx, body.memberId).userId : loadStaffInScope(ctx, body.staffId).userId;
    const user = eligibleAccount(ctx.tenantId, userId);
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get()!;
    const at = now();
    const recoveryId = id('rec');
    const raw = token(32);
    db.update(schema.accountRecoveries).set({ consumedAt: at }).where(and(eq(schema.accountRecoveries.tenantId, ctx.tenantId), eq(schema.accountRecoveries.userId, user.id), isNull(schema.accountRecoveries.consumedAt))).run();
    db.insert(schema.accountRecoveries).values({ id: recoveryId, tenantId: ctx.tenantId, userId: user.id, issuedByUserId: ctx.userId,
      tokenHash: hashToken(`${recoveryId}:${raw}`), identityHash: identityHash(user), reason: body.reason,
      createdAt: at, expiresAt: at + 15 * MINUTE, consumedAt: null }).run();
    audit(ctx, { action: 'account.recovery_issued', entityType: 'user', entityId: user.id, entityLabel: user.name,
      reason: body.reason, after: { identityVerified: true, authority: 'owner_current_password', expiresAt: new Date(at + 15 * MINUTE).toISOString() } });
    return { recoveryId, token: raw, expiresAt: new Date(at + 15 * MINUTE).toISOString(), tenantSlug: tenant.slug, email: user.email! };
  });
}

export function redeemAccountRecovery(input: z.infer<typeof RedeemRecoveryInput>, request: { ip: string; requestId: string }) {
  const body = RedeemRecoveryInput.parse(input);
  const recovered = transact(() => {
    const challenge = db.select().from(schema.accountRecoveries).where(eq(schema.accountRecoveries.id, body.recoveryId)).get();
    if (!challenge || challenge.consumedAt !== null || challenge.expiresAt <= now() ||
        !constantTimeEqual(challenge.tokenHash, hashToken(`${body.recoveryId}:${body.token}`))) {
      throw invalid('This recovery link is invalid or expired. Ask the gym owner for a new verified handoff.');
    }
    const issuer = db.select().from(schema.users).where(and(eq(schema.users.id, challenge.issuedByUserId), eq(schema.users.tenantId, challenge.tenantId))).get();
    if (!issuer || issuer.role !== 'owner' || issuer.accountState !== 'active' || issuer.deletedAt !== null) throw invalid('This handoff is no longer authorized. Contact the gym owner.');
    const user = eligibleAccount(challenge.tenantId, challenge.userId);
    if (!constantTimeEqual(challenge.identityHash, identityHash(user))) throw invalid('This account changed after the handoff. Ask the owner to verify it again.');
    const at = now();
    db.update(schema.users).set({ passwordHash: hashPassword(body.password), updatedAt: at }).where(eq(schema.users.id, user.id)).run();
    revokeAccountChallenges(user);
    db.update(schema.sessions).set({ revokedAt: at }).where(and(eq(schema.sessions.tenantId, user.tenantId), eq(schema.sessions.userId, user.id), isNull(schema.sessions.revokedAt))).run();
    db.insert(schema.auditLog).values({ id: id('aud'), tenantId: user.tenantId, actorId: user.id, actorName: user.name, actorRole: user.role,
      action: 'account.recovery_completed', entityType: 'user', entityId: user.id, entityLabel: user.name,
      reason: 'Recipient redeemed an owner-verified recovery handoff.', changes: [{ field: 'authorizedBy', from: '—', to: issuer.id }, { field: 'priorSessions', from: 'active', to: 'revoked' }],
      ip: request.ip, requestId: request.requestId, at }).run();
    return { userId: user.id, tenantId: user.tenantId };
  });
  disconnectUser(recovered.tenantId, recovered.userId);
  return { recovered: true as const };
}
