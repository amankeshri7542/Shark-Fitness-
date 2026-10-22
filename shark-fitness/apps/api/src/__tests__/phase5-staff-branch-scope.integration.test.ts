import { describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { now } from '../lib/time.js';

interface Session {
  cookie: string;
  csrfToken: string;
}

async function signIn(email: string): Promise<Session> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  return {
    cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`,
    csrfToken: body.csrfToken,
  };
}

function headers(session: Session): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    'x-csrf-token': session.csrfToken,
    'content-type': 'application/json',
  };
}

describe('Phase 5 staff booking branch entitlement', () => {
  it('does not substitute staff branch scope for member branch scope', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const tenant = db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, 'shark'))
      .get()!;
    const classType = db
      .select({ id: schema.classTypes.id })
      .from(schema.classTypes)
      .where(eq(schema.classTypes.tenantId, tenant.id))
      .get()!;

    const member = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .innerJoin(schema.memberships, eq(schema.memberships.memberId, schema.members.id))
      .where(
        and(
          eq(schema.members.tenantId, tenant.id),
          eq(schema.members.homeBranchId, 'br_kor'),
          isNull(schema.members.deletedAt),
          eq(schema.memberships.state, 'active'),
          sql`not exists (
            select 1 from member_branches mb
            where mb.member_id = ${schema.members.id}
              and mb.branch_id = 'br_ind'
          )`,
        ),
      )
      .get();
    if (!member) throw new Error('seed has no active Koramangala-only member');

    const sessionId = `ses_branch_scope_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startsAt = now() + 500 * 24 * 3_600_000;
    db.insert(schema.classSessions)
      .values({
        id: sessionId,
        tenantId: tenant.id,
        branchId: 'br_ind',
        classTypeId: classType.id,
        roomId: null,
        trainerId: null,
        seriesId: null,
        startsAt,
        endsAt: startsAt + 45 * 60_000,
        capacity: 4,
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
        notes: 'Branch-scope regression fixture',
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    const response = await app.request(`/v1/admin/schedule/session/${sessionId}/book`, {
      method: 'POST',
      headers: headers(owner),
      body: JSON.stringify({
        memberId: member.id,
        idempotencyKey: `branch-scope-${sessionId}`,
        acceptDropInCharge: false,
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('does not include this branch');
    expect(db.select().from(schema.classSessions).where(eq(schema.classSessions.id, sessionId)).get()?.booked).toBe(0);
    expect(
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.bookings)
        .where(and(eq(schema.bookings.sessionId, sessionId), eq(schema.bookings.memberId, member.id)))
        .get()?.n,
    ).toBe(0);
  });
});

describe('All branches is the default scope for multi-branch staff', () => {
  it('lists members from every branch when no x-branch-id is sent', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const response = await app.request('/v1/admin/members?limit=100', { headers: headers(owner) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; scopeNote: string };
    expect(body.scopeNote).toMatch(/^Showing all \d+ branches/);
    const everyone = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.members)
      .where(isNull(schema.members.deletedAt))
      .get()!;
    const narrowed = await app.request('/v1/admin/members?limit=100', {
      headers: { ...headers(owner), 'x-branch-id': 'br_kor' },
    });
    const kor = (await narrowed.json()) as { total: number };
    expect(body.total).toBeGreaterThan(kor.total);
    expect(body.total).toBeLessThanOrEqual(everyone.n);

    const me = await app.request('/v1/me/branches', { headers: headers(owner) });
    const branches = (await me.json()) as { activeBranchId: string | null };
    expect(branches.activeBranchId).toBeNull();
  });

  it('still narrows to one branch when the console asks for it', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const response = await app.request('/v1/me/branches', { headers: { ...headers(owner), 'x-branch-id': 'br_ind' } });
    const body = (await response.json()) as { activeBranchId: string | null };
    expect(body.activeBranchId).toBe('br_ind');
  });
});
