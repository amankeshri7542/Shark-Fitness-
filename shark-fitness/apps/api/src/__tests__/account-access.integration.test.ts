import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { hashPassword, hashToken } from '../lib/crypto.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'account-access-password';

interface Session {
  cookie: string;
  csrfToken: string;
}

function sharkTenantId(): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

function makeAccount(options: {
  accountState?: string;
  deletedAt?: number | null;
  staff?: boolean;
} = {}): { userId: string; email: string; staffId: string | null } {
  const userId = id('usr');
  const staffId = options.staff ? id('stf') : null;
  const email = `${userId}@account-access.test`;
  const atMs = now();
  const tenantId = sharkTenantId();

  db.insert(schema.users).values({
    id: userId,
    tenantId,
    email,
    phone: null,
    name: 'Account Access Fixture',
    initials: 'AA',
    role: options.staff ? 'trainer' : 'member',
    accountState: options.accountState ?? 'active',
    passwordHash: hashPassword(PASSWORD),
    preferences: {
      register: 'predator',
      theme: 'dark',
      unitSystem: 'metric',
      haptics: true,
      reducedMotion: false,
    },
    lastSeenAt: null,
    createdAt: atMs,
    updatedAt: atMs,
    deletedAt: options.deletedAt ?? null,
  }).run();

  if (staffId) {
    db.insert(schema.staff).values({
      id: staffId,
      tenantId,
      userId,
      employmentStatus: 'active',
      branchIds: ['br_kor'],
      specialties: [],
      certifications: [],
      commissionRules: [],
      hourlyRateMinor: null,
      joinedOn: '2026-08-23',
      createdAt: atMs,
      updatedAt: atMs,
    }).run();
  }

  return { userId, email, staffId };
}

async function signIn(email: string, password = PASSWORD): Promise<Session> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ tenantSlug: 'shark', email, password }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  expect(token).toBeTruthy();
  return {
    cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`,
    csrfToken: body.csrfToken,
  };
}

function sessionHeaders(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: ORIGIN,
    ...(unsafe ? { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken } : {}),
  };
}

async function verifyOtpFor(userId: string, identifier: string): Promise<Response> {
  const challengeId = id('otp');
  const code = '654321';
  db.insert(schema.otpChallenges).values({
    id: challengeId,
    tenantId: sharkTenantId(),
    identifier,
    codeHash: hashToken(`${challengeId}:${code}`),
    attempts: 0,
    createdAt: now(),
    expiresAt: now() + 600_000,
    consumedAt: null,
  }).run();

  const response = await app.request('/v1/auth/otp/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ challengeId, code }),
  });

  expect(
    db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId)).all(),
  ).toHaveLength(0);
  return response;
}

describe('account authentication boundaries', () => {
  it('does not turn a valid OTP into a session for a non-authenticatable account', async () => {
    for (const accountState of ['disabled', 'legal_hold', 'deletion_requested', 'anonymized']) {
      const account = makeAccount({ accountState });
      const response = await verifyOtpFor(account.userId, account.email);
      expect(response.status).not.toBe(200);
    }

    const deleted = makeAccount({ deletedAt: now() });
    const response = await verifyOtpFor(deleted.userId, deleted.email);
    expect(response.status).not.toBe(200);
  });

  it('ends existing sessions as soon as an account stops being authenticatable', async () => {
    const account = makeAccount();

    for (const accountState of ['invited', 'disabled', 'legal_hold', 'deletion_requested', 'anonymized']) {
      const session = await signIn(account.email);
      db.update(schema.users)
        .set({ accountState, updatedAt: now() })
        .where(eq(schema.users.id, account.userId))
        .run();

      expect((await app.request('/v1/me', { headers: sessionHeaders(session) })).status).toBe(401);

      db.update(schema.users)
        .set({ accountState: 'active', updatedAt: now() })
        .where(eq(schema.users.id, account.userId))
        .run();
    }

    const session = await signIn(account.email);
    db.update(schema.users)
      .set({ deletedAt: now(), updatedAt: now() })
      .where(eq(schema.users.id, account.userId))
      .run();
    expect((await app.request('/v1/me', { headers: sessionHeaders(session) })).status).toBe(401);
  });

  it.each([
    ['disabled', { accountState: 'disabled' }],
    ['former', { employmentStatus: 'former' }],
  ])('revokes active sessions when staff become %s', async (_label, transition) => {
    const owner = await signIn('owner@sharkfitness.in', 'shark1234');
    const staffAccount = makeAccount({ staff: true });
    const staffSession = await signIn(staffAccount.email);

    const response = await app.request(`/v1/admin/staff/${staffAccount.staffId}`, {
      method: 'PATCH',
      headers: sessionHeaders(owner, true),
      body: JSON.stringify(transition),
    });

    expect(response.status).toBe(200);
    expect(
      db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.userId, staffAccount.userId), isNull(schema.sessions.revokedAt)))
        .all(),
    ).toHaveLength(0);
    expect((await app.request('/v1/me', { headers: sessionHeaders(staffSession) })).status).toBe(401);

    if ('employmentStatus' in transition) {
      expect(
        db.select({ accountState: schema.users.accountState }).from(schema.users).where(eq(schema.users.id, staffAccount.userId)).get()!
          .accountState,
      ).toBe('disabled');
    }
  });
});
