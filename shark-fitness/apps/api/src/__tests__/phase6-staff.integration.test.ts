import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { now } from '../lib/time.js';

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

const get = (session: Session, path: string) => app.request(path, { headers: headers(session) });
const post = (session: Session, path: string, body: unknown, idempotencyKey?: string) =>
  app.request(path, { method: 'POST', headers: { ...headers(session, true), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, body: JSON.stringify(body) });
const patch = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(session, true), body: JSON.stringify(body) });

function tenantId(): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

let uniqueCounter = 0;
function uniqueEmail(): string {
  uniqueCounter += 1;
  return `phase6-staff-${now()}-${uniqueCounter}@sharkfitness.in`;
}

describe('Phase 6 — staff directory, employment and availability', () => {
  it('creates a staff member and lists them scoped to branch', async () => {
    const owner = await signIn('owner@sharkfitness.in');

    const created = await post(owner, '/v1/admin/staff', {
      name: 'Test Trainer One',
      email: uniqueEmail(),
      phone: null,
      role: 'trainer',
      branchIds: ['br_kor'],
      specialties: ['Mobility'],
    });
    expect(created.status).toBe(201);
    const { staff } = (await created.json()) as { staff: { id: string } };

    const list = await get(owner, '/v1/admin/staff?branchId=br_kor');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ id: string; name: string }> };
    expect(body.items.some((s) => s.id === staff.id)).toBe(true);
  });

  it('replays a staff invite for the same idempotency key instead of creating another account', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const body = { name: 'Idempotent Staff', email: uniqueEmail(), phone: null, role: 'reception', branchIds: ['br_kor'], specialties: [] };
    const first = await post(owner, '/v1/admin/staff', body, 'phase6-staff-invite-replay');
    const replay = await post(owner, '/v1/admin/staff', body, 'phase6-staff-invite-replay');
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { staff: { id: string } }).staff.id).toBe(((await first.json()) as { staff: { id: string } }).staff.id);
  });

  it('rejects invalid tenant roles and branch assignments', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const invalidRole = await post(owner, '/v1/admin/staff', { name: 'Platform account', email: uniqueEmail(), phone: null, role: 'platform_admin', branchIds: ['br_kor'], specialties: [] });
    expect(invalidRole.status).toBe(422);

    const invalidBranch = await post(owner, '/v1/admin/staff', { name: 'Unknown branch account', email: uniqueEmail(), phone: null, role: 'trainer', branchIds: ['br_not_a_branch'], specialties: [] });
    expect(invalidBranch.status).toBe(422);
  });

  it('rejects a branch-scoped directory query outside the caller scope', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const response = await get(manager, '/v1/admin/staff?branchId=br_ind');
    expect(response.status).toBe(403);
  });

  it('cannot disable the current user', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const ownerRow = db.select({ id: schema.staff.id }).from(schema.staff).innerJoin(schema.users, eq(schema.users.id, schema.staff.userId)).where(eq(schema.users.email, 'owner@sharkfitness.in')).get()!;
    const response = await patch(owner, `/v1/admin/staff/${ownerRow.id}`, { accountState: 'disabled' });
    expect(response.status).toBe(422);
  });

  it('refuses staff creation to a branch manager, who only has staff.view', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const response = await post(manager, '/v1/admin/staff', {
      name: 'Should Not Exist',
      email: uniqueEmail(),
      phone: null,
      role: 'trainer',
      branchIds: ['br_kor'],
      specialties: [],
    });
    expect(response.status).toBe(403);
  });

  it('updates employment status, and lets an owner set commission rules', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const created = await post(owner, '/v1/admin/staff', {
      name: 'Test Trainer Two',
      email: uniqueEmail(),
      phone: null,
      role: 'trainer',
      branchIds: ['br_kor'],
      specialties: [],
    });
    const { staff } = (await created.json()) as { staff: { id: string } };

    const response = await patch(owner, `/v1/admin/staff/${staff.id}`, {
      employmentStatus: 'on_leave',
      commissionRules: [{ kind: 'session', ratePct: 15 }],
      hourlyRateMinor: 50000,
    });
    expect(response.status).toBe(200);

    const detail = await get(owner, `/v1/admin/staff/${staff.id}`);
    const detailBody = (await detail.json()) as {
      staff: { employmentStatus: string; commissionRules: Array<{ kind: string; ratePct: number }> };
    };
    expect(detailBody.staff.employmentStatus).toBe('on_leave');
    expect(detailBody.staff.commissionRules).toEqual([{ kind: 'session', ratePct: 15 }]);
  });

  it('hides commission rules from a viewer who lacks staff.commission', async () => {
    // Reception has neither staff.view nor staff.manage, so use a role that
    // has staff.view but not staff.commission: branch_manager.
    const manager = await signIn('manager@sharkfitness.in');
    const trainerRow = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.users.role, 'trainer')))
      .get()!;

    const detail = await get(manager, `/v1/admin/staff/${trainerRow.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { staff: { commissionRules: unknown[]; hourlyRateMinor: number | null } };
    expect(body.staff.commissionRules).toEqual([]);
    expect(body.staff.hourlyRateMinor).toBeNull();
  });

  it('hides a staff member at another branch behind a 404', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const foreign = db
      .select({ id: schema.staff.id, branchIds: schema.staff.branchIds })
      .from(schema.staff)
      .where(eq(schema.staff.tenantId, tenantId()))
      .all()
      .find((s) => !s.branchIds.includes('br_kor'));
    if (!foreign) return;

    const response = await get(manager, `/v1/admin/staff/${foreign.id}`);
    expect(response.status).toBe(404);
  });

  it('creates a shift and refuses one that overlaps the same person', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const created = await post(owner, '/v1/admin/staff', {
      name: 'Test Trainer Three',
      email: uniqueEmail(),
      phone: null,
      role: 'trainer',
      branchIds: ['br_kor'],
      specialties: [],
    });
    const { staff } = (await created.json()) as { staff: { id: string } };

    const startsAt = new Date(now() + 400 * 24 * 3_600_000).toISOString();
    const endsAt = new Date(now() + 400 * 24 * 3_600_000 + 4 * 3_600_000).toISOString();

    const first = await post(owner, `/v1/admin/staff/${staff.id}/shifts`, {
      branchId: 'br_kor',
      startsAt,
      endsAt,
      role: 'floor',
      note: null,
    });
    expect(first.status).toBe(201);

    const overlapStart = new Date(new Date(startsAt).getTime() + 60 * 60_000).toISOString();
    const overlapEnd = new Date(new Date(endsAt).getTime() + 60 * 60_000).toISOString();
    const overlapping = await post(owner, `/v1/admin/staff/${staff.id}/shifts`, {
      branchId: 'br_kor',
      startsAt: overlapStart,
      endsAt: overlapEnd,
      role: 'floor',
      note: null,
    });
    expect(overlapping.status).toBe(409);
  });
});
