import { sql } from 'drizzle-orm';
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
  (t) => ({
    byUser: index('sessions_user_idx').on(t.userId),
    byExpiry: index('sessions_expiry_idx').on(t.expiresAt),
    byRevocation: index('sessions_revoked_idx').on(t.revokedAt).where(sql`revoked_at is not null`),
  }),
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
  (t) => ({
    byIdentifier: index('otp_identifier_idx').on(t.identifier),
    byExpiry: index('otp_expiry_idx').on(t.expiresAt),
    byConsumption: index('otp_consumed_idx').on(t.consumedAt).where(sql`consumed_at is not null`),
  }),
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

/**
 * A data subject's request about their own data (PF-COMP, DPDP/GDPR shaped).
 *
 * Before this, `POST /me/data-export` and `POST /me/deletion-request` wrote an
 * audit row, flipped an account state, and told the member honestly that a
 * person would have to do the rest by hand. That was truthful and it was not a
 * workflow: nothing recorded the request as a thing with a state, so nobody
 * could see a queue, nothing tracked the statutory clock, and "did we ever
 * answer that?" had no answer but a search of the audit log.
 *
 * The request is now a row with a lifecycle. What it deliberately does *not*
 * do is deliver anything outbound — there is no email provider and no object
 * storage — so the export is produced as an internal artifact and handed over
 * by whoever is doing the handing over.
 */
export const privacyRequests = sqliteTable(
  'privacy_requests',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    /** The person the data is about. */
    subjectUserId: text('subject_user_id').notNull(),
    subjectMemberId: text('subject_member_id'),
    /** export | deletion */
    kind: text('kind').notNull(),
    /**
     * submitted | in_review | on_hold | completed | refused
     *
     * `on_hold` is not a pause somebody chose. It is what a legal hold does to
     * a request, and it is a separate state from `in_review` so that a queue
     * cannot show a blocked request as merely slow.
     */
    state: text('state').notNull().default('submitted'),
    /** Who asked. Usually the subject; a guardian or staff member otherwise. */
    requestedByUserId: text('requested_by_user_id').notNull(),
    reason: text('reason'),
    submittedAt: integer('submitted_at').notNull(),
    reviewedAt: integer('reviewed_at'),
    reviewedByUserId: text('reviewed_by_user_id'),
    completedAt: integer('completed_at'),
    completedByUserId: text('completed_by_user_id'),
    /** What was decided and why, in the reviewer's words. */
    outcomeNote: text('outcome_note'),
    /** The generated export, when there is one. */
    artifactId: text('artifact_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    bySubject: index('privacy_requests_subject_idx').on(t.subjectUserId, t.submittedAt),
    byState: index('privacy_requests_state_idx').on(t.tenantId, t.state),
  }),
);

/**
 * The export package, kept inside the database.
 *
 * Not a file on a disk and not a link to object storage, because this system
 * has neither and a URL to nothing is worse than no URL. The payload is the
 * structured data itself and the checksum is what makes "this is the package
 * we produced on that date" a checkable claim rather than an assertion.
 */
export const privacyArtifacts = sqliteTable('privacy_artifacts', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  requestId: text('request_id').notNull(),
  format: text('format').notNull().default('json'),
  /** The export itself. */
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  byteSize: integer('byte_size').notNull(),
  checksum: text('checksum').notNull(),
  generatedByUserId: text('generated_by_user_id').notNull(),
  generatedAt: integer('generated_at').notNull(),
});

/**
 * A legal hold on one person's data.
 *
 * The reason erasure has to ask before it acts. A hold outranks a deletion
 * request unconditionally: a live dispute, an investigation or a statutory
 * obligation is not something a member can opt out of by asking, and a system
 * that erased through one would destroy the evidence it exists to preserve.
 */
export const legalHolds = sqliteTable(
  'legal_holds',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    subjectUserId: text('subject_user_id').notNull(),
    subjectMemberId: text('subject_member_id'),
    reason: text('reason').notNull(),
    reference: text('reference'),
    placedByUserId: text('placed_by_user_id').notNull(),
    placedAt: integer('placed_at').notNull(),
    releasedAt: integer('released_at'),
    releasedByUserId: text('released_by_user_id'),
    releaseReason: text('release_reason'),
  },
  (t) => ({ bySubject: index('legal_holds_subject_idx').on(t.subjectUserId, t.releasedAt) }),
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
    seqUnique: uniqueIndex('outbox_seq_uq').on(t.seq),
    retention: index('outbox_retention_idx')
      .on(t.at, t.deliveredAt, t.seq)
      .where(sql`delivered_at is not null`),
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
  (t) => ({ byCreatedAt: index('idempotency_created_idx').on(t.createdAt) }),
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

export const messageTemplates = sqliteTable(
  'message_templates',
  {
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
  },
  (t) => ({ versionUnique: uniqueIndex('message_templates_version_uq').on(t.tenantId, t.code, t.version) }),
);

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
    .$type<Array<{
      kind: string;
      templateCode: string | null;
      templateId?: string | null;
      templateVersion?: number | null;
      delayMin: number;
    }>>()
    .notNull(),
  /** Null means every tenant branch. A scoped operator stores an explicit
   * subset so a later scheduler run cannot silently widen their authority. */
  branchIds: text('branch_ids', { mode: 'json' }).$type<string[] | null>(),
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
    deliveryId: text('delivery_id'),
    notificationId: text('notification_id'),
    at: integer('at').notNull(),
  },
  (t) => ({
    byAutomation: index('automation_runs_idx').on(t.tenantId, t.automationId, t.at),
    bySubject: index('automation_runs_member_idx').on(t.tenantId, t.memberId, t.at),
    byRetention: index('automation_runs_retention_idx').on(t.at, t.outcome),
    deliveryUnique: uniqueIndex('automation_runs_delivery_uq')
      .on(t.deliveryId)
      .where(sql`delivery_id is not null`),
  }),
);

/** Durable outbound work owned by the existing scheduler.
 *
 * The unique logical event is reserved while queued, not only after sending,
 * so a restart or overlapping tick cannot enqueue the same member twice.
 * Rendered copy and the immutable template version are snapshotted here; the
 * worker still re-checks consent and operating state at delivery time.
 */
export const automationDeliveries = sqliteTable(
  'automation_deliveries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    automationId: text('automation_id').notNull(),
    branchId: text('branch_id').notNull(),
    memberId: text('member_id').notNull(),
    userId: text('user_id').notNull(),
    eventKey: text('event_key').notNull(),
    channel: text('channel').notNull(),
    templateCode: text('template_code'),
    templateVersion: integer('template_version'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    dueAt: integer('due_at').notNull(),
    /** queued | processing | sent | suppressed | failed */
    state: text('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: integer('last_attempt_at'),
    lockedAt: integer('locked_at'),
    lastError: text('last_error'),
    notificationId: text('notification_id'),
    source: text('source').notNull(),
    actorUserId: text('actor_user_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    eventUnique: uniqueIndex('automation_deliveries_event_uq').on(t.automationId, t.eventKey),
    due: index('automation_deliveries_due_idx').on(t.state, t.dueAt),
    byTenant: index('automation_deliveries_tenant_idx').on(t.tenantId, t.createdAt),
    byRetention: index('automation_deliveries_retention_idx').on(t.updatedAt, t.state),
  }),
);

/** Durable execution evidence for every in-process scheduled job. */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    job: text('job').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    /** running | succeeded | failed */
    status: text('status').notNull().default('running'),
    durationMs: integer('duration_ms'),
    error: text('error'),
  },
  (t) => ({
    byJob: index('job_runs_job_idx').on(t.job, t.startedAt),
    byRetention: index('job_runs_retention_idx').on(t.finishedAt, t.status),
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
