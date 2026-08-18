import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission } from '../../lib/context.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  adjustStock,
  cancelTransfer,
  checkout,
  createGroup,
  createProduct,
  createSupplier,
  createTransfer,
  dispatchTransfer,
  findByBarcode,
  getOrder,
  getTransfer,
  ledgerFor,
  listOrders,
  listProducts,
  listSuppliers,
  listTransfers,
  receiveTransfer,
  reports,
  returnOrder,
  updateProduct,
  voidOrder,
} from '../../services/store.js';

/**
 * Point of sale and inventory (PF-POS). A thin adapter: validate, call
 * `services/store.ts`, serialise. No rule lives in this file.
 */
export const storeRoutes = new Hono();

const Money = z.coerce.number().int().min(0).max(100_000_000);
const PaymentMethod = z.enum(['cash', 'card', 'upi', 'account']);
const StockReason = z.enum(['purchase', 'adjustment', 'damage']);

const ProductQuery = z.object({
  branchId: z.string().min(1).optional(),
  category: z.string().trim().max(80).optional(),
  active: z.enum(['true', 'false']).optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(120).optional(),
});

const ProductBody = z.object({
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().min(1).max(60),
  barcode: z.string().trim().min(4).max(60).nullable().default(null),
  category: z.string().trim().min(1).max(80),
  priceMinor: Money,
  costMinor: Money,
  taxRateBp: z.coerce.number().int().min(0).max(5000).default(1800),
  reorderAt: z.coerce.number().int().min(0).max(10_000).default(5),
  groupId: z.string().min(1).nullable().default(null),
  variantName: z.string().trim().max(80).nullable().default(null),
  supplierId: z.string().min(1).nullable().default(null),
});

const ProductPatch = ProductBody.partial().extend({ active: z.boolean().optional() });

const AdjustBody = z.object({
  branchId: z.string().min(1),
  delta: z.coerce.number().int().refine((v) => v !== 0, 'A stock movement cannot be zero.'),
  reason: StockReason,
  note: z.string().trim().max(400).nullable().default(null),
  unitCostMinor: Money.nullable().default(null),
  overrideReason: z.string().trim().max(400).nullable().default(null),
});

const CheckoutBody = z.object({
  branchId: z.string().min(1),
  memberId: z.string().min(1).nullable().default(null),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.coerce.number().int().min(1).max(1000),
        discountMinor: Money.default(0),
      }),
    )
    .min(1)
    .max(100),
  payments: z
    .array(
      z.object({
        method: PaymentMethod,
        amountMinor: z.coerce.number().int().min(1).max(100_000_000),
        reference: z.string().trim().max(80).default(''),
      }),
    )
    .min(1)
    .max(5),
  overrideReason: z.string().trim().max(400).nullable().default(null),
});

const ReturnBody = z.object({
  reason: z.string().trim().min(4).max(400),
  branchId: z.string().min(1).optional(),
  lines: z
    .array(z.object({ lineId: z.string().min(1), quantity: z.coerce.number().int().min(1).max(1000) }))
    .min(1)
    .max(100),
});

const VoidBody = z.object({ reason: z.string().trim().min(4).max(400) });

const TransferBody = z.object({
  fromBranchId: z.string().min(1),
  toBranchId: z.string().min(1),
  note: z.string().trim().max(400).nullable().default(null),
  lines: z
    .array(z.object({ productId: z.string().min(1), quantity: z.coerce.number().int().min(1).max(10_000) }))
    .min(1)
    .max(100),
});

const ReceiveBody = z.object({
  lines: z
    .array(z.object({ lineId: z.string().min(1), quantity: z.coerce.number().int().min(0).max(10_000) }))
    .max(100)
    .default([]),
});

const OrderQuery = z.object({
  branchId: z.string().min(1).optional(),
  staffId: z.string().min(1).optional(),
  method: PaymentMethod.optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ReportQuery = z.object({
  branchId: z.string().min(1).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

const flag = (v: 'true' | 'false' | undefined): boolean | null => (v === undefined ? null : v === 'true');

/* ------------------------------------------------------------------ reads */

storeRoutes.get('/products', validate('query', ProductQuery), (c) => {
  const q = c.req.valid('query');
  return c.json({
    items: listProducts(ctxOf(c), {
      branchId: q.branchId ?? null,
      category: q.category ?? null,
      active: flag(q.active),
      lowStock: q.lowStock === 'true',
      search: q.q ?? null,
    }),
  });
});

storeRoutes.get('/products/barcode/:barcode', (c) => {
  return c.json({ product: findByBarcode(ctxOf(c), c.req.param('barcode')) });
});

storeRoutes.get('/products/:productId/ledger', (c) => {
  const branchId = c.req.query('branchId') ?? null;
  return c.json({ items: ledgerFor(ctxOf(c), c.req.param('productId'), branchId) });
});

storeRoutes.get('/suppliers', (c) => c.json({ items: listSuppliers(ctxOf(c)) }));

storeRoutes.get('/orders', validate('query', OrderQuery), (c) => {
  const q = c.req.valid('query');
  return c.json({
    items: listOrders(ctxOf(c), {
      branchId: q.branchId ?? null,
      staffId: q.staffId ?? null,
      method: q.method ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      limit: q.limit,
    }),
  });
});

storeRoutes.get('/orders/:orderId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'inventory.view');
  return c.json(getOrder(ctx, c.req.param('orderId')));
});

storeRoutes.get('/transfers', (c) => {
  return c.json({ items: listTransfers(ctxOf(c), c.req.query('state') ?? null) });
});

storeRoutes.get('/transfers/:transferId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'inventory.view');
  return c.json(getTransfer(ctx, c.req.param('transferId')));
});

storeRoutes.get('/reports', validate('query', ReportQuery), (c) => {
  const q = c.req.valid('query');
  return c.json(reports(ctxOf(c), { branchId: q.branchId ?? null, from: q.from ?? null, to: q.to ?? null }));
});

/* ----------------------------------------------------------------- writes */

storeRoutes.post('/products', validate('json', ProductBody), (c) => {
  return c.json({ product: createProduct(ctxOf(c), c.req.valid('json')) }, 201);
});

storeRoutes.patch('/products/:productId', validate('json', ProductPatch), (c) => {
  return c.json({ product: updateProduct(ctxOf(c), c.req.param('productId'), c.req.valid('json')) });
});

storeRoutes.post('/products/:productId/stock', validate('json', AdjustBody), (c) => {
  return c.json(adjustStock(ctxOf(c), c.req.param('productId'), c.req.valid('json')));
});

storeRoutes.post('/suppliers', validate('json', z.object({
  name: z.string().trim().min(1).max(120),
  contactName: z.string().trim().max(120).default(''),
  email: z.string().trim().max(160).default(''),
  phone: z.string().trim().max(40).default(''),
  leadTimeDays: z.coerce.number().int().min(0).max(365).default(7),
})), (c) => {
  return c.json({ supplier: createSupplier(ctxOf(c), c.req.valid('json')) }, 201);
});

storeRoutes.post('/groups', validate('json', z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(80),
  supplierId: z.string().min(1).nullable().default(null),
})), (c) => {
  return c.json({ group: createGroup(ctxOf(c), c.req.valid('json')) }, 201);
});

// A till is retried on a flaky connection; the same key must not sell twice.
storeRoutes.post('/orders', validate('json', CheckoutBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const result = runIdempotently(ctx, 'store.checkout', c.req.header('idempotency-key'), body, () =>
    checkout(ctx, body),
  );
  return c.json(result, 201);
});

storeRoutes.post('/orders/:orderId/refund', validate('json', ReturnBody), (c) => {
  const ctx = ctxOf(c);
  const orderId = c.req.param('orderId');
  const body = c.req.valid('json');
  const result = runIdempotently(ctx, 'store.return', c.req.header('idempotency-key'), { orderId, ...body }, () =>
    returnOrder(ctx, orderId, body.lines, body.reason, body.branchId),
  );
  return c.json(result, 201);
});

storeRoutes.post('/orders/:orderId/void', validate('json', VoidBody), (c) => {
  return c.json(voidOrder(ctxOf(c), c.req.param('orderId'), c.req.valid('json').reason));
});

storeRoutes.post('/transfers', validate('json', TransferBody), (c) => {
  return c.json(createTransfer(ctxOf(c), c.req.valid('json')), 201);
});

storeRoutes.post('/transfers/:transferId/dispatch', validate('json', z.object({
  overrideReason: z.string().trim().max(400).nullable().default(null),
})), (c) => {
  return c.json(dispatchTransfer(ctxOf(c), c.req.param('transferId'), c.req.valid('json').overrideReason));
});

storeRoutes.post('/transfers/:transferId/receive', validate('json', ReceiveBody), (c) => {
  return c.json(receiveTransfer(ctxOf(c), c.req.param('transferId'), c.req.valid('json').lines));
});

storeRoutes.post('/transfers/:transferId/cancel', validate('json', VoidBody), (c) => {
  return c.json(cancelTransfer(ctxOf(c), c.req.param('transferId'), c.req.valid('json').reason));
});
