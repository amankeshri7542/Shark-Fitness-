import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/* ============================================================================
   Staff security (P06): TOTP factors, recovery codes and outbound webhooks.
   Secrets in these tables are AES-256-GCM ciphertext (lib/field-encryption.ts)
   or one-way hashes. Nothing here may be logged or serialised to a client
   except where a route says so explicitly (enrolment, secret reveal).
   ========================================================================= */

/**
 * One TOTP authenticator per person. A row with `confirmedAt` null is an
 * enrolment in progress: it never satisfies a challenge.
 */
export const userMfa = sqliteTable(
  'user_mfa',
  {
    userId: text('user_id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    /** `v1:<iv>:<tag>:<ciphertext>` of the base32 secret. Never plaintext. */
    secretCiphertext: text('secret_ciphertext').notNull(),
    confirmedAt: integer('confirmed_at'),
    /** The last accepted TOTP time step; a code is accepted once (NIST 800-63B 5.1.4.2). */
    lastUsedStep: integer('last_used_step'),
    /** Consecutive wrong codes. Reset on success. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: integer('locked_until'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byTenant: index('user_mfa_tenant_idx').on(t.tenantId) }),
);

/** Ten single-use codes, stored as SHA-256 hashes of the normalised code. */
export const mfaRecoveryCodes = sqliteTable(
  'mfa_recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byUser: index('mfa_recovery_codes_user_idx').on(t.userId) }),
);

/** A gym's HTTPS receiver for business events (PF-INT-003). */
export const webhookEndpoints = sqliteTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    events: text('events', { mode: 'json' }).$type<string[]>().notNull(),
    /** active | paused | disabled (by the system after repeated failures) */
    state: text('state').notNull().default('active'),
    disabledReason: text('disabled_reason'),
    disabledAt: integer('disabled_at'),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretHint: text('secret_hint').notNull(),
    /** During rotation the old secret still signs (dual signatures) until this time. */
    previousSecretCiphertext: text('previous_secret_ciphertext'),
    previousSecretExpiresAt: integer('previous_secret_expires_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Outbox sequence this endpoint has been fanned out to. Starts at creation. */
    cursorSeq: integer('cursor_seq').notNull().default(0),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({ byTenant: index('webhook_endpoints_tenant_idx').on(t.tenantId) }),
);

/** One event owed to one endpoint, with its exact signed body. */
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    endpointId: text('endpoint_id').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    /** The serialised envelope, byte for byte what is signed and sent. */
    body: text('body').notNull(),
    /** pending | succeeded | failed */
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    /** A claim, so overlapping ticks never send the same attempt twice. */
    leaseUntil: integer('lease_until'),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    replayOf: text('replay_of'),
    test: integer('test', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => ({
    due: index('webhook_deliveries_due_idx').on(t.state, t.nextAttemptAt),
    byEndpoint: index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt),
    oncePerEvent: uniqueIndex('webhook_deliveries_endpoint_event_uq')
      .on(t.endpointId, t.eventId)
      .where(sql`replay_of is null and test = 0`),
  }),
);

/** Append-only attempt log (PF-INT-003 "durable delivery log"). */
export const webhookAttempts = sqliteTable(
  'webhook_attempts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    deliveryId: text('delivery_id').notNull(),
    endpointId: text('endpoint_id').notNull(),
    attempt: integer('attempt').notNull(),
    at: integer('at').notNull(),
    statusCode: integer('status_code'),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    latencyMs: integer('latency_ms').notNull(),
    error: text('error'),
    responseExcerpt: text('response_excerpt'),
  },
  (t) => ({ byDelivery: index('webhook_attempts_delivery_idx').on(t.deliveryId, t.attempt) }),
);
