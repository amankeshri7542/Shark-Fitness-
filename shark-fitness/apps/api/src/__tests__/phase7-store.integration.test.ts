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
    const body = (await response.json()) as { tenders: Array<{ method: string; amountMinor: number }> };
    expect(body.tenders).toHaveLength(2);
    expect(body.tenders.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(118_000);
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

/* ==========================================================================
   Financial visibility (PF-RPT-005, Product PRD §4.20)

   Running the shop and knowing what the shop earns are different jobs. These
   assert the line rather than the implementation, so the four roles are read
   as a matrix: who may see unit cost, and who may see margin.
   ========================================================================= */

describe('Financial visibility', () => {
  let accountant: Session;

  beforeAll(async () => {
    accountant = await signIn('accounts@sharkfitness.in');
  });

  it('shows an owner both cost and margin', async () => {
    const response = await get(owner, '/v1/admin/store/reports?branchId=br_kor');
    const body = (await response.json()) as {
      margin: { marginMinor: number } | null;
      valuation: { valuationMinor: number } | null;
      shrinkage: { units: number; costMinor: number | null };
      financial: { canSeeMargin: boolean; canSeeCost: boolean };
    };
    expect(body.financial).toEqual({ canSeeMargin: true, canSeeCost: true, restricted: [] });
    expect(body.margin).not.toBeNull();
    expect(body.valuation).not.toBeNull();
    expect(body.shrinkage.costMinor).not.toBeNull();
  });

  it('withholds margin and valuation from reception rather than zeroing them', async () => {
    const response = await get(reception, '/v1/admin/store/reports?branchId=br_kor');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sales: { revenueMinor: number };
      margin: unknown;
      valuation: unknown;
      shrinkage: { units: number; costMinor: number | null };
      financial: { canSeeMargin: boolean; canSeeCost: boolean; restricted: string[] };
    };
    // Null, not 0. A margin of zero is a real and alarming figure in a shop;
    // it must never stand in for "your role may not see this".
    expect(body.margin).toBeNull();
    expect(body.valuation).toBeNull();
    expect(body.shrinkage.costMinor).toBeNull();
    expect(body.financial.canSeeMargin).toBe(false);
    expect(body.financial.restricted).toContain('marginMinor');
    // Takings stay visible — reception sees every order total in the history
    // anyway, so withholding the sum would be theatre rather than security.
    expect(Number.isInteger(body.sales.revenueMinor)).toBe(true);
    expect(Number.isInteger(body.shrinkage.units)).toBe(true);
  });

  it('withholds unit cost from a reception product list', async () => {
    const response = await get(reception, '/v1/admin/store/products?branchId=br_kor');
    const body = (await response.json()) as {
      items: Array<{ costMinor: number | null; valuationMinor: number | null; priceMinor: number; onHand: number }>;
      financial: { canSeeCost: boolean };
    };
    expect(body.financial.canSeeCost).toBe(false);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.costMinor).toBeNull();
      expect(item.valuationMinor).toBeNull();
      // What it sells for and how many are on the shelf are the shop's job.
      expect(Number.isInteger(item.priceMinor)).toBe(true);
      expect(Number.isInteger(item.onHand)).toBe(true);
    }
  });

  it('gives a branch manager cost but not margin', async () => {
    // Cost is an operational input — whoever books in a delivery types it —
    // so `inventory.manage` reads it. Margin is a commercial figure and needs
    // `report.financial`, which a branch manager does not hold.
    const products = (await (await get(manager, '/v1/admin/store/products?branchId=br_kor')).json()) as {
      items: Array<{ costMinor: number | null; valuationMinor: number | null }>;
      financial: { canSeeCost: boolean; canSeeMargin: boolean };
    };
    expect(products.financial).toMatchObject({ canSeeCost: true, canSeeMargin: false });
    expect(products.items[0]!.costMinor).not.toBeNull();
    expect(products.items[0]!.valuationMinor).toBeNull();

    const report = (await (await get(manager, '/v1/admin/store/reports?branchId=br_kor')).json()) as {
      margin: unknown;
    };
    expect(report.margin).toBeNull();
  });

  it('gives an accountant margin without making them a stock manager', async () => {
    const report = (await (await get(accountant, '/v1/admin/store/reports')).json()) as {
      margin: { marginBp: number } | null;
      financial: { canSeeMargin: boolean; canSeeCost: boolean };
    };
    expect(report.financial).toMatchObject({ canSeeMargin: true, canSeeCost: false });
    expect(report.margin).not.toBeNull();
  });

  it('withholds the cost captured on a sold line from reception', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    });
    const orderId = ((await sale.json()) as { order: { id: string } }).order.id;

    const asOwner = (await (await get(owner, `/v1/admin/store/orders/${orderId}`)).json()) as {
      lines: Array<{ unitCostMinor: number | null }>;
    };
    expect(asOwner.lines[0]!.unitCostMinor).toBe(40_000);

    const asReception = (await (await get(reception, `/v1/admin/store/orders/${orderId}`)).json()) as {
      lines: Array<{ unitCostMinor: number | null }>;
    };
    expect(asReception.lines[0]!.unitCostMinor).toBeNull();
  });

  it('withholds inbound cost on the movement ledger from reception', async () => {
    const productId = freshProduct('br_kor', 6);
    const asOwner = (await (await get(owner, `/v1/admin/store/products/${productId}/ledger`)).json()) as {
      items: Array<{ unitCostMinor: number | null }>;
    };
    expect(asOwner.items[0]!.unitCostMinor).toBe(40_000);

    const asReception = (await (await get(reception, `/v1/admin/store/products/${productId}/ledger`)).json()) as {
      items: Array<{ unitCostMinor: number | null }>;
      financial: { canSeeCost: boolean };
    };
    expect(asReception.financial.canSeeCost).toBe(false);
    expect(asReception.items[0]!.unitCostMinor).toBeNull();
  });
});

/* ==========================================================================
   Wire shapes and realtime topics
   ========================================================================= */

/**
 * Events of one topic since a moment, optionally narrowed to one product.
 *
 * The timestamp alone is not selective enough: `now()` is millisecond
 * precision and the suite emits fast, so a neighbouring test's event can land
 * in the same millisecond as this one's cutoff.
 */
function eventsFor(
  topic: string,
  since: number,
  productId?: string,
): Array<{ channel: string; payload: Record<string, unknown> }> {
  return db
    .select({ channel: schema.outboxEvents.channel, payload: schema.outboxEvents.payload })
    .from(schema.outboxEvents)
    .where(and(eq(schema.outboxEvents.topic, topic), sql`${schema.outboxEvents.at} >= ${since}`))
    .all()
    .map((r) => ({ channel: r.channel, payload: r.payload as Record<string, unknown> }))
    .filter((e) => productId === undefined || e.payload.productId === productId);
}

describe('Store contracts and realtime topics', () => {
  it('serves timestamps as ISO-8601 and names branches rather than leaking ids alone', async () => {
    const body = (await (await get(owner, '/v1/admin/store/orders?branchId=br_kor')).json()) as {
      items: Array<{ createdAt: string; branchName: string; branchId: string }>;
    };
    const row = body.items[0]!;
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(row.branchName.length).toBeGreaterThan(0);
    expect(row.branchName).not.toBe(row.branchId);
  });

  it('publishes a sale as pos.sale_completed, never as a billing payment', async () => {
    const at = now();
    const productId = freshProduct('br_kor', 5);
    await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    });

    const sales = eventsFor('pos.sale_completed', at);
    expect(sales).toHaveLength(1);
    expect(sales[0]!.channel).toBe('branch:br_kor');
    // Reusing payment.succeeded would tell dunning and reconciliation that an
    // invoice moved, which a cash counter sale did not do.
    expect(eventsFor('payment.succeeded', at)).toHaveLength(0);
    expect(eventsFor('stock.changed', at).length).toBeGreaterThan(0);
  });

  it('raises stock.low only once the shelf actually crosses its reorder point', async () => {
    const productId = freshProduct('br_kor', 40, { reorderAt: 3 });
    const before = now();
    await post(owner, `/v1/admin/store/products/${productId}/stock`, {
      branchId: 'br_kor',
      delta: -30,
      reason: 'adjustment',
      note: 'stocktake correction',
    });
    expect(eventsFor('stock.low', before, productId)).toHaveLength(0);

    const at = now();
    await post(owner, `/v1/admin/store/products/${productId}/stock`, {
      branchId: 'br_kor',
      delta: -8,
      reason: 'damage',
      note: 'water damage',
    });
    const low = eventsFor('stock.low', at, productId);
    expect(low).toHaveLength(1);
    expect(low[0]!.payload.onHand).toBe(2);
  });

  it('tells both branches about a transfer, because it is never one shelf', async () => {
    const productId = freshProduct('br_kor', 10);
    const at = now();
    await post(owner, '/v1/admin/store/transfers', {
      fromBranchId: 'br_kor',
      toBranchId: 'br_hsr',
      lines: [{ productId, quantity: 2 }],
    });
    const channelsSeen = eventsFor('transfer.updated', at).map((e) => e.channel).sort();
    expect(channelsSeen).toEqual(['branch:br_hsr', 'branch:br_kor']);
  });

  it('publishes a return and a void under their own topics', async () => {
    const productId = freshProduct('br_kor', 10);
    const sale = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 2 }],
      payments: [{ method: 'cash', amountMinor: 236_000 }],
    });
    const body = (await sale.json()) as { order: { id: string }; lines: Array<{ id: string }> };

    const atReturn = now();
    await post(owner, `/v1/admin/store/orders/${body.order.id}/refund`, {
      reason: 'Wrong size',
      lines: [{ lineId: body.lines[0]!.id, quantity: 1 }],
    });
    expect(eventsFor('pos.return_completed', atReturn)).toHaveLength(1);

    const atVoid = now();
    await post(owner, `/v1/admin/store/orders/${body.order.id}/void`, { reason: 'Till error' });
    expect(eventsFor('pos.order_voided', atVoid)).toHaveLength(1);
  });
});

/* ==========================================================================
   Account tender and the billing relationship
   ========================================================================= */

describe('Account tender (pos_orders.invoice_id)', () => {
  function anyMemberId(): string {
    return db.select({ id: schema.members.id }).from(schema.members).limit(1).get()!.id;
  }

  it('leaves a cash sale standalone rather than minting a paid invoice', async () => {
    const productId = freshProduct('br_kor', 5);
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 118_000 }],
    });
    const body = (await response.json()) as { order: { invoiceId: string | null } };
    // The money is in the drawer. There is no receivable, so there is no
    // invoice — deliberately, not for want of wiring.
    expect(body.order.invoiceId).toBeNull();
  });

  it('raises a real open invoice for the on-account share of a sale', async () => {
    const productId = freshProduct('br_kor', 5);
    const memberId = anyMemberId();
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      memberId,
      lines: [{ productId, quantity: 1 }],
      payments: [
        { method: 'cash', amountMinor: 18_000 },
        { method: 'account', amountMinor: 100_000 },
      ],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { order: { invoiceId: string | null; reference: string } };
    expect(body.order.invoiceId).not.toBeNull();

    const invoice = db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, body.order.invoiceId!))
      .get()!;
    // Only the unsettled share is billed. The ₹180 taken in cash is not a debt.
    expect(invoice.totalMinor).toBe(100_000);
    expect(invoice.state).toBe('open');
    expect(invoice.paidMinor).toBe(0);
    expect(invoice.memberId).toBe(memberId);
    expect(invoice.refType).toBe('pos_order');
    expect(invoice.number).toMatch(/^SF-\d{4}-\d{5}$/);
  });

  it('refuses to charge a walk-in to an account it cannot name', async () => {
    const productId = freshProduct('br_kor', 5);
    const response = await post(owner, '/v1/admin/store/orders', {
      branchId: 'br_kor',
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'account', amountMinor: 118_000 }],
    });
    // `invoices.member_id` is NOT NULL, so there is no honest row to write.
    expect(response.status).toBe(422);
    expect(await onHandOf(productId, 'br_kor')).toBe(5);
  });
});
