import { describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import {
  OPERATIONAL_RETENTION_MS,
  pruneOperationalData,
} from '../services/maintenance.js';

// Deliberately before every seeded timestamp. This makes the eligible set
// consist only of rows arranged by this file, without deleting shared seed
// fixtures or depending on the wall clock.
const AT = Date.UTC(2000, 0, 1);

const exists = {
  idempotency: (key: string) => Boolean(db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key)).get()),
  outbox: (rowId: string) => Boolean(db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, rowId)).get()),
  session: (rowId: string) => Boolean(db.select().from(schema.sessions).where(eq(schema.sessions.id, rowId)).get()),
  otp: (rowId: string) => Boolean(db.select().from(schema.otpChallenges).where(eq(schema.otpChallenges.id, rowId)).get()),
  run: (rowId: string) => Boolean(db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, rowId)).get()),
  delivery: (rowId: string) => Boolean(db.select().from(schema.automationDeliveries).where(eq(schema.automationDeliveries.id, rowId)).get()),
  job: (rowId: string) => Boolean(db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, rowId)).get()),
  usedWindow: (rowId: string) => Boolean(db.select().from(schema.usedAccessWindows).where(eq(schema.usedAccessWindows.id, rowId)).get()),
};

let outboxSeq = -1_000_000;

function insertOutbox(at: number, deliveredAt: number | null, seq = outboxSeq++): string {
  const rowId = id('evt');
  db.insert(schema.outboxEvents)
    .values({
      id: rowId,
      seq,
      tenantId: 'ten_shark',
      branchId: 'br_kor',
      channel: `maintenance:${rowId}`,
      topic: 'notification.created',
      payload: {},
      at,
      deliveredAt,
    })
    .run();
  return rowId;
}

let usedWindow = -1;

function insertUsedAccessWindow(usedAt: number): string {
  const rowId = id('uaw');
  const member = db.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.tenantId, 'ten_shark')).get()!;
  db.insert(schema.usedAccessWindows)
    .values({ id: rowId, tenantId: 'ten_shark', memberId: member.id, window: usedWindow--, usedAt })
    .run();
  return rowId;
}

function insertSession(expiresAt: number, revokedAt: number | null): string {
  const rowId = id('ses');
  const user = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.tenantId, 'ten_shark')).get()!;
  db.insert(schema.sessions)
    .values({
      id: rowId,
      userId: user.id,
      tenantId: 'ten_shark',
      tokenHash: `maintenance-${rowId}`,
      userAgent: 'maintenance test',
      ip: '127.0.0.1',
      createdAt: AT - 365 * 86_400_000,
      lastSeenAt: AT - 365 * 86_400_000,
      expiresAt,
      revokedAt,
      impersonatorId: null,
      impersonationExpiresAt: null,
    })
    .run();
  return rowId;
}

function insertOtp(expiresAt: number, consumedAt: number | null): string {
  const rowId = id('otp');
  db.insert(schema.otpChallenges)
    .values({
      id: rowId,
      tenantId: 'ten_shark',
      identifier: `${rowId}@maintenance.test`,
      codeHash: 'not-a-real-code',
      attempts: 0,
      createdAt: AT - 7 * 86_400_000,
      expiresAt,
      consumedAt,
    })
    .run();
  return rowId;
}

function automationFixture() {
  const automation = db
    .select({ id: schema.automations.id })
    .from(schema.automations)
    .where(eq(schema.automations.tenantId, 'ten_shark'))
    .get()!;
  const member = db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.tenantId, 'ten_shark'))
    .get()!;
  const user = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.tenantId, 'ten_shark'))
    .get()!;
  return { automationId: automation.id, memberId: member.id, userId: user.id };
}

function insertDelivery(state: string, updatedAt: number): string {
  const fixture = automationFixture();
  const rowId = id('adl');
  db.insert(schema.automationDeliveries)
    .values({
      id: rowId,
      tenantId: 'ten_shark',
      automationId: fixture.automationId,
      branchId: 'br_kor',
      memberId: fixture.memberId,
      userId: fixture.userId,
      eventKey: `maintenance:${rowId}`,
      channel: 'in_app',
      templateCode: null,
      templateVersion: null,
      title: 'Maintenance test',
      body: 'Maintenance test',
      dueAt: updatedAt,
      state,
      attempts: 1,
      lastAttemptAt: updatedAt,
      lockedAt: state === 'processing' ? updatedAt : null,
      lastError: null,
      notificationId: null,
      source: 'scheduler',
      actorUserId: null,
      createdAt: updatedAt,
      updatedAt,
    })
    .run();
  return rowId;
}

function insertRun(outcome: string, at: number, deliveryId: string | null): string {
  const fixture = automationFixture();
  const rowId = id('aur');
  db.insert(schema.automationRuns)
    .values({
      id: rowId,
      tenantId: 'ten_shark',
      automationId: fixture.automationId,
      branchId: 'br_kor',
      memberId: fixture.memberId,
      userId: fixture.userId,
      trigger: 'maintenance.test',
      eventKey: `maintenance:${rowId}`,
      outcome,
      reason: '',
      channel: 'in_app',
      templateCode: null,
      deliveryId,
      notificationId: null,
      at,
    })
    .run();
  return rowId;
}

function insertJob(status: string, finishedAt: number | null): string {
  const rowId = id('job');
  db.insert(schema.jobRuns)
    .values({
      id: rowId,
      job: 'maintenance-test',
      startedAt: AT - 365 * 86_400_000,
      finishedAt,
      status,
      durationMs: finishedAt === null ? null : 10,
      error: status === 'failed' ? 'fixture' : null,
    })
    .run();
  return rowId;
}

describe('operational maintenance retention', () => {
  it('prunes only old eligible auth/idempotency/outbox rows at strict cutoffs', () => {
    const oldIdempotency = `maintenance-old-${id('key')}`;
    const boundaryIdempotency = `maintenance-boundary-${id('key')}`;
    db.insert(schema.idempotencyKeys)
      .values([
        {
          key: oldIdempotency,
          tenantId: 'ten_shark',
          route: 'maintenance.test',
          requestHash: 'old',
          responseBody: null,
          statusCode: 200,
          createdAt: AT - OPERATIONAL_RETENTION_MS.idempotencyKeys - 1,
        },
        {
          key: boundaryIdempotency,
          tenantId: 'ten_shark',
          route: 'maintenance.test',
          requestHash: 'boundary',
          responseBody: null,
          statusCode: 200,
          createdAt: AT - OPERATIONAL_RETENTION_MS.idempotencyKeys,
        },
      ])
      .run();

    const oldDelivered = insertOutbox(
      AT - OPERATIONAL_RETENTION_MS.outboxReplay - 1,
      AT - OPERATIONAL_RETENTION_MS.outboxReplay - 1,
    );
    const oldUndelivered = insertOutbox(AT - OPERATIONAL_RETENTION_MS.outboxReplay - 1, null);
    const boundaryDelivered = insertOutbox(
      AT - OPERATIONAL_RETENTION_MS.outboxReplay,
      AT - OPERATIONAL_RETENTION_MS.outboxReplay,
    );
    const recentlyDeliveredOldEvent = insertOutbox(
      AT - OPERATIONAL_RETENTION_MS.outboxReplay - 1,
      AT - OPERATIONAL_RETENTION_MS.outboxReplay + 1,
    );

    const oldExpiredSession = insertSession(AT - OPERATIONAL_RETENTION_MS.sessions - 1, null);
    const oldRevokedSession = insertSession(AT + OPERATIONAL_RETENTION_MS.sessions, AT - OPERATIONAL_RETENTION_MS.sessions - 1);
    const boundarySession = insertSession(AT - OPERATIONAL_RETENTION_MS.sessions, null);

    const oldExpiredOtp = insertOtp(AT - OPERATIONAL_RETENTION_MS.otpChallenges - 1, null);
    const oldConsumedOtp = insertOtp(AT + OPERATIONAL_RETENTION_MS.otpChallenges, AT - OPERATIONAL_RETENTION_MS.otpChallenges - 1);
    const boundaryOtp = insertOtp(AT - OPERATIONAL_RETENTION_MS.otpChallenges, null);
    const oldUsedWindow = insertUsedAccessWindow(AT - OPERATIONAL_RETENTION_MS.usedAccessWindows - 1);
    const boundaryUsedWindow = insertUsedAccessWindow(AT - OPERATIONAL_RETENTION_MS.usedAccessWindows);

    const auditBefore = db.select({ n: sql<number>`count(*)` }).from(schema.auditLog).get()!.n;
    const consentBefore = db.select({ n: sql<number>`count(*)` }).from(schema.consents).get()!.n;
    const invoiceBefore = db.select({ n: sql<number>`count(*)` }).from(schema.invoices).get()!.n;

    const result = pruneOperationalData({ atMs: AT, batchSize: 100 });

    expect(result).toMatchObject({ idempotencyKeys: 1, outboxEvents: 1, sessions: 2, otpChallenges: 2, usedAccessWindows: 1 });
    expect(exists.idempotency(oldIdempotency)).toBe(false);
    expect(exists.idempotency(boundaryIdempotency)).toBe(true);
    expect(exists.outbox(oldDelivered)).toBe(false);
    expect(exists.outbox(oldUndelivered)).toBe(true);
    expect(exists.outbox(boundaryDelivered)).toBe(true);
    expect(exists.outbox(recentlyDeliveredOldEvent)).toBe(true);
    expect(exists.session(oldExpiredSession)).toBe(false);
    expect(exists.session(oldRevokedSession)).toBe(false);
    expect(exists.session(boundarySession)).toBe(true);
    expect(exists.otp(oldExpiredOtp)).toBe(false);
    expect(exists.otp(oldConsumedOtp)).toBe(false);
    expect(exists.otp(boundaryOtp)).toBe(true);
    expect(exists.usedWindow(oldUsedWindow)).toBe(false);
    expect(exists.usedWindow(boundaryUsedWindow)).toBe(true);
    expect(db.select({ n: sql<number>`count(*)` }).from(schema.auditLog).get()!.n).toBe(auditBefore);
    expect(db.select({ n: sql<number>`count(*)` }).from(schema.consents).get()!.n).toBe(consentBefore);
    expect(db.select({ n: sql<number>`count(*)` }).from(schema.invoices).get()!.n).toBe(invoiceBefore);
  });

  it('prunes terminal automation/job history but preserves live work and inconsistent nonterminal links', () => {
    const old = AT - OPERATIONAL_RETENTION_MS.automationHistory - 1;
    const terminalDelivery = insertDelivery('sent', old);
    const terminalRun = insertRun('sent', old, terminalDelivery);
    const dryRun = insertRun('dry_run', old, null);

    const queuedDelivery = insertDelivery('queued', old);
    const failedButRetryableRun = insertRun('failed', old, queuedDelivery);
    const terminalDeliveryWithQueuedRun = insertDelivery('failed', old);
    const queuedRun = insertRun('queued', old, terminalDeliveryWithQueuedRun);
    const recentTerminalDelivery = insertDelivery('suppressed', AT - OPERATIONAL_RETENTION_MS.automationHistory + 1);
    const recentTerminalRun = insertRun('suppressed', AT - OPERATIONAL_RETENTION_MS.automationHistory + 1, recentTerminalDelivery);
    const boundaryTerminalDelivery = insertDelivery('sent', AT - OPERATIONAL_RETENTION_MS.automationHistory);
    const boundaryTerminalRun = insertRun('sent', AT - OPERATIONAL_RETENTION_MS.automationHistory, boundaryTerminalDelivery);

    const oldSucceededJob = insertJob('succeeded', AT - OPERATIONAL_RETENTION_MS.jobRuns - 1);
    const oldFailedJob = insertJob('failed', AT - OPERATIONAL_RETENTION_MS.jobRuns - 1);
    const runningJob = insertJob('running', null);
    const boundaryJob = insertJob('succeeded', AT - OPERATIONAL_RETENTION_MS.jobRuns);

    const result = pruneOperationalData({ atMs: AT, batchSize: 100 });

    expect(result).toMatchObject({ automationRuns: 2, automationDeliveries: 1, jobRuns: 2 });
    expect(exists.run(terminalRun)).toBe(false);
    expect(exists.delivery(terminalDelivery)).toBe(false);
    expect(exists.run(dryRun)).toBe(false);
    expect(exists.delivery(queuedDelivery)).toBe(true);
    expect(exists.run(failedButRetryableRun)).toBe(true);
    expect(exists.delivery(terminalDeliveryWithQueuedRun)).toBe(true);
    expect(exists.run(queuedRun)).toBe(true);
    expect(exists.delivery(recentTerminalDelivery)).toBe(true);
    expect(exists.run(recentTerminalRun)).toBe(true);
    expect(exists.delivery(boundaryTerminalDelivery)).toBe(true);
    expect(exists.run(boundaryTerminalRun)).toBe(true);
    expect(exists.job(oldSucceededJob)).toBe(false);
    expect(exists.job(oldFailedJob)).toBe(false);
    expect(exists.job(runningJob)).toBe(true);
    expect(exists.job(boundaryJob)).toBe(true);
  });

  it('caps each transaction while draining more than one batch per maintenance run', () => {
    const keys = Array.from({ length: 3 }, () => `maintenance-batch-${id('key')}`);
    db.insert(schema.idempotencyKeys)
      .values(
        keys.map((key, index) => ({
          key,
          tenantId: 'ten_shark',
          route: 'maintenance.batch',
          requestHash: String(index),
          responseBody: null,
          statusCode: 200,
          createdAt: AT - OPERATIONAL_RETENTION_MS.idempotencyKeys - 10 - index,
        })),
      )
      .run();

    expect(pruneOperationalData({ atMs: AT, batchSize: 2, maxBatches: 1 }).idempotencyKeys).toBe(2);
    expect(
      db
        .select()
        .from(schema.idempotencyKeys)
        .where(inArray(schema.idempotencyKeys.key, keys))
        .all(),
    ).toHaveLength(1);
    expect(pruneOperationalData({ atMs: AT, batchSize: 2 }).idempotencyKeys).toBe(1);
    expect(() => pruneOperationalData({ atMs: AT, batchSize: 1_001 })).toThrow(/batchSize/);
    expect(() => pruneOperationalData({ atMs: AT, maxBatches: 0 })).toThrow(/maxBatches/);
  });

  it('preserves the outbox sequence high-water mark while pruning replay history', () => {
    const persistedMax = db
      .select({ value: sql<number>`coalesce(max(${schema.outboxEvents.seq}), 0)` })
      .from(schema.outboxEvents)
      .get()!.value;
    const highWater = Math.max(persistedMax, 0) + 100;
    const oldLower = insertOutbox(
      AT - OPERATIONAL_RETENTION_MS.outboxReplay - 1,
      AT - OPERATIONAL_RETENTION_MS.outboxReplay - 1,
      highWater - 1,
    );
    const oldHigh = insertOutbox(
      AT - OPERATIONAL_RETENTION_MS.outboxReplay - 1,
      AT - OPERATIONAL_RETENTION_MS.outboxReplay - 1,
      highWater,
    );

    pruneOperationalData({ atMs: AT, batchSize: 100 });

    expect(exists.outbox(oldLower)).toBe(false);
    expect(exists.outbox(oldHigh)).toBe(true);
    const next = emit({
      tenantId: 'ten_shark',
      branchId: 'br_kor',
      channel: `maintenance:${id('channel')}`,
      topic: 'notification.created',
      payload: {},
    });
    expect(next.seq).toBe(highWater + 1);
  });
});
