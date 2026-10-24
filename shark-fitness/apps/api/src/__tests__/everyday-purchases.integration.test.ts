import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { now } from '../lib/time.js';

const origin = 'http://localhost:5173';
const unique = (scope: string) => `${scope}-${crypto.randomUUID()}`;
type Session = { cookie: string; csrf: string };
let owner: Session;
let reception: Session;
let trainer: Session;
let memberSession: Session;
async function login(email: string): Promise<Session> {
  const res = await app.request('/v1/auth/password', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }) });
  expect(res.status).toBe(200);
  const body = await res.json() as { csrfToken: string };
  return { cookie: `shark_session=${res.headers.get('set-cookie')?.match(/shark_session=([^;,]+)/)?.[1]}; shark_csrf=${body.csrfToken}`, csrf: body.csrfToken };
}
function request(session: Session, path: string, body?: unknown, key?: string, branchId?: string) {
  return app.request(`/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}), ...(branchId ? { 'x-branch-id': branchId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function newMember(branchId = 'br_kor') {
  const template = db.select().from(schema.members).where(eq(schema.members.homeBranchId, branchId)).get()!;
  const id = unique('operation-member');
  db.insert(schema.members).values({ ...template, id, userId: null, memberNo: id, email: null, emailNormalized: null, phone: null, phoneNormalized: null, firstName: 'Original', lastName: 'Buyer', lifecycle: 'trial', trainerId: null, version: 1 }).run();
  return id;
}
async function expiredTerm(memberId = newMember(), productId = 'prd_trial') {
  const res = await request(owner, `/admin/billing/members/${memberId}/assign-plan`, { productId });
  expect(res.status).toBe(201);
  const term = await res.json() as { membershipId: string; invoiceId: string };
  db.update(schema.memberships).set({ state: 'expired', updatedAt: now() }).where(eq(schema.memberships.id, term.membershipId)).run();
  return { memberId, ...term };
}
async function quote(memberId: string, session = reception) {
  const res = await request(session, `/admin/billing/members/${memberId}/renewal-quote?productId=prd_daypass`);
  expect(res.status).toBe(200);
  return await res.json() as { quoteToken: string; totalMinor: number; debts: unknown[]; startedOn: string };
}
async function pay(invoiceId: string, amountMinor: number, session = reception) {
  const res = await request(session, `/admin/billing/invoices/${invoiceId}/payments`, { amountMinor, method: 'cash', idempotencyKey: unique('payment') });
  expect(res.status).toBe(200);
  return await res.json() as { paymentId: string };
}
beforeAll(async () => {
  owner = await login('owner@sharkfitness.in');
  reception = await login('reception@sharkfitness.in');
  trainer = await login('rehan@sharkfitness.in');
  memberSession = await login('rohit@sharkfitness.in');
});

describe('manual renewal confirmation', () => {
  it('requires a reviewed quote, creates one immutable pending term and invoice on retry, and keeps old debt payable', async () => {
    const { memberId, invoiceId: oldInvoiceId } = await expiredTerm(newMember(), 'prd_daypass');
    const oldInvoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, oldInvoiceId)).get()!;
    const current = await quote(memberId);
    expect(current.debts).toHaveLength(1);
    const path = `/admin/billing/members/${memberId}/renew`;
    expect((await request(reception, path, { productId: 'prd_daypass' }, unique('missing-quote'))).status).toBe(422);
    const body = { productId: 'prd_daypass', quoteToken: current.quoteToken };
    const key = unique('renew');
    expect((await request(reception, path, body)).status).toBe(422);
    const res = await request(reception, path, body, key);
    expect(res.status).toBe(201);
    const created = await res.json() as { membershipId: string; invoiceId: string; totalMinor: number };
    expect(await (await request(reception, path, body, key)).json()).toEqual(created);
    const term = db.select().from(schema.memberships).where(eq(schema.memberships.id, created.membershipId)).get()!;
    expect(term).toMatchObject({ state: 'pending_payment', autoRenew: false, startedOn: current.startedOn });
    expect(db.select().from(schema.invoices).where(eq(schema.invoices.refId, created.membershipId)).all()).toHaveLength(1);
    expect((await request(reception, path, { ...body, productId: 'prd_monthly' }, key)).status).toBe(409);
    expect((await request(reception, `/admin/billing/members/${memberId}/renewal-quote`)).status).toBe(409);
    await pay(created.invoiceId, created.totalMinor);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, created.membershipId)).get()?.state).toBe('active');
    expect(term.productSnapshot.id).toBe('prd_daypass');
    expect(db.select().from(schema.invoices).where(eq(schema.invoices.id, oldInvoiceId)).get()).toEqual(oldInvoice);
  });

  it('rejects stale catalogue and corrected member confirmations without writing a second term', async () => {
    const { memberId } = await expiredTerm();
    const current = await quote(memberId);
    db.update(schema.members).set({ version: sql`${schema.members.version} + 1` }).where(eq(schema.members.id, memberId)).run();
    expect((await request(reception, `/admin/billing/members/${memberId}/renew`, { productId: 'prd_daypass', quoteToken: current.quoteToken }, unique('stale'))).status).toBe(409);
    const next = await quote(memberId);
    const product = db.select().from(schema.products).where(eq(schema.products.id, 'prd_daypass')).get()!;
    db.update(schema.products).set({ priceMinor: product.priceMinor + 1 }).where(eq(schema.products.id, product.id)).run();
    try {
      expect((await request(reception, `/admin/billing/members/${memberId}/renew`, { productId: product.id, quoteToken: next.quoteToken }, unique('stale-price'))).status).toBe(409);
    } finally { db.update(schema.products).set({ priceMinor: product.priceMinor }).where(eq(schema.products.id, product.id)).run(); }
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.memberId, memberId)).all()).toHaveLength(1);
  });

  it('requires a fresh quote when another payment changes existing debt', async () => {
    const { memberId, invoiceId } = await expiredTerm(newMember(), 'prd_daypass');
    const current = await quote(memberId);
    expect(current.debts).toHaveLength(1);
    await pay(invoiceId, 100);
    const response = await request(reception, `/admin/billing/members/${memberId}/renew`, { productId: 'prd_daypass', quoteToken: current.quoteToken }, unique('debt-changed'));
    expect(response.status).toBe(409);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.memberId, memberId)).all()).toHaveLength(1);
  });

  it.each(['pending_payment', 'active', 'frozen', 'grace', 'suspended', 'cancel_scheduled'])('explicitly refuses renewal for %s', async (state) => {
    const { memberId, membershipId } = await expiredTerm();
    db.update(schema.memberships).set({ state, endsOn: '2099-12-31', graceEndsOn: '2099-12-31', freezeStartedOn: '2099-01-01', freezeEndsOn: '2099-12-31', cancelEffectiveOn: '2099-12-31' }).where(eq(schema.memberships.id, membershipId)).run();
    expect((await request(reception, `/admin/billing/members/${memberId}/renewal-quote`)).status).toBe(409);
    expect(db.select().from(schema.memberships).where(eq(schema.memberships.memberId, memberId)).all()).toHaveLength(1);
  });

  it('enforces role and branch scope for quote and cached confirmation', async () => {
    const { memberId } = await expiredTerm();
    expect((await request(trainer, `/admin/billing/members/${memberId}/renewal-quote`)).status).toBe(403);
    const current = await quote(memberId);
    const key = unique('scope-renew');
    const body = { productId: 'prd_daypass', quoteToken: current.quoteToken };
    expect((await request(reception, `/admin/billing/members/${memberId}/renew`, body, key)).status).toBe(201);
    expect((await request(reception, `/admin/billing/members/${memberId}/renew`, body, key, 'br_ind')).status).toBe(403);
    const foreignId = newMember();
    db.update(schema.members).set({ tenantId: 'other-tenant' }).where(eq(schema.members.id, foreignId)).run();
    expect((await request(owner, `/admin/billing/members/${foreignId}/renewal-quote`)).status).toBe(404);
  });
});

describe('canonical payment acknowledgements', () => {
  it('preserves issued identity after profile corrections, prints escaped HTML, reflects refunds and creates no financial rows on download', async () => {
    const memberId = newMember();
    const created = await (await request(reception, `/admin/billing/members/${memberId}/assign-plan`, { productId: 'prd_daypass' })).json() as { invoiceId: string; totalMinor: number };
    const { paymentId } = await pay(created.invoiceId, created.totalMinor);
    const snapshot = db.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.paymentId, paymentId)).get()!;
    db.update(schema.members).set({ firstName: '<script>alert(1)</script>', memberNo: unique('corrected') }).where(eq(schema.members.id, memberId)).run();
    const refund = await request(owner, `/admin/billing/payments/${paymentId}/refund`, { amountMinor: 100, reason: 'Partial refund test' }, unique('refund'));
    expect(refund.status).toBe(200);
    const counts = { payments: db.select().from(schema.payments).all().length, refunds: db.select().from(schema.refunds).all().length };
    const text = await request(reception, `/admin/billing/payments/${paymentId}/receipt`);
    expect(text.status).toBe(200);
    expect(text.headers.get('cache-control')).toBe('no-store');
    const content = await text.text();
    expect(content).toContain('Original Buyer');
    expect(content).toContain(snapshot.memberNo);
    expect(content).toContain('Unpaid principal: ₹0');
    expect(content).toContain('Refunded: ₹1');
    const html = await request(reception, `/admin/billing/payments/${paymentId}/receipt?format=html`);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).not.toContain('<script>');
    expect(db.select().from(schema.payments).all()).toHaveLength(counts.payments);
    expect(db.select().from(schema.refunds).all()).toHaveLength(counts.refunds);
    expect((await request(owner, `/admin/billing/payments/${paymentId}/receipt`, undefined, undefined, 'br_ind')).status).toBe(404);
    expect((await request(memberSession, `/member/billing/payments/${paymentId}/receipt`)).status).toBe(404);
    expect(() => db.update(schema.paymentReceipts).set({ memberName: 'Changed' }).where(eq(schema.paymentReceipts.paymentId, paymentId)).run()).toThrow('immutable');
  });

  it('labels unavailable legacy issuance identity explicitly', async () => {
    const payment = db.select().from(schema.payments).where(and(eq(schema.payments.state, 'succeeded'), sql`${schema.payments.id} NOT IN (SELECT payment_id FROM payment_receipts)`)).get()!;
    const res = await request(owner, `/admin/billing/payments/${payment.id}/receipt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Legacy record: identity shown is current');
  });
});


describe('credit account read model', () => {
  it('blocks credit-linked refunds without changing money or ledger history while policy is unresolved', async () => {
    const memberId = newMember();
    const purchase = await (await request(reception, `/admin/billing/members/${memberId}/assign-plan`, { productId: 'prd_daypass' })).json() as { invoiceId: string; totalMinor: number };
    const { paymentId } = await pay(purchase.invoiceId, purchase.totalMinor);
    db.update(schema.invoices).set({ refType: 'credit_purchase' }).where(eq(schema.invoices.id, purchase.invoiceId)).run();
    const before = { invoice: db.select().from(schema.invoices).where(eq(schema.invoices.id, purchase.invoiceId)).get(), refunds: db.select().from(schema.refunds).all(), credits: db.select().from(schema.credits).all(), audit: db.select().from(schema.auditLog).all() };
    const response = await request(owner, `/admin/billing/payments/${paymentId}/refund`, { amountMinor: 100, reason: 'Unapproved credit refund' }, unique('credit-refund'));
    expect(response.status).toBe(412);
    expect({ invoice: db.select().from(schema.invoices).where(eq(schema.invoices.id, purchase.invoiceId)).get(), refunds: db.select().from(schema.refunds).all(), credits: db.select().from(schema.credits).all(), audit: db.select().from(schema.auditLog).all() }).toEqual(before);
  });
  it('shows existing expiry and signed shortfalls without rewriting history or allocating credits', async () => {
    const memberId = newMember();
    const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get()!;
    const rows = [
      { id: unique('expired-grant'), delta: 10, expiresOn: '2000-01-01', reason: 'Historical expired pack' },
      { id: unique('old-consume'), delta: -3, expiresOn: null, reason: 'Historical class consumption' },
      { id: unique('future-grant'), delta: 2, expiresOn: '2099-01-01', reason: 'Historical valid grant' },
    ].map((row) => ({ ...row, tenantId: member.tenantId, memberId, kind: 'class', refType: 'test', refId: null, createdAt: now() }));
    db.insert(schema.credits).values(rows).run();
    const before = db.select().from(schema.credits).where(eq(schema.credits.memberId, memberId)).all();
    const response = await request(reception, `/admin/billing/members/${memberId}/credits`);
    expect(response.status).toBe(200);
    const account = await response.json() as { saleAvailable: boolean; entries: Array<{ id: string; expired: boolean }>; balances: Array<{ kind: string; signedBalance: number; usableUnits: number | null; warning: string | null }> };
    expect(account.saleAvailable).toBe(false);
    expect(account.balances.find((balance) => balance.kind === 'class')).toMatchObject({ signedBalance: -1, usableUnits: 0, warning: expect.any(String) });
    expect(account.balances.find((balance) => balance.kind === 'pt')).toMatchObject({ usableUnits: null });
    expect(account.entries.find((row) => row.id === rows[0]!.id)?.expired).toBe(true);
    expect(db.select().from(schema.credits).where(eq(schema.credits.memberId, memberId)).all()).toEqual(before);
    expect((await request(owner, `/admin/billing/members/${memberId}/credits`, undefined, undefined, 'br_ind')).status).toBe(404);
    expect((await request(trainer, `/admin/billing/members/${memberId}/credits`)).status).toBe(403);
  });

  it('returns only the authenticated member credit history', async () => {
    const me = db.select().from(schema.members).where(eq(schema.members.email, 'rohit@sharkfitness.in')).get()!;
    const res = await request(memberSession, '/member/billing/credits');
    expect(res.status).toBe(200);
    const account = await res.json() as { entries: Array<{ id: string }> };
    const expected = db.select().from(schema.credits).where(eq(schema.credits.memberId, me.id)).all().map((row) => row.id).sort();
    expect(account.entries.map((row) => row.id).sort()).toEqual(expected);
  });
});
