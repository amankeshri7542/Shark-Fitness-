import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

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
  const session = {
    cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`,
    csrfToken: body.csrfToken,
  };
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
  app.request(path, {
    method: 'POST',
    headers: headers(session, true),
    body: JSON.stringify(body),
  });

beforeAll(() => {
  // Successful check-in tests must not depend on the CI runner's local hour.
  db.update(schema.branches).set({ opensMinutes: 0, closesMinutes: 24 * 60 }).run();
});

function tenantId(): string {
  return db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, 'shark'))
    .get()!.id;
}

function idleEntitledMember(branchId: string): { id: string; memberNo: string } {
  const antiPassbackCutoff = now() - 2 * 60_000;
  const row = db
    .select({ id: schema.members.id, memberNo: schema.members.memberNo })
    .from(schema.members)
    .innerJoin(schema.memberships, eq(schema.memberships.memberId, schema.members.id))
    .where(
      and(
        eq(schema.members.homeBranchId, branchId),
        isNull(schema.members.deletedAt),
        eq(schema.memberships.state, 'active'),
        sql`not exists (
          select 1 from invoices i
          where i.member_id = ${schema.members.id}
            and i.state in ('open','partially_paid','overdue')
            and i.total_minor > i.paid_minor
        )`,
        sql`not exists (
          select 1 from check_ins c
          where c.member_id = ${schema.members.id}
            and c.decision = 'granted'
            and c.exited_at is null
        )`,
        sql`not exists (
          select 1 from check_ins recent
          where recent.member_id = ${schema.members.id}
            and recent.decision = 'granted'
            and recent.entered_at > ${antiPassbackCutoff}
        )`,
      ),
    )
    .get();

  if (!row) throw new Error(`seed has no idle entitled member at ${branchId}`);
  return row;
}

function blockedMember(branchId: string): { id: string; memberNo: string } {
  const row = db
    .select({ id: schema.members.id, memberNo: schema.members.memberNo })
    .from(schema.members)
    .innerJoin(schema.memberships, eq(schema.memberships.memberId, schema.members.id))
    .where(
      and(
        eq(schema.members.homeBranchId, branchId),
        isNull(schema.members.deletedAt),
        sql`${schema.memberships.state} in ('expired','suspended','frozen','pending_payment')`,
        sql`not exists (
          select 1 from check_ins c
          where c.member_id = ${schema.members.id}
            and c.decision = 'granted'
            and c.exited_at is null
        )`,
      ),
    )
    .get();

  if (!row) throw new Error(`seed has no blocked member at ${branchId}`);
  return row;
}

function insertGrantedVisit(memberId: string, branchId = 'br_kor', enteredAt = now() - 5 * 60_000): string {
  const checkInId = id('chk');
  db.insert(schema.checkIns)
    .values({
      id: checkInId,
      tenantId: tenantId(),
      branchId,
      memberId,
      method: 'staff',
      decision: 'granted',
      enteredAt,
      exitedAt: null,
      autoClosed: false,
      overrideById: null,
      overrideByName: null,
      overrideReason: null,
      visitNumber: 1,
    })
    .run();
  return checkInId;
}

describe('Phase 4 — front desk attendance', () => {
  it('checks a member in from the desk and records the visit', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const member = idleEntitledMember('br_kor');

    const response = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
      method: 'staff',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      granted: boolean;
      checkInId: string;
      replayed: boolean;
      visitNumber: number;
    };
    expect(body.granted).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.visitNumber).toBeGreaterThan(0);

    const row = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, body.checkInId)).get();
    expect(row?.method).toBe('staff');
    expect(row?.decision).toBe('granted');
    expect(row?.exitedAt).toBeNull();
  });

  it('treats an immediate repeat as the same visit rather than a second entry', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const member = idleEntitledMember('br_kor');

    const first = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
    });
    const firstBody = (await first.json()) as { checkInId: string };

    const retry = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { checkInId: string; replayed: boolean };
    expect(retryBody.replayed).toBe(true);
    expect(retryBody.checkInId).toBe(firstBody.checkInId);

    const open = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.checkIns)
      .where(and(eq(schema.checkIns.memberId, member.id), isNull(schema.checkIns.exitedAt)))
      .get();
    expect(open?.n).toBe(1);
  });

  it('refuses a second entry once the retry window has passed', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const member = idleEntitledMember('br_kor');

    const entry = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
    });
    const { checkInId } = (await entry.json()) as { checkInId: string };

    db.update(schema.checkIns)
      .set({ enteredAt: now() - 10 * 60_000 })
      .where(eq(schema.checkIns.id, checkInId))
      .run();

    const response = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('already checked in');
  });

  it('closes a granted visit and stays idempotent on a repeated check-out', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const member = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId()), eq(schema.members.homeBranchId, 'br_kor')))
      .get()!;
    const checkInId = insertGrantedVisit(member.id);

    const first = await post(reception, '/v1/admin/attendance/check-out', { checkInId });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { replayed: boolean }).replayed).toBe(false);

    const second = await post(reception, '/v1/admin/attendance/check-out', { checkInId });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { replayed: boolean; exitedAt: string };
    expect(secondBody.replayed).toBe(true);

    const row = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).get();
    expect(row?.exitedAt).not.toBeNull();
    expect(new Date(secondBody.exitedAt).getTime()).toBe(row?.exitedAt);
  });

  it('records a refusal instead of admitting an unentitled member', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const member = blockedMember('br_kor');

    const response = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      granted: boolean;
      decision: string;
      canOverride: boolean;
      checkInId: string;
    };
    expect(body.granted).toBe(false);
    expect(body.decision.startsWith('denied_')).toBe(true);
    expect(body.canOverride).toBe(true);

    const row = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, body.checkInId)).get();
    expect(row?.decision).toBe(body.decision);
  });

  it('refuses an override to reception and allows it for a manager', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const manager = await signIn('manager@sharkfitness.in');
    const member = blockedMember('br_kor');

    const denial = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
    });
    const { checkInId } = (await denial.json()) as { checkInId: string };

    expect(
      (
        await post(reception, '/v1/admin/attendance/override', {
          checkInId,
          reason: 'Paying at the desk now',
        })
      ).status,
    ).toBe(403);

    const allowed = await post(manager, '/v1/admin/attendance/override', {
      checkInId,
      reason: 'Paying at the desk now — receipt SF-2026-00291',
    });
    expect(allowed.status).toBe(200);

    const body = (await allowed.json()) as { granted: boolean; checkInId: string };
    expect(body.granted).toBe(true);

    const entry = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, body.checkInId)).get();
    expect(entry?.overrideReason).toContain('receipt SF-2026-00291');
    expect(entry?.overrideByName).toBeTruthy();

    const original = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).get();
    expect(original?.decision.startsWith('denied_')).toBe(true);
  });

  it('rejects an override with no meaningful reason', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const reception = await signIn('reception@sharkfitness.in');
    const member = blockedMember('br_kor');

    const denial = await post(reception, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
    });
    const { checkInId } = (await denial.json()) as { checkInId: string };

    const response = await post(manager, '/v1/admin/attendance/override', { checkInId, reason: 'ok' });
    expect(response.status).toBe(422);
  });

  it('does not let a second manager reuse an already-overridden denial', async () => {
    const managerA = await signIn('manager@sharkfitness.in');
    const managerB = await signIn('owner@sharkfitness.in');
    const member = blockedMember('br_kor');

    const denial = await post(managerA, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
    });
    const { checkInId } = (await denial.json()) as { checkInId: string };

    const first = await post(managerA, '/v1/admin/attendance/override', {
      checkInId,
      reason: 'Manager A: paying now',
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { checkInId: string };
    await post(managerA, '/v1/admin/attendance/check-out', { checkInId: firstBody.checkInId });

    const second = await post(managerB, '/v1/admin/attendance/override', {
      checkInId,
      reason: 'Manager B: also paying now',
    });
    expect(second.status).toBe(409);

    const original = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).get();
    expect(original?.overrideByName).toBeTruthy();
  });

  it('never overrides a reused code', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const member = blockedMember('br_kor');
    const replayId = id('chk');

    db.insert(schema.checkIns)
      .values({
        id: replayId,
        tenantId: tenantId(),
        branchId: 'br_kor',
        memberId: member.id,
        method: 'signed_qr',
        decision: 'denied_token_replayed',
        enteredAt: now(),
        exitedAt: null,
        autoClosed: false,
        overrideById: null,
        overrideByName: null,
        overrideReason: null,
        visitNumber: null,
      })
      .run();

    const response = await post(manager, '/v1/admin/attendance/override', {
      checkInId: replayId,
      reason: 'Member insists the code is theirs',
    });
    expect(response.status).toBe(412);
  });

  it('hides members of another branch behind a 404', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const outsider = idleEntitledMember('br_ind');

    expect(
      (
        await post(reception, '/v1/admin/attendance/check-in', {
          memberId: outsider.id,
          branchId: 'br_ind',
        })
      ).status,
    ).toBe(404);
    expect((await get(reception, `/v1/admin/attendance/member/${outsider.id}`)).status).toBe(404);
  });

  it('reaches a member through an explicit member_branches grant', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const outsider = idleEntitledMember('br_ind');

    db.insert(schema.memberBranches)
      .values({ memberId: outsider.id, branchId: 'br_kor', tenantId: tenantId() })
      .run();

    try {
      const search = await get(reception, `/v1/admin/attendance/search?q=${outsider.memberNo}`);
      expect(search.status).toBe(200);
      const body = (await search.json()) as { items: Array<{ memberId: string }> };
      expect(body.items.some((item) => item.memberId === outsider.id)).toBe(true);
      expect((await get(reception, `/v1/admin/attendance/member/${outsider.id}`)).status).toBe(200);
    } finally {
      db.delete(schema.memberBranches)
        .where(and(eq(schema.memberBranches.memberId, outsider.id), eq(schema.memberBranches.branchId, 'br_kor')))
        .run();
    }
  });

  it('keeps another tenant’s check-in invisible', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const foreign = db
      .select({ id: schema.checkIns.id })
      .from(schema.checkIns)
      .where(sql`${schema.checkIns.tenantId} != ${tenantId()}`)
      .get();

    const response = await post(reception, '/v1/admin/attendance/check-out', {
      checkInId: foreign?.id ?? 'chk_does_not_exist',
    });
    expect(response.status).toBe(404);
  });

  it('reports the floor and filters the door feed to refusals', async () => {
    const reception = await signIn('reception@sharkfitness.in');

    const current = await get(reception, '/v1/admin/attendance/current');
    expect(current.status).toBe(200);
    const floor = (await current.json()) as {
      totals: { inside: number; capacity: number };
      branches: Array<{ branchId: string }>;
      items: Array<{ checkInId: string }>;
    };
    expect(floor.totals.capacity).toBeGreaterThan(0);
    expect(floor.items.length).toBe(floor.totals.inside);
    expect(floor.branches.every((branch) => branch.branchId === 'br_kor')).toBe(true);

    const denied = await get(reception, '/v1/admin/attendance?filter=denied');
    expect(denied.status).toBe(200);
    const feed = (await denied.json()) as {
      items: Array<{ granted: boolean }>;
      breakdown: { all: number; denied: number };
    };
    expect(feed.items.every((row) => row.granted === false)).toBe(true);
    expect(feed.breakdown.all).toBeGreaterThanOrEqual(feed.breakdown.denied);
  });

  it('closes every open visit during an evacuation, including stale visits', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const member = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId()), eq(schema.members.homeBranchId, 'br_kor')))
      .get()!;

    insertGrantedVisit(member.id, 'br_kor', now() - 7 * 3_600_000);

    const before = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.branchId, 'br_kor'),
          eq(schema.checkIns.decision, 'granted'),
          isNull(schema.checkIns.exitedAt),
        ),
      )
      .get();
    expect(before?.n).toBeGreaterThan(0);

    const response = await post(manager, '/v1/admin/attendance/close-all', {
      branchId: 'br_kor',
      reason: 'Fire alarm — building evacuated',
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { closed: number }).closed).toBe(before?.n);

    const after = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.branchId, 'br_kor'),
          eq(schema.checkIns.decision, 'granted'),
          isNull(schema.checkIns.exitedAt),
        ),
      )
      .get();
    expect(after?.n).toBe(0);
  });

  it('refuses a mass checkout to reception', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const response = await post(reception, '/v1/admin/attendance/close-all', {
      branchId: 'br_kor',
      reason: 'Trying it on',
    });
    expect(response.status).toBe(403);
  });
});
