import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { addDays, now } from '../lib/time.js';
import { call, memberIdFor, signIn, userIdFor, type TestSession } from './helpers/session.js';

/* ============================================================================
   Community: comments, report, block, mute, approval mode, and the staff
   moderation console (P07 AC3; PF-GAME-005, UX-M11, PRD 04 "Blocked users
   remain in a group").
   ========================================================================= */

const AMAN = 'aman@sharkfitness.in';
const ROHIT = 'rohit@sharkfitness.in';
const MANAGER = 'manager@sharkfitness.in';
const OWNER = 'owner@sharkfitness.in';

let aman: TestSession;
let rohit: TestSession;
let manager: TestSession;
let owner: TestSession;
let amanId = '';
let rohitId = '';
let rohitDob: string | null = null;
let seededPostIds: string[] = [];
const challengeId = id('chl');
const startedAt = Date.now();

interface FeedPost {
  id: string;
  body: string;
  removed: boolean;
  authorName: string;
  authorId: string | null;
  moderationNote: string | null;
  comments: Array<{ id: string; body: string; removed: boolean }>;
  commentCount: number;
}

async function feed(session: TestSession): Promise<FeedPost[]> {
  const response = await call(session, 'GET', '/v1/member/engagement/feed?limit=50');
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: FeedPost[] }).items;
}

/**
 * The feed allows five posts an hour per member, and this suite posts more
 * than that as each member. Before each post, the suite's own earlier posts are
 * aged past the window — except in the test that proves the limit.
 */
function ageMyPosts(): void {
  for (const memberId of [amanId, rohitId]) {
    for (const row of db.select().from(schema.posts).where(eq(schema.posts.memberId, memberId)).all()) {
      if (row.createdAt > Date.now() - 60 * 60_000 && !seededPostIds.includes(row.id)) {
        db.update(schema.posts).set({ createdAt: row.createdAt - 2 * 60 * 60_000 }).where(eq(schema.posts.id, row.id)).run();
      }
    }
  }
}

async function post(session: TestSession, body: string, keepBudget = false): Promise<{ status: number; id: string; awaitingApproval: boolean }> {
  if (!keepBudget) ageMyPosts();
  const response = await call(session, 'POST', '/v1/member/engagement/feed', { body, kind: 'text', visibility: 'branch' });
  const json = (await response.json()) as { post?: { id: string }; awaitingApproval?: boolean };
  return { status: response.status, id: json.post?.id ?? '', awaitingApproval: json.awaitingApproval ?? false };
}

function notificationsFor(email: string) {
  return db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userIdFor(email)), eq(schema.notifications.kind, 'community')))
    .all()
    .filter((n) => n.createdAt >= startedAt);
}

function setPolicy(key: string, value: unknown) {
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, 'ten_shark')).get()!;
  const policy = { ...(tenant.policy as Record<string, unknown>) };
  if (value === undefined) delete policy[key];
  else policy[key] = value;
  db.update(schema.tenants).set({ policy: policy as never }).where(eq(schema.tenants.id, 'ten_shark')).run();
}

beforeAll(async () => {
  [aman, rohit, manager, owner] = await Promise.all([signIn(AMAN), signIn(ROHIT), signIn(MANAGER), signIn(OWNER)]);
  amanId = memberIdFor(AMAN);
  rohitId = memberIdFor(ROHIT);
  rohitDob = db.select({ dob: schema.members.dob }).from(schema.members).where(eq(schema.members.id, rohitId)).get()?.dob ?? null;
  seededPostIds = db.select({ id: schema.posts.id }).from(schema.posts).where(inArray(schema.posts.memberId, [amanId, rohitId])).all().map((p) => p.id);
});

afterAll(() => {
  const mine = db
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(and(inArray(schema.posts.memberId, [amanId, rohitId])))
    .all()
    .map((p) => p.id);
  const seeded = new Set(seededPostIds);
  const fresh = mine.filter((postId) => !seeded.has(postId));
  if (fresh.length) {
    db.delete(schema.comments).where(inArray(schema.comments.postId, fresh)).run();
    db.delete(schema.contentReports).where(inArray(schema.contentReports.targetId, fresh)).run();
    db.delete(schema.reactions).where(inArray(schema.reactions.postId, fresh)).run();
    db.delete(schema.posts).where(inArray(schema.posts.id, fresh)).run();
  }
  db.delete(schema.comments).where(and(inArray(schema.comments.memberId, [amanId, rohitId]), gte(schema.comments.createdAt, startedAt))).run();
  db.delete(schema.blocks).where(inArray(schema.blocks.memberId, [amanId, rohitId])).run();
  db.delete(schema.communityMutes).where(inArray(schema.communityMutes.memberId, [amanId, rohitId])).run();
  db.delete(schema.communityBans).where(inArray(schema.communityBans.memberId, [amanId, rohitId])).run();
  db.delete(schema.challengeParticipants).where(eq(schema.challengeParticipants.challengeId, challengeId)).run();
  db.delete(schema.challenges).where(eq(schema.challenges.id, challengeId)).run();
  db.update(schema.members).set({ dob: rohitDob }).where(eq(schema.members.id, rohitId)).run();
  setPolicy('communityApprovalMode', undefined);
});

describe('report → queue → remove', () => {
  it('puts a reported post in the queue with context, and removing it hides it for everyone and tells the author', async () => {
    const created = await post(aman, 'Anyone else think the new squat racks wobble?');
    expect(created.status).toBe(201);

    const comment = await call(rohit, 'POST', `/v1/member/engagement/feed/${created.id}/comment`, { body: 'Mine was fine on Tuesday.' });
    expect(comment.status).toBe(201);

    const report = await call(rohit, 'POST', '/v1/member/engagement/report', { targetType: 'post', targetId: created.id, reason: 'harassment', note: 'Rude to staff' });
    expect(report.status).toBe(201);

    const queue = (await (await call(manager, 'GET', '/v1/admin/community/reports')).json()) as {
      items: Array<{ targetId: string; body: string; reportCount: number; author: { name: string }; reasons: Array<{ reason: string }>; notes: string[] }>;
    };
    const item = queue.items.find((i) => i.targetId === created.id)!;
    expect(item).toMatchObject({ body: 'Anyone else think the new squat racks wobble?', reportCount: 1, author: { name: 'Aman Mehra' } });
    expect(item.reasons).toEqual([{ reason: 'harassment', count: 1 }]);
    expect(item.notes).toContain('Rude to staff');

    const removed = await call(manager, 'POST', `/v1/admin/community/content/post/${created.id}`, { action: 'remove', reason: 'Personal remarks about staff are not allowed.' });
    expect(removed.status).toBe(200);

    for (const session of [rohit, aman]) {
      const seen = (await feed(session)).find((p) => p.id === created.id)!;
      expect(seen.removed).toBe(true);
      expect(seen.body).toBe('');
    }
    const note = notificationsFor(AMAN).find((n) => n.title === 'Your post was removed')!;
    expect(note.body).toContain('Personal remarks about staff are not allowed.');

    const after = (await (await call(manager, 'GET', '/v1/admin/community/reports')).json()) as { items: Array<{ targetId: string }> };
    expect(after.items.find((i) => i.targetId === created.id)).toBeUndefined();
    const audit = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, created.id), eq(schema.auditLog.action, 'community.post_removed'))).get();
    expect(audit?.reason).toBe('Personal remarks about staff are not allowed.');
  });

  it('hides content from everyone but its author, then restores it', async () => {
    const created = await post(aman, 'Selling my old lifting belt, DM me');
    await call(manager, 'POST', `/v1/admin/community/content/post/${created.id}`, { action: 'hide', reason: 'No selling in the feed.' });

    expect((await feed(rohit)).find((p) => p.id === created.id)).toBeUndefined();
    const own = (await feed(aman)).find((p) => p.id === created.id)!;
    expect(own.moderationNote).toBe('Hidden by a moderator: No selling in the feed. Only you can see it.');

    await call(manager, 'POST', `/v1/admin/community/content/post/${created.id}`, { action: 'restore', reason: 'Reviewed again' });
    expect((await feed(rohit)).find((p) => p.id === created.id)?.body).toBe('Selling my old lifting belt, DM me');
    expect(notificationsFor(AMAN).some((n) => n.title === 'Your post is back')).toBe(true);
  });

  it('needs a reason, and 404s outside the moderator’s scope', async () => {
    const created = await post(aman, 'A post to moderate');
    expect((await call(manager, 'POST', `/v1/admin/community/content/post/${created.id}`, { action: 'remove', reason: '' })).status).toBe(422);
    const reef = await signIn('owner@reefathletic.in', 'reef');
    expect((await call(reef, 'POST', `/v1/admin/community/content/post/${created.id}`, { action: 'remove', reason: 'Not yours' })).status).toBe(404);
    const reception = await signIn('reception@sharkfitness.in');
    expect((await call(reception, 'GET', '/v1/admin/community/reports')).status).toBe(403);
  });
});

describe('block, mute and shared groups', () => {
  it('hides blocked content both ways, including on a shared challenge board', async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.insert(schema.challenges)
      .values({
        id: challengeId,
        tenantId: 'ten_shark',
        branchId: 'br_kor',
        name: 'P07 shared group',
        description: 'Both members are in it.',
        metric: 'sessions',
        metricLabel: 'sessions',
        startsOn: addDays(today, -3),
        endsOn: addDays(today, 10),
        visibility: 'branch',
        teamMode: false,
        teamTarget: null,
        rules: [],
        rewardLabel: null,
        createdAt: now(),
      })
      .run();
    expect((await call(aman, 'POST', `/v1/member/engagement/challenge/${challengeId}/join`)).status).toBeLessThan(300);
    expect((await call(rohit, 'POST', `/v1/member/engagement/challenge/${challengeId}/join`)).status).toBeLessThan(300);

    const amanPost = await post(aman, 'Aman before the block');
    const rohitPost = await post(rohit, 'Rohit before the block');

    expect((await call(aman, 'POST', `/v1/member/engagement/block/${rohitId}`)).status).toBe(200);

    expect((await feed(aman)).some((p) => p.id === rohitPost.id)).toBe(false);
    expect((await feed(rohit)).some((p) => p.id === amanPost.id)).toBe(false);

    // Both stay in the group; neither sees the other's name on the board.
    const boardFor = async (session: TestSession) =>
      ((await (await call(session, 'GET', `/v1/member/engagement/challenge/${challengeId}`)).json()) as { board: Array<{ displayName: string; memberId: string | null; isYou: boolean }> }).board;
    const amanBoard = await boardFor(aman);
    const rohitBoard = await boardFor(rohit);
    expect(amanBoard).toHaveLength(2);
    expect(amanBoard.find((r) => !r.isYou)).toMatchObject({ displayName: 'Blocked member', memberId: null });
    expect(rohitBoard.find((r) => !r.isYou)).toMatchObject({ displayName: 'Blocked member', memberId: null });

    // Their comments on a third party's post disappear too.
    const neutral = await post(aman, 'Neutral post for comments');
    await call(aman, 'DELETE', `/v1/member/engagement/block/${rohitId}`);
    await call(rohit, 'POST', `/v1/member/engagement/feed/${neutral.id}/comment`, { body: 'Rohit comment' });
    await call(aman, 'POST', `/v1/member/engagement/block/${rohitId}`);
    const seenByAman = (await feed(aman)).find((p) => p.id === neutral.id)!;
    expect(seenByAman.comments.some((c) => c.body === 'Rohit comment')).toBe(false);
    // The count does not give the blocked commenter away either; Rohit still sees his own.
    expect(seenByAman.commentCount).toBe(seenByAman.comments.length);
    const seenByRohit = (await feed(rohit)).find((p) => p.id === neutral.id);
    expect(seenByRohit).toBeUndefined();
    await call(aman, 'DELETE', `/v1/member/engagement/block/${rohitId}`);
  });

  it('mutes one way: I stop seeing them, they still see me', async () => {
    const rohitPost = await post(rohit, 'Rohit after the mute');
    const amanPost = await post(aman, 'Aman after the mute');
    expect((await call(aman, 'POST', `/v1/member/engagement/mute/${rohitId}`)).status).toBe(200);
    expect((await feed(aman)).some((p) => p.id === rohitPost.id)).toBe(false);
    expect((await feed(rohit)).some((p) => p.id === amanPost.id)).toBe(true);
    const lists = (await (await call(aman, 'GET', '/v1/member/engagement/blocks')).json()) as { muted: Array<{ memberId: string }> };
    expect(lists.muted.map((m) => m.memberId)).toContain(rohitId);
    expect((await call(aman, 'DELETE', `/v1/member/engagement/mute/${rohitId}`)).status).toBe(200);
    expect((await feed(aman)).some((p) => p.id === rohitPost.id)).toBe(true);
  });
});

describe('rate limits, approval mode, bans and minors', () => {
  it('answers 429 once the comment budget is spent', async () => {
    const target = await post(aman, 'Comment target for the budget');
    let status = 0;
    for (let i = 0; i < 20 && status !== 429; i++) {
      status = (await call(rohit, 'POST', `/v1/member/engagement/feed/${target.id}/comment`, { body: `comment ${i}` })).status;
    }
    expect(status).toBe(429);
  });

  it('answers 429 once the post budget is spent', async () => {
    let status = 0;
    ageMyPosts();
    for (let i = 0; i < 8 && status !== 429; i++) status = (await post(rohit, `Post number ${i} in a burst`, true)).status;
    expect(status).toBe(429);
  });

  it('holds posts for a moderator in approval mode', async () => {
    expect((await call(owner, 'PATCH', '/v1/admin/settings/engagement', { communityApprovalMode: true })).status).toBe(200);
    try {
      const held = await post(aman, 'Waiting for approval please');
      expect(held).toMatchObject({ status: 201, awaitingApproval: true });
      expect((await feed(rohit)).some((p) => p.id === held.id)).toBe(false);
      expect((await feed(aman)).find((p) => p.id === held.id)?.moderationNote).toMatch(/^Waiting for a moderator/);

      const queue = (await (await call(manager, 'GET', '/v1/admin/community/approvals')).json()) as { approvalMode: boolean; items: Array<{ id: string }> };
      expect(queue.approvalMode).toBe(true);
      expect(queue.items.map((i) => i.id)).toContain(held.id);

      expect((await call(manager, 'POST', `/v1/admin/community/approvals/${held.id}`, { decision: 'approve' })).status).toBe(200);
      expect((await feed(rohit)).some((p) => p.id === held.id)).toBe(true);
      expect(notificationsFor(AMAN).some((n) => n.title === 'Your post is live')).toBe(true);

      const rejected = await post(aman, 'Another one to reject');
      expect((await call(manager, 'POST', `/v1/admin/community/approvals/${rejected.id}`, { decision: 'reject', reason: 'Off topic for the feed.' })).status).toBe(200);
      expect((await feed(rohit)).some((p) => p.id === rejected.id)).toBe(false);
      // Restore is for hidden or removed content; it does not publish around the queue.
      expect((await call(manager, 'POST', `/v1/admin/community/content/post/${rejected.id}`, { action: 'restore', reason: 'Trying a shortcut' })).status).toBe(409);
      expect((await feed(rohit)).some((p) => p.id === rejected.id)).toBe(false);
    } finally {
      await call(owner, 'PATCH', '/v1/admin/settings/engagement', { communityApprovalMode: false });
    }
  });

  it('stops a banned member posting and commenting until the ban is lifted', async () => {
    expect((await call(manager, 'POST', '/v1/admin/community/bans', { memberId: rohitId, reason: 'Repeated harassment reports' })).status).toBe(201);
    const refused = await call(rohit, 'POST', '/v1/member/engagement/feed', { body: 'Can I still post?', kind: 'text', visibility: 'branch' });
    expect(refused.status).toBe(403);
    const bans = (await (await call(manager, 'GET', '/v1/admin/community/bans')).json()) as { items: Array<{ memberId: string }> };
    expect(bans.items.map((b) => b.memberId)).toContain(rohitId);
    expect((await call(manager, 'DELETE', `/v1/admin/community/bans/${rohitId}`)).status).toBe(200);
    expect((await post(rohit, 'Back again after the ban')).status).toBe(201);
  });

  it('gives minors no public profile in the feed', async () => {
    db.update(schema.members).set({ dob: '2011-05-01' }).where(eq(schema.members.id, rohitId)).run();
    try {
      const minorPost = await post(rohit, 'Hit a new deadlift PR today');
      const seen = (await feed(aman)).find((p) => p.id === minorPost.id)!;
      expect(seen.authorName).toBe('A member');
      expect(seen.authorName).not.toContain('Rohit');
    } finally {
      db.update(schema.members).set({ dob: rohitDob }).where(eq(schema.members.id, rohitId)).run();
    }
  });
});
