import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { hashPassword, hashToken } from '../lib/crypto.js';
import { id, initialsOf } from '../lib/ids.js';
import { issuePassBatch } from '../lib/pass-token.js';
import { runtimeConfig } from '../lib/config.js';
import { DAY, now } from '../lib/time.js';

const ORIGIN = 'http://localhost:5173';
const TENANT_ID = 'ten_shark';
const BRANCH_ID = 'br_kor';

interface Session {
  cookie: string;
  csrfToken: string;
}

async function signIn(email: string, password = 'shark1234'): Promise<Session> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ tenantSlug: 'shark', email, password }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  expect(token).toBeTruthy();
  return {
    cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`,
    csrfToken: body.csrfToken,
  };
}

function headers(session: Session, unsafe = false, branchId?: string): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: ORIGIN,
    ...(branchId ? { 'x-branch-id': branchId } : {}),
    ...(unsafe ? { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken } : {}),
  };
}

const get = (session: Session, path: string, branchId?: string) =>
  app.request(path, { headers: headers(session, false, branchId) });

const post = (session: Session, path: string, body: unknown, branchId?: string) =>
  app.request(path, {
    method: 'POST',
    headers: headers(session, true, branchId),
    body: JSON.stringify(body),
  });

const patch = (session: Session, path: string, body: unknown, branchId?: string) =>
  app.request(path, {
    method: 'PATCH',
    headers: headers(session, true, branchId),
    body: JSON.stringify(body),
  });

function memberFor(email: string) {
  return db
    .select({ member: schema.members })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(and(eq(schema.users.email, email), eq(schema.users.tenantId, TENANT_ID)))
    .get()!.member;
}

function insertMember(branchId = BRANCH_ID): string {
  const memberId = id('mbr');
  const suffix = memberId.slice(-8).toUpperCase();
  db.insert(schema.members)
    .values({
      id: memberId,
      tenantId: TENANT_ID,
      userId: null,
      homeBranchId: branchId,
      memberNo: `SEC-${suffix}`,
      firstName: 'Security',
      lastName: 'Fixture',
      initials: 'SF',
      email: null,
      phone: null,
      lifecycle: 'active',
      tags: [],
      trainerId: null,
      joinedOn: '2026-08-24',
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return memberId;
}

function insertStaff(role: 'regional_manager' | 'trainer', branchIds: string[], password = 'security-test-password') {
  const userId = id('usr');
  const staffId = id('stf');
  const email = `${userId}@security.test`;
  const atMs = now();
  db.insert(schema.users)
    .values({
      id: userId,
      tenantId: TENANT_ID,
      email,
      phone: null,
      name: `Security ${role}`,
      initials: initialsOf(`Security ${role}`),
      role,
      accountState: 'active',
      passwordHash: hashPassword(password),
      preferences: { register: 'plain', theme: 'dark', unitSystem: 'metric', haptics: true },
      lastSeenAt: null,
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();
  db.insert(schema.staff)
    .values({
      id: staffId,
      tenantId: TENANT_ID,
      userId,
      employmentStatus: 'active',
      branchIds,
      specialties: [],
      certifications: [],
      commissionRules: [],
      hourlyRateMinor: null,
      joinedOn: '2026-08-24',
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();
  return { userId, staffId, email, password };
}

let owner: Session;
let member: Session;

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  member = await signIn('aman@sharkfitness.in');
});

afterAll(() => {
  db.update(schema.tenants).set({ status: 'active', updatedAt: now() }).where(eq(schema.tenants.id, TENANT_ID)).run();
  db.update(schema.branches).set({ state: 'active', updatedAt: now() }).where(eq(schema.branches.id, BRANCH_ID)).run();
});

describe('tenant operational state is enforced at the session boundary', () => {
  it('discovers operational customer gyms without exposing the platform tenant', async () => {
    const response = await app.request('/v1/auth/tenants');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ slug: string }> };
    expect(body.items.map((item) => item.slug).sort()).toEqual(['reef', 'shark']);
    expect(body.items.some((item) => item.slug === 'platform')).toBe(false);
  });

  it('rejects a pending OTP after suspension and invalidates a session if status changes out of band', async () => {
    const target = db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, TENANT_ID), eq(schema.users.email, 'owner@sharkfitness.in')))
      .get()!;
    const challengeId = id('otp');
    const code = '834921';
    const liveBefore = db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, target.id), isNull(schema.sessions.revokedAt)))
      .all().length;
    db.insert(schema.otpChallenges)
      .values({
        id: challengeId,
        tenantId: TENANT_ID,
        identifier: target.email!,
        codeHash: hashToken(`${challengeId}:${code}`),
        attempts: 0,
        createdAt: now(),
        expiresAt: now() + 10 * 60_000,
        consumedAt: null,
      })
      .run();

    db.update(schema.tenants).set({ status: 'suspended', updatedAt: now() }).where(eq(schema.tenants.id, TENANT_ID)).run();
    try {
      const verified = await app.request('/v1/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId, code }),
      });
      expect(verified.status).not.toBe(200);
      expect(
        db.select().from(schema.sessions).where(and(eq(schema.sessions.userId, target.id), isNull(schema.sessions.revokedAt))).all(),
      ).toHaveLength(liveBefore); // the pending OTP created no additional session

      expect((await get(owner, '/v1/me')).status).toBe(401);
    } finally {
      db.update(schema.tenants).set({ status: 'active', updatedAt: now() }).where(eq(schema.tenants.id, TENANT_ID)).run();
    }
  });
});

describe('reader credentials are tenant-bound', () => {
  it('rejects a second tenant branch even when its slug matches the reader allowlist', async () => {
    const sourceBranch = db
      .select()
      .from(schema.branches)
      .where(and(eq(schema.branches.tenantId, 'ten_reef'), eq(schema.branches.slug, 'jayanagar')))
      .get()!;
    const branchId = id('brn');
    const memberId = id('mbr');
    const atMs = now();
    const readerKeysBefore = runtimeConfig.readerKeys;

    db.insert(schema.branches)
      .values({
        ...sourceBranch,
        id: branchId,
        name: 'Reef duplicate-slug probe',
        slug: 'koramangala',
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
    db.insert(schema.members)
      .values({
        id: memberId,
        tenantId: 'ten_reef',
        userId: null,
        homeBranchId: branchId,
        memberNo: `REEF-SEC-${memberId.slice(-6).toUpperCase()}`,
        firstName: 'Reader',
        lastName: 'Probe',
        initials: 'RP',
        email: null,
        phone: null,
        lifecycle: 'active',
        tags: [],
        trainerId: null,
        joinedOn: '2026-08-24',
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
    runtimeConfig.readerKeys = {
      'tenant-bound-reader': {
        key: 'tenant-bound-reader-secret',
        tenantSlug: 'shark',
        branchSlugs: ['koramangala'],
      },
    };

    try {
      const pass = issuePassBatch('ten_reef', memberId, undefined, 1)[0]!;
      const response = await app.request('/v1/door/scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-reader-id': 'tenant-bound-reader',
          'x-reader-key': 'tenant-bound-reader-secret',
        },
        body: JSON.stringify({ token: pass.token, branchId }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        granted: false,
        decision: 'denied_branch_not_permitted',
        memberName: null,
        branchName: null,
      });
    } finally {
      runtimeConfig.readerKeys = readerKeysBefore;
      db.delete(schema.checkIns).where(eq(schema.checkIns.memberId, memberId)).run();
      db.delete(schema.members).where(eq(schema.members.id, memberId)).run();
      db.delete(schema.branches).where(eq(schema.branches.id, branchId)).run();
    }
  });
});

describe('branch lifecycle gates new trade', () => {
  it('records closed-branch door and desk attempts as non-overridable denials', async () => {
    const memberId = insertMember();
    const pass = issuePassBatch(TENANT_ID, memberId, undefined, 1)[0]!;
    db.update(schema.branches).set({ state: 'temporarily_closed', updatedAt: now() }).where(eq(schema.branches.id, BRANCH_ID)).run();

    try {
      const door = await app.request('/v1/door/scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-reader-id': 'demo-reader',
          'x-reader-key': runtimeConfig.demoReaderKey,
        },
        body: JSON.stringify({ token: pass.token, branchId: BRANCH_ID }),
      });
      expect(door.status).toBe(200);
      expect((await door.json()) as { decision: string; granted: boolean }).toMatchObject({
        decision: 'denied_branch_closed',
        granted: false,
      });

      const desk = await post(owner, '/v1/admin/attendance/check-in', { memberId, branchId: BRANCH_ID });
      expect(desk.status).toBe(200);
      const denial = (await desk.json()) as { checkInId: string | null; decision: string; granted: boolean };
      expect(denial).toMatchObject({ decision: 'denied_branch_closed', granted: false });
      expect(denial.checkInId).toBeTruthy();

      const override = await post(owner, '/v1/admin/attendance/override', {
        checkInId: denial.checkInId,
        reason: 'Attempting a closed-branch bypass',
      });
      expect(override.status).toBe(412);
    } finally {
      db.update(schema.branches).set({ state: 'active', updatedAt: now() }).where(eq(schema.branches.id, BRANCH_ID)).run();
      db.delete(schema.checkIns).where(eq(schema.checkIns.memberId, memberId)).run();
      db.delete(schema.members).where(eq(schema.members.id, memberId)).run();
    }
  });

  it('refuses member, staff override, and waitlist booking paths while closed', async () => {
    const target = memberFor('aman@sharkfitness.in');
    const classTypeId = db.select({ id: schema.classTypes.id }).from(schema.classTypes).where(eq(schema.classTypes.tenantId, TENANT_ID)).get()!.id;
    const sessionId = id('ses');
    const atMs = now();
    db.insert(schema.classSessions)
      .values({
        id: sessionId,
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        classTypeId,
        roomId: null,
        trainerId: null,
        seriesId: null,
        startsAt: atMs + 40 * DAY,
        endsAt: atMs + 40 * DAY + 45 * 60_000,
        capacity: 10,
        booked: 0,
        state: 'scheduled',
        bookingOpensAt: null,
        cancelDeadlineAt: null,
        creditsRequired: 0,
        dropInPriceMinor: null,
        lateCancelFeeMinor: 0,
        waitlistEnabled: true,
        cancelledReason: null,
        substituteFor: null,
        notes: null,
        version: 1,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
    db.update(schema.branches).set({ state: 'suspended', updatedAt: now() }).where(eq(schema.branches.id, BRANCH_ID)).run();

    try {
      const mine = await post(member, '/v1/member/schedule/book', {
        sessionId,
        idempotencyKey: `security-member-${sessionId}`,
      });
      expect(mine.status).toBe(412);

      const override = await post(owner, `/v1/admin/schedule/session/${sessionId}/book-override`, {
        memberId: target.id,
        idempotencyKey: `security-override-${sessionId}`,
        reason: 'Testing the lifecycle boundary',
      });
      expect(override.status).toBe(412);

      db.update(schema.classSessions).set({ booked: 10 }).where(eq(schema.classSessions.id, sessionId)).run();
      const waitlist = await post(member, '/v1/member/schedule/waitlist', { sessionId });
      expect(waitlist.status).toBe(412);

      expect(db.select().from(schema.bookings).where(eq(schema.bookings.sessionId, sessionId)).all()).toHaveLength(0);
      expect(db.select().from(schema.waitlistEntries).where(eq(schema.waitlistEntries.sessionId, sessionId)).all()).toHaveLength(0);
    } finally {
      db.update(schema.branches).set({ state: 'active', updatedAt: now() }).where(eq(schema.branches.id, BRANCH_ID)).run();
      db.delete(schema.waitlistEntries).where(eq(schema.waitlistEntries.sessionId, sessionId)).run();
      db.delete(schema.bookings).where(eq(schema.bookings.sessionId, sessionId)).run();
      db.delete(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).run();
    }
  });

  it('refuses a sale without changing stock while the branch is closed', async () => {
    const product = db
      .select()
      .from(schema.retailProducts)
      .where(and(eq(schema.retailProducts.tenantId, TENANT_ID), eq(schema.retailProducts.active, true)))
      .all()
      .find((candidate) => {
        const stock = db
          .select({ onHand: sql<number>`coalesce(sum(${schema.stockLedger.delta}), 0)` })
          .from(schema.stockLedger)
          .where(
            and(
              eq(schema.stockLedger.tenantId, TENANT_ID),
              eq(schema.stockLedger.branchId, BRANCH_ID),
              eq(schema.stockLedger.productId, candidate.id),
            ),
          )
          .get();
        return (stock?.onHand ?? 0) > 0;
      });
    expect(product).toBeTruthy();
    const movementsBefore = db.select().from(schema.stockLedger).where(eq(schema.stockLedger.productId, product!.id)).all();
    const totalMinor = product!.priceMinor + Math.round((product!.priceMinor * product!.taxRateBp) / 10_000);
    db.update(schema.branches).set({ state: 'archived', updatedAt: now() }).where(eq(schema.branches.id, BRANCH_ID)).run();

    try {
      const response = await post(owner, '/v1/admin/store/orders', {
        branchId: BRANCH_ID,
        lines: [{ productId: product!.id, quantity: 1 }],
        payments: [{ method: 'cash', amountMinor: totalMinor }],
      });
      expect(response.status).toBe(412);
      expect(db.select().from(schema.stockLedger).where(eq(schema.stockLedger.productId, product!.id)).all()).toEqual(
        movementsBefore,
      );
    } finally {
      db.update(schema.branches).set({ state: 'active', updatedAt: now() }).where(eq(schema.branches.id, BRANCH_ID)).run();
    }
  });
});

describe('staff management enforces actor-versus-target privilege', () => {
  it('does not let a regional manager alter an owner or a peer regional manager', async () => {
    const actor = insertStaff('regional_manager', ['br_kor', 'br_ind']);
    const peer = insertStaff('regional_manager', ['br_kor']);
    const actorSession = await signIn(actor.email, actor.password);
    const ownerRow = db
      .select({ staffId: schema.staff.id, userId: schema.users.id, email: schema.users.email, accountState: schema.users.accountState })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.users.tenantId, TENANT_ID), eq(schema.users.role, 'owner')))
      .get()!;

    try {
      const ownerUpdate = await patch(actorSession, `/v1/admin/staff/${ownerRow.staffId}`, {
        email: 'regional-controlled@security.test',
      });
      const peerUpdate = await patch(actorSession, `/v1/admin/staff/${peer.staffId}`, { name: 'Peer controlled' });

      expect(ownerUpdate.status).toBe(403);
      expect(peerUpdate.status).toBe(403);

      expect(db.select().from(schema.users).where(eq(schema.users.id, ownerRow.userId)).get()).toMatchObject({
        email: ownerRow.email,
        accountState: ownerRow.accountState,
      });
    } finally {
      for (const fixture of [actor, peer]) {
        db.delete(schema.sessions).where(eq(schema.sessions.userId, fixture.userId)).run();
        db.delete(schema.staff).where(eq(schema.staff.id, fixture.staffId)).run();
        db.delete(schema.users).where(eq(schema.users.id, fixture.userId)).run();
      }
    }
  });
});

describe('selected branch is also enforced on direct record ids', () => {
  it('hides representative records from another selected branch', async () => {
    const memberId = db.select({ id: schema.members.id }).from(schema.members).where(and(eq(schema.members.tenantId, TENANT_ID), eq(schema.members.homeBranchId, 'br_ind'), isNull(schema.members.deletedAt))).get()!.id;
    const leadId = db.select({ id: schema.leads.id }).from(schema.leads).where(and(eq(schema.leads.tenantId, TENANT_ID), eq(schema.leads.branchId, 'br_ind'))).get()!.id;
    const invoiceId = db.select({ id: schema.invoices.id }).from(schema.invoices).where(and(eq(schema.invoices.tenantId, TENANT_ID), eq(schema.invoices.branchId, 'br_ind'))).get()!.id;
    const sessionId = db.select({ id: schema.classSessions.id }).from(schema.classSessions).where(and(eq(schema.classSessions.tenantId, TENANT_ID), eq(schema.classSessions.branchId, 'br_ind'))).get()!.id;
    const equipmentId = db.select({ id: schema.equipment.id }).from(schema.equipment).where(and(eq(schema.equipment.tenantId, TENANT_ID), eq(schema.equipment.branchId, 'br_ind'))).get()!.id;
    const orderId = db.select({ id: schema.posOrders.id }).from(schema.posOrders).where(and(eq(schema.posOrders.tenantId, TENANT_ID), eq(schema.posOrders.branchId, 'br_ind'))).get()!.id;
    const ticketId = db.select({ id: schema.tickets.id }).from(schema.tickets).where(and(eq(schema.tickets.tenantId, TENANT_ID), eq(schema.tickets.branchId, 'br_ind'))).get()!.id;

    const paths = [
      `/v1/admin/members/${memberId}`,
      `/v1/admin/leads/${leadId}`,
      `/v1/admin/billing/invoices/${invoiceId}`,
      `/v1/admin/schedule/session/${sessionId}`,
      `/v1/admin/facility/equipment/${equipmentId}`,
      `/v1/admin/store/orders/${orderId}`,
      `/v1/admin/support/tickets/${ticketId}`,
    ];
    for (const path of paths) expect((await get(owner, path, BRANCH_ID)).status, path).toBe(404);
  });

  it('does not disclose or refund a payment from outside the selected branch', async () => {
    const payment = db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .innerJoin(schema.invoices, eq(schema.invoices.id, schema.payments.invoiceId))
      .where(
        and(
          eq(schema.payments.tenantId, TENANT_ID),
          eq(schema.payments.state, 'failed'),
          eq(schema.invoices.branchId, BRANCH_ID),
        ),
      )
      .get();
    expect(payment).toBeTruthy();

    const response = await post(
      owner,
      `/v1/admin/billing/payments/${payment!.id}/refund`,
      { amountMinor: 1, reason: 'Selected branch isolation probe' },
      'br_ind',
    );
    expect(response.status).toBe(404);
  });

  it('limits a series cancellation to sessions in the selected branch', async () => {
    const classTypeId = db
      .select({ id: schema.classTypes.id })
      .from(schema.classTypes)
      .where(eq(schema.classTypes.tenantId, TENANT_ID))
      .get()!.id;
    const seriesId = id('ser');
    const korSessionId = id('ses');
    const indSessionId = id('ses');
    const atMs = now();
    const common = {
      tenantId: TENANT_ID,
      classTypeId,
      roomId: null,
      trainerId: null,
      seriesId,
      startsAt: atMs + 45 * DAY,
      endsAt: atMs + 45 * DAY + 45 * 60_000,
      capacity: 10,
      booked: 0,
      state: 'scheduled',
      bookingOpensAt: null,
      cancelDeadlineAt: null,
      creditsRequired: 0,
      dropInPriceMinor: null,
      lateCancelFeeMinor: 0,
      waitlistEnabled: true,
      cancelledReason: null,
      substituteFor: null,
      notes: null,
      version: 1,
      createdAt: atMs,
      updatedAt: atMs,
    };
    db.insert(schema.classSessions)
      .values([
        { ...common, id: korSessionId, branchId: BRANCH_ID },
        { ...common, id: indSessionId, branchId: 'br_ind', startsAt: common.startsAt + DAY, endsAt: common.endsAt + DAY },
      ])
      .run();

    try {
      const response = await post(
        owner,
        `/v1/admin/schedule/session/${korSessionId}/cancel`,
        { reason: 'Selected branch cancellation probe', scope: 'series' },
        BRANCH_ID,
      );
      expect(response.status).toBe(200);
      expect(db.select({ state: schema.classSessions.state }).from(schema.classSessions).where(eq(schema.classSessions.id, korSessionId)).get()!.state).toBe('cancelled');
      expect(db.select({ state: schema.classSessions.state }).from(schema.classSessions).where(eq(schema.classSessions.id, indSessionId)).get()!.state).toBe('scheduled');
    } finally {
      db.delete(schema.classSessions).where(eq(schema.classSessions.id, korSessionId)).run();
      db.delete(schema.classSessions).where(eq(schema.classSessions.id, indSessionId)).run();
    }
  });
});

describe('relationship and visibility isolation', () => {
  it('scopes the lead owner picker and refuses an out-of-entitlement branch query', async () => {
    const outsider = insertStaff('trainer', ['br_ind']);
    const manager = await signIn('manager@sharkfitness.in');
    try {
      const response = await get(manager, '/v1/admin/leads/owners');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: Array<{ id: string }> };
      expect(body.items.some((item) => item.id === outsider.staffId)).toBe(false);
      expect((await get(manager, '/v1/admin/leads/owners?branchId=br_ind')).status).toBe(403);
    } finally {
      db.delete(schema.staff).where(eq(schema.staff.id, outsider.staffId)).run();
      db.delete(schema.users).where(eq(schema.users.id, outsider.userId)).run();
    }
  });

  it('does not let a direct id mutate a private or different-branch post', async () => {
    const targetMember = memberFor('aman@sharkfitness.in');
    const privatePostId = id('pst');
    const branchPostId = id('pst');
    const atMs = now();
    db.insert(schema.posts)
      .values([
        {
          id: privatePostId,
          tenantId: TENANT_ID,
          branchId: BRANCH_ID,
          memberId: targetMember.id,
          staffId: null,
          authorKind: 'member',
          kind: 'text',
          body: 'Private security fixture',
          badge: null,
          refType: null,
          refId: null,
          visibility: 'private',
          state: 'visible',
          kudosCount: 0,
          commentCount: 0,
          createdAt: atMs,
          deletedAt: null,
        },
        {
          id: branchPostId,
          tenantId: TENANT_ID,
          branchId: 'br_ind',
          memberId: targetMember.id,
          staffId: null,
          authorKind: 'member',
          kind: 'text',
          body: 'Other branch security fixture',
          badge: null,
          refType: null,
          refId: null,
          visibility: 'branch',
          state: 'visible',
          kudosCount: 0,
          commentCount: 0,
          createdAt: atMs,
          deletedAt: null,
        },
      ])
      .run();

    try {
      expect((await post(member, `/v1/member/engagement/feed/${privatePostId}/kudos`, {})).status).toBe(404);
      expect((await post(member, `/v1/member/engagement/feed/${branchPostId}/comment`, { body: 'Direct id bypass' })).status).toBe(404);
      expect(db.select().from(schema.reactions).where(eq(schema.reactions.postId, privatePostId)).all()).toHaveLength(0);
      expect(db.select().from(schema.comments).where(eq(schema.comments.postId, branchPostId)).all()).toHaveLength(0);
    } finally {
      db.delete(schema.reactions).where(eq(schema.reactions.postId, privatePostId)).run();
      db.delete(schema.comments).where(eq(schema.comments.postId, branchPostId)).run();
      db.delete(schema.posts).where(eq(schema.posts.id, privatePostId)).run();
      db.delete(schema.posts).where(eq(schema.posts.id, branchPostId)).run();
    }
  });

  it('rejects a foreign-tenant exercise link on equipment create and update', async () => {
    const exerciseId = id('exr');
    db.insert(schema.exercises)
      .values({
        id: exerciseId,
        tenantId: 'ten_reef',
        slug: `security-${exerciseId}`,
        name: 'Foreign security exercise',
        aliases: [],
        equipment: 'machine',
        primaryMuscles: ['chest'],
        secondaryMuscles: [],
        difficulty: 'beginner',
        instructions: [],
        cues: [],
        contraindications: [],
        substitutionIds: [],
        isUnilateral: false,
        usesBarbell: false,
        defaultRestSec: 60,
        loadStepKg: 2.5,
        mediaUrl: null,
        archived: false,
      })
      .run();
    const existing = db.select().from(schema.equipment).where(and(eq(schema.equipment.tenantId, TENANT_ID), eq(schema.equipment.branchId, BRANCH_ID))).get()!;

    try {
      const create = await post(owner, '/v1/admin/facility/equipment', {
        name: 'Foreign link probe',
        assetTag: `SEC-${exerciseId.slice(-8)}`,
        branchId: BRANCH_ID,
        area: 'Security',
        linkedExerciseId: exerciseId,
      });
      expect(create.status).toBe(422);

      const update = await patch(owner, `/v1/admin/facility/equipment/${existing.id}`, { linkedExerciseId: exerciseId });
      expect(update.status).toBe(422);
      expect(db.select().from(schema.equipment).where(eq(schema.equipment.id, existing.id)).get()!.linkedExerciseId).toBe(existing.linkedExerciseId);
    } finally {
      db.delete(schema.equipment).where(eq(schema.equipment.assetTag, `SEC-${exerciseId.slice(-8)}`)).run();
      db.delete(schema.exercises).where(eq(schema.exercises.id, exerciseId)).run();
    }
  });
});
