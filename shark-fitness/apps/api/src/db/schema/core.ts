import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/* ============================================================================
   Conventions (Engineering PRD §"Database conventions")

   - snake_case columns, plural tables
   - money is integer minor units, never a float
   - timestamps are integer epoch milliseconds, UTC
   - every business table carries tenant_id, and branch_id where it applies
   - soft delete via deleted_at; hard delete only through a retention job
   - `version` supports optimistic concurrency on records staff edit
   ========================================================================= */

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  plan: text('plan').notNull().default('growth'),
  /**
   * `customer` or `platform`.
   *
   * Platform staff are not a customer's users — they are above every tenant —
   * but `users.tenant_id` is not nullable and should not become so. They live
   * in their own tenant instead, which this column marks so the platform's
   * customer list does not show the operator its own record as if it were a
   * gym. Nothing else in the product reads it.
   */
  kind: text('kind').notNull().default('customer'),
  locale: text('locale').notNull().default('en-IN'),
  currency: text('currency').notNull().default('INR'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  unitSystem: text('unit_system').notNull().default('metric'),
  status: text('status').notNull().default('active'),
  featureFlags: text('feature_flags', { mode: 'json' }).$type<Record<string, boolean>>().notNull(),
  quotas: text('quotas', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  branding: text('branding', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  /** Tenant-level policy switches the domain rules read. */
  policy: text('policy', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /**
   * Invoicing identity (PF-TEN-001). Separate from `policy` because it is
   * financial and appears on documents people keep: a registration number, the
   * label tax is printed under, and whether prices are quoted inclusive of it.
   * Changing it must never re-interpret an invoice already raised, which is
   * why every invoice carries its own currency and per-line tax.
   */
  taxProfile: text('tax_profile', { mode: 'json' }).$type<Record<string, unknown>>(),
  /**
   * Data-processing configuration (PF-TEN-001): retention windows, the contact
   * a subject reaches, and the consent-document version in force. Consent rows
   * store the version they were granted under, so raising this here does not
   * silently re-consent anybody.
   */
  dataProcessing: text('data_processing', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const branches = sqliteTable(
  'branches',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    addressLine: text('address_line').notNull(),
    city: text('city').notNull(),
    timezone: text('timezone').notNull(),
    capacity: integer('capacity').notNull(),
    opensMinutes: integer('opens_minutes').notNull(),
    closesMinutes: integer('closes_minutes').notNull(),
    state: text('state').notNull().default('active'),
    amenities: text('amenities', { mode: 'json' }).$type<string[]>().notNull(),
    holidays: text('holidays', { mode: 'json' }).$type<string[]>().notNull(),
    phone: text('phone'),
    email: text('email'),
    /**
     * Per-day opening hours (PF-TEN-002), keyed `mon`…`sun`.
     *
     * `opensMinutes`/`closesMinutes` above stay as the branch's typical day and
     * remain the fallback: the door and the occupancy chart have read them
     * since Phase 1 and a null here must not change what they decide. A day
     * present in this map wins for that day.
     */
    hours: text('hours', { mode: 'json' }).$type<Record<string, { open: number; close: number; closed: boolean }>>(),
    /**
     * Branch overrides of tenant policy (PF-TEN-003) — **overrides only**.
     *
     * A key absent here is inherited, and that absence is the inheritance
     * indicator: there is no separate "inherited?" flag that could disagree
     * with the value beside it. `resolveBranchPolicy` is the only reader.
     */
    policy: text('policy', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    /** When the branch last changed lifecycle state, and why (PF-TEN-004). */
    stateChangedAt: integer('state_changed_at'),
    stateNote: text('state_note'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    byTenant: index('branches_tenant_idx').on(t.tenantId),
    slugUnique: uniqueIndex('branches_tenant_slug_uq').on(t.tenantId, t.slug),
  }),
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    email: text('email'),
    phone: text('phone'),
    name: text('name').notNull(),
    initials: text('initials').notNull(),
    role: text('role').notNull(),
    accountState: text('account_state').notNull().default('active'),
    /** scrypt(password). Null for OTP-only accounts. */
    passwordHash: text('password_hash'),
    preferences: text('preferences', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    lastSeenAt: integer('last_seen_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    byTenant: index('users_tenant_idx').on(t.tenantId),
    emailUnique: uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email),
  }),
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    /** Set while a support agent is acting as this user. Drives the banner. */
    impersonatorId: text('impersonator_id'),
    impersonationExpiresAt: integer('impersonation_expires_at'),
  },
  (t) => ({ byUser: index('sessions_user_idx').on(t.userId) }),
);

export const otpChallenges = sqliteTable(
  'otp_challenges',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    identifier: text('identifier').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
  },
  (t) => ({ byIdentifier: index('otp_identifier_idx').on(t.identifier) }),
);

export const consents = sqliteTable(
  'consents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    purpose: text('purpose').notNull(),
    granted: integer('granted', { mode: 'boolean' }).notNull(),
    version: text('version').notNull(),
    updatedAt: integer('updated_at').notNull(),
    ip: text('ip'),
  },
  (t) => ({ uq: uniqueIndex('consents_user_purpose_uq').on(t.userId, t.purpose) }),
);

/** Append-only. Nothing in the product may update or delete a row here. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    actorId: text('actor_id'),
    actorName: text('actor_name').notNull(),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entityLabel: text('entity_label').notNull().default(''),
    reason: text('reason'),
    changes: text('changes', { mode: 'json' })
      .$type<Array<{ field: string; from: string; to: string }>>()
      .notNull(),
    ip: text('ip'),
    requestId: text('request_id'),
    at: integer('at').notNull(),
  },
  (t) => ({
    byTenant: index('audit_tenant_at_idx').on(t.tenantId, t.at),
    byEntity: index('audit_entity_idx').on(t.entityType, t.entityId),
  }),
);

/** Transactional outbox. Realtime fan-out and async jobs both read from here,
 *  so an event is never lost because a socket was down. */
export const outboxEvents = sqliteTable(
  'outbox_events',
  {
    id: text('id').primaryKey(),
    seq: integer('seq').notNull(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    channel: text('channel').notNull(),
    topic: text('topic').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    at: integer('at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => ({
    byChannel: index('outbox_channel_seq_idx').on(t.channel, t.seq),
  }),
);

/** Idempotency ledger. A repeated key returns the stored response rather than
 *  performing the write twice (PF-BILL "Cash payment entered twice"). */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    route: text('route').notNull(),
    requestHash: text('request_hash').notNull(),
    responseBody: text('response_body', { mode: 'json' }).$type<unknown>(),
    statusCode: integer('status_code').notNull().default(200),
    createdAt: integer('created_at').notNull(),
  },
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    channel: text('channel').notNull().default('in_app'),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link'),
    templateCode: text('template_code'),
    state: text('state').notNull().default('sent'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
  },
  (t) => ({ byUser: index('notifications_user_idx').on(t.userId, t.createdAt) }),
);

export const messageTemplates = sqliteTable('message_templates', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  code: text('code').notNull(),
  channel: text('channel').notNull(),
  version: integer('version').notNull().default(1),
  locale: text('locale').notNull().default('en'),
  subject: text('subject'),
  body: text('body').notNull(),
  variables: text('variables', { mode: 'json' }).$type<string[]>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  name: text('name').notNull(),
  trigger: text('trigger').notNull(),
  description: text('description').notNull().default(''),
  conditions: text('conditions', { mode: 'json' })
    .$type<Array<{ field: string; op: string; value: string }>>()
    .notNull(),
  actions: text('actions', { mode: 'json' })
    .$type<Array<{ kind: string; templateCode: string | null; delayMin: number }>>()
    .notNull(),
  quietHours: text('quiet_hours', { mode: 'json' }).$type<{ from: string; to: string } | null>(),
  state: text('state').notNull().default('draft'),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
  runsLast30: integer('runs_last_30').notNull().default(0),
  lastRunAt: integer('last_run_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Every time an automation considered somebody (PF-COMM-004, PF-COMM-005).
 *
 * One row per automation per subject per logical event, whatever the outcome —
 * sent, suppressed, failed, or a dry run. The suppressions are the point: "why
 * did my member not get the renewal reminder" is the question this module gets
 * asked, and an execution log that only records successes cannot answer it.
 *
 * `eventKey` is the logical event, not the attempt. A partial unique index on
 * `(automation_id, event_key) WHERE outcome = 'sent'` is what actually
 * prevents a duplicate send — the database refuses it rather than the service
 * remembering to check. A failed run leaves the key free to retry; a dry run
 * never consumes it.
 */
export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    automationId: text('automation_id').notNull(),
    branchId: text('branch_id'),
    memberId: text('member_id'),
    userId: text('user_id'),
    trigger: text('trigger').notNull(),
    /** The logical event this run answers. The dedupe key. */
    eventKey: text('event_key').notNull(),
    /** sent | suppressed | failed | dry_run */
    outcome: text('outcome').notNull(),
    /** Why it was suppressed or how it failed. Empty for a plain send. */
    reason: text('reason').notNull().default(''),
    channel: text('channel').notNull(),
    templateCode: text('template_code'),
    notificationId: text('notification_id'),
    at: integer('at').notNull(),
  },
  (t) => ({
    byAutomation: index('automation_runs_idx').on(t.tenantId, t.automationId, t.at),
    bySubject: index('automation_runs_member_idx').on(t.tenantId, t.memberId, t.at),
  }),
);

/** Precomputed report aggregates, so a dashboard never scans the whole
 *  transaction history (PF-RPT-006). */
export const metricRollups = sqliteTable(
  'metric_rollups',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    metric: text('metric').notNull(),
    period: text('period').notNull(),
    onDate: text('on_date').notNull(),
    value: integer('value').notNull(),
    computedAt: integer('computed_at').notNull(),
  },
  (t) => ({
    uq: uniqueIndex('rollup_uq').on(t.tenantId, t.branchId, t.metric, t.period, t.onDate),
  }),
);
