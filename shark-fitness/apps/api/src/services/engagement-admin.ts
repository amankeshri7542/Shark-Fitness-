import { and, eq, inArray } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { invalid, notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, now, startOfLocalDay } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { loadMemberInScope, memberBranchIds } from './members.js';

/**
 * Invitations to private challenges (PF-GAME-003), from the console side.
 *
 * A private challenge has no self-service door: the gym decides who is in it.
 * That makes the invitation the authorisation record, which is why it lives in
 * its own table rather than being inferred from participation — a member who
 * leaves is still invited, and a member whose invitation is revoked must lose
 * their seat rather than keep it because a participant row survived.
 *
 * Deliberately not a full challenge CRUD. Challenges are seeded and managed
 * outside this file; the only gap the audit found was that private ones had no
 * way in and no way to be kept out of.
 */

/** A challenge the caller may administer. Tenant first, then branch, then
 *  visibility — a branch challenge at a gym the caller cannot see is not
 *  found rather than forbidden, matching every other detail load. */
function loadChallengeForStaff(ctx: RequestContext, challengeId: string) {
  const challenge = db
    .select()
    .from(schema.challenges)
    .where(and(eq(schema.challenges.id, challengeId), eq(schema.challenges.tenantId, ctx.tenantId)))
    .get();
  if (!challenge) throw notFound('That challenge');
  if (challenge.branchId && !branchScope(ctx).includes(challenge.branchId)) throw notFound('That challenge');
  return challenge;
}

/** The instant a challenge stops mattering, in its own branch's zone.
 *
 *  An invitation that outlives the challenge is a dead link, so every expiry
 *  written here is clamped to this. Computed in the branch timezone because
 *  `endsOn` is a local calendar date — clamping in UTC would cut a Bengaluru
 *  challenge short by five and a half hours on its final day. */
function challengeEndsAt(tenantId: string, challenge: { branchId: string | null; endsOn: string }): number {
  const tz = branchTimeZone(tenantId, challenge.branchId);
  return startOfLocalDay(challenge.endsOn, tz) + DAY;
}

export interface InviteInput {
  challengeId: string;
  memberIds: string[];
  /** Days the invitation stays open. Clamped to the challenge end regardless. */
  expiresInDays: number | null;
}

export interface InviteResult {
  invited: string[];
  alreadyInvited: string[];
  expiresAt: number;
}

export function inviteToChallenge(ctx: RequestContext, input: InviteInput): InviteResult {
  requirePermission(ctx, 'community.moderate');
  const atMs = now();
  const challenge = loadChallengeForStaff(ctx, input.challengeId);

  if (challenge.visibility !== 'private') {
    throw invalid('Only a private challenge uses invitations. Everyone at the branch can already see this one.');
  }
  const endsAt = challengeEndsAt(ctx.tenantId, challenge);
  if (endsAt <= atMs) throw invalid('That challenge has already finished.');

  const requested = input.expiresInDays === null ? endsAt : atMs + input.expiresInDays * DAY;
  const expiresAt = Math.min(requested, endsAt);

  const result: InviteResult = { invited: [], alreadyInvited: [], expiresAt };

  transact(() => {
    for (const memberId of input.memberIds) {
      // Scope check per member: a manager cannot invite somebody at a branch
      // they cannot see, even into a tenant-wide challenge.
      const member = loadMemberInScope(ctx, memberId);

      const existing = db
        .select()
        .from(schema.challengeInvitations)
        .where(
          and(
            eq(schema.challengeInvitations.challengeId, challenge.id),
            eq(schema.challengeInvitations.memberId, memberId),
          ),
        )
        .get();

      if (existing && (existing.state === 'pending' || existing.state === 'accepted')) {
        result.alreadyInvited.push(memberId);
        continue;
      }

      if (existing) {
        // Re-inviting somebody who declined or was revoked revives the one row
        // rather than stacking a second, so "who was asked" stays a single
        // answer per member.
        db.update(schema.challengeInvitations)
          .set({
            state: 'pending',
            invitedByUserId: ctx.userId,
            expiresAt,
            respondedAt: null,
            updatedAt: atMs,
          })
          .where(eq(schema.challengeInvitations.id, existing.id))
          .run();
      } else {
        db.insert(schema.challengeInvitations)
          .values({
            id: id('cin'),
            tenantId: ctx.tenantId,
            challengeId: challenge.id,
            memberId,
            invitedByUserId: ctx.userId,
            state: 'pending',
            expiresAt,
            respondedAt: null,
            createdAt: atMs,
            updatedAt: atMs,
          })
          .run();
      }

      // Truthful in-app notification: this is a real row the member's app
      // reads, not a promise that an email went anywhere.
      if (member.userId) {
        db.insert(schema.notifications)
          .values({
            id: id('ntf'),
            tenantId: ctx.tenantId,
            userId: member.userId,
            channel: 'in_app',
            kind: 'challenge_invitation',
            title: 'You have been invited to a challenge',
            body: `${challenge.name} — open the Pack tab to accept or decline.`,
            link: `/pack/challenge/${challenge.id}`,
            templateCode: 'challenge.invited',
            state: 'sent',
            attempts: 1,
            lastError: null,
            createdAt: atMs,
            readAt: null,
          })
          .run();
      }

      audit(ctx, {
        action: 'challenge.invited',
        entityType: 'challenge_invitation',
        entityId: challenge.id,
        entityLabel: challenge.name,
        branchId: challenge.branchId ?? member.homeBranchId,
        after: { memberId, expiresAt: new Date(expiresAt).toISOString() },
      });

      result.invited.push(memberId);
    }
  });

  return result;
}

/**
 * Revoking takes the seat as well as the invitation.
 *
 * Leaving the participant row behind would mean a revoked member kept reading
 * the board through the "already taking part" clause in the member read path —
 * which is the whole reason revoke exists.
 */
export function revokeChallengeInvitation(
  ctx: RequestContext,
  challengeId: string,
  memberId: string,
): { revoked: true; seatRemoved: boolean } {
  requirePermission(ctx, 'community.moderate');
  const atMs = now();
  const challenge = loadChallengeForStaff(ctx, challengeId);
  loadMemberInScope(ctx, memberId);

  const invitation = db
    .select()
    .from(schema.challengeInvitations)
    .where(
      and(
        eq(schema.challengeInvitations.challengeId, challenge.id),
        eq(schema.challengeInvitations.memberId, memberId),
      ),
    )
    .get();
  if (!invitation) throw notFound('That invitation');

  let seatRemoved = false;

  transact(() => {
    db.update(schema.challengeInvitations)
      .set({ state: 'revoked', respondedAt: atMs, updatedAt: atMs })
      .where(eq(schema.challengeInvitations.id, invitation.id))
      .run();

    const participant = db
      .select()
      .from(schema.challengeParticipants)
      .where(
        and(
          eq(schema.challengeParticipants.challengeId, challenge.id),
          eq(schema.challengeParticipants.memberId, memberId),
        ),
      )
      .get();

    if (participant) {
      db.delete(schema.challengeParticipants)
        .where(eq(schema.challengeParticipants.id, participant.id))
        .run();
      seatRemoved = true;
    }

    audit(ctx, {
      action: 'challenge.invitation_revoked',
      entityType: 'challenge_invitation',
      entityId: invitation.id,
      entityLabel: challenge.name,
      branchId: challenge.branchId,
      before: { state: invitation.state, participating: seatRemoved },
      after: { state: 'revoked', participating: false },
    });

    if (challenge.branchId) {
      emit({
        tenantId: ctx.tenantId,
        branchId: challenge.branchId,
        channel: channels.branch(challenge.branchId),
        topic: 'challenge.score_changed',
        payload: { challengeId: challenge.id, memberId, joined: false },
      });
    }
  });

  return { revoked: true, seatRemoved };
}

export function listChallengeInvitations(ctx: RequestContext, challengeId: string) {
  requirePermission(ctx, 'community.moderate');
  const atMs = now();
  const challenge = loadChallengeForStaff(ctx, challengeId);

  const rows = db
    .select({
      invitation: schema.challengeInvitations,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      homeBranchId: schema.members.homeBranchId,
      memberId: schema.members.id,
    })
    .from(schema.challengeInvitations)
    .innerJoin(schema.members, eq(schema.members.id, schema.challengeInvitations.memberId))
    .where(eq(schema.challengeInvitations.challengeId, challenge.id))
    .all()
    // Branch scope via the shared helper rather than home branch alone, so a
    // member granted into this branch is not dropped from a list the caller
    // can legitimately see.
    .filter((row) =>
      memberBranchIds({ id: row.memberId, homeBranchId: row.homeBranchId }).some((branchId) =>
        branchScope(ctx).includes(branchId),
      ),
    );

  const participating = new Set(
    db
      .select({ memberId: schema.challengeParticipants.memberId })
      .from(schema.challengeParticipants)
      .where(eq(schema.challengeParticipants.challengeId, challenge.id))
      .all()
      .map((row) => row.memberId),
  );

  return {
    challenge: { id: challenge.id, name: challenge.name, visibility: challenge.visibility, endsOn: challenge.endsOn },
    invitations: rows.map((row) => ({
      memberId: row.invitation.memberId,
      memberName: `${row.firstName} ${row.lastName}`.trim(),
      // A lapsed row is reported as expired whether or not a sweeper has run,
      // so the console never shows an invitation as open when it is not.
      state:
        row.invitation.state === 'pending' &&
        row.invitation.expiresAt !== null &&
        row.invitation.expiresAt <= atMs
          ? 'expired'
          : row.invitation.state,
      expiresAt: row.invitation.expiresAt,
      invitedAt: row.invitation.createdAt,
      respondedAt: row.invitation.respondedAt,
      participating: participating.has(row.invitation.memberId),
    })),
  };
}

/** Rows whose expiry has passed, settled so the state column stops lying.
 *  Read paths already treat a lapsed row as unusable, so this is bookkeeping
 *  rather than enforcement — which is what makes it safe to run on a timer. */
export function expireChallengeInvitations(atMs = now()): number {
  const ids = db
    .select({ id: schema.challengeInvitations.id, expiresAt: schema.challengeInvitations.expiresAt })
    .from(schema.challengeInvitations)
    .where(eq(schema.challengeInvitations.state, 'pending'))
    .all()
    .filter((row) => row.expiresAt !== null && row.expiresAt <= atMs)
    .map((row) => row.id);
  if (ids.length === 0) return 0;

  db.update(schema.challengeInvitations)
    .set({ state: 'expired', updatedAt: atMs })
    .where(inArray(schema.challengeInvitations.id, ids))
    .run();
  return ids.length;
}
