import { z } from 'zod';
import { Id, IsoDateTime, Money } from './identity.js';

/* ============================================================================
   Point of sale and inventory — PF-POS-001…006.

   These are the canonical wire shapes for the Store module. The console reads
   them directly; it does not keep a parallel set of interfaces, because a
   client-side fork of a server shape is a bug that typechecks (PF agent
   contract rule 5).

   Two conventions carry through every schema here.

   Money is integer minor units, and a money field that the viewer's role may
   not see is `null` rather than absent or zero. Zero is a real number in a
   shop — it means "no margin", not "not allowed to know" — so restricting a
   field by zeroing it would put a lie in a report. The `financial` block on
   each response says which of them were withheld, and the console renders that
   as a permission state rather than blank data (PF-RPT-005).

   Timestamps are ISO-8601 UTC on the wire, matching every other module, even
   though the tables store epoch milliseconds.
   ========================================================================= */

/* — States ————————————————————————————————————————————————————— */

/** A return is its own order, so `returned` describes the sale it points at. */
export const PosOrderState = z.enum(['paid', 'voided', 'returned', 'partially_returned']);
export type PosOrderState = z.infer<typeof PosOrderState>;

export const PosOrderKind = z.enum(['sale', 'return']);
export type PosOrderKind = z.infer<typeof PosOrderKind>;

/** Till tenders. Narrower than the billing `PaymentMethod` on purpose: a shop
 *  counter cannot take a bank transfer or a chargeback. `account` is the one
 *  that does not settle at the till — it raises a receivable. */
export const PosTenderMethod = z.enum(['cash', 'card', 'upi', 'account']);
export type PosTenderMethod = z.infer<typeof PosTenderMethod>;

/** Every reason a unit may move. The ledger is append-only, so this list is
 *  also the complete vocabulary of the stock history (PF-POS-003). */
export const StockReason = z.enum([
  'purchase',
  'sale',
  'return',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'damage',
]);
export type StockReason = z.infer<typeof StockReason>;

/** The subset a human may write by hand. Sale, return and transfer movements
 *  are only ever produced by their own workflow. */
export const StockAdjustReason = z.enum(['purchase', 'adjustment', 'damage']);
export type StockAdjustReason = z.infer<typeof StockAdjustReason>;

export const StockTransferState = z.enum(['draft', 'dispatched', 'received', 'cancelled']);
export type StockTransferState = z.infer<typeof StockTransferState>;

/* — Financial visibility ——————————————————————————————————————— */

/**
 * Which restricted figures the caller was allowed to see.
 *
 * Cost, margin and stock valuation are the gym's commercial position, not the
 * shop's operating data. `inventory.view` runs the shop; `report.financial`
 * sees what it earns (Product PRD §4.20 lists product margin as a financial
 * report, and reception explicitly has no access to sensitive reports).
 *
 * The split is three ways and every serialiser in the module obeys it:
 *
 * | Figure | Permission |
 * |---|---|
 * | stock on hand, price, reorder point, units, takings, low stock | `inventory.view` |
 * | unit cost — on a product, a ledger row, a sold line, a transfer line | `inventory.manage` |
 * | margin, stock valuation, shrinkage **value** | `report.financial` |
 *
 * `restricted` is the machine-readable form of that table for this response,
 * and it is the contract: a field named there is `null` in the body, and a
 * field not named there carries a real number. The two disagreeing is a bug,
 * because the console renders the permission state from `restricted` while
 * reading the value from the field.
 */
export const StoreFinancialAccess = z.object({
  /** True when the caller holds `report.financial`. */
  canSeeMargin: z.boolean(),
  /** True when the caller holds `inventory.manage` — cost is an operational
   *  input they type in when receiving stock, not a report. */
  canSeeCost: z.boolean(),
  /** Field names withheld from this response, for the permission state. */
  restricted: z.array(z.string()),
});
export type StoreFinancialAccess = z.infer<typeof StoreFinancialAccess>;

/* — Catalogue (PF-POS-001) —————————————————————————————————————— */

export const Supplier = z.object({
  id: Id,
  name: z.string(),
  contactName: z.string(),
  email: z.string(),
  phone: z.string(),
  leadTimeDays: z.number().int(),
  active: z.boolean(),
  createdAt: IsoDateTime,
});
export type Supplier = z.infer<typeof Supplier>;

/** The parent that turns "Shark Tee" into S/M/L. The stock-keeping unit stays
 *  the product — the ledger points at it, not at the group. */
export const ProductGroup = z.object({
  id: Id,
  name: z.string(),
  category: z.string(),
  supplierId: Id.nullable(),
  active: z.boolean(),
  createdAt: IsoDateTime,
});
export type ProductGroup = z.infer<typeof ProductGroup>;

export const StoreProduct = z.object({
  id: Id,
  name: z.string(),
  /** `name` plus the variant, ready to print on a receipt line. */
  displayName: z.string(),
  sku: z.string(),
  barcode: z.string().nullable(),
  category: z.string(),
  variantName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  supplierId: Id.nullable(),
  supplierName: z.string().nullable(),
  priceMinor: Money,
  taxRateBp: z.number().int(),
  reorderAt: z.number().int(),
  active: z.boolean(),
  /** Summed from the ledger for the requested branch scope. Never stored. */
  onHand: z.number().int(),
  lowStock: z.boolean(),
  /** Null without `inventory.manage`. */
  costMinor: Money.nullable(),
  /** Weighted-average cost × on-hand. Null without `report.financial`. */
  valuationMinor: Money.nullable(),
  createdAt: IsoDateTime,
});
export type StoreProduct = z.infer<typeof StoreProduct>;

export const StoreProductList = z.object({
  items: z.array(StoreProduct),
  financial: StoreFinancialAccess,
});
export type StoreProductList = z.infer<typeof StoreProductList>;

/* — Ledger (PF-POS-003) ————————————————————————————————————————— */

export const StockMovement = z.object({
  id: Id,
  productId: Id,
  branchId: Id,
  branchName: z.string(),
  /** Signed. Negative leaves the shelf. */
  delta: z.number().int(),
  reason: StockReason,
  /** What produced this row — `pos_order`, `stock_transfer`, `manual`, … */
  refType: z.string().nullable(),
  refId: Id.nullable(),
  actorName: z.string(),
  note: z.string().nullable(),
  /** Only ever set on inbound movements. Null without `inventory.manage`. */
  unitCostMinor: Money.nullable(),
  /** True when tenant policy let this row drive on-hand below zero. */
  negativeOverride: z.boolean(),
  overrideReason: z.string().nullable(),
  at: IsoDateTime,
});
export type StockMovement = z.infer<typeof StockMovement>;

export const StockLedgerPage = z.object({
  items: z.array(StockMovement),
  financial: StoreFinancialAccess,
});
export type StockLedgerPage = z.infer<typeof StockLedgerPage>;

export const StockAdjustResult = z.object({
  productId: Id,
  branchId: Id,
  onHand: z.number().int(),
  lowStock: z.boolean(),
});
export type StockAdjustResult = z.infer<typeof StockAdjustResult>;

/* — Orders (PF-POS-002) ————————————————————————————————————————— */

export const PosOrderLine = z.object({
  id: Id,
  productId: Id,
  name: z.string(),
  /** Negative on a return order. */
  quantity: z.number().int(),
  unitMinor: Money,
  discountMinor: Money,
  taxRateBp: z.number().int(),
  taxMinor: Money,
  totalMinor: Money,
  /** How many of this line have already gone back. */
  quantityReturned: z.number().int(),
  /** Still returnable. Zero on a return order's own lines. */
  quantityReturnable: z.number().int(),
  /** Cost captured at the moment of sale, so a later price edit cannot
   *  rewrite last month's margin. Null without `inventory.manage` — it is the
   *  same operational figure as `StoreProduct.costMinor`, frozen. The margin
   *  *derived* from it is the part that needs `report.financial`. */
  unitCostMinor: Money.nullable(),
});
export type PosOrderLine = z.infer<typeof PosOrderLine>;

export const PosTender = z.object({
  id: Id,
  method: PosTenderMethod,
  amountMinor: Money,
  /** Card auth code, UPI reference, or empty for cash. */
  reference: z.string(),
  at: IsoDateTime,
});
export type PosTender = z.infer<typeof PosTender>;

/** The row shape for sales history — no lines, no tenders. */
export const PosOrderSummary = z.object({
  id: Id,
  reference: z.string(),
  branchId: Id,
  branchName: z.string(),
  memberId: Id.nullable(),
  memberName: z.string().nullable(),
  kind: PosOrderKind,
  state: PosOrderState,
  subtotalMinor: Money,
  discountMinor: Money,
  taxMinor: Money,
  totalMinor: Money,
  staffId: Id.nullable(),
  staffName: z.string(),
  /** Set only when an `account` tender raised a receivable. */
  invoiceId: Id.nullable(),
  returnOfOrderId: Id.nullable(),
  voidReason: z.string().nullable(),
  voidedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type PosOrderSummary = z.infer<typeof PosOrderSummary>;

export const PosOrderDetail = z.object({
  order: PosOrderSummary,
  lines: z.array(PosOrderLine),
  tenders: z.array(PosTender),
  /** Populated when this order is itself a return. */
  returnedFrom: PosOrderSummary.nullable(),
  financial: StoreFinancialAccess,
});
export type PosOrderDetail = z.infer<typeof PosOrderDetail>;

export const PosOrderList = z.object({
  items: z.array(PosOrderSummary),
});
export type PosOrderList = z.infer<typeof PosOrderList>;

/* — Transfers (PF-POS-005) —————————————————————————————————————— */

export const StockTransferLine = z.object({
  id: Id,
  productId: Id,
  productName: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  quantityReceived: z.number().int(),
  /** Dispatched minus received. Written off as damage at the destination. */
  shortfall: z.number().int(),
  /** Null without `inventory.manage`, like every other unit cost. */
  unitCostMinor: Money.nullable(),
});
export type StockTransferLine = z.infer<typeof StockTransferLine>;

export const StockTransfer = z.object({
  id: Id,
  reference: z.string(),
  fromBranchId: Id,
  fromBranchName: z.string(),
  toBranchId: Id,
  toBranchName: z.string(),
  state: StockTransferState,
  note: z.string().nullable(),
  createdBy: z.string(),
  dispatchedAt: IsoDateTime.nullable(),
  dispatchedBy: z.string().nullable(),
  receivedAt: IsoDateTime.nullable(),
  receivedBy: z.string().nullable(),
  cancelledAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  /** Units still on the van — dispatched and not yet received. */
  unitsInTransit: z.number().int(),
});
export type StockTransfer = z.infer<typeof StockTransfer>;

export const StockTransferDetail = z.object({
  transfer: StockTransfer,
  lines: z.array(StockTransferLine),
  financial: StoreFinancialAccess,
});
export type StockTransferDetail = z.infer<typeof StockTransferDetail>;

export const StockTransferList = z.object({
  items: z.array(StockTransfer),
});
export type StockTransferList = z.infer<typeof StockTransferList>;

/* — Reports (PF-POS-006) ———————————————————————————————————————— */

export const StoreLowStockRow = z.object({
  id: Id,
  name: z.string(),
  sku: z.string(),
  onHand: z.number().int(),
  reorderAt: z.number().int(),
});
export type StoreLowStockRow = z.infer<typeof StoreLowStockRow>;

export const StoreTopProduct = z.object({
  productId: Id,
  name: z.string(),
  units: z.number().int(),
  revenueMinor: Money,
  /** Null without `report.financial`. */
  marginMinor: Money.nullable(),
});
export type StoreTopProduct = z.infer<typeof StoreTopProduct>;

export const StoreReport = z.object({
  scope: z.object({
    branchId: Id.nullable(),
    branches: z.number().int(),
    from: IsoDateTime,
    to: IsoDateTime,
  }),
  /** Takings. Visible to anyone who may run the till — they already see every
   *  order total in the sales history, so withholding the sum is theatre. */
  sales: z.object({
    orders: z.number().int(),
    returns: z.number().int(),
    voided: z.number().int(),
    unitsSold: z.number().int(),
    revenueMinor: Money,
    taxMinor: Money,
  }),
  /** Null in full without `report.financial`. */
  margin: z
    .object({
      revenueMinor: Money,
      costMinor: Money,
      marginMinor: Money,
      /** Basis points — a float percentage has no place in a money report. */
      marginBp: z.number().int(),
    })
    .nullable(),
  /** Null in full without `report.financial`. */
  valuation: z
    .object({
      valuationMinor: Money,
      skus: z.number().int(),
    })
    .nullable(),
  shrinkage: z.object({
    /** Units lost is an operational fact — a manager needs it to act. */
    units: z.number().int(),
    /** What those units cost. Null without `report.financial`. */
    costMinor: Money.nullable(),
  }),
  lowStock: z.array(StoreLowStockRow),
  topProducts: z.array(StoreTopProduct),
  /** Computed live from the ledger on every request. */
  asOf: IsoDateTime,
  financial: StoreFinancialAccess,
});
export type StoreReport = z.infer<typeof StoreReport>;

/* — Requests ——————————————————————————————————————————————————— */

export const PosCheckoutLine = z.object({
  productId: Id,
  quantity: z.number().int().min(1).max(1000),
  discountMinor: Money.min(0).default(0),
});
export type PosCheckoutLine = z.infer<typeof PosCheckoutLine>;

export const PosCheckoutTender = z.object({
  method: PosTenderMethod,
  amountMinor: Money.min(1),
  reference: z.string().max(80).default(''),
});
export type PosCheckoutTender = z.infer<typeof PosCheckoutTender>;

export const PosCheckoutRequest = z.object({
  branchId: Id,
  memberId: Id.nullable().default(null),
  lines: z.array(PosCheckoutLine).min(1).max(100),
  /** Mixed tender must sum to the order total exactly. Rounding here would
   *  quietly create or destroy money in the day's takings. */
  payments: z.array(PosCheckoutTender).min(1).max(5),
  overrideReason: z.string().max(400).nullable().default(null),
});
export type PosCheckoutRequest = z.infer<typeof PosCheckoutRequest>;
