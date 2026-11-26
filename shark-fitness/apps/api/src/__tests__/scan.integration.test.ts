import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gte } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { issuePassBatch } from '../lib/pass-token.js';
import { now } from '../lib/time.js';
import { TENANT, createMember, get, post, signIn, signInMember, type Session } from './support/fixtures.js';

/**
 * Reception scanning (P05, PF-ATT-001/005, PRD 01 §6.2, UX-A08).
 *
 * `POST /v1/admin/attendance/scan` runs the door's own decision. Every member
 * here is built for the test, so the outcome never depends on the seed or on
 * the hour the suite runs.
 */

const BRANCH = 'br_kor';
let owner: Session;
let reception: Session;
const startedAt = now();

beforeAll(async () => {
  // Opening hours must not decide these tests; the hours rule has its own suite.
  db.update(schema.branches)
    .set({ state: 'active', opensMinutes: 0, closesMinutes: 24 * 60, hours: null, holidays: [] })
    .run();
  owner = await signIn('owner@sharkfitness.in');
  reception = await signIn('reception@sharkfitness.in');
});

afterAll(() => {
  // Leave nobody "inside" for later suites that count the room.
  db.update(schema.checkIns).set({ exitedAt: now() }).where(gte(schema.checkIns.enteredAt, startedAt)).run();
});

function token(memberId: string, tenantId = TENANT, epoch?: number): string {
  return issuePassBatch(tenantId, memberId, epoch, 1)[0]!.token;
}

async function scan(session: Session, rawToken: string, branchId = BRANCH, key?: string) {
  const response = await post(session, '/v1/admin/attendance/scan', { token: rawToken, branchId }, key ? { 'idempotency-key': key } : {});
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function checkInRows(memberId: string) {
  return db.select().from(schema.checkIns).where(eq(schema.checkIns.memberId, memberId)).all();
}

function auditRows(entityId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.entityId, entityId), gte(schema.auditLog.at, startedAt)))
    .all();
}

describe('POST /v1/admin/attendance/scan', () => {
  it('admits a valid code once; the second scan reads "Already checked in" and writes no second visit', async () => {
    const member = createMember({ firstName: 'Admit' });
    const code = token(member.memberId);

    const first = await scan(reception, code);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      granted: true,
      outcome: 'admitted',
      decision: 'granted',
      memberName: 'Admit Member',
      initials: 'AM',
      memberNo: member.memberNo,
    });

    const second = await scan(reception, code);
    expect(second.body).toMatchObject({ outcome: 'already_checked_in', message: 'Already checked in.', checkInId: first.body.checkInId });

    // A fresh code shown a minute later by someone already inside is the same answer.
    const fresh = await scan(reception, token(member.memberId, TENANT, Math.floor(now() / 1000) + 30));
    expect(fresh.body.outcome).toBe('already_checked_in');

    const rows = checkInRows(member.memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'granted', method: 'qr' });

    const actions = auditRows(member.memberId).map((row) => row.action);
    expect(actions.filter((a) => a === 'attendance.checked_in')).toHaveLength(1);
    expect(actions.filter((a) => a === 'attendance.scan_duplicate')).toHaveLength(2);
  });

  it('refuses a code whose window was already used, once the member has left', async () => {
    const member = createMember({ firstName: 'Replay' });
    const code = token(member.memberId);
    const first = await scan(owner, code);
    expect(first.body.granted).toBe(true);
    const out = await post(owner, '/v1/admin/attendance/check-out', { checkInId: first.body.checkInId });
    expect(out.status).toBe(200);

    const replay = await scan(owner, code);
    expect(replay.body).toMatchObject({ granted: false, outcome: 'denied', decision: 'denied_token_replayed', overridable: false });
    expect(replay.body.denialCheckInId).toEqual(expect.any(String));
    expect(auditRows(member.memberId).some((row) => row.action === 'attendance.denied' && row.reason === 'denied_token_replayed')).toBe(true);
  });

  it('tells an expired code from a forged one', async () => {
    const member = createMember({ firstName: 'Stale' });
    const stale = token(member.memberId, TENANT, Math.floor(now() / 1000) - 600);
    const expired = await scan(owner, stale);
    expect(expired.body).toMatchObject({ granted: false, decision: 'denied_token_expired', memberNo: member.memberNo });
    expect(checkInRows(member.memberId)).toHaveLength(1);
    expect(auditRows(member.memberId).some((row) => row.reason === 'denied_token_expired')).toBe(true);

    const [payload] = token(member.memberId).split('.');
    const forged = await scan(owner, `${payload}.${'A'.repeat(43)}`);
    expect(forged.body).toMatchObject({ granted: false, decision: 'denied_token_invalid', memberName: null, memberNo: null });
    expect(checkInRows(member.memberId)).toHaveLength(1);
    expect(auditRows('unidentified').some((row) => row.reason === 'denied_token_invalid')).toBe(true);
  });

  it("refuses another gym's genuine code without naming its owner or recording a visit", async () => {
    const reef = createMember({ tenantId: 'ten_reef', branchId: 'brn_reef_main', firstName: 'Reef' });
    const result = await scan(owner, token(reef.memberId, 'ten_reef'));
    expect(result.body).toMatchObject({ granted: false, decision: 'denied_wrong_tenant', memberName: null, memberId: null, initials: null });
    expect(checkInRows(reef.memberId)).toHaveLength(0);
    expect(auditRows('unidentified').some((row) => row.reason === 'denied_wrong_tenant' && row.tenantId === TENANT)).toBe(true);
  });

  it('refuses a member entitled to another branch only, and records it', async () => {
    const member = createMember({ branchId: 'br_ind', firstName: 'Elsewhere' });
    const result = await scan(owner, token(member.memberId));
    expect(result.body).toMatchObject({ granted: false, decision: 'denied_branch_not_permitted', overridable: true });
    expect(checkInRows(member.memberId)[0]).toMatchObject({ decision: 'denied_branch_not_permitted', branchId: BRANCH });
  });

  it('admits a member entitled to this branch as an extra branch (cross-branch entitlement)', async () => {
    const member = createMember({ branchId: 'br_ind', extraBranchIds: [BRANCH], firstName: 'Cross' });
    const result = await scan(owner, token(member.memberId));
    expect(result.body).toMatchObject({ granted: true, outcome: 'admitted' });
  });

  it('refuses a suspended membership with its own code', async () => {
    const member = createMember({ state: 'suspended', firstName: 'Held' });
    const result = await scan(owner, token(member.memberId));
    expect(result.body).toMatchObject({ granted: false, decision: 'denied_suspended' });
    expect(auditRows(member.memberId).some((row) => row.action === 'attendance.denied' && row.reason === 'denied_suspended')).toBe(true);
  });

  it('refuses entry when the branch is at capacity', async () => {
    const branch = db.select().from(schema.branches).where(eq(schema.branches.id, 'br_hsr')).get()!;
    const occupancy = (await (await get(owner, '/v1/admin/attendance/occupancy')).json()) as {
      branches: Array<{ branchId: string; inside: number }>;
    };
    const inside = occupancy.branches.find((b) => b.branchId === 'br_hsr')?.inside ?? 0;
    db.update(schema.branches).set({ capacity: Math.max(inside, 0) }).where(eq(schema.branches.id, 'br_hsr')).run();
    try {
      const member = createMember({ branchId: 'br_hsr', firstName: 'Full' });
      const result = await scan(owner, token(member.memberId), 'br_hsr');
      expect(result.body).toMatchObject({ granted: false, decision: 'denied_capacity', overridable: true, canOverride: true });
    } finally {
      db.update(schema.branches).set({ capacity: branch.capacity }).where(eq(schema.branches.id, 'br_hsr')).run();
    }
  });

  it('offers the override only to staff who hold attendance.override, and the override admits', async () => {
    const member = createMember({ branchId: 'br_ind', firstName: 'Override' });
    const atDesk = await scan(reception, token(member.memberId));
    expect(atDesk.body).toMatchObject({ granted: false, overridable: true, canOverride: false });

    const manager = await scan(owner, token(member.memberId, TENANT, Math.floor(now() / 1000) + 30));
    expect(manager.body.canOverride).toBe(true);
    const override = await post(owner, '/v1/admin/attendance/override', {
      checkInId: manager.body.denialCheckInId,
      reason: 'Visiting from Indiranagar today',
    });
    expect(override.status).toBe(200);
    expect(checkInRows(member.memberId).filter((row) => row.decision === 'granted')).toHaveLength(1);
  });

  it('replays the first answer for a retried Idempotency-Key', async () => {
    const member = createMember({ firstName: 'Retry' });
    const code = token(member.memberId);
    const first = await scan(owner, code, BRANCH, `scan-${member.memberId}`);
    const retry = await scan(owner, code, BRANCH, `scan-${member.memberId}`);
    expect(retry.body).toEqual(first.body);
    expect(retry.body.outcome).toBe('admitted');
    expect(checkInRows(member.memberId)).toHaveLength(1);
  });

  it('emits occupancy on the branch channel', async () => {
    const member = createMember({ firstName: 'Signal' });
    const before = db
      .select()
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.topic, 'attendance.checked_in'), gte(schema.outboxEvents.at, startedAt)))
      .all().length;
    const result = await scan(owner, token(member.memberId));
    expect(result.body.granted).toBe(true);
    const events = db
      .select()
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.topic, 'attendance.checked_in'), gte(schema.outboxEvents.at, startedAt)))
      .all();
    expect(events.length).toBeGreaterThan(before);
    expect(events.some((e) => e.channel === `branch:${BRANCH}`)).toBe(true);
  });

  it('hides branches outside the caller scope and refuses members and unauthenticated callers', async () => {
    const member = createMember({ withLogin: true, firstName: 'Nosy' });
    const code = token(member.memberId);
    const memberSession = await signInMember(member);
    expect((await post(memberSession, '/v1/admin/attendance/scan', { token: code, branchId: BRANCH })).status).toBe(403);
    expect((await scan(owner, code, 'brn_reef_main')).status).toBe(404);
    const anonymous = await app.request('/v1/admin/attendance/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ token: code, branchId: BRANCH }),
    });
    expect([401, 403]).toContain(anonymous.status);
    expect(checkInRows(member.memberId)).toHaveLength(0);
  });
});

describe('Permissions-Policy', () => {
  it('lets only the console ask for the camera', async () => {
    const consoleDoc = await app.request('/admin/floor');
    expect(consoleDoc.headers.get('permissions-policy')).toContain('camera=(self)');
    for (const path of ['/', '/app/', '/v1/health', '/v1/admin/attendance/current', '/administrator']) {
      const response = await app.request(path);
      expect(response.headers.get('permissions-policy'), path).toContain('camera=()');
    }
  });
});
