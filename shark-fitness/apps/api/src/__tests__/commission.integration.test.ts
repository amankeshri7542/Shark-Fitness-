import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { isoDate, now } from '../lib/time.js';
import { commissionAmount, resolveRate } from '../services/commission.js';

/* ============================================================================
   Staff commission (PF-STAFF).

   `commission_rates` and `commission_lines` existed and nothing outside the
   seed read or wrote them — the shape of a commission system with no
   commission system in it.

   What these tests hold to:

   - money stays in integer minor units and the total equals the sum of rows;
   - commission accrues on money *collected*, never on money invoiced;
   - tax is not commissionable;
   - re-running a period accrues nothing twice;
   - a correction is a compensating entry, never an edit;
   - reading and approving are different permissions;
   - a line at another branch is not visible and not approvable;
   - nothing claims a payment provider settled anything.
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

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const OWNER = 'owner@sharkfitness.in';
const TZ = 'Asia/Kolkata';

/** A period far enough in the past that the seed put nothing in it, so this
 *  suite's arithmetic is only ever about its own rows. */
const PERIOD_START = '2019-03-01';
const PERIOD_END = '2019-03-31';
const SALE_AT = Date.parse('2019-03-15T10:00:00+05:30');

let receptionStaffId = '';
const createdOrderIds: string[] = [];

beforeAll(() => {
  receptionStaffId = db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(eq(schema.users.email, 'reception@sharkfitness.in'))
    .get()!.id;
});

afterAll(() => {
  db.delete(schema.commissionLines)
    .where(
      and(
        eq(schema.commissionLines.tenantId, 'ten_shark'),
        eq(schema.commissionLines.periodStart, PERIOD_START),
      ),
    )
    .run();
  if (createdOrderIds.length > 0) {
    db.delete(schema.posOrders).where(inArray(schema.posOrders.id, createdOrderIds)).run();
  }
});

/** A POS sale this suite owns. Figures chosen so tax is clearly separable:
 *  ₹1,000 net, ₹180 tax, ₹1,180 gross. Commission must be on the ₹1,000. */
function makeSale(
  staffId: string | null,
  branchId: string,
  options: { subtotalMinor?: number; discountMinor?: number; kind?: string; at?: number } = {},
): string {
  const orderId = id('pos');
  const subtotalMinor = options.subtotalMinor ?? 100_000;
  const discountMinor = options.discountMinor ?? 0;
  const taxMinor = Math.round((subtotalMinor - discountMinor) * 0.18);
  db.insert(schema.posOrders)
    .values({
      id: orderId,
      tenantId: 'ten_shark',
      branchId,
      reference: `T-${orderId.slice(-6)}`,
      memberId: null,
      subtotalMinor,
      discountMinor,
      taxMinor,
      totalMinor: subtotalMinor - discountMinor + taxMinor,
      state: 'paid',
      kind: options.kind ?? 'sale',
      returnOfOrderId: null,
      voidReason: null,
      voidedAt: null,
      staffId,
      staffName: 'Test Seller',
      invoiceId: null,
      createdAt: options.at ?? SALE_AT,
    })
    .run();
  createdOrderIds.push(orderId);
  return orderId;
}

async function calculate(session: Session, branchId?: string) {
  const response = await app.request('/v1/admin/staff/commission/calculate', {
    method: 'POST',
    headers: headers(session, true),
    body: JSON.stringify({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      ...(branchId ? { branchId } : {}),
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function linesFor(refId: string) {
  return db
    .select()
    .from(schema.commissionLines)
    .where(eq(schema.commissionLines.refId, refId))
    .all();
}

describe('commission arithmetic', () => {
  it('keeps money in integer minor units and rounds once, at the end', () => {
    // 5% of ₹1,000.00 is exactly ₹50.00.
    expect(commissionAmount(100_000, 5)).toBe(5_000);
    // A rate that does not divide evenly rounds half-up to a whole paisa and
    // never leaves a fraction on the row.
    expect(commissionAmount(33_333, 12.5)).toBe(4_167);
    expect(Number.isInteger(commissionAmount(33_333, 12.5))).toBe(true);
    // A negative basis (a return) yields a negative commission of the same
    // magnitude, so a sale and its reversal cancel exactly.
    expect(commissionAmount(-100_000, 5)).toBe(-5_000);
    expect(commissionAmount(100_000, 5) + commissionAmount(-100_000, 5)).toBe(0);
  });

  it('prefers a negotiated per-staff rate over the tenant table', () => {
    const trainer = db
      .select()
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.users.email, 'rehan@sharkfitness.in'))
      .get()!.staff;

    // The seed gives trainers their own `package` rule at 12%.
    const own = resolveRate('ten_shark', trainer, 'package', '2026-06-01')!;
    expect(own.source).toBe('staff');
    expect(own.ruleVersion).toBe(`staff:${trainer.id}`);

    // With no per-staff rule the tenant table answers, and names its version.
    const tenant = resolveRate('ten_shark', { id: 'stf_none', commissionRules: [] }, 'sale', '2026-06-01')!;
    expect(tenant.source).toBe('tenant');
    expect(tenant.ratePct).toBe(5);
    expect(tenant.ruleVersion).toBe('v2');
  });

  it('does not pick up a rate introduced after the period it is calculating', () => {
    // Every seeded rate is effective 2026-01-01; a 2019 period predates them.
    expect(resolveRate('ten_shark', { id: 'stf_none', commissionRules: [] }, 'sale', '2019-03-15')).toBeNull();
  });
});

describe('accruing a run', () => {
  it('commissions the net of a sale, never the tax', async () => {
    const owner = await signIn(OWNER);
    // Reception's seeded rule is `sale` at 5%.
    const orderId = makeSale(receptionStaffId, 'br_kor', { subtotalMinor: 100_000 });

    const { status } = await calculate(owner);
    expect(status).toBe(201);

    const lines = linesFor(orderId);
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    // ₹1,000 net, not ₹1,180 gross.
    expect(line.basisMinor).toBe(100_000);
    expect(line.amountMinor).toBe(5_000);
    expect(line.state).toBe('pending');
    expect(line.branchId).toBe('br_kor');
  });

  it('excludes discount from the basis', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor', { subtotalMinor: 100_000, discountMinor: 20_000 });

    await calculate(owner);
    const line = linesFor(orderId)[0]!;
    expect(line.basisMinor).toBe(80_000);
    expect(line.amountMinor).toBe(4_000);
  });

  it('accrues nothing twice, however many times the run is repeated', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor');

    const first = await calculate(owner);
    expect((first.body as { created: number }).created).toBeGreaterThan(0);
    expect(linesFor(orderId).length).toBe(1);

    const second = await calculate(owner);
    expect((second.body as { created: number }).created).toBe(0);
    expect((second.body as { alreadyAccrued: number }).alreadyAccrued).toBeGreaterThan(0);
    expect(linesFor(orderId).length).toBe(1);

    // And the database is what actually holds it, not the service's check.
    const line = linesFor(orderId)[0]!;
    expect(() =>
      db.insert(schema.commissionLines).values({ ...line, id: id('cml') }).run(),
    ).toThrow(/UNIQUE|constraint/i);
  });

  it('ignores a voided order and a sale with nobody attributed', async () => {
    const owner = await signIn(OWNER);
    const voided = makeSale(receptionStaffId, 'br_kor');
    db.update(schema.posOrders).set({ state: 'voided' }).where(eq(schema.posOrders.id, voided)).run();
    const unattributed = makeSale(null, 'br_kor');

    await calculate(owner);
    expect(linesFor(voided)).toEqual([]);
    expect(linesFor(unattributed)).toEqual([]);
  });

  it('reports eligible money that no rule covers rather than silently dropping it', async () => {
    const owner = await signIn(OWNER);
    // The owner has no `sale` rule and no tenant rate applies in 2019.
    const ownerStaffId = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.users.email, OWNER))
      .get()!.id;
    const orderId = makeSale(ownerStaffId, 'br_kor');

    const { body } = await calculate(owner);
    const noRate = body.noRate as Array<{ staffId: string; basisMinor: number }>;
    expect(noRate.some((row) => row.staffId === ownerStaffId)).toBe(true);
    expect(linesFor(orderId)).toEqual([]);
  });

  it('never claims a payment provider settled anything', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor');
    await calculate(owner);

    const evidence = linesFor(orderId)[0]!.evidence.join(' ');
    expect(evidence).toMatch(/pos_order:/);
    expect(evidence).not.toMatch(/razorpay|stripe|cashfree|settled|captured/i);

    const report = await app.request(
      `/v1/admin/staff/commission?periodStart=${PERIOD_START}&periodEnd=${PERIOD_END}`,
      { headers: headers(owner) },
    );
    const body = (await report.json()) as { settlementNote: string };
    expect(body.settlementNote).toMatch(/no money moves here/i);
  });
});

describe('approval is a different permission from viewing', () => {
  it('lets a viewer read the figures and refuses to let them approve', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor');
    await calculate(owner);
    const lineId = linesFor(orderId)[0]!.id;

    // A regional manager holds `staff.commission` and not
    // `staff.commission.approve`. There is no seeded one, so build it.
    const viewerUser = id('usr');
    db.insert(schema.users)
      .values({
        id: viewerUser,
        tenantId: 'ten_shark',
        email: `${viewerUser}@commission.test`,
        phone: null,
        name: 'Regional Viewer',
        initials: 'RV',
        role: 'regional_manager',
        accountState: 'active',
        passwordHash: null,
        preferences: {},
        lastSeenAt: null,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      })
      .run();
    const { createSession } = await import('../services/auth.js');
    const session = createSession(viewerUser, 'ten_shark', '192.0.2.90', 'commission-test');
    const bearer = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };

    try {
      const read = await app.request(
        `/v1/admin/staff/commission?periodStart=${PERIOD_START}&periodEnd=${PERIOD_END}`,
        { headers: bearer },
      );
      expect(read.status).toBe(200);
      expect((await read.json()) as { totals: { pendingMinor: number } }).toHaveProperty('totals');

      const approve = await app.request('/v1/admin/staff/commission/approve', {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ lineIds: [lineId] }),
      });
      expect(approve.status).toBe(403);
      expect(db.select().from(schema.commissionLines).where(eq(schema.commissionLines.id, lineId)).get()!.state)
        .toBe('pending');

      const paid = await app.request('/v1/admin/staff/commission/paid', {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ lineIds: [lineId], reference: 'PAYROLL-2019-03' }),
      });
      expect(paid.status).toBe(403);
    } finally {
      db.delete(schema.sessions).where(eq(schema.sessions.userId, viewerUser)).run();
      db.delete(schema.users).where(eq(schema.users.id, viewerUser)).run();
    }
  });

  it('walks pending to approved to paid, and refuses to skip approval', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor');
    await calculate(owner);
    const lineId = linesFor(orderId)[0]!.id;

    // Paid before approved is refused.
    const early = await app.request('/v1/admin/staff/commission/paid', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ lineIds: [lineId], reference: 'PAYROLL-2019-03' }),
    });
    // A precondition failure, not a validation one: the request was well
    // formed and the line was simply not approved yet.
    expect(early.status).toBe(412);

    const approve = await app.request('/v1/admin/staff/commission/approve', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ lineIds: [lineId] }),
    });
    expect(approve.status).toBe(200);

    const paid = await app.request('/v1/admin/staff/commission/paid', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ lineIds: [lineId], reference: 'PAYROLL-2019-03' }),
    });
    expect(paid.status).toBe(200);

    const line = db.select().from(schema.commissionLines).where(eq(schema.commissionLines.id, lineId)).get()!;
    expect(line.state).toBe('paid');
    expect(line.approvedByUserId).toBeTruthy();
    expect(line.paidReference).toBe('PAYROLL-2019-03');

    // Both decisions are on the audit trail.
    const actions = db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, lineId))
      .all()
      .map((row) => row.action);
    expect(actions).toContain('commission.approved');
    expect(actions).toContain('commission.paid');
  });

  it('requires a payroll reference, because marking paid records an external settlement', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor');
    await calculate(owner);
    const lineId = linesFor(orderId)[0]!.id;
    await app.request('/v1/admin/staff/commission/approve', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ lineIds: [lineId] }),
    });

    const response = await app.request('/v1/admin/staff/commission/paid', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ lineIds: [lineId], reference: '' }),
    });
    expect(response.status).toBe(422);
  });
});

describe('corrections', () => {
  it('reverses with a compensating entry and leaves the original untouched', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor', { subtotalMinor: 200_000 });
    await calculate(owner);
    const original = linesFor(orderId)[0]!;
    expect(original.amountMinor).toBe(10_000);

    const response = await app.request(`/v1/admin/staff/commission/${original.id}/correct`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Customer returned the goods.' }),
    });
    expect(response.status).toBe(201);
    const { correctionId } = (await response.json()) as { correctionId: string };

    // The original still says exactly what it always said.
    const after = db
      .select()
      .from(schema.commissionLines)
      .where(eq(schema.commissionLines.id, original.id))
      .get()!;
    expect(after.amountMinor).toBe(original.amountMinor);
    expect(after.basisMinor).toBe(original.basisMinor);
    expect(after.ratePct).toBe(original.ratePct);
    expect(after.state).toBe('reversed');

    const correction = db
      .select()
      .from(schema.commissionLines)
      .where(eq(schema.commissionLines.id, correctionId))
      .get()!;
    expect(correction.amountMinor).toBe(-10_000);
    expect(correction.correctionOfLineId).toBe(original.id);
    expect(correction.correctionReason).toMatch(/returned/i);
    // A correction is settled through the same approval as anything else.
    expect(correction.state).toBe('pending');

    // The pair nets to nothing.
    expect(after.amountMinor + correction.amountMinor).toBe(0);
  });

  it('claws back a paid line without pretending it was never paid', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor', { subtotalMinor: 300_000 });
    await calculate(owner);
    const original = linesFor(orderId)[0]!;

    await app.request('/v1/admin/staff/commission/approve', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ lineIds: [original.id] }),
    });
    await app.request('/v1/admin/staff/commission/paid', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ lineIds: [original.id], reference: 'PAYROLL-2019-03' }),
    });

    const response = await app.request(`/v1/admin/staff/commission/${original.id}/correct`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Rated against the wrong rule.' }),
    });
    expect(response.status).toBe(201);

    const after = db
      .select()
      .from(schema.commissionLines)
      .where(eq(schema.commissionLines.id, original.id))
      .get()!;
    // Still carries the evidence it was paid, and under which payroll run.
    expect(after.paidAt).toBeTruthy();
    expect(after.paidReference).toBe('PAYROLL-2019-03');
  });

  it('refuses a partial correction larger than the line, and a correction of a correction', async () => {
    const owner = await signIn(OWNER);
    const orderId = makeSale(receptionStaffId, 'br_kor', { subtotalMinor: 100_000 });
    await calculate(owner);
    const original = linesFor(orderId)[0]!;

    const tooBig = await app.request(`/v1/admin/staff/commission/${original.id}/correct`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Trying to overshoot.', amountMinor: 9_999_999 }),
    });
    expect(tooBig.status).toBe(422);

    const partial = await app.request(`/v1/admin/staff/commission/${original.id}/correct`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Half of it was returned.', amountMinor: 2_500 }),
    });
    expect(partial.status).toBe(201);
    const { correctionId } = (await partial.json()) as { correctionId: string };

    // A partial correction leaves the original standing, not reversed.
    expect(
      db.select().from(schema.commissionLines).where(eq(schema.commissionLines.id, original.id)).get()!.state,
    ).not.toBe('reversed');

    const chained = await app.request(`/v1/admin/staff/commission/${correctionId}/correct`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Correcting the correction.' }),
    });
    expect(chained.status).toBe(422);
  });
});

describe('commission is branch scoped', () => {
  it('hides a line earned at a branch the caller cannot see', async () => {
    const owner = await signIn(OWNER);
    const manager = await signIn('manager@sharkfitness.in');
    const orderId = makeSale(receptionStaffId, 'br_ind');
    await calculate(owner);

    const line = linesFor(orderId)[0];
    // Reception's rule covers `sale`, so this must have produced a line.
    expect(line).toBeTruthy();
    expect(line!.branchId).toBe('br_ind');

    // Also earn something at the branch the viewer *can* see, so the test
    // distinguishes "scoped correctly" from "returned nothing".
    const korOrder = makeSale(receptionStaffId, 'br_kor', { subtotalMinor: 400_000 });
    await calculate(owner);
    const korLine = linesFor(korOrder)[0]!;

    // A branch manager holds no `staff.commission` at all, so the read is
    // refused on the permission before scope is ever consulted.
    const read = await app.request(
      `/v1/admin/staff/commission?periodStart=${PERIOD_START}&periodEnd=${PERIOD_END}`,
      { headers: headers(manager) },
    );
    expect(read.status).toBe(403);

    // The real scope test needs somebody who may read commission *and* holds
    // one branch. A user with no staff record is granted every branch in the
    // tenant, so this one gets a staff record pinned to br_kor — otherwise
    // "one branch" and "all branches" produce identical results and the test
    // asserts nothing.
    const viewerUser = id('usr');
    const viewerStaff = id('stf');
    db.insert(schema.users)
      .values({
        id: viewerUser,
        tenantId: 'ten_shark',
        email: `${viewerUser}@commission.test`,
        phone: null,
        name: 'Koramangala Regional',
        initials: 'KR',
        role: 'regional_manager',
        accountState: 'active',
        passwordHash: null,
        preferences: {},
        lastSeenAt: null,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      })
      .run();
    db.insert(schema.staff)
      .values({
        id: viewerStaff,
        tenantId: 'ten_shark',
        userId: viewerUser,
        employmentStatus: 'active',
        branchIds: ['br_kor'],
        specialties: [],
        certifications: [],
        commissionRules: [],
        hourlyRateMinor: null,
        joinedOn: '2026-01-01',
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    const { createSession } = await import('../services/auth.js');
    const viewerSession = createSession(viewerUser, 'ten_shark', '192.0.2.91', 'commission-scope');
    const bearer = { authorization: `Bearer ${viewerSession.token}` };

    try {
      const scoped = await app.request(
        `/v1/admin/staff/commission?periodStart=${PERIOD_START}&periodEnd=${PERIOD_END}`,
        { headers: bearer },
      );
      expect(scoped.status).toBe(200);
      const scopedIds = ((await scoped.json()) as {
        staff: Array<{ lines: Array<{ id: string }> }>;
      }).staff.flatMap((entry) => entry.lines).map((row) => row.id);

      // Sees their own branch's earnings, and not Indiranagar's.
      expect(scopedIds).toContain(korLine.id);
      expect(scopedIds).not.toContain(line!.id);

      // And cannot reach the other branch by naming it.
      const reachOver = await app.request(
        `/v1/admin/staff/commission?periodStart=${PERIOD_START}&periodEnd=${PERIOD_END}&branchId=br_ind`,
        { headers: bearer },
      );
      expect(reachOver.status).toBe(404);
    } finally {
      db.delete(schema.sessions).where(eq(schema.sessions.userId, viewerUser)).run();
      db.delete(schema.staff).where(eq(schema.staff.id, viewerStaff)).run();
      db.delete(schema.users).where(eq(schema.users.id, viewerUser)).run();
    }

    // The owner holds every branch and sees both.
    const ownerRead = await app.request(
      `/v1/admin/staff/commission?periodStart=${PERIOD_START}&periodEnd=${PERIOD_END}`,
      { headers: headers(owner) },
    );
    expect(ownerRead.status).toBe(200);
    const ownerIds = ((await ownerRead.json()) as {
      staff: Array<{ lines: Array<{ id: string }> }>;
    }).staff.flatMap((entry) => entry.lines).map((row) => row.id);
    expect(ownerIds).toContain(line!.id);
    expect(ownerIds).toContain(korLine.id);
  });

  it('refuses a calculation scoped to a branch outside the caller’s reach', async () => {
    const owner = await signIn(OWNER);
    const response = await app.request('/v1/admin/staff/commission/calculate', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ periodStart: PERIOD_START, periodEnd: PERIOD_END, branchId: 'br_not_ours' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('the run and the report agree', () => {
  it('reports a total equal to the sum of its own rows', async () => {
    const owner = await signIn(OWNER);
    makeSale(receptionStaffId, 'br_kor', { subtotalMinor: 123_457 });
    makeSale(receptionStaffId, 'br_kor', { subtotalMinor: 76_543 });
    await calculate(owner);

    const response = await app.request(
      `/v1/admin/staff/commission?periodStart=${PERIOD_START}&periodEnd=${PERIOD_END}&staffId=${receptionStaffId}`,
      { headers: headers(owner) },
    );
    const body = (await response.json()) as {
      staff: Array<{ staffId: string; totalMinor: number; lines: Array<{ amountMinor: number; state: string }> }>;
    };
    const entry = body.staff.find((row) => row.staffId === receptionStaffId)!;

    const summed = entry.lines
      .filter((line) => line.state !== 'reversed')
      .reduce((total, line) => total + line.amountMinor, 0);
    expect(entry.totalMinor).toBe(summed);
    expect(Number.isInteger(entry.totalMinor)).toBe(true);
  });

  it('dates a line by the branch’s calendar, not the server’s', async () => {
    const owner = await signIn(OWNER);
    // 23:30 in Bengaluru on the last day of the period is 18:00 UTC the same
    // day — but a sale at 00:30 IST on the 1st is 19:00 UTC on the previous
    // day, and dating by UTC would push it out of the period entirely.
    const edge = Date.parse('2019-03-01T00:30:00+05:30');
    const orderId = makeSale(receptionStaffId, 'br_kor', { at: edge });
    expect(isoDate(edge, TZ)).toBe('2019-03-01');

    await calculate(owner);
    expect(linesFor(orderId).length).toBe(1);
  });
});
