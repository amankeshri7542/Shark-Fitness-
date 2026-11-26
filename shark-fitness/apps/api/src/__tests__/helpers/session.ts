import { and, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { app } from '../../app.js';
import { db, schema } from '../../db/client.js';
import { signInRequest } from './mfa.js';

/** A signed-in test session: cookie header plus the CSRF token for writes. */
export interface TestSession {
  cookie: string;
  csrfToken: string;
}

const ORIGIN = 'http://localhost:5173';
const cache = new Map<string, TestSession>();

/** Signs in (completing two-step for roles that need it) and caches the session. */
export async function signIn(email: string, tenantSlug = 'shark', fresh = false): Promise<TestSession> {
  const key = `${tenantSlug}:${email}`;
  const cached = cache.get(key);
  if (cached && !fresh) return cached;
  const response = await signInRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ tenantSlug, email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(key, session);
  return session;
}

export function headers(session: TestSession, extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: ORIGIN,
    'x-csrf-token': session.csrfToken,
    'content-type': 'application/json',
    ...extra,
  };
}

/** `app.request` with the session's headers; `body` is JSON-encoded. */
export async function call(
  session: TestSession,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method,
    headers: headers(session, extra),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function userIdFor(email: string, tenantId = 'ten_shark'): string {
  const row = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.email, email), eq(schema.users.tenantId, tenantId)))
    .get();
  if (!row) throw new Error(`No seeded user ${email}`);
  return row.id;
}

export function memberIdFor(email: string, tenantId = 'ten_shark'): string {
  const row = db
    .select({ id: schema.members.id })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(and(eq(schema.users.email, email), eq(schema.users.tenantId, tenantId)))
    .get();
  if (!row) throw new Error(`No seeded member ${email}`);
  return row.id;
}

export function staffIdFor(email: string, tenantId = 'ten_shark'): string {
  const row = db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(and(eq(schema.users.email, email), eq(schema.users.tenantId, tenantId)))
    .get();
  if (!row) throw new Error(`No seeded staff ${email}`);
  return row.id;
}

/** Sets (or clears, with `null`) one consent row for a user, returning the old value. */
export function setConsent(userId: string, purpose: string, granted: boolean | null, tenantId = 'ten_shark'): boolean | null {
  const existing = db
    .select()
    .from(schema.consents)
    .where(and(eq(schema.consents.userId, userId), eq(schema.consents.purpose, purpose)))
    .get();
  if (granted === null) {
    if (existing) db.delete(schema.consents).where(eq(schema.consents.id, existing.id)).run();
  } else if (existing) {
    db.update(schema.consents).set({ granted }).where(eq(schema.consents.id, existing.id)).run();
  } else {
    db.insert(schema.consents)
      .values({ id: `cns_test_${userId}_${purpose}`, tenantId, userId, purpose, granted, version: 'test', updatedAt: Date.now(), ip: null })
      .run();
  }
  return existing ? existing.granted : null;
}
