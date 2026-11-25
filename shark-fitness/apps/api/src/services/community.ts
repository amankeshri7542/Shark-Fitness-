import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { emit } from '../lib/events.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { now, relativeTime } from '../lib/time.js';
import { engagementSettings } from './engagement-settings.js';
import { memberIsMinor } from './messaging.js';
import { queueNotification } from './notifications/service.js';

/**
 * Community moderation (P07; PF-GAME-005, UX-M11, PRD 04 community edge cases).
 *
 * Every decision is a person's, carries a reason, is audited, and is told to
 * the author in plain words. "Hide" is reversible and leaves the author able to
 * see their own content with the reason; "remove" leaves a tombstone for
 * everyone. Both can be restored. Content in a branch outside the moderator's
 * scope is not found.
 */

type TargetType = 'post' | 'comment';
type Post = typeof schema.posts.$inferSelect;
type Comment = typeof schema.comments.$inferSelect;

export function activeCommunityBan(tenantId: string, memberId: string) {
  return db
    .select()
    .from(schema.communityBans)
    .where(and(eq(schema.communityBans.tenantId, tenantId), eq(schema.communityBans.memberId, memberId), isNull(schema.communityBans.liftedAt)))
    .get();
}

function memberCard(tenantId: string, memberId: string | null) {
  if (!memberId) return null;
  const m = db.select().from(schema.members).where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, tenantId))).get();
  if (!m) return null;
  return {
    id: m.id,
    name: `${m.firstName} ${m.lastName}`.trim(),
    initials: m.initials,
    memberNo: m.memberNo,
    minor: memberIsMinor(m),
    banned: Boolean(activeCommunityBan(tenantId, m.id)),
  };
}

/** The post (and, for a comment, the comment) in the caller's scope, or 404. */
function loadTarget(ctx: RequestContext, type: TargetType, targetId: string): { post: Post; comment: Comment | null } {
  const comment =
    type === 'comment'
      ? db.select().from(schema.comments).where(and(eq(schema.comments.id, targetId), eq(schema.comments.tenantId, ctx.tenantId))).get() ?? null
      : null;
  const postId = type === 'comment' ? comment?.postId : targetId;
  const post = postId
    ? db.select().from(schema.posts).where(and(eq(schema.posts.id, postId), eq(schema.posts.tenantId, ctx.tenantId))).get()
    : undefined;
  if (!post || (type === 'comment' && !comment)) throw notFound('That content');
  if (post.branchId && !branchScope(ctx).includes(post.branchId)) throw notFound('That content');
  return { post, comment };
}

/* ——— Reports queue ———————————————————————————————————————— */

export function reportsQueue(ctx: RequestContext, state: 'open' | 'resolved') {
  requirePermission(ctx, 'community.moderate');
  const scope = new Set(branchScope(ctx));
  const reports = db
    .select()
    .from(schema.contentReports)
    .where(
      and(
        eq(schema.contentReports.tenantId, ctx.tenantId),
        inArray(schema.contentReports.targetType, ['post', 'comment']),
        state === 'open' ? eq(schema.contentReports.state, 'open') : sql`${schema.contentReports.state} != 'open'`,
      ),
    )
    .orderBy(desc(schema.contentReports.createdAt))
    .limit(500)
    .all();

  // One row per piece of content, however many people reported it.
  const grouped = new Map<string, typeof reports>();
  for (const r of reports) {
    const key = `${r.targetType}:${r.targetId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), r]);
  }

  const items = [];
  for (const [key, rows] of grouped) {
    const [type, targetId] = key.split(':') as [TargetType, string];
    let target: { post: Post; comment: Comment | null };
    try {
      target = loadTarget(ctx, type, targetId);
    } catch {
      continue;
    }
    if (target.post.branchId && !scope.has(target.post.branchId)) continue;
    const content = type === 'comment' ? target.comment! : target.post;
    const reasons: Record<string, number> = {};
    for (const r of rows) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    items.push({
      key,
      targetType: type,
      targetId,
      postId: target.post.id,
      branchId: target.post.branchId,
      body: content.body,
      state: content.state,
      createdAt: new Date(content.createdAt).toISOString(),
      // The post a comment sits under, so a moderator sees what it replied to.
      context: type === 'comment' ? { postBody: target.post.body.slice(0, 280) } : null,
      author: memberCard(ctx.tenantId, content.memberId),
      reportCount: new Set(rows.map((r) => r.reporterId)).size,
      reasons: Object.entries(reasons).map(([reason, count]) => ({ reason, count })),
      notes: rows.map((r) => r.note).filter((n): n is string => Boolean(n)).slice(0, 5),
      firstReportedAt: new Date(Math.min(...rows.map((r) => r.createdAt))).toISOString(),
      lastReportedRelative: relativeTime(Math.max(...rows.map((r) => r.createdAt))),
      resolution: rows[0]?.resolution ?? null,
    });
  }
  return { items, counts: { open: state === 'open' ? items.length : null } };
}

/* ——— Decisions ———————————————————————————————————————————— */

export type ModerationAction = 'hide' | 'remove' | 'dismiss' | 'restore';

const ACTION_STATE: Record<Exclude<ModerationAction, 'dismiss'>, string> = {
  hide: 'hidden',
  remove: 'removed',
  restore: 'visible',
};

const AUTHOR_COPY: Record<'hide' | 'remove' | 'restore', (what: string, reason: string) => { title: string; body: string }> = {
  hide: (what, reason) => ({
    title: `Your ${what} was hidden`,
    body: `A moderator hid your ${what} from the community: ${reason} You can still see it. Ask the front desk if you think this is a mistake.`,
  }),
  remove: (what, reason) => ({
    title: `Your ${what} was removed`,
    body: `A moderator removed your ${what}: ${reason} Ask the front desk if you think this is a mistake.`,
  }),
  restore: (what) => ({
    title: `Your ${what} is back`,
    body: `A moderator reviewed your ${what} again and restored it. Sorry for the trouble.`,
  }),
};

function notifyAuthor(ctx: RequestContext, memberId: string | null, branchId: string | null, title: string, body: string, key: string): void {
  if (!memberId) return;
  const userId = db.select({ userId: schema.members.userId }).from(schema.members).where(eq(schema.members.id, memberId)).get()?.userId;
  if (!userId) return;
  queueNotification({
    tenantId: ctx.tenantId,
    userId,
    memberId,
    branchId,
    channel: 'in_app',
    // About their own account standing: always delivered.
    purpose: 'transactional',
    source: 'community',
    sourceId: key,
    dedupeKey: `moderation:${key}:${Date.now()}`,
    kind: 'community',
    title,
    body,
    link: '/pack',
  });
}

export function moderate(ctx: RequestContext, type: TargetType, targetId: string, action: ModerationAction, reason: string) {
  requirePermission(ctx, 'community.moderate');
  const trimmed = reason.trim();
  if (action !== 'dismiss' && trimmed.length < 3) throw invalid('Give a reason. The author is told it.');
  const { post, comment } = loadTarget(ctx, type, targetId);
  const content = comment ?? post;
  const at = now();

  if (action === 'restore' && content.state === 'visible') throw conflict('That is already visible.');

  transact(() => {
    if (action !== 'dismiss') {
      const patch = {
        state: ACTION_STATE[action],
        moderationReason: action === 'restore' ? null : trimmed,
        moderatedAt: at,
        moderatedByUserId: ctx.userId,
      };
      if (comment) db.update(schema.comments).set(patch).where(eq(schema.comments.id, comment.id)).run();
      else db.update(schema.posts).set(patch).where(eq(schema.posts.id, post.id)).run();
    }

    // Every open report on this content is answered by this decision.
    db.update(schema.contentReports)
      .set({
        state: action === 'dismiss' ? 'dismissed' : 'resolved',
        resolution: action === 'dismiss' ? `No action: ${trimmed || 'reviewed and kept'}` : `${action}: ${trimmed}`,
        resolvedById: ctx.userId,
        resolvedAt: at,
      })
      .where(and(eq(schema.contentReports.tenantId, ctx.tenantId), eq(schema.contentReports.targetId, targetId), eq(schema.contentReports.state, 'open')))
      .run();
    // A dismissed report clears the "under review" flag the reports put on it.
    if (action === 'dismiss' && content.state === 'flagged') {
      if (comment) db.update(schema.comments).set({ state: 'visible' }).where(eq(schema.comments.id, comment.id)).run();
      else db.update(schema.posts).set({ state: 'visible' }).where(eq(schema.posts.id, post.id)).run();
    }

    audit(ctx, {
      action: `community.${type}_${action === 'dismiss' ? 'reports_dismissed' : action === 'restore' ? 'restored' : action === 'hide' ? 'hidden' : 'removed'}`,
      entityType: type,
      entityId: targetId,
      entityLabel: content.body.slice(0, 60),
      reason: trimmed || null,
      branchId: post.branchId,
      before: { state: content.state },
      after: { state: action === 'dismiss' ? (content.state === 'flagged' ? 'visible' : content.state) : ACTION_STATE[action] },
    });

    if (action !== 'dismiss') {
      const copy = AUTHOR_COPY[action](type === 'comment' ? 'comment' : 'post', trimmed);
      notifyAuthor(ctx, content.memberId, post.branchId, copy.title, copy.body, `${type}:${targetId}`);
    }
    if (post.branchId) {
      emit({
        tenantId: ctx.tenantId,
        branchId: post.branchId,
        channel: channels.branch(post.branchId),
        topic: 'post.created',
        payload: { postId: post.id, moderated: action },
      });
    }
  });
  return { ok: true as const, state: action === 'dismiss' ? content.state : ACTION_STATE[action] };
}

/* ——— Approval queue ————————————————————————————————————————— */

export function approvalQueue(ctx: RequestContext) {
  requirePermission(ctx, 'community.moderate');
  const scope = branchScope(ctx);
  const rows = db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.tenantId, ctx.tenantId), eq(schema.posts.state, 'pending'), inArray(schema.posts.branchId, scope)))
    .orderBy(schema.posts.createdAt)
    .all();
  return {
    approvalMode: engagementSettings(ctx.tenantId).communityApprovalMode,
    items: rows.map((p) => ({
      id: p.id,
      body: p.body,
      kind: p.kind,
      branchId: p.branchId,
      createdAt: new Date(p.createdAt).toISOString(),
      relativeTime: relativeTime(p.createdAt),
      author: memberCard(ctx.tenantId, p.memberId),
    })),
  };
}

export function decideApproval(ctx: RequestContext, postId: string, decision: 'approve' | 'reject', reason: string) {
  requirePermission(ctx, 'community.moderate');
  const { post } = loadTarget(ctx, 'post', postId);
  if (post.state !== 'pending') throw conflict('That post is no longer waiting for approval.');
  if (decision === 'reject' && reason.trim().length < 3) throw invalid('Give a reason. The author is told it.');
  const at = now();
  transact(() => {
    db.update(schema.posts)
      .set({
        state: decision === 'approve' ? 'visible' : 'rejected',
        // Approval publishes it now, at the top of the feed.
        createdAt: decision === 'approve' ? at : post.createdAt,
        moderationReason: decision === 'reject' ? reason.trim() : null,
        moderatedAt: at,
        moderatedByUserId: ctx.userId,
      })
      .where(eq(schema.posts.id, post.id))
      .run();
    audit(ctx, {
      action: decision === 'approve' ? 'community.post_approved' : 'community.post_rejected',
      entityType: 'post',
      entityId: post.id,
      entityLabel: post.body.slice(0, 60),
      reason: reason.trim() || null,
      branchId: post.branchId,
      before: { state: 'pending' },
      after: { state: decision === 'approve' ? 'visible' : 'rejected' },
    });
    notifyAuthor(
      ctx,
      post.memberId,
      post.branchId,
      decision === 'approve' ? 'Your post is live' : 'Your post was not approved',
      decision === 'approve'
        ? 'A moderator approved your post. It is now in the community feed.'
        : `A moderator did not approve your post: ${reason.trim()} Only you can see it.`,
      `post:${post.id}`,
    );
    if (decision === 'approve' && post.branchId) {
      emit({
        tenantId: ctx.tenantId,
        branchId: post.branchId,
        channel: channels.branch(post.branchId),
        topic: 'post.created',
        payload: { postId: post.id, authorKind: 'member' },
      });
    }
  });
  return { ok: true as const, state: decision === 'approve' ? 'visible' : 'rejected' };
}

/* ——— Bans ————————————————————————————————————————————————— */

function loadMemberInScope(ctx: RequestContext, memberId: string) {
  const member = db.select().from(schema.members).where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId))).get();
  if (!member || !branchScope(ctx).includes(member.homeBranchId)) throw notFound('That member');
  return member;
}

export function listBans(ctx: RequestContext) {
  requirePermission(ctx, 'community.moderate');
  const scope = new Set(branchScope(ctx));
  const rows = db
    .select({ ban: schema.communityBans, member: schema.members })
    .from(schema.communityBans)
    .innerJoin(schema.members, eq(schema.members.id, schema.communityBans.memberId))
    .where(and(eq(schema.communityBans.tenantId, ctx.tenantId), isNull(schema.communityBans.liftedAt)))
    .all()
    .filter((r) => scope.has(r.member.homeBranchId));
  return {
    items: rows.map(({ ban, member }) => ({
      memberId: member.id,
      name: `${member.firstName} ${member.lastName}`.trim(),
      memberNo: member.memberNo,
      reason: ban.reason,
      since: new Date(ban.createdAt).toISOString(),
      relativeTime: relativeTime(ban.createdAt),
    })),
  };
}

export function banFromCommunity(ctx: RequestContext, memberId: string, reason: string) {
  requirePermission(ctx, 'community.moderate');
  const member = loadMemberInScope(ctx, memberId);
  if (reason.trim().length < 3) throw invalid('Give a reason. The member is told it.');
  if (activeCommunityBan(ctx.tenantId, member.id)) throw conflict('That member is already blocked from the community.');
  transact(() => {
    db.insert(schema.communityBans)
      .values({ id: id('cbn'), tenantId: ctx.tenantId, memberId: member.id, reason: reason.trim(), bannedByUserId: ctx.userId, createdAt: now(), liftedAt: null, liftedByUserId: null })
      .run();
    audit(ctx, {
      action: 'community.member_banned',
      entityType: 'member',
      entityId: member.id,
      entityLabel: `${member.firstName} ${member.lastName}`,
      reason: reason.trim(),
      branchId: member.homeBranchId,
      after: { banned: true },
    });
    notifyAuthor(
      ctx,
      member.id,
      member.homeBranchId,
      'You can no longer post in the community',
      `A moderator switched off posting and commenting for your account: ${reason.trim()} You can still read the feed and use everything else. Ask the front desk if you think this is a mistake.`,
      `ban:${member.id}`,
    );
  });
  return { ok: true as const };
}

export function liftCommunityBan(ctx: RequestContext, memberId: string) {
  requirePermission(ctx, 'community.moderate');
  const member = loadMemberInScope(ctx, memberId);
  const ban = activeCommunityBan(ctx.tenantId, member.id);
  if (!ban) throw notFound('That block');
  transact(() => {
    db.update(schema.communityBans).set({ liftedAt: now(), liftedByUserId: ctx.userId }).where(eq(schema.communityBans.id, ban.id)).run();
    audit(ctx, {
      action: 'community.member_unbanned',
      entityType: 'member',
      entityId: member.id,
      entityLabel: `${member.firstName} ${member.lastName}`,
      branchId: member.homeBranchId,
      before: { banned: true },
      after: { banned: false },
    });
    notifyAuthor(ctx, member.id, member.homeBranchId, 'You can post in the community again', 'A moderator switched posting and commenting back on for your account.', `unban:${member.id}`);
  });
  return { ok: true as const };
}
