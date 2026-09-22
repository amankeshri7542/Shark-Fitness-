import { and, desc, eq, sql } from 'drizzle-orm';
import type { Product } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, isoDate, now } from '../lib/time.js';
import type { RequestContext } from '../lib/context.js';
import { createInvoiceForProduct } from './billing.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { formatMoney, totalsFor } from '@shark/domain';
import { requestHash } from '../lib/crypto.js';
import { loadMemberInScope } from './members.js';
import { notFound } from '../lib/errors.js';
import { reconcileMembershipDates } from './membership-dates.js';

type MemberRow = typeof schema.members.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;

const MEMBERSHIP_KINDS = new Set(['membership', 'trial', 'day_pass', 'corporate', 'digital']);

export function validateMembershipProduct(
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
    const today = new Date(`${isoDate(now(), branchTimeZone(member.tenantId, member.homeBranchId))}T00:00:00Z`);
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

/** A quote binds the operator's confirmation to today's terms and debt. */
export function renewalQuote(ctx: RequestContext, memberId: string, productId?: string) {
  const member = loadMemberInScope(ctx, memberId);
  reconcileMembershipDates(memberId);
  const memberships = db.select().from(schema.memberships).where(and(
    eq(schema.memberships.tenantId, ctx.tenantId), eq(schema.memberships.memberId, memberId),
  )).orderBy(desc(schema.memberships.updatedAt), desc(schema.memberships.id)).all();
  const current = memberships.find((row) => !['cancelled', 'expired'].includes(row.state));
  if (current) throw conflict(`Renewal is unavailable while this membership is ${current.state}. Only expired or cancelled terms can be renewed.`);
  const previous = memberships[0];
  if (!previous) throw conflict('Only an expired or cancelled membership can be renewed. Assign a first plan instead.');
  const product = db.select().from(schema.products).where(and(
    eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId ?? previous.productId),
  )).get();
  if (!product) throw notFound('That product');
  validateMembershipProduct(member, product, true);
  const timeZone = branchTimeZone(ctx.tenantId, member.homeBranchId);
  const startedOn = isoDate(now(), timeZone);
  const endsOn = product.durationDays ? isoDate(now() + product.durationDays * DAY, timeZone) : null;
  const totals = totalsFor([{ quantity: 1, unitMinor: product.priceMinor, taxRateBp: product.taxRateBp }]);
  const debt = db.select().from(schema.invoices).where(and(
    eq(schema.invoices.tenantId, ctx.tenantId), eq(schema.invoices.memberId, memberId),
    eq(schema.invoices.voided, false), sql`${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`,
  )).orderBy(schema.invoices.id).all();
  const quoteToken = requestHash({ memberId, memberVersion: member.version, branchId: member.homeBranchId, previous, product, startedOn, endsOn, debt });
  const branchNames = db.select().from(schema.branches).where(eq(schema.branches.tenantId, ctx.tenantId)).all().filter((branch) => product.access.allBranches || product.access.branchIds.includes(branch.id)).map((branch) => branch.name);
  return {
    member, product, previous,
    quote: {
      quoteToken, memberId, previousMembershipId: previous.id, previousState: previous.state,
      productId: product.id, productName: product.name, productVersion: product.version,
      startedOn, endsOn, timeZone, currency: product.currency, totalMinor: totals.totalMinor,
      totalLabel: formatMoney(totals.totalMinor, product.currency),
      priceLabel: formatMoney(product.priceMinor, product.currency), taxLabel: formatMoney(totals.taxMinor, product.currency),
      freezeFeeLabel: formatMoney(product.freeze.feeMinor, product.currency), cancellationFeeLabel: formatMoney(product.cancellation.earlyExitFeeMinor, product.currency), branchNames,
      freeze: product.freeze, cancellation: product.cancellation, access: product.access,
      requiresApproval: product.eligibility.requiresApproval,
      debts: debt.map((invoice) => ({ invoiceId: invoice.id, number: invoice.number, currency: invoice.currency,
        dueMinor: Math.max(invoice.totalMinor - invoice.paidMinor, 0), dueLabel: formatMoney(Math.max(invoice.totalMinor - invoice.paidMinor, 0), invoice.currency) })),
      consequence: 'Existing debt stays payable. Refunds reduce retained cash, not unpaid principal. The new term starts today and activates only after its full invoice is paid. No recurring collection is enabled.',
    },
  };
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
  // A membership starts on the day it starts *at the gym that sold it*.
  const tz = branchTimeZone(ctx.tenantId, member.homeBranchId);
  const startedOn = isoDate(now(), tz);
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
      endsOn: product.durationDays ? isoDate(now() + product.durationDays * DAY, tz) : null,
      // Recurring collection is not enabled for the staffed-gym pilot.
      autoRenew: false,
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
