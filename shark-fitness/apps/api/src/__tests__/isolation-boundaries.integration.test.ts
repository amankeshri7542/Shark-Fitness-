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

const sessions = new Map<string, Session>();

async function signIn(email: string, tenantSlug = 'shark'): Promise<Session> {
  const cacheKey = `${tenantSlug}:${email}`;
  const cached = sessions.get(cacheKey);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug, email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = {
    cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`,
    csrfToken: body.csrfToken,
  };
  sessions.set(cacheKey, session);
  return session;
}

function headers(session: Session, unsafe = false, activeBranchId?: string): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(activeBranchId ? { 'x-branch-id': activeBranchId } : {}),
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const get = (session: Session, path: string, activeBranchId?: string) =>
  app.request(path, { headers: headers(session, false, activeBranchId) });
const post = (session: Session, path: string, body: unknown, activeBranchId?: string) =>
  app.request(path, {
    method: 'POST',
    headers: headers(session, true, activeBranchId),
    body: JSON.stringify(body),
  });
const patch = (session: Session, path: string, body: unknown, activeBranchId?: string) =>
  app.request(path, {
    method: 'PATCH',
    headers: headers(session, true, activeBranchId),
    body: JSON.stringify(body),
  });

function tenantId(slug: 'shark' | 'reef'): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug)).get()!.id;
}

function insertMember(tenant: string, branchId: string, label: string): string {
  const memberId = id('mbr');
  const unique = memberId.slice(-10).toUpperCase();
  db.insert(schema.members)
    .values({
      id: memberId,
      tenantId: tenant,
      userId: null,
      homeBranchId: branchId,
      memberNo: `${label}-${unique}`,
      firstName: label,
      lastName: 'Boundary',
      initials: 'BB',
      email: null,
      phone: null,
      lifecycle: 'active',
      tags: [],
      trainerId: null,
      joinedOn: '2026-08-23',
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return memberId;
}

function insertRetailProduct(
  tenant: string,
  overrides: Partial<typeof schema.retailProducts.$inferInsert> = {},
): string {
  const productId = id('rtl');
  const unique = productId.slice(-10).toUpperCase();
  db.insert(schema.retailProducts)
    .values({
      id: productId,
      tenantId: tenant,
      name: `Boundary Item ${unique}`,
      sku: `BOUND-${unique}`,
      barcode: `991${unique}`,
      category: 'Accessories',
      groupId: null,
      variantName: '',
      supplierId: null,
      priceMinor: 10_000,
      costMinor: 4_000,
      taxRateBp: 1800,
      reorderAt: 5,
      active: true,
      createdAt: now(),
      ...overrides,
    })
    .run();
  return productId;
}

function stock(productId: string, branchId: string, quantity: number): void {
  db.insert(schema.stockLedger)
    .values({
      id: id('stk'),
      tenantId: tenantId('shark'),
      branchId,
      productId,
      delta: quantity,
      reason: 'purchase',
      refType: null,
      refId: null,
      actorName: 'boundary fixture',
      note: null,
      unitCostMinor: 4_000,
      negativeOverride: false,
      overrideReason: null,
      at: now(),
    })
    .run();
}

function onHand(productId: string, branchId: string): number {
  return db
    .select({ quantity: sql<number>`coalesce(sum(${schema.stockLedger.delta}), 0)` })
    .from(schema.stockLedger)
    .where(and(eq(schema.stockLedger.productId, productId), eq(schema.stockLedger.branchId, branchId)))
    .get()!.quantity;
}

const accessRules = (allBranches: boolean, branchIds: string[]) => ({
  allBranches,
  branchIds,
  windowStartMin: null,
  windowEndMin: null,
  visitsPerWeek: null,
  guestPassesPerMonth: 0,
  classPriorityTier: 1,
  bookingWindowHours: 24,
});

function billingProduct(allBranches: boolean, branchIds: string[]) {
  return {
    kind: 'membership',
    name: `Boundary Plan ${id('p').slice(-8)}`,
    priceMinor: 100_000,
    cadence: 'monthly',
    durationDays: 30,
    access: accessRules(allBranches, branchIds),
    freeze: { allowed: false, maxDaysPerTerm: 0, minDaysPerFreeze: 0, extendsExpiry: false, feeMinor: 0 },
    cancellation: {
      noticeDays: 0,
      commitmentMonths: 0,
      earlyExitFeeMinor: 0,
      refundable: false,
      description: 'Boundary fixture.',
    },
  };
}

let owner: Session;
let manager: Session;

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
});

describe('POS member isolation', () => {
  it('rejects out-of-branch and foreign-tenant members without selling, but accepts an explicit branch grant', async () => {
    const shark = tenantId('shark');
    const productId = insertRetailProduct(shark);
    stock(productId, 'br_kor', 3);
    const otherBranchMember = insertMember(shark, 'br_ind', 'OtherBranch');
    const foreignMember = insertMember(tenantId('reef'), 'brn_reef_main', 'ForeignTenant');
    const checkout = (memberId: string) => ({
      branchId: 'br_kor',
      memberId,
      lines: [{ productId, quantity: 1 }],
      payments: [{ method: 'cash', amountMinor: 11_800 }],
    });

    const outOfBranch = await post(manager, '/v1/admin/store/orders', checkout(otherBranchMember));
    expect(outOfBranch.status).toBe(404);
    expect(onHand(productId, 'br_kor')).toBe(3);

    const foreignTenant = await post(owner, '/v1/admin/store/orders', checkout(foreignMember));
    expect(foreignTenant.status).toBe(404);
    expect(onHand(productId, 'br_kor')).toBe(3);

    db.insert(schema.memberBranches)
      .values({ tenantId: shark, memberId: otherBranchMember, branchId: 'br_kor' })
      .run();
    const granted = await post(manager, '/v1/admin/store/orders', checkout(otherBranchMember));
    expect(granted.status).toBe(201);
    expect(onHand(productId, 'br_kor')).toBe(2);
  });
});

describe('retail relationship isolation', () => {
  it('rejects foreign group/supplier relationships and tenant-scopes relationship hydration', async () => {
    const reef = tenantId('reef');
    const foreignSupplierId = id('sup');
    const foreignGroupId = id('grp');
    db.insert(schema.suppliers)
      .values({
        id: foreignSupplierId,
        tenantId: reef,
        name: `Reef Supplier ${foreignSupplierId.slice(-6)}`,
        contactName: '',
        email: '',
        phone: '',
        leadTimeDays: 7,
        active: true,
        createdAt: now(),
      })
      .run();
    db.insert(schema.retailProductGroups)
      .values({
        id: foreignGroupId,
        tenantId: reef,
        name: `Reef Group ${foreignGroupId.slice(-6)}`,
        category: 'Accessories',
        supplierId: foreignSupplierId,
        active: true,
        createdAt: now(),
      })
      .run();

    const groupAttempt = await post(owner, '/v1/admin/store/groups', {
      name: `Leaking Group ${id('g').slice(-6)}`,
      category: 'Accessories',
      supplierId: foreignSupplierId,
    });
    expect(groupAttempt.status).toBe(404);

    const createAttempt = await post(owner, '/v1/admin/store/products', {
      name: 'Leaking Variant',
      sku: `LEAK-${id('s').slice(-8)}`,
      category: 'Accessories',
      priceMinor: 10_000,
      costMinor: 4_000,
      groupId: foreignGroupId,
      supplierId: foreignSupplierId,
    });
    expect(createAttempt.status).toBe(404);

    const localProductId = insertRetailProduct(tenantId('shark'));
    const updateAttempt = await patch(owner, `/v1/admin/store/products/${localProductId}`, {
      groupId: foreignGroupId,
      supplierId: foreignSupplierId,
    });
    expect(updateAttempt.status).toBe(404);
    const unchanged = db.select().from(schema.retailProducts).where(eq(schema.retailProducts.id, localProductId)).get()!;
    expect(unchanged.groupId).toBeNull();
    expect(unchanged.supplierId).toBeNull();

    const corruptId = insertRetailProduct(tenantId('shark'), {
      groupId: foreignGroupId,
      supplierId: foreignSupplierId,
    });
    const corrupt = db.select().from(schema.retailProducts).where(eq(schema.retailProducts.id, corruptId)).get()!;
    const hydrated = await get(owner, `/v1/admin/store/products/barcode/${corrupt.barcode}`);
    expect(hydrated.status).toBe(200);
    const hydratedBody = (await hydrated.json()) as {
      product: { groupName: string | null; supplierName: string | null };
    };
    expect(hydratedBody.product.groupName).toBeNull();
    expect(hydratedBody.product.supplierName).toBeNull();
  });

  it('creates and hydrates in-tenant supplier/group relationships', async () => {
    const supplierResponse = await post(owner, '/v1/admin/store/suppliers', {
      name: `Local Supplier ${id('s').slice(-6)}`,
    });
    expect(supplierResponse.status).toBe(201);
    const supplier = ((await supplierResponse.json()) as { supplier: { id: string; name: string } }).supplier;

    const groupResponse = await post(owner, '/v1/admin/store/groups', {
      name: `Local Group ${id('g').slice(-6)}`,
      category: 'Accessories',
      supplierId: supplier.id,
    });
    expect(groupResponse.status).toBe(201);
    const group = ((await groupResponse.json()) as { group: { id: string } }).group;

    const productResponse = await post(owner, '/v1/admin/store/products', {
      name: 'Local Variant',
      sku: `LOCAL-${id('s').slice(-8)}`,
      category: 'Accessories',
      priceMinor: 10_000,
      costMinor: 4_000,
      groupId: group.id,
      supplierId: supplier.id,
    });
    expect(productResponse.status).toBe(201);
    const product = ((await productResponse.json()) as {
      product: { groupName: string | null; supplierName: string | null };
    }).product;
    expect(product.groupName).toContain('Local Group');
    expect(product.supplierName).toBe(supplier.name);
  });
});

describe('billing catalogue branch isolation', () => {
  it('rejects foreign and out-of-request-scope branches and leaves the catalogue unchanged', async () => {
    const before = db.select().from(schema.products).where(eq(schema.products.tenantId, tenantId('shark'))).all().length;
    const foreign = await post(
      owner,
      '/v1/admin/billing/products',
      billingProduct(false, ['brn_reef_main']),
    );
    expect(foreign.status).toBe(422);

    const otherBranch = await post(
      owner,
      '/v1/admin/billing/products',
      billingProduct(false, ['br_ind']),
      'br_kor',
    );
    expect(otherBranch.status).toBe(422);

    const widened = await post(owner, '/v1/admin/billing/products', billingProduct(true, []), 'br_kor');
    expect(widened.status).toBe(422);
    expect(db.select().from(schema.products).where(eq(schema.products.tenantId, tenantId('shark'))).all()).toHaveLength(before);
  });

  it('normalizes valid access branches and rejects an out-of-scope patch without mutation', async () => {
    const create = await post(owner, '/v1/admin/billing/products', billingProduct(false, ['br_kor']));
    expect(create.status).toBe(201);
    const productId = ((await create.json()) as { id: string }).id;
    const created = db.select().from(schema.products).where(eq(schema.products.id, productId)).get()!;
    expect(created.access.branchIds).toEqual(['br_kor']);
    expect(created.branchIds).toEqual(['br_kor']);

    const update = await patch(
      owner,
      `/v1/admin/billing/products/${productId}`,
      { access: accessRules(false, ['br_ind']) },
      'br_kor',
    );
    expect(update.status).toBe(422);
    const unchanged = db.select().from(schema.products).where(eq(schema.products.id, productId)).get()!;
    expect(unchanged.access.branchIds).toEqual(['br_kor']);
    expect(unchanged.branchIds).toEqual(['br_kor']);
  });
});

describe('shared-trainer workload isolation', () => {
  it('shows only assignments whose members fall within the caller branch scope', async () => {
    const shark = tenantId('shark');
    const trainer = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.users.tenantId, shark), eq(schema.users.email, 'rehan@sharkfitness.in')))
      .get()!;
    const program = db
      .select({ id: schema.programs.id, version: schema.programs.version })
      .from(schema.programs)
      .where(eq(schema.programs.tenantId, shark))
      .get()!;
    const localMember = insertMember(shark, 'br_kor', 'LocalWorkload');
    const otherMember = insertMember(shark, 'br_ind', 'OtherWorkload');
    for (const memberId of [localMember, otherMember]) {
      db.insert(schema.assignments)
        .values({
          id: id('asg'),
          tenantId: shark,
          memberId,
          programId: program.id,
          programVersion: program.version,
          trainerId: trainer.id,
          startsOn: '2026-08-23',
          currentWeek: 1,
          currentBlock: 'A',
          state: 'active',
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
    }

    const scoped = await get(manager, `/v1/admin/staff/${trainer.id}`);
    expect(scoped.status).toBe(200);
    const scopedMembers = ((await scoped.json()) as { workload: { members: Array<{ memberId: string }> } }).workload.members;
    expect(scopedMembers.some((row) => row.memberId === localMember)).toBe(true);
    expect(scopedMembers.some((row) => row.memberId === otherMember)).toBe(false);

    const allBranches = await get(owner, `/v1/admin/staff/${trainer.id}`);
    expect(allBranches.status).toBe(200);
    const allMembers = ((await allBranches.json()) as { workload: { members: Array<{ memberId: string }> } }).workload.members;
    expect(allMembers.some((row) => row.memberId === localMember)).toBe(true);
    expect(allMembers.some((row) => row.memberId === otherMember)).toBe(true);
  });
});
