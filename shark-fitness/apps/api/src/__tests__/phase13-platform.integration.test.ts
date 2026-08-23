import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { now } from '../lib/time.js';

/* ============================================================================
   Phase 13 — Platform administration (PF-PLAT-001…006).

   This is the module where a mistake is a breach rather than a bug, so the
   tests are written as refusals first and features second. Every endpoint is
   probed by somebody who must not reach it — an owner, an accountant, a
   member, and an impersonated session carrying an owner's authority — before
   anything checks that it works for the operator.

   The property being defended: **cross-tenant reads exist only inside
   `/v1/platform`, and support access borrows authority without acquiring
   any.**
   ========================================================================= */

interface Session {
  cookie: string;
  csrfToken: string;
}

async function signIn(email: string, tenantSlug = 'shark'): Promise<Session> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug, email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  return { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
}

const headers = (s: Session, unsafe = false): Record<string, string> => ({
  cookie: s.cookie,
  origin: 'http://localhost:5173',
  ...(unsafe ? { 'x-csrf-token': s.csrfToken, 'content-type': 'application/json' } : {}),
});

const get = (s: Session, path: string) => app.request(path, { headers: headers(s) });
const post = (s: Session, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: headers(s, true), body: JSON.stringify(body) });
const patch = (s: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(s, true), body: JSON.stringify(body) });

const REEF = 'ten_reef';
const SHARK = 'ten_shark';

let admin: Session;
let support: Session;
let owner: Session;
let accountant: Session;
let reefOwner: Session;

/** Every platform surface, so a new one cannot quietly skip the sweep. */
const PLATFORM_READS = ['/v1/platform/tenants', `/v1/platform/tenants/${REEF}`, '/v1/platform/health'];

beforeAll(async () => {
  admin = await signIn('platform@sharkfitness.io', 'platform');
  support = await signIn('support@sharkfitness.io', 'platform');
  owner = await signIn('owner@sharkfitness.in');
  accountant = await signIn('accounts@sharkfitness.in');
  reefOwner = await signIn('owner@reefathletic.in', 'reef');
});

/* ——— Negative authorization ————————————————————————————— */

describe('PF-PLAT — no tenant role reaches the platform, however senior', () => {
  it('refuses an owner every platform read', async () => {
    for (const path of PLATFORM_READS) {
      expect((await get(owner, path)).status).toBe(403);
    }
  });

  it('refuses an owner every platform write', async () => {
    expect((await post(owner, `/v1/platform/tenants/${REEF}/status`, { status: 'suspended', reason: 'taking over' })).status).toBe(403);
    expect((await patch(owner, `/v1/platform/tenants/${REEF}/entitlements`, { plan: 'enterprise', reason: 'free upgrade' })).status).toBe(403);
    expect((await post(owner, '/v1/platform/impersonate', { userId: 'usr_x', reason: 'because I can' })).status).toBe(403);
  });

  it('refuses an accountant, who sees money and has no standing over gyms', async () => {
    for (const path of PLATFORM_READS) expect((await get(accountant, path)).status).toBe(403);
  });

  it('refuses a member outright', async () => {
    const member = await signIn('aman@sharkfitness.in');
    for (const path of PLATFORM_READS) expect((await get(member, path)).status).toBe(403);
  });

  it('refuses an unauthenticated caller before it refuses the role', async () => {
    for (const path of PLATFORM_READS) {
      expect((await app.request(path)).status).toBe(401);
    }
  });

  it('tells a tenant nothing about whether a platform console exists', async () => {
    // The refusal a wrong role gets is the refusal a wrong permission gets.
    // Whether this deployment has platform tooling is not a customer's
    // business, and a distinctive message would answer that.
    const roleRefusal = (await get(owner, '/v1/platform/tenants')).json();
    const permissionRefusal = (await get(accountant, '/v1/platform/health')).json();
    expect(((await roleRefusal) as { error: { message: string } }).error.message).toBe(
      ((await permissionRefusal) as { error: { message: string } }).error.message,
    );
  });
});

describe('PF-PLAT-004 — support access borrows authority and acquires none', () => {
  let borrowed: Session;
  let targetUserId = '';

  const shark = (): { ownerUserId: string } => ({
    ownerUserId: db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, SHARK), eq(schema.users.email, 'owner@sharkfitness.in')))
      .get()!.id,
  });

  it('lets platform support enter a gym account with a stated reason', async () => {
    targetUserId = shark().ownerUserId;
    const res = await post(support, '/v1/platform/impersonate', {
      userId: targetUserId,
      reason: 'Investigating the duplicate invoice on ticket SUP-1042',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { userName: string; minutesRemaining: number }; csrfToken: string };
    expect(body.session.minutesRemaining).toBe(60);

    const token = (res.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
    borrowed = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  });

  it('shows the banner on the call the console already makes at boot', async () => {
    const body = (await (await get(borrowed, '/v1/me')).json()) as {
      viewer: { name: string; role: string };
      impersonation?: { active: boolean; operatorName: string; tenantName: string; minutesRemaining: number };
    };
    // A support session that looks like an ordinary one, even for a moment, is
    // the failure this requirement is written against.
    expect(body.impersonation?.active).toBe(true);
    expect(body.impersonation?.operatorName).toMatch(/Noel/);
    // Read from the row rather than hard-coded: the gym's display name is a
    // setting another suite is entitled to change.
    expect(body.impersonation?.tenantName).toBe(
      db.select({ displayName: schema.tenants.displayName }).from(schema.tenants).where(eq(schema.tenants.id, SHARK)).get()!.displayName,
    );
    expect(body.impersonation?.minutesRemaining).toBeGreaterThan(0);
  });

  it('carries the target’s authority — it can do the gym’s own work', async () => {
    expect((await get(borrowed, '/v1/admin/members?limit=5')).status).toBe(200);
    expect((await get(borrowed, '/v1/admin/settings/business')).status).toBe(200);
  });

  it('cannot re-enter the platform it came from', async () => {
    // The whole requirement. The borrowed role is `owner`, which never held
    // platform permissions; the guard must not depend on that being true.
    for (const path of PLATFORM_READS) {
      expect((await get(borrowed, path)).status).toBe(403);
    }
  });

  it('carries no platform permission on the session itself, not merely at the door', async () => {
    const body = (await (await get(borrowed, '/v1/me')).json()) as { viewer: { permissions: string[] } };
    expect(body.viewer.permissions).not.toContain('platform.admin');
    expect(body.viewer.permissions).not.toContain('platform.impersonate');
  });

  it('cannot start a second support session from inside the first', async () => {
    const res = await post(borrowed, '/v1/platform/impersonate', {
      userId: targetUserId,
      reason: 'Chaining support access to muddy the audit trail',
    });
    expect(res.status).toBe(403);
  });

  it('records the start in the gym’s own audit log, under the operator’s name', async () => {
    const row = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, SHARK), eq(schema.auditLog.action, 'support.impersonation.started')))
      .orderBy(sql`${schema.auditLog.at} desc`)
      .get()!;
    // The gym can read what support did to it. A support tool whose activity
    // only the vendor can see is one nobody should agree to.
    expect(row.reason).toMatch(/duplicate invoice/);
    expect(row.changes.some((c) => c.field === 'operator' && /Noel/.test(c.to))).toBe(true);
  });

  it('marks anything the borrowed session writes as done via support', async () => {
    await patch(borrowed, '/v1/admin/settings/business', { displayName: 'Shark Fitness' });
    const row = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, SHARK), eq(schema.auditLog.action, 'tenant.updated')))
      .orderBy(sql`${schema.auditLog.at} desc`)
      .get()!;
    expect(row.actorName).toMatch(/via support/);
  });

  it('ends on request, and the session stops working immediately', async () => {
    expect((await post(borrowed, '/v1/platform/impersonate/end', {})).status).toBe(200);
    expect((await get(borrowed, '/v1/me')).status).toBe(401);

    const row = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, SHARK), eq(schema.auditLog.action, 'support.impersonation.ended')))
      .orderBy(sql`${schema.auditLog.at} desc`)
      .get();
    expect(row).toBeDefined();
  });

  it('expires on its own clock, mid-session, without anybody ending it', async () => {
    const target = shark().ownerUserId;
    const res = await post(support, '/v1/platform/impersonate', {
      userId: target,
      reason: 'Checking the expiry behaviour end to end',
    });
    const body = (await res.json()) as { csrfToken: string };
    const token = (res.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
    const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
    expect((await get(session, '/v1/me')).status).toBe(200);

    // Wind the clock past the window rather than waiting an hour.
    db.update(schema.sessions)
      .set({ impersonationExpiresAt: now() - 1000 })
      .where(sql`${schema.sessions.impersonatorId} is not null and ${schema.sessions.revokedAt} is null`)
      .run();

    expect((await get(session, '/v1/me')).status).toBe(401);
    expect((await get(session, '/v1/admin/members')).status).toBe(401);
  });

  it('refuses to enter another platform account', async () => {
    const otherOperator = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, 'ten_platform'), eq(schema.users.email, 'platform@sharkfitness.io')))
      .get()!;
    const res = await post(support, '/v1/platform/impersonate', {
      userId: otherOperator.id,
      reason: 'Trying to borrow a colleague’s administrative authority',
    });
    expect(res.status).toBe(403);
  });

  it('refuses a reason nobody could act on', async () => {
    const res = await post(support, '/v1/platform/impersonate', { userId: shark().ownerUserId, reason: 'test' });
    expect(res.status).toBe(422);
  });

  it('refuses to end a session that is not a support session', async () => {
    expect((await post(owner, '/v1/platform/impersonate/end', {})).status).toBe(412);
  });
});

/* ——— Cross-tenant isolation ————————————————————————————— */

describe('PF-PLAT — cross-tenant reads exist only here', () => {
  it('shows the operator both customers', async () => {
    const body = (await (await get(admin, '/v1/platform/tenants')).json()) as { items: Array<{ id: string; displayName: string }> };
    const ids = body.items.map((t) => t.id);
    expect(ids).toContain(SHARK);
    expect(ids).toContain(REEF);
  });

  it('does not show the operator its own record among its customers', async () => {
    const body = (await (await get(admin, '/v1/platform/tenants')).json()) as { items: Array<{ id: string }> };
    expect(body.items.map((t) => t.id)).not.toContain('ten_platform');
  });

  it('refuses a platform read of the operator’s own tenant by id', async () => {
    expect((await get(admin, '/v1/platform/tenants/ten_platform')).status).toBe(404);
  });

  it('keeps one gym’s members invisible to another gym’s owner', async () => {
    // The property the second seeded tenant exists to make testable at all.
    const reefMember = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(eq(schema.members.tenantId, REEF))
      .limit(1)
      .get()!;
    expect((await get(owner, `/v1/admin/members/${reefMember.id}`)).status).toBe(404);

    const sharkMember = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, SHARK), isNull(schema.members.deletedAt)))
      .limit(1)
      .get()!;
    expect((await get(reefOwner, `/v1/admin/members/${sharkMember.id}`)).status).toBe(404);
  });

  it('keeps each gym’s directory to its own members', async () => {
    const sharkList = (await (await get(owner, '/v1/admin/members?limit=100')).json()) as { total: number };
    const reefList = (await (await get(reefOwner, '/v1/admin/members?limit=100')).json()) as { total: number; items: Array<{ memberNo: string }> };
    expect(reefList.total).toBe(2);
    expect(reefList.items.every((m) => m.memberNo.startsWith('RF-'))).toBe(true);
    expect(sharkList.total).toBeGreaterThan(2);
  });
});

/* ——— Tenant lifecycle (PF-PLAT-001) ————————————————————— */

describe('PF-PLAT-001 — tenant lifecycle', () => {
  const statusOf = (tenantId: string): string =>
    db.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()!.status;

  it('suspends a gym with a reason, and signs everyone in it out', async () => {
    const res = await post(admin, `/v1/platform/tenants/${REEF}/status`, {
      status: 'suspended',
      reason: 'Three failed platform payments, contract clause 7',
      approvedBy: 'Ira Sundaram',
    });
    expect(res.status).toBe(200);
    expect(statusOf(REEF)).toBe('suspended');

    // "Suspended at next login" is not what anybody suspending a gym means.
    expect((await get(reefOwner, '/v1/admin/members')).status).toBe(401);
  });

  it('records the suspension in the gym’s own audit log', async () => {
    const row = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, REEF), eq(schema.auditLog.action, 'platform.tenant.suspended')))
      .orderBy(sql`${schema.auditLog.at} desc`)
      .get()!;
    expect(row.reason).toMatch(/clause 7/);
    expect(row.changes.some((c) => c.field === 'approvedBy' && c.to === 'Ira Sundaram')).toBe(true);
  });

  it('deletes nothing when it suspends', async () => {
    expect(
      db.select({ n: sql<number>`count(*)` }).from(schema.members).where(eq(schema.members.tenantId, REEF)).get()!.n,
    ).toBe(2);
  });

  it('restores a suspended gym and lets its owner back in', async () => {
    const res = await post(admin, `/v1/platform/tenants/${REEF}/status`, {
      status: 'active',
      reason: 'Payment cleared and the account is current again',
    });
    expect(res.status).toBe(200);
    const back = await signIn('owner@reefathletic.in', 'reef');
    expect((await get(back, '/v1/admin/members')).status).toBe(200);
  });

  it('refuses an illegal transition', async () => {
    const res = await post(admin, `/v1/platform/tenants/${REEF}/status`, { status: 'trial', reason: 'Putting them back on trial' });
    expect(res.status).toBe(412);
  });

  it('refuses to archive a gym with an account under legal hold, and cannot be talked round', async () => {
    const held = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.tenantId, REEF)).limit(1).get()!;
    db.update(schema.users).set({ accountState: 'legal_hold' }).where(eq(schema.users.id, held.id)).run();
    try {
      const res = await post(admin, `/v1/platform/tenants/${REEF}/status`, {
        status: 'archived',
        reason: 'Customer asked us to delete everything today',
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/legal hold/);
      expect(statusOf(REEF)).toBe('active');
    } finally {
      db.update(schema.users).set({ accountState: 'active' }).where(eq(schema.users.id, held.id)).run();
    }
  });
});

/* ——— Entitlements and meters (PF-PLAT-002) ————————————————— */

describe('PF-PLAT-002 — plans, flags, quotas and meters', () => {
  it('reads a zero quota as unmetered rather than as exceeded', async () => {
    const body = (await (await get(admin, `/v1/platform/tenants/${REEF}`)).json()) as {
      tenant: { meters: Array<{ meter: string; health: string; percent: number | null }> };
    };
    const video = body.tenant.meters.find((m) => m.meter === 'video_minutes');
    if (video) {
      expect(video.health).toBe('unmetered');
      expect(video.percent).toBeNull();
    }
    // Reef is seeded over its AI quota and near its SMS one.
    expect(body.tenant.meters.find((m) => m.meter === 'ai_calls')!.health).toBe('exceeded');
    expect(body.tenant.meters.find((m) => m.meter === 'sms')!.health).toBe('approaching');
  });

  it('raises a quota and moves the meter it is read against', async () => {
    const res = await patch(admin, `/v1/platform/tenants/${REEF}/entitlements`, {
      quotas: { aiCallsPerMonth: 1000 },
      reason: 'Upgraded on the new contract',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant: { quotas: Record<string, number>; meters: Array<{ meter: string; limit: number; health: string }> } };
    expect(body.tenant.quotas.aiCallsPerMonth).toBe(1000);
    // A quota the meters do not follow is a number on a screen.
    const ai = body.tenant.meters.find((m) => m.meter === 'ai_calls')!;
    expect(ai.limit).toBe(1000);
    expect(ai.health).toBe('ok');
  });

  it('turns a feature on without disturbing the others', async () => {
    const before = (await (await get(admin, `/v1/platform/tenants/${REEF}`)).json()) as { tenant: { featureFlags: Record<string, boolean> } };
    const res = await patch(admin, `/v1/platform/tenants/${REEF}/entitlements`, {
      featureFlags: { pos: true },
      reason: 'Bought the till add-on',
    });
    const after = (await res.json()) as { tenant: { featureFlags: Record<string, boolean> } };
    expect(after.tenant.featureFlags.pos).toBe(true);
    expect(after.tenant.featureFlags.classes).toBe(before.tenant.featureFlags.classes);
  });

  it('refuses an entitlement change with no reason', async () => {
    expect((await patch(admin, `/v1/platform/tenants/${REEF}/entitlements`, { plan: 'scale' })).status).toBe(422);
  });
});

/* ——— Observability (PF-PLAT-003) ————————————————————————— */

describe('PF-PLAT-003 — platform health', () => {
  it('reports tenants, activity, jobs and queue depth', async () => {
    const body = (await (await get(admin, '/v1/platform/health')).json()) as {
      tenants: { total: number }; members: number; jobs: Array<{ name: string; everyMinutes: number }>;
      outboxPending: number; activeSupportSessions: number;
    };
    expect(body.tenants.total).toBeGreaterThanOrEqual(2);
    expect(body.members).toBeGreaterThan(0);
    // A job list nobody can see is a job list nobody notices has stopped.
    expect(body.jobs.map((j) => j.name)).toContain('roll-up-metrics');
    expect(body.jobs.every((j) => j.everyMinutes > 0)).toBe(true);
    expect(body.outboxPending).toBeGreaterThanOrEqual(0);
    expect(body.activeSupportSessions).toBeGreaterThanOrEqual(0);
  });

  it('surfaces only the meters that need attention', async () => {
    const body = (await (await get(admin, '/v1/platform/health')).json()) as {
      metersNeedingAttention: Array<{ tenantName: string; health: string }>;
    };
    expect(body.metersNeedingAttention.every((m) => m.health === 'approaching' || m.health === 'exceeded')).toBe(true);
  });

  it('is refused to platform support, who may enter accounts and not administer', async () => {
    expect((await get(support, '/v1/platform/health')).status).toBe(403);
    expect((await get(support, '/v1/platform/tenants')).status).toBe(403);
  });
});

/* ——— Immutability (PF-PLAT-006) ————————————————————————— */

describe('PF-PLAT-006 — super-admin tooling bypasses no immutable control', () => {
  it('offers no platform route that edits an invoice, a ledger or an audit row', async () => {
    for (const path of ['/v1/platform/invoices', '/v1/platform/audit/delete', '/v1/platform/ledger']) {
      expect([404, 403]).toContain((await get(admin, path)).status);
    }
  });

  it('cannot update an audit row even from inside the database layer', () => {
    const row = db.select().from(schema.auditLog).limit(1).get()!;
    // The trigger does not check who is asking, and there is no path here that
    // would want it to.
    expect(() =>
      db.update(schema.auditLog).set({ reason: 'rewritten by support' }).where(eq(schema.auditLog.id, row.id)).run(),
    ).toThrow();
  });

  it('leaves a paid invoice paid through every platform action available', async () => {
    const before = db
      .select({ id: schema.invoices.id, paidMinor: schema.invoices.paidMinor, state: schema.invoices.state })
      .from(schema.invoices)
      .where(eq(schema.invoices.tenantId, SHARK))
      .limit(1)
      .get()!;

    await patch(admin, `/v1/platform/tenants/${SHARK}/entitlements`, { plan: 'starter', reason: 'Downgrade test' });
    await post(admin, `/v1/platform/tenants/${SHARK}/status`, { status: 'suspended', reason: 'Immutability probe, restored below' });
    await post(admin, `/v1/platform/tenants/${SHARK}/status`, { status: 'active', reason: 'Restoring after the probe' });

    const after = db
      .select({ id: schema.invoices.id, paidMinor: schema.invoices.paidMinor, state: schema.invoices.state })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, before.id))
      .get()!;
    expect(after).toEqual(before);
  });
});
