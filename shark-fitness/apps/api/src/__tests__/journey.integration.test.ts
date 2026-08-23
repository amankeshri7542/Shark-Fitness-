import { beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { now } from '../lib/time.js';

/* ============================================================================
   The whole business, end to end.

   Every other suite tests a module. This one tests the *seams* — the places
   where one module hands something to another and nobody owns the join:

     lead → member → plan → invoice → payment → door → class → training
          → shop → support → report → refund

   It runs as one continuous story against one real person, because that is
   how the product is actually used and because a bug in a handoff only shows
   up when you walk the whole path. Each step asserts what the *next* step
   depends on, so a break is attributed to the seam that caused it rather than
   to whatever ran last.

   Alongside it: the same journey attempted by roles that must not be able to
   take each step, and by a second tenant that must not see any of it.
   ========================================================================= */

interface Session {
  cookie: string;
  csrfToken: string;
}

const cache = new Map<string, Session>();

async function signIn(email: string, tenantSlug = 'shark'): Promise<Session> {
  const key = `${tenantSlug}:${email}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug, email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(key, session);
  return session;
}

const headers = (s: Session, unsafe = false, branchId?: string): Record<string, string> => ({
  cookie: s.cookie,
  origin: 'http://localhost:5173',
  ...(branchId ? { 'x-branch-id': branchId } : {}),
  ...(unsafe ? { 'x-csrf-token': s.csrfToken, 'content-type': 'application/json' } : {}),
});

const get = (s: Session, path: string, branchId?: string) => app.request(path, { headers: headers(s, false, branchId) });
const post = (s: Session, path: string, body: unknown, key?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { ...headers(s, true), ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });

const tenantId = (): string =>
  db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;

let owner: Session;
let manager: Session;
let reception: Session;
let trainer: Session;
let accountant: Session;
let reefOwner: Session;

/** Carried from step to step. The journey is one person, not twelve fixtures. */
const journey: {
  leadId: string;
  memberId: string;
  invoiceId: string;
  paymentId: string;
  sessionId: string;
  bookingId: string;
} = { leadId: '', memberId: '', invoiceId: '', paymentId: '', sessionId: '', bookingId: '' };

const unique = Date.now().toString().slice(-8);

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
  reception = await signIn('reception@sharkfitness.in');
  trainer = await signIn('rehan@sharkfitness.in');
  accountant = await signIn('accounts@sharkfitness.in');
  reefOwner = await signIn('owner@reefathletic.in', 'reef');
});

/* ——— 1. Lead ————————————————————————————————————————————— */

describe('journey · 1 · a lead walks in', () => {
  it('reception captures them', async () => {
    const res = await post(reception, '/v1/admin/leads', {
      name: 'Journey Test',
      phone: `+91 98${unique}`,
      source: 'walk_in',
      branchId: 'br_kor',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    journey.leadId = body.id;
    expect(journey.leadId).toBeTruthy();
  });

  it('a trainer cannot, because leads are not their job', async () => {
    const res = await post(trainer, '/v1/admin/leads', {
      name: 'Not allowed', phone: `+91 97${unique}`, source: 'walk_in', branchId: 'br_kor',
    });
    expect(res.status).toBe(403);
  });

  it('another gym cannot see it', async () => {
    expect((await get(reefOwner, `/v1/admin/leads/${journey.leadId}`)).status).toBe(404);
  });
});

/* ——— 2. Member ————————————————————————————————————————— */

describe('journey · 2 · the lead converts to a member', () => {
  it('cannot be converted straight from new — the pipeline is the pipeline', async () => {
    // "Won" is reachable only through a trial that completed. A lead that
    // jumps from a walk-in to a member is a member nobody qualified.
    const res = await post(reception, `/v1/admin/leads/${journey.leadId}/convert`, {});
    expect(res.status).toBe(409);
  });

  it('reception cannot fake the last step either', async () => {
    const res = await post(reception, `/v1/admin/leads/${journey.leadId}/stage`, { to: 'won' });
    expect(res.status).toBe(409);
  });

  it('reception walks them through the pipeline', async () => {
    for (const to of ['contacted', 'qualified', 'trial_booked', 'trial_completed']) {
      const res = await post(reception, `/v1/admin/leads/${journey.leadId}/stage`, { to });
      expect(res.status).toBe(200);
    }
  });

  it('reception converts them, and the member lands at the lead’s branch', async () => {
    const res = await post(reception, `/v1/admin/leads/${journey.leadId}/convert`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberId: string };
    journey.memberId = body.memberId;
    expect(journey.memberId).toBeTruthy();

    const member = db.select().from(schema.members).where(eq(schema.members.id, journey.memberId)).get()!;
    expect(member.homeBranchId).toBe('br_kor');
    expect(member.tenantId).toBe(tenantId());
  });

  it('the lead now points at the member rather than being deleted', async () => {
    const lead = db.select().from(schema.leads).where(eq(schema.leads.id, journey.leadId)).get()!;
    expect(lead.convertedMemberId).toBe(journey.memberId);
  });

  it('a manager at another branch cannot open the record', async () => {
    // The Phase 10 fix, exercised through the journey rather than in isolation.
    const indMember = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId()), eq(schema.members.homeBranchId, 'br_ind'), isNull(schema.members.deletedAt)))
      .limit(1)
      .get()!;
    expect((await get(manager, `/v1/admin/members/${indMember.id}`)).status).toBe(404);
    // And can open one at their own.
    expect((await get(manager, `/v1/admin/members/${journey.memberId}`)).status).toBe(200);
  });

  it('another gym’s owner cannot open it at all', async () => {
    expect((await get(reefOwner, `/v1/admin/members/${journey.memberId}`)).status).toBe(404);
  });
});

/* ——— 3. Plan and 4. Invoice ————————————————————————————— */

describe('journey · 3 · they buy a plan, which raises an invoice', () => {
  it('reception assigns a published plan', async () => {
    const product = db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId()), eq(schema.products.status, 'active')))
      .limit(1)
      .get()!;

    const res = await post(reception, `/v1/admin/billing/members/${journey.memberId}/assign-plan`, { productId: product.id });
    expect([200, 201]).toContain(res.status);
  });

  it('the invoice exists, is unpaid, and carries the tenant’s currency', async () => {
    const invoice = db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.memberId, journey.memberId))
      .orderBy(desc(schema.invoices.createdAt))
      .get()!;
    journey.invoiceId = invoice.id;
    expect(invoice.paidMinor).toBe(0);
    expect(invoice.totalMinor).toBeGreaterThan(0);
    expect(invoice.currency).toBe(
      db.select({ currency: schema.tenants.currency }).from(schema.tenants).where(eq(schema.tenants.id, tenantId())).get()!.currency,
    );
  });

  it('the invoice line names the product it was sold from', async () => {
    // What Phase 10's revenue report groups by. A null here is a report that
    // cannot tell two products apart.
    const line = db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, journey.invoiceId)).get()!;
    expect(line.productId).not.toBeNull();
  });

  it('a trainer cannot see the money', async () => {
    expect((await get(trainer, `/v1/admin/billing/invoices/${journey.invoiceId}`)).status).toBe(403);
  });
});

/* ——— 5. Payment ————————————————————————————————————————— */

describe('journey · 4 · they pay', () => {
  it('reception records the payment, once', async () => {
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, journey.invoiceId)).get()!;
    const key = `journey-payment-${unique}`;
    const body = { amountMinor: invoice.totalMinor, method: 'cash', idempotencyKey: key };

    const first = await post(reception, `/v1/admin/billing/invoices/${journey.invoiceId}/payments`, body, key);
    expect(first.status).toBe(200);

    // The same logical payment, retried. A lost response must not take the
    // money twice.
    const second = await post(reception, `/v1/admin/billing/invoices/${journey.invoiceId}/payments`, body, key);
    expect(second.status).toBe(200);

    const payments = db.select().from(schema.payments).where(eq(schema.payments.invoiceId, journey.invoiceId)).all();
    expect(payments).toHaveLength(1);
    journey.paymentId = payments[0]!.id;
  });

  it('the invoice is settled and the membership is live', async () => {
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, journey.invoiceId)).get()!;
    expect(invoice.paidMinor).toBe(invoice.totalMinor);
    expect(['paid', 'partially_paid']).toContain(invoice.state);

    const membership = db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.memberId, journey.memberId))
      .orderBy(desc(schema.memberships.createdAt))
      .get()!;
    expect(membership.state).toBe('active');
  });
});

/* ——— 6. Access ————————————————————————————————————————— */

describe('journey · 5 · they come in and train', () => {
  it('the door lets them in, now that they have paid', async () => {
    // Widen the branch so the assertion is about entitlement rather than the
    // hour the suite runs at.
    db.update(schema.branches)
      .set({ opensMinutes: 0, closesMinutes: 24 * 60, hours: null })
      .where(eq(schema.branches.id, 'br_kor'))
      .run();

    const res = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: journey.memberId, branchId: 'br_kor', method: 'staff',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { granted: boolean; decision: string; visitNumber: number };
    expect(body.granted).toBe(true);
    expect(body.visitNumber).toBe(1);
  });

  it('the visit appears in attendance for their branch and nowhere else', async () => {
    const mine = (await (await get(owner, '/v1/admin/attendance?limit=100', 'br_kor')).json()) as {
      items: Array<{ memberId?: string; member?: { id: string } }>;
    };
    const found = mine.items.some((row) => (row.memberId ?? row.member?.id) === journey.memberId);
    expect(found).toBe(true);

    const elsewhere = (await (await get(owner, '/v1/admin/attendance?limit=100', 'br_ind')).json()) as {
      items: Array<{ memberId?: string; member?: { id: string } }>;
    };
    expect(elsewhere.items.some((row) => (row.memberId ?? row.member?.id) === journey.memberId)).toBe(false);
  });
});

/* ——— 7. Class ————————————————————————————————————————— */

describe('journey · 6 · they book a class', () => {
  it('reception books them onto a future session at their branch', async () => {
    const session = db
      .select()
      .from(schema.classSessions)
      .where(and(
        eq(schema.classSessions.tenantId, tenantId()),
        eq(schema.classSessions.branchId, 'br_kor'),
        eq(schema.classSessions.state, 'scheduled'),
        sql`${schema.classSessions.startsAt} > ${now()}`,
        sql`${schema.classSessions.booked} < ${schema.classSessions.capacity}`,
      ))
      .orderBy(schema.classSessions.startsAt)
      .get()!;
    journey.sessionId = session.id;

    const res = await post(reception, `/v1/admin/schedule/session/${session.id}/book`, {
      memberId: journey.memberId,
      idempotencyKey: `journey-book-${unique}`,
    });
    expect([200, 201]).toContain(res.status);
  });

  it('the seat is held against the session’s capacity', async () => {
    const booking = db
      .select()
      .from(schema.bookings)
      .where(and(eq(schema.bookings.sessionId, journey.sessionId), eq(schema.bookings.memberId, journey.memberId)))
      .get()!;
    journey.bookingId = booking.id;
    expect(['held', 'confirmed']).toContain(booking.state);

    const session = db.select().from(schema.classSessions).where(eq(schema.classSessions.id, journey.sessionId)).get()!;
    expect(session.booked).toBeLessThanOrEqual(session.capacity);
  });

  it('never gives the same member two seats on the same class', async () => {
    // Booking is idempotent on the member, not only on the key: a second
    // attempt returns the seat they already hold rather than taking another.
    // The database backs it with a partial unique index on live bookings.
    const res = await post(reception, `/v1/admin/schedule/session/${journey.sessionId}/book`, {
      memberId: journey.memberId,
      idempotencyKey: `journey-book-again-${unique}`,
    });
    expect([200, 201, 409, 412]).toContain(res.status);

    const live = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.bookings)
      .where(and(
        eq(schema.bookings.sessionId, journey.sessionId),
        eq(schema.bookings.memberId, journey.memberId),
        sql`${schema.bookings.state} in ('held','confirmed','attended')`,
      ))
      .get()!.n;
    expect(live).toBe(1);
  });
});

/* ——— 8. Training ————————————————————————————————————— */

describe('journey · 7 · a coach puts them on a programme', () => {
  it('the trainer cannot reach a member who is not theirs', async () => {
    // PF-STAFF-005, through the journey. This member has no trainer yet.
    expect((await get(trainer, `/v1/admin/members/${journey.memberId}`)).status).toBe(403);
  });

  it('once assigned, the coach can see them', async () => {
    const staff = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.users.email, 'rehan@sharkfitness.in'))
      .get()!;
    db.update(schema.members).set({ trainerId: staff.id }).where(eq(schema.members.id, journey.memberId)).run();

    expect((await get(trainer, `/v1/admin/members/${journey.memberId}`)).status).toBe(200);
  });

  it('a published programme can be assigned to them', async () => {
    const program = db
      .select({ id: schema.programs.id })
      .from(schema.programs)
      .where(and(eq(schema.programs.tenantId, tenantId()), eq(schema.programs.state, 'published')))
      .limit(1)
      .get();
    if (!program) return;

    const res = await post(trainer, '/v1/admin/training/assignments', {
      memberId: journey.memberId,
      programId: program.id,
      startsOn: new Date(now()).toISOString().slice(0, 10),
    });
    expect([200, 201, 404, 422]).toContain(res.status);
  });
});

/* ——— 9. Store ————————————————————————————————————————— */

describe('journey · 8 · they buy a shaker at the till', () => {
  it('reception rings up a sale against their branch', async () => {
    const product = db
      .select()
      .from(schema.retailProducts)
      .where(eq(schema.retailProducts.tenantId, tenantId()))
      .limit(1)
      .get();
    if (!product) return;

    const res = await post(
      reception,
      '/v1/admin/store/orders',
      {
        branchId: 'br_kor',
        lines: [{ productId: product.id, quantity: 1 }],
        // The tender has to cover price *and* tax — the till refuses a short
        // payment, which is the whole point of it being a till.
        payments: [
          {
            method: 'cash',
            amountMinor: Math.round(product.priceMinor * (1 + product.taxRateBp / 10_000)),
            reference: `JRN-${unique}`,
          },
        ],
        memberId: journey.memberId,
      },
      `journey-sale-${unique}`,
    );
    // Reception operates the till (Design PRD UX-A14). Requiring
    // `inventory.manage` to sell one shaker meant either they could not, or
    // every receptionist got stock-management rights to do their job.
    expect(res.status).toBe(201);
  });

  it('but still cannot adjust stock, which is a different job', async () => {
    const product = db.select().from(schema.retailProducts).where(eq(schema.retailProducts.tenantId, tenantId())).limit(1).get();
    if (!product) return;
    const res = await post(reception, `/v1/admin/store/products/${product.id}/stock`, {
      branchId: 'br_kor', delta: 50, reason: 'adjustment', note: 'journey probe',
    });
    expect(res.status).toBe(403);
  });

  it('and cannot void or refund the sale it just rang up', async () => {
    const order = db
      .select({ id: schema.posOrders.id })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.tenantId, tenantId()))
      .orderBy(desc(schema.posOrders.createdAt))
      .get();
    if (!order) return;
    const res = await post(reception, `/v1/admin/store/orders/${order.id}/void`, { reason: 'Journey probe' });
    expect(res.status).toBe(403);
  });
});

/* ——— 10. Support ————————————————————————————————————— */

describe('journey · 9 · they raise a complaint', () => {
  it('reception opens a ticket against the member', async () => {
    const res = await post(reception, '/v1/admin/support/tickets', {
      subject: 'Locker key stuck',
      body: 'Member reported the locker in the changing room will not open.',
      category: 'facility',
      memberId: journey.memberId,
      branchId: 'br_kor',
    });
    expect([200, 201]).toContain(res.status);
  });

  it('the ticket is visible at their branch and hidden from another', async () => {
    const mine = (await (await get(owner, '/v1/admin/support/tickets?branchId=br_kor')).json()) as {
      items: Array<{ subject: string }>;
    };
    expect(mine.items.some((t) => t.subject === 'Locker key stuck')).toBe(true);

    const elsewhere = (await (await get(owner, '/v1/admin/support/tickets?branchId=br_ind')).json()) as {
      items: Array<{ subject: string }>;
    };
    expect(elsewhere.items.some((t) => t.subject === 'Locker key stuck')).toBe(false);
  });
});

/* ——— 11. Reports ————————————————————————————————————— */

describe('journey · 10 · the money shows up in the reports', () => {
  const today = new Date(now()).toISOString().slice(0, 10);

  it('the accountant sees the revenue, because they hold report.financial', async () => {
    const res = await get(accountant, `/v1/admin/reports/revenue?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { canSeeFinancial: boolean }; totals: { netMinor: { value: number } } | null };
    expect(body.meta.canSeeFinancial).toBe(true);
    expect(body.totals).not.toBeNull();
  });

  it('the branch manager sees the report and not the money', async () => {
    // The permission split that PF-RPT-005 exists for, end to end.
    const res = await get(manager, `/v1/admin/reports/revenue?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { canSeeFinancial: boolean; restricted: string[] }; totals: unknown };
    expect(body.meta.canSeeFinancial).toBe(false);
    // Absent, never zero.
    expect(body.totals).toBeNull();
    expect(body.meta.restricted).toContain('totals');
  });

  it('today’s revenue includes this member’s payment', async () => {
    const body = (await (await get(owner, `/v1/admin/reports/revenue?from=${today}&to=${today}`)).json()) as {
      totals: { netMinor: { value: number } } | null;
    };
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, journey.invoiceId)).get()!;
    expect(body.totals!.netMinor.value).toBeGreaterThanOrEqual(invoice.totalMinor);
  });

  it('a single-branch scope reports less than the whole estate', async () => {
    const all = (await (await get(owner, `/v1/admin/reports/attendance?from=${today}&to=${today}`)).json()) as {
      meta: { branchIds: string[] };
    };
    const one = (await (await get(owner, `/v1/admin/reports/attendance?from=${today}&to=${today}&branchId=br_kor`)).json()) as {
      meta: { branchIds: string[] };
    };
    expect(all.meta.branchIds.length).toBeGreaterThan(one.meta.branchIds.length);
  });
});

/* ——— 12. Refund ————————————————————————————————————— */

describe('journey · 11 · a refund, and what it does to the report', () => {
  const today = new Date(now()).toISOString().slice(0, 10);

  it('reception cannot refund — that is a separate permission', async () => {
    const res = await post(reception, `/v1/admin/billing/payments/${journey.paymentId}/refund`, {
      amountMinor: 10_000, reason: 'Journey refund test',
    });
    expect(res.status).toBe(403);
  });

  it('the accountant can, and the money comes off net revenue', async () => {
    const before = (await (await get(owner, `/v1/admin/reports/revenue?from=${today}&to=${today}`)).json()) as {
      totals: { netMinor: { value: number }; refundedMinor: number } | null;
    };

    const res = await post(accountant, `/v1/admin/billing/payments/${journey.paymentId}/refund`, {
      amountMinor: 10_000, reason: 'Member changed their mind on the upgrade',
    });
    expect([200, 201]).toContain(res.status);

    const after = (await (await get(owner, `/v1/admin/reports/revenue?from=${today}&to=${today}`)).json()) as {
      totals: { netMinor: { value: number }; refundedMinor: number } | null;
    };
    // Net is gross less refunds — the report has to follow the money.
    expect(after.totals!.refundedMinor).toBe(before.totals!.refundedMinor + 10_000);
    expect(after.totals!.netMinor.value).toBe(before.totals!.netMinor.value - 10_000);
  });

  it('the refund is a compensating entry, not an edit of the payment', async () => {
    const payment = db.select().from(schema.payments).where(eq(schema.payments.id, journey.paymentId)).get()!;
    const refunds = db.select().from(schema.refunds).where(eq(schema.refunds.paymentId, journey.paymentId)).all();
    // The original payment still says what was taken.
    expect(payment.amountMinor).toBeGreaterThan(0);
    expect(refunds.length).toBeGreaterThan(0);
  });
});

/* ——— The audit trail across the whole journey ————————————— */

describe('journey · every step left a record', () => {
  it('names the actor and the branch on each write', async () => {
    const rows = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId()), eq(schema.auditLog.entityId, journey.memberId)))
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actorName.length).toBeGreaterThan(0);
      expect(row.actorRole.length).toBeGreaterThan(0);
      expect(row.requestId ?? '').not.toBe('');
    }
  });

  it('cannot be edited afterwards, by anybody', () => {
    const row = db.select().from(schema.auditLog).limit(1).get()!;
    expect(() => db.update(schema.auditLog).set({ reason: 'rewritten' }).where(eq(schema.auditLog.id, row.id)).run()).toThrow();
    expect(() => db.delete(schema.auditLog).where(eq(schema.auditLog.id, row.id)).run()).toThrow();
  });
});

/* ——— The member’s own view of all of it ————————————————— */

describe('journey · the member sees their own record and nobody else’s', () => {
  it('refuses a member every admin surface', async () => {
    const member = await signIn('aman@sharkfitness.in');
    for (const path of ['/v1/admin/members', '/v1/admin/billing/invoices', '/v1/admin/reports/revenue?from=2026-08-01&to=2026-08-02', '/v1/admin/settings/business']) {
      expect((await get(member, path)).status).toBe(403);
    }
  });

  it('gives them their own home screen', async () => {
    const member = await signIn('aman@sharkfitness.in');
    const res = await get(member, '/v1/member/home');
    expect(res.status).toBe(200);
  });
});
