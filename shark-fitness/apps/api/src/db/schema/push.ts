import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Web Push subscriptions (PF-COMM-002; ADR-002).
 *
 * One row per browser push endpoint. The endpoint is unique across the whole
 * product: if a phone that still holds someone else's subscription registers
 * it again, the row moves to the person signing in now, so nobody keeps
 * receiving notifications on a phone they handed back.
 *
 * `sessionId` is the session that registered it. Sending only uses rows whose
 * session is still live, so signing out (or a revoked or expired session)
 * stops pushes to that phone even before the client removes the row.
 */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id'),
    /** SHA-256 of the endpoint URL: lookups and uniqueness without scanning URLs. */
    endpointHash: text('endpoint_hash').notNull(),
    /** The push service capability URL. Needed to send; never returned to clients. */
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: integer('created_at').notNull(),
    lastSuccessAt: integer('last_success_at'),
    lastFailureAt: integer('last_failure_at'),
    failureCount: integer('failure_count').notNull().default(0),
  },
  (t) => ({
    endpointUnique: uniqueIndex('push_subscriptions_endpoint_uq').on(t.endpointHash),
    byUser: index('push_subscriptions_user_idx').on(t.tenantId, t.userId),
  }),
);

/**
 * One push notification for one person, whatever number of devices it fans
 * out to. Durable so quiet hours can defer it and a restart cannot lose or
 * repeat it: `(userId, dedupeKey)` is unique, so the same logical event (a
 * reminder for booking X, a payment outcome for invoice Y) is queued once.
 *
 * state: queued | sending | sent | suppressed | failed
 */
export const pushDeliveries = sqliteTable(
  'push_deliveries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    branchId: text('branch_id'),
    category: text('category').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    notificationId: text('notification_id'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    path: text('path').notNull(),
    state: text('state').notNull().default('queued'),
    reason: text('reason').notNull().default(''),
    dueAt: integer('due_at').notNull(),
    /** After this the message is pointless (the class started, the offer lapsed). */
    expiresAt: integer('expires_at'),
    attempts: integer('attempts').notNull().default(0),
    lockedAt: integer('locked_at'),
    devicesSent: integer('devices_sent').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    sentAt: integer('sent_at'),
  },
  (t) => ({
    dedupe: uniqueIndex('push_deliveries_dedupe_uq').on(t.userId, t.dedupeKey),
    due: index('push_deliveries_due_idx').on(t.state, t.dueAt),
    byTenant: index('push_deliveries_tenant_idx').on(t.tenantId, t.createdAt),
    open: index('push_deliveries_open_idx').on(t.lockedAt).where(sql`state = 'sending'`),
  }),
);
