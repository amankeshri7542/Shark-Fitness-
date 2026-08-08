import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Append-only. A correction is a new negative row citing the original
 *  (PF-GAME-002) — nothing here is ever updated or deleted. */
export const xpLedger = sqliteTable(
  'xp_ledger',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    isCorrection: integer('is_correction', { mode: 'boolean' }).notNull().default(false),
    at: integer('at').notNull(),
  },
  (t) => ({
    byMember: index('xp_member_idx').on(t.memberId, t.at),
    /** One award per source event. Re-syncing a workout cannot double-pay. */
    sourceUq: uniqueIndex('xp_source_uq').on(t.memberId, t.reason, t.refType, t.refId, t.isCorrection),
  }),
);

export const achievements = sqliteTable('achievements', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  tier: text('tier').notNull().default('bronze'),
  criteria: text('criteria', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
});

export const memberAchievements = sqliteTable(
  'member_achievements',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    achievementId: text('achievement_id').notNull(),
    earnedAt: integer('earned_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('member_achievements_uq').on(t.memberId, t.achievementId) }),
);

export const challenges = sqliteTable(
  'challenges',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Constrained to the rankable set — volume and body metrics are refused
     *  at the service layer (PF-GAME-004). */
    metric: text('metric').notNull(),
    metricLabel: text('metric_label').notNull(),
    startsOn: text('starts_on').notNull(),
    endsOn: text('ends_on').notNull(),
    visibility: text('visibility').notNull().default('branch'),
    teamMode: integer('team_mode', { mode: 'boolean' }).notNull().default(false),
    teamTarget: integer('team_target'),
    rules: text('rules', { mode: 'json' }).$type<string[]>().notNull(),
    rewardLabel: text('reward_label'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byTenant: index('challenges_tenant_idx').on(t.tenantId, t.endsOn) }),
);

export const challengeParticipants = sqliteTable(
  'challenge_participants',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    challengeId: text('challenge_id').notNull(),
    memberId: text('member_id').notNull(),
    teamId: text('team_id'),
    rawCount: integer('raw_count').notNull().default(0),
    score: integer('score').notNull().default(0),
    joinedAt: integer('joined_at').notNull(),
    /** Ranked entries can be pseudonymous — "Shark #4417". */
    anonymous: integer('anonymous', { mode: 'boolean' }).notNull().default(false),
    flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    uq: uniqueIndex('challenge_participants_uq').on(t.challengeId, t.memberId),
    byScore: index('challenge_score_idx').on(t.challengeId, t.score),
  }),
);

export const referrals = sqliteTable(
  'referrals',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    code: text('code').notNull(),
    inviteeName: text('invitee_name'),
    inviteeContact: text('invitee_contact'),
    state: text('state').notNull().default('invited'),
    rewardMinor: integer('reward_minor').notNull().default(0),
    rewardPaidAt: integer('reward_paid_at'),
    expiresOn: text('expires_on'),
    deviceFingerprint: text('device_fingerprint'),
    suspiciousReason: text('suspicious_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    codeUq: uniqueIndex('referrals_code_uq').on(t.tenantId, t.code, t.inviteeContact),
    byMember: index('referrals_member_idx').on(t.memberId),
  }),
);

export const streaksTable = sqliteTable('streaks', {
  memberId: text('member_id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  current: integer('current').notNull().default(0),
  longest: integer('longest').notNull().default(0),
  weeklyTarget: integer('weekly_target').notNull().default(4),
  restDaysAllowed: integer('rest_days_allowed').notNull().default(2),
  lastSessionOn: text('last_session_on'),
  updatedAt: integer('updated_at').notNull(),
});

/* ——— Community ————————————————————————————————————————————— */

export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id'),
    memberId: text('member_id'),
    /** Set for gym announcements posted by staff. */
    staffId: text('staff_id'),
    authorKind: text('author_kind').notNull().default('member'),
    kind: text('kind').notNull().default('text'),
    body: text('body').notNull(),
    badge: text('badge'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    visibility: text('visibility').notNull().default('branch'),
    state: text('state').notNull().default('visible'),
    kudosCount: integer('kudos_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({ byFeed: index('posts_feed_idx').on(t.tenantId, t.branchId, t.createdAt) }),
);

export const reactions = sqliteTable(
  'reactions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    postId: text('post_id').notNull(),
    memberId: text('member_id').notNull(),
    kind: text('kind').notNull().default('kudos'),
    at: integer('at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('reactions_uq').on(t.postId, t.memberId, t.kind) }),
);

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    postId: text('post_id').notNull(),
    memberId: text('member_id').notNull(),
    body: text('body').notNull(),
    state: text('state').notNull().default('visible'),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({ byPost: index('comments_post_idx').on(t.postId, t.createdAt) }),
);

export const contentReports = sqliteTable(
  'content_reports',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reporterId: text('reporter_id').notNull(),
    reason: text('reason').notNull(),
    note: text('note'),
    state: text('state').notNull().default('open'),
    resolvedById: text('resolved_by_id'),
    resolution: text('resolution'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byState: index('content_reports_idx').on(t.tenantId, t.state) }),
);

/** Blocking is mutual and hides content in both directions. */
export const blocks = sqliteTable(
  'blocks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    blockedMemberId: text('blocked_member_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('blocks_uq').on(t.memberId, t.blockedMemberId) }),
);

/* ——— Messaging ———————————————————————————————————————————— */

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    kind: text('kind').notNull().default('coach'),
    title: text('title').notNull(),
    memberId: text('member_id'),
    staffId: text('staff_id'),
    ticketId: text('ticket_id'),
    state: text('state').notNull().default('open'),
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
    lastMessageAt: integer('last_message_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byMember: index('conversations_member_idx').on(t.memberId, t.lastMessageAt) }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    senderUserId: text('sender_user_id').notNull(),
    senderName: text('sender_name').notNull(),
    senderRole: text('sender_role').notNull(),
    body: text('body').notNull(),
    attachments: text('attachments', { mode: 'json' })
      .$type<Array<{ name: string; url: string; sizeBytes: number }>>()
      .notNull(),
    state: text('state').notNull().default('sent'),
    clientId: text('client_id'),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
    /** Set when the body tripped a safety pattern; routes to a human. */
    safetyFlagged: integer('safety_flagged', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    byConversation: index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    clientUq: uniqueIndex('messages_client_uq').on(t.conversationId, t.clientId),
  }),
);

/* ——— Media ———————————————————————————————————————————————— */

export const mediaAssets = sqliteTable(
  'media_assets',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    trainerName: text('trainer_name').notNull(),
    durationSec: integer('duration_sec').notNull(),
    level: text('level').notNull().default('intermediate'),
    equipment: text('equipment', { mode: 'json' }).$type<string[]>().notNull(),
    posterColor: text('poster_color').notNull().default('#0b2331'),
    hasCaptions: integer('has_captions', { mode: 'boolean' }).notNull().default(true),
    /** Which plans may play it. Empty means every active member. */
    requiredProductKinds: text('required_product_kinds', { mode: 'json' }).$type<string[]>().notNull(),
    playbackUrl: text('playback_url'),
    publishedAt: integer('published_at').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => ({ byTenant: index('media_tenant_idx').on(t.tenantId, t.category) }),
);

export const mediaProgress = sqliteTable(
  'media_progress',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    assetId: text('asset_id').notNull(),
    positionSec: integer('position_sec').notNull().default(0),
    favourite: integer('favourite', { mode: 'boolean' }).notNull().default(false),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('media_progress_uq').on(t.memberId, t.assetId) }),
);

export const liveSessions = sqliteTable(
  'live_sessions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    classSessionId: text('class_session_id'),
    title: text('title').notNull(),
    trainerName: text('trainer_name').notNull(),
    startsAt: integer('starts_at').notNull(),
    state: text('state').notNull().default('scheduled'),
    provider: text('provider').notNull().default('none'),
    roomKey: text('room_key'),
    recordingPolicy: text('recording_policy').notNull().default('none'),
    recordingConsentGiven: integer('recording_consent_given', { mode: 'boolean' }).notNull().default(false),
    participantCount: integer('participant_count').notNull().default(0),
    /** Set when video is unavailable; chat and attendance still work. */
    fallbackNote: text('fallback_note'),
  },
  (t) => ({ byTenant: index('live_tenant_idx').on(t.tenantId, t.startsAt) }),
);

/** Metered usage per tenant, so a quota can be enforced before a provider
 *  bill arrives (PF-MEDIA-005, cost guardrails). */
export const usageMeters = sqliteTable(
  'usage_meters',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    meter: text('meter').notNull(),
    period: text('period').notNull(),
    used: integer('used').notNull().default(0),
    limitValue: integer('limit_value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('usage_meters_uq').on(t.tenantId, t.meter, t.period) }),
);
