import { beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { isoDate, now, startOfLocalDay } from '../lib/time.js';

/* ============================================================================
   Phase 10 — Reports and analytics (PF-RPT-001…006).

   A report is read once and acted on for a month, so the failures worth
   testing are the quiet ones: a figure that is confidently wrong, a total that
   silently covers one branch of three, a withheld number rendered as zero, a
   comparison invented against a period that never existed.
   ========================================================================= */

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
const post = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: headers(session, true), body: JSON.stringify(body) });

const tenantId = (): string =>
  db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;

const branches = (): Array<{ id: string; name: string; timezone: string }> =>
  db
    .select({ id: schema.branches.id, name: schema.branches.name, timezone: schema.branches.timezone })
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, tenantId()))
    .all();

/** Owner holds every report permission; branch manager holds view but not financial. */
let owner: Session;
let manager: Session;
let trainer: Session;
let tz: string;
let today: string;

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
  trainer = await signIn('rehan@sharkfitness.in');
  tz = branches()[0]!.timezone;
  today = isoDate(now(), tz);
});

const range = (from: string, to: string): string => `from=${from}&to=${to}`;

/* ——— Permissions ————————————————————————————————————————— */

describe('PF-RPT-005 — report.view and report.financial are separate', () => {
  it('lets the owner see revenue', async () => {
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2026-06-01', '2026-08-18')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { grossMinor: { value: number } } | null; meta: { canSeeFinancial: boolean } };
    expect(body.meta.canSeeFinancial).toBe(true);
    expect(body.totals).not.toBeNull();
    expect(body.totals!.grossMinor.value).toBeGreaterThan(0);
  });

  it('opens Reports for a role with report.view and no report.financial', async () => {
    // The whole point of two permissions: a branch manager works the
    // operational reports and is refused only the money.
    const res = await get(manager, `/v1/admin/reports/attendance?${range('2026-06-01', '2026-08-18')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { visits: { value: number } };
    expect(body.visits.value).toBeGreaterThan(0);
  });

  it('withholds revenue as absent rather than as zero', async () => {
    const res = await get(manager, `/v1/admin/reports/revenue?${range('2026-06-01', '2026-08-18')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: unknown;
      byCurrency: unknown[];
      meta: { restricted: string[]; canSeeFinancial: boolean };
    };
    // Null, never 0. A zero renders as a real figure and "revenue this month:
    // ₹0" is something a person escalates.
    expect(body.totals).toBeNull();
    expect(body.byCurrency).toEqual([]);
    expect(body.meta.canSeeFinancial).toBe(false);
    expect(body.meta.restricted).toContain('totals');
  });

  it('withholds lifetime value from membership but still reports the joins', async () => {
    const res = await get(manager, `/v1/admin/reports/membership?${range('2026-06-01', '2026-08-18')}`);
    const body = (await res.json()) as { ltvMinor: number | null; joins: { value: number }; meta: { restricted: string[] } };
    expect(body.ltvMinor).toBeNull();
    expect(body.meta.restricted).toContain('ltvMinor');
    // Operational figures are untouched by the financial gate.
    expect(typeof body.joins.value).toBe('number');
  });

  it('gives the owner a lifetime value figure', async () => {
    const res = await get(owner, `/v1/admin/reports/membership?${range('2026-06-01', '2026-08-18')}`);
    const body = (await res.json()) as { ltvMinor: number | null };
    expect(body.ltvMinor).not.toBeNull();
  });

  it('refuses Reports entirely to a role without report.view', async () => {
    // A trainer has no reporting permission at all — not a blank report, a
    // refusal.
    const res = await get(trainer, `/v1/admin/reports/attendance?${range('2026-06-01', '2026-08-18')}`);
    expect(res.status).toBe(403);
  });
});

/* ——— Comparison periods ————————————————————————————————— */

describe('PF-RPT edge case — a range with no prior comparison period', () => {
  it('reports no comparison rather than a fall from zero', async () => {
    // 2019 predates every row in this tenant, so there is nothing behind it.
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2019-01-01', '2019-01-31')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: { comparison: unknown };
      totals: { grossMinor: { previous: number | null; changeBp: number | null } } | null;
    };
    expect(body.meta.comparison).toBeNull();
    expect(body.totals!.grossMinor.previous).toBeNull();
    // "Down 100%" about a month the gym did not exist in is a fabrication.
    expect(body.totals!.grossMinor.changeBp).toBeNull();
  });

  it('offers a comparison when there is history behind the range', async () => {
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2026-08-01', '2026-08-18')}`);
    const body = (await res.json()) as { meta: { comparison: { from: string; to: string } | null } };
    expect(body.meta.comparison).not.toBeNull();
    // Immediately before, equal length.
    expect(body.meta.comparison).toEqual({ from: '2026-07-14', to: '2026-07-31', days: 18, label: '2026-07-14 to 2026-07-31' });
  });
});

/* ——— Branch scope ————————————————————————————————————————— */

describe('PF-MBR — a user scoped to some branches sees only those', () => {
  it('covers every branch the caller may see when none is named', async () => {
    const res = await get(owner, `/v1/admin/reports/attendance?${range('2026-06-01', '2026-08-18')}`);
    const body = (await res.json()) as { meta: { branchIds: string[] } };
    // Not `activeBranchId`. Scoping an unfiltered read to the session default
    // is what made "all branches" a lie in Support before Phase 9.
    expect(body.meta.branchIds).toHaveLength(branches().length);
  });

  it('narrows to one branch on request, and says so', async () => {
    const one = branches()[0]!;
    const res = await get(owner, `/v1/admin/reports/attendance?${range('2026-06-01', '2026-08-18')}&branchId=${one.id}`);
    const body = (await res.json()) as { meta: { branchIds: string[]; scopeNote: string } };
    expect(body.meta.branchIds).toEqual([one.id]);
    expect(body.meta.scopeNote).toContain(one.name);
  });

  it('refuses a branch the caller does not hold', async () => {
    const all = branches();
    const managerScope = (await (await get(manager, `/v1/admin/reports/attendance?${range('2026-08-01', '2026-08-18')}`)).json()) as {
      meta: { branchIds: string[] };
    };
    const outside = all.find((b) => !managerScope.meta.branchIds.includes(b.id));
    if (!outside) return; // manager already covers every branch in this seed
    const res = await get(manager, `/v1/admin/reports/attendance?${range('2026-08-01', '2026-08-18')}&branchId=${outside.id}`);
    expect(res.status).toBe(403);
  });

  it('never reports more than the sum of the branches in scope', async () => {
    const all = branches();
    const whole = (await (await get(owner, `/v1/admin/reports/attendance?${range('2026-06-01', '2026-08-18')}`)).json()) as {
      visits: { value: number };
    };
    let summed = 0;
    for (const branch of all) {
      const one = (await (await get(owner, `/v1/admin/reports/attendance?${range('2026-06-01', '2026-08-18')}&branchId=${branch.id}`)).json()) as {
        visits: { value: number };
      };
      summed += one.visits.value;
    }
    expect(whole.visits.value).toBe(summed);
  });
});

/* ——— Timezone ————————————————————————————————————————————— */

describe('PF-RPT-002 — day boundaries are the branch’s, not the server’s', () => {
  it('states the zone every boundary was computed in', async () => {
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2026-08-01', '2026-08-18')}`);
    const body = (await res.json()) as { meta: { timeZone: string } };
    expect(body.meta.timeZone).toBe(tz);
  });

  it('puts a sale just before local midnight in that local day, not the next', async () => {
    const branch = branches()[0]!;
    const member = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId()), eq(schema.members.homeBranchId, branch.id)))
      .limit(1)
      .get()!;

    // 23:30 local on a quiet historical day. In UTC that instant belongs to the
    // *previous* calendar day, which is exactly how a night's takings end up
    // filed against the wrong date when the server's zone decides.
    const day = '2026-06-10';
    const at = startOfLocalDay(day, branch.timezone) + 23.5 * 3_600_000;
    const invoiceId = id('inv');
    db.insert(schema.invoices)
      .values({
        id: invoiceId,
        tenantId: tenantId(),
        branchId: branch.id,
        memberId: member.id,
        number: `TZ-${Date.now()}`,
        state: 'paid',
        issuedOn: day,
        dueOn: day,
        currency: 'INR',
        subtotalMinor: 100_000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 100_000,
        paidMinor: 100_000,
        refundedMinor: 0,
        voided: false,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    // The rollup for that day was computed before this row existed.
    db.delete(schema.metricRollups)
      .where(and(eq(schema.metricRollups.tenantId, tenantId()), eq(schema.metricRollups.onDate, day)))
      .run();

    const res = await get(owner, `/v1/admin/reports/revenue?${range(day, day)}&branchId=${branch.id}`);
    const body = (await res.json()) as { series: Array<{ date: string; grossMinor: number }> };
    const onDay = body.series.find((p) => p.date === day)!;
    expect(onDay.grossMinor).toBeGreaterThanOrEqual(100_000);

    // And it is absent from the following day.
    const next = '2026-06-11';
    const after = (await (await get(owner, `/v1/admin/reports/revenue?${range(next, next)}&branchId=${branch.id}`)).json()) as {
      series: Array<{ date: string; grossMinor: number }>;
    };
    expect(after.series.find((p) => p.date === next)!.grossMinor).toBe(0);

    db.delete(schema.invoices).where(eq(schema.invoices.id, invoiceId)).run();
    db.delete(schema.metricRollups)
      .where(and(eq(schema.metricRollups.tenantId, tenantId()), eq(schema.metricRollups.onDate, day)))
      .run();
  });
});

/* ——— Currency ————————————————————————————————————————————— */

describe('PF-RPT edge case — a currency change inside the range', () => {
  it('reports each currency separately and refuses to state one total', async () => {
    const branch = branches()[0]!;
    const member = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId()), eq(schema.members.homeBranchId, branch.id)))
      .limit(1)
      .get()!;

    const day = '2026-06-12';
    const at = startOfLocalDay(day, branch.timezone) + 10 * 3_600_000;
    const aed = id('inv');
    db.insert(schema.invoices)
      .values({
        id: aed,
        tenantId: tenantId(),
        branchId: branch.id,
        memberId: member.id,
        number: `AED-${Date.now()}`,
        state: 'paid',
        issuedOn: day,
        dueOn: day,
        currency: 'AED',
        subtotalMinor: 50_000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 50_000,
        paidMinor: 50_000,
        refundedMinor: 0,
        voided: false,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    const res = await get(owner, `/v1/admin/reports/revenue?${range('2026-06-01', '2026-06-30')}&branchId=${branch.id}`);
    const body = (await res.json()) as {
      mixedCurrency: boolean;
      byCurrency: Array<{ currency: string; grossMinor: number }>;
      totals: unknown;
      seriesCurrency: string | null;
      meta: { restricted: string[] };
    };

    expect(body.mixedCurrency).toBe(true);
    expect(body.byCurrency.map((c) => c.currency).sort()).toEqual(['AED', 'INR']);
    // No single total, because adding rupees to dirhams produces a number that
    // is wrong in a way nobody can see by looking at it.
    expect(body.totals).toBeNull();
    expect(body.meta.restricted).toContain('totals:mixed-currency');
    // The series still has to be one currency to be a line, and says which.
    expect(body.seriesCurrency).toBe('INR');

    db.delete(schema.invoices).where(eq(schema.invoices.id, aed)).run();
  });

  it('states a single total when the range holds one currency', async () => {
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2026-08-01', '2026-08-18')}`);
    const body = (await res.json()) as { mixedCurrency: boolean; totals: unknown; byCurrency: unknown[] };
    expect(body.mixedCurrency).toBe(false);
    expect(body.totals).not.toBeNull();
    expect(body.byCurrency).toHaveLength(1);
  });
});

/* ——— Empty periods vs failed reads ————————————————————— */

describe('PF-RPT-004 — an empty period is not a failure, and neither is silent', () => {
  it('answers a quiet period with real zeros and a stated range', async () => {
    const res = await get(owner, `/v1/admin/reports/attendance?${range('2019-01-01', '2019-01-07')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      visits: { value: number };
      series: unknown[];
      noShowRateBp: number | null;
      meta: { period: { days: number } };
    };
    // Nothing happened, and the report says so with a shape rather than an
    // error: seven days, all zero.
    expect(body.visits.value).toBe(0);
    expect(body.series).toHaveLength(7);
    expect(body.meta.period.days).toBe(7);
    // But a rate over no bookings is absent, not 0% — "nobody missed a class"
    // and "there were no classes" must not look alike.
    expect(body.noShowRateBp).toBeNull();
  });

  it('refuses a range that ends before it starts rather than returning nothing', async () => {
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2026-08-18', '2026-08-01')}`);
    expect(res.status).toBe(422);
  });

  it('refuses an unbounded range rather than scanning the whole history', async () => {
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2000-01-01', '2026-08-18')}`);
    expect(res.status).toBe(422);
  });

  it('refuses a malformed date', async () => {
    const res = await get(owner, '/v1/admin/reports/revenue?from=August&to=2026-08-18');
    expect(res.status).toBe(422);
  });
});

/* ——— Freshness ————————————————————————————————————————— */

describe('PF-RPT-004 — every figure declares its freshness', () => {
  it('marks a settled historical range as batch once it is in the store', async () => {
    // The first read may have to materialise a day, which is honestly
    // near-real-time. The second is served from the store, and that is what
    // `batch` means — so the assertion is about the second.
    const path = `/v1/admin/reports/revenue?${range('2026-07-01', '2026-07-31')}`;
    await get(owner, path);
    const body = (await (await get(owner, path)).json()) as { meta: { freshness: string; computedAt: string } };
    expect(body.meta.freshness).toBe('batch');
    expect(Number.isNaN(Date.parse(body.meta.computedAt))).toBe(false);
  });

  it('marks a range that includes today as near real-time', async () => {
    const res = await get(owner, `/v1/admin/reports/attendance?${range(today, today)}`);
    const body = (await res.json()) as { meta: { freshness: string } };
    // Today is still moving, so it is never served from the store.
    expect(body.meta.freshness).toBe('near_realtime');
  });
});

/* ——— Rollups (PF-RPT-006) ————————————————————————————— */

describe('PF-RPT-006 — expensive analytics come from an aggregate table', () => {
  it('has a populated rollup store rather than empty charts', async () => {
    const rows = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.metricRollups)
      .where(eq(schema.metricRollups.tenantId, tenantId()))
      .get()!.n;
    expect(rows).toBeGreaterThan(0);
  });

  it('materialises a complete day it has never seen and keeps it', async () => {
    const branch = branches()[0]!;
    const day = '2026-05-30';
    db.delete(schema.metricRollups)
      .where(
        and(
          eq(schema.metricRollups.tenantId, tenantId()),
          eq(schema.metricRollups.branchId, branch.id),
          eq(schema.metricRollups.onDate, day),
        ),
      )
      .run();

    await get(owner, `/v1/admin/reports/attendance?${range(day, day)}&branchId=${branch.id}`);

    const after = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.metricRollups)
      .where(
        and(
          eq(schema.metricRollups.tenantId, tenantId()),
          eq(schema.metricRollups.branchId, branch.id),
          eq(schema.metricRollups.onDate, day),
        ),
      )
      .get()!.n;
    // The second person to open this range pays nothing for it.
    expect(after).toBeGreaterThan(0);
  });

  it('never stores today, because today is still moving', async () => {
    await get(owner, `/v1/admin/reports/attendance?${range(today, today)}`);
    const stored = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.metricRollups)
      .where(and(eq(schema.metricRollups.tenantId, tenantId()), eq(schema.metricRollups.onDate, today)))
      .get()!.n;
    expect(stored).toBe(0);
  });
});

/* ——— Export ————————————————————————————————————————————— */

describe('PF-RPT-003 and PF-RPT-005 — export', () => {
  it('refuses without report.export', async () => {
    // The trainer has neither view nor export; the refusal must come before
    // any data is assembled.
    const res = await post(trainer, '/v1/admin/reports/export', {
      kind: 'revenue',
      from: '2026-08-01',
      to: '2026-08-18',
    });
    expect(res.status).toBe(403);
  });

  it('returns the complete filtered set, not one page of it', async () => {
    // 90 days in, 90 rows out. An export that silently stops at a page is
    // worse than none, because the recipient cannot see what is missing.
    const res = await post(owner, '/v1/admin/reports/export', {
      kind: 'attendance',
      from: '2026-05-21',
      to: '2026-08-18',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: number; csv: string; filename: string };
    expect(body.rows).toBe(90);
    // Header plus every row plus the trailing newline.
    expect(body.csv.trim().split('\n')).toHaveLength(91);
    expect(body.filename).toBe('shark-attendance-2026-05-21-to-2026-08-18.csv');
  });

  it('audits every export with the filter set that produced it', async () => {
    const before = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId()), eq(schema.auditLog.action, 'report.export')))
      .get()!.n;

    const branch = branches()[0]!;
    await post(owner, '/v1/admin/reports/export', {
      kind: 'revenue',
      from: '2026-07-01',
      to: '2026-07-31',
      branchId: branch.id,
    });

    const rows = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId()), eq(schema.auditLog.action, 'report.export')))
      .orderBy(desc(schema.auditLog.at))
      .all();
    expect(rows.length).toBe(before + 1);

    // "Somebody exported revenue" does not tell you what left the building.
    // The range and the branches are what make the log answerable later.
    const changes = JSON.stringify(rows[0]!.changes);
    expect(changes).toContain('2026-07-01');
    expect(changes).toContain('2026-07-31');
    expect(changes).toContain(branch.id);
    expect(rows[0]!.entityId).toBe('revenue');
  });

  it('leaves a withheld financial column empty rather than writing a zero', async () => {
    const res = await post(manager, '/v1/admin/reports/export', {
      kind: 'revenue',
      from: '2026-08-01',
      to: '2026-08-07',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { csv: string };
    const [header, ...rows] = body.csv.trim().split('\n');
    expect(header).toContain('net_minor');
    // Money columns are blank, not 0 — a zero in a spreadsheet is a number
    // somebody will total.
    for (const row of rows) {
      const cells = row.split(',');
      expect(cells[2]).toBe('');
      expect(cells[4]).toBe('');
    }
  });

  it('exports every report kind', async () => {
    for (const kind of ['revenue', 'membership', 'attendance', 'trainer', 'retention']) {
      const res = await post(owner, '/v1/admin/reports/export', { kind, from: '2026-08-01', to: '2026-08-18' });
      expect(res.status, kind).toBe(200);
      const body = (await res.json()) as { csv: string };
      expect(body.csv.length, kind).toBeGreaterThan(0);
    }
  });
});

/* ——— The reports themselves ————————————————————————————— */

describe('the five reports answer their own question', () => {
  it('revenue nets refunds off gross rather than flattering the month', async () => {
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2026-06-01', '2026-08-18')}`);
    const body = (await res.json()) as {
      totals: { grossMinor: { value: number }; netMinor: { value: number }; refundedMinor: number };
    };
    expect(body.totals.netMinor.value).toBe(body.totals.grossMinor.value - body.totals.refundedMinor);
  });

  it('attendance reports the busiest local hour', async () => {
    const res = await get(owner, `/v1/admin/reports/attendance?${range('2026-06-01', '2026-08-18')}`);
    const body = (await res.json()) as { byHour: Array<{ hour: number; visits: number }> };
    expect(body.byHour).toHaveLength(24);
    expect(body.byHour.reduce((n, h) => n + h.visits, 0)).toBeGreaterThan(0);
  });

  it('trainer utilisation is seats taken over seats offered', async () => {
    const res = await get(owner, `/v1/admin/reports/trainer?${range('2026-08-12', '2026-08-18')}`);
    const body = (await res.json()) as {
      rows: Array<{ seatsBooked: number; seatsCapacity: number; utilisationBp: number | null }>;
    };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      if (row.seatsCapacity === 0) expect(row.utilisationBp).toBeNull();
      else expect(row.utilisationBp).toBe(Math.round((row.seatsBooked / row.seatsCapacity) * 10_000));
    }
  });

  it('retention buckets members by joining month and never claims a rate over nobody', async () => {
    const res = await get(owner, `/v1/admin/reports/retention?${range('2026-08-01', '2026-08-18')}`);
    const body = (await res.json()) as {
      bands: { high: number; watch: number; low: number };
      cohorts: Array<{ cohort: string; joined: number; retainedBp: number | null }>;
    };
    expect(body.bands.high + body.bands.watch + body.bands.low).toBeGreaterThan(0);
    for (const c of body.cohorts) {
      expect(c.cohort).toMatch(/^\d{4}-\d{2}$/);
      if (c.joined === 0) expect(c.retainedBp).toBeNull();
    }
  });

  it('membership churn has no rate when nobody could have churned', async () => {
    const res = await get(owner, `/v1/admin/reports/membership?${range('2019-01-01', '2019-01-31')}`);
    const body = (await res.json()) as { churnBp: number | null; activeAtEnd: number; cancellations: { value: number } };
    if (body.activeAtEnd + body.cancellations.value === 0) expect(body.churnBp).toBeNull();
  });
});

/* ——— Isolation ————————————————————————————————————————— */

describe('tenant isolation', () => {
  it('answers only for the caller’s own tenant', async () => {
    const res = await get(owner, `/v1/admin/reports/revenue?${range('2026-06-01', '2026-08-18')}`);
    const body = (await res.json()) as { meta: { branchIds: string[] } };
    const mine = new Set(branches().map((b) => b.id));
    for (const branchId of body.meta.branchIds) expect(mine.has(branchId)).toBe(true);
  });

  it('refuses an unauthenticated read', async () => {
    const res = await app.request(`/v1/admin/reports/revenue?${range('2026-08-01', '2026-08-18')}`);
    expect(res.status).toBe(401);
  });
});
