import { and, desc, eq } from 'drizzle-orm';
import { formatMoney, totalsFor } from '@shark/domain';
import { db, schema } from '../../db/client.js';
import type { RequestContext } from '../../lib/context.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { runIdempotently } from '../../lib/idempotency.js';
import { resolvePaymentProvider } from '../../lib/payment-provider.js';
import { createMembershipPurchase, renewalQuote, validateMembershipProduct } from '../billing-membership.js';
import { reconcileMembershipDates } from '../membership-dates.js';
import { requireProvider, startInvoiceCheckout, type CheckoutSession } from './checkout.js';

/**
 * Member self-service plan purchase and renewal (P02).
 *
 * Nothing new about *what* may be sold: the plan list is filtered by the same
 * `validateMembershipProduct` reception uses (published, sold at the member's
 * branch, corporate and age rules) with no staff eligibility approval, and a
 * renewal goes through `renewalQuote`, which keeps the existing rule that only
 * an expired or cancelled membership can be renewed. The purchase creates the
 * same pending membership and invoice reception would, then opens the same
 * checkout as any other invoice. Nothing is active until the invoice is paid.
 */

export type PlanMode = 'purchase' | 'renew' | 'unavailable';

function ownMember(ctx: RequestContext) {
  const member = ctx.memberId
    ? db.select().from(schema.members).where(and(eq(schema.members.id, ctx.memberId), eq(schema.members.tenantId, ctx.tenantId))).get()
    : undefined;
  if (!member) throw notFound('Your membership account');
  return member;
}

function planMode(memberId: string, tenantId: string) {
  reconcileMembershipDates(memberId);
  const memberships = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.memberId, memberId)))
    .orderBy(desc(schema.memberships.updatedAt), desc(schema.memberships.id))
    .all();
  const current = memberships.find((row) => !['cancelled', 'expired'].includes(row.state));
  if (current) return { mode: 'unavailable' as const, current, previous: null };
  return { mode: memberships.length > 0 ? ('renew' as const) : ('purchase' as const), current: null, previous: memberships[0] ?? null };
}

export function memberPlanOptions(ctx: RequestContext) {
  const member = ownMember(ctx);
  const { mode, current, previous } = planMode(member.id, ctx.tenantId);
  const products = db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.status, 'active')))
    .orderBy(schema.products.priceMinor)
    .all()
    .filter((product) => {
      try {
        validateMembershipProduct(member, product, false);
        return true;
      } catch {
        return false;
      }
    });

  return {
    onlinePayment: resolvePaymentProvider() !== null,
    mode,
    unavailableReason:
      current?.state === 'pending_payment'
        ? 'Your new plan is waiting for payment. Pay its invoice below to start it.'
        : current
          ? 'You already have a plan. Renewal opens when it has expired or been cancelled.'
          : null,
    previousProductId: previous?.productId ?? null,
    plans: mode === 'unavailable' ? [] : products.map((product) => {
      const totals = totalsFor([{ quantity: 1, unitMinor: product.priceMinor, taxRateBp: product.taxRateBp }]);
      return {
        productId: product.id,
        name: product.name,
        description: product.description,
        kind: product.kind,
        durationDays: product.durationDays,
        priceLabel: formatMoney(product.priceMinor, product.currency),
        taxLabel: formatMoney(totals.taxMinor, product.currency),
        totalMinor: totals.totalMinor,
        totalLabel: formatMoney(totals.totalMinor, product.currency),
        cancellation: product.cancellation.description,
        freezeAllowed: product.freeze.allowed,
      };
    }),
  };
}

export type PlanCheckoutResult =
  | ({ kind: 'checkout' } & CheckoutSession)
  | { kind: 'activated'; invoiceId: string; membershipId: string };

/**
 * Invoice the plan (idempotent on the member's key), then open checkout for
 * that invoice. The provider is required up front: without online payment the
 * app shows reception instructions and never creates an invoice from here.
 */
export async function startPlanCheckout(ctx: RequestContext, productId: string, idempotencyKey: string): Promise<PlanCheckoutResult> {
  requireProvider();
  const member = ownMember(ctx);

  const purchase = runIdempotently(ctx, 'member.plan_checkout', idempotencyKey, { productId }, () => {
    const { mode, previous } = planMode(member.id, ctx.tenantId);
    if (mode === 'unavailable') {
      throw conflict('You already have a plan. Renewal opens when it has expired or been cancelled.');
    }
    const product = db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, ctx.tenantId)))
      .get();
    if (!product) throw notFound('That plan');
    if (mode === 'renew') {
      // The staff renewal quote: same "expired or cancelled only" rule, same
      // product checks. Eligibility approval is never assumed for a member.
      const quote = renewalQuote(ctx, member.id, product.id);
      const result = createMembershipPurchase({ ctx, member: quote.member, product: quote.product, previousMembershipId: quote.previous.id, eligibilityApproved: false });
      return { ...result, mode };
    }
    const result = createMembershipPurchase({ ctx, member, product, previousMembershipId: previous?.id ?? null, eligibilityApproved: false });
    return { ...result, mode };
  });

  if (purchase.activated) return { kind: 'activated', invoiceId: purchase.invoiceId, membershipId: purchase.membershipId };
  try {
    const checkout = await startInvoiceCheckout(ctx, purchase.invoiceId, `${idempotencyKey}:checkout`, purchase.mode === 'renew' ? 'plan_renewal' : 'plan_purchase');
    return { kind: 'checkout', ...checkout };
  } catch (error) {
    // The invoice exists either way; say so, so the member is not surprised
    // to find it under Billing.
    if (error instanceof AppError && error.code === 'PROVIDER_UNAVAILABLE') {
      throw new AppError('PROVIDER_UNAVAILABLE', 'Your plan was saved, but online payment could not be started. Nothing was charged. Try Pay now on the invoice in a moment, or pay at reception.', { retryAfterSec: 10 });
    }
    throw error;
  }
}
