import { and, eq, sql } from 'drizzle-orm';
import type { Product } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, isoDate, now } from '../lib/time.js';
import type { RequestContext } from '../lib/context.js';
import { createInvoiceForProduct } from './billing.js';

type MemberRow = typeof schema.members.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;

const MEMBERSHIP_KINDS = new Set(['membership', 'trial', 'day_pass', 'corporate', 'digital']);

function validateMembershipProduct(
  member: MemberRow,
  product: ProductRow,
  eligibilityApproved: boolean,
): void {
  if (!MEMBERSHIP_KINDS.has(product.kind)) {
    throw invalid(
      product.kind === 'class_pack' || product.kind === 'pt_credits'
        ? 'Credit packs are not membership plans. Use the credits purchase flow.'
        : 'This product is fulfilled by Store/POS, not membership assignment.',
    );
  }
  if (product.status !== 'active') throw invalid('That product is not published.');
  if (!product.access.allBranches && !product.access.branchIds.includes(member.homeBranchId)) {
    throw invalid("That product is not available at this member's branch.");
  }

  const rules = product.eligibility;
  if (rules.corporateOnly && !member.corporateSponsorId) {
    throw invalid('This plan is available only to members linked to a corporate sponsor.');
  }
  if (rules.requiresApproval && !eligibilityApproved) {
    throw invalid('This plan requires an explicit eligibility approval before assignment.');
  }

  // Converted leads may legitimately have no DOB yet. We preserve that existing
  // onboarding path instead of blocking every seeded plan, but once DOB is known
  // the age rule is authoritative and cannot be overridden by the client.
  if (member.dob && (rules.minAge !== null || rules.maxAge !== null)) {
    const today = new Date(`${isoDate(now(), 'Asia/Kolkata')}T00:00:00Z`);
    const birth = new Date(`${member.dob}T00:00:00Z`);
    let age = today.getUTCFullYear() - birth.getUTCFullYear();
    const monthDelta = today.getUTCMonth() - birth.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < birth.getUTCDate())) age -= 1;
    if (rules.minAge !== null && age < rules.minAge) {
      throw invalid(`This plan requires members to be at least ${rules.minAge}.`);
    }
    if (rules.maxAge !== null && age > rules.maxAge) {
      throw invalid(`This plan is limited to members aged ${rules.maxAge} or younger.`);
    }
  }
}

export function createMembershipPurchase(input: {
  ctx: RequestContext;
  member: MemberRow;
  product: ProductRow;
  previousMembershipId: string | null;
  eligibilityApproved?: boolean;
}) {
  const { ctx, member, product, previousMembershipId } = input;
  validateMembershipProduct(member, product, input.eligibilityApproved ?? false);

  const current = db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.memberId, member.id),
        sql`${schema.memberships.state} not in ('cancelled','expired')`,
      ),
    )
    .get();
  if (current) throw conflict('This member already has a plan. Cancel or let it expire before assigning a new one.');

  const membershipId = id('msh');
  const startedOn = isoDate(now(), 'Asia/Kolkata');
  db.insert(schema.memberships)
    .values({
      id: membershipId,
      tenantId: ctx.tenantId,
      memberId: member.id,
      productId: product.id,
      productName: product.name,
      productSnapshot: product as unknown as Product,
      state: 'pending_payment',
      startedOn,
      endsOn: product.durationDays ? isoDate(now() + product.durationDays * DAY, 'Asia/Kolkata') : null,
      autoRenew: product.cadence !== 'one_time',
      priceMinor: product.priceMinor,
      currency: product.currency,
      freezeDaysUsed: 0,
      freezeStartedOn: null,
      graceEndsOn: null,
      cancelEffectiveOn: null,
      previousMembershipId,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  const invoice = createInvoiceForProduct({
    ctx,
    memberId: member.id,
    branchId: member.homeBranchId,
    product: product as unknown as Product,
    refType: 'membership',
    refId: membershipId,
  });

  let activated = false;
  if (invoice.state === 'paid') {
    db.update(schema.memberships)
      .set({ state: 'active', updatedAt: now() })
      .where(eq(schema.memberships.id, membershipId))
      .run();
    db.insert(schema.membershipEvents)
      .values({
        id: id('mev'),
        tenantId: ctx.tenantId,
        membershipId,
        fromState: 'pending_payment',
        toState: 'active',
        reason: 'Zero-price product, activated immediately',
        actorId: ctx.userId,
        actorName: ctx.name,
        source: 'staff',
        effectiveAt: now(),
      })
      .run();
    db.update(schema.members)
      .set({ lifecycle: 'active', updatedAt: now() })
      .where(eq(schema.members.id, member.id))
      .run();
    activated = true;
  }

  audit(ctx, {
    action: previousMembershipId ? 'membership.renewed' : 'membership.assigned',
    entityType: 'member',
    entityId: member.id,
    entityLabel: member.memberNo,
    after: {
      productId: product.id,
      invoiceId: invoice.invoiceId,
      previousMembershipId,
      eligibilityApproved: input.eligibilityApproved ?? false,
    },
  });
  return {
    ok: true as const,
    membershipId,
    invoiceId: invoice.invoiceId,
    activated,
    totalMinor: invoice.totalMinor,
  };
}
