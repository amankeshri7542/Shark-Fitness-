import { and, eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { app } from '../../app.js';
import { resetRateLimitsForTest } from '../../middleware/index.js';
import { db, schema } from '../../db/client.js';
import { hashPassword } from '../../lib/crypto.js';
import { id } from '../../lib/ids.js';
import { addDays, isoDate, now } from '../../lib/time.js';

/**
 * Self-contained fixtures for the P05 suites (scan, waitlist, credit packs,
 * media, progress photos). Each test builds the members it needs instead of
 * hunting the shared seed for one in the right state, so a suite run at any
 * hour, in any order, sees the same world.
 */

export const TENANT = 'ten_shark';
export const ORIGIN = 'http://localhost:5173';

export interface Session {
  cookie: string;
  csrfToken: string;
}

const sessions = new Map<string, Session>();

export async function signIn(email: string, password = 'shark1234', tenantSlug = 'shark'): Promise<Session> {
  const key = `${tenantSlug}:${email}`;
  const cached = sessions.get(key);
  if (cached) return cached;
  // Suites here sign in dozens of fixture members from one address; the
  // sign-in limiter has its own suite and must not decide these.
  resetRateLimitsForTest();
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ tenantSlug, email, password }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  sessions.set(key, session);
  return session;
}

export function headers(session: Session, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrfToken, ...extra };
}

export const get = (session: Session, path: string) => app.request(path, { headers: headers(session) });

export const send = (
  session: Session,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: headers(session, body === undefined ? extra : { 'content-type': 'application/json', ...extra }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const post = (session: Session, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  send(session, 'POST', path, body ?? {}, extra);

/** A membership snapshot copied from a seeded all-day plan, so fixtures carry
 *  real product terms rather than a hand-written approximation. */
function allDayTemplate() {
  const row = db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.tenantId, TENANT),
        sql`json_extract(${schema.memberships.productSnapshot}, '$.access.windowStartMin') is null`,
        sql`json_extract(${schema.memberships.productSnapshot}, '$.access.windowEndMin') is null`,
        sql`json_extract(${schema.memberships.productSnapshot}, '$.kind') = 'membership'`,
      ),
    )
    .get();
  if (!row) throw new Error('The seed has no all-day membership to copy.');
  return row;
}

export interface FixtureMember {
  memberId: string;
  userId: string | null;
  email: string | null;
  memberNo: string;
  membershipId: string | null;
}

let counter = 0;

const graceEndedOn = () => isoDate(now() - 2 * 86_400_000, 'Asia/Kolkata');

/**
 * A member at `branchId` holding a membership in `state` (or none), optionally
 * with a sign-in (password `shark1234`) and extra entitled branches.
 */
export function createMember(input: {
  branchId?: string;
  state?: string | null;
  extraBranchIds?: string[];
  withLogin?: boolean;
  firstName?: string;
  tenantId?: string;
}): FixtureMember {
  const tenantId = input.tenantId ?? TENANT;
  const branchId = input.branchId ?? 'br_kor';
  const atMs = now();
  counter += 1;
  const memberId = id('mbr');
  const suffix = `${memberId.slice(-6)}${counter}`.toUpperCase();
  const firstName = input.firstName ?? 'Fixture';
  let userId: string | null = null;
  let email: string | null = null;

  if (input.withLogin) {
    userId = id('usr');
    email = `${userId}@p05.test`;
    db.insert(schema.users)
      .values({
        id: userId,
        tenantId,
        email,
        phone: null,
        name: `${firstName} Member`,
        initials: `${firstName[0]}M`,
        role: 'member',
        accountState: 'active',
        passwordHash: hashPassword('shark1234'),
        preferences: { register: 'predator', theme: 'dark', unitSystem: 'metric', haptics: true },
        lastSeenAt: null,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
  }

  db.insert(schema.members)
    .values({
      id: memberId,
      tenantId,
      userId,
      homeBranchId: branchId,
      memberNo: `P05-${suffix}`,
      firstName,
      lastName: 'Member',
      initials: `${firstName[0]}M`,
      email,
      phone: null,
      lifecycle: 'active',
      tags: [],
      trainerId: null,
      joinedOn: '2026-08-24',
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();

  for (const extra of input.extraBranchIds ?? []) {
    db.insert(schema.memberBranches).values({ tenantId, memberId, branchId: extra }).run();
  }

  let membershipId: string | null = null;
  const state = input.state === undefined ? 'active' : input.state;
  if (state !== null) {
    const template = allDayTemplate();
    membershipId = id('msh');
    // Grace is derived, not declared: a term that ended inside the grace days
    // with money still owed (services/membership-dates.ts). Anything else
    // would be reconciled straight back to active on the next read.
    const graceEnded = graceEndedOn();
    db.insert(schema.memberships)
      .values({
        ...template,
        id: membershipId,
        tenantId,
        memberId,
        state,
        startedOn: '2026-01-01',
        endsOn: state === 'grace' ? graceEnded : '2099-12-31',
        graceEndsOn: state === 'grace' ? addDays(graceEnded, 7) : null,
        freezeStartedOn: state === 'frozen' ? '2026-01-01' : null,
        freezeEndsOn: state === 'frozen' ? '2099-12-30' : null,
        cancelEffectiveOn: null,
        previousMembershipId: null,
        version: 1,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
  }

  if (state === 'grace') {
    db.insert(schema.invoices)
      .values({
        id: id('inv'),
        tenantId,
        branchId,
        memberId,
        number: `P05-${suffix}`,
        state: 'overdue',
        issuedOn: graceEndedOn(),
        dueOn: graceEndedOn(),
        currency: 'INR',
        subtotalMinor: 100_000,
        taxMinor: 18_000,
        totalMinor: 118_000,
        refType: 'membership',
        refId: membershipId,
        createdAt: atMs,
        updatedAt: atMs,
      })
      .run();
  }

  return { memberId, userId, email, memberNo: `P05-${suffix}`, membershipId };
}

export async function signInMember(member: FixtureMember): Promise<Session> {
  if (!member.email) throw new Error('That fixture member has no login.');
  return signIn(member.email);
}

/** A class at `branchId` starting `startsInMs` from now, with free
 *  cancellation until two hours before. Nothing else depends on the seed. */
export function createClassSession(input: {
  branchId?: string;
  capacity: number;
  startsInMs?: number;
  creditsRequired?: number;
  dropInPriceMinor?: number | null;
  cancelDeadlineBeforeMs?: number;
  tenantId?: string;
}): string {
  const tenantId = input.tenantId ?? TENANT;
  const classTypeId = db
    .select({ id: schema.classTypes.id })
    .from(schema.classTypes)
    .where(eq(schema.classTypes.tenantId, tenantId))
    .get()!.id;
  const atMs = now();
  const startsAt = atMs + (input.startsInMs ?? 2 * 86_400_000);
  const sessionId = id('ses');
  db.insert(schema.classSessions)
    .values({
      id: sessionId,
      tenantId,
      branchId: input.branchId ?? 'br_kor',
      classTypeId,
      roomId: null,
      trainerId: null,
      seriesId: null,
      startsAt,
      endsAt: startsAt + 45 * 60_000,
      capacity: input.capacity,
      booked: 0,
      state: 'scheduled',
      bookingOpensAt: null,
      cancelDeadlineAt: startsAt - (input.cancelDeadlineBeforeMs ?? 2 * 3_600_000),
      creditsRequired: input.creditsRequired ?? 0,
      dropInPriceMinor: input.dropInPriceMinor ?? null,
      lateCancelFeeMinor: 0,
      waitlistEnabled: true,
      cancelledReason: null,
      substituteFor: null,
      notes: null,
      version: 1,
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();
  return sessionId;
}
