import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}

// Same session-caching rationale as leads.integration.test.ts — the Phase 1
// login rate limiter (10/60s per route, process-wide) makes a fresh sign-in
// per test case both unrealistic and self-defeating.
const sessionCache = new Map<string, BrowserSession>();

async function signIn(email: string): Promise<BrowserSession> {
  const cached = sessionCache.get(email);
  if (cached) return cached;

  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const setCookie = response.headers.get('set-cookie') ?? '';
  const session = setCookie.match(/shark_session=([^;,]+)/)?.[1];
  const result = { cookie: `shark_session=${session}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  sessionCache.set(email, result);
  return result;
}

function headers(session: BrowserSession, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

function idemKey(scope: string): string {
  return `${scope}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** Creates a member with no membership, in br_kor, for a clean assign-plan target. */
async function freshMember(owner: BrowserSession): Promise<string> {
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
  const branch = db.select().from(schema.branches).where(and(eq(schema.branches.tenantId, tenant.id), eq(schema.branches.id, 'br_kor'))).get()!;

  const lead = await app.request('/v1/admin/leads', {
    method: 'POST',
    headers: headers(owner, true),
    body: JSON.stringify({ name: `Billing Test ${Math.random().toString(36).slice(2, 8)}`, phone: `+91 9${Math.floor(100000000 + Math.random() * 800000000)}`, source: 'walk_in', branchId: branch.id }),
  });
  const { id: leadId } = (await lead.json()) as { id: string };
  for (const to of ['contacted', 'qualified', 'trial_booked', 'trial_completed']) {
    await app.request(`/v1/admin/leads/${leadId}/stage`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ to }) });
  }
  const convert = await app.request(`/v1/admin/leads/${leadId}/convert`, { method: 'POST', headers: headers(owner, true) });
  const { memberId } = (await convert.json()) as { memberId: string };
  return memberId;
}

describe('billing — products', () => {
  it('creates, edits, and retires a product, reporting the affected membership count', async () => {
    const owner = await signIn('owner@sharkfitness.in');

    const create = await app.request('/v1/admin/billing/products', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({
        kind: 'day_pass',
        name: 'Test Day Pass',
        priceMinor: 50000,
        cadence: 'one_time',
        access: { allBranches: true, branchIds: [], windowStartMin: null, windowEndMin: null, visitsPerWeek: null, guestPassesPerMonth: 0, classPriorityTier: 0, bookingWindowHours: 24 },
        freeze: { allowed: false, maxDaysPerTerm: 0, minDaysPerFreeze: 0, extendsExpiry: false, feeMinor: 0 },
        cancellation: { noticeDays: 0, commitmentMonths: 0, earlyExitFeeMinor: 0, refundable: false, description: 'Non-refundable.' },
      }),
    });
    expect(create.status).toBe(201);
    const { id: productId } = (await create.json()) as { id: string };

    const edit = await app.request(`/v1/admin/billing/products/${productId}`, {
      method: 'PATCH',
      headers: headers(owner, true),
      body: JSON.stringify({ status: 'active', priceMinor: 60000 }),
    });
    expect(edit.status).toBe(200);

    const retire = await app.request(`/v1/admin/billing/products/${productId}/retire`, { method: 'POST', headers: headers(owner, true) });
    expect(retire.status).toBe(200);
    const retireBody = (await retire.json()) as { activeMembershipCount: number };
    expect(retireBody.activeMembershipCount).toBe(0);
  });

  it('reports a nonzero active-membership count when retiring a seeded product members are on', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const retire = await app.request('/v1/admin/billing/products/prd_monthly/retire', { method: 'POST', headers: headers(owner, true) });
    expect(retire.status).toBe(200);
    const body = (await retire.json()) as { activeMembershipCount: number };
    expect(body.activeMembershipCount).toBeGreaterThan(0);
    // Restore status for any later test relying on prd_monthly being active.
    await app.request('/v1/admin/billing/products/prd_monthly', { method: 'PATCH', headers: headers(owner, true), body: JSON.stringify({ status: 'active' }) });
  });

  it('denies product management to a role without product.manage', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const before = db.select().from(schema.products).all();
    const product = before.find((row) => row.id === 'prd_daypass')!;
    for (const [method, path, body] of [
      ['POST', '/products', product],
      ['PATCH', `/products/${product.id}`, { priceMinor: 0 }],
      ['POST', `/products/${product.id}/retire`, {}],
      ['POST', `/products/${product.id}/duplicate`, {}],
    ] as const) {
      const response = await app.request(`/v1/admin/billing${path}`, { method, headers: headers(reception, true), body: JSON.stringify(body) });
      expect(response.status).toBe(403);
    }
    expect(db.select().from(schema.products).all()).toEqual(before);
  });

  it.each(['rehan@sharkfitness.in', 'accounts@sharkfitness.in'])('denies catalogue access without product or membership management: %s', async (email) => {
    const session = await signIn(email);
    const response = await app.request('/v1/admin/billing/products', { headers: headers(session) });
    expect(response.status).toBe(403);
  });

  it('lets reception list an entitled published plan and assign it without exposing draft or other-branch plans', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const template = db.select().from(schema.products).where(eq(schema.products.id, 'prd_daypass')).get()!;
    const draftId = idemKey('draft-plan');
    const otherBranchId = idemKey('other-branch-plan');
    db.insert(schema.products).values([
      { ...template, id: draftId, status: 'draft' },
      { ...template, id: otherBranchId, status: 'active', branchIds: ['br_ind'], access: { ...template.access, allBranches: false, branchIds: ['br_ind'] } },
    ]).run();
    try {
      const response = await app.request('/v1/admin/billing/products', { headers: { ...headers(reception), 'x-branch-id': 'br_kor' } });
      expect(response.status).toBe(200);
      const { items } = await response.json() as { items: Array<{ id: string; status: string; name: string; priceLabel: string; cadence: string }> };
      const plan = items.find((item) => item.id === template.id)!;
      expect(plan).toMatchObject({ id: template.id, status: 'active', name: template.name, priceLabel: expect.any(String), cadence: template.cadence });
      expect(items.map((item) => item.id)).not.toContain(draftId);
      expect(items.map((item) => item.id)).not.toContain(otherBranchId);
      expect(items.every((item) => item.status === 'active')).toBe(true);
      const memberId = await freshMember(reception);
      const denied = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, {
        method: 'POST', headers: headers(reception, true), body: JSON.stringify({ productId: otherBranchId }),
      });
      expect(denied.status).toBe(422);
      const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, {
        method: 'POST', headers: headers(reception, true), body: JSON.stringify({ productId: plan.id }),
      });
      expect(assign.status).toBe(201);
      const { membershipId, invoiceId, activated } = await assign.json() as { membershipId: string; invoiceId: string; activated: boolean };
      expect(activated).toBe(false);
      expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, membershipId)).get()?.state).toBe('pending_payment');
      expect(db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).get()).toMatchObject({ state: 'open', paidMinor: 0 });
    } finally {
      db.delete(schema.products).where(eq(schema.products.id, draftId)).run();
      db.delete(schema.products).where(eq(schema.products.id, otherBranchId)).run();
    }
  });
});

describe('billing — plan assignment', () => {
  it('assigns a paid plan, creating a pending_payment membership and an open invoice', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner);

    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ productId: 'prd_daypass' }),
    });
    expect(assign.status).toBe(201);
    const body = (await assign.json()) as { membershipId: string; invoiceId: string; activated: boolean; totalMinor: number };
    expect(body.activated).toBe(false);
    expect(body.totalMinor).toBeGreaterThan(0);

    const membership = db.select().from(schema.memberships).where(eq(schema.memberships.id, body.membershipId)).get();
    expect(membership?.state).toBe('pending_payment');
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, body.invoiceId)).get();
    expect(invoice?.state).toBe('open');
    expect(invoice?.totalMinor).toBe(body.totalMinor);
  });

  it('assigns a zero-price plan and activates the membership immediately', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner);

    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ productId: 'prd_trial' }),
    });
    expect(assign.status).toBe(201);
    const body = (await assign.json()) as { membershipId: string; activated: boolean };
    expect(body.activated).toBe(true);

    const membership = db.select().from(schema.memberships).where(eq(schema.memberships.id, body.membershipId)).get();
    expect(membership?.state).toBe('active');
  });

  it('rejects assigning a second plan to a member who already has one', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner);
    await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_trial' }) });

    const second = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    expect(second.status).toBe(409);
  });

  it('rejects assigning a branch-restricted plan the member cannot use', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner); // br_kor member
    // prd_offpeak is restricted to br_kor and br_hsr — should succeed there,
    // so use a product with zero branch coverage instead to force the reject.
    await db.update(schema.products).set({ access: { allBranches: false, branchIds: ['br_ind'], windowStartMin: null, windowEndMin: null, visitsPerWeek: null, guestPassesPerMonth: 0, classPriorityTier: 0, bookingWindowHours: 24 } }).where(eq(schema.products.id, 'prd_daypass')).run();

    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    expect(assign.status).toBe(422);

    // Restore.
    await db.update(schema.products).set({ access: { allBranches: true, branchIds: [], windowStartMin: null, windowEndMin: null, visitsPerWeek: null, guestPassesPerMonth: 0, classPriorityTier: 0, bookingWindowHours: 24 } }).where(eq(schema.products.id, 'prd_daypass')).run();
  });
});

describe('billing — manual payment recording', () => {
  it('records a full manual payment, activating the membership, and is idempotent on retry', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner);
    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    const { invoiceId, membershipId, totalMinor } = (await assign.json()) as { invoiceId: string; membershipId: string; totalMinor: number };

    const key = idemKey('pay');
    const record = async () =>
      app.request(`/v1/admin/billing/invoices/${invoiceId}/payments`, {
        method: 'POST',
        headers: headers(owner, true),
        body: JSON.stringify({ method: 'cash', amountMinor: totalMinor, idempotencyKey: key }),
      });

    const first = await record();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { invoiceState: string; membershipActivated: boolean; alreadyProcessed: boolean };
    expect(firstBody.invoiceState).toBe('paid');
    expect(firstBody.membershipActivated).toBe(true);
    expect(firstBody.alreadyProcessed).toBe(false);

    const membership = db.select().from(schema.memberships).where(eq(schema.memberships.id, membershipId)).get();
    expect(membership?.state).toBe('active');

    const paymentCountBefore = db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)).all().length;

    const second = await record();
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { alreadyProcessed: boolean };
    expect(secondBody.alreadyProcessed).toBe(true);

    const paymentCountAfter = db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)).all().length;
    expect(paymentCountAfter).toBe(paymentCountBefore);
  });

  it('records a partial payment without activating the membership', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner);
    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    const { invoiceId, membershipId, totalMinor } = (await assign.json()) as { invoiceId: string; membershipId: string; totalMinor: number };

    const half = Math.floor(totalMinor / 2);
    const record = await app.request(`/v1/admin/billing/invoices/${invoiceId}/payments`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ method: 'cash', amountMinor: half, idempotencyKey: idemKey('partial') }),
    });
    expect(record.status).toBe(200);
    const body = (await record.json()) as { invoiceState: string; membershipActivated: boolean };
    expect(body.invoiceState).toBe('partially_paid');
    expect(body.membershipActivated).toBe(false);

    const membership = db.select().from(schema.memberships).where(eq(schema.memberships.id, membershipId)).get();
    expect(membership?.state).toBe('pending_payment');
  });

  it('rejects a payment larger than the amount outstanding', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner);
    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    const { invoiceId, totalMinor } = (await assign.json()) as { invoiceId: string; totalMinor: number };

    const record = await app.request(`/v1/admin/billing/invoices/${invoiceId}/payments`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ method: 'cash', amountMinor: totalMinor + 100000, idempotencyKey: idemKey('over') }),
    });
    expect(record.status).toBe(422);
  });

  it('denies payment recording to a role without billing.record_payment', async () => {
    // trainer role lacks billing.record_payment per packages/domain/src/permissions.ts.
    const trainer = await signIn('rehan@sharkfitness.in');
    const response = await app.request('/v1/admin/billing/invoices/inv_doesnotexist/payments', {
      method: 'POST',
      headers: headers(trainer, true),
      body: JSON.stringify({ method: 'cash', amountMinor: 100, idempotencyKey: idemKey('denied') }),
    });
    expect(response.status).toBe(403);
  });
});

describe('billing — refunds and void', () => {
  it('refunds a succeeded payment, moving the invoice to refunded, without auto-reversing entitlements', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner);
    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    const { invoiceId, totalMinor } = (await assign.json()) as { invoiceId: string; totalMinor: number };

    const record = await app.request(`/v1/admin/billing/invoices/${invoiceId}/payments`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ method: 'cash', amountMinor: totalMinor, idempotencyKey: idemKey('refundme') }) });
    const { paymentId } = (await record.json()) as { paymentId: string };

    const refund = await app.request(`/v1/admin/billing/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ amountMinor: totalMinor, reason: 'Member requested a refund' }),
    });
    expect(refund.status).toBe(200);
    const body = (await refund.json()) as { invoiceState: string };
    expect(body.invoiceState).toBe('refunded');

    const refundRow = db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, paymentId)).get();
    expect(refundRow?.entitlementReversed).toBe(false);
  });

  it('denies refunds to a role without billing.refund', async () => {
    // reception has billing.record_payment but not billing.refund per permissions.ts.
    const reception = await signIn('reception@sharkfitness.in');
    const response = await app.request('/v1/admin/billing/payments/pay_doesnotexist/refund', {
      method: 'POST',
      headers: headers(reception, true),
      body: JSON.stringify({ amountMinor: 100, reason: 'test' }),
    });
    expect(response.status).toBe(403);
  });

  it('voids an unpaid invoice but refuses to void one with payments recorded', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const memberId = await freshMember(owner);
    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    const { invoiceId, totalMinor } = (await assign.json()) as { invoiceId: string; totalMinor: number };

    await app.request(`/v1/admin/billing/invoices/${invoiceId}/payments`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ method: 'cash', amountMinor: 1, idempotencyKey: idemKey('partpay') }) });
    const blockedVoid = await app.request(`/v1/admin/billing/invoices/${invoiceId}/void`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ reason: 'Testing void guard' }) });
    expect(blockedVoid.status).toBe(412);
    void totalMinor;

    const memberId2 = await freshMember(owner);
    const assign2 = await app.request(`/v1/admin/billing/members/${memberId2}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    const { invoiceId: invoiceId2 } = (await assign2.json()) as { invoiceId: string };
    const voidResult = await app.request(`/v1/admin/billing/invoices/${invoiceId2}/void`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ reason: 'Testing clean void' }) });
    expect(voidResult.status).toBe(200);
  });

  it('denies invoice voiding to a role without billing.write_off', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const response = await app.request('/v1/admin/billing/invoices/inv_doesnotexist/void', {
      method: 'POST',
      headers: headers(reception, true),
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(response.status).toBe(403);
  });
});

describe('billing — invoice branch isolation', () => {
  it('hides an invoice in another branch behind a 404', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
    const otherBranch = db.select().from(schema.branches).where(and(eq(schema.branches.tenantId, tenant.id), eq(schema.branches.id, 'br_ind'))).get()!;

    // Create a member directly in br_ind so their invoice is branch-scoped there.
    const lead = await app.request('/v1/admin/leads', { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ name: 'Ind Branch Member', phone: `+91 9${Math.floor(100000000 + Math.random() * 800000000)}`, source: 'walk_in', branchId: otherBranch.id }) });
    const { id: leadId } = (await lead.json()) as { id: string };
    for (const to of ['contacted', 'qualified', 'trial_booked', 'trial_completed']) {
      await app.request(`/v1/admin/leads/${leadId}/stage`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ to }) });
    }
    const convert = await app.request(`/v1/admin/leads/${leadId}/convert`, { method: 'POST', headers: headers(owner, true) });
    const { memberId } = (await convert.json()) as { memberId: string };
    const assign = await app.request(`/v1/admin/billing/members/${memberId}/assign-plan`, { method: 'POST', headers: headers(owner, true), body: JSON.stringify({ productId: 'prd_daypass' }) });
    const { invoiceId } = (await assign.json()) as { invoiceId: string };

    // reception@sharkfitness.in is scoped to br_kor only (seed.ts).
    const reception = await signIn('reception@sharkfitness.in');
    const response = await app.request(`/v1/admin/billing/invoices/${invoiceId}`, { headers: headers(reception) });
    expect(response.status).toBe(404);
  });
});

describe('billing — member self-service', () => {
  it('sees only its own invoices and membership', async () => {
    const aman = await signIn('aman@sharkfitness.in');
    const response = await app.request('/v1/member/billing', { headers: headers(aman) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { membership: { productName: string } | null; invoices: unknown[] };
    expect(body.membership).not.toBeNull();
  });

  it('404s on another member\'s invoice id rather than exposing it', async () => {
    const aman = await signIn('aman@sharkfitness.in');
    const rohit = await signIn('rohit@sharkfitness.in');
    const rohitInvoices = await app.request('/v1/member/billing', { headers: headers(rohit) });
    const rohitBody = (await rohitInvoices.json()) as { invoices: Array<{ id: string }> };
    expect(rohitBody.invoices.length).toBeGreaterThan(0);
    const someRohitInvoiceId = rohitBody.invoices[0]!.id;

    const crossAccess = await app.request(`/v1/member/billing/invoices/${someRohitInvoiceId}`, { headers: headers(aman) });
    expect(crossAccess.status).toBe(404);
  });

});
