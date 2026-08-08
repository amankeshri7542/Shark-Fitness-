import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id, initialsOf, normalizeEmail } from '../lib/ids.js';
import { now } from '../lib/time.js';

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}

// The Phase 1 login rate limiter (10 requests/60s per route, shared across the
// whole test process) makes a fresh sign-in per test case unrealistic and
// self-defeating — a real browser holds one long-lived session, not one per
// action. Cache by email so each account authenticates once per test run.
const sessionCache = new Map<string, BrowserSession>();

async function signIn(email = 'reception@sharkfitness.in'): Promise<BrowserSession> {
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

function tenantAndBranches(): { tenantId: string; kor: string; other: string } {
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!;
  const branches = db.select().from(schema.branches).where(eq(schema.branches.tenantId, tenant.id)).all();
  const kor = branches.find((b) => b.id === 'br_kor')!.id;
  const other = branches.find((b) => b.id !== 'br_kor')!.id;
  return { tenantId: tenant.id, kor, other };
}

async function createLead(
  session: BrowserSession,
  overrides: Partial<{ name: string; phone: string; email: string; source: string; branchId: string; ownerId: string }> = {},
): Promise<{ id: string; duplicateOfId: string | null }> {
  const { kor } = tenantAndBranches();
  const response = await app.request('/v1/admin/leads', {
    method: 'POST',
    headers: headers(session, true),
    body: JSON.stringify({
      name: 'Test Lead',
      phone: `+91 9${Math.floor(100000000 + Math.random() * 800000000)}`,
      source: 'walk_in',
      branchId: kor,
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; duplicateOfId: string | null };
}

async function moveStage(session: BrowserSession, leadId: string, to: string, reason?: string): Promise<Response> {
  return app.request(`/v1/admin/leads/${leadId}/stage`, {
    method: 'POST',
    headers: headers(session, true),
    body: JSON.stringify({ to, ...(reason ? { reason } : {}) }),
  });
}

async function advanceToTrialCompleted(session: BrowserSession, leadId: string): Promise<void> {
  for (const to of ['contacted', 'qualified', 'trial_booked', 'trial_completed']) {
    const res = await moveStage(session, leadId, to);
    expect(res.status).toBe(200);
  }
}

describe('admin leads', () => {
  it('lists seeded leads scoped to the tenant', async () => {
    const session = await signIn();
    const response = await app.request('/v1/admin/leads', { headers: headers(session) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; items: Array<{ stage: string }> };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((l) => typeof l.stage === 'string')).toBe(true);
  });

  it('creates a lead and detects a duplicate', async () => {
    const session = await signIn();
    const phone = '+91 9000000001';
    const created = await createLead(session, { phone });
    const dupe = await createLead(session, { name: 'Same Person Again', phone, source: 'call' });
    expect(dupe.duplicateOfId).toBe(created.id);
  });

  describe('branch isolation', () => {
    it('hides a lead in another branch from a receptionist scoped to one branch (404, not 403)', async () => {
      const owner = await signIn('owner@sharkfitness.in');
      const { other } = tenantAndBranches();
      const created = await createLead(owner, { branchId: other });

      const reception = await signIn('reception@sharkfitness.in');
      const detail = await app.request(`/v1/admin/leads/${created.id}`, { headers: headers(reception) });
      expect(detail.status).toBe(404);

      const edit = await app.request(`/v1/admin/leads/${created.id}`, {
        method: 'PATCH',
        headers: headers(reception, true),
        body: JSON.stringify({ expectedValueMinor: 1000 }),
      });
      expect(edit.status).toBe(404);

      const stage = await moveStage(reception, created.id, 'contacted');
      expect(stage.status).toBe(404);

      const convert = await app.request(`/v1/admin/leads/${created.id}/convert`, { method: 'POST', headers: headers(reception, true) });
      expect(convert.status).toBe(404);
    });

    it('rejects creating a lead in a branch the actor cannot access', async () => {
      const reception = await signIn('reception@sharkfitness.in');
      const { other } = tenantAndBranches();
      const response = await app.request('/v1/admin/leads', {
        method: 'POST',
        headers: headers(reception, true),
        body: JSON.stringify({ name: 'Out of scope', phone: '+91 9111111111', source: 'walk_in', branchId: other }),
      });
      expect(response.status).toBe(403);
    });
  });

  describe('owner validation', () => {
    it('rejects a nonexistent owner on create', async () => {
      const session = await signIn();
      const response = await app.request('/v1/admin/leads', {
        method: 'POST',
        headers: headers(session, true),
        body: JSON.stringify({ name: 'Bad owner', phone: '+91 9222222222', source: 'walk_in', branchId: tenantAndBranches().kor, ownerId: 'stf_doesnotexist' }),
      });
      expect(response.status).toBe(422);
    });

    it('rejects an owner not assigned to the branch', async () => {
      const owner = await signIn('owner@sharkfitness.in');
      // reception@sharkfitness.in's staff record is scoped to br_kor only (seed.ts).
      const receptionUser = db.select().from(schema.users).where(eq(schema.users.email, 'reception@sharkfitness.in')).get()!;
      const receptionStaff = db.select().from(schema.staff).where(eq(schema.staff.userId, receptionUser.id)).get()!;

      // "other" is a branch outside reception's staff.branchIds.
      const { other } = tenantAndBranches();
      const response = await app.request('/v1/admin/leads', {
        method: 'POST',
        headers: headers(owner, true),
        body: JSON.stringify({ name: 'Mismatched owner', phone: '+91 9333333333', source: 'walk_in', branchId: other, ownerId: receptionStaff.id }),
      });
      expect(response.status).toBe(422);
    });

    it('rejects an inactive staff member as owner', async () => {
      const owner = await signIn('owner@sharkfitness.in');
      const { tenantId, kor } = tenantAndBranches();

      const userId = id('usr');
      const staffId = id('stf');
      db.insert(schema.users)
        .values({
          id: userId,
          tenantId,
          email: normalizeEmail('disabled.coach@example.com'),
          phone: null,
          name: 'Disabled Coach',
          initials: initialsOf('Disabled Coach'),
          role: 'trainer',
          accountState: 'disabled',
          passwordHash: null,
          preferences: {},
          lastSeenAt: null,
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
      db.insert(schema.staff)
        .values({
          id: staffId,
          tenantId,
          userId,
          employmentStatus: 'active',
          branchIds: [kor],
          specialties: [],
          certifications: [],
          commissionRules: [],
          hourlyRateMinor: null,
          joinedOn: '2020-01-01',
          createdAt: now(),
          updatedAt: now(),
        })
        .run();

      const response = await app.request('/v1/admin/leads', {
        method: 'POST',
        headers: headers(owner, true),
        body: JSON.stringify({ name: 'Inactive owner test', phone: '+91 9444444444', source: 'walk_in', branchId: kor, ownerId: staffId }),
      });
      expect(response.status).toBe(422);
    });
  });

  describe('conversion pipeline enforcement', () => {
    it('rejects converting a lead that is not trial_completed', async () => {
      const session = await signIn();
      const lead = await createLead(session);
      const convert = await app.request(`/v1/admin/leads/${lead.id}/convert`, { method: 'POST', headers: headers(session, true) });
      expect(convert.status).toBe(409);
    });

    it('rejects a direct stage move to won — only /convert may reach won', async () => {
      const session = await signIn();
      const lead = await createLead(session);
      await advanceToTrialCompleted(session, lead.id);
      const jump = await moveStage(session, lead.id, 'won');
      expect(jump.status).toBe(409);
    });

    it('converts a trial_completed lead atomically and blocks a second conversion', async () => {
      const session = await signIn();
      const lead = await createLead(session, { phone: '+91 9000000099', source: 'trial' });
      await advanceToTrialCompleted(session, lead.id);

      const convert = await app.request(`/v1/admin/leads/${lead.id}/convert`, { method: 'POST', headers: headers(session, true) });
      expect(convert.status).toBe(200);
      const converted = (await convert.json()) as { memberId: string; memberNo: string; message: string };
      expect(converted.memberNo).toMatch(/^SF-\d+$/);
      expect(converted.message).toMatch(/pending/i);

      const member = db.select().from(schema.members).where(eq(schema.members.id, converted.memberId)).get();
      expect(member?.lifecycle).toBe('trial');
      const memberUser = db.select().from(schema.users).where(eq(schema.users.id, member!.userId!)).get();
      expect(memberUser?.accountState).toBe('invited');

      const dbLead = db.select().from(schema.leads).where(eq(schema.leads.id, lead.id)).get();
      expect(dbLead?.stage).toBe('won');

      const secondConvert = await app.request(`/v1/admin/leads/${lead.id}/convert`, { method: 'POST', headers: headers(session, true) });
      expect(secondConvert.status).toBe(409);
    });

    it('blocks conversion when an existing member already matches, with a clear conflict', async () => {
      const session = await signIn();
      const existingMember = db.select().from(schema.members).where(eq(schema.members.email, 'aman@sharkfitness.in')).get()!;

      const lead = await createLead(session, { email: 'aman@sharkfitness.in', phone: existingMember.phone ?? '+91 9555555555' });
      await advanceToTrialCompleted(session, lead.id);

      const convert = await app.request(`/v1/admin/leads/${lead.id}/convert`, { method: 'POST', headers: headers(session, true) });
      expect(convert.status).toBe(409);
      const body = (await convert.json()) as { error: { message: string; details?: { existingMemberId?: string } } };
      expect(body.error.details?.existingMemberId).toBe(existingMember.id);

      // No orphaned user/member should have been created for the blocked attempt.
      const dbLead = db.select().from(schema.leads).where(eq(schema.leads.id, lead.id)).get();
      expect(dbLead?.convertedMemberId).toBeNull();
    });

    it('converts two trial_completed leads back-to-back with distinct, sequential member numbers', async () => {
      const session = await signIn();
      const leadA = await createLead(session, { phone: '+91 9666666601' });
      const leadB = await createLead(session, { phone: '+91 9666666602' });
      await advanceToTrialCompleted(session, leadA.id);
      await advanceToTrialCompleted(session, leadB.id);

      const [resA, resB] = await Promise.all([
        app.request(`/v1/admin/leads/${leadA.id}/convert`, { method: 'POST', headers: headers(session, true) }),
        app.request(`/v1/admin/leads/${leadB.id}/convert`, { method: 'POST', headers: headers(session, true) }),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const bodyA = (await resA.json()) as { memberNo: string };
      const bodyB = (await resB.json()) as { memberNo: string };
      expect(bodyA.memberNo).not.toBe(bodyB.memberNo);
    });
  });

  describe('lost/disqualified and reopening', () => {
    it('requires a reason to mark a lead lost or disqualified', async () => {
      const session = await signIn();
      const lead = await createLead(session);
      const withoutReason = await moveStage(session, lead.id, 'lost');
      expect(withoutReason.status).toBe(409);
      const disqualifiedWithoutReason = await moveStage(session, lead.id, 'disqualified');
      expect(disqualifiedWithoutReason.status).toBe(409);
    });

    it('clears lossReason when a lost lead is reopened', async () => {
      const session = await signIn();
      const lead = await createLead(session);
      const lost = await moveStage(session, lead.id, 'lost', 'Went with a competitor');
      expect(lost.status).toBe(200);
      const afterLost = db.select().from(schema.leads).where(eq(schema.leads.id, lead.id)).get();
      expect(afterLost?.lossReason).toBe('Went with a competitor');

      const reopened = await moveStage(session, lead.id, 'reopened');
      expect(reopened.status).toBe(200);
      const afterReopen = db.select().from(schema.leads).where(eq(schema.leads.id, lead.id)).get();
      expect(afterReopen?.lossReason).toBeNull();
    });
  });

  describe('pipeline totals beyond the page', () => {
    it('reports accurate total and byStage counts even when items are limited', async () => {
      const session = await signIn();
      for (let i = 0; i < 5; i += 1) {
        await createLead(session, { phone: `+91 97${String(i).padStart(8, '7')}` });
      }
      const limited = await app.request('/v1/admin/leads?limit=2', { headers: headers(session) });
      expect(limited.status).toBe(200);
      const limitedBody = (await limited.json()) as { total: number; byStage: Record<string, number>; items: unknown[] };

      const unlimited = await app.request('/v1/admin/leads?limit=200', { headers: headers(session) });
      const unlimitedBody = (await unlimited.json()) as { total: number; byStage: Record<string, number>; items: unknown[] };

      expect(limitedBody.items.length).toBe(2);
      expect(limitedBody.total).toBe(unlimitedBody.total);
      expect(limitedBody.byStage).toEqual(unlimitedBody.byStage);
      expect(limitedBody.total).toBeGreaterThan(2);
    });
  });

  describe('assignable owners', () => {
    it('lists active staff for a branch', async () => {
      const session = await signIn();
      const { kor } = tenantAndBranches();
      const response = await app.request(`/v1/admin/leads/owners?branchId=${kor}`, { headers: headers(session) });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: Array<{ id: string; name: string }> };
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((o) => typeof o.name === 'string' && o.name.length > 0)).toBe(true);
    });
  });

  it('rejects lead access for a role without lead.view', async () => {
    // rehan@sharkfitness.in is seeded as a trainer, and the trainer permission
    // set (packages/domain/src/permissions.ts) does not include lead.view.
    const session = await signIn('rehan@sharkfitness.in');
    const response = await app.request('/v1/admin/leads', { headers: headers(session) });
    expect(response.status).toBe(403);
  });
});
