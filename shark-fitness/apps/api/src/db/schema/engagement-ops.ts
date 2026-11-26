import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/* ============================================================================
   Engagement and operations (P07): notification deliveries, inbox notes and
   attachments, community moderation, staff tasks and broadcasts.
   ========================================================================= */

/**
 * Every attempt to reach a person on a channel (PF-COMM-002, PF-COMM-005).
 *
 * One row per person per channel per logical message. The row is written when
 * the message is queued and updated as it moves: `queued` → `processing` →
 * `logged` (the log driver: recorded, not delivered) | `sent` (a provider
 * accepted it and gave us an id) | `deferred` (quiet hours) | `suppressed`
 * (consent, opt-out, no destination, no provider) | `failed` (provider refused
 * or retries ran out). The reason is always written in words.
 *
 * The copy is stored as a template plus variables and rendered at send time,
 * so a variable that went missing between queueing and sending stops the send
 * rather than delivering "Hi {firstName}".
 */
export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    userId: text('user_id').notNull(),
    memberId: text('member_id'),
    /** in_app | push | email | sms | whatsapp */
    channel: text('channel').notNull(),
    /** transactional | operational | coaching | promotional */
    purpose: text('purpose').notNull(),
    /** What asked for it: automation | dunning | broadcast | message | community | coaching | task | system */
    source: text('source').notNull(),
    sourceId: text('source_id'),
    /** Same key on the same channel means the same message. */
    dedupeKey: text('dedupe_key'),
    kind: text('kind').notNull().default('system'),
    /** The gym's message template this came from, when there was one. */
    templateCode: text('template_code'),
    title: text('title').notNull(),
    bodyTemplate: text('body_template').notNull(),
    variables: text('variables', { mode: 'json' }).$type<Record<string, string | number | null>>().notNull(),
    /** Approved provider template (WhatsApp Cloud template name, MSG91 flow id). */
    providerTemplate: text('provider_template'),
    link: text('link'),
    state: text('state').notNull().default('queued'),
    reason: text('reason').notNull().default(''),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    /** Masked address the attempt went to ("+91•••••45678"), never the full one. */
    destinationHint: text('destination_hint'),
    attempts: integer('attempts').notNull().default(0),
    dueAt: integer('due_at').notNull(),
    lockedAt: integer('locked_at'),
    lastAttemptAt: integer('last_attempt_at'),
    deliveredAt: integer('delivered_at'),
    notificationId: text('notification_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    due: index('notification_deliveries_due_idx').on(t.state, t.dueAt),
    bySource: index('notification_deliveries_source_idx').on(t.tenantId, t.source, t.sourceId),
    byUser: index('notification_deliveries_user_idx').on(t.userId, t.createdAt),
    dedupe: uniqueIndex('notification_deliveries_dedupe_uq')
      .on(t.tenantId, t.channel, t.dedupeKey)
      .where(sql`dedupe_key is not null`),
  }),
);

/**
 * Staff-only notes on a member conversation. A separate table on purpose: the
 * member-facing message serializer reads `messages`, and a note can never be
 * one bad filter away from a member's screen.
 */
export const conversationNotes = sqliteTable(
  'conversation_notes',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    authorUserId: text('author_user_id').notNull(),
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byConversation: index('conversation_notes_idx').on(t.conversationId, t.createdAt) }),
);

/**
 * A file sent in a conversation. Stored through the `MediaStorage` port and
 * only ever served through a short-lived signed URL that re-checks who is
 * asking. `messageId` is null between upload and send.
 */
export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id'),
    uploaderUserId: text('uploader_user_id').notNull(),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    byConversation: index('message_attachments_conversation_idx').on(t.conversationId),
    byMessage: index('message_attachments_message_idx').on(t.messageId),
  }),
);

/** One-way: I stop seeing someone's posts and comments; they are not told and
 *  still see mine (a block is the two-way tool). */
export const communityMutes = sqliteTable(
  'community_mutes',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    mutedMemberId: text('muted_member_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('community_mutes_uq').on(t.memberId, t.mutedMemberId) }),
);

/** Staff removed a member from the community. At most one live ban per member. */
export const communityBans = sqliteTable(
  'community_bans',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    reason: text('reason').notNull(),
    bannedByUserId: text('banned_by_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    liftedAt: integer('lifted_at'),
    liftedByUserId: text('lifted_by_user_id'),
  },
  (t) => ({
    live: uniqueIndex('community_bans_live_uq').on(t.tenantId, t.memberId).where(sql`lifted_at is null`),
  }),
);

/**
 * The staff work queue (PF-DASH-005, PF-SUP-004).
 *
 * Generated tasks carry a `generationKey` ("lead_sla:<leadId>") with a unique
 * index, so a scheduler that runs twice, or two overlapping ticks, cannot open
 * the same follow-up twice — the database refuses the second insert.
 */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull().default(''),
    /** manual | lead_sla | failed_payment | member_risk | safety_work_order | waitlist_offer */
    source: text('source').notNull(),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    generationKey: text('generation_key'),
    memberId: text('member_id'),
    leadId: text('lead_id'),
    /** Console path to the thing the task is about. */
    link: text('link'),
    assigneeStaffId: text('assignee_staff_id'),
    createdByUserId: text('created_by_user_id'),
    /** low | normal | high | urgent */
    priority: text('priority').notNull().default('normal'),
    /** open | in_progress | done | cancelled */
    status: text('status').notNull().default('open'),
    dueAt: integer('due_at'),
    outcome: text('outcome'),
    completedAt: integer('completed_at'),
    completedByUserId: text('completed_by_user_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    byStatus: index('tasks_status_idx').on(t.tenantId, t.status, t.dueAt),
    byAssignee: index('tasks_assignee_idx').on(t.assigneeStaffId, t.status),
    generation: uniqueIndex('tasks_generation_uq')
      .on(t.tenantId, t.generationKey)
      .where(sql`generation_key is not null`),
  }),
);

/** A one-off message to a segment (PF-COMM-006). */
export const broadcasts = sqliteTable(
  'broadcasts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    channel: text('channel').notNull(),
    /** promotional | operational */
    purpose: text('purpose').notNull(),
    segment: text('segment', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** The creator's branch scope, frozen so a later run cannot widen it. */
    branchIds: text('branch_ids', { mode: 'json' }).$type<string[]>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** draft | awaiting_approval | approved | sending | sent | cancelled */
    state: text('state').notNull().default('draft'),
    recipientCount: integer('recipient_count').notNull().default(0),
    estimatedCostMinor: integer('estimated_cost_minor').notNull().default(0),
    approvalRequired: integer('approval_required', { mode: 'boolean' }).notNull().default(false),
    approvedByUserId: text('approved_by_user_id'),
    approvedAt: integer('approved_at'),
    lastDryRunAt: integer('last_dry_run_at'),
    createdByUserId: text('created_by_user_id').notNull(),
    sentAt: integer('sent_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byTenant: index('broadcasts_tenant_idx').on(t.tenantId, t.createdAt) }),
);
