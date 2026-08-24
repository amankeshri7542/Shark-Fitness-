import { and, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db, schema, transact } from '../db/client.js';
import { OUTBOX_REPLAY_WINDOW_MS } from '../lib/events.js';
import { DAY, now } from '../lib/time.js';

/**
 * Operational rows are short-lived implementation evidence, not business
 * records. These windows intentionally do not derive from a tenant's legal
 * retention setting: audit, consent, member, billing and ledger tables are not
 * in this service's allowlist at all.
 *
 * The outbox window is the documented reconnect/replay guarantee. A delivered
 * event remains replayable for seven full days after both creation and
 * delivery; an undelivered row is never eligible for deletion.
 */
export const OPERATIONAL_RETENTION_MS = {
  idempotencyKeys: 30 * DAY,
  outboxReplay: OUTBOX_REPLAY_WINDOW_MS,
  sessions: 30 * DAY,
  otpChallenges: DAY,
  usedAccessWindows: DAY,
  automationHistory: 90 * DAY,
  jobRuns: 30 * DAY,
} as const;

export const MAX_OPERATIONAL_PRUNE_BATCH = 1_000;
export const MAX_OPERATIONAL_PRUNE_BATCHES = 10;

export interface OperationalPruneResult {
  idempotencyKeys: number;
  outboxEvents: number;
  sessions: number;
  otpChallenges: number;
  usedAccessWindows: number;
  automationRuns: number;
  automationDeliveries: number;
  jobRuns: number;
}

interface PruneOptions {
  atMs?: number;
  /** Maximum rows removed from each allowlisted table in one transaction. */
  batchSize?: number;
  /** Maximum short transactions used to catch up after downtime. */
  maxBatches?: number;
}

function checkedBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_OPERATIONAL_PRUNE_BATCH) {
    throw new RangeError(`batchSize must be an integer from 1 to ${MAX_OPERATIONAL_PRUNE_BATCH}.`);
  }
  return value;
}

function checkedMaxBatches(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_OPERATIONAL_PRUNE_BATCHES) {
    throw new RangeError(`maxBatches must be an integer from 1 to ${MAX_OPERATIONAL_PRUNE_BATCHES}.`);
  }
  return value;
}

/**
 * Prune bounded, explicitly allowlisted operational history.
 *
 * Safety properties live in the predicates rather than in the caller:
 * queued/processing automation work, running jobs, undelivered outbox events,
 * live sessions and usable OTPs cannot be deleted even if a scheduler invokes
 * this helper with a surprising clock value.
 */
export function pruneOperationalData(options: PruneOptions = {}): OperationalPruneResult {
  const atMs = options.atMs ?? now();
  if (!Number.isFinite(atMs)) throw new RangeError('atMs must be a finite epoch timestamp.');
  const batchSize = checkedBatchSize(options.batchSize ?? MAX_OPERATIONAL_PRUNE_BATCH);
  const maxBatches = checkedMaxBatches(options.maxBatches ?? MAX_OPERATIONAL_PRUNE_BATCHES);
  const total: OperationalPruneResult = {
    idempotencyKeys: 0,
    outboxEvents: 0,
    sessions: 0,
    otpChallenges: 0,
    usedAccessWindows: 0,
    automationRuns: 0,
    automationDeliveries: 0,
    jobRuns: 0,
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = pruneOperationalBatch(atMs, batchSize);
    for (const key of Object.keys(total) as Array<keyof OperationalPruneResult>) total[key] += result[key];
    if (Object.values(result).every((count) => count < batchSize)) break;
  }
  return total;
}

function pruneOperationalBatch(atMs: number, batchSize: number): OperationalPruneResult {
  return transact(() => {
    const idempotencyIds = db
      .select({ key: schema.idempotencyKeys.key })
      .from(schema.idempotencyKeys)
      .where(lt(schema.idempotencyKeys.createdAt, atMs - OPERATIONAL_RETENTION_MS.idempotencyKeys))
      .orderBy(schema.idempotencyKeys.createdAt)
      .limit(batchSize)
      .all()
      .map((row) => row.key);
    const idempotencyKeys = idempotencyIds.length === 0
      ? 0
      : db.delete(schema.idempotencyKeys).where(inArray(schema.idempotencyKeys.key, idempotencyIds)).run().changes;

    const outboxIds = db
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(
        and(
          isNotNull(schema.outboxEvents.deliveredAt),
          lt(schema.outboxEvents.at, atMs - OPERATIONAL_RETENTION_MS.outboxReplay),
          lt(schema.outboxEvents.deliveredAt, atMs - OPERATIONAL_RETENTION_MS.outboxReplay),
          // Keep the sequence high-water mark durable across pruning and a
          // process restart without introducing a second sequence store.
          sql`${schema.outboxEvents.seq} < (select coalesce(max(${schema.outboxEvents.seq}), 0) from ${schema.outboxEvents})`,
        ),
      )
      .orderBy(schema.outboxEvents.at)
      .limit(batchSize)
      .all()
      .map((row) => row.id);
    const outboxEvents = outboxIds.length === 0
      ? 0
      : db.delete(schema.outboxEvents).where(inArray(schema.outboxEvents.id, outboxIds)).run().changes;

    const sessionCutoff = atMs - OPERATIONAL_RETENTION_MS.sessions;
    const sessionIds = db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        or(
          lt(schema.sessions.expiresAt, sessionCutoff),
          and(isNotNull(schema.sessions.revokedAt), lt(schema.sessions.revokedAt, sessionCutoff)),
        ),
      )
      .orderBy(schema.sessions.expiresAt)
      .limit(batchSize)
      .all()
      .map((row) => row.id);
    const sessions = sessionIds.length === 0
      ? 0
      : db.delete(schema.sessions).where(inArray(schema.sessions.id, sessionIds)).run().changes;

    const otpCutoff = atMs - OPERATIONAL_RETENTION_MS.otpChallenges;
    const otpIds = db
      .select({ id: schema.otpChallenges.id })
      .from(schema.otpChallenges)
      .where(
        or(
          lt(schema.otpChallenges.expiresAt, otpCutoff),
          and(isNotNull(schema.otpChallenges.consumedAt), lt(schema.otpChallenges.consumedAt, otpCutoff)),
        ),
      )
      .orderBy(schema.otpChallenges.expiresAt)
      .limit(batchSize)
      .all()
      .map((row) => row.id);
    const otpChallenges = otpIds.length === 0
      ? 0
      : db.delete(schema.otpChallenges).where(inArray(schema.otpChallenges.id, otpIds)).run().changes;

    const usedAccessIds = db
      .select({ id: schema.usedAccessWindows.id })
      .from(schema.usedAccessWindows)
      .where(lt(schema.usedAccessWindows.usedAt, atMs - OPERATIONAL_RETENTION_MS.usedAccessWindows))
      .orderBy(schema.usedAccessWindows.usedAt)
      .limit(batchSize)
      .all()
      .map((row) => row.id);
    const usedAccessWindows = usedAccessIds.length === 0
      ? 0
      : db.delete(schema.usedAccessWindows).where(inArray(schema.usedAccessWindows.id, usedAccessIds)).run().changes;

    const automationCutoff = atMs - OPERATIONAL_RETENTION_MS.automationHistory;
    const runIds = db
      .select({ id: schema.automationRuns.id })
      .from(schema.automationRuns)
      .where(
        and(
          lt(schema.automationRuns.at, automationCutoff),
          inArray(schema.automationRuns.outcome, ['sent', 'suppressed', 'failed', 'dry_run']),
          sql`(
            ${schema.automationRuns.deliveryId} is null
            or not exists (
              select 1 from ${schema.automationDeliveries}
              where ${schema.automationDeliveries.id} = ${schema.automationRuns.deliveryId}
                and ${schema.automationDeliveries.state} in ('queued', 'processing')
            )
          )`,
        ),
      )
      .orderBy(schema.automationRuns.at)
      .limit(batchSize)
      .all()
      .map((row) => row.id);
    const automationRuns = runIds.length === 0
      ? 0
      : db.delete(schema.automationRuns).where(inArray(schema.automationRuns.id, runIds)).run().changes;

    const deliveryIds = db
      .select({ id: schema.automationDeliveries.id })
      .from(schema.automationDeliveries)
      .where(
        and(
          lt(schema.automationDeliveries.updatedAt, automationCutoff),
          inArray(schema.automationDeliveries.state, ['sent', 'suppressed', 'failed']),
          sql`not exists (
            select 1 from ${schema.automationRuns}
            where ${schema.automationRuns.deliveryId} = ${schema.automationDeliveries.id}
          )`,
        ),
      )
      .orderBy(schema.automationDeliveries.updatedAt)
      .limit(batchSize)
      .all()
      .map((row) => row.id);
    const automationDeliveries = deliveryIds.length === 0
      ? 0
      : db.delete(schema.automationDeliveries).where(inArray(schema.automationDeliveries.id, deliveryIds)).run().changes;

    const jobIds = db
      .select({ id: schema.jobRuns.id })
      .from(schema.jobRuns)
      .where(
        and(
          isNotNull(schema.jobRuns.finishedAt),
          lt(schema.jobRuns.finishedAt, atMs - OPERATIONAL_RETENTION_MS.jobRuns),
          inArray(schema.jobRuns.status, ['succeeded', 'failed']),
        ),
      )
      .orderBy(schema.jobRuns.finishedAt)
      .limit(batchSize)
      .all()
      .map((row) => row.id);
    const jobRuns = jobIds.length === 0
      ? 0
      : db.delete(schema.jobRuns).where(inArray(schema.jobRuns.id, jobIds)).run().changes;

    return {
      idempotencyKeys,
      outboxEvents,
      sessions,
      otpChallenges,
      usedAccessWindows,
      automationRuns,
      automationDeliveries,
      jobRuns,
    };
  });
}
