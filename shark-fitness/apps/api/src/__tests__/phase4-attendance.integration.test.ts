import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

/**
 * Phase 4 — Attendance and front desk.
 *
 * Signing in per test would hit the Phase 1 login rate limiter (10/60s per
 * route, process-wide), so sessions are cached at module scope.
 */
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

const get = async (session: Session, path: string) =>
  app.request(path, { headers: headers(session) });

const post = async (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: headers(session, true), body: JSON.stringify(body) });

/**
 * Branch hours are 05:00–23:00 and access is refused outside them, so a suite
 * asserting a successful entry would fail whenever CI happens to run at night.
 * Widening the window makes these tests independent of the wall clock. Nothing
 * else asserts an hours-based denial, so this cannot mask another test.
 */
beforeAll(() => {
  db.update(schema.branches).set({ opensMinutes: 0, closesMinutes: 24 * 60 }).run();
});

/** An entitled member at `branchId` who is not currently inside. Drawn from the
 *  seed rather than fabricated, so the entitlement path is the real one. */
function idleEntitledMember(branchId: string): { id: string; memberNo: string } {
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
          select 1 from check_ins c
          where c.member_id = ${schema.members.id}
            and c.decision = 'granted'
            and c.exited_at is null
        )`,
      ),
    )
    .get();
  if (!row) throw new Error(`seed has no idle entitled member at ${branchId}`);
  return row;
}

/** A member whose membership does not entitle entry — the denial fixture. */
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

function tenantId(): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

describe('Phase 4 — front desk attendance', () => {
  it('checks a member in from the desk and records the visit', async () => {
    const session = await signIn('reception@sharkfitness.in');
    const member = idleEntitledMember('br_kor');

    const response = await post(session, '/v1/admin/attendance/check-in', {
      memberId: member.id,
      branchId: 'br_kor',
      method: 'staff',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { granted: boolean; checkInId: string; replayed: boolean; visitNumber: number };
    expect(body.granted).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.visitNumber).toBeGreaterThan(0);

    const row = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, body.checkInId)).get();
    expect(row?.method).toBe('staff');
    expect(row?.decision).toBe('granted');
    expect(row?.exitedAt).toBeNull();
  });

  it('treats an immediate repeat as the same visit rather than a second entry', async () => {
    const session = await signIn('reception@sharkfitness.in');
    const member = idleEntitledMember('br_kor');

    const first = await post(session, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
    const firstBody = (await first.json()) as { checkInId: string };

    const retry = await post(session, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
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

  it('refuses a second entry once the retry window has passed, rather than double-counting the room', async () => {
    const session = await signIn('reception@sharkfitness.in');
    const member = idleEntitledMember('br_kor');

    const entry = await post(session, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
    const { checkInId } = (await entry.json()) as { checkInId: string };

    // Age the visit past the retry window: this is no longer the same action
    // being retried, it is someone who is genuinely still inside.
    db.update(schema.checkIns)
      .set({ enteredAt: now() - 10 * 60_000 })
      .where(eq(schema.checkIns.id, checkInId))
      .run();

    const response = await post(session, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('already checked in');

    const open = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.checkIns)
      .where(and(eq(schema.checkIns.memberId, member.id), isNull(schema.checkIns.exitedAt)))
      .get();
    expect(open?.n).toBe(1);
  });

  it('closes a visit and stays idempotent on a repeated check-out', async () => {
    const session = await signIn('reception@sharkfitness.in');
    const member = idleEntitledMember('br_kor');

    const entry = await post(session, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
    const { checkInId } = (await entry.json()) as { checkInId: string };

    const first = await post(session, '/v1/admin/attendance/check-out', { checkInId });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { replayed: boolean }).replayed).toBe(false);

    const second = await post(session, '/v1/admin/attendance/check-out', { checkInId });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { replayed: boolean; exitedAt: string };
    expect(secondBody.replayed).toBe(true);

    const row = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).get();
    expect(row?.exitedAt).not.toBeNull();
    expect(new Date(secondBody.exitedAt).getTime()).toBe(row?.exitedAt);
  });

  it('records a refusal instead of admitting an unentitled member', async () => {
    const session = await signIn('reception@sharkfitness.in');
    const member = blockedMember('br_kor');

    const response = await post(session, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { granted: boolean; decision: string; canOverride: boolean; checkInId: string };
    expect(body.granted).toBe(false);
    expect(body.decision.startsWith('denied_')).toBe(true);
    expect(body.canOverride).toBe(true);

    const row = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, body.checkInId)).get();
    expect(row?.decision).toBe(body.decision);
    expect(row?.exitedAt).toBeNull();
  });

  it('refuses an override to reception and allows it for a manager, with the reason on the record', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    const manager = await signIn('manager@sharkfitness.in');
    const member = blockedMember('br_kor');

    const denial = await post(reception, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
    const { checkInId } = (await denial.json()) as { checkInId: string };

    // Reception admits members; contradicting a refusal is a manager's call.
    const refused = await post(reception, '/v1/admin/attendance/override', {
      checkInId,
      reason: 'Paying at the desk now',
    });
    expect(refused.status).toBe(403);

    const allowed = await post(manager, '/v1/admin/attendance/override', {
      checkInId,
      reason: 'Paying at the desk now — receipt SF-2026-00291',
    });
    expect(allowed.status).toBe(200);

    const body = (await allowed.json()) as { granted: boolean; checkInId: string };
    expect(body.granted).toBe(true);

    const entry = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, body.checkInId)).get();
    expect(entry?.decision).toBe('granted');
    expect(entry?.overrideReason).toContain('receipt SF-2026-00291');
    expect(entry?.overrideByName).toBeTruthy();

    // The refusal is preserved, not edited away.
    const original = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).get();
    expect(original?.decision.startsWith('denied_')).toBe(true);

    const audited = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'attendance.override'), eq(schema.auditLog.entityId, member.id)))
      .get();
    expect(audited?.n).toBeGreaterThan(0);
  });

  it('rejects an override with no meaningful reason', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const reception = await signIn('reception@sharkfitness.in');
    const member = blockedMember('br_kor');

    const denial = await post(reception, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
    const { checkInId } = (await denial.json()) as { checkInId: string };

    const response = await post(manager, '/v1/admin/attendance/override', { checkInId, reason: 'ok' });
    // VALIDATION_FAILED maps to 422, not 400.
    expect(response.status).toBe(422);
  });

  it('does not let a second manager reuse a denial another manager already overrode', async () => {
    const managerA = await signIn('manager@sharkfitness.in');
    const managerB = await signIn('owner@sharkfitness.in');
    const member = blockedMember('br_kor');

    const denial = await post(managerA, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });
    const { checkInId } = (await denial.json()) as { checkInId: string };

    const first = await post(managerA, '/v1/admin/attendance/override', {
      checkInId,
      reason: 'Manager A: paying now',
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { checkInId: string };

    // Member checks out — the visit closes, but the original denial row's
    // consumption must not depend on that.
    await post(managerA, '/v1/admin/attendance/check-out', { checkInId: firstBody.checkInId });

    // A different manager tries to reuse the SAME original denial.
    const second = await post(managerB, '/v1/admin/attendance/override', {
      checkInId,
      reason: 'Manager B: also paying now',
    });
    expect(second.status).toBe(409);

    const original = db.select().from(schema.checkIns).where(eq(schema.checkIns.id, checkInId)).get();
    expect(original?.decision.startsWith('denied_')).toBe(true);
    expect(original?.overrideByName).toBeTruthy();
  });

  it('never overrides a reused code, whatever the reason', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const member = blockedMember('br_kor');

    // A replay refusal as the door reader would write it.
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

  it('hides members of another branch behind a 404 rather than a 403', async () => {
    // Reception is scoped to br_kor only.
    const session = await signIn('reception@sharkfitness.in');
    const outsider = idleEntitledMember('br_ind');

    const checkIn = await post(session, '/v1/admin/attendance/check-in', {
      memberId: outsider.id,
      branchId: 'br_ind',
    });
    expect(checkIn.status).toBe(404);

    const history = await get(session, `/v1/admin/attendance/member/${outsider.id}`);
    expect(history.status).toBe(404);
  });

  it('reaches a member through an explicit member_branches grant, not just the home branch', async () => {
    const reception = await signIn('reception@sharkfitness.in');
    // A member whose home branch is NOT br_kor, explicitly granted access to br_kor.
    const outsider = idleEntitledMember('br_ind');

    db.insert(schema.memberBranches)
      .values({ memberId: outsider.id, branchId: 'br_kor', tenantId: tenantId() })
      .run();

    try {
      const search = await get(reception, `/v1/admin/attendance/search?q=${outsider.memberNo}`);
      expect(search.status).toBe(200);
      const body = (await search.json()) as { items: Array<{ memberId: string }> };
      expect(body.items.some((i) => i.memberId === outsider.id)).toBe(true);

      const history = await get(reception, `/v1/admin/attendance/member/${outsider.id}`);
      expect(history.status).toBe(200);
    } finally {
      db.delete(schema.memberBranches)
        .where(and(eq(schema.memberBranches.memberId, outsider.id), eq(schema.memberBranches.branchId, 'br_kor')))
        .run();
    }
  });

  it('keeps another tenant’s check-in invisible', async () => {
    const session = await signIn('reception@sharkfitness.in');
    const foreign = db
      .select({ id: schema.checkIns.id })
      .from(schema.checkIns)
      .where(sql`${schema.checkIns.tenantId} != ${tenantId()}`)
      .get();

    // The seed is single-tenant; when that changes this assertion still holds.
    if (!foreign) {
      const response = await post(session, '/v1/admin/attendance/check-out', { checkInId: 'chk_does_not_exist' });
      expect(response.status).toBe(404);
      return;
    }
    const response = await post(session, '/v1/admin/attendance/check-out', { checkInId: foreign.id });
    expect(response.status).toBe(404);
  });

  it('reports the floor and filters the door feed to refusals', async () => {
    const session = await signIn('reception@sharkfitness.in');

    const current = await get(session, '/v1/admin/attendance/current');
    expect(current.status).toBe(200);
    const floor = (await current.json()) as {
      totals: { inside: number; capacity: number };
      branches: Array<{ branchId: string }>;
      items: Array<{ checkInId: string; minutesInside: number }>;
    };
    expect(floor.totals.capacity).toBeGreaterThan(0);
    expect(floor.items.length).toBe(floor.totals.inside);
    // Reception sees only its own branch.
    expect(floor.branches.every((b) => b.branchId === 'br_kor')).toBe(true);

    const denied = await get(session, '/v1/admin/attendance?filter=denied');
    expect(denied.status).toBe(200);
    const feed = (await denied.json()) as {
      items: Array<{ granted: boolean }>;
      breakdown: { all: number; denied: number };
      total: number;
    };
    expect(feed.items.every((row) => row.granted === false)).toBe(true);
    // The breakdown counts the whole day, not the returned page.
    expect(feed.breakdown.all).toBeGreaterThanOrEqual(feed.breakdown.denied);
  });

  it('closes every open visit for an evacuation, auditing each one', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const reception = await signIn('reception@sharkfitness.in');
    const member = idleEntitledMember('br_kor');
    await post(reception, '/v1/admin/attendance/check-in', { memberId: member.id, branchId: 'br_kor' });

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
    const session = await signIn('reception@sharkfitness.in');
    const response = await post(session, '/v1/admin/attendance/close-all', {
      branchId: 'br_kor',
      reason: 'Trying it on',
    });
    expect(response.status).toBe(403);
  });
});
