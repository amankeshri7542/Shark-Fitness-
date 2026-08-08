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
