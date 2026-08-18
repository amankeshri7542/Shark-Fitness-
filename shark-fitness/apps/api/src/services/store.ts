import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import type {
  PosOrderDetail,
  PosOrderList,
  PosOrderKind,
  PosOrderLine,
  PosOrderState,
  PosOrderSummary,
  PosTender,
  PosTenderMethod,
  ProductGroup,
  StockAdjustResult,
  StockLedgerPage,
  StockMovement,
  StockReason as StockReasonContract,
  StockTransfer,
  StockTransferDetail,
  StockTransferLine,
  StockTransferList,
  StockTransferState,
  StoreFinancialAccess,
  StoreProduct,
  StoreProductList,
  StoreReport,
  Supplier,
} from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import type { RequestContext } from '../lib/context.js';
import { requireBranch, requirePermission } from '../lib/context.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { addDays, isoDate, now } from '../lib/time.js';
import { nextInvoiceNumber } from './billing.js';

/**
 * Store: point of sale and inventory (PF-POS-001…006).
 *
 * Two rules shape everything here.
 *
 * On-hand stock is **always** a sum over `stock_ledger`. There is no quantity
 * column to drift, and every movement — purchase, sale, return, transfer,
 * adjustment, damage — is an append-only row that says who did it and why.
 * A refund does not edit the sale that caused it; it writes a compensating
 * entry, so the history of a product reads like a bank statement.
 *
 * Money is integer minor units end to end, and tax is computed per line and
 * then summed. Summing first and taxing the total drifts by a rupee or two on
 * mixed-rate baskets, which is exactly the kind of error a shop notices at
 * close of day and cannot explain.
 */

/* ——— Stock, derived ————————————————————————————————————————— */

/** On-hand for one product at one branch. The only way stock is ever read. */
export function onHand(tenantId: string, branchId: string, productId: string): number {
  const row = db
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLedger.delta}), 0)` })
    .from(schema.stockLedger)
    .where(
      and(
        eq(schema.stockLedger.tenantId, tenantId),
        eq(schema.stockLedger.branchId, branchId),
        eq(schema.stockLedger.productId, productId),
      ),
    )
    .get();
  return row?.qty ?? 0;
}

/** Batched form, so a product list does not run one query per row. */
export function onHandMap(tenantId: string, branchId: string | null): Map<string, number> {
  const conditions = [eq(schema.stockLedger.tenantId, tenantId)];
  if (branchId) conditions.push(eq(schema.stockLedger.branchId, branchId));
  const rows = db
    .select({
      productId: schema.stockLedger.productId,
      qty: sql<number>`coalesce(sum(${schema.stockLedger.delta}), 0)`,
    })
    .from(schema.stockLedger)
    .where(and(...conditions))
    .groupBy(schema.stockLedger.productId)
    .all();
  return new Map(rows.map((r) => [r.productId, r.qty]));
}

/**
 * Weighted average unit cost from inbound movements.
 *
 * Falls back to the product's current cost only when no inbound row carries a
 * cost — true for stock seeded before Phase 7. Valuing at the current cost
 * would let an edit to a product rewrite last month's reported margin.
 */
export function averageCost(tenantId: string, productId: string, fallbackMinor: number): number {
  const row = db
    .select({
      qty: sql<number>`coalesce(sum(${schema.stockLedger.delta}), 0)`,
      value: sql<number>`coalesce(sum(${schema.stockLedger.delta} * ${schema.stockLedger.unitCostMinor}), 0)`,
    })
    .from(schema.stockLedger)
    .where(
      and(
        eq(schema.stockLedger.tenantId, tenantId),
        eq(schema.stockLedger.productId, productId),
        sql`${schema.stockLedger.delta} > 0`,
        sql`${schema.stockLedger.unitCostMinor} is not null`,
      ),
    )
    .get();
  if (!row || row.qty <= 0) return fallbackMinor;
  return Math.round(row.value / row.qty);
}

/* ——— Tenant policy ——————————————————————————————————————————— */

/**
 * Negative stock is refused unless the tenant has explicitly turned it on
 * (PF-POS-004). Absent policy means "no" — a shop that never made the decision
 * has not consented to selling what it does not have.
 */
export function allowsNegativeStock(tenantId: string): boolean {
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  return tenant?.policy?.['allowNegativeStock'] === true;
}

/* ——— Scope helpers ——————————————————————————————————————————— */

function productInTenant(ctx: RequestContext, productId: string) {
  const product = db
    .select()
    .from(schema.retailProducts)
    .where(and(eq(schema.retailProducts.id, productId), eq(schema.retailProducts.tenantId, ctx.tenantId)))
    .get();
  // Cross-tenant and unknown are the same answer on purpose: a 404 leaks less
  // than a 403 about whether an id exists somewhere else.
  if (!product) throw notFound('That product');
  return product;
}

function orderInScope(ctx: RequestContext, orderId: string) {
  const order = db
    .select()
    .from(schema.posOrders)
    .where(and(eq(schema.posOrders.id, orderId), eq(schema.posOrders.tenantId, ctx.tenantId)))
    .get();
  if (!order) throw notFound('That order');
  // An order at a branch the caller cannot see does not exist as far as they
  // are concerned.
  if (!ctx.branchIds.includes(order.branchId)) throw notFound('That order');
  return order;
}

/* ——— Financial visibility ————————————————————————————————————— */

/**
 * Who may see what a thing cost.
 *
 * Running the shop and knowing what the shop earns are two different jobs, and
 * the Product PRD separates them: reception has `inventory.view` so it can sell
 * and reorder, and explicitly "no access to sensitive global reports", while
 * §4.20 files product margin under *financial* reports. Handing margin to
 * everyone holding `inventory.view` would have made every receptionist a reader
 * of the gym's commercial position.
 *
 * The line lands in two places rather than one, because cost is two things:
 *
 * - **Unit cost** is an operational input. Whoever receives a delivery types it
 *   in, so `inventory.manage` sees it. Hiding it would make product editing
 *   lossy — a branch manager would have to save a form with a field they were
 *   not allowed to read.
 * - **Margin, valuation and shrinkage value** are derived commercial figures.
 *   Those need `report.financial`.
 *
 * A withheld figure is `null`, never `0`. Zero margin is a real and alarming
 * number in a shop; substituting it for "you may not see this" would put a
 * falsehood in a report (PF-RPT-005).
 */
export function financialAccess(ctx: RequestContext): StoreFinancialAccess {
  const canSeeMargin = ctx.permissions.includes('report.financial');
  const canSeeCost = ctx.permissions.includes('inventory.manage');
  const restricted: string[] = [];
  if (!canSeeCost) restricted.push('costMinor', 'unitCostMinor');
  if (!canSeeMargin) restricted.push('marginMinor', 'valuationMinor', 'shrinkageCostMinor');
  return { canSeeMargin, canSeeCost, restricted };
}

/* ——— Serialisation ———————————————————————————————————————————— */

/* Rows go out in the shapes `@shark/contracts` declares, not as raw tables.
   The console used to hold its own copy of these interfaces, which typechecked
   perfectly while drifting from what the server actually sent. */

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Branch ids are not a user-facing label. Resolved once per response. */
function branchNames(tenantId: string): Map<string, string> {
  return new Map(
    db
      .select({ id: schema.branches.id, name: schema.branches.name })
      .from(schema.branches)
      .where(eq(schema.branches.tenantId, tenantId))
      .all()
      .map((b) => [b.id, b.name]),
  );
}

function memberNames(tenantId: string, memberIds: string[]): Map<string, string> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return new Map();
  return new Map(
    db
      .select({ id: schema.members.id, firstName: schema.members.firstName, lastName: schema.members.lastName })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId), inArray(schema.members.id, unique)))
      .all()
      .map((m) => [m.id, `${m.firstName} ${m.lastName}`.trim()]),
  );
}

export const displayNameOf = (p: { name: string; variantName: string | null }): string =>
  p.variantName ? `${p.name} — ${p.variantName}` : p.name;

interface ProductExtras {
  onHand: number;
  valuationMinor: number;
  groupName: string | null;
  supplierName: string | null;
}

function toProduct(
  row: typeof schema.retailProducts.$inferSelect,
  extras: ProductExtras,
  access: StoreFinancialAccess,
): StoreProduct {
  return {
    id: row.id,
    name: row.name,
    displayName: displayNameOf(row),
    sku: row.sku,
    barcode: row.barcode,
    category: row.category,
    variantName: row.variantName ?? '',
    groupId: row.groupId,
    groupName: extras.groupName,
    supplierId: row.supplierId,
    supplierName: extras.supplierName,
    priceMinor: row.priceMinor,
    taxRateBp: row.taxRateBp,
    reorderAt: row.reorderAt,
    active: row.active,
    onHand: extras.onHand,
    lowStock: extras.onHand <= row.reorderAt,
    costMinor: access.canSeeCost ? row.costMinor : null,
    valuationMinor: access.canSeeMargin ? extras.valuationMinor : null,
    createdAt: iso(row.createdAt),
  };
}

function toMovement(
  row: typeof schema.stockLedger.$inferSelect,
  branches: Map<string, string>,
  access: StoreFinancialAccess,
): StockMovement {
  return {
    id: row.id,
    productId: row.productId,
    branchId: row.branchId,
    branchName: branches.get(row.branchId) ?? row.branchId,
    delta: row.delta,
    reason: row.reason as StockReasonContract,
    refType: row.refType,
    refId: row.refId,
    actorName: row.actorName,
    note: row.note,
    unitCostMinor: access.canSeeCost ? row.unitCostMinor : null,
    negativeOverride: row.negativeOverride,
    overrideReason: row.overrideReason,
    at: iso(row.at),
  };
}

function toOrderSummary(
  row: typeof schema.posOrders.$inferSelect,
  branches: Map<string, string>,
  members: Map<string, string>,
): PosOrderSummary {
  return {
    id: row.id,
    reference: row.reference,
    branchId: row.branchId,
    branchName: branches.get(row.branchId) ?? row.branchId,
    memberId: row.memberId,
    memberName: row.memberId ? (members.get(row.memberId) ?? null) : null,
    kind: row.kind as PosOrderKind,
    state: row.state as PosOrderState,
    subtotalMinor: row.subtotalMinor,
    discountMinor: row.discountMinor,
    taxMinor: row.taxMinor,
    totalMinor: row.totalMinor,
    staffId: row.staffId,
    staffName: row.staffName,
    invoiceId: row.invoiceId,
    returnOfOrderId: row.returnOfOrderId,
    voidReason: row.voidReason,
    voidedAt: isoOrNull(row.voidedAt),
    createdAt: iso(row.createdAt),
  };
}

function toOrderLine(
  row: typeof schema.posOrderLines.$inferSelect,
  access: StoreFinancialAccess,
): PosOrderLine {
  return {
    id: row.id,
    productId: row.productId,
    name: row.name,
    quantity: row.quantity,
    unitMinor: row.unitMinor,
    discountMinor: row.discountMinor,
    taxRateBp: row.taxRateBp,
    taxMinor: row.taxMinor,
    totalMinor: row.totalMinor,
    quantityReturned: row.quantityReturned,
    // A return order's own lines are already negative; nothing about them is
    // returnable, so the console never offers to return a return.
    quantityReturnable: row.quantity > 0 ? row.quantity - row.quantityReturned : 0,
    unitCostMinor: access.canSeeMargin ? row.unitCostMinor : null,
  };
}

const toTender = (row: typeof schema.posPayments.$inferSelect): PosTender => ({
  id: row.id,
  method: row.method as PosTenderMethod,
  amountMinor: row.amountMinor,
  reference: row.reference,
  at: iso(row.at),
});

function toTransfer(
  row: typeof schema.stockTransfers.$inferSelect,
  lines: Array<typeof schema.stockTransferLines.$inferSelect>,
  branches: Map<string, string>,
): StockTransfer {
  return {
    id: row.id,
    reference: row.reference,
    fromBranchId: row.fromBranchId,
    fromBranchName: branches.get(row.fromBranchId) ?? row.fromBranchId,
    toBranchId: row.toBranchId,
    toBranchName: branches.get(row.toBranchId) ?? row.toBranchId,
    state: row.state as StockTransferState,
    note: row.note,
    createdBy: row.createdBy,
    dispatchedAt: isoOrNull(row.dispatchedAt),
    dispatchedBy: row.dispatchedBy,
    receivedAt: isoOrNull(row.receivedAt),
    receivedBy: row.receivedBy,
    cancelledAt: isoOrNull(row.cancelledAt),
    createdAt: iso(row.createdAt),
    // Only a dispatched transfer holds stock that is on neither shelf.
    unitsInTransit:
      row.state === 'dispatched' ? lines.reduce((sum, l) => sum + (l.quantity - l.quantityReceived), 0) : 0,
  };
}

function toTransferLine(
  row: typeof schema.stockTransferLines.$inferSelect,
  product: { name: string; variantName: string | null; sku: string } | undefined,
  state: StockTransferState,
  access: StoreFinancialAccess,
): StockTransferLine {
  return {
    id: row.id,
    productId: row.productId,
    productName: product ? displayNameOf(product) : row.productId,
    sku: product?.sku ?? '',
    quantity: row.quantity,
    quantityReceived: row.quantityReceived,
    // Shortfall only means anything once someone has counted what arrived.
    shortfall: state === 'received' ? row.quantity - row.quantityReceived : 0,
    unitCostMinor: access.canSeeMargin ? row.unitCostMinor : null,
  };
}

/* ——— Realtime ————————————————————————————————————————————————— */

/**
 * Tell the branch its shelf moved.
 *
 * One event per movement batch rather than per line: a five-line sale is one
 * fact about the shop, and five events would make five consoles refetch five
 * times each. The payload carries the affected products so a client can decide
 * whether it cares without a round trip.
 */
function emitStockChanged(
  ctx: RequestContext,
  branchId: string,
  products: Array<{ productId: string; name: string; onHand: number }>,
  reason: string,
): void {
  if (products.length === 0) return;
  emit({
    tenantId: ctx.tenantId,
    branchId,
    channel: channels.branch(branchId),
    topic: 'stock.changed',
    payload: { reason, products },
  });
}

/**
 * A transfer moved. Published to **both** branches, because the destination
 * needs to know a van is coming and the source needs to know it landed — and a
 * transfer is the one Store fact that is never about a single shelf.
 */
function emitTransferUpdated(ctx: RequestContext, transferId: string, state: StockTransferState): void {
  const transfer = db
    .select()
    .from(schema.stockTransfers)
    .where(eq(schema.stockTransfers.id, transferId))
    .get();
  if (!transfer) return;
  const payload = {
    transferId,
    reference: transfer.reference,
    state,
    fromBranchId: transfer.fromBranchId,
    toBranchId: transfer.toBranchId,
  };
  for (const branchId of new Set([transfer.fromBranchId, transfer.toBranchId])) {
    emit({
      tenantId: ctx.tenantId,
      branchId,
      channel: channels.branch(branchId),
      topic: 'transfer.updated',
      payload,
    });
  }
}

/** Fires for every product a completed order pushed under its reorder point. */
function emitLowStockFor(ctx: RequestContext, branchId: string, productIds: string[]): void {
  for (const productId of [...new Set(productIds)]) {
    const product = db
      .select()
      .from(schema.retailProducts)
      .where(eq(schema.retailProducts.id, productId))
      .get();
    if (!product) continue;
    const qty = onHand(ctx.tenantId, branchId, productId);
    if (qty > product.reorderAt) continue;
    emit({
      tenantId: ctx.tenantId,
      branchId,
      channel: channels.branch(branchId),
      topic: 'stock.low',
      payload: {
        productId,
        name: displayNameOf(product),
        sku: product.sku,
        onHand: qty,
        reorderAt: product.reorderAt,
      },
    });
  }
}

/* ——— Ledger ————————————————————————————————————————————————— */

export type StockReason = 'purchase' | 'sale' | 'return' | 'transfer_out' | 'transfer_in' | 'adjustment' | 'damage';

interface MovementInput {
  branchId: string;
  productId: string;
  delta: number;
  reason: StockReason;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  unitCostMinor?: number | null;
  overrideReason?: string | null;
}

/**
 * The single writer for stock. Refuses to drive on-hand below zero unless the
 * tenant allows it and the caller gave a reason, and records both facts on the
 * row so an auditor can see the override rather than infer it.
 */
function writeMovement(ctx: RequestContext, input: MovementInput): void {
  if (input.delta === 0) throw invalid('A stock movement cannot be zero.');

  if (input.delta < 0) {
    const current = onHand(ctx.tenantId, input.branchId, input.productId);
    if (current + input.delta < 0) {
      if (!allowsNegativeStock(ctx.tenantId)) {
        throw precondition(
          `Only ${current} in stock at this branch. Negative stock is not enabled for this tenant.`,
        );
      }
      if (!input.overrideReason || input.overrideReason.trim().length < 4) {
        throw invalid('Going below zero stock needs a reason.');
      }
    }
  }

  const drivesNegative =
    input.delta < 0 && onHand(ctx.tenantId, input.branchId, input.productId) + input.delta < 0;

  db.insert(schema.stockLedger)
    .values({
      id: id('stk'),
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      productId: input.productId,
      delta: input.delta,
      reason: input.reason,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      actorName: ctx.name,
      note: input.note ?? null,
      unitCostMinor: input.delta > 0 ? (input.unitCostMinor ?? null) : null,
      negativeOverride: drivesNegative,
      overrideReason: drivesNegative ? (input.overrideReason ?? null) : null,
      at: now(),
    })
    .run();
}

/* ——— Money ——————————————————————————————————————————————————— */

export interface PricedLine {
  productId: string;
  name: string;
  quantity: number;
  unitMinor: number;
  discountMinor: number;
  taxRateBp: number;
  taxMinor: number;
  unitCostMinor: number;
  totalMinor: number;
}

/** Tax per line, then summed (PF-POS-002). Never tax on a rolled-up total. */
function priceLine(
  product: typeof schema.retailProducts.$inferSelect,
  quantity: number,
  discountMinor: number,
  unitCostMinor: number,
): PricedLine {
  const gross = product.priceMinor * quantity;
  if (discountMinor < 0) throw invalid('A discount cannot be negative.');
  if (discountMinor > gross) throw invalid(`A discount cannot exceed the line total for ${product.name}.`);
  const taxable = gross - discountMinor;
  const taxMinor = Math.round((taxable * product.taxRateBp) / 10_000);
  return {
    productId: product.id,
    name: product.variantName ? `${product.name} — ${product.variantName}` : product.name,
    quantity,
    unitMinor: product.priceMinor,
    discountMinor,
    taxRateBp: product.taxRateBp,
    taxMinor,
    unitCostMinor,
    totalMinor: taxable + taxMinor,
  };
}

/* ——— Checkout ————————————————————————————————————————————————— */

export interface CheckoutLineInput {
  productId: string;
  quantity: number;
  discountMinor?: number;
}

export interface CheckoutPaymentInput {
  method: 'cash' | 'card' | 'upi' | 'account';
  amountMinor: number;
  reference?: string;
}

export interface CheckoutInput {
  branchId: string;
  memberId?: string | null;
  lines: CheckoutLineInput[];
  payments: CheckoutPaymentInput[];
  overrideReason?: string | null;
}

/**
 * Sell (PF-POS-002).
 *
 * The whole thing is one transaction: order, lines, tenders, stock and audit
 * commit together or not at all. That is the answer to the PRD's "payment
 * succeeds but stock update fails" case — there is no window in which money is
 * recorded and stock is not, because both are the same write.
 *
 * Stock is re-read *inside* the transaction. The screen may have been showing
 * one unit left for ten minutes; what matters is what is there at commit.
 */
export function checkout(ctx: RequestContext, input: CheckoutInput) {
  requirePermission(ctx, 'inventory.manage');
  requireBranch(ctx, input.branchId);
  if (input.lines.length === 0) throw invalid('A sale needs at least one line.');
  if (input.payments.length === 0) throw invalid('A sale needs at least one payment.');
  // Checked here as well as in `raiseAccountInvoice` so the till is told before
  // it starts pricing a basket it cannot settle.
  if (!input.memberId && input.payments.some((p) => p.method === 'account')) {
    throw invalid('Charging a sale to an account needs a member. Pick one, or take another tender.');
  }

  return transact(() => {
    const priced: PricedLine[] = [];

    for (const line of input.lines) {
      if (line.quantity <= 0) throw invalid('A quantity must be at least one.');
      const product = productInTenant(ctx, line.productId);
      if (!product.active) throw precondition(`${product.name} is retired and cannot be sold.`);
      const cost = averageCost(ctx.tenantId, product.id, product.costMinor);
      priced.push(priceLine(product, line.quantity, line.discountMinor ?? 0, cost));
    }

    const subtotalMinor = priced.reduce((sum, l) => sum + l.unitMinor * l.quantity, 0);
    const discountMinor = priced.reduce((sum, l) => sum + l.discountMinor, 0);
    const taxMinor = priced.reduce((sum, l) => sum + l.taxMinor, 0);
    const totalMinor = priced.reduce((sum, l) => sum + l.totalMinor, 0);

    const tendered = input.payments.reduce((sum, p) => sum + p.amountMinor, 0);
    if (input.payments.some((p) => p.amountMinor <= 0)) throw invalid('Every payment must be a positive amount.');
    // Mixed tender has to add up exactly. Letting it round would quietly
    // create or destroy money in the day's takings.
    if (tendered !== totalMinor) {
      throw invalid(`Payments total ${tendered} but the sale is ${totalMinor}.`);
    }

    if (input.memberId) {
      const member = db
        .select({ id: schema.members.id })
        .from(schema.members)
        .where(and(eq(schema.members.id, input.memberId), eq(schema.members.tenantId, ctx.tenantId)))
        .get();
      if (!member) throw notFound('That member');
    }

    const orderId = id('pos');
    const at = now();
    const reference = `SF-${new Date(at).toISOString().slice(0, 10).replaceAll('-', '')}-${orderId.slice(-5).toUpperCase()}`;

    db.insert(schema.posOrders)
      .values({
        id: orderId,
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        reference,
        memberId: input.memberId ?? null,
        subtotalMinor,
        discountMinor,
        taxMinor,
        totalMinor,
        state: 'paid',
        kind: 'sale',
        returnOfOrderId: null,
        voidReason: null,
        voidedAt: null,
        staffId: ctx.staffId,
        staffName: ctx.name,
        invoiceId: null,
        createdAt: at,
      })
      .run();

    for (const line of priced) {
      db.insert(schema.posOrderLines)
        .values({
          id: id('pol'),
          tenantId: ctx.tenantId,
          orderId,
          productId: line.productId,
          name: line.name,
          quantity: line.quantity,
          unitMinor: line.unitMinor,
          taxRateBp: line.taxRateBp,
          taxMinor: line.taxMinor,
          discountMinor: line.discountMinor,
          unitCostMinor: line.unitCostMinor,
          quantityReturned: 0,
          totalMinor: line.totalMinor,
        })
        .run();

      writeMovement(ctx, {
        branchId: input.branchId,
        productId: line.productId,
        delta: -line.quantity,
        reason: 'sale',
        refType: 'pos_order',
        refId: orderId,
        overrideReason: input.overrideReason ?? null,
      });
    }

    for (const payment of input.payments) {
      db.insert(schema.posPayments)
        .values({
          id: id('pay'),
          tenantId: ctx.tenantId,
          orderId,
          method: payment.method,
          amountMinor: payment.amountMinor,
          reference: payment.reference ?? '',
          at,
        })
        .run();
    }

    // An `account` tender is the one that does not settle at the counter, so
    // it is the only one that becomes a receivable. See `raiseAccountInvoice`.
    const onAccountMinor = input.payments
      .filter((p) => p.method === 'account')
      .reduce((sum, p) => sum + p.amountMinor, 0);
    const invoiceId =
      onAccountMinor > 0
        ? raiseAccountInvoice(ctx, {
            orderId,
            reference,
            branchId: input.branchId,
            memberId: input.memberId ?? null,
            amountMinor: onAccountMinor,
            lines: priced,
          })
        : null;
    if (invoiceId) {
      db.update(schema.posOrders).set({ invoiceId }).where(eq(schema.posOrders.id, orderId)).run();
    }

    audit(ctx, {
      action: 'store.sale',
      entityType: 'pos_order',
      entityId: orderId,
      entityLabel: reference,
      branchId: input.branchId,
      after: {
        totalMinor,
        lines: priced.length,
        memberId: input.memberId ?? null,
        onAccountMinor,
        invoiceId,
      },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      channel: channels.branch(input.branchId),
      topic: 'pos.sale_completed',
      payload: {
        orderId,
        reference,
        totalMinor,
        lines: priced.length,
        memberId: input.memberId ?? null,
        invoiceId,
      },
    });
    emitStockChanged(
      ctx,
      input.branchId,
      priced.map((l) => ({
        productId: l.productId,
        name: l.name,
        onHand: onHand(ctx.tenantId, input.branchId, l.productId),
      })),
      'sale',
    );
    emitLowStockFor(ctx, input.branchId, priced.map((l) => l.productId));

    return getOrder(ctx, orderId);
  });
}

/* ——— Account tender ———————————————————————————————————————————— */

interface AccountInvoiceInput {
  orderId: string;
  reference: string;
  branchId: string;
  memberId: string | null;
  amountMinor: number;
  lines: PricedLine[];
}

/**
 * Turn the on-account portion of a sale into a real invoice.
 *
 * This is the whole of `pos_orders.invoice_id`, and the restraint is the point.
 * Cash, card and UPI settle at the counter: the money is in the drawer before
 * the customer leaves, there is no receivable, and minting an invoice that is
 * born paid would double-count the day's takings against the billing ledger and
 * put a stack of meaningless documents in the member's account. Those receipts
 * stay standalone and `invoice_id` stays null — deliberately, not for want of
 * wiring.
 *
 * An `account` tender is different in kind. Nothing was collected; the member
 * owes the gym. That is exactly what an invoice is for, so it becomes one,
 * using the same tables and numbering as the rest of billing rather than a
 * parallel receivable only the shop knows about.
 *
 * `invoices.member_id` is NOT NULL, which is also the reason this cannot be
 * generalised: a walk-in has no member to bill, so an account tender without a
 * member is refused at the till rather than papered over with a placeholder.
 */
function raiseAccountInvoice(ctx: RequestContext, input: AccountInvoiceInput): string {
  if (!input.memberId) {
    throw invalid('Charging a sale to an account needs a member. Pick one, or take another tender.');
  }

  const invoiceId = id('inv');
  const at = now();
  const issuedOn = isoDate(at, 'Asia/Kolkata');

  // Only the on-account share is billed. A basket half-settled in cash leaves a
  // receivable for the remainder, not for the whole sale.
  const share = input.amountMinor / input.lines.reduce((sum, l) => sum + l.totalMinor, 0);
  const taxMinor = Math.round(input.lines.reduce((sum, l) => sum + l.taxMinor, 0) * share);

  db.insert(schema.invoices)
    .values({
      id: invoiceId,
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      memberId: input.memberId,
      number: nextInvoiceNumber(ctx.tenantId),
      state: 'open',
      issuedOn,
      dueOn: addDays(issuedOn, 7),
      currency: 'INR',
      subtotalMinor: input.amountMinor - taxMinor,
      discountMinor: 0,
      taxMinor,
      totalMinor: input.amountMinor,
      paidMinor: 0,
      refundedMinor: 0,
      voided: false,
      voidReason: null,
      refType: 'pos_order',
      refId: input.orderId,
      createdAt: at,
      updatedAt: at,
    })
    .run();

  db.insert(schema.invoiceLines)
    .values({
      id: id('ivl'),
      tenantId: ctx.tenantId,
      invoiceId,
      description: `Shop purchase ${input.reference}`,
      quantity: 1,
      unitMinor: input.amountMinor - taxMinor,
      discountMinor: 0,
      taxRateBp: 0,
      taxMinor,
      totalMinor: input.amountMinor,
      productId: null,
    })
    .run();

  emit({
    tenantId: ctx.tenantId,
    branchId: input.branchId,
    channel: channels.member(input.memberId),
    topic: 'invoice.updated',
    payload: { invoiceId, state: 'open', source: 'pos', orderId: input.orderId },
  });

  return invoiceId;
}

/* ——— Return and void ————————————————————————————————————————— */

export interface ReturnLineInput {
  lineId: string;
  quantity: number;
}

/**
 * Return some or all of a sale (PF-POS-002).
 *
 * A return is a new order pointing at the original, and the stock comes back
 * through a fresh ledger entry. Nothing about the original sale is edited —
 * yesterday's takings stay what they were.
 *
 * The branch is the branch of the *return*, which is how "item returned to
 * another branch" works: stock lands where the customer actually stood.
 */
export function returnOrder(
  ctx: RequestContext,
  orderId: string,
  lines: ReturnLineInput[],
  reason: string,
  branchId?: string,
) {
  requirePermission(ctx, 'inventory.manage');
  const original = orderInScope(ctx, orderId);
  if (original.kind !== 'sale') throw precondition('Only a sale can be returned.');
  if (original.state === 'voided') throw precondition('That sale was voided; there is nothing to return.');
  if (lines.length === 0) throw invalid('A return needs at least one line.');
  if (reason.trim().length < 4) throw invalid('Give a reason for the return.');

  const returnBranch = branchId ?? original.branchId;
  requireBranch(ctx, returnBranch);

  return transact(() => {
    const originalLines = db
      .select()
      .from(schema.posOrderLines)
      .where(and(eq(schema.posOrderLines.orderId, orderId), eq(schema.posOrderLines.tenantId, ctx.tenantId)))
      .all();

    let subtotalMinor = 0;
    let discountMinor = 0;
    let taxMinor = 0;
    let totalMinor = 0;
    const returnId = id('pos');
    const at = now();

    for (const req of lines) {
      const line = originalLines.find((l) => l.id === req.lineId);
      if (!line) throw notFound('That order line');
      if (req.quantity <= 0) throw invalid('A returned quantity must be at least one.');
      const remaining = line.quantity - line.quantityReturned;
      if (req.quantity > remaining) {
        throw precondition(`Only ${remaining} of ${line.name} remain returnable on this sale.`);
      }

      // Refund the proportion of what was actually charged, discount included,
      // so a half-price basket does not refund at full price.
      const share = req.quantity / line.quantity;
      const lineDiscount = Math.round(line.discountMinor * share);
      const lineGross = line.unitMinor * req.quantity;
      const lineTax = Math.round(line.taxMinor * share);
      const lineTotal = lineGross - lineDiscount + lineTax;

      subtotalMinor += lineGross;
      discountMinor += lineDiscount;
      taxMinor += lineTax;
      totalMinor += lineTotal;

      db.insert(schema.posOrderLines)
        .values({
          id: id('pol'),
          tenantId: ctx.tenantId,
          orderId: returnId,
          productId: line.productId,
          name: line.name,
          quantity: -req.quantity,
          unitMinor: line.unitMinor,
          taxRateBp: line.taxRateBp,
          taxMinor: -lineTax,
          discountMinor: -lineDiscount,
          unitCostMinor: line.unitCostMinor,
          quantityReturned: 0,
          totalMinor: -lineTotal,
        })
        .run();

      db.update(schema.posOrderLines)
        .set({ quantityReturned: line.quantityReturned + req.quantity })
        .where(eq(schema.posOrderLines.id, line.id))
        .run();

      // A product retired since the sale still takes its stock back: the item
      // physically exists and refusing would strand it off the books.
      writeMovement(ctx, {
        branchId: returnBranch,
        productId: line.productId,
        delta: req.quantity,
        reason: 'return',
        refType: 'pos_order',
        refId: returnId,
        note: reason,
        unitCostMinor: line.unitCostMinor,
      });
    }

    db.insert(schema.posOrders)
      .values({
        id: returnId,
        tenantId: ctx.tenantId,
        branchId: returnBranch,
        reference: `${original.reference}-R`,
        memberId: original.memberId,
        subtotalMinor: -subtotalMinor,
        discountMinor: -discountMinor,
        taxMinor: -taxMinor,
        totalMinor: -totalMinor,
        state: 'paid',
        kind: 'return',
        returnOfOrderId: orderId,
        voidReason: null,
        voidedAt: null,
        staffId: ctx.staffId,
        staffName: ctx.name,
        invoiceId: null,
        createdAt: at,
      })
      .run();

    const after = db
      .select()
      .from(schema.posOrderLines)
      .where(and(eq(schema.posOrderLines.orderId, orderId), eq(schema.posOrderLines.tenantId, ctx.tenantId)))
      .all();
    const fullyReturned = after.every((l) => l.quantityReturned >= l.quantity);
    db.update(schema.posOrders)
      .set({ state: fullyReturned ? 'returned' : 'partially_returned' })
      .where(eq(schema.posOrders.id, orderId))
      .run();

    audit(ctx, {
      action: 'store.return',
      entityType: 'pos_order',
      entityId: returnId,
      entityLabel: `${original.reference} → return`,
      branchId: returnBranch,
      reason,
      after: { totalMinor: -totalMinor, returnedTo: returnBranch, of: orderId },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: returnBranch,
      channel: channels.branch(returnBranch),
      topic: 'pos.return_completed',
      payload: {
        orderId: returnId,
        reference: `${original.reference}-R`,
        ofOrderId: orderId,
        refundMinor: totalMinor,
        fullyReturned,
      },
    });
    // Stock came back at the branch that took the return, which may not be the
    // branch that sold it — that shelf is the one whose console is now stale.
    emitStockChanged(
      ctx,
      returnBranch,
      lines.map((l) => {
        const line = originalLines.find((o) => o.id === l.lineId);
        return {
          productId: line?.productId ?? '',
          name: line?.name ?? '',
          onHand: line ? onHand(ctx.tenantId, returnBranch, line.productId) : 0,
        };
      }),
      'return',
    );

    return getOrder(ctx, returnId);
  });
}

/** Void a sale outright: stock back, order marked, reason recorded. */
export function voidOrder(ctx: RequestContext, orderId: string, reason: string) {
  requirePermission(ctx, 'inventory.manage');
  const order = orderInScope(ctx, orderId);
  if (order.state === 'voided') throw conflict('That sale is already voided.');
  if (order.kind !== 'sale') throw precondition('Only a sale can be voided.');
  if (reason.trim().length < 4) throw invalid('Give a reason for voiding this sale.');

  return transact(() => {
    const lines = db
      .select()
      .from(schema.posOrderLines)
      .where(and(eq(schema.posOrderLines.orderId, orderId), eq(schema.posOrderLines.tenantId, ctx.tenantId)))
      .all();

    for (const line of lines) {
      const outstanding = line.quantity - line.quantityReturned;
      if (outstanding <= 0) continue;
      writeMovement(ctx, {
        branchId: order.branchId,
        productId: line.productId,
        delta: outstanding,
        reason: 'return',
        refType: 'pos_order_void',
        refId: orderId,
        note: reason,
        unitCostMinor: line.unitCostMinor,
      });
    }

    db.update(schema.posOrders)
      .set({ state: 'voided', voidReason: reason, voidedAt: now() })
      .where(eq(schema.posOrders.id, orderId))
      .run();

    audit(ctx, {
      action: 'store.void',
      entityType: 'pos_order',
      entityId: orderId,
      entityLabel: order.reference,
      branchId: order.branchId,
      reason,
      before: { state: order.state },
      after: { state: 'voided' },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: order.branchId,
      channel: channels.branch(order.branchId),
      topic: 'pos.order_voided',
      payload: { orderId, reference: order.reference, totalMinor: order.totalMinor, reason },
    });
    emitStockChanged(
      ctx,
      order.branchId,
      lines.map((l) => ({
        productId: l.productId,
        name: l.name,
        onHand: onHand(ctx.tenantId, order.branchId, l.productId),
      })),
      'void',
    );

    return getOrder(ctx, orderId);
  });
}

/* ——— Reads ——————————————————————————————————————————————————— */

export function getOrder(ctx: RequestContext, orderId: string): PosOrderDetail {
  const order = orderInScope(ctx, orderId);
  const lines = db
    .select()
    .from(schema.posOrderLines)
    .where(and(eq(schema.posOrderLines.orderId, orderId), eq(schema.posOrderLines.tenantId, ctx.tenantId)))
    .all();
  const payments = db
    .select()
    .from(schema.posPayments)
    .where(and(eq(schema.posPayments.orderId, orderId), eq(schema.posPayments.tenantId, ctx.tenantId)))
    .all();

  const access = financialAccess(ctx);
  const branches = branchNames(ctx.tenantId);
  const original = order.returnOfOrderId
    ? db.select().from(schema.posOrders).where(eq(schema.posOrders.id, order.returnOfOrderId)).get()
    : null;
  const members = memberNames(
    ctx.tenantId,
    [order.memberId, original?.memberId ?? null].filter((m): m is string => m !== null),
  );

  return {
    order: toOrderSummary(order, branches, members),
    lines: lines.map((l) => toOrderLine(l, access)),
    tenders: payments.map(toTender),
    returnedFrom: original ? toOrderSummary(original, branches, members) : null,
    financial: access,
  };
}

export interface OrderQuery {
  branchId?: string | null;
  staffId?: string | null;
  method?: string | null;
  from?: number | null;
  to?: number | null;
  limit?: number;
  /** Matches the receipt reference or the staff member who took the sale. */
  search?: string | null;
}

export function listOrders(ctx: RequestContext, query: OrderQuery): PosOrderList {
  requirePermission(ctx, 'inventory.view');
  const conditions = [eq(schema.posOrders.tenantId, ctx.tenantId)];
  if (query.branchId) {
    requireBranch(ctx, query.branchId);
    conditions.push(eq(schema.posOrders.branchId, query.branchId));
  } else {
    // No branch filter means "every branch I may see", never every branch.
    conditions.push(inArray(schema.posOrders.branchId, ctx.branchIds));
  }
  if (query.staffId) conditions.push(eq(schema.posOrders.staffId, query.staffId));
  if (query.from) conditions.push(sql`${schema.posOrders.createdAt} >= ${query.from}`);
  if (query.to) conditions.push(sql`${schema.posOrders.createdAt} <= ${query.to}`);

  let rows = db
    .select()
    .from(schema.posOrders)
    .where(and(...conditions))
    .orderBy(desc(schema.posOrders.createdAt))
    .limit(query.limit ?? 100)
    .all();

  if (query.method) {
    const paid = new Set(
      db
        .select({ orderId: schema.posPayments.orderId })
        .from(schema.posPayments)
        .where(and(eq(schema.posPayments.tenantId, ctx.tenantId), eq(schema.posPayments.method, query.method)))
        .all()
        .map((r) => r.orderId),
    );
    rows = rows.filter((r) => paid.has(r.id));
  }

  if (query.search) {
    const needle = query.search.trim().toLowerCase();
    rows = rows.filter(
      (r) => r.reference.toLowerCase().includes(needle) || r.staffName.toLowerCase().includes(needle),
    );
  }

  const branches = branchNames(ctx.tenantId);
  const members = memberNames(ctx.tenantId, rows.map((r) => r.memberId).filter((m): m is string => m !== null));
  return { items: rows.map((r) => toOrderSummary(r, branches, members)) };
}

export interface ProductQuery {
  branchId?: string | null;
  category?: string | null;
  active?: boolean | null;
  lowStock?: boolean;
  search?: string | null;
}

export function listProducts(ctx: RequestContext, query: ProductQuery): StoreProductList {
  requirePermission(ctx, 'inventory.view');
  const branchId = query.branchId ?? null;
  if (branchId) requireBranch(ctx, branchId);

  const conditions = [eq(schema.retailProducts.tenantId, ctx.tenantId)];
  if (query.category) conditions.push(eq(schema.retailProducts.category, query.category));
  if (query.active !== null && query.active !== undefined) {
    conditions.push(eq(schema.retailProducts.active, query.active));
  }

  const products = db
    .select()
    .from(schema.retailProducts)
    .where(and(...conditions))
    .all();

  const stock = onHandMap(ctx.tenantId, branchId);
  const groups = new Map(
    db
      .select()
      .from(schema.retailProductGroups)
      .where(eq(schema.retailProductGroups.tenantId, ctx.tenantId))
      .all()
      .map((g) => [g.id, g]),
  );
  const suppliers = new Map(
    db
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.tenantId, ctx.tenantId))
      .all()
      .map((s) => [s.id, s]),
  );

  const access = financialAccess(ctx);
  const search = query.search?.trim().toLowerCase();
  let items = products.map((p) => {
    const qty = stock.get(p.id) ?? 0;
    return toProduct(
      p,
      {
        onHand: qty,
        // Valuation is only computed when it will be shown. Weighted average
        // cost is a query per product, and reception never sees the answer.
        valuationMinor: access.canSeeMargin ? qty * averageCost(ctx.tenantId, p.id, p.costMinor) : 0,
        groupName: p.groupId ? (groups.get(p.groupId)?.name ?? null) : null,
        supplierName: p.supplierId ? (suppliers.get(p.supplierId)?.name ?? null) : null,
      },
      access,
    );
  });

  if (query.lowStock) items = items.filter((i) => i.lowStock);
  if (search) {
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(search) ||
        i.sku.toLowerCase().includes(search) ||
        (i.barcode ?? '').toLowerCase().includes(search),
    );
  }
  return { items: items.sort((a, b) => a.name.localeCompare(b.name)), financial: access };
}

/** Scan-to-sell: a barcode resolves to exactly one SKU or nothing. */
export function findByBarcode(ctx: RequestContext, barcode: string, branchId?: string | null): StoreProduct {
  requirePermission(ctx, 'inventory.view');
  const product = db
    .select()
    .from(schema.retailProducts)
    .where(and(eq(schema.retailProducts.tenantId, ctx.tenantId), eq(schema.retailProducts.barcode, barcode)))
    .get();
  if (!product) throw notFound('That barcode');
  if (branchId) requireBranch(ctx, branchId);
  return hydrateProduct(ctx, product, branchId ?? null);
}

/** One product in the shape the console reads, with stock for a branch scope. */
function hydrateProduct(
  ctx: RequestContext,
  row: typeof schema.retailProducts.$inferSelect,
  branchId: string | null,
): StoreProduct {
  const access = financialAccess(ctx);
  const qty = branchId ? onHand(ctx.tenantId, branchId, row.id) : (onHandMap(ctx.tenantId, null).get(row.id) ?? 0);
  const group = row.groupId
    ? db.select().from(schema.retailProductGroups).where(eq(schema.retailProductGroups.id, row.groupId)).get()
    : null;
  const supplier = row.supplierId
    ? db.select().from(schema.suppliers).where(eq(schema.suppliers.id, row.supplierId)).get()
    : null;
  return toProduct(
    row,
    {
      onHand: qty,
      valuationMinor: access.canSeeMargin ? qty * averageCost(ctx.tenantId, row.id, row.costMinor) : 0,
      groupName: group?.name ?? null,
      supplierName: supplier?.name ?? null,
    },
    access,
  );
}

/* ——— Catalogue ———————————————————————————————————————————————— */

export interface ProductInput {
  name: string;
  sku: string;
  barcode?: string | null;
  category: string;
  priceMinor: number;
  costMinor: number;
  taxRateBp?: number;
  reorderAt?: number;
  groupId?: string | null;
  variantName?: string | null;
  supplierId?: string | null;
}

function assertBarcodeFree(ctx: RequestContext, barcode: string | null | undefined, exceptId?: string): void {
  if (!barcode) return;
  const clash = db
    .select({ id: schema.retailProducts.id, name: schema.retailProducts.name })
    .from(schema.retailProducts)
    .where(and(eq(schema.retailProducts.tenantId, ctx.tenantId), eq(schema.retailProducts.barcode, barcode)))
    .get();
  // A scanner cannot ask which product you meant, so a duplicate barcode is a
  // conflict at write time rather than a surprise at the till.
  if (clash && clash.id !== exceptId) throw conflict(`That barcode already belongs to ${clash.name}.`);
}

export function createProduct(ctx: RequestContext, input: ProductInput): StoreProduct {
  requirePermission(ctx, 'inventory.manage');
  if (input.priceMinor < 0 || input.costMinor < 0) throw invalid('Price and cost cannot be negative.');
  assertBarcodeFree(ctx, input.barcode);

  const existingSku = db
    .select({ id: schema.retailProducts.id })
    .from(schema.retailProducts)
    .where(and(eq(schema.retailProducts.tenantId, ctx.tenantId), eq(schema.retailProducts.sku, input.sku)))
    .get();
  if (existingSku) throw conflict('That SKU already exists.');

  if (input.groupId) {
    const group = db
      .select({ id: schema.retailProductGroups.id })
      .from(schema.retailProductGroups)
      .where(
        and(eq(schema.retailProductGroups.id, input.groupId), eq(schema.retailProductGroups.tenantId, ctx.tenantId)),
      )
      .get();
    if (!group) throw notFound('That product group');
  }

  const productId = id('rtl');
  db.insert(schema.retailProducts)
    .values({
      id: productId,
      tenantId: ctx.tenantId,
      name: input.name,
      sku: input.sku,
      barcode: input.barcode ?? null,
      category: input.category,
      groupId: input.groupId ?? null,
      variantName: input.variantName ?? '',
      supplierId: input.supplierId ?? null,
      priceMinor: input.priceMinor,
      costMinor: input.costMinor,
      taxRateBp: input.taxRateBp ?? 1800,
      reorderAt: input.reorderAt ?? 5,
      active: true,
      createdAt: now(),
    })
    .run();

  audit(ctx, {
    action: 'store.product_created',
    entityType: 'retail_product',
    entityId: productId,
    entityLabel: input.name,
    after: { sku: input.sku, priceMinor: input.priceMinor },
  });
  return hydrateProduct(ctx, productInTenant(ctx, productId), null);
}

export function updateProduct(
  ctx: RequestContext,
  productId: string,
  patch: Partial<ProductInput> & { active?: boolean },
): StoreProduct {
  requirePermission(ctx, 'inventory.manage');
  const before = productInTenant(ctx, productId);
  if (patch.barcode !== undefined) assertBarcodeFree(ctx, patch.barcode, productId);

  db.update(schema.retailProducts)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.barcode !== undefined ? { barcode: patch.barcode } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.priceMinor !== undefined ? { priceMinor: patch.priceMinor } : {}),
      ...(patch.costMinor !== undefined ? { costMinor: patch.costMinor } : {}),
      ...(patch.taxRateBp !== undefined ? { taxRateBp: patch.taxRateBp } : {}),
      ...(patch.reorderAt !== undefined ? { reorderAt: patch.reorderAt } : {}),
      ...(patch.supplierId !== undefined ? { supplierId: patch.supplierId } : {}),
      ...(patch.variantName !== undefined ? { variantName: patch.variantName ?? '' } : {}),
      ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    })
    .where(eq(schema.retailProducts.id, productId))
    .run();

  const after = productInTenant(ctx, productId);
  audit(ctx, {
    action: 'store.product_updated',
    entityType: 'retail_product',
    entityId: productId,
    entityLabel: after.name,
    before: { priceMinor: before.priceMinor, costMinor: before.costMinor, active: before.active },
    after: { priceMinor: after.priceMinor, costMinor: after.costMinor, active: after.active },
  });
  return hydrateProduct(ctx, after, null);
}

export function createSupplier(
  ctx: RequestContext,
  input: { name: string; contactName?: string; email?: string; phone?: string; leadTimeDays?: number },
): Supplier {
  requirePermission(ctx, 'inventory.manage');
  const supplierId = id('sup');
  db.insert(schema.suppliers)
    .values({
      id: supplierId,
      tenantId: ctx.tenantId,
      name: input.name,
      contactName: input.contactName ?? '',
      email: input.email ?? '',
      phone: input.phone ?? '',
      leadTimeDays: input.leadTimeDays ?? 7,
      active: true,
      createdAt: now(),
    })
    .run();
  audit(ctx, { action: 'store.supplier_created', entityType: 'supplier', entityId: supplierId, entityLabel: input.name });
  return toSupplier(db.select().from(schema.suppliers).where(eq(schema.suppliers.id, supplierId)).get()!);
}

const toSupplier = (row: typeof schema.suppliers.$inferSelect): Supplier => ({
  id: row.id,
  name: row.name,
  contactName: row.contactName,
  email: row.email,
  phone: row.phone,
  leadTimeDays: row.leadTimeDays,
  active: row.active,
  createdAt: iso(row.createdAt),
});

export function listSuppliers(ctx: RequestContext): { items: Supplier[] } {
  requirePermission(ctx, 'inventory.view');
  return {
    items: db
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.tenantId, ctx.tenantId))
      .all()
      .map(toSupplier),
  };
}

export function createGroup(
  ctx: RequestContext,
  input: { name: string; category: string; supplierId?: string | null },
): ProductGroup {
  requirePermission(ctx, 'inventory.manage');
  const groupId = id('grp');
  db.insert(schema.retailProductGroups)
    .values({
      id: groupId,
      tenantId: ctx.tenantId,
      name: input.name,
      category: input.category,
      supplierId: input.supplierId ?? null,
      active: true,
      createdAt: now(),
    })
    .run();
  audit(ctx, { action: 'store.group_created', entityType: 'retail_product_group', entityId: groupId, entityLabel: input.name });
  const row = db.select().from(schema.retailProductGroups).where(eq(schema.retailProductGroups.id, groupId)).get()!;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    supplierId: row.supplierId,
    active: row.active,
    createdAt: iso(row.createdAt),
  };
}

export function listGroups(ctx: RequestContext): { items: ProductGroup[] } {
  requirePermission(ctx, 'inventory.view');
  return {
    items: db
      .select()
      .from(schema.retailProductGroups)
      .where(eq(schema.retailProductGroups.tenantId, ctx.tenantId))
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        supplierId: row.supplierId,
        active: row.active,
        createdAt: iso(row.createdAt),
      })),
  };
}

/* ——— Stock adjustment ————————————————————————————————————————— */

export interface AdjustInput {
  branchId: string;
  delta: number;
  reason: 'purchase' | 'adjustment' | 'damage';
  note?: string | null;
  unitCostMinor?: number | null;
  overrideReason?: string | null;
}

export function adjustStock(ctx: RequestContext, productId: string, input: AdjustInput): StockAdjustResult {
  requirePermission(ctx, 'inventory.manage');
  requireBranch(ctx, input.branchId);
  const product = productInTenant(ctx, productId);

  return transact(() => {
    writeMovement(ctx, {
      branchId: input.branchId,
      productId,
      delta: input.delta,
      reason: input.reason,
      refType: 'manual',
      refId: null,
      note: input.note ?? null,
      unitCostMinor: input.unitCostMinor ?? product.costMinor,
      overrideReason: input.overrideReason ?? null,
    });

    const qty = onHand(ctx.tenantId, input.branchId, productId);
    audit(ctx, {
      action: 'store.stock_adjusted',
      entityType: 'retail_product',
      entityId: productId,
      entityLabel: product.name,
      branchId: input.branchId,
      reason: input.note ?? input.reason,
      after: { delta: input.delta, onHand: qty, reason: input.reason },
    });

    const lowStock = qty <= product.reorderAt;
    emitStockChanged(ctx, input.branchId, [{ productId, name: displayNameOf(product), onHand: qty }], input.reason);
    if (lowStock) {
      emit({
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        channel: channels.branch(input.branchId),
        topic: 'stock.low',
        payload: {
          productId,
          name: displayNameOf(product),
          sku: product.sku,
          onHand: qty,
          reorderAt: product.reorderAt,
        },
      });
    }

    return { productId, branchId: input.branchId, onHand: qty, lowStock };
  });
}

/* ——— Inter-branch transfer ———————————————————————————————————— */

export interface TransferLineInput {
  productId: string;
  quantity: number;
}

/**
 * Move stock between branches (PF-POS-005).
 *
 * Dispatch and receipt are separate acts because stock in a van belongs to
 * neither branch's shelf. Dispatch writes the outbound row; receipt writes the
 * inbound one. Between the two the goods are off both shelves and visible as
 * an open transfer, which is what a stocktake needs to see.
 */
export function createTransfer(
  ctx: RequestContext,
  input: { fromBranchId: string; toBranchId: string; lines: TransferLineInput[]; note?: string | null },
) {
  requirePermission(ctx, 'inventory.manage');
  requireBranch(ctx, input.fromBranchId);
  requireBranch(ctx, input.toBranchId);
  if (input.fromBranchId === input.toBranchId) throw invalid('A transfer needs two different branches.');
  if (input.lines.length === 0) throw invalid('A transfer needs at least one line.');

  return transact(() => {
    const transferId = id('trf');
    const at = now();
    db.insert(schema.stockTransfers)
      .values({
        id: transferId,
        tenantId: ctx.tenantId,
        reference: `TR-${transferId.slice(-6).toUpperCase()}`,
        fromBranchId: input.fromBranchId,
        toBranchId: input.toBranchId,
        state: 'draft',
        note: input.note ?? null,
        createdBy: ctx.name,
        dispatchedAt: null,
        dispatchedBy: null,
        receivedAt: null,
        receivedBy: null,
        cancelledAt: null,
        createdAt: at,
      })
      .run();

    for (const line of input.lines) {
      if (line.quantity <= 0) throw invalid('A transfer quantity must be at least one.');
      const product = productInTenant(ctx, line.productId);
      db.insert(schema.stockTransferLines)
        .values({
          id: id('trl'),
          tenantId: ctx.tenantId,
          transferId,
          productId: line.productId,
          quantity: line.quantity,
          quantityReceived: 0,
          unitCostMinor: averageCost(ctx.tenantId, line.productId, product.costMinor),
        })
        .run();
    }

    audit(ctx, {
      action: 'store.transfer_created',
      entityType: 'stock_transfer',
      entityId: transferId,
      branchId: input.fromBranchId,
      after: { to: input.toBranchId, lines: input.lines.length },
    });
    emitTransferUpdated(ctx, transferId, 'draft');
    return getTransfer(ctx, transferId);
  });
}

function transferInScope(ctx: RequestContext, transferId: string) {
  const transfer = db
    .select()
    .from(schema.stockTransfers)
    .where(and(eq(schema.stockTransfers.id, transferId), eq(schema.stockTransfers.tenantId, ctx.tenantId)))
    .get();
  if (!transfer) throw notFound('That transfer');
  const visible = ctx.branchIds.includes(transfer.fromBranchId) || ctx.branchIds.includes(transfer.toBranchId);
  if (!visible) throw notFound('That transfer');
  return transfer;
}

export function getTransfer(ctx: RequestContext, transferId: string): StockTransferDetail {
  const transfer = transferInScope(ctx, transferId);
  const lines = db
    .select()
    .from(schema.stockTransferLines)
    .where(eq(schema.stockTransferLines.transferId, transferId))
    .all();

  const access = financialAccess(ctx);
  const products = new Map(
    lines.length
      ? db
          .select()
          .from(schema.retailProducts)
          .where(inArray(schema.retailProducts.id, [...new Set(lines.map((l) => l.productId))]))
          .all()
          .map((p) => [p.id, p])
      : [],
  );
  const state = transfer.state as StockTransferState;
  return {
    transfer: toTransfer(transfer, lines, branchNames(ctx.tenantId)),
    lines: lines.map((l) => toTransferLine(l, products.get(l.productId), state, access)),
    financial: access,
  };
}

export function listTransfers(ctx: RequestContext, state?: string | null): StockTransferList {
  requirePermission(ctx, 'inventory.view');
  const conditions = [eq(schema.stockTransfers.tenantId, ctx.tenantId)];
  if (state) conditions.push(eq(schema.stockTransfers.state, state));
  const rows = db
    .select()
    .from(schema.stockTransfers)
    .where(and(...conditions))
    .orderBy(desc(schema.stockTransfers.createdAt))
    .all()
    .filter((t) => ctx.branchIds.includes(t.fromBranchId) || ctx.branchIds.includes(t.toBranchId));

  // One query for every line rather than one per transfer, so the list stays
  // flat as the history grows.
  const allLines = rows.length
    ? db
        .select()
        .from(schema.stockTransferLines)
        .where(inArray(schema.stockTransferLines.transferId, rows.map((r) => r.id)))
        .all()
    : [];
  const byTransfer = new Map<string, Array<typeof schema.stockTransferLines.$inferSelect>>();
  for (const line of allLines) {
    const bucket = byTransfer.get(line.transferId);
    if (bucket) bucket.push(line);
    else byTransfer.set(line.transferId, [line]);
  }

  const branches = branchNames(ctx.tenantId);
  return { items: rows.map((r) => toTransfer(r, byTransfer.get(r.id) ?? [], branches)) };
}

export function dispatchTransfer(ctx: RequestContext, transferId: string, overrideReason?: string | null) {
  requirePermission(ctx, 'inventory.manage');
  const transfer = transferInScope(ctx, transferId);
  if (transfer.state !== 'draft') throw precondition(`That transfer is already ${transfer.state}.`);
  requireBranch(ctx, transfer.fromBranchId);

  return transact(() => {
    const lines = db
      .select()
      .from(schema.stockTransferLines)
      .where(eq(schema.stockTransferLines.transferId, transferId))
      .all();

    for (const line of lines) {
      writeMovement(ctx, {
        branchId: transfer.fromBranchId,
        productId: line.productId,
        delta: -line.quantity,
        reason: 'transfer_out',
        refType: 'stock_transfer',
        refId: transferId,
        overrideReason: overrideReason ?? null,
      });
    }

    db.update(schema.stockTransfers)
      .set({ state: 'dispatched', dispatchedAt: now(), dispatchedBy: ctx.name })
      .where(eq(schema.stockTransfers.id, transferId))
      .run();

    audit(ctx, {
      action: 'store.transfer_dispatched',
      entityType: 'stock_transfer',
      entityId: transferId,
      entityLabel: transfer.reference,
      branchId: transfer.fromBranchId,
      before: { state: 'draft' },
      after: { state: 'dispatched' },
    });
    emitTransferUpdated(ctx, transferId, 'dispatched');
    emitStockChanged(
      ctx,
      transfer.fromBranchId,
      lines.map((l) => ({
        productId: l.productId,
        name: '',
        onHand: onHand(ctx.tenantId, transfer.fromBranchId, l.productId),
      })),
      'transfer_out',
    );
    emitLowStockFor(ctx, transfer.fromBranchId, lines.map((l) => l.productId));
    return getTransfer(ctx, transferId);
  });
}

/**
 * Receive a dispatched transfer. A short receipt is allowed and the shortfall
 * is written off as damage at the destination, because pretending the van
 * arrived full would hide the loss in nobody's numbers.
 */
export function receiveTransfer(
  ctx: RequestContext,
  transferId: string,
  received: Array<{ lineId: string; quantity: number }>,
) {
  requirePermission(ctx, 'inventory.manage');
  const transfer = transferInScope(ctx, transferId);
  if (transfer.state !== 'dispatched') throw precondition(`That transfer is ${transfer.state}, not dispatched.`);
  requireBranch(ctx, transfer.toBranchId);

  return transact(() => {
    const lines = db
      .select()
      .from(schema.stockTransferLines)
      .where(eq(schema.stockTransferLines.transferId, transferId))
      .all();

    for (const line of lines) {
      const claim = received.find((r) => r.lineId === line.id);
      const qty = claim ? claim.quantity : line.quantity;
      if (qty < 0) throw invalid('A received quantity cannot be negative.');
      if (qty > line.quantity) throw invalid('Cannot receive more than was dispatched.');

      // Receive the whole dispatched quantity, then write off whatever did not
      // turn up. Booking only what arrived would balance the branches but make
      // the loss invisible: the shrinkage report would show nothing, and the
      // units would simply have evaporated between two ledgers.
      writeMovement(ctx, {
        branchId: transfer.toBranchId,
        productId: line.productId,
        delta: line.quantity,
        reason: 'transfer_in',
        refType: 'stock_transfer',
        refId: transferId,
        unitCostMinor: line.unitCostMinor,
      });

      const missing = line.quantity - qty;
      if (missing > 0) {
        writeMovement(ctx, {
          branchId: transfer.toBranchId,
          productId: line.productId,
          delta: 0 - missing,
          reason: 'damage',
          refType: 'stock_transfer_shortfall',
          refId: transferId,
          note: 'Short on receipt',
          overrideReason: 'Transfer arrived short',
        });
      }

      db.update(schema.stockTransferLines)
        .set({ quantityReceived: qty })
        .where(eq(schema.stockTransferLines.id, line.id))
        .run();
    }

    db.update(schema.stockTransfers)
      .set({ state: 'received', receivedAt: now(), receivedBy: ctx.name })
      .where(eq(schema.stockTransfers.id, transferId))
      .run();

    audit(ctx, {
      action: 'store.transfer_received',
      entityType: 'stock_transfer',
      entityId: transferId,
      entityLabel: transfer.reference,
      branchId: transfer.toBranchId,
      before: { state: 'dispatched' },
      after: { state: 'received' },
    });
    emitTransferUpdated(ctx, transferId, 'received');
    emitStockChanged(
      ctx,
      transfer.toBranchId,
      lines.map((l) => ({
        productId: l.productId,
        name: '',
        onHand: onHand(ctx.tenantId, transfer.toBranchId, l.productId),
      })),
      'transfer_in',
    );
    return getTransfer(ctx, transferId);
  });
}

export function cancelTransfer(ctx: RequestContext, transferId: string, reason: string) {
  requirePermission(ctx, 'inventory.manage');
  const transfer = transferInScope(ctx, transferId);
  // Once stock has left a shelf, cancelling is a receipt decision, not a
  // paperwork one.
  if (transfer.state !== 'draft') throw precondition('Only a draft transfer can be cancelled.');
  if (reason.trim().length < 4) throw invalid('Give a reason for cancelling.');

  db.update(schema.stockTransfers)
    .set({ state: 'cancelled', cancelledAt: now() })
    .where(eq(schema.stockTransfers.id, transferId))
    .run();
  audit(ctx, {
    action: 'store.transfer_cancelled',
    entityType: 'stock_transfer',
    entityId: transferId,
    entityLabel: transfer.reference,
    reason,
    after: { state: 'cancelled' },
  });
  emitTransferUpdated(ctx, transferId, 'cancelled');
  return getTransfer(ctx, transferId);
}

/* ——— Reports ————————————————————————————————————————————————— */

/**
 * Margin, valuation, shrinkage, low stock and sales (PF-POS-006).
 *
 * Margin uses the cost captured on each sold line, not the product's current
 * cost, so restating a supplier price does not rewrite last month's profit.
 * Valuation uses the weighted average of what stock actually cost to buy.
 */
export function reports(
  ctx: RequestContext,
  opts: { branchId?: string | null; from?: number | null; to?: number | null },
): StoreReport {
  requirePermission(ctx, 'inventory.view');
  const branchId = opts.branchId ?? null;
  if (branchId) requireBranch(ctx, branchId);
  const branchIds = branchId ? [branchId] : ctx.branchIds;
  const from = opts.from ?? 0;
  const to = opts.to ?? now();

  const orders = db
    .select()
    .from(schema.posOrders)
    .where(
      and(
        eq(schema.posOrders.tenantId, ctx.tenantId),
        inArray(schema.posOrders.branchId, branchIds),
        sql`${schema.posOrders.createdAt} >= ${from}`,
        sql`${schema.posOrders.createdAt} <= ${to}`,
      ),
    )
    .all();

  const live = orders.filter((o) => o.state !== 'voided');
  const orderIds = live.map((o) => o.id);
  const lines = orderIds.length
    ? db.select().from(schema.posOrderLines).where(inArray(schema.posOrderLines.orderId, orderIds)).all()
    : [];

  // Returns carry negative quantities, so revenue and cost both net out
  // without a special case.
  const revenueMinor = lines.reduce((sum, l) => sum + (l.unitMinor * l.quantity - l.discountMinor), 0);
  const costMinor = lines.reduce((sum, l) => sum + l.unitCostMinor * l.quantity, 0);
  const taxMinor = lines.reduce((sum, l) => sum + l.taxMinor, 0);
  const unitsSold = lines.reduce((sum, l) => sum + l.quantity, 0);
  const marginMinor = revenueMinor - costMinor;

  const products = db
    .select()
    .from(schema.retailProducts)
    .where(eq(schema.retailProducts.tenantId, ctx.tenantId))
    .all();

  let valuationMinor = 0;
  const lowStock: Array<{ id: string; name: string; sku: string; onHand: number; reorderAt: number }> = [];
  const wantsValuation = ctx.permissions.includes('report.financial');
  for (const branch of branchIds) {
    const stock = onHandMap(ctx.tenantId, branch);
    for (const p of products) {
      const qty = stock.get(p.id) ?? 0;
      if (qty > 0 && wantsValuation) valuationMinor += qty * averageCost(ctx.tenantId, p.id, p.costMinor);
      if (p.active && qty <= p.reorderAt) {
        // The variant is the stock-keeping unit, so "Shark Whey 1kg" alone
        // does not tell a manager which one to reorder.
        lowStock.push({ id: p.id, name: displayNameOf(p), sku: p.sku, onHand: qty, reorderAt: p.reorderAt });
      }
    }
  }

  const shrinkageRows = db
    .select({
      productId: schema.stockLedger.productId,
      qty: sql<number>`coalesce(sum(${schema.stockLedger.delta}), 0)`,
    })
    .from(schema.stockLedger)
    .where(
      and(
        eq(schema.stockLedger.tenantId, ctx.tenantId),
        inArray(schema.stockLedger.branchId, branchIds),
        eq(schema.stockLedger.reason, 'damage'),
        sql`${schema.stockLedger.at} >= ${from}`,
        sql`${schema.stockLedger.at} <= ${to}`,
      ),
    )
    .groupBy(schema.stockLedger.productId)
    .all();

  const costOf = new Map(products.map((p) => [p.id, averageCost(ctx.tenantId, p.id, p.costMinor)]));
  const shrinkageUnits = shrinkageRows.reduce((sum, r) => sum + Math.abs(r.qty), 0);
  const shrinkageMinor = shrinkageRows.reduce(
    (sum, r) => sum + Math.abs(r.qty) * (costOf.get(r.productId) ?? 0),
    0,
  );

  const byProduct = new Map<string, { name: string; units: number; revenueMinor: number; marginMinor: number }>();
  for (const l of lines) {
    const entry = byProduct.get(l.productId) ?? { name: l.name, units: 0, revenueMinor: 0, marginMinor: 0 };
    entry.units += l.quantity;
    entry.revenueMinor += l.unitMinor * l.quantity - l.discountMinor;
    entry.marginMinor += l.unitMinor * l.quantity - l.discountMinor - l.unitCostMinor * l.quantity;
    byProduct.set(l.productId, entry);
  }

  const access = financialAccess(ctx);

  return {
    scope: { branchId, branches: branchIds.length, from: iso(from), to: iso(to) },
    sales: {
      orders: live.filter((o) => o.kind === 'sale').length,
      returns: live.filter((o) => o.kind === 'return').length,
      voided: orders.filter((o) => o.state === 'voided').length,
      unitsSold,
      revenueMinor,
      taxMinor,
    },
    // Withheld whole rather than zeroed. A margin of ₹0 is a real and alarming
    // figure; it must never stand in for "your role may not see this".
    margin: access.canSeeMargin
      ? {
          revenueMinor,
          costMinor,
          marginMinor,
          // Basis points avoid a float percentage in a money report.
          marginBp: revenueMinor === 0 ? 0 : Math.round((marginMinor / revenueMinor) * 10_000),
        }
      : null,
    valuation: access.canSeeMargin ? { valuationMinor, skus: products.length } : null,
    // Units lost is operational — a manager reorders against it — so it stays
    // visible. What those units were worth is the financial half.
    shrinkage: { units: shrinkageUnits, costMinor: access.canSeeMargin ? shrinkageMinor : null },
    lowStock: lowStock.sort((a, b) => a.onHand - b.onHand).slice(0, 50),
    topProducts: [...byProduct.entries()]
      .map(([productId, v]) => ({
        productId,
        name: v.name,
        units: v.units,
        revenueMinor: v.revenueMinor,
        marginMinor: access.canSeeMargin ? v.marginMinor : null,
      }))
      .sort((a, b) => b.revenueMinor - a.revenueMinor)
      .slice(0, 10),
    asOf: iso(now()),
    financial: access,
  };
}

/** Movement history for one product — the audit trail a stocktake argues with. */
export function ledgerFor(ctx: RequestContext, productId: string, branchId?: string | null): StockLedgerPage {
  requirePermission(ctx, 'inventory.view');
  productInTenant(ctx, productId);
  const conditions = [eq(schema.stockLedger.tenantId, ctx.tenantId), eq(schema.stockLedger.productId, productId)];
  if (branchId) {
    requireBranch(ctx, branchId);
    conditions.push(eq(schema.stockLedger.branchId, branchId));
  } else {
    conditions.push(inArray(schema.stockLedger.branchId, ctx.branchIds));
  }
  const rows = db
    .select()
    .from(schema.stockLedger)
    .where(and(...conditions))
    .orderBy(desc(schema.stockLedger.at))
    .limit(200)
    .all();

  const access = financialAccess(ctx);
  const branches = branchNames(ctx.tenantId);
  return { items: rows.map((r) => toMovement(r, branches, access)), financial: access };
}
