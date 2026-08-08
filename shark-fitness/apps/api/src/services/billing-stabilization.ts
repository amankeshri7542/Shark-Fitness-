import { and, eq, sql } from 'drizzle-orm';
import type { MembershipState, Product } from '@shark/contracts';
import { channels } from '@shark/contracts';
import { canTransition } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { DAY, isoDate, now } from '../lib/time.js';
import type { RequestContext } from '../lib/context.js';
import {
  applyPaymentToInvoice,
  applyRefund,
  createInvoiceForProduct,
  loadInvoiceInScope,
  type ApplyPaymentInput,
} from './billing.js';

type MemberRow = typeof schema.members.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;
type InvoiceRow = typeof schema.invoices.$inferSelect;

const MEMBERSHIP_KINDS = new Set(['membership', 'trial', 'day_pass', 'corporate', 'digital']);

export function validateMembershipProduct(member: MemberRow, product: ProductRow): void {
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
  if (rules.minAge !== null || rules.maxAge !== null) {
    if (!member.dob) throw invalid('Add the member’s date of birth before assigning this age-restricted plan.');
    const today = new Date(`${isoDate(now(), 'Asia/Kolkata')}T00:00:00Z`);
    const birth = new Date(`${member.dob}T00:00:00Z`);
    let age = today.getUTCFullYear() - birth.getUTCFullYear();
    const md = today.getUTCMonth() - birth.getUTCMonth();
    if (md < 0 || (md === 0 && today.getUTCDate() < birth.getUTCDate())) age -= 1;
    if (rules.minAge !== null && age < rules.minAge) {
      throw invalid(`This plan requires members to be at least ${rules.minAge}.`);
    }
    if (rules.maxAge !== null && age > rules.maxAge) {
      throw invalid(`This plan is limited to members aged ${rules.maxAge} or younger.`);
    }
  }
}

export function applyPaymentSafely(input: ApplyPaymentInput) {
  const existing = db
    .select()
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.tenantId, input.ctx.tenantId),
        eq(schema.payments.idempotencyKey, input.idempotencyKey),
      ),
    )
    .get();

  if (existing) {
    const sameRequest =
      existing.invoiceId === input.invoiceId &&
      existing.amountMinor === input.amountMinor &&
      existing.method === input.method &&
      existing.provider === input.provider &&
      existing.providerRef === input.providerRef &&
      existing.note === (input.note ?? null);

    if (!sameRequest) {
      throw conflict('This idempotency key was already used for a different payment request.');
    }
    if (existing.state !== 'succeeded') {
      throw conflict('This idempotency key already belongs to another payment attempt.');
    }
  }

  return applyPaymentToInvoice(input);
}

function reverseMembership(
  ctx: RequestContext,
  invoice: InvoiceRow,
  reason: string,
): string {
  if (invoice.refType !== 'membership' || !invoice.refId) {
    throw invalid('This invoice does not contain a reversible membership entitlement.');
  }
  const membership = db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.id, invoice.refId),
        eq(schema.memberships.tenantId, ctx.tenantId),
        eq(schema.memberships.memberId, invoice.memberId),
      ),
    )
    .get();
  if (!membership) throw notFound('The membership for that invoice');
  if (membership.state === 'cancelled' || membership.state === 'expired') return membership.state;

  const target =
    membership.state === 'active' || membership.state === 'grace' || membership.state === 'frozen'
      ? 'suspended'
      : 'cancelled';
  const transition = canTransition({
    from: membership.state as MembershipState,
    to: target as MembershipState,
    reason,
    actorRole: 'staff',
  });
  if (!transition.ok) throw conflict(transition.message);

  db.update(schema.memberships)
    .set({
      state: target,
      autoRenew: false,
      cancelEffectiveOn: target === 'cancelled' ? isoDate(now(), 'Asia/Kolkata') : membership.cancelEffectiveOn,
      updatedAt: now(),
      version: membership.version + 1,
    })
    .where(eq(schema.memberships.id, membership.id))
    .run();
  db.insert(schema.membershipEvents)
    .values({
      id: id('mev'),
      tenantId: ctx.tenantId,
      membershipId: membership.id,
      fromState: membership.state,
      toState: target,
      reason,
      actorId: ctx.userId,
      actorName: ctx.name,
      source: 'staff',
      effectiveAt: now(),
    })
    .run();
  db.update(schema.members)
    .set({ lifecycle: target === 'suspended' ? 'suspended' : 'former', updatedAt: now() })
    .where(eq(schema.members.id, invoice.memberId))
    .run();
  emit({
    tenantId: ctx.tenantId,
    branchId: invoice.branchId,
    channel: channels.member(invoice.memberId),
    topic: 'membership.state_changed',
    payload: { membershipId: membership.id, from: membership.state, to: target },
  });
  return target;
}

export function refundSafely(input: {
  ctx: RequestContext;
  paymentId: string;
  amountMinor: number;
  reason: string;
  entitlementReversed: boolean;
}) {
  const payment = db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.id, input.paymentId), eq(schema.payments.tenantId, input.ctx.tenantId)))
    .get();
  if (!payment?.invoiceId) throw notFound('That payment');

  const invoice = loadInvoiceInScope(input.ctx, payment.invoiceId);
  const result = applyRefund({
    ...input,
    actorName: input.ctx.name,
  });
  const entitlementState = input.entitlementReversed
    ? reverseMembership(input.ctx, invoice, `Refund: ${input.reason}`)
    : null;
  return { ...result, entitlementState };
}

export function voidInvoiceSafely(ctx: RequestContext, invoiceId: string, reason: string) {
  const invoice = loadInvoiceInScope(ctx, invoiceId);
  if (invoice.paidMinor > 0) {
    throw precondition('This invoice already has payments recorded — refund them before voiding.');
  }
  if (invoice.voided) throw conflict('This invoice is already void.');

  let entitlementState: string | null = null;
  if (invoice.refType === 'membership' && invoice.refId) {
    const membership = db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.id, invoice.refId),
          eq(schema.memberships.tenantId, ctx.tenantId),
          eq(schema.memberships.memberId, invoice.memberId),
        ),
      )
      .get();
    if (membership && (membership.state === 'draft' || membership.state === 'pending_payment')) {
      const transition = canTransition({
        from: membership.state as MembershipState,
        to: 'cancelled',
        reason,
        actorRole: 'staff',
      });
      if (!transition.ok) throw conflict(transition.message);
      db.update(schema.memberships)
        .set({
          state: 'cancelled',
          autoRenew: false,
          cancelEffectiveOn: isoDate(now(), 'Asia/Kolkata'),
          updatedAt: now(),
          version: membership.version + 1,
        })
        .where(eq(schema.memberships.id, membership.id))
        .run();
      db.insert(schema.membershipEvents)
        .values({
          id: id('mev'),
          tenantId: ctx.tenantId,
          membershipId: membership.id,
          fromState: membership.state,
          toState: 'cancelled',
          reason: `Invoice voided: ${reason}`,
          actorId: ctx.userId,
          actorName: ctx.name,
          source: 'staff',
          effectiveAt: now(),
        })
        .run();
      entitlementState = 'cancelled';

      const another = db
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.memberId, invoice.memberId),
            sql`${schema.memberships.id} != ${membership.id}`,
            sql`${schema.memberships.state} in ('active','grace','frozen','suspended','cancel_scheduled')`,
          ),
        )
        .get();
      if (!another) {
        db.update(schema.members)
          .set({ lifecycle: 'trial', updatedAt: now() })
          .where(eq(schema.members.id, invoice.memberId))
          .run();
      }
    }
  }

  db.update(schema.invoices)
    .set({ voided: true, voidReason: reason, state: 'void', updatedAt: now() })
    .where(eq(schema.invoices.id, invoiceId))
    .run();
  db.update(schema.dunningAttempts)
    .set({ state: 'stopped', stopReason: 'invoice_voided' })
    .where(and(eq(schema.dunningAttempts.tenantId, ctx.tenantId), eq(schema.dunningAttempts.invoiceId, invoiceId)))
    .run();
  audit(ctx, {
    action: 'invoice.voided',
    entityType: 'invoice',
    entityId: invoiceId,
    entityLabel: invoice.number,
    reason,
    after: { entitlementState },
  });
  emit({
    tenantId: ctx.tenantId,
    branchId: invoice.branchId,
    channel: channels.member(invoice.memberId),
    topic: 'invoice.updated',
    payload: { invoiceId, state: 'void' },
  });
  return { ok: true, entitlementState };
}

export function createMembershipPurchase(input: {
  ctx: RequestContext;
  member: MemberRow;
  product: ProductRow;
  previousMembershipId: string | null;
}) {
  const { ctx, member, product, previousMembershipId } = input;
  validateMembershipProduct(member, product);

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
      eligibilityApproved: product.eligibility.requiresApproval,
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
