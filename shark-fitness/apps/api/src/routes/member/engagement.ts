import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { channels } from '@shark/contracts';
import {
  computeStreak,
  fairScore,
  isRankable,
  levelFor,
  referralIsSuspicious,
  scanForSafety,
} from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { id } from '../../lib/ids.js';
import { DAY, HOUR, MINUTE, daysBetween, isoDate, now, relativeTime } from '../../lib/time.js';
import { conflict, forbidden, invalid, notFound, rateLimited } from '../../lib/errors.js';
import { requireBranch, type RequestContext } from '../../lib/context.js';

export const engagementRoutes = new Hono();

/**
 * Pack — challenges, community and referrals (UX-M10, UX-M11, PF-GAME).
 *
 * Two rules run through the whole file:
 *
 *   1. **Nothing is ranked unless `isRankable` says so.** Volume lifted and
 *      every body metric are absent from the rankable set on purpose
 *      (PF-GAME-004). A challenge configured on an unrankable metric still
 *      renders — it just has no leaderboard and says why, rather than quietly
 *      ranking people on how much they lifted.
 *   2. **Late joiners are compared on rate, not totals.** `fairScore` does that
 *      arithmetic; nothing here re-derives it.
 *
 * Community writes are rate limited per member, blocking is mutual and hides
 * content in both directions, and removed content leaves a visible tombstone
 * instead of silently disappearing (UX-M11 mandatory states).
 */

const FAIRNESS_NOTE =
  'Ranked on sessions attended. Volume lifted and body metrics are never ranked.';

/** Community write budgets. Deliberately generous for a person, tight for a bot. */
const POST_LIMIT = 5;
const POST_WINDOW_MS = HOUR;
const COMMENT_LIMIT = 15;
const COMMENT_WINDOW_MS = 10 * MINUTE;

const REFERRAL_TARGET = 3;

/* ============================================================================
   Shared helpers
   ========================================================================= */

interface Scope {
  member: typeof schema.members.$inferSelect;
  branchId: string;
  branchName: string;
  tz: string;
  today: string;
}

function scopeOf(ctx: RequestContext): Scope {
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, ctx.memberId!), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) throw notFound('Your membership');

  const branchId =
    ctx.activeBranchId && ctx.branchIds.includes(ctx.activeBranchId)
      ? ctx.activeBranchId
      : member.homeBranchId;
  requireBranch(ctx, branchId);

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, branchId)).get();
  const tz = branch?.timezone ?? 'Asia/Kolkata';
  return { member, branchId, branchName: branch?.name ?? '', tz, today: isoDate(now(), tz) };
}

/** Stable pseudonym for a private board entry. Derived from the id, never from
 *  the member number — a member number is identifying. */
function anonHandle(memberId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < memberId.length; i++) {
    hash ^= memberId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `Shark #${(Math.abs(hash) % 9000) + 1000}`;
}

/** Blocking is mutual: someone I blocked and someone who blocked me are both
 *  hidden from me. */
function blockSet(ctx: RequestContext): { hidden: Set<string>; iBlocked: Set<string> } {
  const rows = db
    .select()
    .from(schema.blocks)
    .where(
      and(
        eq(schema.blocks.tenantId, ctx.tenantId),
        or(eq(schema.blocks.memberId, ctx.memberId!), eq(schema.blocks.blockedMemberId, ctx.memberId!)),
      ),
    )
    .all();

  const hidden = new Set<string>();
  const iBlocked = new Set<string>();
  for (const row of rows) {
    if (row.memberId === ctx.memberId) {
      hidden.add(row.blockedMemberId);
      iBlocked.add(row.blockedMemberId);
    } else {
      hidden.add(row.memberId);
    }
  }
  return { hidden, iBlocked };
}

interface Person {
  id: string;
  name: string;
  initials: string;
}

function peopleByIds(tenantId: string, ids: string[]): Map<string, Person> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = db
    .select({
      id: schema.members.id,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      initials: schema.members.initials,
    })
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenantId), inArray(schema.members.id, unique)))
    .all();
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, name: `${r.firstName} ${r.lastName.slice(0, 1)}.`.trim(), initials: r.initials },
    ]),
  );
}

/* — Challenges ————————————————————————————————————————————— */

type ChallengeRow = typeof schema.challenges.$inferSelect;
type ParticipantRow = typeof schema.challengeParticipants.$inferSelect;

interface ScoredParticipant {
  row: ParticipantRow;
  score: number;
  daysParticipated: number;
}

function scoreParticipants(
  challenge: ChallengeRow,
  participants: ParticipantRow[],
  scope: Scope,
): { scored: ScoredParticipant[]; totalDays: number; daysElapsed: number; daysLeft: number } {
  const totalDays = Math.max(1, daysBetween(challenge.startsOn, challenge.endsOn) + 1);
  const elapsed = daysBetween(challenge.startsOn, scope.today) + 1;
  const daysElapsed = Math.max(1, Math.min(totalDays, elapsed));
  const daysLeft = Math.max(0, daysBetween(scope.today, challenge.endsOn));

  const scored = participants.map((row) => {
    const joinedOn = isoDate(row.joinedAt, scope.tz);
    const from = joinedOn > challenge.startsOn ? joinedOn : challenge.startsOn;
    const daysParticipated = Math.max(1, Math.min(daysElapsed, daysBetween(from, scope.today) + 1));
    // Rate carried across the elapsed window. Joining on day 20 is not a loss,
    // joining on day 1 is not a win.
    return {
      row,
      daysParticipated,
      score: fairScore({ rawCount: row.rawCount, daysParticipated, daysElapsed }),
    };
  });

  return { scored, totalDays, daysElapsed, daysLeft };
}

function rankOrder(a: ScoredParticipant, b: ScoredParticipant): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.row.rawCount !== a.row.rawCount) return b.row.rawCount - a.row.rawCount;
  return a.row.joinedAt - b.row.joinedAt;
}

interface BoardRow {
  rank: number;
  memberId: string | null;
  displayName: string;
  initials: string;
  score: number;
  rawCount: number;
  isYou: boolean;
  isPrivate: boolean;
  isBlocked: boolean;
  teamId: string | null;
  flagged: boolean;
}

function buildBoard(
  ctx: RequestContext,
  scored: ScoredParticipant[],
  hidden: Set<string>,
): BoardRow[] {
  const ordered = [...scored].sort(rankOrder);
  const people = peopleByIds(
    ctx.tenantId,
    ordered.filter((s) => !s.row.anonymous && !hidden.has(s.row.memberId)).map((s) => s.row.memberId),
  );

  return ordered.map((entry, index) => {
    const isYou = entry.row.memberId === ctx.memberId;
    const isBlocked = !isYou && hidden.has(entry.row.memberId);
    const isPrivate = !isYou && entry.row.anonymous;
    const person = people.get(entry.row.memberId);

    const displayName = isYou
      ? 'You'
      : isBlocked
        ? 'Blocked member'
        : isPrivate
          ? anonHandle(entry.row.memberId)
          : (person?.name ?? anonHandle(entry.row.memberId));

    return {
      rank: index + 1,
      // A private or blocked row never carries the id back to the client.
      memberId: isYou || (!isPrivate && !isBlocked) ? entry.row.memberId : null,
      displayName,
      initials: isYou ? 'YOU' : isBlocked ? '··' : isPrivate ? '##' : (person?.initials ?? '··'),
      score: Math.round(entry.score),
      rawCount: isPrivate || isBlocked ? 0 : entry.row.rawCount,
      isYou,
      isPrivate,
      isBlocked,
      teamId: entry.row.teamId,
      flagged: entry.row.flagged,
    };
  });
}

const TEAM_NAMES: Record<string, string> = {
  team_reef: 'Reef',
  team_trench: 'Trench',
  team_depot: 'Depot',
};

function summariseChallenge(ctx: RequestContext, challenge: ChallengeRow, scope: Scope) {
  const participants = db
    .select()
    .from(schema.challengeParticipants)
    .where(
      and(
        eq(schema.challengeParticipants.tenantId, ctx.tenantId),
        eq(schema.challengeParticipants.challengeId, challenge.id),
      ),
    )
    .all();

  const { scored, totalDays, daysElapsed, daysLeft } = scoreParticipants(challenge, participants, scope);
  const ranked = isRankable(challenge.metric);

  const mine = scored.find((s) => s.row.memberId === ctx.memberId) ?? null;
  const ordered = ranked ? [...scored].sort(rankOrder) : [];
  const myRank = mine && ranked ? ordered.findIndex((s) => s.row.memberId === ctx.memberId) + 1 : null;

  const myTeam = mine?.row.teamId ?? null;
  const teamMembers = myTeam ? participants.filter((p) => p.teamId === myTeam) : participants;
  const teamProgress = challenge.teamMode
    ? teamMembers.reduce((total, p) => total + p.rawCount, 0)
    : null;

  const joinedLate = mine ? isoDate(mine.row.joinedAt, scope.tz) > challenge.startsOn : false;

  const lateJoinNote =
    daysLeft === 0
      ? null
      : mine
        ? joinedLate
          ? `You joined on day ${totalDays - daysBetween(isoDate(mine.row.joinedAt, scope.tz), challenge.endsOn)} of ${totalDays}. Your score is your rate carried across the whole challenge, so the late start is not held against you.`
          : null
        : daysElapsed > 1
          ? `This is day ${daysElapsed} of ${totalDays}. Scores compare rate, not totals, so joining now still gives you a fair result.`
          : null;

  return {
    id: challenge.id,
    name: challenge.name,
    description: challenge.description,
    metric: challenge.metric,
    metricLabel: challenge.metricLabel,
    /** The gate. False means this challenge is shown but never ranked. */
    ranked,
    unrankedReason: ranked
      ? null
      : 'This challenge is not ranked. Volume lifted and body metrics are never put on a leaderboard.',
    fairnessNote: FAIRNESS_NOTE,
    startsOn: challenge.startsOn,
    endsOn: challenge.endsOn,
    totalDays,
    daysElapsed,
    daysLeft,
    branchId: challenge.branchId,
    visibility: challenge.visibility,
    teamMode: challenge.teamMode,
    teamId: myTeam,
    teamName: myTeam ? (TEAM_NAMES[myTeam] ?? 'Your squad') : null,
    teamTarget: challenge.teamTarget,
    teamProgress,
    teamShort:
      challenge.teamTarget !== null && teamProgress !== null
        ? Math.max(0, challenge.teamTarget - teamProgress)
        : null,
    teamProgressPct:
      challenge.teamTarget && teamProgress !== null
        ? Math.min(100, Math.round((teamProgress / challenge.teamTarget) * 100))
        : null,
    participantCount: participants.length,
    joined: mine !== null,
    anonymous: mine?.row.anonymous ?? false,
    myScore: mine ? Math.round(mine.score) : null,
    myRawCount: mine?.row.rawCount ?? null,
    myRank,
    rules: challenge.rules,
    rewardLabel: challenge.rewardLabel,
    lateJoinNote,
    closed: daysLeft === 0 && scope.today > challenge.endsOn,
    scored,
  };
}

function activeChallenges(ctx: RequestContext, scope: Scope): ChallengeRow[] {
  return db
    .select()
    .from(schema.challenges)
    .where(
      and(
        eq(schema.challenges.tenantId, ctx.tenantId),
        gte(schema.challenges.endsOn, scope.today),
        sql`${schema.challenges.visibility} != 'private'`,
        or(
          sql`${schema.challenges.branchId} is null`,
          inArray(schema.challenges.branchId, ctx.branchIds.length ? ctx.branchIds : ['']),
        ),
      ),
    )
    .orderBy(schema.challenges.endsOn)
    .all();
}

/* — Referrals ————————————————————————————————————————————— */

function referralState(ctx: RequestContext, scope: Scope) {
  const rows = db
    .select()
    .from(schema.referrals)
    .where(and(eq(schema.referrals.tenantId, ctx.tenantId), eq(schema.referrals.memberId, ctx.memberId!)))
    .orderBy(schema.referrals.createdAt)
    .all();

  // One code per member. The oldest row carries it; later rows reuse it.
  const code = rows[0]?.code ?? `${scope.member.firstName.replace(/[^a-z]/gi, '').slice(0, 5).toUpperCase()}-0000`;

  // Anti-fraud: same-device clusters and burst sign-ups (PF-GAME-006). The
  // decision itself is the domain rule's, not this route's.
  const invitees = rows.map((row) => {
    const sameDevice = row.deviceFingerprint
      ? rows.filter((r) => r.deviceFingerprint === row.deviceFingerprint)
      : [row];
    const nearest = sameDevice
      .filter((r) => r.id !== row.id)
      .reduce<number>(
        (min, r) => Math.min(min, Math.abs(r.createdAt - row.createdAt) / MINUTE),
        Number.POSITIVE_INFINITY,
      );

    const verdict = referralIsSuspicious({
      sameDeviceCount: sameDevice.length,
      joinedWithinMinutes: Number.isFinite(nearest) ? Math.round(nearest) : 10_000,
      sharedPaymentInstrument: (row.suspiciousReason ?? '').toLowerCase().includes('payment'),
    });

    const expired = row.expiresOn !== null && row.expiresOn < scope.today && row.state !== 'joined';

    return {
      id: row.id,
      name: row.inviteeName ?? 'A friend',
      contactHint: maskContact(row.inviteeContact),
      state: expired ? 'expired' : row.state,
      at: new Date(row.createdAt).toISOString(),
      relativeTime: relativeTime(row.createdAt),
      rewardMinor: row.rewardMinor,
      rewardPaid: row.rewardPaidAt !== null,
      rewardPaidAt: row.rewardPaidAt ? new Date(row.rewardPaidAt).toISOString() : null,
      expiresOn: row.expiresOn,
      suspicious: verdict.suspicious,
      suspiciousReason: row.suspiciousReason ?? verdict.reason,
    };
  });

  const joined = invitees.filter((i) => i.state === 'joined');
  const pending = joined.filter((i) => !i.rewardPaid && !i.suspicious);
  const held = joined.filter((i) => i.suspicious && !i.rewardPaid);

  return {
    code,
    target: REFERRAL_TARGET,
    invited: invitees.length,
    joined: joined.length,
    pendingRewardMinor: pending.reduce((total, i) => total + i.rewardMinor, 0),
    earnedRewardMinor: joined.filter((i) => i.rewardPaid).reduce((total, i) => total + i.rewardMinor, 0),
    heldRewardMinor: held.reduce((total, i) => total + i.rewardMinor, 0),
    expiresOn: rows.find((r) => r.expiresOn)?.expiresOn ?? null,
    invitees,
    shareMessage: `Train with me at Shark Fitness ${scope.branchName}. Use my code ${code} when you join and we both get credit.`,
    /** Plain register: this is money, so it never uses the predator voice. */
    rewardNote:
      'Credit lands once your friend joins and their first payment clears. Sign-ups that look automated are held for a human to check.',
  };
}

function maskContact(contact: string | null): string | null {
  if (!contact) return null;
  if (contact.includes('@')) {
    const [local, domain] = contact.split('@');
    return `${(local ?? '').slice(0, 2)}···@${domain ?? ''}`;
  }
  return `···${contact.replace(/\D/g, '').slice(-4)}`;
}

/* — Community ————————————————————————————————————————————— */

function postBudget(ctx: RequestContext) {
  const since = now() - POST_WINDOW_MS;
  const rows = db
    .select({ createdAt: schema.posts.createdAt })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.tenantId, ctx.tenantId),
        eq(schema.posts.memberId, ctx.memberId!),
        gte(schema.posts.createdAt, since),
      ),
    )
    .all();

  const oldest = rows.length ? Math.min(...rows.map((r) => r.createdAt)) : null;
  return {
    max: POST_LIMIT,
    used: rows.length,
    remaining: Math.max(0, POST_LIMIT - rows.length),
    windowLabel: 'an hour',
    retryAfterSec: oldest ? Math.max(1, Math.ceil((oldest + POST_WINDOW_MS - now()) / 1000)) : 0,
  };
}

function commentBudget(ctx: RequestContext) {
  const since = now() - COMMENT_WINDOW_MS;
  const rows = db
    .select({ createdAt: schema.comments.createdAt })
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.tenantId, ctx.tenantId),
        eq(schema.comments.memberId, ctx.memberId!),
        gte(schema.comments.createdAt, since),
      ),
    )
    .all();

  const oldest = rows.length ? Math.min(...rows.map((r) => r.createdAt)) : null;
  return {
    max: COMMENT_LIMIT,
    used: rows.length,
    remaining: Math.max(0, COMMENT_LIMIT - rows.length),
    retryAfterSec: oldest ? Math.max(1, Math.ceil((oldest + COMMENT_WINDOW_MS - now()) / 1000)) : 0,
  };
}

type PostRow = typeof schema.posts.$inferSelect;

function serialisePost(
  ctx: RequestContext,
  post: PostRow,
  people: Map<string, Person>,
  staffNames: Map<string, string>,
  kudosByMe: Set<string>,
  comments: Array<typeof schema.comments.$inferSelect>,
  iBlocked: Set<string>,
) {
  const removed = post.state === 'removed' || post.deletedAt !== null;
  const author = post.memberId ? people.get(post.memberId) : null;
  const staffName = post.staffId ? staffNames.get(post.staffId) : null;
  const mine = post.memberId !== null && post.memberId === ctx.memberId;

  const authorName =
    post.authorKind === 'gym'
      ? 'Shark Fitness'
      : post.authorKind === 'staff'
        ? (staffName ?? 'Gym team')
        : mine
          ? 'You'
          : (author?.name ?? 'A member');

  const postComments = comments
    .filter((cm) => cm.postId === post.id)
    .filter((cm) => !iBlocked.has(cm.memberId))
    .map((cm) => ({
      id: cm.id,
      postId: cm.postId,
      authorId: cm.memberId === ctx.memberId ? cm.memberId : (people.get(cm.memberId)?.id ?? null),
      authorName: cm.memberId === ctx.memberId ? 'You' : (people.get(cm.memberId)?.name ?? 'A member'),
      authorInitials: people.get(cm.memberId)?.initials ?? '··',
      body: cm.state === 'removed' ? '' : cm.body,
      state: cm.state,
      removed: cm.state === 'removed',
      createdAt: new Date(cm.createdAt).toISOString(),
      relativeTime: relativeTime(cm.createdAt),
      canDelete: cm.memberId === ctx.memberId,
      canReport: cm.memberId !== ctx.memberId && cm.state !== 'removed',
    }));

  return {
    id: post.id,
    authorId: post.authorKind === 'member' && !mine ? (author?.id ?? null) : null,
    authorName,
    authorInitials:
      post.authorKind === 'gym' ? 'SF' : mine ? 'YOU' : (author?.initials ?? staffInitials(staffName)),
    authorKind: post.authorKind,
    isMine: mine,
    kind: post.kind,
    badge: post.badge,
    body: removed ? '' : post.body,
    removed,
    /** A removed post leaves a tombstone. Content never silently disappears. */
    removedNote: removed ? 'This post was removed after a moderation review.' : null,
    underReview: post.state === 'flagged',
    state: post.state,
    visibility: post.visibility,
    createdAt: new Date(post.createdAt).toISOString(),
    relativeTime: relativeTime(post.createdAt),
    kudos: post.kudosCount,
    kudosByMe: kudosByMe.has(post.id),
    commentCount: post.commentCount,
    comments: postComments,
    canReport: !removed && !mine && post.authorKind === 'member',
    canBlock: !mine && post.authorKind === 'member' && post.memberId !== null,
    canDelete: mine && !removed,
    canComment: !removed,
  };
}

function staffInitials(name: string | null | undefined): string {
  if (!name) return 'SF';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? 'S') + (parts.at(-1)?.[0] ?? 'F')).toUpperCase();
}

function feedFor(ctx: RequestContext, scope: Scope, limit: number) {
  const { hidden, iBlocked } = blockSet(ctx);

  const rows = db
    .select()
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.tenantId, ctx.tenantId),
        or(
          eq(schema.posts.branchId, scope.branchId),
          sql`${schema.posts.visibility} = 'tenant'`,
        ),
        sql`${schema.posts.visibility} != 'private'`,
      ),
    )
    .orderBy(desc(schema.posts.createdAt))
    .limit(limit)
    .all()
    .filter((post) => !(post.memberId && hidden.has(post.memberId)));

  const postIds = rows.map((p) => p.id);

  const comments = postIds.length
    ? db
        .select()
        .from(schema.comments)
        .where(and(eq(schema.comments.tenantId, ctx.tenantId), inArray(schema.comments.postId, postIds)))
        .orderBy(schema.comments.createdAt)
        .all()
        .filter((cm) => !hidden.has(cm.memberId))
    : [];

  const kudos = postIds.length
    ? new Set(
        db
          .select({ postId: schema.reactions.postId })
          .from(schema.reactions)
          .where(
            and(
              eq(schema.reactions.memberId, ctx.memberId!),
              inArray(schema.reactions.postId, postIds),
            ),
          )
          .all()
          .map((r) => r.postId),
      )
    : new Set<string>();

  const people = peopleByIds(ctx.tenantId, [
    ...rows.map((p) => p.memberId ?? ''),
    ...comments.map((cm) => cm.memberId),
  ]);

  const staffIds = [...new Set(rows.map((p) => p.staffId).filter((s): s is string => Boolean(s)))];
  const staffNames = new Map<string, string>(
    staffIds.length
      ? db
          .select({ staffId: schema.staff.id, name: schema.users.name })
          .from(schema.staff)
          .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
          .where(inArray(schema.staff.id, staffIds))
          .all()
          .map((r) => [r.staffId, r.name] as const)
      : [],
  );

  return {
    items: rows.map((post) =>
      serialisePost(ctx, post, people, staffNames, kudos, comments, iBlocked),
    ),
    blockedCount: iBlocked.size,
  };
}

/* ============================================================================
   GET /  — the Pack overview
   ========================================================================= */

engagementRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);

  /* — XP and level ————————————————————————————————————————— */

  const xpTotal =
    db
      .select({ total: sql<number>`coalesce(sum(${schema.xpLedger.delta}), 0)` })
      .from(schema.xpLedger)
      .where(and(eq(schema.xpLedger.tenantId, ctx.tenantId), eq(schema.xpLedger.memberId, ctx.memberId!)))
      .get()?.total ?? 0;

  const level = levelFor(xpTotal);

  const xpRecent = db
    .select()
    .from(schema.xpLedger)
    .where(and(eq(schema.xpLedger.tenantId, ctx.tenantId), eq(schema.xpLedger.memberId, ctx.memberId!)))
    .orderBy(desc(schema.xpLedger.at))
    .limit(6)
    .all()
    .map((row) => ({
      id: row.id,
      delta: row.delta,
      reason: row.reason.replace(/_/g, ' '),
      at: new Date(row.at).toISOString(),
      relativeTime: relativeTime(row.at),
      isCorrection: row.isCorrection,
    }));

  /* — Streak ————————————————————————————————————————————— */

  const sessionDates = db
    .select({ startedAt: schema.workouts.startedAt })
    .from(schema.workouts)
    .where(
      and(
        eq(schema.workouts.memberId, ctx.memberId!),
        eq(schema.workouts.state, 'completed'),
      ),
    )
    .orderBy(desc(schema.workouts.startedAt))
    .limit(180)
    .all()
    .map((r) => isoDate(r.startedAt, scope.tz));

  const streakRow = db
    .select()
    .from(schema.streaksTable)
    .where(eq(schema.streaksTable.memberId, ctx.memberId!))
    .get();

  const weeklyTarget = streakRow?.weeklyTarget ?? 4;
  const restDaysAllowed = streakRow?.restDaysAllowed ?? 2;
  const streak = computeStreak({
    sessionDates,
    today: scope.today,
    weeklyTarget,
    restDaysAllowed,
  });

  /* — Achievements ————————————————————————————————————————— */

  const sessionCount = sessionDates.length;

  const prCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.personalRecords)
      .where(
        and(
          eq(schema.personalRecords.memberId, ctx.memberId!),
          sql`${schema.personalRecords.retiredAt} is null`,
        ),
      )
      .get()?.n ?? 0;

  const classCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.bookings)
      .where(
        and(
          eq(schema.bookings.memberId, ctx.memberId!),
          sql`${schema.bookings.attendedAt} is not null`,
        ),
      )
      .get()?.n ?? 0;

  const habitDays =
    db
      .select({ n: sql<number>`count(distinct ${schema.habitLogs.onDate})` })
      .from(schema.habitLogs)
      .where(eq(schema.habitLogs.memberId, ctx.memberId!))
      .get()?.n ?? 0;

  const referral = referralState(ctx, scope);

  const earlyCount = db
    .select({ startedAt: schema.workouts.startedAt })
    .from(schema.workouts)
    .where(and(eq(schema.workouts.memberId, ctx.memberId!), eq(schema.workouts.state, 'completed')))
    .all()
    .filter((r) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: scope.tz, hour: '2-digit', hour12: false }).format(r.startedAt)) < 7).length;

  const PROGRESS: Record<string, { have: number; need: number }> = {
    first_session: { have: sessionCount, need: 1 },
    ten_sessions: { have: sessionCount, need: 10 },
    fifty_sessions: { have: sessionCount, need: 50 },
    hundred_sessions: { have: sessionCount, need: 100 },
    first_pr: { have: prCount, need: 1 },
    four_week_streak: { have: Math.min(4, Math.floor(streak.longest / Math.max(1, weeklyTarget))), need: 4 },
    class_regular: { have: classCount, need: 20 },
    habit_month: { have: habitDays, need: 30 },
    first_referral: { have: referral.joined, need: 1 },
    early_bird: { have: earlyCount, need: 20 },
  };

  const earned = new Map(
    db
      .select()
      .from(schema.memberAchievements)
      .where(
        and(
          eq(schema.memberAchievements.tenantId, ctx.tenantId),
          eq(schema.memberAchievements.memberId, ctx.memberId!),
        ),
      )
      .all()
      .map((r) => [r.achievementId, r.earnedAt] as const),
  );

  const achievements = db
    .select()
    .from(schema.achievements)
    .all()
    .map((a) => {
      const earnedAt = earned.get(a.id) ?? null;
      const p = PROGRESS[a.code] ?? { have: 0, need: 1 };
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        description: a.description,
        tier: a.tier,
        earned: earnedAt !== null,
        earnedAt: earnedAt ? new Date(earnedAt).toISOString() : null,
        relativeTime: earnedAt ? relativeTime(earnedAt) : null,
        progressPct: earnedAt ? 100 : Math.min(99, Math.round((p.have / p.need) * 100)),
        progressLabel: earnedAt ? 'Earned' : `${Math.min(p.have, p.need)} of ${p.need}`,
      };
    })
    .sort((a, b) => Number(b.earned) - Number(a.earned) || b.progressPct - a.progressPct);

  /* — Challenges ————————————————————————————————————————— */

  const { hidden } = blockSet(ctx);

  const challenges = activeChallenges(ctx, scope).map((row) => {
    const summary = summariseChallenge(ctx, row, scope);
    const { scored, ...rest } = summary;
    return {
      ...rest,
      board: summary.ranked ? buildBoard(ctx, scored, hidden).slice(0, 5) : [],
    };
  });

  const primary =
    challenges.find((ch) => ch.joined) ?? challenges[0] ?? null;

  const primaryBoard = primary
    ? (() => {
        const row = activeChallenges(ctx, scope).find((ch) => ch.id === primary.id);
        if (!row) return [];
        const summary = summariseChallenge(ctx, row, scope);
        if (!summary.ranked) return [];
        const full = buildBoard(ctx, summary.scored, hidden);
        const top = full.slice(0, 4);
        const you = full.find((r) => r.isYou);
        return you && !top.some((r) => r.isYou) ? [...top, you] : top;
      })()
    : [];

  return c.json({
    member: {
      id: scope.member.id,
      firstName: scope.member.firstName,
      initials: scope.member.initials,
      memberNo: scope.member.memberNo,
    },
    branch: { id: scope.branchId, name: scope.branchName },
    today: scope.today,
    fairnessNote: FAIRNESS_NOTE,
    level: {
      level: level.level,
      name: level.name,
      xp: level.xp,
      xpIntoLevel: level.xpIntoLevel,
      xpForNextLevel: level.xpForNextLevel,
      progressPct: level.progressPct,
      nextName: level.nextName,
    },
    xpRecent,
    streak: {
      current: streak.current,
      longest: streak.longest,
      thisWeek: streak.thisWeek,
      weeklyTarget,
      restDaysAllowed,
      lastSessionOn: streak.lastSessionOn,
      week: streak.week,
      atRisk: streak.atRisk,
      /** Streaks never punish illness — the allowance is stated, not hidden. */
      restNote: `Rest is part of the plan. You can miss ${restDaysAllowed} days without breaking the streak.`,
    },
    achievements,
    achievementsEarned: achievements.filter((a) => a.earned).length,
    achievementsTotal: achievements.length,
    challenges,
    primaryChallengeId: primary?.id ?? null,
    primaryBoard,
    referral,
    community: {
      blockedCount: blockSet(ctx).iBlocked.size,
      postBudget: postBudget(ctx),
    },
  });
});

/* ============================================================================
   Challenge detail
   ========================================================================= */

function loadChallenge(ctx: RequestContext, challengeId: string): ChallengeRow {
  const challenge = db
    .select()
    .from(schema.challenges)
    .where(and(eq(schema.challenges.id, challengeId), eq(schema.challenges.tenantId, ctx.tenantId)))
    .get();
  if (!challenge) throw notFound('That challenge');
  if (challenge.branchId && !ctx.branchIds.includes(challenge.branchId)) {
    throw forbidden('That challenge belongs to a branch you are not a member of.');
  }
  return challenge;
}

engagementRoutes.get('/challenge/:id', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const challenge = loadChallenge(ctx, c.req.param('id'));

  const summary = summariseChallenge(ctx, challenge, scope);
  const { scored, ...rest } = summary;
  const { hidden } = blockSet(ctx);

  // The refusal, made explicit: an unrankable metric gets no board at all.
  const board = summary.ranked ? buildBoard(ctx, scored, hidden) : [];

  const teams = challenge.teamMode
    ? Object.entries(
        scored.reduce<Record<string, { rawCount: number; members: number }>>((acc, entry) => {
          const key = entry.row.teamId ?? 'unassigned';
          acc[key] ??= { rawCount: 0, members: 0 };
          acc[key]!.rawCount += entry.row.rawCount;
          acc[key]!.members += 1;
          return acc;
        }, {}),
      )
        .map(([teamId, agg]) => ({
          teamId,
          name: TEAM_NAMES[teamId] ?? 'Unassigned',
          rawCount: agg.rawCount,
          members: agg.members,
          isMine: teamId === summary.teamId,
          pct: challenge.teamTarget
            ? Math.min(100, Math.round((agg.rawCount / challenge.teamTarget) * 100))
            : null,
        }))
        .sort((a, b) => b.rawCount - a.rawCount)
    : [];

  return c.json({
    challenge: rest,
    board,
    you: board.find((r) => r.isYou) ?? null,
    teams,
    fairnessNote: FAIRNESS_NOTE,
    privacyNote:
      'Private mode keeps your place on the board and replaces your name with a Shark number. Nobody, including staff, sees a different ranking.',
  });
});

engagementRoutes.post('/challenge/:id/join', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const challenge = loadChallenge(ctx, c.req.param('id'));

  if (challenge.endsOn < scope.today) {
    throw conflict('That challenge has already finished.');
  }

  const existing = db
    .select()
    .from(schema.challengeParticipants)
    .where(
      and(
        eq(schema.challengeParticipants.challengeId, challenge.id),
        eq(schema.challengeParticipants.memberId, ctx.memberId!),
      ),
    )
    .get();
  if (existing) throw conflict('You are already in this challenge.');

  const participantId = id('chp');

  transact(() => {
    // Sessions already logged inside the window count from the start — a member
    // is not asked to redo work they have done.
    const rawCount =
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.workouts)
        .where(
          and(
            eq(schema.workouts.memberId, ctx.memberId!),
            eq(schema.workouts.state, 'completed'),
            gte(schema.workouts.startedAt, Date.parse(`${challenge.startsOn}T00:00:00Z`)),
          ),
        )
        .get()?.n ?? 0;

    db.insert(schema.challengeParticipants)
      .values({
        id: participantId,
        tenantId: ctx.tenantId,
        challengeId: challenge.id,
        memberId: ctx.memberId!,
        teamId: challenge.teamMode ? smallestTeam(challenge.id) : null,
        rawCount,
        score: rawCount,
        joinedAt: now(),
        anonymous: false,
        flagged: false,
      })
      .run();

    audit(ctx, {
      action: 'challenge.joined',
      entityType: 'challenge',
      entityId: challenge.id,
      entityLabel: challenge.name,
      branchId: challenge.branchId,
      after: { memberId: ctx.memberId, rawCount },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: challenge.branchId,
      channel: channels.branch(challenge.branchId ?? scope.branchId),
      topic: 'challenge.score_changed',
      payload: { challengeId: challenge.id, memberId: ctx.memberId, joined: true },
    });
  });

  const summary = summariseChallenge(ctx, challenge, scope);
  const { scored, ...rest } = summary;
  void scored;
  return c.json({ ok: true, challenge: rest });
});

function smallestTeam(challengeId: string): string {
  const counts = db
    .select({ teamId: schema.challengeParticipants.teamId, n: sql<number>`count(*)` })
    .from(schema.challengeParticipants)
    .where(eq(schema.challengeParticipants.challengeId, challengeId))
    .groupBy(schema.challengeParticipants.teamId)
    .all();

  const known = ['team_reef', 'team_trench', 'team_depot'];
  const sized = known.map((teamId) => ({
    teamId,
    n: counts.find((r) => r.teamId === teamId)?.n ?? 0,
  }));
  sized.sort((a, b) => a.n - b.n);
  return sized[0]?.teamId ?? 'team_reef';
}

engagementRoutes.delete('/challenge/:id/leave', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const challenge = loadChallenge(ctx, c.req.param('id'));

  const existing = db
    .select()
    .from(schema.challengeParticipants)
    .where(
      and(
        eq(schema.challengeParticipants.challengeId, challenge.id),
        eq(schema.challengeParticipants.memberId, ctx.memberId!),
      ),
    )
    .get();
  if (!existing) throw notFound('Your place in that challenge');

  transact(() => {
    db.delete(schema.challengeParticipants)
      .where(eq(schema.challengeParticipants.id, existing.id))
      .run();

    audit(ctx, {
      action: 'challenge.left',
      entityType: 'challenge',
      entityId: challenge.id,
      entityLabel: challenge.name,
      branchId: challenge.branchId,
      before: { memberId: ctx.memberId, rawCount: existing.rawCount },
      after: null,
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: challenge.branchId,
      channel: channels.branch(challenge.branchId ?? scope.branchId),
      topic: 'challenge.score_changed',
      payload: { challengeId: challenge.id, memberId: ctx.memberId, joined: false },
    });
  });

  return c.json({
    ok: true,
    message: 'You are out of this challenge. Your sessions still count everywhere else, and you can rejoin before it ends.',
  });
});

/** Privacy mode for a board entry (PF-GAME-003). The rank is unchanged; only
 *  the name shown to other members is. */
engagementRoutes.patch(
  '/challenge/:id/privacy',
  validate('json', z.object({ anonymous: z.boolean() })),
  (c) => {
    const ctx = ctxOf(c);
    const scope = scopeOf(ctx);
    const challenge = loadChallenge(ctx, c.req.param('id'));
    const { anonymous } = c.req.valid('json');

    const existing = db
      .select()
      .from(schema.challengeParticipants)
      .where(
        and(
          eq(schema.challengeParticipants.challengeId, challenge.id),
          eq(schema.challengeParticipants.memberId, ctx.memberId!),
        ),
      )
      .get();
    if (!existing) throw notFound('Your place in that challenge');

    transact(() => {
      db.update(schema.challengeParticipants)
        .set({ anonymous })
        .where(eq(schema.challengeParticipants.id, existing.id))
        .run();

      audit(ctx, {
        action: 'challenge.privacy_changed',
        entityType: 'challenge_participant',
        entityId: existing.id,
        entityLabel: challenge.name,
        branchId: challenge.branchId,
        before: { anonymous: existing.anonymous },
        after: { anonymous },
      });
    });

    void scope;
    return c.json({
      ok: true,
      anonymous,
      displayName: anonymous ? anonHandle(ctx.memberId!) : 'You',
      message: anonymous
        ? `Other members now see you as ${anonHandle(ctx.memberId!)}. Your rank does not change.`
        : 'Your name is back on the board.',
    });
  },
);

/* ============================================================================
   Community feed
   ========================================================================= */

engagementRoutes.get('/feed', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 25)));

  const feed = feedFor(ctx, scope, limit);
  const budget = postBudget(ctx);

  return c.json({
    branch: { id: scope.branchId, name: scope.branchName },
    items: feed.items,
    blockedCount: feed.blockedCount,
    postBudget: budget,
    canPost: budget.remaining > 0,
    guidelines:
      'Posts are visible to members at this branch. Report anything unsafe or unkind — a human reads every report.',
  });
});

const PostInput = z.object({
  body: z.string().trim().min(3).max(600),
  kind: z.enum(['text', 'pr', 'workout']).default('text'),
  visibility: z.enum(['private', 'team', 'branch', 'tenant']).default('branch'),
});

engagementRoutes.post('/feed', validate('json', PostInput), (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const input = c.req.valid('json');

  const budget = postBudget(ctx);
  if (budget.remaining <= 0) {
    // A rate limit is a plain, honest statement, not a telling-off.
    throw rateLimited(budget.retryAfterSec || 60);
  }

  // Safety scan is the domain's, not this route's. A post that mentions injury
  // or distress is still published, but it is routed to a human as well.
  const signals = scanForSafety(input.body);
  const needsReview = signals.some((s) => s.action !== 'block_automation');

  const postId = id('pst');

  transact(() => {
    db.insert(schema.posts)
      .values({
        id: postId,
        tenantId: ctx.tenantId,
        branchId: scope.branchId,
        memberId: ctx.memberId!,
        staffId: null,
        authorKind: 'member',
        kind: input.kind,
        body: input.body,
        badge: input.kind === 'pr' ? 'PR' : null,
        refType: null,
        refId: null,
        visibility: input.visibility,
        state: needsReview ? 'flagged' : 'visible',
        kudosCount: 0,
        commentCount: 0,
        createdAt: now(),
        deletedAt: null,
      })
      .run();

    if (needsReview) {
      db.insert(schema.contentReports)
        .values({
          id: id('rep'),
          tenantId: ctx.tenantId,
          targetType: 'post',
          targetId: postId,
          reporterId: ctx.memberId!,
          reason: 'other',
          note: signals.map((s) => s.note).join(' '),
          state: 'open',
          resolvedById: null,
          resolution: null,
          createdAt: now(),
        })
        .run();
    }

    emit({
      tenantId: ctx.tenantId,
      branchId: scope.branchId,
      channel: channels.branch(scope.branchId),
      topic: 'post.created',
      payload: { postId, authorKind: 'member' },
    });
  });

  const created = db.select().from(schema.posts).where(eq(schema.posts.id, postId)).get()!;
  const people = peopleByIds(ctx.tenantId, [ctx.memberId!]);

  return c.json(
    {
      ok: true,
      post: serialisePost(ctx, created, people, new Map(), new Set(), [], new Set()),
      postBudget: postBudget(ctx),
      safetyNote: signals.length
        ? 'Thanks for saying it. Someone from the gym team will read this and get in touch — nothing automated replies to a message like this.'
        : null,
    },
    201,
  );
});

engagementRoutes.post('/feed/:id/kudos', (c) => {
  const ctx = ctxOf(c);
  const postId = c.req.param('id');

  const post = db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.id, postId), eq(schema.posts.tenantId, ctx.tenantId)))
    .get();
  if (!post) throw notFound('That post');
  if (post.state === 'removed' || post.deletedAt) throw conflict('That post is no longer available.');

  const already = db
    .select()
    .from(schema.reactions)
    .where(and(eq(schema.reactions.postId, postId), eq(schema.reactions.memberId, ctx.memberId!)))
    .get();

  if (!already) {
    transact(() => {
      db.insert(schema.reactions)
        .values({
          id: id('rct'),
          tenantId: ctx.tenantId,
          postId,
          memberId: ctx.memberId!,
          kind: 'kudos',
          at: now(),
        })
        .run();
      db.update(schema.posts)
        .set({ kudosCount: post.kudosCount + 1 })
        .where(eq(schema.posts.id, postId))
        .run();
    });
  }

  const fresh = db.select().from(schema.posts).where(eq(schema.posts.id, postId)).get();
  return c.json({ ok: true, kudos: fresh?.kudosCount ?? post.kudosCount, kudosByMe: true });
});

engagementRoutes.delete('/feed/:id/kudos', (c) => {
  const ctx = ctxOf(c);
  const postId = c.req.param('id');

  const post = db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.id, postId), eq(schema.posts.tenantId, ctx.tenantId)))
    .get();
  if (!post) throw notFound('That post');

  const existing = db
    .select()
    .from(schema.reactions)
    .where(and(eq(schema.reactions.postId, postId), eq(schema.reactions.memberId, ctx.memberId!)))
    .get();

  if (existing) {
    transact(() => {
      db.delete(schema.reactions).where(eq(schema.reactions.id, existing.id)).run();
      db.update(schema.posts)
        .set({ kudosCount: Math.max(0, post.kudosCount - 1) })
        .where(eq(schema.posts.id, postId))
        .run();
    });
  }

  const fresh = db.select().from(schema.posts).where(eq(schema.posts.id, postId)).get();
  return c.json({ ok: true, kudos: fresh?.kudosCount ?? post.kudosCount, kudosByMe: false });
});

engagementRoutes.post(
  '/feed/:id/comment',
  validate('json', z.object({ body: z.string().trim().min(1).max(400) })),
  (c) => {
    const ctx = ctxOf(c);
    const postId = c.req.param('id');
    const { body } = c.req.valid('json');

    const post = db
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.id, postId), eq(schema.posts.tenantId, ctx.tenantId)))
      .get();
    if (!post) throw notFound('That post');
    if (post.state === 'removed' || post.deletedAt) {
      throw conflict('That post was removed, so it can no longer be replied to.');
    }

    const { hidden } = blockSet(ctx);
    if (post.memberId && hidden.has(post.memberId)) {
      throw forbidden('You and this member have blocked each other, so you cannot reply here.');
    }

    const budget = commentBudget(ctx);
    if (budget.remaining <= 0) throw rateLimited(budget.retryAfterSec || 60);

    const commentId = id('cmt');

    transact(() => {
      db.insert(schema.comments)
        .values({
          id: commentId,
          tenantId: ctx.tenantId,
          postId,
          memberId: ctx.memberId!,
          body,
          state: 'visible',
          createdAt: now(),
          deletedAt: null,
        })
        .run();

      db.update(schema.posts)
        .set({ commentCount: post.commentCount + 1 })
        .where(eq(schema.posts.id, postId))
        .run();
    });

    return c.json(
      {
        ok: true,
        comment: {
          id: commentId,
          postId,
          authorId: ctx.memberId,
          authorName: 'You',
          authorInitials: 'YOU',
          body,
          state: 'visible',
          removed: false,
          createdAt: new Date(now()).toISOString(),
          relativeTime: 'just now',
          canDelete: true,
          canReport: false,
        },
        commentCount: post.commentCount + 1,
        commentBudget: commentBudget(ctx),
      },
      201,
    );
  },
);

/* ============================================================================
   Moderation: report and block (PF-GAME-005)
   ========================================================================= */

const ReportInput = z.object({
  targetType: z.enum(['post', 'comment', 'member']),
  targetId: z.string().min(1),
  reason: z.enum(['harassment', 'spam', 'unsafe_advice', 'impersonation', 'other']),
  note: z.string().max(1000).optional(),
});

engagementRoutes.post('/report', validate('json', ReportInput), (c) => {
  const ctx = ctxOf(c);
  const input = c.req.valid('json');

  const exists =
    input.targetType === 'post'
      ? db.select({ id: schema.posts.id }).from(schema.posts).where(and(eq(schema.posts.id, input.targetId), eq(schema.posts.tenantId, ctx.tenantId))).get()
      : input.targetType === 'comment'
        ? db.select({ id: schema.comments.id }).from(schema.comments).where(and(eq(schema.comments.id, input.targetId), eq(schema.comments.tenantId, ctx.tenantId))).get()
        : db.select({ id: schema.members.id }).from(schema.members).where(and(eq(schema.members.id, input.targetId), eq(schema.members.tenantId, ctx.tenantId))).get();

  if (!exists) throw notFound('That content');

  const duplicate = db
    .select({ id: schema.contentReports.id })
    .from(schema.contentReports)
    .where(
      and(
        eq(schema.contentReports.tenantId, ctx.tenantId),
        eq(schema.contentReports.targetId, input.targetId),
        eq(schema.contentReports.reporterId, ctx.memberId!),
        eq(schema.contentReports.state, 'open'),
      ),
    )
    .get();

  if (duplicate) {
    return c.json({
      ok: true,
      reportId: duplicate.id,
      message: 'You already reported this. It is with the gym team.',
    });
  }

  const reportId = id('rep');

  transact(() => {
    db.insert(schema.contentReports)
      .values({
        id: reportId,
        tenantId: ctx.tenantId,
        targetType: input.targetType,
        targetId: input.targetId,
        reporterId: ctx.memberId!,
        reason: input.reason,
        note: input.note ?? null,
        state: 'open',
        resolvedById: null,
        resolution: null,
        createdAt: now(),
      })
      .run();

    // Three independent reports take content out of the feed while a human looks.
    const reportCount =
      db
        .select({ n: sql<number>`count(distinct ${schema.contentReports.reporterId})` })
        .from(schema.contentReports)
        .where(
          and(
            eq(schema.contentReports.tenantId, ctx.tenantId),
            eq(schema.contentReports.targetId, input.targetId),
            eq(schema.contentReports.state, 'open'),
          ),
        )
        .get()?.n ?? 1;

    if (input.targetType === 'post' && reportCount >= 3) {
      db.update(schema.posts).set({ state: 'flagged' }).where(eq(schema.posts.id, input.targetId)).run();
    }

    audit(ctx, {
      action: 'content.reported',
      entityType: input.targetType,
      entityId: input.targetId,
      entityLabel: input.reason,
      reason: input.note ?? null,
      after: { reason: input.reason, reports: reportCount },
    });
  });

  return c.json(
    {
      ok: true,
      reportId,
      message:
        'Reported. A person from the gym team reads every report, usually within a day. You will not hear from the member you reported about this.',
    },
    201,
  );
});

engagementRoutes.post('/block/:memberId', (c) => {
  const ctx = ctxOf(c);
  const targetId = c.req.param('memberId');

  if (targetId === ctx.memberId) throw invalid('You cannot block yourself.');

  const target = db
    .select({ id: schema.members.id, firstName: schema.members.firstName })
    .from(schema.members)
    .where(and(eq(schema.members.id, targetId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!target) throw notFound('That member');

  const existing = db
    .select()
    .from(schema.blocks)
    .where(and(eq(schema.blocks.memberId, ctx.memberId!), eq(schema.blocks.blockedMemberId, targetId)))
    .get();

  if (!existing) {
    transact(() => {
      db.insert(schema.blocks)
        .values({
          id: id('blk'),
          tenantId: ctx.tenantId,
          memberId: ctx.memberId!,
          blockedMemberId: targetId,
          createdAt: now(),
        })
        .run();

      audit(ctx, {
        action: 'member.blocked',
        entityType: 'member',
        entityId: targetId,
        entityLabel: target.firstName,
        after: { blocked: true },
      });
    });
  }

  return c.json({
    ok: true,
    blocked: true,
    message:
      'Blocked. You will not see their posts or comments and they will not see yours. They are not told. You can undo this from your profile.',
  });
});

engagementRoutes.delete('/block/:memberId', (c) => {
  const ctx = ctxOf(c);
  const targetId = c.req.param('memberId');

  const existing = db
    .select()
    .from(schema.blocks)
    .where(and(eq(schema.blocks.memberId, ctx.memberId!), eq(schema.blocks.blockedMemberId, targetId)))
    .get();
  if (!existing) throw notFound('That block');

  transact(() => {
    db.delete(schema.blocks).where(eq(schema.blocks.id, existing.id)).run();
    audit(ctx, {
      action: 'member.unblocked',
      entityType: 'member',
      entityId: targetId,
      entityLabel: targetId,
      before: { blocked: true },
      after: { blocked: false },
    });
  });

  return c.json({ ok: true, blocked: false, message: 'Unblocked. Their posts will appear in the feed again.' });
});

engagementRoutes.get('/blocks', (c) => {
  const ctx = ctxOf(c);
  const rows = db
    .select()
    .from(schema.blocks)
    .where(and(eq(schema.blocks.tenantId, ctx.tenantId), eq(schema.blocks.memberId, ctx.memberId!)))
    .all();

  const people = peopleByIds(ctx.tenantId, rows.map((r) => r.blockedMemberId));

  return c.json({
    items: rows.map((r) => ({
      memberId: r.blockedMemberId,
      name: people.get(r.blockedMemberId)?.name ?? 'A member',
      initials: people.get(r.blockedMemberId)?.initials ?? '··',
      since: new Date(r.createdAt).toISOString(),
      relativeTime: relativeTime(r.createdAt),
    })),
  });
});

/* ============================================================================
   Referrals
   ========================================================================= */

engagementRoutes.get('/referrals', (c) => {
  const ctx = ctxOf(c);
  const scope = scopeOf(ctx);
  const referral = referralState(ctx, scope);

  return c.json({
    ...referral,
    branch: { id: scope.branchId, name: scope.branchName },
    progressPct: Math.min(100, Math.round((referral.joined / Math.max(1, referral.target)) * 100)),
    /** How long a code stays live, stated up front rather than discovered. */
    expiryNote: referral.expiresOn
      ? `Your code works until ${referral.expiresOn}.`
      : 'Your code does not expire.',
  });
});

void DAY;
