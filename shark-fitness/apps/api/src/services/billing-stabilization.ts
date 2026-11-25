import { and, eq, sql } from 'drizzle-orm';
import type { MembershipState } from '@shark/contracts';
import { channels } from '@shark/contracts';
import { canTransition } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { isoDate, now } from '../lib/time.js';
import type { RequestContext } from '../lib/context.js';
import {
  applyPaymentToInvoice,
  applyRefund,
  loadInvoiceInScope,
  type ApplyPaymentInput,
} from './billing.js';
import { stopDunning } from './dunning.js';
import { branchTimeZone } from '../lib/branch-time.js';

type InvoiceRow = typeof schema.invoices.$inferSelect;

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

export function reverseMembership(
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
      cancelEffectiveOn:
        target === 'cancelled'
          ? isoDate(now(), branchTimeZone(ctx.tenantId, invoice.branchId))
          : membership.cancelEffectiveOn,
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
          cancelEffectiveOn: isoDate(now(), branchTimeZone(ctx.tenantId, invoice.branchId)),
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
  // Through the shared helper so "stop chasing this" means the same thing
  // whether the debt was paid, written off or voided.
  stopDunning(ctx.tenantId, invoiceId, 'invoice_voided');
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
