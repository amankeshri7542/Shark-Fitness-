import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { channels, CorrectMemberIdentity, CorrectMemberProfile } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { requirePermission } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { initialsOf, normalizeEmail, normalizePhone } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { loadMemberInScope } from './members.js';
import { contactConflict } from './member-enrollment.js';
import { requireFreshOwner } from './account-recovery.js';
import { revokeAccountChallenges } from './auth.js';
import { disconnectUser } from '../realtime/hub.js';

export function profileChanged(ctx: RequestContext, memberId: string, branchId: string): void {
  for (const channel of [channels.member(memberId), channels.branch(branchId)]) {
    emit({ tenantId: ctx.tenantId, branchId, channel, topic: 'member.profile_updated', payload: {} });
  }
}

function editableMember(ctx: RequestContext, memberId: string, version: number) {
  requirePermission(ctx, 'member.edit');
  const member = loadMemberInScope(ctx, memberId);
  if (member.mergedIntoId) throw notFound('That member');
  if (member.version !== version) throw conflict('This profile changed. Reload it before saving your correction.');
  return member;
}

export function correctProfile(ctx: RequestContext, memberId: string, input: z.infer<typeof CorrectMemberProfile>) {
  input = CorrectMemberProfile.parse(input);
  return transact(() => {
    const member = editableMember(ctx, memberId, input.version);
    const { version, reason, ...fields } = input;
    const name = `${fields.firstName} ${fields.lastName}`.trim();
    db.update(schema.members).set({ ...fields, initials: initialsOf(name), version: version + 1, updatedAt: now() }).where(eq(schema.members.id, memberId)).run();
    if (member.userId) {
      db.update(schema.users).set({ name, initials: initialsOf(name), updatedAt: now() }).where(and(eq(schema.users.id, member.userId), eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.role, 'member'))).run();
    }
    audit(ctx, { action: 'member.profile_corrected', entityType: 'member', entityId: memberId, entityLabel: member.memberNo, reason,
      before: { firstName: member.firstName, lastName: member.lastName, dob: member.dob, addressLine: member.addressLine, emergencyContact: member.emergencyContact }, after: fields });
    profileChanged(ctx, memberId, member.homeBranchId);
    return { ok: true, version: version + 1 };
  });
}

export function correctIdentity(ctx: RequestContext, memberId: string, input: z.infer<typeof CorrectMemberIdentity>) {
  input = CorrectMemberIdentity.parse(input);
  const result = transact(() => {
    requireFreshOwner(ctx, input.currentPassword);
    const member = editableMember(ctx, memberId, input.version);
    const user = member.userId ? db.select().from(schema.users).where(and(eq(schema.users.id, member.userId), eq(schema.users.tenantId, ctx.tenantId))).get() : null;
    if (!user || user.role !== 'member' || user.deletedAt || !['active', 'invited'].includes(user.accountState)) throw conflict('This member account is not eligible for login-identity correction.');
    const email = normalizeEmail(input.email); const phone = input.phone?.trim() || null;
    if (user.passwordHash && !email) throw conflict('An activated account must keep a valid login email. Phone-only sign-in is unavailable.');
    if (contactConflict(ctx.tenantId, email, phone, memberId, user.id)) throw conflict('A phone or email is already used by an account in this gym. Resolve the conflict; accounts are never merged automatically.');
    revokeAccountChallenges(user);
    db.update(schema.users).set({ email, phone, updatedAt: now() }).where(eq(schema.users.id, user.id)).run();
    db.update(schema.members).set({ email, phone, emailNormalized: email, phoneNormalized: normalizePhone(phone), version: input.version + 1, updatedAt: now() }).where(eq(schema.members.id, memberId)).run();
    db.update(schema.sessions).set({ revokedAt: now() }).where(eq(schema.sessions.userId, user.id)).run();
    audit(ctx, { action: 'member.identity_corrected', entityType: 'member', entityId: memberId, entityLabel: member.memberNo, reason: input.reason,
      before: { email: member.email, phone: member.phone }, after: { email, phone, identityVerified: true, sessionsRevoked: true } });
    profileChanged(ctx, memberId, member.homeBranchId);
    return { ok: true, version: input.version + 1, sessionsRevoked: true, userId: user.id };
  });
  disconnectUser(ctx.tenantId, result.userId);
  return { ok: result.ok, version: result.version, sessionsRevoked: result.sessionsRevoked };
}
