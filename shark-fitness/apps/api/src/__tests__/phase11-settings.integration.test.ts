import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

/* ============================================================================
   Phase 11 — Tenant and branch configuration (PF-TEN-001…006).

   Settings is the module whose mistakes are the most expensive, because every
   value on it is read by something that already happened. The tests that
   matter here are not "the form saved"; they are the four the PRD names:

   - a branch in another timezone, whose stored instants must not move
   - a branch closing with a timetable already on it
   - a branch archived while members still hold cross-branch access
   - a currency change with invoices already raised

   Each one has the same shape: prove the change is prospective, prove the
   history is untouched, and prove nobody could have made it without seeing
   what it does.
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

const headers = (s: Session, unsafe = false): Record<string, string> => ({
  cookie: s.cookie,
  origin: 'http://localhost:5173',
  ...(unsafe ? { 'x-csrf-token': s.csrfToken, 'content-type': 'application/json' } : {}),
});

const get = (s: Session, path: string) => app.request(path, { headers: headers(s) });
const post = (s: Session, path: string, body: unknown, key?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { ...headers(s, true), ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
const patch = (s: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(s, true), body: JSON.stringify(body) });
const del = (s: Session, path: string) => app.request(path, { method: 'DELETE', headers: headers(s, true) });

const tenantId = (): string =>
  db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;

interface Consequences {
  error: { message: string; details?: { consequences: Array<{ code: string; blocking: boolean; count?: number }> } };
}
const codesOf = async (res: Response): Promise<string[]> =>
  ((await res.json()) as Consequences).error.details?.consequences.map((c) => c.code) ?? [];

/** Owner holds `settings.manage`; nobody else in the seed does. */
let owner: Session;
let manager: Session;
let accountant: Session;

/**
 * A branch this file owns outright.
 *
 * The seeded three are read by every other suite — the door, the till, the
 * leads desk — so a test that edits their hours or their state is a test that
 * breaks somebody else's. `br_kor` is closed on Sundays in one draft of this
 * file, and the whole of Phase 4 failed on a Sunday. Mutations that do not
 * specifically need seeded history happen here instead.
 */
let fixtureBranchId = '';

/** Everything this file creates, torn down at the end. The seed is left as found. */
const created: string[] = [];

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
  accountant = await signIn('accounts@sharkfitness.in');

  const res = await post(owner, '/v1/admin/settings/branches', {
    name: 'Settings Fixture', slug: `fixture-${Date.now()}`, addressLine: 'Test Row', city: 'Bengaluru',
    timezone: 'Asia/Kolkata', capacity: 30, opensAt: '06:00', closesAt: '22:00',
  });
  fixtureBranchId = ((await res.json()) as { branch: { id: string } }).branch.id;
  created.push(fixtureBranchId);
});

afterAll(() => {
  // A branch left behind changes what "the other branch" means to suites that
  // pick one by elimination, and that is exactly how this file first broke the
  // leads tests.
  for (const branchId of created) {
    db.delete(schema.rooms).where(eq(schema.rooms.branchId, branchId)).run();
    db.delete(schema.memberBranches).where(eq(schema.memberBranches.branchId, branchId)).run();
    db.delete(schema.branches).where(eq(schema.branches.id, branchId)).run();
  }
});

/* ——— Permission ————————————————————————————————————————— */

describe('PF-TEN — settings.manage is owner-level and nothing else reaches it', () => {
  it('opens every settings read for the owner', async () => {
    for (const path of ['/v1/admin/settings/business', '/v1/admin/settings/branches', '/v1/admin/settings/setup']) {
      expect((await get(owner, path)).status).toBe(200);
    }
  });

  it('refuses a branch manager, who runs a site but does not configure the company', async () => {
    expect((await get(manager, '/v1/admin/settings/business')).status).toBe(403);
    expect((await get(manager, '/v1/admin/settings/branches')).status).toBe(403);
  });

  it('refuses an accountant, who sees the money and not the switches', async () => {
    expect((await get(accountant, '/v1/admin/settings/business')).status).toBe(403);
  });

  it('refuses a branch-manager write, not merely the read', async () => {
    // A module that hides its buttons and accepts its writes is not scoped.
    const res = await patch(manager, '/v1/admin/settings/business', { displayName: 'Taken over' });
    expect(res.status).toBe(403);
    expect(db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId())).get()!.displayName).not.toBe('Taken over');
  });
});

/* ——— Business profile (PF-TEN-001) ————————————————————————— */

describe('PF-TEN-001 — the business profile', () => {
  it('returns the tenant identity the invoices are raised under', async () => {
    const body = (await (await get(owner, '/v1/admin/settings/business')).json()) as {
      legalName: string; currency: string; timezone: string; plan: string;
    };
    expect(body.legalName.length).toBeGreaterThan(0);
    expect(body.currency).toBe('INR');
    expect(body.timezone).toBe('Asia/Kolkata');
  });

  it('stores a tax profile and a data-processing policy', async () => {
    const res = await patch(owner, '/v1/admin/settings/business', {
      taxProfile: { registrationNumber: '29ABCDE1234F1Z5', label: 'GST', defaultRateBp: 1800, pricesIncludeTax: false },
      dataProcessing: { privacyContact: 'privacy@sharkfitness.in', retentionDays: 1095, consentVersion: '2026-01', jurisdiction: 'India' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taxProfile: { label: string }; dataProcessing: { retentionDays: number } };
    expect(body.taxProfile.label).toBe('GST');
    expect(body.dataProcessing.retentionDays).toBe(1095);
  });

  it('audits the change with a field-level diff, not two blobs', async () => {
    await patch(owner, '/v1/admin/settings/business', { displayName: 'Shark Fitness Bengaluru' });
    const row = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId()), eq(schema.auditLog.action, 'tenant.updated')))
      .orderBy(sql`${schema.auditLog.at} desc`)
      .get()!;
    expect(row.changes.some((c) => c.field === 'displayName' && c.to === 'Shark Fitness Bengaluru')).toBe(true);
  });
});

/* ——— Currency (PF-TEN edge case) ————————————————————————— */

describe('PF-TEN — a currency change never re-reads an invoice already raised', () => {
  it('refuses until the consequences have been seen', async () => {
    const res = await patch(owner, '/v1/admin/settings/business', { currency: 'AED' });
    expect(res.status).toBe(409);
    const codes = await codesOf(res);
    expect(codes).toContain('currency.prospective_only');
    expect(codes).toContain('currency.mixed_history');
    expect(codes).toContain('currency.reprice_products');
  });

  it('leaves every existing invoice in the currency it was raised in', async () => {
    const before = db
      .select({ currency: schema.invoices.currency, n: sql<number>`count(*)` })
      .from(schema.invoices)
      .where(eq(schema.invoices.tenantId, tenantId()))
      .groupBy(schema.invoices.currency)
      .all();

    const res = await patch(owner, '/v1/admin/settings/business', {
      currency: 'AED',
      acknowledge: ['currency.prospective_only', 'currency.mixed_history', 'currency.reprice_products'],
    });
    expect(res.status).toBe(200);

    const after = db
      .select({ currency: schema.invoices.currency, n: sql<number>`count(*)` })
      .from(schema.invoices)
      .where(eq(schema.invoices.tenantId, tenantId()))
      .groupBy(schema.invoices.currency)
      .all();
    // The whole requirement in one assertion: money already invoiced did not
    // change denomination because somebody edited a settings field.
    expect(after).toEqual(before);

    // Put it back for the rest of the suite.
    await patch(owner, '/v1/admin/settings/business', {
      currency: 'INR',
      acknowledge: ['currency.prospective_only', 'currency.mixed_history', 'currency.reprice_products'],
    });
  });

  it('accepts a no-op currency write without asking anything', async () => {
    expect((await patch(owner, '/v1/admin/settings/business', { currency: 'INR' })).status).toBe(200);
  });
});

/* ——— Branch CRUD and timezones (PF-TEN-002) ————————————————— */

describe('PF-TEN-002 — creating a branch', () => {
  it('creates one in a different timezone, as a draft', async () => {
    const res = await post(owner, '/v1/admin/settings/branches', {
      name: 'Dubai Marina', slug: 'dubai-marina', addressLine: 'Marina Walk', city: 'Dubai',
      timezone: 'Asia/Dubai', capacity: 60, opensAt: '06:00', closesAt: '23:00',
    }, 'settings-branch-dubai');
    expect(res.status).toBe(201);
    const { branch } = (await res.json()) as { branch: { id: string; state: string; timezone: string; trades: boolean } };
    created.push(branch.id);
    // A branch that takes bookings the instant it is typed in is a branch
    // nobody checked.
    expect(branch.state).toBe('draft');
    expect(branch.trades).toBe(false);
    expect(branch.timezone).toBe('Asia/Dubai');
  });

  it('refuses a timezone the runtime cannot resolve', async () => {
    const res = await post(owner, '/v1/admin/settings/branches', {
      name: 'Nowhere', slug: 'nowhere', addressLine: 'x', city: 'x',
      timezone: 'Mars/Olympus', capacity: 10, opensAt: '06:00', closesAt: '22:00',
    });
    expect(res.status).toBe(422);
  });

  it('refuses a duplicate short name within the tenant', async () => {
    const res = await post(owner, '/v1/admin/settings/branches', {
      name: 'Another Koramangala', slug: 'koramangala', addressLine: 'x', city: 'x',
      timezone: 'Asia/Kolkata', capacity: 10, opensAt: '06:00', closesAt: '22:00',
    });
    expect(res.status).toBe(409);
  });

  it('refuses a day that closes before it opens', async () => {
    const res = await post(owner, '/v1/admin/settings/branches', {
      name: 'Backwards', slug: 'backwards', addressLine: 'x', city: 'x',
      timezone: 'Asia/Kolkata', capacity: 10, opensAt: '22:00', closesAt: '06:00',
    });
    expect(res.status).toBe(422);
  });

  it('always offers a branch its own current timezone', async () => {
    // Node's bundled ICU lists the legacy `Asia/Calcutta` and never
    // `Asia/Kolkata`, which is the name every seeded branch is stored under. A
    // picker that cannot offer the current value reads as broken, and
    // re-saving would rewrite the row to a different string for no reason.
    const body = (await (await get(owner, '/v1/admin/settings/timezones')).json()) as { items: string[] };
    expect(body.items).toContain('Asia/Kolkata');
  });

  it('finds a renamed zone by the name people actually use', async () => {
    const body = (await (await get(owner, '/v1/admin/settings/timezones?q=kolkata')).json()) as { items: string[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.some((z) => z === 'Asia/Kolkata' || z === 'Asia/Calcutta')).toBe(true);
  });

  it('narrows on a plain substring too', async () => {
    const body = (await (await get(owner, '/v1/admin/settings/timezones?q=dubai')).json()) as { items: string[] };
    expect(body.items).toContain('Asia/Dubai');
  });
});

describe('PF-TEN — changing a branch timezone moves no stored instant', () => {
  it('warns first, and says the data does not move', async () => {
    const res = await patch(owner, '/v1/admin/settings/branches/br_hsr', { timezone: 'Asia/Dubai' });
    expect(res.status).toBe(409);
    expect(await codesOf(res)).toContain('timezone.presentation_only');
  });

  it('leaves every stored timestamp byte-identical', async () => {
    const fingerprint = () =>
      db
        .select({ id: schema.classSessions.id, startsAt: schema.classSessions.startsAt })
        .from(schema.classSessions)
        .where(eq(schema.classSessions.branchId, 'br_hsr'))
        .orderBy(schema.classSessions.id)
        .all();

    const before = fingerprint();
    expect(before.length).toBeGreaterThan(0);

    const res = await patch(owner, '/v1/admin/settings/branches/br_hsr', {
      timezone: 'Asia/Dubai',
      acknowledge: ['timezone.presentation_only', 'timezone.future_bookings'],
    });
    expect(res.status).toBe(200);
    // A timezone is a lens, not a value. Every instant is where it was.
    expect(fingerprint()).toEqual(before);

    await patch(owner, '/v1/admin/settings/branches/br_hsr', {
      timezone: 'Asia/Kolkata',
      acknowledge: ['timezone.presentation_only', 'timezone.future_bookings'],
    });
  });
});

/* ——— Hours and holidays (PF-TEN-002) ————————————————————— */

describe('PF-TEN-002 — opening hours and holidays', () => {
  it('stores a per-day week', async () => {
    const res = await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, {
      hours: {
        mon: { open: 330, close: 1380, closed: false },
        sat: { open: 420, close: 1200, closed: false },
        sun: { open: 0, close: 0, closed: true },
      },
    });
    expect(res.status).toBe(200);
    const { branch } = (await res.json()) as { branch: { hours: Record<string, { closed: boolean }> } };
    expect(branch.hours.sun!.closed).toBe(true);
  });

  it('refuses a day that closes before it opens, and explains the overnight case', async () => {
    const res = await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, {
      hours: { tue: { open: 1320, close: 120, closed: false } },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/past midnight/);
  });

  it('stores holidays as calendar dates', async () => {
    const res = await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, { holidays: ['2026-12-25', '2027-01-01'] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: { holidays: string[] } }).branch.holidays).toEqual(['2026-12-25', '2027-01-01']);
  });
});

/* ——— Inheritance (PF-TEN-003) ————————————————————————— */

describe('PF-TEN-003 — tenant defaults and branch overrides', () => {
  it('reports every setting as inherited until a branch overrides it', async () => {
    const { branch } = (await (await get(owner, `/v1/admin/settings/branches/${fixtureBranchId}`)).json()) as {
      branch: { settings: Array<{ key: string; source: string; overridable: boolean }> };
    };
    const antiPassback = branch.settings.find((s) => s.key === 'antiPassbackSeconds')!;
    expect(antiPassback.source).toBe('tenant');
    expect(antiPassback.overridable).toBe(true);
  });

  it('marks a tenant-wide promise as not overridable', async () => {
    const { branch } = (await (await get(owner, `/v1/admin/settings/branches/${fixtureBranchId}`)).json()) as {
      branch: { settings: Array<{ key: string; overridable: boolean }> };
    };
    expect(branch.settings.find((s) => s.key === 'graceDays')!.overridable).toBe(false);
  });

  it('refuses a branch override of a tenant-wide promise', async () => {
    const res = await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, { policy: { graceDays: 30 } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/whole gym/);
  });

  it('flips a setting to branch-sourced when overridden, and back when cleared', async () => {
    const sourceOf = async (key: string): Promise<string> => {
      const { branch } = (await (await get(owner, `/v1/admin/settings/branches/${fixtureBranchId}`)).json()) as {
        branch: { settings: Array<{ key: string; source: string; value: unknown }> };
      };
      return branch.settings.find((s) => s.key === key)!.source;
    };

    await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, { policy: { antiPassbackSeconds: 20 } });
    expect(await sourceOf('antiPassbackSeconds')).toBe('branch');

    // `null` removes the override rather than storing null — otherwise
    // "explicitly off" and "not set" become the same value.
    await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, { policy: { antiPassbackSeconds: null } });
    expect(await sourceOf('antiPassbackSeconds')).toBe('tenant');
  });

  it('makes an override change what the door actually decides', async () => {
    // The difference between a settings screen and a settings screen that
    // works. `false` is a real override, not an absence.
    await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, { policy: { graceAllowsEntry: true } });
    const { branch } = (await (await get(owner, `/v1/admin/settings/branches/${fixtureBranchId}`)).json()) as {
      branch: { settings: Array<{ key: string; value: unknown; source: string }> };
    };
    const setting = branch.settings.find((s) => s.key === 'graceAllowsEntry')!;
    expect(setting.value).toBe(true);
    expect(setting.source).toBe('branch');

    const tenantValue = (db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId())).get()!
      .policy as Record<string, unknown>).graceAllowsEntry;
    expect(tenantValue).toBe(false);

    await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, { policy: { graceAllowsEntry: null } });
  });

  it('refuses a key that is not a branch setting at all', async () => {
    expect((await patch(owner, `/v1/admin/settings/branches/${fixtureBranchId}`, { policy: { madeUp: 1 } })).status).toBe(422);
  });
});

/* ——— Lifecycle (PF-TEN-004) ————————————————————————————— */

describe('PF-TEN-004 — branch lifecycle without deleting history', () => {
  const draftBranch = (): string =>
    db.select({ id: schema.branches.id }).from(schema.branches).where(and(eq(schema.branches.tenantId, tenantId()), eq(schema.branches.slug, 'dubai-marina'))).get()!.id;

  it('opens a draft branch', async () => {
    const res = await post(owner, `/v1/admin/settings/branches/${draftBranch()}/state`, {
      state: 'active', note: 'Fit-out signed off and staffed',
    });
    expect(res.status).toBe(200);
    const { branch } = (await res.json()) as { branch: { state: string; trades: boolean; stateNote: string } };
    expect(branch.state).toBe('active');
    expect(branch.trades).toBe(true);
    expect(branch.stateNote).toBe('Fit-out signed off and staffed');
  });

  it('refuses an illegal move and says which one it was', async () => {
    const res = await post(owner, `/v1/admin/settings/branches/${draftBranch()}/state`, {
      state: 'active', note: 'Trying again for no reason',
    });
    expect(res.status).toBe(412);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/already active/);
  });

  it('records who changed it, when, and why', async () => {
    const branchId = draftBranch();
    await post(owner, `/v1/admin/settings/branches/${branchId}/state`, {
      state: 'temporarily_closed', note: 'Chiller failure, closed until parts arrive',
    });
    const row = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId()), eq(schema.auditLog.entityId, branchId)))
      .orderBy(sql`${schema.auditLog.at} desc`)
      .get()!;
    expect(row.action).toBe('branch.temporarily_closed');
    expect(row.reason).toMatch(/Chiller failure/);
  });

  it('stops a closed branch trading without touching what it recorded', async () => {
    const branchId = draftBranch();
    const { branch } = (await (await get(owner, `/v1/admin/settings/branches/${branchId}`)).json()) as {
      branch: { state: string; trades: boolean };
    };
    expect(branch.state).toBe('temporarily_closed');
    expect(branch.trades).toBe(false);
  });
});

describe('PF-TEN — closing a branch with a timetable on it', () => {
  it('warns about future bookings and refuses to pretend they are gone', async () => {
    const res = await post(owner, '/v1/admin/settings/branches/br_kor/state', {
      state: 'temporarily_closed', note: 'Deep clean over the long weekend',
    });
    expect(res.status).toBe(409);
    expect(await codesOf(res)).toContain('branch.future_bookings');
  });

  it('leaves every one of those bookings exactly where it was', async () => {
    const live = () =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.bookings)
        .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
        .where(and(eq(schema.classSessions.branchId, 'br_kor'), sql`${schema.bookings.state} in ('held','confirmed')`))
        .get()!.n;

    const before = live();
    const res = await post(owner, '/v1/admin/settings/branches/br_kor/state', {
      state: 'temporarily_closed',
      note: 'Deep clean over the long weekend',
      acknowledge: ['branch.future_bookings'],
    });
    expect(res.status).toBe(200);
    // Cancelling somebody's class has a refund attached. A state change is not
    // allowed to make that decision on an operator's behalf.
    expect(live()).toBe(before);

    await post(owner, '/v1/admin/settings/branches/br_kor/state', { state: 'active', note: 'Reopened after the clean' });
  });
});

describe('PF-TEN — archiving a branch members still use', () => {
  it('refuses while members call it home, and the refusal cannot be acknowledged away', async () => {
    const res = await post(owner, '/v1/admin/settings/branches/br_ind/state', {
      state: 'archived',
      note: 'Lease not renewed',
      // Acknowledging a blocking consequence must not get past it.
      acknowledge: ['branch.home_members', 'branch.future_bookings', 'branch.cross_branch_entitlement'],
    });
    expect(res.status).toBe(409);
    expect(await codesOf(res)).toContain('branch.home_members');
    expect(db.select({ state: schema.branches.state }).from(schema.branches).where(eq(schema.branches.id, 'br_ind')).get()!.state).toBe('active');
  });

  it('archives a branch whose only claim is a cross-branch grant, and keeps the grant', async () => {
    // The PRD edge case. The entitlement is not revoked — it stops opening
    // this door, which is what archiving means.
    const branchId = id('brn');
    const atMs = now();
    db.insert(schema.branches).values({
      id: branchId, tenantId: tenantId(), name: 'Whitefield Pop-up', slug: `popup-${branchId.slice(-6)}`,
      addressLine: 'Temporary', city: 'Bengaluru', timezone: 'Asia/Kolkata', capacity: 20,
      opensMinutes: 360, closesMinutes: 1320, state: 'active', amenities: [], holidays: [],
      phone: null, email: null, hours: null, policy: {}, stateChangedAt: atMs, stateNote: 'seeded',
      createdAt: atMs, updatedAt: atMs,
    }).run();

    const member = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(eq(schema.members.tenantId, tenantId()))
      .limit(1)
      .get()!;
    db.insert(schema.memberBranches).values({ tenantId: tenantId(), memberId: member.id, branchId }).onConflictDoNothing().run();

    const first = await post(owner, `/v1/admin/settings/branches/${branchId}/state`, { state: 'archived', note: 'Pop-up ended' });
    expect(first.status).toBe(409);
    const codes = await codesOf(first);
    expect(codes).toContain('branch.cross_branch_entitlement');
    expect(codes).not.toContain('branch.home_members');

    const second = await post(owner, `/v1/admin/settings/branches/${branchId}/state`, {
      state: 'archived', note: 'Pop-up ended', acknowledge: codes,
    });
    expect(second.status).toBe(200);

    // Kept, not revoked.
    const grant = db
      .select()
      .from(schema.memberBranches)
      .where(and(eq(schema.memberBranches.memberId, member.id), eq(schema.memberBranches.branchId, branchId)))
      .get();
    expect(grant).toBeDefined();

    db.delete(schema.memberBranches).where(eq(schema.memberBranches.branchId, branchId)).run();
    db.delete(schema.branches).where(eq(schema.branches.id, branchId)).run();
  });
});

/* ——— Rooms ————————————————————————————————————————————— */

describe('PF-TEN-002 — rooms and areas', () => {
  it('adds a room to a branch', async () => {
    const res = await post(owner, '/v1/admin/settings/branches/br_hsr/rooms', { name: 'Recovery Suite', capacity: 8 });
    expect(res.status).toBe(201);
    const { room } = (await res.json()) as { room: { id: string; name: string } };
    expect(room.name).toBe('Recovery Suite');
    expect((await del(owner, `/v1/admin/settings/rooms/${room.id}`)).status).toBe(200);
  });

  it('refuses to remove a room classes have already been scheduled in', async () => {
    const used = db
      .select({ roomId: schema.classSessions.roomId })
      .from(schema.classSessions)
      .where(and(eq(schema.classSessions.tenantId, tenantId()), sql`${schema.classSessions.roomId} is not null`))
      .limit(1)
      .get();
    if (!used?.roomId) return;
    const res = await del(owner, `/v1/admin/settings/rooms/${used.roomId}`);
    expect(res.status).toBe(412);
    // The timetable would point at a room that no longer exists.
    expect(db.select().from(schema.rooms).where(eq(schema.rooms.id, used.roomId)).get()).toBeDefined();
  });

  it('refuses a room on a branch in another tenant', async () => {
    expect((await post(owner, '/v1/admin/settings/branches/brn_not_real/rooms', { name: 'x', capacity: 4 })).status).toBe(404);
  });
});

/* ——— Guided setup (PF-TEN-006) ——————————————————————————— */

describe('PF-TEN-006 — the guided setup checklist', () => {
  it('counts real rows rather than storing ticks', async () => {
    const body = (await (await get(owner, '/v1/admin/settings/setup')).json()) as {
      items: Array<{ key: string; done: boolean; to: string; blocking: boolean }>;
      done: number; total: number; readyToOpen: boolean;
    };
    expect(body.total).toBe(body.items.length);
    expect(body.done).toBe(body.items.filter((i) => i.done).length);
    // The seed has branches, staff and published plans, so these are true
    // because the rows exist — not because anything was ticked.
    expect(body.items.find((i) => i.key === 'branch')!.done).toBe(true);
    expect(body.items.find((i) => i.key === 'products')!.done).toBe(true);
    expect(body.items.find((i) => i.key === 'staff')!.done).toBe(true);
  });

  it('gives every item somewhere to act', async () => {
    const body = (await (await get(owner, '/v1/admin/settings/setup')).json()) as { items: Array<{ to: string }> };
    for (const item of body.items) expect(item.to.startsWith('/')).toBe(true);
  });
});

/* ——— Idempotency ————————————————————————————————————— */

describe('PF-TEN — a lost response does not create a second branch', () => {
  it('answers a replayed create with the first result', async () => {
    const body = {
      name: 'Replay Test', slug: `replay-${Date.now()}`, addressLine: 'x', city: 'Bengaluru',
      timezone: 'Asia/Kolkata', capacity: 25, opensAt: '06:00', closesAt: '22:00',
    };
    const key = `settings-replay-${Date.now()}`;
    const first = await post(owner, '/v1/admin/settings/branches', body, key);
    const second = await post(owner, '/v1/admin/settings/branches', body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = (await first.json()) as { branch: { id: string } };
    const b = (await second.json()) as { branch: { id: string } };
    expect(b.branch.id).toBe(a.branch.id);
    expect(
      db.select({ n: sql<number>`count(*)` }).from(schema.branches).where(eq(schema.branches.slug, body.slug)).get()!.n,
    ).toBe(1);

    db.delete(schema.branches).where(eq(schema.branches.id, a.branch.id)).run();
  });
});
