import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

interface Session {
  cookie: string;
  csrfToken: string;
}

const cache = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const get = (session: Session, path: string) => app.request(path, { headers: headers(session) });
const post = (session: Session, path: string, body: unknown, key?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { ...headers(session, true), ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
const patch = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(session, true), body: JSON.stringify(body) });

function tenantId(): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

function onHandOf(productId: string, branchId: string): number {
  const row = db
    .select({ qty: sql<number>`coalesce(sum(${schema.stockLedger.delta}), 0)` })
    .from(schema.stockLedger)
    .where(and(eq(schema.stockLedger.productId, productId), eq(schema.stockLedger.branchId, branchId)))
    .get();
  return row?.qty ?? 0;
}

function setNegativeStockPolicy(enabled: boolean): void {
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId())).get()!;
  db.update(schema.tenants)
    .set({ policy: { ...tenant.policy, allowNegativeStock: enabled } })
    .where(eq(schema.tenants.id, tenant.id))
    .run();
}

/** A product nobody else in the suite touches, stocked to a known quantity. */
function freshProduct(branchId: string, quantity: number, overrides: Record<string, unknown> = {}): string {
  const productId = id('rtl');
  const unique = productId.slice(-8).toUpperCase();
  db.insert(schema.retailProducts)
    .values({
      id: productId,
      tenantId: tenantId(),
      name: `Test Item ${unique}`,
      sku: `TST-${unique}`,
      barcode: `999${unique}`,
      category: 'Accessories',
      groupId: null,
      variantName: '',
      supplierId: null,
      priceMinor: 100_000,
      costMinor: 40_000,
      taxRateBp: 1800,
      reorderAt: 5,
      active: true,
      createdAt: now(),
      ...overrides,
    })
    .run();
  if (quantity > 0) {
    db.insert(schema.stockLedger)
      .values({
        id: id('stk'),
        tenantId: tenantId(),
        branchId,
        productId,
        delta: quantity,
        reason: 'purchase',
        refType: null,
        refId: null,
        actorName: 'seed',
        note: 'test opening',
        unitCostMinor: 40_000,
        negativeOverride: false,
        overrideReason: null,
        at: now(),
      })
      .run();
  }
  return productId;
}

let owner: Session;
let reception: Session;
let manager: Session;

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  reception = await signIn('reception@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
  setNegativeStockPolicy(false);
});

describe('Store catalogue (PF-POS-001)', () => {
  it('lists products with branch stock and a low-stock flag', async () => {
    const response = await get(owner, '/v1/admin/store/products?branchId=br_kor');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ onHand: number; lowStock: boolean; valuationMinor: number }> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Number.isInteger(item.onHand)).toBe(true);
      expect(item.valuationMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuses a duplicate barcode rather than letting a scan be ambiguous', async () => {
    const unique = id('bc').slice(-9);
    const first = await post(owner, '/v1/admin/store/products', {
      name: 'Barcode One',
      sku: `BC1-${unique}`,
      barcode: `777${unique}`,
      category: 'Accessories',
      priceMinor: 10_000,
      costMinor: 4_000,
    });
    expect(first.status).toBe(201);

    const second = await post(owner, '/v1/admin/store/products', {
      name: 'Barcode Two',
      sku: `BC2-${unique}`,
      barcode: `777${unique}`,
      category: 'Accessories',
      priceMinor: 10_000,
      costMinor: 4_000,
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already belongs to/i);
  });

  it('resolves a barcode to exactly one SKU', async () => {
    const unique = id('bc').slice(-9);
    await post(owner, '/v1/admin/store/products', {
      name: 'Scannable',
      sku: `SCN-${unique}`,
      barcode: `778${unique}`,
      category: 'Accessories',
      priceMinor: 10_000,
      costMinor: 4_000,
    });
    const response = await get(owner, `/v1/admin/store/products/barcode/778${unique}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { product: { sku: string } };
    expect(body.product.sku).toBe(`SCN-${unique}`);
  });

  it('groups variants under one product group', async () => {
    const group = await post(owner, '/v1/admin/store/groups', { name: `Group ${id('g').slice(-6)}`, category: 'Apparel' });
    expect(group.status).toBe(201);
    const groupId = ((await group.json()) as { group: { id: string } }).group.id;

    const unique = id('v').slice(-8);
    const variant = await post(owner, '/v1/admin/store/products', {
      name: 'Grouped Tee',
      sku: `GT-${unique}`,
      category: 'Apparel',
      priceMinor: 100_000,
      costMinor: 40_000,
      groupId,
      variantName: 'XL',
    });
    expect(variant.status).toBe(201);
    const created = (await variant.json()) as { product: { groupId: string; variantName: string } };
    expect(created.product.groupId).toBe(groupId);
    expect(created.product.variantName).toBe('XL');
  });

  it('records a supplier against stock it supplies', async () => {
    const supplier = await post(owner, '/v1/admin/store/suppliers', { name: `Supplier ${id('s').slice(-6)}` });
    expect(supplier.status).toBe(201);
    const listed = await get(owner, '/v1/admin/store/suppliers');
    const body = (await listed.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
  });
});

describe('Stock ledger (PF-POS-003)', () => {
  it('derives on-hand from the ledger rather than a stored counter', async () => {
    const productId = freshProduct('br_kor', 20);
    const before = onHandOf(productId, 'br_kor');
    const response = await post(owner, `/v1/admin/store/products/${productId}/stock`, {
      branchId: 'br_kor',
      delta: -3,
      reason: 'damage',
      note: 'Water damage in the store room',
    });
    expect(response.status).toBe(200);
    expect(onHandOf(productId, 'br_kor')).toBe(before - 3);
  });

  it('writes a new row for every movement instead of editing history', async () => {
    const productId = freshProduct('br_kor', 10);
    const rowsBefore = db.select().from(schema.stockLedger).where(eq(schema.stockLedger.productId, productId)).all().length;
    await post(owner, `/v1/admin/store/products/${productId}/stock`, {
      branchId: 'br_kor',
      delta: 5,
      reason: 'purchase',
    });
    const rowsAfter = db.select().from(schema.stockLedger).where(eq(schema.stockLedger.productId, productId)).all();
    expect(rowsAfter.length).toBe(rowsBefore + 1);
    // The opening row is untouched.
    expect(rowsAfter.filter((r) => r.note === 'test opening')).toHaveLength(1);
  });

  it('refuses a stock adjustment from a role holding only inventory.view', async () => {
    const productId = freshProduct('br_kor', 10);
    const response = await post(reception, `/v1/admin/store/products/${productId}/stock`, {
      branchId: 'br_kor',
      delta: -1,
      reason: 'damage',
      note: 'Reception should not be able to do this',
    });
    expect(response.status).toBe(403);
    expect(onHandOf(productId, 'br_kor')).toBe(10);
  });

  it('refuses an adjustment at a branch the caller cannot see', async () => {
    const productId = freshProduct('br_hsr', 10);
    // The branch manager is scoped to Koramangala.
    const response = await post(manager, `/v1/admin/store/products/${productId}/stock`, {
      branchId: 'br_hsr',
      delta: -1,
      reason: 'damage',
      note: 'Out of scope branch',
    });
    expect([403, 404]).toContain(response.status);
    expect(onHandOf(productId, 'br_hsr')).toBe(10);
  });
});

describe('Negative stock policy (PF-POS-004)', () => {
  it('refuses to sell past zero when the tenant has not enabled it', async () => {
    setNegativeStockPolicy(false);
    const productId = freshProduct('br_kor', 2);
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 5 }],
      payments: [{ method: 'cash', amountMinor: 590_000 }],
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/not enabled/i);
    expect(onHandOf(productId, 'br_kor')).toBe(2);
  });

  it('still refuses when the policy is on but no reason is given', async () => {
    setNegativeStockPolicy(true);
    const productId = freshProduct('br_kor', 1);
    const response = await post(owner, `/v1/admin/store/products/${productId}/stock`, {
      branchId: 'br_kor',
      delta: -5,
      reason: 'adjustment',
    });
    expect(response.status).toBe(422);
    expect(onHandOf(productId, 'br_kor')).toBe(1);
    setNegativeStockPolicy(false);
  });

  it('allows the override with a reason and records it on the row', async () => {
    setNegativeStockPolicy(true);
    const productId = freshProduct('br_kor', 1);
    const response = await post(owner, `/v1/admin/store/products/${productId}/stock`, {
      branchId: 'br_kor',
      delta: -4,
      reason: 'adjustment',
      overrideReason: 'Stocktake correction, physical count was wrong',
    });
    expect(response.status).toBe(200);
    expect(onHandOf(productId, 'br_kor')).toBe(-3);

    const row = db
      .select()
      .from(schema.stockLedger)
      .where(and(eq(schema.stockLedger.productId, productId), eq(schema.stockLedger.negativeOverride, true)))
      .get();
    expect(row).toBeDefined();
    expect(row!.overrideReason).toMatch(/stocktake correction/i);
    setNegativeStockPolicy(false);
  });
});

describe('Checkout (PF-POS-002)', () => {
  it('sells, taxes per line, and takes the stock down', async () => {
    const productId = freshProduct('br_kor', 20);
    const before = onHandOf(productId, 'br_kor');
    // 2 × 100000 = 200000, tax 18% = 36000, total 236000.
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 2 }],
      payments: [{ method: 'card', amountMinor: 236_000 }],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      order: { subtotalMinor: number; taxMinor: number; totalMinor: number; state: string };
      lines: Array<{ taxMinor: number; unitCostMinor: number }>;
    };
    expect(body.order.subtotalMinor).toBe(200_000);
    expect(body.order.taxMinor).toBe(36_000);
    expect(body.order.totalMinor).toBe(236_000);
    expect(body.lines[0]!.taxMinor).toBe(36_000);
    // Cost is snapshotted so margin cannot be rewritten later.
    expect(body.lines[0]!.unitCostMinor).toBe(40_000);
    expect(onHandOf(productId, 'br_kor')).toBe(before - 2);
  });

  it('applies a discount before tax', async () => {
    const productId = freshProduct('br_kor', 10);
    // 100000 - 10000 discount = 90000 taxable, tax 16200, total 106200.
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1, discountMinor: 10_000 }],
      payments: [{ method: 'cash', amountMinor: 106_200 }],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { order: { discountMinor: number; taxMinor: number; totalMinor: number } };
    expect(body.order.discountMinor).toBe(10_000);
    expect(body.order.taxMinor).toBe(16_200);
    expect(body.order.totalMinor).toBe(106_200);
  });

  it('settles one sale across mixed tender', async () => {
    const productId = freshProduct('br_kor', 10);
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [
        { method: 'cash', amountMinor: 100_000 },
        { method: 'card', amountMinor: 18_000, reference: 'VISA·1111' },
      ],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { payments: Array<{ method: string; amountMinor: number }> };
    expect(body.payments).toHaveLength(2);
    expect(body.payments.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(118_000);
  });

  it('refuses tender that does not add up to the sale', async () => {
    const productId = freshProduct('br_kor', 10);
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 100_000 }],
    });
    expect(response.status).toBe(422);
    // Nothing was sold, so nothing left the shelf.
    expect(onHandOf(productId, 'br_kor')).toBe(10);
  });

  it('replays an idempotent checkout instead of selling twice', async () => {
    const productId = freshProduct('br_kor', 10);
    const key = `checkout-${id('k')}`;
    const body = {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    };

    const first = await post(owner, '/v1/admin/store/orders', body, key);
    expect(first.status).toBe(201);
    const firstOrder = ((await first.json()) as { order: { id: string } }).order.id;

    const second = await post(owner, '/v1/admin/store/orders', body, key);
    expect(second.status).toBe(201);
    const secondOrder = ((await second.json()) as { order: { id: string } }).order.id;

    expect(secondOrder).toBe(firstOrder);
    // One unit sold, not two.
    expect(onHandOf(productId, 'br_kor')).toBe(9);
  });

  it('refuses to sell a retired product', async () => {
    const productId = freshProduct('br_kor', 10, { active: false });
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    });
    expect(response.status).toBe(412);
    expect(onHandOf(productId, 'br_kor')).toBe(10);
  });

  it('refuses a sale at a branch the caller cannot see', async () => {
    const productId = freshProduct('br_hsr', 10);
    const response = await post(manager, '/v1/admin/store/orders', {
      branchId: 'br_hsr',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    });
    expect([403, 404]).toContain(response.status);
    expect(onHandOf(productId, 'br_hsr')).toBe(10);
  });

  it('refuses a sale from a role without inventory.manage', async () => {
    const productId = freshProduct('br_kor', 10);
    const response = await post(reception, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    });
    expect(response.status).toBe(403);
    expect(onHandOf(productId, 'br_kor')).toBe(10);
  });

  it('sells the last unit once and refuses the second attempt', async () => {
    // The register may have been showing "1 left" for both cashiers. Stock is
    // re-read inside the transaction, so only one sale can win.
    const productId = freshProduct('br_kor', 1);
    const body = {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    };
    const first = await post(owner, '/v1/admin/store/orders', body);
    const second = await post(owner, '/v1/admin/store/orders', body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(412);
    expect(onHandOf(productId, 'br_kor')).toBe(0);
  });

  it('leaves no order, line, payment or stock movement behind when a sale fails', async () => {
    // Payment succeeds but stock fails is the PRD's named edge case. There is
    // no such window: both are the same transaction, so a basket whose second
    // line is short must commit nothing at all.
    const stocked = freshProduct('br_kor', 10);
    const short = freshProduct('br_kor', 1);
    const ordersBefore = db.select().from(schema.posOrders).all().length;
    const paymentsBefore = db.select().from(schema.posPayments).all().length;

    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [
        { productId: stocked, quantity: 1 },
        { productId: short, quantity: 5 },
      ],
      payments: [{ method: 'cash', amountMinor: 708_000 }],
    });

    expect(response.status).toBe(412);
    expect(db.select().from(schema.posOrders).all().length).toBe(ordersBefore);
    expect(db.select().from(schema.posPayments).all().length).toBe(paymentsBefore);
    // Critically, the first line's stock was not taken.
    expect(onHandOf(stocked, 'br_kor')).toBe(10);
    expect(onHandOf(short, 'br_kor')).toBe(1);
  });
});

describe('Returns and voids (PF-POS-002)', () => {
  async function sell(productId: string, quantity: number, branchId = 'br_kor') {
    const total = quantity * 118_000;
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId,
      lines: [{ productId, quantity }],
      payments: [{ method: 'cash', amountMinor: total }],
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { order: { id: string }; lines: Array<{ id: string }> };
  }

  it('returns stock through a new order rather than editing the sale', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await sell(productId, 2);
    expect(onHandOf(productId, 'br_kor')).toBe(8);

    const response = await post(owner, `/v1/admin/store/orders/${sale.order.id}/refund`, {
      reason: 'Wrong size for the customer',
      lines: [{ lineId: sale.lines[0]!.id, quantity: 1 }],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { order: { kind: string; returnOfOrderId: string; totalMinor: number } };
    expect(body.order.kind).toBe('return');
    expect(body.order.returnOfOrderId).toBe(sale.order.id);
    expect(body.order.totalMinor).toBeLessThan(0);
    expect(onHandOf(productId, 'br_kor')).toBe(9);

    const original = db.select().from(schema.posOrders).where(eq(schema.posOrders.id, sale.order.id)).get()!;
    expect(original.state).toBe('partially_returned');
    expect(original.totalMinor).toBe(236_000);
  });

  it('marks a sale fully returned once every unit is back', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await sell(productId, 1);
    await post(owner, `/v1/admin/store/orders/${sale.order.id}/refund`, {
      reason: 'Changed their mind',
      lines: [{ lineId: sale.lines[0]!.id, quantity: 1 }],
    });
    const original = db.select().from(schema.posOrders).where(eq(schema.posOrders.id, sale.order.id)).get()!;
    expect(original.state).toBe('returned');
  });

  it('refuses to return more than was sold', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await sell(productId, 1);
    const response = await post(owner, `/v1/admin/store/orders/${sale.order.id}/refund`, {
      reason: 'Trying to over-return',
      lines: [{ lineId: sale.lines[0]!.id, quantity: 3 }],
    });
    expect(response.status).toBe(412);
  });

  it('accepts a return of a product retired since the sale', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await sell(productId, 1);
    const retire = await patch(owner, `/v1/admin/store/products/${productId}`, { active: false });
    expect(retire.status).toBe(200);

    // The item physically exists; refusing would strand it off the books.
    const response = await post(owner, `/v1/admin/store/orders/${sale.order.id}/refund`, {
      reason: 'Returned after the line was retired',
      lines: [{ lineId: sale.lines[0]!.id, quantity: 1 }],
    });
    expect(response.status).toBe(201);
    expect(onHandOf(productId, 'br_kor')).toBe(10);
  });

  it('puts stock back at the branch that took the return, not the one that sold it', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await sell(productId, 1);
    expect(onHandOf(productId, 'br_kor')).toBe(9);

    const response = await post(owner, `/v1/admin/store/orders/${sale.order.id}/refund`, {
      reason: 'Returned at another branch',
      branchId: 'br_ind',
      lines: [{ lineId: sale.lines[0]!.id, quantity: 1 }],
    });
    expect(response.status).toBe(201);
    expect(onHandOf(productId, 'br_kor')).toBe(9);
    expect(onHandOf(productId, 'br_ind')).toBe(1);
  });

  it('voids a sale, restores the stock and records the reason', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await sell(productId, 2);
    const response = await post(owner, `/v1/admin/store/orders/${sale.order.id}/void`, {
      reason: 'Rung up on the wrong till',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { order: { state: string; voidReason: string } };
    expect(body.order.state).toBe('voided');
    expect(body.order.voidReason).toMatch(/wrong till/i);
    expect(onHandOf(productId, 'br_kor')).toBe(10);
  });

  it('refuses to void the same sale twice', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await sell(productId, 1);
    await post(owner, `/v1/admin/store/orders/${sale.order.id}/void`, { reason: 'First void' });
    const second = await post(owner, `/v1/admin/store/orders/${sale.order.id}/void`, { reason: 'Second void' });
    expect(second.status).toBe(409);
    expect(onHandOf(productId, 'br_kor')).toBe(10);
  });

  it('hides an order at a branch the caller cannot see', async () => {
    const productId = freshProduct('br_hsr', 10);
    const sale = await sell(productId, 1, 'br_hsr');
    const response = await get(manager, `/v1/admin/store/orders/${sale.order.id}`);
    expect(response.status).toBe(404);
  });
});

describe('Inter-branch transfer (PF-POS-005)', () => {
  it('runs the full dispatch and receipt lifecycle', async () => {
    const productId = freshProduct('br_kor', 20);

    const created = await post(owner, '/v1/admin/store/transfers', {
      fromBranchId: 'br_kor',
      toBranchId: 'br_ind',
      lines: [{ productId, quantity: 5 }],
      note: 'Rebalance',
    });
    expect(created.status).toBe(201);
    const transferId = ((await created.json()) as { transfer: { id: string; state: string } }).transfer.id;

    // Draft moves nothing: the goods are still on the shelf.
    expect(onHandOf(productId, 'br_kor')).toBe(20);
    expect(onHandOf(productId, 'br_ind')).toBe(0);

    const dispatched = await post(owner, `/v1/admin/store/transfers/${transferId}/dispatch`, {});
    expect(dispatched.status).toBe(200);
    expect(((await dispatched.json()) as { transfer: { state: string } }).transfer.state).toBe('dispatched');

    // In transit: off the source shelf, not yet on the destination's.
    expect(onHandOf(productId, 'br_kor')).toBe(15);
    expect(onHandOf(productId, 'br_ind')).toBe(0);

    const received = await post(owner, `/v1/admin/store/transfers/${transferId}/receive`, { lines: [] });
    expect(received.status).toBe(200);
    expect(((await received.json()) as { transfer: { state: string } }).transfer.state).toBe('received');
    expect(onHandOf(productId, 'br_kor')).toBe(15);
    expect(onHandOf(productId, 'br_ind')).toBe(5);
  });

  it('books a short receipt as shrinkage rather than losing it quietly', async () => {
    const productId = freshProduct('br_kor', 20);
    const created = await post(owner, '/v1/admin/store/transfers', {
      fromBranchId: 'br_kor',
      toBranchId: 'br_ind',
      lines: [{ productId, quantity: 6 }],
    });
    const body = (await created.json()) as { transfer: { id: string }; lines: Array<{ id: string }> };
    await post(owner, `/v1/admin/store/transfers/${body.transfer.id}/dispatch`, {});

    const received = await post(owner, `/v1/admin/store/transfers/${body.transfer.id}/receive`, {
      lines: [{ lineId: body.lines[0]!.id, quantity: 4 }],
    });
    expect(received.status).toBe(200);

    // Four arrived; the missing two are written off at the destination.
    expect(onHandOf(productId, 'br_ind')).toBe(4);
    const damage = db
      .select()
      .from(schema.stockLedger)
      .where(and(eq(schema.stockLedger.productId, productId), eq(schema.stockLedger.reason, 'damage')))
      .all();
    expect(damage).toHaveLength(1);
    expect(damage[0]!.delta).toBe(-2);
  });

  it('refuses to receive a transfer that was never dispatched', async () => {
    const productId = freshProduct('br_kor', 10);
    const created = await post(owner, '/v1/admin/store/transfers', {
      fromBranchId: 'br_kor',
      toBranchId: 'br_ind',
      lines: [{ productId, quantity: 2 }],
    });
    const transferId = ((await created.json()) as { transfer: { id: string } }).transfer.id;
    const received = await post(owner, `/v1/admin/store/transfers/${transferId}/receive`, { lines: [] });
    expect(received.status).toBe(412);
  });

  it('refuses to dispatch more than the source branch holds', async () => {
    const productId = freshProduct('br_kor', 3);
    const created = await post(owner, '/v1/admin/store/transfers', {
      fromBranchId: 'br_kor',
      toBranchId: 'br_ind',
      lines: [{ productId, quantity: 10 }],
    });
    const transferId = ((await created.json()) as { transfer: { id: string } }).transfer.id;
    const dispatched = await post(owner, `/v1/admin/store/transfers/${transferId}/dispatch`, {});
    expect(dispatched.status).toBe(412);
    expect(onHandOf(productId, 'br_kor')).toBe(3);
  });

  it('will not cancel stock that has already left the building', async () => {
    const productId = freshProduct('br_kor', 10);
    const created = await post(owner, '/v1/admin/store/transfers', {
      fromBranchId: 'br_kor',
      toBranchId: 'br_ind',
      lines: [{ productId, quantity: 2 }],
    });
    const transferId = ((await created.json()) as { transfer: { id: string } }).transfer.id;
    await post(owner, `/v1/admin/store/transfers/${transferId}/dispatch`, {});
    const cancelled = await post(owner, `/v1/admin/store/transfers/${transferId}/cancel`, {
      reason: 'Changed our minds',
    });
    expect(cancelled.status).toBe(412);
  });

  it('shows a stocktake that dispatched stock is in transit, not on the shelf', async () => {
    // The PRD's "stocktake conflicts with pending transfer" case: a counter at
    // the source must not still see the dispatched units.
    const productId = freshProduct('br_kor', 12);
    const created = await post(owner, '/v1/admin/store/transfers', {
      fromBranchId: 'br_kor',
      toBranchId: 'br_ind',
      lines: [{ productId, quantity: 4 }],
    });
    const transferId = ((await created.json()) as { transfer: { id: string } }).transfer.id;
    await post(owner, `/v1/admin/store/transfers/${transferId}/dispatch`, {});

    const listed = await get(owner, '/v1/admin/store/products?branchId=br_kor');
    const items = ((await listed.json()) as { items: Array<{ id: string; onHand: number }> }).items;
    expect(items.find((i) => i.id === productId)!.onHand).toBe(8);

    const open = await get(owner, '/v1/admin/store/transfers?state=dispatched');
    const transfers = ((await open.json()) as { items: Array<{ id: string }> }).items;
    expect(transfers.some((t) => t.id === transferId)).toBe(true);
  });

  it('refuses a transfer between the same branch twice over', async () => {
    const productId = freshProduct('br_kor', 10);
    const response = await post(owner, '/v1/admin/store/transfers', {
      fromBranchId: 'br_kor',
      toBranchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
    });
    expect(response.status).toBe(422);
  });
});

describe('Reports (PF-POS-006)', () => {
  it('reports margin from the cost captured at sale, not the cost today', async () => {
    const productId = freshProduct('br_kor', 20);
    await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 2 }],
      payments: [{ method: 'cash', amountMinor: 236_000 }],
    });

    const before = (await (await get(owner, '/v1/admin/store/reports?branchId=br_kor')).json()) as {
      margin: { marginMinor: number };
    };

    // Restating the supplier price must not rewrite history.
    await patch(owner, `/v1/admin/store/products/${productId}`, { costMinor: 90_000 });

    const after = (await (await get(owner, '/v1/admin/store/reports?branchId=br_kor')).json()) as {
      margin: { marginMinor: number };
    };
    expect(after.margin.marginMinor).toBe(before.margin.marginMinor);
  });

  it('values stock, counts shrinkage and lists what needs reordering', async () => {
    const response = await get(owner, '/v1/admin/store/reports?branchId=br_kor');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sales: { orders: number; unitsSold: number; revenueMinor: number };
      margin: { revenueMinor: number; costMinor: number; marginMinor: number; marginBp: number };
      valuation: { valuationMinor: number };
      shrinkage: { units: number; costMinor: number };
      lowStock: Array<{ onHand: number; reorderAt: number }>;
      topProducts: Array<{ revenueMinor: number }>;
    };
    expect(body.valuation.valuationMinor).toBeGreaterThan(0);
    expect(body.margin.marginMinor).toBe(body.margin.revenueMinor - body.margin.costMinor);
    expect(body.shrinkage.units).toBeGreaterThanOrEqual(0);
    for (const row of body.lowStock) expect(row.onHand).toBeLessThanOrEqual(row.reorderAt);
    expect(body.topProducts.length).toBeGreaterThan(0);
  });

  it('nets a return out of the day rather than double-counting it', async () => {
    const productId = freshProduct('br_ind', 20);
    const sale = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_ind',
      lines: [{ productId, quantity: 2 }],
      payments: [{ method: 'cash', amountMinor: 236_000 }],
    });
    const sold = (await sale.json()) as { order: { id: string }; lines: Array<{ id: string }> };

    const before = (await (await get(owner, '/v1/admin/store/reports?branchId=br_ind')).json()) as {
      margin: { revenueMinor: number };
    };

    await post(owner, `/v1/admin/store/orders/${sold.order.id}/refund`, {
      reason: 'Returned the next morning',
      lines: [{ lineId: sold.lines[0]!.id, quantity: 1 }],
    });

    const after = (await (await get(owner, '/v1/admin/store/reports?branchId=br_ind')).json()) as {
      margin: { revenueMinor: number };
    };
    expect(after.margin.revenueMinor).toBe(before.margin.revenueMinor - 100_000);
  });

  it('excludes a voided sale from the takings', async () => {
    const productId = freshProduct('br_ind', 20);
    const before = (await (await get(owner, '/v1/admin/store/reports?branchId=br_ind')).json()) as {
      margin: { revenueMinor: number };
    };
    const sale = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_ind',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    });
    const orderId = ((await sale.json()) as { order: { id: string } }).order.id;
    await post(owner, `/v1/admin/store/orders/${orderId}/void`, { reason: 'Cashier error' });

    const after = (await (await get(owner, '/v1/admin/store/reports?branchId=br_ind')).json()) as {
      margin: { revenueMinor: number };
    };
    expect(after.margin.revenueMinor).toBe(before.margin.revenueMinor);
  });

  it('keeps a report scoped to the branches the caller may see', async () => {
    const response = await get(manager, '/v1/admin/store/reports');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scope: { branches: number } };
    // The branch manager sees fewer branches than an owner does.
    const ownerScope = (await (await get(owner, '/v1/admin/store/reports')).json()) as {
      scope: { branches: number };
    };
    expect(body.scope.branches).toBeLessThan(ownerScope.scope.branches);
  });
});
