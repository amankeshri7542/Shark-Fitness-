import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

/* ============================================================================
   Member-detail authorization.

   Member *lists* were branch-scoped. The member *record* was not.
   `GET /admin/members/:id` matched on tenant alone, and freeze, unfreeze,
   cancel and notes matched on nothing but the member id — not even the tenant.
   A branch manager at Koramangala who knew, or guessed, an Indiranagar
   member's id could read that member's whole file and schedule the
   cancellation of their membership. The list scoping above it made the gap
   invisible: the console never showed a way to reach the record, so nobody
   went looking for one.

   The rule these tests hold to: a member outside the caller's scope is *not
   found*, never *forbidden* — a 403 confirms the record exists somewhere the
   caller may not look — and a real `member_branches` grant still reaches.
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

function headers(session: Session, unsafe = false, branchId?: string): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(branchId !== undefined ? { 'x-branch-id': branchId } : {}),
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const get = (session: Session, path: string, branchId?: string) =>
  app.request(path, { headers: headers(session, false, branchId) });
const post = (session: Session, path: string, body: unknown, branchId?: string) =>
  app.request(path, { method: 'POST', headers: headers(session, true, branchId), body: JSON.stringify(body) });
const patch = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(session, true), body: JSON.stringify(body) });

const tenantId = (): string =>
  db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;

/** Live members whose home branch is `branchId`, in a deterministic order. */
function membersAt(branchId: string): Array<{ id: string }> {
  return db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, tenantId()),
        eq(schema.members.homeBranchId, branchId),
        isNull(schema.members.deletedAt),
        isNull(schema.members.mergedIntoId),
      ),
    )
    .orderBy(asc(schema.members.memberNo))
    .all();
}

const memberAt = (branchId: string): { id: string } => membersAt(branchId)[0]!;

/** Owner: every branch. Manager: Koramangala only (see the seed). */
let owner: Session;
let manager: Session;
let trainer: Session;
let outOfScopeMemberId = '';
let outOfScopeMembershipId = '';

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
  trainer = await signIn('rehan@sharkfitness.in');

  // This file used to probe the first seeded Indiranagar member. Other suites
  // legitimately add a temporary Koramangala grant to seeded members, and
  // Vitest may run files concurrently; that made the security regression turn
  // green or red depending on timing. Clone a real active member + membership
  // so the endpoint still traverses the full business path without sharing its
  // authorization fixture with any other test.
  const sourceMember = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenantId()), eq(schema.members.homeBranchId, 'br_ind'), isNull(schema.members.deletedAt)))
    .orderBy(asc(schema.members.memberNo))
    .all()
    .find((member) =>
      Boolean(
        db
          .select({ id: schema.memberships.id })
          .from(schema.memberships)
          .where(and(eq(schema.memberships.memberId, member.id), eq(schema.memberships.state, 'active')))
          .get(),
      ),
    )!;
  const sourceMembership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, sourceMember.id), eq(schema.memberships.state, 'active')))
    .get()!;
  const atMs = now();
  outOfScopeMemberId = id('mbr');
  outOfScopeMembershipId = id('msh');
  db.insert(schema.members)
    .values({
      ...sourceMember,
      id: outOfScopeMemberId,
      userId: null,
      memberNo: `SCOPE-${outOfScopeMemberId.slice(-10).toUpperCase()}`,
      firstName: 'Scope',
      lastName: 'Fixture',
      email: null,
      emailNormalized: null,
      phone: null,
      phoneNormalized: null,
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();
  db.insert(schema.memberships)
    .values({
      ...sourceMembership,
      id: outOfScopeMembershipId,
      memberId: outOfScopeMemberId,
      previousMembershipId: null,
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();
});

afterAll(() => {
  db.delete(schema.memberBranches).where(eq(schema.memberBranches.memberId, outOfScopeMemberId)).run();
  db.delete(schema.memberships).where(eq(schema.memberships.id, outOfScopeMembershipId)).run();
  db.delete(schema.members).where(eq(schema.members.id, outOfScopeMemberId)).run();
});

/* ——— The member record obeys the same scope as the member list ——— */

describe('member detail — a branch the caller cannot see is not found', () => {
  it('lets a Koramangala manager read a Koramangala member', async () => {
    const response = await get(manager, `/v1/admin/members/${memberAt('br_kor').id}`);
    expect(response.status).toBe(200);
  });

  it('refuses that manager an Indiranagar member by direct id — 404, not the record', async () => {
    // The list already hid this member. Knowing the id must not be a way round
    // it, and a 403 would confirm the record exists somewhere they may not look.
    const response = await get(manager, `/v1/admin/members/${outOfScopeMemberId}`);
    expect(response.status).toBe(404);
  });

  it('refuses to freeze an out-of-scope member’s live membership', async () => {
    const target = outOfScopeMemberId;
    const before = db
      .select({ state: schema.memberships.state })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.memberId, target), eq(schema.memberships.state, 'active')))
      .get()!;
    const response = await post(manager, `/v1/admin/members/${target}/freeze`, { days: 7, reason: 'scope probe' });
    expect(response.status).toBe(404);
    const after = db
      .select({ state: schema.memberships.state })
      .from(schema.memberships)
      .where(eq(schema.memberships.memberId, target))
      .get()!;
    expect(after.state).toBe(before.state);
  });

  it('refuses to cancel an out-of-scope member’s live membership', async () => {
    const target = outOfScopeMemberId;
    // Notice-period cancellation, because `immediate` is refused from `active`
    // by the state machine and would 409 before ever reaching the data.
    const response = await post(manager, `/v1/admin/members/${target}/cancel`, {
      reason: 'scope probe',
      immediate: false,
    });
    expect(response.status).toBe(404);
    const after = db
      .select({ state: schema.memberships.state, cancelEffectiveOn: schema.memberships.cancelEffectiveOn })
      .from(schema.memberships)
      .where(eq(schema.memberships.memberId, target))
      .get()!;
    // The proof that matters: before the fix this came back `cancel_scheduled`
    // with a date on it, from a manager two branches away.
    expect(after.state).toBe('active');
    expect(after.cancelEffectiveOn).toBeNull();
  });

  it('refuses to unfreeze an out-of-scope member’s membership', async () => {
    const response = await post(manager, `/v1/admin/members/${outOfScopeMemberId}/unfreeze`, {
      reason: 'scope probe',
    });
    expect(response.status).toBe(404);
  });

  it('refuses to write notes onto an out-of-scope member, and leaves them untouched', async () => {
    const before = db.select().from(schema.members).where(eq(schema.members.id, outOfScopeMemberId)).get()!;
    const response = await patch(manager, `/v1/admin/members/${outOfScopeMemberId}/notes`, {
      staffNotes: 'written from another branch',
      version: before.version,
    });
    expect(response.status).toBe(404);
    const after = db.select().from(schema.members).where(eq(schema.members.id, outOfScopeMemberId)).get()!;
    expect(after.staffNotes).toBe(before.staffNotes);
    expect(after.version).toBe(before.version);
  });

  it('refuses a member id from another tenant outright', async () => {
    const foreign = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(ne(schema.members.tenantId, tenantId()))
      .limit(1)
      .get();
    const probe = foreign?.id ?? 'mem_not_a_real_member';
    expect((await get(owner, `/v1/admin/members/${probe}`)).status).toBe(404);
  });

  it('keeps a cross-branch entitlement working — a granted member stays reachable', async () => {
    // `member_branches` is a real grant: a member of Indiranagar who trains at
    // Koramangala must not be collateral damage of the fix above.
    const target = { id: outOfScopeMemberId };
    db.insert(schema.memberBranches)
      .values({ tenantId: tenantId(), memberId: target.id, branchId: 'br_kor' })
      .onConflictDoNothing()
      .run();
    try {
      const response = await get(manager, `/v1/admin/members/${target.id}`);
      expect(response.status).toBe(200);
    } finally {
      db.delete(schema.memberBranches)
        .where(and(eq(schema.memberBranches.memberId, target.id), eq(schema.memberBranches.branchId, 'br_kor')))
        .run();
    }
  });

  it('still restricts a trainer to their own roster inside their branch', async () => {
    // The trainer rule is narrower than the branch rule and survives it.
    const unassigned = db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId()), isNull(schema.members.trainerId), isNull(schema.members.deletedAt)))
      .limit(1)
      .get();
    if (!unassigned) return;
    const response = await get(trainer, `/v1/admin/members/${unassigned.id}`);
    expect(response.status).toBe(403);
  });
});
