import { and, eq, isNull, or } from 'drizzle-orm';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { conflict, notFound } from '../lib/errors.js';
import { normalizeEmail, normalizePhone } from '../lib/ids.js';
import { createMembershipPurchase } from './billing-membership.js';
import { contactConflict, enrollMember } from './member-enrollment.js';

/**
 * Quick add for a walk-in (P07; PRD 01 §4.4 "Member operations: Add",
 * Design PRD UX-A04).
 *
 * The short form at the desk: name, phone, optional email, branch, optional
 * plan. It reuses the enrolment that lead conversion and roster import use,
 * so a quick-added member is the same shape as any other. A phone or email
 * that already belongs to someone is refused: when that someone is a member
 * the caller can see, the answer links to them ("open Aman Mehra instead");
 * otherwise it says only that the contact is taken, because naming a person
 * from another branch would leak who trains where.
 */
export interface QuickAddInput {
  name: string;
  phone: string;
  email?: string | null;
  branchId: string;
  productId?: string | null;
}

export function findDuplicate(ctx: RequestContext, phone: string | null, email: string | null) {
  const phoneNormalized = normalizePhone(phone);
  const emailNormalized = normalizeEmail(email);
  if (!phoneNormalized && !emailNormalized) return null;
  const member = db
    .select()
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        isNull(schema.members.mergedIntoId),
        or(
          phoneNormalized ? eq(schema.members.phoneNormalized, phoneNormalized) : undefined,
          emailNormalized ? eq(schema.members.emailNormalized, emailNormalized) : undefined,
        ),
      ),
    )
    .get();
  if (member && branchScope(ctx).includes(member.homeBranchId) && member.deletedAt === null) {
    return {
      visible: true as const,
      member: { id: member.id, name: `${member.firstName} ${member.lastName}`.trim(), memberNo: member.memberNo, matchedOn: member.phoneNormalized === phoneNormalized ? 'phone' : 'email' },
    };
  }
  if (member || contactConflict(ctx.tenantId, email, phone)) return { visible: false as const, member: null };
  return null;
}

export function quickAddMember(ctx: RequestContext, input: QuickAddInput) {
  requirePermission(ctx, 'member.edit');
  if (input.productId) requirePermission(ctx, 'membership.manage');

  const duplicate = findDuplicate(ctx, input.phone, input.email ?? null);
  if (duplicate?.visible) {
    throw conflict(`${duplicate.member.name} (${duplicate.member.memberNo}) already has this ${duplicate.member.matchedOn}. Open their record instead of adding them again.`, {
      existing: duplicate.member,
    });
  }
  if (duplicate) {
    throw conflict('That phone number or email is already used by an account at this gym. Check with a manager before adding them.');
  }

  const product = input.productId
    ? db.select().from(schema.products).where(and(eq(schema.products.id, input.productId), eq(schema.products.tenantId, ctx.tenantId))).get()
    : null;
  if (input.productId && !product) throw notFound('That plan');

  return transact(() => {
    const { memberId, memberNo, userId } = enrollMember(ctx, {
      branchId: input.branchId,
      name: input.name,
      email: input.email?.trim() || null,
      phone: input.phone.trim(),
    });
    let membership: unknown = null;
    if (product) {
      const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get()!;
      membership = createMembershipPurchase({ ctx, member, product, previousMembershipId: null, eligibilityApproved: false });
    }
    audit(ctx, {
      action: 'member.quick_added',
      entityType: 'member',
      entityId: memberId,
      entityLabel: input.name.trim(),
      branchId: input.branchId,
      after: { memberNo, branchId: input.branchId, productId: input.productId ?? null, hasEmail: Boolean(input.email) },
    });
    return {
      member: { id: memberId, memberNo, userId, name: input.name.trim().replace(/\s+/g, ' ') },
      membership,
      /** Password activation needs an email; without one the desk signs them in by phone code later. */
      activation: input.email
        ? { eligible: true, note: 'Send an activation link so they can set a password and use the app.' }
        : { eligible: false, note: 'No email yet. Add one to send an app activation link.' },
    };
  });
}
