import { and, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { branchScope, requirePermission } from '../lib/context.js';
import { conflict, notFound } from '../lib/errors.js';
import { id, initialsOf, normalizeEmail, normalizePhone } from '../lib/ids.js';
import { isoDate, now } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';

export function enrollmentBranch(ctx: RequestContext, branchId: string): void {
  requirePermission(ctx, 'member.edit');
  const branch = db.select().from(schema.branches).where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, ctx.tenantId))).get();
  if (!branch || branch.state !== 'active' || !branchScope(ctx).includes(branchId)) throw notFound('An active branch in your scope');
}

/** Check both profiles and login accounts, including disabled/deleted identities.
 * Never reveal a matching person's identity from another branch. */
export function contactConflict(tenantId: string, email: string | null, phone: string | null, excludeMemberId?: string, excludeUserId?: string): boolean {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  // ponytail: scan one gym's identities per row (imports cap at 200); index normalized user contacts if roster size makes this slow.
  const members = db.select().from(schema.members).where(and(eq(schema.members.tenantId, tenantId), excludeMemberId ? ne(schema.members.id, excludeMemberId) : undefined)).all();
  const users = db.select().from(schema.users).where(and(eq(schema.users.tenantId, tenantId), excludeUserId ? ne(schema.users.id, excludeUserId) : undefined)).all();
  return [...members, ...users].some((row) => (normalizedEmail && normalizeEmail(row.email) === normalizedEmail) || (normalizedPhone && normalizePhone(row.phone) === normalizedPhone));
}

/** Must run in the caller's transaction, shared by lead conversion and CSV import. */
export function enrollMember(ctx: RequestContext, input: { branchId: string; name: string; email: string | null; phone: string | null }) {
  enrollmentBranch(ctx, input.branchId);
  if (contactConflict(ctx.tenantId, input.email, input.phone)) throw conflict('A phone or email is already used by an account in this gym. Resolve the contact conflict; accounts are never merged automatically.');
  const userId = id('usr'); const memberId = id('mbr'); const at = now();
  const name = input.name.trim().replace(/\s+/g, ' ');
  const [firstName = name, ...rest] = name.split(' ');
  const email = normalizeEmail(input.email); const phone = input.phone?.trim() || null;
  const memberNoRow = db.select({ max: sql<number>`max(cast(substr(${schema.members.memberNo}, 4) as integer))` }).from(schema.members).where(eq(schema.members.tenantId, ctx.tenantId)).get();
  const memberNo = `SF-${(memberNoRow?.max ?? 40000) + 1}`;
  db.insert(schema.users).values({ id: userId, tenantId: ctx.tenantId, email, phone, name, initials: initialsOf(name), role: 'member', accountState: 'invited', passwordHash: null,
    preferences: { register: 'predator', theme: 'dark', unitSystem: 'metric', haptics: true, reducedMotion: false }, lastSeenAt: null, createdAt: at, updatedAt: at }).run();
  db.insert(schema.members).values({ id: memberId, tenantId: ctx.tenantId, userId, homeBranchId: input.branchId, memberNo, firstName, lastName: rest.join(' '), initials: initialsOf(name), email, phone,
    emailNormalized: email, phoneNormalized: normalizePhone(phone), dob: null, gender: null, addressLine: null, emergencyContact: null, lifecycle: 'trial', tags: [], trainerId: null, guardianId: null, corporateSponsorId: null, memberNotes: null, staffNotes: null,
    riskScore: null, riskReasons: null, joinedOn: isoDate(at, branchTimeZone(ctx.tenantId, input.branchId)), lastVisitAt: null, mergedIntoId: null, version: 1, createdAt: at, updatedAt: at }).run();
  return { memberId, memberNo, userId };
}
