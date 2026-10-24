import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { DAY, now } from '../lib/time.js';
import { createSession } from '../services/auth.js';
import { anonymisationPlan, evaluateRetention, pseudonymFor } from '../services/privacy.js';

/* ============================================================================
   Data-subject requests (PF-COMP).

   The member's endpoints were truthful and were not a workflow: an audit row,
   an account state, and an honest message that somebody would do the rest by
   hand. Nothing recorded the request as a thing with a state.

   What these tests hold to:

   - a legal hold outranks a deletion request, always;
   - the tenant's own retention window blocks erasure and says why;
   - erasure is pseudonymisation — accounting and audit rows survive, still
     pointing at a subject who can no longer be identified;
   - `audit_log` cannot be deleted even deliberately;
   - the export is an internal artifact with a checksum, and nothing claims it
     was sent anywhere;
   - the anonymisation plan is deterministic, so a reviewer approves the thing
     that actually runs.

   Every row is owned by this suite and removed in `afterAll`.
   ========================================================================= */

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

const OWNER = 'owner@sharkfitness.in';
const TENANT = 'ten_shark';

const subjects: Array<{ userId: string; memberId: string; invoiceId: string }> = [];

/** A member this suite owns outright, with an invoice against them so the
 *  "accounting survives erasure" assertion has something real to check. */
function makeSubject(options: { lifecycle?: string; membershipEndsOn?: string | null } = {}) {
  const userId = id('usr');
  const memberId = id('mem');
  const invoiceId = id('inv');

  db.insert(schema.users)
    .values({
      id: userId,
      tenantId: TENANT,
      email: `${userId}@privacy.test`,
      phone: '+919000000001',
      name: 'Subject Under Test',
      initials: 'SU',
      role: 'member',
      accountState: 'active',
      passwordHash: null,
      preferences: {},
      lastSeenAt: null,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    })
    .run();

  db.insert(schema.members)
    .values({
      id: memberId,
      tenantId: TENANT,
      userId,
      homeBranchId: 'br_kor',
      memberNo: `PT-${memberId.slice(-6)}`,
      firstName: 'Subject',
      lastName: 'Under Test',
      initials: 'SU',
      email: `${userId}@privacy.test`,
      phone: '+919000000001',
      phoneNormalized: '9000000001',
      emailNormalized: `${userId}@privacy.test`,
      dob: '1990-01-01',
      gender: 'other',
      addressLine: '1 Test Street',
      emergencyContact: { name: 'Someone', phone: '+919000000002', relationship: 'friend' },
      lifecycle: options.lifecycle ?? 'active',
      tags: [],
      trainerId: null,
      guardianId: null,
      corporateSponsorId: null,
      memberNotes: null,
      staffNotes: null,
      riskScore: null,
      riskReasons: null,
      joinedOn: '2023-01-01',
      lastVisitAt: null,
      mergedIntoId: null,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    })
    .run();

  db.insert(schema.invoices)
    .values({
      id: invoiceId,
      tenantId: TENANT,
      branchId: 'br_kor',
      memberId,
      number: `PT-${invoiceId.slice(-6)}`,
      state: 'paid',
      issuedOn: '2024-01-01',
      dueOn: '2024-01-15',
      currency: 'INR',
      subtotalMinor: 100_000,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 100_000,
      paidMinor: 100_000,
      refundedMinor: 0,
      voided: false,
      voidReason: null,
      refType: null,
      refId: null,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  if (options.membershipEndsOn !== undefined) {
    db.insert(schema.memberships)
      .values({
        id: id('mbs'),
        tenantId: TENANT,
        memberId,
        productId: 'prd_test',
        productName: 'Test plan',
        productSnapshot: {} as never,
        state: options.membershipEndsOn === null ? 'active' : 'expired',
        startedOn: '2023-01-01',
        endsOn: options.membershipEndsOn,
        autoRenew: false,
        priceMinor: 100_000,
        currency: 'INR',
        freezeDaysUsed: 0,
        freezeStartedOn: null,
        graceEndsOn: null,
        cancelEffectiveOn: null,
        previousMembershipId: null,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }

  subjects.push({ userId, memberId, invoiceId });
  return { userId, memberId, invoiceId };
}

beforeAll(() => {
  // Nothing to prepare; each test builds the subject it needs.
});

afterAll(() => {
  const userIds = subjects.map((s) => s.userId);
  const memberIds = subjects.map((s) => s.memberId);
  const invoiceIds = subjects.map((s) => s.invoiceId);
  if (userIds.length === 0) return;

  const requestIds = db
    .select({ id: schema.privacyRequests.id })
    .from(schema.privacyRequests)
    .where(inArray(schema.privacyRequests.subjectUserId, userIds))
    .all()
    .map((row) => row.id);
  if (requestIds.length > 0) {
    db.delete(schema.privacyArtifacts).where(inArray(schema.privacyArtifacts.requestId, requestIds)).run();
    db.delete(schema.privacyRequests).where(inArray(schema.privacyRequests.id, requestIds)).run();
  }
  db.delete(schema.legalHolds).where(inArray(schema.legalHolds.subjectUserId, userIds)).run();
  db.delete(schema.invoices).where(inArray(schema.invoices.id, invoiceIds)).run();
  db.delete(schema.memberships).where(inArray(schema.memberships.memberId, memberIds)).run();
  db.delete(schema.sessions).where(inArray(schema.sessions.userId, userIds)).run();
  db.delete(schema.members).where(inArray(schema.members.id, memberIds)).run();
  db.delete(schema.users).where(inArray(schema.users.id, userIds)).run();
});

async function raise(owner: Session, subjectUserId: string, kind: 'export' | 'deletion') {
  const response = await app.request('/v1/admin/privacy/requests', {
    method: 'POST',
    headers: headers(owner, true),
    body: JSON.stringify({ subjectUserId, kind, reason: null }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { requestId: string; created: boolean; state: string };
}

describe('a request is a record with a lifecycle', () => {
  it('carries requester, subject and timestamps, and does not duplicate on a second press', async () => {
    const owner = await signIn(OWNER);
    const subject = makeSubject();

    const first = await raise(owner, subject.userId, 'export');
    expect(first.created).toBe(true);
    expect(first.state).toBe('submitted');

    const second = await raise(owner, subject.userId, 'export');
    expect(second.created).toBe(false);
    expect(second.requestId).toBe(first.requestId);

    const row = db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, first.requestId))
      .get()!;
    expect(row.subjectUserId).toBe(subject.userId);
    expect(row.subjectMemberId).toBe(subject.memberId);
    expect(row.requestedByUserId).toBeTruthy();
    expect(row.submittedAt).toBeGreaterThan(0);
    expect(row.reviewedAt).toBeNull();
    expect(row.completedAt).toBeNull();
  });

  it('lands a member’s own request in the queue without changing what they are told', async () => {
    const subject = makeSubject();
    const session = createSession(subject.userId, TENANT, '192.0.2.100', 'privacy-workflow');
    const bearer = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };

    const response = await app.request('/v1/me/data-export', { method: 'POST', headers: bearer, body: '{}' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; message: string; requestId: string };

    // The honest message is unchanged — no download link, no promise to send.
    expect(body.status).toBe('recorded_manual');
    expect(body.message).toMatch(/does not generate or send/i);
    expect(body.message).not.toMatch(/within 24 hours|download link/i);

    // And it is now a row somebody can work from.
    const row = db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, body.requestId))
      .get()!;
    expect(row.kind).toBe('export');
    expect(row.subjectUserId).toBe(subject.userId);
  });
});

describe('legal holds outrank a deletion request', () => {
  it('blocks a request that already exists and refuses erasure while the hold stands', async () => {
    const owner = await signIn(OWNER);
    const subject = makeSubject({ lifecycle: 'lapsed', membershipEndsOn: '2020-01-01' });
    const request = await raise(owner, subject.userId, 'deletion');

    const hold = await app.request('/v1/admin/privacy/holds', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({
        subjectUserId: subject.userId,
        reason: 'Injury claim under investigation.',
        reference: 'CLAIM-2026-08',
      }),
    });
    expect(hold.status).toBe(201);
    const { holdId } = (await hold.json()) as { holdId: string };

    // The in-flight request is blocked, in its own state — a queue must not
    // show a blocked request as merely slow.
    expect(
      db.select().from(schema.privacyRequests).where(eq(schema.privacyRequests.id, request.requestId)).get()!.state,
    ).toBe('on_hold');

    const erase = await app.request(`/v1/admin/privacy/requests/${request.requestId}/erase`, {
      method: 'POST',
      headers: headers(owner, true),
    });
    expect(erase.status).toBe(412);
    expect(JSON.stringify(await erase.json())).toMatch(/legal hold/i);

    // The subject is untouched.
    expect(db.select().from(schema.users).where(eq(schema.users.id, subject.userId)).get()!.name)
      .toBe('Subject Under Test');

    // Releasing the hold unblocks the decision — it does not make one.
    const release = await app.request(`/v1/admin/privacy/holds/${holdId}/release`, {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ reason: 'Claim settled and closed.' }),
    });
    expect(release.status).toBe(200);
    expect(
      db.select().from(schema.privacyRequests).where(eq(schema.privacyRequests.id, request.requestId)).get()!.state,
    ).toBe('in_review');
  });

  it('lands a new deletion request straight into on_hold when a hold is already in force', async () => {
    const owner = await signIn(OWNER);
    const subject = makeSubject({ lifecycle: 'lapsed', membershipEndsOn: '2020-01-01' });

    await app.request('/v1/admin/privacy/holds', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ subjectUserId: subject.userId, reason: 'Ongoing dispute.', reference: null }),
    });

    const request = await raise(owner, subject.userId, 'deletion');
    expect(request.state).toBe('on_hold');

    // An export is not blocked by a hold. Seeing your own data is not the same
    // act as destroying evidence.
    const exportRequest = await raise(owner, subject.userId, 'export');
    expect(exportRequest.state).toBe('submitted');
  });
});

describe('retention policy is evaluated, not guessed', () => {
  it('reports no end date at all while the membership is live', () => {
    const subject = makeSubject({ membershipEndsOn: null });
    const evaluation = evaluateRetention(TENANT, subject.memberId);
    // The clock starts when the relationship ends, and it has not.
    expect(evaluation.relationshipEndedOn).toBeNull();
    expect(evaluation.retainUntil).toBeNull();
    expect(evaluation.withinRetentionWindow).toBe(false);
  });

  it('blocks erasure inside the tenant’s own retention window and says until when', async () => {
    const owner = await signIn(OWNER);
    // Ended yesterday: comfortably inside the seeded 1,095-day window.
    const endedOn = new Date(now() - DAY).toISOString().slice(0, 10);
    const subject = makeSubject({ lifecycle: 'lapsed', membershipEndsOn: endedOn });

    const evaluation = evaluateRetention(TENANT, subject.memberId);
    expect(evaluation.retentionDays).toBe(1095);
    expect(evaluation.withinRetentionWindow).toBe(true);
    expect(evaluation.retainUntil).toBeTruthy();

    const request = await raise(owner, subject.userId, 'deletion');
    const erase = await app.request(`/v1/admin/privacy/requests/${request.requestId}/erase`, {
      method: 'POST',
      headers: headers(owner, true),
    });
    expect(erase.status).toBe(412);
    const message = JSON.stringify(await erase.json());
    expect(message).toMatch(/retention policy/i);
    expect(message).toContain(evaluation.retainUntil!);
  });
});

describe('the anonymisation plan', () => {
  it('is deterministic, so a reviewer approves the thing that runs', () => {
    const subject = makeSubject({ lifecycle: 'lapsed', membershipEndsOn: '2019-01-01' });
    const first = anonymisationPlan(TENANT, subject.userId, subject.memberId);
    const second = anonymisationPlan(TENANT, subject.userId, subject.memberId);
    expect(second).toEqual(first);
    expect(first.pseudonym).toBe(pseudonymFor(subject.userId));
    // The same subject is the same anonymous person everywhere, and a
    // different subject is a different one.
    expect(pseudonymFor(subject.userId)).not.toBe(pseudonymFor(`${subject.userId}x`));
  });

  it('names every field it would overwrite and every record it would keep', () => {
    const subject = makeSubject({ lifecycle: 'lapsed', membershipEndsOn: '2019-01-01' });
    const plan = anonymisationPlan(TENANT, subject.userId, subject.memberId);

    const fields = plan.overwrites.filter((row) => row.table === 'members').map((row) => row.field);
    for (const expected of ['firstName', 'email', 'phone', 'dob', 'addressLine', 'emergencyContact']) {
      expect(fields).toContain(expected);
    }

    const preserved = plan.preserved.map((row) => row.table);
    for (const expected of ['invoices', 'payments', 'audit_log', 'consents', 'check_ins']) {
      expect(preserved).toContain(expected);
    }
    expect(plan.blockers).toEqual([]);
  });
});

describe('erasure preserves what it must', () => {
  it('pseudonymises the person and leaves the accounting standing', async () => {
    const owner = await signIn(OWNER);
    const subject = makeSubject({ lifecycle: 'lapsed', membershipEndsOn: '2019-01-01' });
    const request = await raise(owner, subject.userId, 'deletion');

    const erase = await app.request(`/v1/admin/privacy/requests/${request.requestId}/erase`, {
      method: 'POST',
      headers: headers(owner, true),
    });
    expect(erase.status).toBe(200);
    const result = (await erase.json()) as { pseudonym: string; applied: number };
    expect(result.applied).toBeGreaterThan(0);

    // The person is gone from the record.
    const user = db.select().from(schema.users).where(eq(schema.users.id, subject.userId)).get()!;
    expect(user.name).toBe(result.pseudonym);
    expect(user.email).toBeNull();
    expect(user.phone).toBeNull();
    expect(user.accountState).toBe('erased');

    const member = db.select().from(schema.members).where(eq(schema.members.id, subject.memberId)).get()!;
    expect(member.email).toBeNull();
    expect(member.phone).toBeNull();
    expect(member.dob).toBeNull();
    expect(member.addressLine).toBeNull();
    expect(member.emergencyContact).toBeNull();
    expect(member.firstName).toBe(result.pseudonym);

    // The invoice is still there, still linked, still worth what it was worth.
    const invoice = db.select().from(schema.invoices).where(eq(schema.invoices.id, subject.invoiceId)).get()!;
    expect(invoice).toBeTruthy();
    expect(invoice.memberId).toBe(subject.memberId);
    expect(invoice.totalMinor).toBe(100_000);

    // Sessions are revoked: an erased account stays signed in nowhere.
    expect(
      db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.userId, subject.userId)))
        .all()
        .every((row) => row.revokedAt !== null),
    ).toBe(true);

    // And the request is closed with who closed it and when.
    const closed = db
      .select()
      .from(schema.privacyRequests)
      .where(eq(schema.privacyRequests.id, request.requestId))
      .get()!;
    expect(closed.state).toBe('completed');
    expect(closed.completedAt).toBeTruthy();
    expect(closed.completedByUserId).toBeTruthy();
  });

  it('cannot destroy the audit trail, even deliberately', async () => {
    const owner = await signIn(OWNER);
    const subject = makeSubject({ lifecycle: 'lapsed', membershipEndsOn: '2019-01-01' });
    const request = await raise(owner, subject.userId, 'deletion');
    await app.request(`/v1/admin/privacy/requests/${request.requestId}/erase`, {
      method: 'POST',
      headers: headers(owner, true),
    });

    // The erasure is itself on the trail, and states what was kept.
    const entry = db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, request.requestId),
          eq(schema.auditLog.action, 'privacy.erasure_applied'),
        ),
      )
      .get()!;
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry.changes)).toMatch(/invoices|payments/);

    // The trigger refuses regardless of who is asking. This is the guarantee
    // the whole preservation story rests on.
    expect(() => db.delete(schema.auditLog).where(eq(schema.auditLog.id, entry.id)).run()).toThrow(
      /append-only/i,
    );
  });
});

describe('the export package', () => {
  it('is an internal artifact with a checksum, and claims no delivery', async () => {
    const owner = await signIn(OWNER);
    const subject = makeSubject();
    const request = await raise(owner, subject.userId, 'export');

    const generate = await app.request(`/v1/admin/privacy/requests/${request.requestId}/export`, {
      method: 'POST',
      headers: headers(owner, true),
    });
    expect(generate.status).toBe(201);
    const body = (await generate.json()) as {
      artifactId: string;
      checksum: string;
      byteSize: number;
      delivery: { sent: boolean; reason: string; message: string };
    };

    expect(body.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(body.byteSize).toBeGreaterThan(0);
    // The one thing this system cannot do, said where somebody will read it.
    expect(body.delivery.sent).toBe(false);
    expect(body.delivery.reason).toBe('no_delivery_provider_configured');
    expect(body.delivery.message).toMatch(/manual step/i);

    // The package is the data, and the checksum is checkable rather than
    // asserted.
    const artifact = db
      .select()
      .from(schema.privacyArtifacts)
      .where(eq(schema.privacyArtifacts.id, body.artifactId))
      .get()!;
    const payload = artifact.payload as Record<string, unknown>;
    expect(payload.subject).toMatchObject({ userId: subject.userId });
    expect(payload.invoices).toBeDefined();
    expect((payload.notice as { delivery: string }).delivery).toMatch(/not emailed and not uploaded/i);

    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(JSON.stringify(payload)).digest('hex')).toBe(body.checksum);
  });

  it('refuses an export generated against a deletion request, and vice versa', async () => {
    const owner = await signIn(OWNER);
    const subject = makeSubject({ lifecycle: 'lapsed', membershipEndsOn: '2019-01-01' });
    const deletion = await raise(owner, subject.userId, 'deletion');
    const exportRequest = await raise(owner, subject.userId, 'export');

    const wrongExport = await app.request(`/v1/admin/privacy/requests/${deletion.requestId}/export`, {
      method: 'POST',
      headers: headers(owner, true),
    });
    expect(wrongExport.status).toBe(422);

    const wrongErase = await app.request(`/v1/admin/privacy/requests/${exportRequest.requestId}/erase`, {
      method: 'POST',
      headers: headers(owner, true),
    });
    expect(wrongErase.status).toBe(422);
  });
});

describe('privacy work is not a branch manager’s job', () => {
  it('refuses the queue, holds and erasure to a role without settings.manage', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const owner = await signIn(OWNER);
    const subject = makeSubject();
    const request = await raise(owner, subject.userId, 'export');

    for (const [method, path, body] of [
      ['GET', '/v1/admin/privacy/requests', null],
      ['GET', `/v1/admin/privacy/requests/${request.requestId}`, null],
      ['GET', '/v1/admin/privacy/holds', null],
    ] as Array<[string, string, string | null]>) {
      const response = await app.request(path, { method, headers: headers(manager, body !== null) });
      expect(response.status).toBe(403);
    }

    const hold = await app.request('/v1/admin/privacy/holds', {
      method: 'POST',
      headers: headers(manager, true),
      body: JSON.stringify({ subjectUserId: subject.userId, reason: 'Should not work.', reference: null }),
    });
    expect(hold.status).toBe(403);

    const erase = await app.request(`/v1/admin/privacy/requests/${request.requestId}/erase`, {
      method: 'POST',
      headers: headers(manager, true),
    });
    expect(erase.status).toBe(403);
  });

  it('does not reach a subject in another tenant', async () => {
    const owner = await signIn(OWNER);
    // The seed carries a second tenant precisely so isolation can be tested
    // from the outside. Asserted rather than skipped: a `return` here would
    // make this test pass on a seed that had no second tenant at all.
    const otherTenantUser = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'owner'), ne(schema.users.tenantId, TENANT)))
      .get();
    expect(otherTenantUser).toBeTruthy();

    const response = await app.request('/v1/admin/privacy/requests', {
      method: 'POST',
      headers: headers(owner, true),
      body: JSON.stringify({ subjectUserId: otherTenantUser!.id, kind: 'export', reason: null }),
    });
    // Not found: the subject exists, in a tenant this caller cannot see.
    expect(response.status).toBe(404);
  });
});
