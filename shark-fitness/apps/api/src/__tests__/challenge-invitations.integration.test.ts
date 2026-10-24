import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { addDays, now } from '../lib/time.js';

/* ============================================================================
   Private challenges (PF-GAME-003).

   `visibility: 'private'` was honoured by the *list* and by nothing else. The
   feed filtered private challenges out, so the console never offered a way to
   reach one — and `GET /challenge/:id`, `POST /:id/join`, `DELETE /:id/leave`
   and `PATCH /:id/privacy` all loaded by id and checked only the tenant and
   the branch. A member who knew or guessed the id read the whole leaderboard
   of a challenge they were never invited to, and could put themselves on it.

   The rule these tests hold to: a private challenge a member was not invited
   to is *not found*, never *forbidden* — a 403 confirms it exists — and an
   invitation is the only door in.
   ========================================================================= */

interface Session { cookie: string; csrfToken: string }
const cache = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const INVITED = 'aman@sharkfitness.in';
const UNINVITED = 'rohit@sharkfitness.in';
const STAFF = 'owner@sharkfitness.in';

function invitationState(memberId: string): string | undefined {
  return db
    .select({ state: schema.challengeInvitations.state })
    .from(schema.challengeInvitations)
    .where(
      and(
        eq(schema.challengeInvitations.challengeId, privateChallengeId),
        eq(schema.challengeInvitations.memberId, memberId),
      ),
    )
    .get()?.state;
}

/** This suite owns every row it creates and deletes them in `afterAll` — the
 *  seed is a shared fixture and a challenge left behind changes another
 *  suite's feed. */
const privateChallengeId = id('chl');
let invitedMemberId = '';
let uninvitedMemberId = '';

function memberIdFor(email: string): string {
  const row = db
    .select({ memberId: schema.members.id })
    .from(schema.users)
    .innerJoin(schema.members, eq(schema.members.userId, schema.users.id))
    .where(and(eq(schema.users.email, email), eq(schema.users.tenantId, 'ten_shark')))
    .get();
  expect(row).toBeTruthy();
  return row!.memberId;
}

beforeAll(() => {
  invitedMemberId = memberIdFor(INVITED);
  uninvitedMemberId = memberIdFor(UNINVITED);

  db.insert(schema.challenges)
    .values({
      id: privateChallengeId,
      tenantId: 'ten_shark',
      branchId: null,
      name: 'Invite-only Ladder',
      description: 'A closed group.',
      metric: 'sessions',
      metricLabel: 'sessions',
      startsOn: addDays(new Date().toISOString().slice(0, 10), -3),
      endsOn: addDays(new Date().toISOString().slice(0, 10), 20),
      visibility: 'private',
      teamMode: false,
      teamTarget: null,
      rules: ['Invitation only.'],
      rewardLabel: null,
      createdAt: now(),
    })
    .run();
});

afterAll(() => {
  db.delete(schema.challengeInvitations)
    .where(eq(schema.challengeInvitations.challengeId, privateChallengeId))
    .run();
  db.delete(schema.challengeParticipants)
    .where(eq(schema.challengeParticipants.challengeId, privateChallengeId))
    .run();
  db.delete(schema.challenges).where(eq(schema.challenges.id, privateChallengeId)).run();
});

describe('private challenges are not enumerable', () => {
  it('keeps a private challenge out of the feed for everyone', async () => {
    for (const email of [INVITED, UNINVITED]) {
      const session = await signIn(email);
      const response = await app.request('/v1/member/engagement', { headers: headers(session) });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { challenges: Array<{ id: string }> };
      expect(body.challenges.map((ch) => ch.id)).not.toContain(privateChallengeId);
    }
  });

  it('refuses a direct read of a private challenge the member was not invited to', async () => {
    const session = await signIn(UNINVITED);
    const response = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}`, {
      headers: headers(session),
    });
    // Not found, not forbidden: a 403 confirms the challenge exists.
    expect(response.status).toBe(404);
  });

  it('refuses a join of a private challenge without an invitation', async () => {
    const session = await signIn(UNINVITED);
    const response = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}/join`, {
      method: 'POST',
      headers: headers(session, true),
      body: '{}',
    });
    expect(response.status).toBe(404);

    expect(
      db
        .select()
        .from(schema.challengeParticipants)
        .where(
          and(
            eq(schema.challengeParticipants.challengeId, privateChallengeId),
            eq(schema.challengeParticipants.memberId, uninvitedMemberId),
          ),
        )
        .get(),
    ).toBeUndefined();
  });

  it('refuses the leave and privacy verbs to an uninvited member too', async () => {
    const session = await signIn(UNINVITED);
    const leave = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}/leave`, {
      method: 'DELETE',
      headers: headers(session, true),
    });
    expect(leave.status).toBe(404);

    const privacy = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}/privacy`, {
      method: 'PATCH',
      headers: headers(session, true),
      body: JSON.stringify({ anonymous: true }),
    });
    expect(privacy.status).toBe(404);
  });
});

describe('an invitation is the door in', () => {
  it('lets an invited member see, join and leave, and keeps the seat out of an uninvited feed', async () => {
    const staff = await signIn(STAFF);
    const invite = await app.request(
      `/v1/admin/engagement/challenges/${privateChallengeId}/invitations`,
      {
        method: 'POST',
        headers: { ...headers(staff, true), 'idempotency-key': `inv-${privateChallengeId}` },
        body: JSON.stringify({ memberIds: [invitedMemberId], expiresInDays: 7 }),
      },
    );
    expect(invite.status).toBe(201);
    const inviteBody = (await invite.json()) as { invited: string[]; expiresAt: number };
    expect(inviteBody.invited).toEqual([invitedMemberId]);

    const member = await signIn(INVITED);

    // The pending invitation is visible to the member it belongs to...
    const pending = await app.request('/v1/member/engagement/invitations', { headers: headers(member) });
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { invitations: Array<{ challengeId: string }> }).invitations
      .map((row) => row.challengeId)).toContain(privateChallengeId);

    // ...and to nobody else.
    const otherPending = await app.request('/v1/member/engagement/invitations', {
      headers: headers(await signIn(UNINVITED)),
    });
    expect(((await otherPending.json()) as { invitations: Array<{ challengeId: string }> }).invitations
      .map((row) => row.challengeId)).not.toContain(privateChallengeId);

    // The challenge now reads, and appears in the invited member's own feed.
    const read = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}`, {
      headers: headers(member),
    });
    expect(read.status).toBe(200);

    const feed = await app.request('/v1/member/engagement', { headers: headers(member) });
    expect(((await feed.json()) as { challenges: Array<{ id: string }> }).challenges
      .map((ch) => ch.id)).toContain(privateChallengeId);

    // Joining accepts the invitation rather than needing a second press.
    const join = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}/join`, {
      method: 'POST',
      headers: headers(member, true),
      body: '{}',
    });
    expect(join.status).toBe(200);
    expect(invitationState(invitedMemberId)).toBe('accepted');

    // The uninvited member still cannot see it, seat or no seat.
    const stillHidden = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}`, {
      headers: headers(await signIn(UNINVITED)),
    });
    expect(stillHidden.status).toBe(404);
  });

  it('is idempotent on the invite write and does not stack rows', async () => {
    const staff = await signIn(STAFF);
    const body = JSON.stringify({ memberIds: [invitedMemberId], expiresInDays: 7 });
    const key = `inv-replay-${privateChallengeId}`;
    const first = await app.request(`/v1/admin/engagement/challenges/${privateChallengeId}/invitations`, {
      method: 'POST',
      headers: { ...headers(staff, true), 'idempotency-key': key },
      body,
    });
    const second = await app.request(`/v1/admin/engagement/challenges/${privateChallengeId}/invitations`, {
      method: 'POST',
      headers: { ...headers(staff, true), 'idempotency-key': key },
      body,
    });
    expect(await first.json()).toEqual(await second.json());

    expect(
      db
        .select()
        .from(schema.challengeInvitations)
        .where(
          and(
            eq(schema.challengeInvitations.challengeId, privateChallengeId),
            eq(schema.challengeInvitations.memberId, invitedMemberId),
          ),
        )
        .all().length,
    ).toBe(1);
  });

  it('takes the seat back when an invitation is revoked', async () => {
    const staff = await signIn(STAFF);
    const revoke = await app.request(
      `/v1/admin/engagement/challenges/${privateChallengeId}/invitations/${invitedMemberId}`,
      { method: 'DELETE', headers: headers(staff, true) },
    );
    expect(revoke.status).toBe(200);
    expect((await revoke.json()) as { seatRemoved: boolean }).toMatchObject({ seatRemoved: true });
    expect(invitationState(invitedMemberId)).toBe('revoked');

    // A revoked member must not keep reading the board through the
    // "already taking part" clause — the seat goes with the invitation.
    const member = await signIn(INVITED);
    const read = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}`, {
      headers: headers(member),
    });
    expect(read.status).toBe(404);
  });

  it('honours an expired invitation without waiting for a sweeper', async () => {
    const staff = await signIn(STAFF);
    await app.request(`/v1/admin/engagement/challenges/${privateChallengeId}/invitations`, {
      method: 'POST',
      headers: headers(staff, true),
      body: JSON.stringify({ memberIds: [invitedMemberId], expiresInDays: 7 }),
    });
    expect(invitationState(invitedMemberId)).toBe('pending');

    // Backdate the expiry. The row still says `pending`; the read path must
    // not care, because an invitation that has lapsed is not an invitation.
    db.update(schema.challengeInvitations)
      .set({ expiresAt: now() - 1000 })
      .where(
        and(
          eq(schema.challengeInvitations.challengeId, privateChallengeId),
          eq(schema.challengeInvitations.memberId, invitedMemberId),
        ),
      )
      .run();

    const member = await signIn(INVITED);
    const read = await app.request(`/v1/member/engagement/challenge/${privateChallengeId}`, {
      headers: headers(member),
    });
    expect(read.status).toBe(404);

    const pending = await app.request('/v1/member/engagement/invitations', { headers: headers(member) });
    expect(((await pending.json()) as { invitations: Array<{ challengeId: string }> }).invitations
      .map((row) => row.challengeId)).not.toContain(privateChallengeId);
  });

  it('clamps an invitation expiry to the end of the challenge', async () => {
    const staff = await signIn(STAFF);
    const response = await app.request(
      `/v1/admin/engagement/challenges/${privateChallengeId}/invitations`,
      {
        method: 'POST',
        headers: headers(staff, true),
        // Far beyond the challenge, which ends in 20 days.
        body: JSON.stringify({ memberIds: [uninvitedMemberId], expiresInDays: 365 }),
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { expiresAt: number };
    // The challenge ends 20 days out; an invitation may not outlive it.
    expect(body.expiresAt).toBeLessThan(now() + 22 * 24 * 60 * 60 * 1000);
  });

  it('refuses invitations on a challenge everyone can already see', async () => {
    const staff = await signIn(STAFF);
    const branchChallenge = db
      .select({ id: schema.challenges.id })
      .from(schema.challenges)
      .where(eq(schema.challenges.visibility, 'branch'))
      .get();
    expect(branchChallenge).toBeTruthy();

    const response = await app.request(
      `/v1/admin/engagement/challenges/${branchChallenge!.id}/invitations`,
      {
        method: 'POST',
        headers: headers(staff, true),
        body: JSON.stringify({ memberIds: [invitedMemberId], expiresInDays: null }),
      },
    );
    expect(response.status).toBe(422);
  });

  it('refuses the invite verb to a role without community moderation', async () => {
    const accountant = await signIn('accounts@sharkfitness.in');
    const response = await app.request(
      `/v1/admin/engagement/challenges/${privateChallengeId}/invitations`,
      {
        method: 'POST',
        headers: headers(accountant, true),
        body: JSON.stringify({ memberIds: [invitedMemberId], expiresInDays: null }),
      },
    );
    expect(response.status).toBe(403);
  });
});
