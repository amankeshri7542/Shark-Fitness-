import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';
import {
  TENANT,
  createClassSession,
  createMember,
  get,
  post,
  send,
  signIn,
  signInMember,
  type FixtureMember,
  type Session,
} from './support/fixtures.js';
import { checkout, postWebhook, startHarness, type Harness } from './support/razorpay-harness.js';

/**
 * Credit packs (P05; decision 11; PF-CAT-001/004/005; PRD 02 §14.2 "Refund
 * with partial consumption"). Every pack here is sold through the API, paid
 * through the API (desk or Razorpay webhook), and spent through real bookings.
 */

let owner: Session;
let reception: Session;

/** A pack product of our own, so expiry and price are the test's choice. */
function packProduct(input: { credits: number; expireDays: number; priceMinor: number; kind?: 'class_pack' | 'pt_credits' }): string {
  const template = db.select().from(schema.products).where(eq(schema.products.id, 'prd_class_10')).get()!;
  const productId = id('prd');
  db.insert(schema.products)
    .values({
      ...template,
      id: productId,
      kind: input.kind ?? 'class_pack',
      name: `Test pack ${input.credits}×${input.expireDays}d`,
      credits: input.credits,
      creditsExpireDays: input.expireDays,
      durationDays: input.expireDays,
      priceMinor: input.priceMinor,
      taxRateBp: 0,
    })
    .run();
  return productId;
}

const key = () => `k-${id('x')}`;

async function sell(memberId: string, productId: string, session = owner, idem = key()) {
  const response = await post(session, `/v1/admin/billing/members/${memberId}/credit-packs`, { productId }, { 'idempotency-key': idem });
  return { status: response.status, body: (await response.json()) as { packId: string; invoiceId: string; totalMinor: number; creditsAllocated: boolean; message: string } };
}

async function payAtDesk(invoiceId: string, amountMinor: number) {
  const response = await post(owner, `/v1/admin/billing/invoices/${invoiceId}/payments`, { amountMinor, method: 'cash', idempotencyKey: key() });
  expect(response.status).toBe(200);
}

async function account(session: Session, memberId?: string) {
  const response = memberId ? await get(session, `/v1/admin/billing/members/${memberId}/credits`) : await get(session, '/v1/member/billing/credits');
  expect(response.status).toBe(200);
  return (await response.json()) as {
    balances: Array<{ kind: string; usableUnits: number; lots: Array<{ lotId: string; usable: number; remaining: number; expiresOn: string | null }> }>;
    packs: Array<{ id: string; state: string; remaining: number; refund: { refundable: boolean; kind: string | null; units: number; amountMinor: number; message: string } }>;
    offers: Array<{ productId: string }>;
    saleAvailable: boolean;
  };
}

const classBalance = async (session: Session, memberId?: string) => (await account(session, memberId)).balances.find((b) => b.kind === 'class')!;

function creditRows(memberId: string) {
  return db.select().from(schema.credits).where(eq(schema.credits.memberId, memberId)).all();
}

async function memberWithLogin(label: string): Promise<FixtureMember & { session: Session }> {
  const member = createMember({ withLogin: true, firstName: label });
  return { ...member, session: await signInMember(member) };
}

beforeAll(async () => {
  db.update(schema.branches).set({ state: 'active' }).run();
  owner = await signIn('owner@sharkfitness.in');
  reception = await signIn('reception@sharkfitness.in');
});

describe('sale and allocation', () => {
  it('no credits before the invoice is paid in full; they appear with the payment that completes it', async () => {
    const member = createMember({ firstName: 'Alloc' });
    const productId = packProduct({ credits: 5, expireDays: 90, priceMinor: 5_000_00 });

    const sale = await sell(member.memberId, productId);
    expect(sale.status).toBe(200);
    expect(sale.body.creditsAllocated).toBe(false);
    expect(sale.body.message).toContain('as soon as it is paid in full');
    expect((await classBalance(owner, member.memberId)).usableUnits).toBe(0);

    // Part-paid is still not paid.
    await payAtDesk(sale.body.invoiceId, 2_000_00);
    expect((await classBalance(owner, member.memberId)).usableUnits).toBe(0);
    expect(creditRows(member.memberId)).toHaveLength(0);

    await payAtDesk(sale.body.invoiceId, 3_000_00);
    const balance = await classBalance(owner, member.memberId);
    expect(balance.usableUnits).toBe(5);
    expect(balance.lots[0]!.expiresOn).not.toBeNull();

    const pack = db.select().from(schema.creditPacks).where(eq(schema.creditPacks.id, sale.body.packId)).get()!;
    expect(pack.state).toBe('active');
    // The payment and the allocation were one request, one transaction.
    const payment = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, sale.body.invoiceId), eq(schema.auditLog.action, 'payment.recorded'))).all().at(-1)!;
    const allocated = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, sale.body.packId), eq(schema.auditLog.action, 'credit_pack.allocated'))).get()!;
    expect(allocated.requestId).toBe(payment.requestId);
  });

  it('if the credits cannot be written, the payment does not commit either', async () => {
    const member = createMember({ firstName: 'Atomic' });
    const productId = packProduct({ credits: 3, expireDays: 30, priceMinor: 900_00 });
    const sale = await sell(member.memberId, productId);

    sqlite.exec(`CREATE TRIGGER p05_block_pack_grant BEFORE INSERT ON credits WHEN NEW.ref_type = 'credit_pack' BEGIN SELECT RAISE(ABORT, 'blocked for test'); END`);
    try {
      const response = await post(owner, `/v1/admin/billing/invoices/${sale.body.invoiceId}/payments`, { amountMinor: 900_00, method: 'cash', idempotencyKey: key() });
      expect(response.status).toBe(500);
    } finally {
      sqlite.exec('DROP TRIGGER p05_block_pack_grant');
    }
    expect(db.select().from(schema.payments).where(eq(schema.payments.invoiceId, sale.body.invoiceId)).all()).toHaveLength(0);
    expect(db.select().from(schema.invoices).where(eq(schema.invoices.id, sale.body.invoiceId)).get()!.paidMinor).toBe(0);
  });

  it('selling is idempotent on the request key, and refuses a product that is not a pack', async () => {
    const member = createMember({ firstName: 'Idem' });
    const productId = packProduct({ credits: 2, expireDays: 30, priceMinor: 100_00 });
    const idem = key();
    const first = await sell(member.memberId, productId, owner, idem);
    const second = await sell(member.memberId, productId, owner, idem);
    expect(second.body.packId).toBe(first.body.packId);
    expect(db.select().from(schema.creditPacks).where(eq(schema.creditPacks.memberId, member.memberId)).all()).toHaveLength(1);

    const notAPack = await sell(member.memberId, db.select().from(schema.products).where(eq(schema.products.kind, 'membership')).get()!.id);
    expect(notAPack.status).toBe(422);
  });

  it('a member buys a pack in the app; with no payment provider it waits for reception', async () => {
    const member = await memberWithLogin('SelfBuy');
    const productId = packProduct({ credits: 4, expireDays: 60, priceMinor: 1_600_00 });
    expect((await account(member.session)).offers.some((o) => o.productId === productId)).toBe(true);

    const response = await post(member.session, '/v1/member/billing/credit-packs', { productId }, { 'idempotency-key': key() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { invoiceId: string; payOnline: boolean; message: string };
    expect(body.payOnline).toBe(false);
    expect(body.message).toContain('Pay at reception');
    expect((await classBalance(member.session)).usableUnits).toBe(0);

    await payAtDesk(body.invoiceId, 1_600_00);
    expect((await classBalance(member.session)).usableUnits).toBe(4);
  });
});

describe('consumption and restoration', () => {
  it('bookings spend the earliest-expiring credits first; a timely cancellation restores them with the original expiry', async () => {
    const member = await memberWithLogin('Fifo');
    const late = packProduct({ credits: 3, expireDays: 120, priceMinor: 300_00 });
    const soon = packProduct({ credits: 1, expireDays: 20, priceMinor: 100_00 });
    for (const productId of [late, soon]) {
      const sale = await sell(member.memberId, productId);
      await payAtDesk(sale.body.invoiceId, sale.body.totalMinor);
    }
    const before = await classBalance(member.session);
    expect(before.usableUnits).toBe(4);
    const soonLot = before.lots[0]!;
    const lateLot = before.lots[1]!;
    expect(soonLot.expiresOn! < lateLot.expiresOn!).toBe(true);

    const sessionId = createClassSession({ capacity: 5, creditsRequired: 1 });
    const booked = await post(member.session, '/v1/member/schedule/book', { sessionId, idempotencyKey: key() });
    expect(booked.status).toBe(200);
    const bookingId = ((await booked.json()) as { booking: { id: string } }).booking.id;

    const spend = creditRows(member.memberId).find((row) => row.refId === bookingId && row.delta < 0)!;
    expect(spend.lotId).toBe(soonLot.lotId);
    expect((await classBalance(member.session)).lots[0]!.usable).toBe(0);

    const cancelled = await send(member.session, 'DELETE', `/v1/member/schedule/booking/${bookingId}`);
    expect(cancelled.status).toBe(200);
    const restore = creditRows(member.memberId).find((row) => row.refId === bookingId && row.delta > 0)!;
    expect(restore.lotId).toBe(soonLot.lotId);
    expect(restore.expiresOn).toBe(soonLot.expiresOn);
    const after = await classBalance(member.session);
    expect(after.usableUnits).toBe(4);
    expect(after.lots[0]).toMatchObject({ lotId: soonLot.lotId, usable: 1, expiresOn: soonLot.expiresOn });
  });

  it('a late cancellation forfeits the credit', async () => {
    const member = await memberWithLogin('Late');
    const sale = await sell(member.memberId, packProduct({ credits: 2, expireDays: 60, priceMinor: 200_00 }));
    await payAtDesk(sale.body.invoiceId, sale.body.totalMinor);
    // The deadline has already passed.
    const sessionId = createClassSession({ capacity: 5, creditsRequired: 1, startsInMs: 3 * 3_600_000, cancelDeadlineBeforeMs: 4 * 3_600_000 });
    const booked = await post(member.session, '/v1/member/schedule/book', { sessionId, idempotencyKey: key() });
    const bookingId = ((await booked.json()) as { booking: { id: string } }).booking.id;
    const cancelled = await send(member.session, 'DELETE', `/v1/member/schedule/booking/${bookingId}`);
    expect(((await cancelled.json()) as { cancellation: { late: boolean; creditsRefunded: number } }).cancellation).toMatchObject({ late: true, creditsRefunded: 0 });
    expect((await classBalance(member.session)).usableUnits).toBe(1);
  });

  it('a delivered PT session uses one PT credit, earliest expiry first', async () => {
    const member = createMember({ firstName: 'Pt' });
    db.update(schema.members).set({ trainerId: db.select().from(schema.staff).where(eq(schema.staff.tenantId, TENANT)).get()!.id }).where(eq(schema.members.id, member.memberId)).run();
    const sale = await sell(member.memberId, packProduct({ credits: 2, expireDays: 30, priceMinor: 2_400_00, kind: 'pt_credits' }));
    await payAtDesk(sale.body.invoiceId, sale.body.totalMinor);
    const idem = key();
    const used = await post(owner, `/v1/admin/billing/members/${member.memberId}/pt-sessions`, { note: 'Squat technique' }, { 'idempotency-key': idem });
    expect(used.status).toBe(200);
    await post(owner, `/v1/admin/billing/members/${member.memberId}/pt-sessions`, { note: 'Squat technique' }, { 'idempotency-key': idem });
    const pt = (await account(owner, member.memberId)).balances.find((b) => b.kind === 'pt')!;
    expect(pt.usableUnits).toBe(1);
  });
});

describe('refunds (decision 11)', () => {
  async function refund(packId: string, reason: string, session = owner) {
    const response = await post(session, `/v1/admin/billing/credit-packs/${packId}/refund`, { reason }, { 'idempotency-key': key() });
    return { status: response.status, body: (await response.json()) as { amountMinor: number; unitsRevoked: number; state: string; error?: { message: string } } };
  }

  it('wholly unused: the full amount, and every credit removed', async () => {
    const member = createMember({ firstName: 'RefundFull' });
    const sale = await sell(member.memberId, packProduct({ credits: 10, expireDays: 90, priceMinor: 6_000_00 }));
    await payAtDesk(sale.body.invoiceId, sale.body.totalMinor);

    const quote = (await account(owner, member.memberId)).packs[0]!.refund;
    expect(quote).toMatchObject({ refundable: true, kind: 'full', units: 10, amountMinor: 6_000_00 });

    const result = await refund(sale.body.packId, 'Moving cities');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ amountMinor: 6_000_00, unitsRevoked: 10, state: 'succeeded' });
    expect((await classBalance(owner, member.memberId)).usableUnits).toBe(0);
    expect(db.select().from(schema.creditPacks).where(eq(schema.creditPacks.id, sale.body.packId)).get()!.state).toBe('refunded');
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, sale.body.invoiceId)).get()!;
    expect(invoice.refundedMinor).toBe(6_000_00);
    expect(db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, sale.body.packId), eq(schema.auditLog.action, 'credit_pack.refunded'))).get()?.reason).toBe('Moving cities');
  });

  it('partly used: unused credits × unit price, with the reason recorded', async () => {
    const member = await memberWithLogin('RefundPart');
    const sale = await sell(member.memberId, packProduct({ credits: 10, expireDays: 90, priceMinor: 5_999_00 }));
    await payAtDesk(sale.body.invoiceId, sale.body.totalMinor);
    for (let i = 0; i < 3; i += 1) {
      const sessionId = createClassSession({ capacity: 5, creditsRequired: 1, startsInMs: (2 + i) * 86_400_000 });
      expect((await post(member.session, '/v1/member/schedule/book', { sessionId, idempotencyKey: key() })).status).toBe(200);
    }

    const result = await refund(sale.body.packId, 'Injury, doctor advised rest');
    expect(result.status).toBe(200);
    // 7 unused × floor(5,999.00 / 10) = 7 × 599.90
    expect(result.body).toMatchObject({ amountMinor: 7 * 599_90, unitsRevoked: 7 });
    expect((await classBalance(member.session)).usableUnits).toBe(0);
    expect(db.select().from(schema.creditPacks).where(eq(schema.creditPacks.id, sale.body.packId)).get()!.state).toBe('partially_refunded');
    // The three booked classes keep their seats.
    expect(db.select().from(schema.bookings).where(and(eq(schema.bookings.memberId, member.memberId), eq(schema.bookings.state, 'confirmed'))).all()).toHaveLength(3);

    // Nothing left: a second refund is refused.
    const again = await refund(sale.body.packId, 'Asking twice');
    expect(again.status).toBe(412);
  });

  it('expired: refused, with nothing changed', async () => {
    const member = createMember({ firstName: 'RefundExpired' });
    const sale = await sell(member.memberId, packProduct({ credits: 5, expireDays: 30, priceMinor: 1_000_00 }));
    await payAtDesk(sale.body.invoiceId, sale.body.totalMinor);
    // The pack's lot expired yesterday (a compensating ledger view is not
    // possible on an append-only table, so the test ages the pack row instead
    // of the ledger: re-grant is not an option either).
    const lot = creditRows(member.memberId).find((row) => row.refType === 'credit_pack')!;
    sqlite.exec('DROP TRIGGER credits_no_update');
    try {
      sqlite.prepare('update credits set expires_on = ? where id = ?').run('2026-01-01', lot.id);
    } finally {
      sqlite.exec(`CREATE TRIGGER credits_no_update BEFORE UPDATE ON credits BEGIN SELECT RAISE(ABORT, 'credits is append-only'); END`);
    }

    const result = await refund(sale.body.packId, 'Never came');
    expect(result.status).toBe(412);
    expect(result.body.error?.message).toContain('Expired credits are not refundable');
    expect(db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, db.select().from(schema.payments).where(eq(schema.payments.invoiceId, sale.body.invoiceId)).get()!.id)).all()).toHaveLength(0);
  });

  it('needs billing.refund, and the generic refund path refuses a pack', async () => {
    const member = createMember({ firstName: 'RefundPerm' });
    const sale = await sell(member.memberId, packProduct({ credits: 2, expireDays: 30, priceMinor: 200_00 }));
    await payAtDesk(sale.body.invoiceId, sale.body.totalMinor);
    expect((await refund(sale.body.packId, 'Reception trying', reception)).status).toBe(403);

    const paymentId = db.select().from(schema.payments).where(eq(schema.payments.invoiceId, sale.body.invoiceId)).get()!.id;
    const generic = await post(owner, `/v1/admin/billing/payments/${paymentId}/refund`, { amountMinor: 200_00, reason: 'Generic path', entitlementReversed: false }, { 'idempotency-key': key() });
    expect(generic.status).toBe(412);
    expect((await classBalance(owner, member.memberId)).usableUnits).toBe(2);
  });
});

describe('who sees what', () => {
  it('the assigned coach sees balances and history but no prices, packs or refund amounts', async () => {
    const member = createMember({ firstName: 'CoachView' });
    const rehan = db.select().from(schema.users).where(eq(schema.users.email, 'rehan@sharkfitness.in')).get()!;
    const staffId = db.select().from(schema.staff).where(eq(schema.staff.userId, rehan.id)).get()!.id;
    db.update(schema.members).set({ trainerId: staffId }).where(eq(schema.members.id, member.memberId)).run();
    const sale = await sell(member.memberId, packProduct({ credits: 3, expireDays: 30, priceMinor: 900_00 }));
    await payAtDesk(sale.body.invoiceId, sale.body.totalMinor);

    const coach = await signIn('rehan@sharkfitness.in');
    const response = await get(coach, `/v1/admin/billing/members/${member.memberId}/credits`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown> & { balances: Array<{ kind: string; usableUnits: number }> };
    expect(body.balances.find((b) => b.kind === 'class')?.usableUnits).toBe(3);
    expect(body.packs).toBeUndefined();
    expect(body.offers).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('900');
  });
});

describe('the ledger is append-only', () => {
  it('refuses an update or a delete of a credit row', () => {
    const member = createMember({ firstName: 'Ledger' });
    const rowId = id('crd');
    db.insert(schema.credits)
      .values({ id: rowId, tenantId: TENANT, memberId: member.memberId, kind: 'class', delta: 1, reason: 'Test', refType: 'test', refId: null, expiresOn: null, createdAt: now(), lotId: null, packId: null })
      .run();
    expect(() => db.update(schema.credits).set({ delta: 50 }).where(eq(schema.credits.id, rowId)).run()).toThrow(/append-only/);
    expect(() => db.delete(schema.credits).where(eq(schema.credits.id, rowId)).run()).toThrow(/append-only/);
  });
});

describe('Razorpay paths', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.close());

  it('credits appear when the payment.captured webhook settles the pack invoice, and not before', async () => {
    const member = await memberWithLogin('Webhook');
    const productId = packProduct({ credits: 6, expireDays: 45, priceMinor: 2_400_00 });
    const bought = await post(member.session, '/v1/member/billing/credit-packs', { productId }, { 'idempotency-key': key() });
    const body = (await bought.json()) as { invoiceId: string; payOnline: boolean; packId: string };
    expect(body.payOnline).toBe(true);

    const harnessSession = { cookie: member.session.cookie, 'x-csrf-token': member.session.csrfToken };
    const order = await checkout(harnessSession, body.invoiceId);
    expect(order.response.status).toBe(200);
    expect((await classBalance(member.session)).usableUnits).toBe(0);

    const payment = harness.fake.pay(order.body.orderId);
    const hook = await postWebhook(harness, 'payment.captured', { payment });
    expect(hook.status).toBe(200);
    expect((await classBalance(member.session)).usableUnits).toBe(6);
    expect(db.select().from(schema.creditPacks).where(eq(schema.creditPacks.id, body.packId)).get()!.state).toBe('active');
    harness.assertClean();
  });

  it('a provider refund takes the credits back when it is requested, and returns them if Razorpay fails it', async () => {
    const member = await memberWithLogin('ProviderRefund');
    const productId = packProduct({ credits: 4, expireDays: 45, priceMinor: 1_200_00 });
    const bought = await post(member.session, '/v1/member/billing/credit-packs', { productId }, { 'idempotency-key': key() });
    const body = (await bought.json()) as { invoiceId: string; packId: string };
    const order = await checkout({ cookie: member.session.cookie, 'x-csrf-token': member.session.csrfToken }, body.invoiceId);
    await postWebhook(harness, 'payment.captured', { payment: harness.fake.pay(order.body.orderId) });
    expect((await classBalance(member.session)).usableUnits).toBe(4);

    const requested = await post(owner, `/v1/admin/billing/credit-packs/${body.packId}/refund`, { reason: 'Changed plans' }, { 'idempotency-key': key() });
    expect(requested.status).toBe(200);
    const refundBody = (await requested.json()) as { refundId: string; state: string; amountMinor: number };
    expect(refundBody.amountMinor).toBe(1_200_00);
    expect((await classBalance(member.session)).usableUnits).toBe(0);

    const refundRow = db.select().from(schema.refunds).where(eq(schema.refunds.id, refundBody.refundId)).get()!;
    const providerRefund = harness.fake.refunds.get(refundRow.providerRefundId!)!;
    const providerPaymentId = db.select().from(schema.payments).where(eq(schema.payments.id, refundRow.paymentId)).get()!.providerRef!;
    providerRefund.status = 'failed';
    harness.fake.payments.get(providerPaymentId)!.amount_refunded = 0;
    const failed = await postWebhook(harness, 'refund.failed', { refund: { ...providerRefund, status: 'failed' }, payment: harness.fake.payments.get(providerPaymentId)! });
    expect(failed.status).toBe(200);
    expect(db.select().from(schema.refunds).where(eq(schema.refunds.id, refundRow.id)).get()!.state).toBe('failed');
    expect((await classBalance(member.session)).usableUnits).toBe(4);
    expect(db.select().from(schema.creditPacks).where(eq(schema.creditPacks.id, body.packId)).get()!.state).toBe('active');
    harness.assertClean();
  });
});
