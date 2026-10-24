import { describe, expect, it } from 'vitest';
import { and, asc, eq, ne } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { taxInvoiceRecord } from '../services/tax-invoice.js';

/* ============================================================================
   GST tax invoices.

   A tax invoice is a document somebody else files. What must hold: it states
   the GSTIN, state and place of supply it was raised under, not today's; its
   CGST and SGST add back to the tax the member was charged; it says so plainly
   when it is not a tax invoice; and it reaches only the people who may see
   the invoice it prints.
   ========================================================================= */

interface Session { cookie: string; csrfToken: string }
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

const headers = (session: Session, unsafe = false): Record<string, string> => ({
  cookie: session.cookie,
  origin: 'http://localhost:5173',
  ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
});
const get = (session: Session, path: string) => app.request(path, { headers: headers(session) });
const post = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: headers(session, true), body: JSON.stringify(body) });

const tenant = () => db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
const memberByNo = (memberNo: string) => db.select().from(schema.members).where(eq(schema.members.memberNo, memberNo)).get()!;
const firstInvoiceOf = (memberId: string) =>
  db.select().from(schema.invoices).where(eq(schema.invoices.memberId, memberId)).orderBy(asc(schema.invoices.issuedOn)).get()!;

/** Runs `body` with the tenant's tax profile replaced, and puts it back. */
async function withTaxProfile(profile: Record<string, unknown> | null, body: () => Promise<void>): Promise<void> {
  const before = tenant().taxProfile;
  db.update(schema.tenants).set({ taxProfile: profile as never }).where(eq(schema.tenants.id, tenant().id)).run();
  try {
    await body();
  } finally {
    db.update(schema.tenants).set({ taxProfile: before as never }).where(eq(schema.tenants.id, tenant().id)).run();
  }
}

/** An invoice raised before tax documents existed: an invoice and a line, no snapshot. */
function legacyInvoice(memberId: string): { invoiceId: string; cleanup: () => void } {
  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get()!;
  const invoiceId = id('inv');
  const at = Date.now();
  db.insert(schema.invoices).values({
    id: invoiceId, tenantId: member.tenantId, branchId: member.homeBranchId, memberId, number: `LEGACY-${invoiceId.slice(-6)}`,
    state: 'open', issuedOn: '2026-05-10', dueOn: '2026-05-17', currency: 'INR', subtotalMinor: 100_000, discountMinor: 0,
    taxMinor: 18_000, totalMinor: 118_000, paidMinor: 0, refundedMinor: 0, voided: false, voidReason: null,
    refType: 'membership', refId: null, createdAt: at, updatedAt: at,
  }).run();
  db.insert(schema.invoiceLines).values({
    id: id('ivl'), tenantId: member.tenantId, invoiceId, description: 'Depot Monthly', quantity: 1, unitMinor: 100_000,
    discountMinor: 0, taxRateBp: 1800, taxMinor: 18_000, totalMinor: 118_000, productId: null,
  }).run();
  return {
    invoiceId,
    cleanup: () => {
      db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)).run();
      db.delete(schema.invoices).where(eq(schema.invoices.id, invoiceId)).run();
    },
  };
}

/** A member with no plan yet, converted from a walk-in at Koramangala. */
async function freshMember(owner: Session): Promise<string> {
  const lead = await post(owner, '/v1/admin/leads', {
    name: `Tax Invoice ${Math.random().toString(36).slice(2, 8)}`,
    phone: `+91 9${Math.floor(100000000 + Math.random() * 800000000)}`,
    source: 'walk_in',
    branchId: 'br_kor',
  });
  const { id: leadId } = (await lead.json()) as { id: string };
  const convert = await post(owner, `/v1/admin/leads/${leadId}/convert`, {});
  return ((await convert.json()) as { memberId: string }).memberId;
}

async function raiseMembershipInvoice(owner: Session): Promise<string> {
  const memberId = await freshMember(owner);
  const assign = await post(owner, `/v1/admin/billing/members/${memberId}/assign-plan`, { productId: 'prd_monthly' });
  expect(assign.status).toBe(201);
  return ((await assign.json()) as { invoiceId: string }).invoiceId;
}

describe('a seeded invoice as a GST tax invoice', () => {
  it('states the GSTIN, state, place of supply, SAC and the amount in words', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const invoice = firstInvoiceOf(memberByNo('SF-40219').id);
    const res = await get(owner, `/v1/admin/billing/invoices/${invoice.id}/tax-invoice`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="tax-invoice-${invoice.number}.txt"`);
    const text = await res.text();
    expect(text).toMatch(/^TAX INVOICE — Original for recipient/);
    expect(text).toContain('GSTIN: 29AABCS1429B1ZQ; State: Karnataka (29)');
    expect(text).toContain('Place of supply: Karnataka (29)');
    expect(text).toContain('Tax payable on reverse charge: No');
    expect(text).toContain('SAC 999723');
    expect(text).toContain(`Invoice number: ${invoice.number}`);
    expect(text).toMatch(/In words: Rupees .* Only/);
    expect(text).not.toMatch(/Not a GST tax invoice|Raised before tax-invoice details/);
  });

  it('splits the tax into CGST and SGST that add back to exactly what was charged', () => {
    // Invoices the application raised, each with its frozen document. Other
    // suites insert bare invoice rows without lines to test reports.
    const raised = db
      .select({ invoice: schema.invoices })
      .from(schema.invoices)
      .innerJoin(schema.invoiceTaxDocuments, eq(schema.invoiceTaxDocuments.invoiceId, schema.invoices.id))
      .where(eq(schema.invoices.tenantId, tenant().id))
      .limit(60)
      .all()
      .map((row) => row.invoice);
    expect(raised.length).toBeGreaterThan(20);
    for (const invoice of raised) {
      const record = taxInvoiceRecord(invoice.tenantId, invoice.id);
      expect(record.totals.cgstMinor + record.totals.sgstMinor + record.totals.igstMinor).toBe(invoice.taxMinor);
      expect(record.totals.taxableMinor + invoice.taxMinor).toBe(invoice.totalMinor);
    }
  });

  it('serves a printable page with the same facts', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const invoice = firstInvoiceOf(memberByNo('SF-40219').id);
    const res = await get(owner, `/v1/admin/billing/invoices/${invoice.id}/tax-invoice?format=html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<h1>Tax invoice</h1>');
    expect(html).toContain('GSTIN 29AABCS1429B1ZQ · Karnataka (29)');
    expect(html).toContain('<th class="n">CGST</th>');
    expect(html).toContain('<th class="n">SGST</th>');
  });
});

describe('the details a tax invoice was raised under are frozen', () => {
  it('keeps the GSTIN of the day of issue when the gym changes it later', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const issuedUnder = (tenant().taxProfile as { registrationNumber: string }).registrationNumber;
    const invoiceId = await raiseMembershipInvoice(owner);

    await withTaxProfile({ registrationNumber: '33AAACS9999K1ZK', label: 'GST', defaultRateBp: 1800, pricesIncludeTax: false }, async () => {
      const text = await (await get(owner, `/v1/admin/billing/invoices/${invoiceId}/tax-invoice`)).text();
      expect(text).toContain(`GSTIN: ${issuedUnder}`);
      expect(text).not.toContain('33AAACS9999K1ZK');
      expect(text).not.toContain('Tamil Nadu');
    });
  });

  it('refuses to edit or delete the frozen record, whoever asks', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const invoiceId = await raiseMembershipInvoice(owner);
    const where = eq(schema.invoiceTaxDocuments.invoiceId, invoiceId);
    expect(db.select().from(schema.invoiceTaxDocuments).where(where).get()).toBeDefined();
    expect(() => db.update(schema.invoiceTaxDocuments).set({ gstin: '27AAPFU0939F1ZV' }).where(where).run()).toThrow(/immutable/);
    expect(() => db.delete(schema.invoiceTaxDocuments).where(where).run()).toThrow(/immutable/);
  });

  it('numbers new invoices with the gym’s own prefix', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const profile = tenant().taxProfile as Record<string, unknown>;
    const res = await app.request('/v1/admin/settings/business', {
      method: 'PATCH',
      headers: headers(owner, true),
      body: JSON.stringify({ taxProfile: { ...profile, pricesIncludeTax: false, invoicePrefix: 'DEPOT' } }),
    });
    expect(res.status).toBe(200);
    try {
      const invoiceId = await raiseMembershipInvoice(owner);
      const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).get()!;
      expect(invoice.number).toMatch(/^DEPOT-\d{4}-\d{5}$/);
      expect(invoice.number.length).toBeLessThanOrEqual(16);
    } finally {
      db.update(schema.tenants).set({ taxProfile: profile as never }).where(eq(schema.tenants.id, tenant().id)).run();
    }
  });
});

describe('who may read a tax invoice', () => {
  it('gives a member their own invoice and nobody else’s', async () => {
    const aman = await signIn('aman@sharkfitness.in');
    const own = firstInvoiceOf(memberByNo('SF-40219').id);
    const res = await get(aman, `/v1/member/billing/invoices/${own.id}/tax-invoice?format=html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(own.number);

    const someoneElse = firstInvoiceOf(memberByNo('SF-40188').id);
    expect((await get(aman, `/v1/member/billing/invoices/${someoneElse.id}/tax-invoice`)).status).toBe(404);
  });

  it('answers 404 to staff outside the invoice’s branch, not 403', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const elsewhere = db.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, tenant().id), ne(schema.invoices.branchId, 'br_kor'))).get()!;
    expect((await get(manager, `/v1/admin/billing/invoices/${elsewhere.id}/tax-invoice`)).status).toBe(404);
  });

  it('refuses a role without billing access', async () => {
    const trainer = await signIn('rehan@sharkfitness.in');
    const invoice = firstInvoiceOf(memberByNo('SF-40219').id);
    expect((await get(trainer, `/v1/admin/billing/invoices/${invoice.id}/tax-invoice`)).status).toBe(403);
  });
});

describe('when it is not, or not provably, a tax invoice', () => {
  it('marks an invoice raised before tax documents existed, and uses current details', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const { invoiceId, cleanup } = legacyInvoice(memberByNo('SF-40219').id);
    try {
      const text = await (await get(owner, `/v1/admin/billing/invoices/${invoiceId}/tax-invoice`)).text();
      expect(text).toContain('Raised before tax-invoice details were recorded');
      expect(text).toContain('CGST 9% ₹90.00; SGST 9% ₹90.00');
    } finally {
      cleanup();
    }
  });

  it('says plainly that it is not a GST tax invoice when no valid GSTIN is configured', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    await withTaxProfile(null, async () => {
      const { invoiceId, cleanup } = legacyInvoice(memberByNo('SF-40219').id);
      try {
        const res = await get(owner, `/v1/admin/billing/invoices/${invoiceId}/tax-invoice`);
        expect(res.headers.get('content-disposition')).toMatch(/filename="invoice-/);
        const text = await res.text();
        expect(text).toMatch(/^INVOICE\n/);
        expect(text).toContain('Not a GST tax invoice: no valid GSTIN was configured when this invoice was raised.');
        expect(text).not.toContain('GSTIN:');
        expect(text).not.toContain('Place of supply');
      } finally {
        cleanup();
      }
    });
  });

  it('escapes member-supplied text on the printable page', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const member = memberByNo('SF-40219');
    db.update(schema.members).set({ addressLine: '<script>alert(1)</script> 5th Block' }).where(eq(schema.members.id, member.id)).run();
    const { invoiceId, cleanup } = legacyInvoice(member.id);
    try {
      const html = await (await get(owner, `/v1/admin/billing/invoices/${invoiceId}/tax-invoice?format=html`)).text();
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; 5th Block');
      expect(html).not.toContain('<script>alert(1)</script>');
    } finally {
      cleanup();
      db.update(schema.members).set({ addressLine: member.addressLine }).where(eq(schema.members.id, member.id)).run();
    }
  });
});
