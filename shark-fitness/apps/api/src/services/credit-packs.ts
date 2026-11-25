import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Product } from '@shark/contracts';
import { formatMoney, planSoldAt, quotePackRefund, totalsFor } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { requirePermission, type RequestContext } from '../lib/context.js';
import { AppError, conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { isoDate, now } from '../lib/time.js';
import { applyRefund, createInvoiceForProduct, refundableBalance } from './billing.js';
import { allocatePackForInvoice, creditBalance, packLot, revokeLotForRefund, spendCredits, type CreditKind } from './credit-ledger.js';
import { loadMemberInScope } from './members.js';
import { requestProviderRefund } from './payments/refunds.js';
import { resolvePaymentProvider } from '../lib/payment-provider.js';

/**
 * Credit packs (decision 11; PF-CAT-001/004/005; PRD 02 §14.2).
 *
 * - **Sale.** Staff sell a pack from a member's record; a member buys one in
 *   the app. Either way the result is an unpaid invoice and a pack waiting for
 *   it. Paying online goes through P02 Checkout; without a provider the
 *   invoice waits for reception.
 * - **Allocation.** Credits appear in the transaction that pays the invoice in
 *   full (`credit-ledger.ts#allocatePackForInvoice`, called from the single
 *   settlement path) — never before.
 * - **Use.** Bookings and PT sessions spend earliest-expiring credits first.
 * - **Refund.** Wholly unused: everything paid back, all credits removed.
 *   Partly used: unused × unit price, with a reason. Expired: refused. The
 *   credits are taken back in the same transaction that records the refund.
 */

type PackRow = typeof schema.creditPacks.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;

export const CREDIT_PRODUCT_KINDS = ['class_pack', 'pt_credits'] as const;
const kindOf = (product: { kind: string }): CreditKind => (product.kind === 'pt_credits' ? 'pt' : 'class');

/** A pack product this member may buy at their home branch. */
function sellableProduct(tenantId: string, productId: string, homeBranchId: string): ProductRow {
  const product = db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, tenantId)))
    .get();
  if (!product) throw notFound('That pack');
  if (!(CREDIT_PRODUCT_KINDS as readonly string[]).includes(product.kind)) throw invalid('That product is not a credit pack.');
  if (product.status !== 'active') throw invalid('That pack is not on sale.');
  if (!product.credits || product.credits <= 0) throw invalid('That pack has no credits set up. Ask the gym to fix the product first.');
  if (!planSoldAt(product.access, homeBranchId)) throw invalid('That pack is not sold at this home branch.');
  return product;
}

export function packOffers(tenantId: string, homeBranchId: string) {
  return db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.status, 'active'), inArray(schema.products.kind, [...CREDIT_PRODUCT_KINDS])))
    .all()
    .filter((product) => (product.credits ?? 0) > 0 && planSoldAt(product.access, homeBranchId))
    .map((product) => {
      const totals = totalsFor([{ quantity: 1, unitMinor: product.priceMinor, taxRateBp: product.taxRateBp }]);
      const units = product.credits!;
      return {
        productId: product.id,
        name: product.name,
        description: product.description,
        kind: kindOf(product),
        units,
        validDays: product.creditsExpireDays ?? product.durationDays ?? 180,
        totalMinor: totals.totalMinor,
        totalLabel: formatMoney(totals.totalMinor, product.currency),
        perCreditLabel: formatMoney(Math.floor(totals.totalMinor / units), product.currency),
      };
    });
}

export interface SaleResult {
  packId: string;
  invoiceId: string;
  totalMinor: number;
  invoiceState: string;
  creditsAllocated: boolean;
  replayed: boolean;
}

/** Creates the pack and its invoice. Idempotent on `idempotencyKey`. */
export function sellCreditPack(
  ctx: RequestContext,
  input: { memberId: string; productId: string; idempotencyKey: string; soldBy: 'staff' | 'member' },
): SaleResult {
  return transact(() => {
    const keyed = db
      .select()
      .from(schema.creditPacks)
      .where(and(eq(schema.creditPacks.tenantId, ctx.tenantId), eq(schema.creditPacks.idempotencyKey, input.idempotencyKey)))
      .get();
    if (keyed) {
      if (keyed.memberId !== input.memberId || keyed.productId !== input.productId) {
        throw new AppError('IDEMPOTENCY_MISMATCH', 'That request key was already used for a different pack.');
      }
      const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, keyed.invoiceId)).get()!;
      return { packId: keyed.id, invoiceId: keyed.invoiceId, totalMinor: invoice.totalMinor, invoiceState: invoice.state, creditsAllocated: keyed.allocatedAt !== null, replayed: true };
    }

    const member = db
      .select()
      .from(schema.members)
      .where(and(eq(schema.members.id, input.memberId), eq(schema.members.tenantId, ctx.tenantId)))
      .get();
    if (!member) throw notFound('That member');
    const product = sellableProduct(ctx.tenantId, input.productId, member.homeBranchId);
    const atMs = now();
    const packId = id('cpk');

    const invoice = createInvoiceForProduct({
      ctx,
      memberId: member.id,
      branchId: member.homeBranchId,
      product: product as unknown as Product,
      refType: 'credit_pack',
      refId: packId,
    });

    db.insert(schema.creditPacks)
      .values({
        id: packId,
        tenantId: ctx.tenantId,
        branchId: member.homeBranchId,
        memberId: member.id,
        productId: product.id,
        productName: product.name,
        creditKind: kindOf(product),
        units: product.credits!,
        validDays: product.creditsExpireDays ?? product.durationDays ?? 180,
        priceMinor: invoice.totalMinor,
        invoiceId: invoice.invoiceId,
        state: 'pending_payment',
        soldBy: input.soldBy,
        allocatedAt: null,
        expiresOn: null,
        idempotencyKey: input.idempotencyKey,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();

    audit(ctx, {
      action: 'credit_pack.sold',
      entityType: 'credit_pack',
      entityId: packId,
      entityLabel: product.name,
      branchId: member.homeBranchId,
      after: { memberId: member.id, units: product.credits, invoiceId: invoice.invoiceId, totalMinor: invoice.totalMinor, soldBy: input.soldBy },
    });

    // A free pack is paid the moment it exists.
    const creditsAllocated =
      invoice.state === 'paid' &&
      allocatePackForInvoice(ctx, db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.invoiceId)).get()!, atMs);
    return { packId, invoiceId: invoice.invoiceId, totalMinor: invoice.totalMinor, invoiceState: invoice.state, creditsAllocated, replayed: false };
  });
}

/* ============================================================================
   Reading a member's credits
   ========================================================================= */

function packView(pack: PackRow, today: string) {
  const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, pack.invoiceId)).get();
  const lotRow = packLot(pack.id);
  const lot = lotRow ? creditBalance(pack.memberId, pack.creditKind as CreditKind, today).lots.find((l) => l.lotId === lotRow.id) ?? null : null;
  const quote = quotePackRefund({
    lot,
    packUnits: pack.units,
    paidMinor: invoice?.paidMinor ?? 0,
    alreadyRefundedMinor: invoice?.refundedMinor ?? 0,
  });
  return {
    id: pack.id,
    productId: pack.productId,
    productName: pack.productName,
    kind: pack.creditKind as CreditKind,
    units: pack.units,
    state: pack.state,
    priceMinor: pack.priceMinor,
    priceLabel: formatMoney(pack.priceMinor, 'INR'),
    invoiceId: pack.invoiceId,
    invoiceNumber: invoice?.number ?? '',
    invoiceState: invoice?.state ?? 'open',
    dueMinor: invoice ? Math.max(0, invoice.totalMinor - invoice.paidMinor) : 0,
    soldBy: pack.soldBy,
    createdAt: new Date(pack.createdAt).toISOString(),
    allocatedAt: pack.allocatedAt === null ? null : new Date(pack.allocatedAt).toISOString(),
    expiresOn: pack.expiresOn,
    remaining: lot?.remaining ?? 0,
    used: lot?.used ?? 0,
    expired: lot?.expired ?? false,
    refund: {
      refundable: quote.refundable,
      kind: quote.refundable ? quote.kind : null,
      units: quote.units,
      amountMinor: quote.amountMinor,
      amountLabel: formatMoney(quote.amountMinor, 'INR'),
      message: quote.message,
    },
  };
}

export function creditAccount(member: typeof schema.members.$inferSelect) {
  const today = isoDate(now(), branchTimeZone(member.tenantId, member.homeBranchId));
  const entries = db
    .select()
    .from(schema.credits)
    .where(and(eq(schema.credits.tenantId, member.tenantId), eq(schema.credits.memberId, member.id)))
    .orderBy(desc(schema.credits.createdAt), desc(schema.credits.id))
    .all();

  const balances = (['class', 'pt'] as const).map((kind) => {
    const balance = creditBalance(member.id, kind, today);
    const soonest = balance.lots.find((lot) => lot.usable > 0 && lot.expiresOn !== null) ?? null;
    return {
      kind,
      // What is usable less any legacy spend no purchase covered; negative
      // means the history needs a look (shown with the warning below).
      signedBalance: balance.lots.reduce((sum, lot) => sum + lot.usable, 0) - balance.unallocatedDebit,
      usableUnits: balance.usable,
      ledgerUnits: entries.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.delta, 0),
      consumptionAvailable: true,
      warning:
        balance.unallocatedDebit > 0
          ? `${balance.unallocatedDebit} ${balance.unallocatedDebit === 1 ? 'credit was' : 'credits were'} used before a matching purchase was recorded. Reception can check the history.`
          : null,
      nextExpiry: soonest ? { units: soonest.usable, on: soonest.expiresOn! } : null,
      lots: balance.lots.map((lot) => ({
        lotId: lot.lotId,
        packId: lot.packId,
        source: lot.reason,
        granted: lot.granted,
        used: lot.used,
        revoked: lot.revoked,
        remaining: Math.max(0, lot.remaining),
        usable: lot.usable,
        expiresOn: lot.expiresOn,
        expired: lot.expired,
        grantedAt: new Date(lot.createdAt).toISOString(),
      })),
    };
  });

  const packs = db
    .select()
    .from(schema.creditPacks)
    .where(and(eq(schema.creditPacks.tenantId, member.tenantId), eq(schema.creditPacks.memberId, member.id)))
    .orderBy(desc(schema.creditPacks.createdAt))
    .all()
    .map((pack) => packView(pack, today));

  const offers = packOffers(member.tenantId, member.homeBranchId);
  return {
    today,
    balances,
    packs,
    offers,
    entries: entries.map((row) => ({
      id: row.id,
      kind: row.kind,
      delta: row.delta,
      reason: row.reason,
      refType: row.refType,
      refId: row.refId,
      expiresOn: row.expiresOn,
      expired: row.expiresOn !== null && row.expiresOn < today,
      createdAt: new Date(row.createdAt).toISOString(),
    })),
    saleAvailable: offers.length > 0,
    saleUnavailableReason: offers.length > 0 ? '' : 'No credit packs are on sale at this branch right now.',
    historyNotice: 'Every change to your credits is listed here. Credits are used earliest expiry first; a class cancelled in time gives the credit back with its original expiry.',
  };
}

/* ============================================================================
   Refunds (decision 11)
   ========================================================================= */

export function loadPackInScope(ctx: RequestContext, packId: string): PackRow {
  const pack = db
    .select()
    .from(schema.creditPacks)
    .where(and(eq(schema.creditPacks.id, packId), eq(schema.creditPacks.tenantId, ctx.tenantId)))
    .get();
  if (!pack) throw notFound('That pack');
  loadMemberInScope(ctx, pack.memberId);
  return pack;
}

export interface PackRefundResult {
  refundId: string;
  state: 'succeeded' | 'pending' | 'failed';
  amountMinor: number;
  amountLabel: string;
  unitsRevoked: number;
  message: string;
}

function quoteFor(pack: PackRow, today: string) {
  const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, pack.invoiceId)).get()!;
  const lotRow = packLot(pack.id);
  const lot = lotRow ? creditBalance(pack.memberId, pack.creditKind as CreditKind, today).lots.find((l) => l.lotId === lotRow.id) ?? null : null;
  return { invoice, lotRow, quote: quotePackRefund({ lot, packUnits: pack.units, paidMinor: invoice.paidMinor, alreadyRefundedMinor: invoice.refundedMinor }) };
}

/** The payment the refund goes back to: the newest one that can carry it. */
function refundTarget(invoiceId: string, amountMinor: number) {
  const payments = db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.invoiceId, invoiceId), eq(schema.payments.state, 'succeeded')))
    .orderBy(desc(schema.payments.createdAt))
    .all();
  const target = payments.find((payment) => refundableBalance(payment) >= amountMinor);
  if (!target) {
    throw precondition(
      'This pack was paid in several parts, and no single payment covers the refund. Refund each payment from Billing by agreement; no money or credits were changed.',
    );
  }
  return target;
}

export async function refundCreditPack(
  ctx: RequestContext,
  packId: string,
  input: { reason: string; idempotencyKey: string },
): Promise<PackRefundResult> {
  requirePermission(ctx, 'billing.refund');
  const reason = input.reason.trim();
  if (reason.length < 4) throw invalid('A pack refund needs a reason of at least 4 characters.');

  const pack = loadPackInScope(ctx, packId);
  const today = isoDate(now(), branchTimeZone(pack.tenantId, pack.branchId));

  // A repeat of a refund already recorded answers with that refund.
  const prior = db
    .select()
    .from(schema.refunds)
    .where(and(eq(schema.refunds.tenantId, ctx.tenantId), eq(schema.refunds.idempotencyKey, input.idempotencyKey)))
    .get();
  if (prior) {
    const revoked = db
      .select({ units: sql<number>`coalesce(-sum(${schema.credits.delta}), 0)` })
      .from(schema.credits)
      .where(and(eq(schema.credits.refType, 'refund'), eq(schema.credits.refId, prior.id)))
      .get();
    return {
      refundId: prior.id,
      state: prior.state as PackRefundResult['state'],
      amountMinor: prior.amountMinor,
      amountLabel: formatMoney(prior.amountMinor, 'INR'),
      unitsRevoked: revoked?.units ?? 0,
      message: 'This refund was already recorded.',
    };
  }

  const { quote, lotRow } = quoteFor(pack, today);
  if (!quote.refundable || !lotRow) throw precondition(quote.message);
  const target = refundTarget(pack.invoiceId, quote.amountMinor);
  const nextState = quote.kind === 'full' ? 'refunded' : 'partially_refunded';

  // Re-quoted inside the transaction: a booking may have spent a credit
  // between the quote on screen and this moment.
  const assertUnchanged = (): void => {
    const fresh = quoteFor(pack, today).quote;
    if (!fresh.refundable || fresh.units !== quote.units || fresh.amountMinor !== quote.amountMinor) {
      throw conflict('The pack changed while you were looking at it (a credit was used or expired). Check the new amount and try again.');
    }
  };
  const revoke = (refundId: string): void => {
    revokeLotForRefund(pack, lotRow, quote.units, refundId, reason, now());
    db.update(schema.creditPacks).set({ state: nextState, updatedAt: now() }).where(eq(schema.creditPacks.id, pack.id)).run();
    audit(ctx, {
      action: 'credit_pack.refunded',
      entityType: 'credit_pack',
      entityId: pack.id,
      entityLabel: pack.productName,
      branchId: pack.branchId,
      reason,
      before: { state: pack.state, remaining: quote.units },
      after: { state: nextState, unitsRevoked: quote.units, amountMinor: quote.amountMinor, kind: quote.kind, refundId },
    });
  };

  if (target.provider === 'razorpay') {
    if (!resolvePaymentProvider()) throw precondition('This pack was paid online. Refunding it needs the payment provider to be connected.');
    const result = await requestProviderRefund({
      ctx,
      paymentId: target.id,
      amountMinor: quote.amountMinor,
      reason,
      entitlementReversed: true,
      idempotencyKey: input.idempotencyKey,
      creditPackRefund: (refundId) => {
        assertUnchanged();
        revoke(refundId);
      },
    });
    return {
      refundId: result.refundId,
      state: result.state,
      amountMinor: quote.amountMinor,
      amountLabel: formatMoney(quote.amountMinor, 'INR'),
      unitsRevoked: result.state === 'failed' ? 0 : quote.units,
      message:
        result.state === 'failed'
          ? 'Razorpay did not make the refund, so the credits are back on the pack.'
          : `${quote.units} ${quote.units === 1 ? 'credit was' : 'credits were'} removed. Razorpay is returning ${formatMoney(quote.amountMinor, 'INR')} to the original payment method.`,
    };
  }

  // Money recorded at the desk goes back the same way, recorded here.
  return transact(() => {
    assertUnchanged();
    const { refundId } = applyRefund({
      ctx,
      paymentId: target.id,
      amountMinor: quote.amountMinor,
      reason,
      entitlementReversed: true,
      actorName: ctx.name,
      creditPackRefund: true,
    });
    db.update(schema.refunds).set({ idempotencyKey: input.idempotencyKey }).where(eq(schema.refunds.id, refundId)).run();
    revoke(refundId);
    return {
      refundId,
      state: 'succeeded' as const,
      amountMinor: quote.amountMinor,
      amountLabel: formatMoney(quote.amountMinor, 'INR'),
      unitsRevoked: quote.units,
      message: `${quote.units} ${quote.units === 1 ? 'credit was' : 'credits were'} removed. Pay ${formatMoney(quote.amountMinor, 'INR')} back to the member the way they paid (${target.method}).`,
    };
  });
}

/* ============================================================================
   PT sessions: a delivered session uses one PT credit.
   ========================================================================= */

export function recordPtSession(
  ctx: RequestContext,
  memberId: string,
  input: { idempotencyKey: string; note: string | null; trainerId: string | null },
) {
  requirePermission(ctx, 'member.edit');
  const member = loadMemberInScope(ctx, memberId);
  const trainerId = input.trainerId ?? ctx.staffId ?? member.trainerId;
  if (!trainerId) throw invalid('Choose the coach who ran the session.');
  return transact(() => {
    const existing = db
      .select()
      .from(schema.appointments)
      .where(and(eq(schema.appointments.tenantId, ctx.tenantId), eq(schema.appointments.id, `apt_${input.idempotencyKey}`)))
      .get();
    if (existing) return { appointmentId: existing.id, replayed: true };

    const atMs = now();
    const today = isoDate(atMs, branchTimeZone(ctx.tenantId, member.homeBranchId));
    const appointmentId = `apt_${input.idempotencyKey}`;
    db.insert(schema.appointments)
      .values({
        id: appointmentId,
        tenantId: ctx.tenantId,
        branchId: member.homeBranchId,
        memberId: member.id,
        trainerId,
        kind: 'pt',
        startsAt: atMs,
        endsAt: atMs + 60 * 60_000,
        state: 'attended',
        creditsUsed: 1,
        notes: input.note,
        createdAt: atMs,
      })
      .run();
    spendCredits(ctx.tenantId, member.id, 'pt', 1, { reason: 'Personal training session', refType: 'appointment', refId: appointmentId }, today, atMs);
    audit(ctx, {
      action: 'pt_session.recorded',
      entityType: 'appointment',
      entityId: appointmentId,
      entityLabel: `${member.firstName} ${member.lastName}`,
      branchId: member.homeBranchId,
      after: { creditsUsed: 1, trainerId },
    });
    return { appointmentId, replayed: false };
  });
}
