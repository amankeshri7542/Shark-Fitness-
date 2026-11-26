import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { hashToken } from '../lib/crypto.js';
import { id } from '../lib/ids.js';
import { DAY, MINUTE, addDays, now } from '../lib/time.js';
import { STAFF_IDLE_TIMEOUT_MINUTES } from '@shark/contracts';
import { call, signIn, staffIdFor, userIdFor, type TestSession } from './helpers/session.js';
import { createMember } from './support/fixtures.js';

/* ============================================================================
   Admin console reads and one delete that no other suite reached (P08 route
   coverage): webhook endpoint removal, the dunning queue, challenge
   invitations, the privacy export read, report branches, schedule resources,
   security and engagement settings, product groups and task assignees.
   Every fixture here is this file's own; tenant policy it touches is restored.
   ========================================================================= */

const TENANT = 'ten_shark';
const REEF = 'ten_reef';

let owner: TestSession;
let manager: TestSession; // branch_manager, br_kor only
let reception: TestSession; // reception, br_kor only
let trainer: TestSession; // trainer, every branch
let accountant: TestSession;
let reefOwner: TestSession;

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

function auditRows(entityId: string, action: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.entityId, entityId), eq(schema.auditLog.action, action)))
    .all();
}

function sessionRowOf(session: TestSession) {
  const token = session.cookie.match(/shark_session=([^;]+)/)![1]!;
  return db.select().from(schema.sessions).where(sql`token_hash = ${hashToken(token)}`).get()!;
}

const shark = () => db.select().from(schema.tenants).where(eq(schema.tenants.id, TENANT)).get()!;
const allSharkBranches = () =>
  db.select({ id: schema.branches.id, name: schema.branches.name }).from(schema.branches).where(eq(schema.branches.tenantId, TENANT)).all();

const createdEndpointIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdChallengeIds: string[] = [];

beforeAll(async () => {
  [owner, manager, reception, trainer, accountant, reefOwner] = await Promise.all([
    signIn('owner@sharkfitness.in', 'shark', true),
    signIn('manager@sharkfitness.in'),
    signIn('reception@sharkfitness.in'),
    signIn('rehan@sharkfitness.in'),
    signIn('accounts@sharkfitness.in'),
    signIn('owner@reefathletic.in', 'reef', true),
  ]);
});

afterAll(() => {
  if (createdEndpointIds.length) {
    db.update(schema.webhookEndpoints).set({ deletedAt: now(), state: 'paused' }).where(inArray(schema.webhookEndpoints.id, createdEndpointIds)).run();
  }
  if (createdInvoiceIds.length) {
    db.delete(schema.dunningAttempts).where(inArray(schema.dunningAttempts.invoiceId, createdInvoiceIds)).run();
    db.delete(schema.invoices).where(inArray(schema.invoices.id, createdInvoiceIds)).run();
  }
  if (createdChallengeIds.length) {
    db.delete(schema.challengeInvitations).where(inArray(schema.challengeInvitations.challengeId, createdChallengeIds)).run();
    db.delete(schema.challenges).where(inArray(schema.challenges.id, createdChallengeIds)).run();
  }
});

/* ——— DELETE /v1/admin/integrations/webhooks/:endpointId ———————————— */

function insertEndpoint(tenantId: string, createdByUserId: string): string {
  const endpointId = id('whe');
  const at = now();
  db.insert(schema.webhookEndpoints)
    .values({
      id: endpointId,
      tenantId,
      url: `https://hooks.example.com/p08/${endpointId}`,
      description: 'P08 route coverage',
      events: ['lead.created'],
      state: 'active',
      secretCiphertext: 'not-read-by-delete',
      secretHint: 'abcd',
      cursorSeq: 0,
      createdByUserId,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  createdEndpointIds.push(endpointId);
  return endpointId;
}

function insertDelivery(endpointId: string, state: 'pending' | 'succeeded'): string {
  const deliveryId = id('whd');
  db.insert(schema.webhookDeliveries)
    .values({
      id: deliveryId,
      tenantId: TENANT,
      endpointId,
      eventId: id('evt'),
      eventType: 'lead.created',
      body: '{}',
      state,
      attempts: state === 'pending' ? 0 : 1,
      nextAttemptAt: state === 'pending' ? now() + 10 * MINUTE : null,
      createdAt: now(),
      completedAt: state === 'pending' ? null : now(),
    })
    .run();
  return deliveryId;
}

describe('DELETE /v1/admin/integrations/webhooks/:endpointId', () => {
  it('soft-deletes the endpoint, fails its pending deliveries, keeps finished ones, and audits it', async () => {
    const endpointId = insertEndpoint(TENANT, userIdFor('owner@sharkfitness.in'));
    const pending = insertDelivery(endpointId, 'pending');
    const done = insertDelivery(endpointId, 'succeeded');

    const response = await call(owner, 'DELETE', `/v1/admin/integrations/webhooks/${endpointId}`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });

    const row = db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpointId)).get()!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.state).toBe('paused');
    const pendingRow = db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, pending)).get()!;
    expect(pendingRow).toMatchObject({ state: 'failed', lastError: 'Endpoint deleted.' });
    expect(pendingRow.completedAt).not.toBeNull();
    expect(db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, done)).get()!.state).toBe('succeeded');

    const audits = auditRows(endpointId, 'webhook.endpoint_deleted');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: TENANT, entityLabel: 'hooks.example.com', actorId: userIdFor('owner@sharkfitness.in') });

    // Gone from the list, and a second delete finds nothing.
    const list = await json<{ items: Array<{ id: string }> }>(await call(owner, 'GET', '/v1/admin/integrations/webhooks'));
    expect(list.items.map((item) => item.id)).not.toContain(endpointId);
    expect((await call(owner, 'DELETE', `/v1/admin/integrations/webhooks/${endpointId}`)).status).toBe(404);
  });

  it('is refused to a role without settings.manage and cannot reach another gym’s endpoint', async () => {
    const endpointId = insertEndpoint(TENANT, userIdFor('owner@sharkfitness.in'));
    const denied = await call(manager, 'DELETE', `/v1/admin/integrations/webhooks/${endpointId}`);
    expect(denied.status).toBe(403);
    expect(errorCode(await json(denied))).toBe('FORBIDDEN');

    const crossTenant = await call(reefOwner, 'DELETE', `/v1/admin/integrations/webhooks/${endpointId}`);
    expect(crossTenant.status).toBe(404);

    const row = db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpointId)).get()!;
    expect(row.deletedAt).toBeNull();
    expect(row.state).toBe('active');
  });
});

/* ——— GET /v1/admin/billing/dunning ————————————————————————————————— */

function insertOverdueInvoice(branchId: string, memberId: string, attempts: number): string {
  const template = db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.tenantId, TENANT), inArray(schema.invoices.state, ['open', 'overdue'])))
    .get()!;
  const invoiceId = id('inv');
  db.insert(schema.invoices)
    .values({
      ...template,
      id: invoiceId,
      branchId,
      memberId,
      number: `P08D-${invoiceId.slice(-8).toUpperCase()}`,
      state: 'overdue',
      totalMinor: 250_000,
      paidMinor: 100_000,
      refundedMinor: 0,
      currency: 'INR',
      refType: null,
      refId: null,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  createdInvoiceIds.push(invoiceId);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    db.insert(schema.dunningAttempts)
      .values({
        id: id('dun'),
        tenantId: TENANT,
        invoiceId,
        attempt,
        channel: attempt === 1 ? 'in_app' : 'email',
        scheduledFor: now() - (attempts - attempt) * DAY,
        state: attempt === 1 ? 'sent' : 'scheduled',
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }
  return invoiceId;
}

describe('GET /v1/admin/billing/dunning', () => {
  it('lists unpaid invoices with dunning attempts, inside the caller’s branches only', async () => {
    const korMember = createMember({ branchId: 'br_kor', state: null, firstName: 'Dunkor' });
    const indMember = createMember({ branchId: 'br_ind', state: null, firstName: 'Dunind' });
    const kor = insertOverdueInvoice('br_kor', korMember.memberId, 2);
    const ind = insertOverdueInvoice('br_ind', indMember.memberId, 1);
    // Unpaid but never chased: not on the dunning queue.
    const quiet = insertOverdueInvoice('br_kor', korMember.memberId, 0);

    const ownerView = await call(owner, 'GET', '/v1/admin/billing/dunning');
    expect(ownerView.status).toBe(200);
    const ownerItems = (await json<{ items: Array<Record<string, unknown> & { invoiceId: string }> }>(ownerView)).items;
    const korItem = ownerItems.find((item) => item.invoiceId === kor);
    expect(korItem).toMatchObject({
      state: 'overdue',
      memberId: korMember.memberId,
      memberName: 'Dunkor Member',
      attempts: [
        { attempt: 1, channel: 'in_app', state: 'sent' },
        { attempt: 2, channel: 'email', state: 'scheduled' },
      ],
    });
    // Due is what is still owed (total minus paid), in rupees.
    expect(korItem!.dueLabel).toMatch(/1,500/);
    expect(ownerItems.map((item) => item.invoiceId)).toContain(ind);
    expect(ownerItems.map((item) => item.invoiceId)).not.toContain(quiet);

    const managerItems = (await json<{ items: Array<{ invoiceId: string }> }>(await call(manager, 'GET', '/v1/admin/billing/dunning'))).items;
    expect(managerItems.map((item) => item.invoiceId)).toContain(kor);
    expect(managerItems.map((item) => item.invoiceId)).not.toContain(ind);
  });

  it('is refused to a role without billing.view', async () => {
    const denied = await call(trainer, 'GET', '/v1/admin/billing/dunning');
    expect(denied.status).toBe(403);
  });
});

/* ——— GET /v1/admin/engagement/challenges/:challengeId/invitations —————— */

function insertChallenge(branchId: string | null): string {
  const challengeId = id('chl');
  const today = new Date().toISOString().slice(0, 10);
  db.insert(schema.challenges)
    .values({
      id: challengeId,
      tenantId: TENANT,
      branchId,
      name: `P08 invite list ${challengeId.slice(-5)}`,
      description: 'Route coverage.',
      metric: 'sessions',
      metricLabel: 'sessions',
      startsOn: addDays(today, -2),
      endsOn: addDays(today, 20),
      visibility: 'private',
      teamMode: false,
      teamTarget: null,
      rules: ['Invitation only.'],
      rewardLabel: null,
      createdAt: now(),
    })
    .run();
  createdChallengeIds.push(challengeId);
  return challengeId;
}

function invite(challengeId: string, memberId: string, expiresAt: number | null, state = 'pending'): void {
  db.insert(schema.challengeInvitations)
    .values({
      id: id('cin'),
      tenantId: TENANT,
      challengeId,
      memberId,
      invitedByUserId: userIdFor('owner@sharkfitness.in'),
      state,
      expiresAt,
      respondedAt: state === 'pending' ? null : now(),
      createdAt: now() - DAY,
      updatedAt: now() - DAY,
    })
    .run();
}

describe('GET /v1/admin/engagement/challenges/:challengeId/invitations', () => {
  it('lists invitations with their honest state, filtered to the caller’s branches', async () => {
    const challengeId = insertChallenge(null);
    const kor = createMember({ branchId: 'br_kor', state: null, firstName: 'Invkor' });
    const lapsed = createMember({ branchId: 'br_kor', state: null, firstName: 'Invlapsed' });
    const ind = createMember({ branchId: 'br_ind', state: null, firstName: 'Invind' });
    invite(challengeId, kor.memberId, now() + 5 * DAY);
    // Still `pending` in the column, but its expiry passed: reported as expired.
    invite(challengeId, lapsed.memberId, now() - MINUTE);
    invite(challengeId, ind.memberId, null, 'declined');

    const response = await call(owner, 'GET', `/v1/admin/engagement/challenges/${challengeId}/invitations`);
    expect(response.status).toBe(200);
    const body = await json<{
      challenge: { id: string; visibility: string };
      invitations: Array<{ memberId: string; memberName: string; state: string; participating: boolean }>;
    }>(response);
    expect(body.challenge).toMatchObject({ id: challengeId, visibility: 'private' });
    const byMember = new Map(body.invitations.map((row) => [row.memberId, row]));
    expect(byMember.size).toBe(3);
    expect(byMember.get(kor.memberId)).toMatchObject({ memberName: 'Invkor Member', state: 'pending', participating: false });
    expect(byMember.get(lapsed.memberId)!.state).toBe('expired');
    expect(byMember.get(ind.memberId)!.state).toBe('declined');

    const managerView = await json<{ invitations: Array<{ memberId: string }> }>(
      await call(manager, 'GET', `/v1/admin/engagement/challenges/${challengeId}/invitations`),
    );
    expect(managerView.invitations.map((row) => row.memberId).sort()).toEqual([kor.memberId, lapsed.memberId].sort());
  });

  it('answers 404 for a challenge outside the caller’s branches or tenant, and 403 without community.moderate', async () => {
    const indChallenge = insertChallenge('br_ind');
    expect((await call(manager, 'GET', `/v1/admin/engagement/challenges/${indChallenge}/invitations`)).status).toBe(404);
    expect((await call(reefOwner, 'GET', `/v1/admin/engagement/challenges/${indChallenge}/invitations`)).status).toBe(404);
    expect((await call(owner, 'GET', `/v1/admin/engagement/challenges/${indChallenge}/invitations`)).status).toBe(200);
    expect((await call(trainer, 'GET', `/v1/admin/engagement/challenges/${indChallenge}/invitations`)).status).toBe(403);
  });
});

/* ——— GET /v1/admin/privacy/requests/:id/export ———————————————————————— */

describe('GET /v1/admin/privacy/requests/:id/export', () => {
  it('returns the generated package and records that it was read', async () => {
    const fresh = await signIn('owner@sharkfitness.in', 'shark', true);
    const subject = createMember({ state: null, withLogin: true, firstName: 'Exportee' });
    const raised = await call(fresh, 'POST', '/v1/admin/privacy/requests', { subjectUserId: subject.userId, kind: 'export', reason: null });
    expect(raised.status).toBe(201);
    const { requestId } = await json<{ requestId: string }>(raised);

    // Nothing generated yet: there is no package to read.
    const before = await call(fresh, 'GET', `/v1/admin/privacy/requests/${requestId}/export`);
    expect(before.status).toBe(404);

    const generated = await call(fresh, 'POST', `/v1/admin/privacy/requests/${requestId}/export`);
    expect(generated.status).toBe(201);
    const { artifactId, checksum } = await json<{ artifactId: string; checksum: string }>(generated);

    const read = await call(fresh, 'GET', `/v1/admin/privacy/requests/${requestId}/export`);
    expect(read.status).toBe(200);
    const artifact = await json<{ id: string; requestId: string; checksum: string; format: string; payload: { subject: { userId: string; name: string } } }>(read);
    expect(artifact).toMatchObject({ id: artifactId, requestId, checksum, format: 'json' });
    expect(artifact.payload.subject).toMatchObject({ userId: subject.userId, name: 'Exportee Member' });

    const audits = auditRows(requestId, 'privacy.export_read');
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.changes)).toContain(artifactId);
  });

  it('needs settings.manage and a recent re-authentication', async () => {
    const fresh = await signIn('owner@sharkfitness.in', 'shark', true);
    const subject = createMember({ state: null, withLogin: true, firstName: 'Stepup' });
    const { requestId } = await json<{ requestId: string }>(
      await call(fresh, 'POST', '/v1/admin/privacy/requests', { subjectUserId: subject.userId, kind: 'export', reason: null }),
    );
    expect((await call(fresh, 'POST', `/v1/admin/privacy/requests/${requestId}/export`)).status).toBe(201);

    expect((await call(manager, 'GET', `/v1/admin/privacy/requests/${requestId}/export`)).status).toBe(403);
    expect((await call(reefOwner, 'GET', `/v1/admin/privacy/requests/${requestId}/export`)).status).toBe(404);

    const session = sessionRowOf(fresh);
    db.update(schema.sessions).set({ reauthenticatedAt: now() - 6 * MINUTE }).where(eq(schema.sessions.id, session.id)).run();
    const stale = await call(fresh, 'GET', `/v1/admin/privacy/requests/${requestId}/export`);
    expect(stale.status).toBe(401);
    expect(errorCode(await json(stale))).toBe('STEP_UP_REQUIRED');
    expect(auditRows(requestId, 'privacy.export_read')).toHaveLength(0);
  });
});

/* ——— GET /v1/admin/reports/branches ———————————————————————————————— */

describe('GET /v1/admin/reports/branches', () => {
  it('names exactly the branches the caller may report on', async () => {
    const branches = allSharkBranches();
    const ownerView = await json<{ items: Array<{ id: string; name: string }> }>(await call(owner, 'GET', '/v1/admin/reports/branches'));
    expect(ownerView.items.map((b) => b.id).sort()).toEqual(branches.map((b) => b.id).sort());
    for (const item of ownerView.items) expect(item.name).toBe(branches.find((b) => b.id === item.id)!.name);

    const managerView = await json<{ items: Array<{ id: string }> }>(await call(manager, 'GET', '/v1/admin/reports/branches'));
    expect(managerView.items.map((b) => b.id)).toEqual(['br_kor']);

    const reefView = await json<{ items: Array<{ id: string }> }>(await call(reefOwner, 'GET', '/v1/admin/reports/branches'));
    expect(reefView.items.some((b) => branches.some((own) => own.id === b.id))).toBe(false);
  });

  it('is refused to a role without report.view', async () => {
    expect((await call(reception, 'GET', '/v1/admin/reports/branches')).status).toBe(403);
  });
});

/* ——— GET /v1/admin/schedule/resources ——————————————————————————————— */

describe('GET /v1/admin/schedule/resources', () => {
  interface Resources {
    classTypes: Array<{ id: string; name: string; durationMin: number }>;
    rooms: Array<{ id: string; branchId: string }>;
    trainers: Array<{ id: string; name: string; branchIds: string[] }>;
    branches: Array<{ id: string; name: string }>;
  }

  it('offers class types, and only rooms, trainers and branches in the caller’s scope', async () => {
    const ownerView = await json<Resources>(await call(owner, 'GET', '/v1/admin/schedule/resources'));
    const sharkClassTypes = db.select({ id: schema.classTypes.id }).from(schema.classTypes).where(eq(schema.classTypes.tenantId, TENANT)).all();
    expect(ownerView.classTypes.map((t) => t.id).sort()).toEqual(sharkClassTypes.map((t) => t.id).sort());
    // Alphabetical, so the picker reads in order.
    expect(ownerView.classTypes.map((t) => t.name)).toEqual([...ownerView.classTypes.map((t) => t.name)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(ownerView.rooms.map((r) => r.branchId)).size).toBeGreaterThan(1);
    expect(ownerView.branches.map((b) => b.id).sort()).toEqual(allSharkBranches().map((b) => b.id).sort());
    expect(ownerView.trainers.map((t) => t.id)).toContain(staffIdFor('rehan@sharkfitness.in'));
    // Reception does not teach classes.
    expect(ownerView.trainers.map((t) => t.id)).not.toContain(staffIdFor('reception@sharkfitness.in'));

    const managerView = await json<Resources>(await call(manager, 'GET', '/v1/admin/schedule/resources'));
    expect(managerView.rooms.length).toBeGreaterThan(0);
    expect(managerView.rooms.every((r) => r.branchId === 'br_kor')).toBe(true);
    expect(managerView.branches.map((b) => b.id)).toEqual(['br_kor']);
    expect(managerView.trainers.every((t) => t.branchIds.includes('br_kor'))).toBe(true);
  });

  it('is refused to a role without schedule.view', async () => {
    expect((await call(accountant, 'GET', '/v1/admin/schedule/resources')).status).toBe(403);
  });
});

/* ——— GET /v1/admin/security/settings ———————————————————————————————— */

describe('GET /v1/admin/security/settings', () => {
  it('reads the gym’s own sign-in policy, falling back to the default for an out-of-range value', async () => {
    const reef = db.select().from(schema.tenants).where(eq(schema.tenants.id, REEF)).get()!;
    const original = reef.policy;
    try {
      db.update(schema.tenants)
        .set({ policy: { ...(original as Record<string, unknown>), staffIdleTimeoutMinutes: 120, requireMfaForStaff: true } as never })
        .where(eq(schema.tenants.id, REEF))
        .run();
      const reefView = await json<{ requireMfaForStaff: boolean; staffIdleTimeoutMinutes: number; mandatoryRoles: string[] }>(
        await call(reefOwner, 'GET', '/v1/admin/security/settings'),
      );
      expect(reefView).toMatchObject({ requireMfaForStaff: true, staffIdleTimeoutMinutes: 120 });
      expect(reefView.mandatoryRoles).toContain('owner');

      // The other gym's policy is its own.
      const sharkPolicy = (shark().policy ?? {}) as Record<string, unknown>;
      const sharkView = await json<{ requireMfaForStaff: boolean; staffIdleTimeoutMinutes: number }>(
        await call(owner, 'GET', '/v1/admin/security/settings'),
      );
      expect(sharkView.requireMfaForStaff).toBe(sharkPolicy.requireMfaForStaff === true);

      db.update(schema.tenants)
        .set({ policy: { ...(original as Record<string, unknown>), staffIdleTimeoutMinutes: 5 } as never })
        .where(eq(schema.tenants.id, REEF))
        .run();
      const clamped = await json<{ staffIdleTimeoutMinutes: number }>(await call(reefOwner, 'GET', '/v1/admin/security/settings'));
      expect(clamped.staffIdleTimeoutMinutes).toBe(STAFF_IDLE_TIMEOUT_MINUTES.default);
    } finally {
      db.update(schema.tenants).set({ policy: original }).where(eq(schema.tenants.id, REEF)).run();
    }
  });

  it('is refused to a role without settings.manage', async () => {
    expect((await call(manager, 'GET', '/v1/admin/security/settings')).status).toBe(403);
  });
});

/* ——— GET /v1/admin/settings/engagement —————————————————————————————— */

describe('GET /v1/admin/settings/engagement', () => {
  it('reads the gym’s engagement policy, with defaults for what it never set', async () => {
    const reef = db.select().from(schema.tenants).where(eq(schema.tenants.id, REEF)).get()!;
    const original = reef.policy;
    try {
      const base = { ...(original as Record<string, unknown>) };
      delete base.broadcastApprovalThreshold;
      delete base.messageRates;
      db.update(schema.tenants)
        .set({ policy: { ...base, communityApprovalMode: true, allowStaffMinorMessaging: false } as never })
        .where(eq(schema.tenants.id, REEF))
        .run();
      const response = await call(reefOwner, 'GET', '/v1/admin/settings/engagement');
      expect(response.status).toBe(200);
      const { settings } = await json<{ settings: { communityApprovalMode: boolean; allowStaffMinorMessaging: boolean; broadcastApprovalThreshold: number; messageRates: Record<string, number> } }>(response);
      expect(settings).toMatchObject({ communityApprovalMode: true, allowStaffMinorMessaging: false, broadcastApprovalThreshold: 200 });
      expect(Object.keys(settings.messageRates)).toEqual(expect.arrayContaining(['in_app', 'email', 'sms']));

      db.update(schema.tenants)
        .set({ policy: { ...base, broadcastApprovalThreshold: 35, messageRates: { sms: 42 } } as never })
        .where(eq(schema.tenants.id, REEF))
        .run();
      const updated = (await json<{ settings: { communityApprovalMode: boolean; broadcastApprovalThreshold: number; messageRates: Record<string, number> } }>(
        await call(reefOwner, 'GET', '/v1/admin/settings/engagement'),
      )).settings;
      expect(updated.communityApprovalMode).toBe(false);
      expect(updated.broadcastApprovalThreshold).toBe(35);
      expect(updated.messageRates.sms).toBe(42);
    } finally {
      db.update(schema.tenants).set({ policy: original }).where(eq(schema.tenants.id, REEF)).run();
    }
  });

  it('is refused to a role without settings.manage', async () => {
    expect((await call(manager, 'GET', '/v1/admin/settings/engagement')).status).toBe(403);
  });
});

/* ——— GET /v1/admin/store/groups ————————————————————————————————————— */

describe('GET /v1/admin/store/groups', () => {
  it('lists this gym’s product groups, including one just created, and none of another gym’s', async () => {
    const name = `P08 Shakers ${id('x').slice(-6)}`;
    const created = await call(manager, 'POST', '/v1/admin/store/groups', { name, category: 'Accessories' });
    expect(created.status).toBe(201);
    const { group } = await json<{ group: { id: string } }>(created);

    const response = await call(reception, 'GET', '/v1/admin/store/groups');
    expect(response.status).toBe(200);
    const { items } = await json<{ items: Array<{ id: string; name: string; category: string; active: boolean; supplierId: string | null }> }>(response);
    expect(items.find((item) => item.id === group.id)).toMatchObject({ name, category: 'Accessories', active: true, supplierId: null });
    const sharkCount = db.select({ id: schema.retailProductGroups.id }).from(schema.retailProductGroups).where(eq(schema.retailProductGroups.tenantId, TENANT)).all().length;
    expect(items).toHaveLength(sharkCount);

    const reefItems = (await json<{ items: Array<{ id: string }> }>(await call(reefOwner, 'GET', '/v1/admin/store/groups'))).items;
    expect(reefItems.map((item) => item.id)).not.toContain(group.id);
  });

  it('is refused to a role without inventory.view', async () => {
    expect((await call(trainer, 'GET', '/v1/admin/store/groups')).status).toBe(403);
  });
});

/* ——— GET /v1/admin/tasks/assignees ——————————————————————————————————— */

describe('GET /v1/admin/tasks/assignees', () => {
  it('names active staff who work at the branch', async () => {
    const response = await call(manager, 'GET', '/v1/admin/tasks/assignees?branchId=br_kor');
    expect(response.status).toBe(200);
    const { items } = await json<{ items: Array<{ staffId: string; name: string; role: string }> }>(response);
    const ids = items.map((item) => item.staffId);
    expect(ids).toEqual(expect.arrayContaining([staffIdFor('reception@sharkfitness.in'), staffIdFor('manager@sharkfitness.in'), staffIdFor('rehan@sharkfitness.in')]));
    expect(items.find((item) => item.staffId === staffIdFor('reception@sharkfitness.in'))!.role).toBe('reception');

    // Reception works only at Koramangala, so is not offered elsewhere.
    const elsewhere = await json<{ items: Array<{ staffId: string }> }>(await call(owner, 'GET', '/v1/admin/tasks/assignees?branchId=br_ind'));
    expect(elsewhere.items.map((item) => item.staffId)).not.toContain(staffIdFor('reception@sharkfitness.in'));
    expect(elsewhere.items.map((item) => item.staffId)).toContain(staffIdFor('rehan@sharkfitness.in'));
  });

  it('drops staff whose account is not active', async () => {
    const userId = userIdFor('nikhil@sharkfitness.in');
    const staffId = staffIdFor('nikhil@sharkfitness.in');
    const before = db.select({ accountState: schema.users.accountState }).from(schema.users).where(eq(schema.users.id, userId)).get()!.accountState;
    try {
      db.update(schema.users).set({ accountState: 'suspended' }).where(eq(schema.users.id, userId)).run();
      const { items } = await json<{ items: Array<{ staffId: string }> }>(await call(owner, 'GET', '/v1/admin/tasks/assignees?branchId=br_kor'));
      expect(items.map((item) => item.staffId)).not.toContain(staffId);
    } finally {
      db.update(schema.users).set({ accountState: before }).where(eq(schema.users.id, userId)).run();
    }
  });

  it('refuses a branch outside scope (404), a missing branch (422) and a role without task.view (403)', async () => {
    expect((await call(manager, 'GET', '/v1/admin/tasks/assignees?branchId=br_ind')).status).toBe(404);
    const missing = await call(manager, 'GET', '/v1/admin/tasks/assignees');
    expect(missing.status).toBe(422);
    expect(errorCode(await json(missing))).toBe('VALIDATION_FAILED');
    const member = await signIn('rohit@sharkfitness.in');
    expect((await call(member, 'GET', '/v1/admin/tasks/assignees?branchId=br_kor')).status).toBe(403);
  });
});
