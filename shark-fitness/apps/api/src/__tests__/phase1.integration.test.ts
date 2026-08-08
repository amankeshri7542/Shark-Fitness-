import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema, sqlite } from '../db/client.js';
import { consumeRealtimeTicket } from '../lib/realtime-ticket.js';

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}

async function signIn(email = 'aman@sharkfitness.in'): Promise<BrowserSession> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
      'user-agent': 'phase1-integration-test',
    },
    body: JSON.stringify({
      tenantSlug: 'shark',
      email,
      password: 'shark1234',
    }),
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string; token?: string };
  expect(body.token).toBeUndefined();
  expect(body.csrfToken).toHaveLength(32);

  const setCookie = response.headers.get('set-cookie') ?? '';
  const session = setCookie.match(/shark_session=([^;,]+)/)?.[1];
  expect(session).toBeTruthy();

  return {
    cookie: `shark_session=${session}; shark_csrf=${body.csrfToken}`,
    csrfToken: body.csrfToken,
  };
}

function browserHeaders(session: BrowserSession, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken } : {}),
  };
}

function prepareAmanForDoorTest(): void {
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get();
  expect(tenant).toBeTruthy();

  const user = db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, tenant!.id), eq(schema.users.email, 'aman@sharkfitness.in')))
    .get();
  expect(user).toBeTruthy();

  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenant!.id), eq(schema.members.userId, user!.id)))
    .get();
  expect(member).toBeTruthy();

  sqlite.prepare('DELETE FROM used_access_windows WHERE tenant_id = ? AND member_id = ?').run(tenant!.id, member!.id);
  sqlite.prepare('DELETE FROM check_ins WHERE tenant_id = ? AND member_id = ?').run(tenant!.id, member!.id);
  sqlite
    .prepare("UPDATE memberships SET state = 'active' WHERE tenant_id = ? AND member_id = ?")
    .run(tenant!.id, member!.id);
  sqlite
    .prepare("UPDATE invoices SET state = 'paid', paid_minor = total_minor WHERE tenant_id = ? AND member_id = ?")
    .run(tenant!.id, member!.id);
  sqlite
    .prepare('UPDATE branches SET opens_minutes = 0, closes_minutes = 1440, capacity = 500 WHERE tenant_id = ?')
    .run(tenant!.id);
}

describe('Phase 1 production boundaries', () => {
  beforeEach(() => {
    prepareAmanForDoorTest();
  });

  afterAll(() => {
    sqlite.close();
  });

  it('requires tenant context and rejects untrusted browser origins', async () => {
    const missingTenant = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'aman@sharkfitness.in', password: 'shark1234' }),
    });
    expect(missingTenant.status).toBe(422);

    const untrustedOrigin = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ tenantSlug: 'shark', email: 'aman@sharkfitness.in', password: 'shark1234' }),
    });
    expect(untrustedOrigin.status).toBe(403);
  });

  it('keeps the session in an HttpOnly cookie and enforces CSRF on mutations', async () => {
    const session = await signIn();

    const me = await app.request('/v1/me', { headers: browserHeaders(session) });
    expect(me.status).toBe(200);

    const sessions = await app.request('/v1/me/sessions', { headers: browserHeaders(session) });
    const sessionList = (await sessions.json()) as { items: Array<{ current: boolean }> };
    expect(sessionList.items.some((item) => item.current)).toBe(true);

    const missingCsrf = await app.request('/v1/auth/sign-out', {
      method: 'POST',
      headers: browserHeaders(session),
    });
    expect(missingCsrf.status).toBe(403);

    const signedOut = await app.request('/v1/auth/sign-out', {
      method: 'POST',
      headers: browserHeaders(session, true),
    });
    expect(signedOut.status).toBe(200);

    const afterSignOut = await app.request('/v1/me', { headers: browserHeaders(session) });
    expect(afterSignOut.status).toBe(401);
  });

  it('does not echo OTPs unless explicitly enabled for local development', async () => {
    const response = await app.request('/v1/auth/otp/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ tenantSlug: 'shark', identifier: 'aman@sharkfitness.in' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { devCode?: string };
    expect(body.devCode).toBeUndefined();
  });

  it('issues one-use realtime tickets instead of putting the session token in a WebSocket URL', async () => {
    const session = await signIn();
    const response = await app.request('/v1/me/realtime-ticket', {
      method: 'POST',
      headers: browserHeaders(session, true),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ticket: string; expiresInSec: number };
    expect(body.ticket.length).toBeGreaterThan(20);
    expect(body.expiresInSec).toBeLessThanOrEqual(30);
    expect(consumeRealtimeTicket(body.ticket)).not.toBeNull();
    expect(consumeRealtimeTicket(body.ticket)).toBeNull();
  });

  it('lets only an authenticated reader consume and burn a signed pass', async () => {
    const session = await signIn();
    const passResponse = await app.request('/v1/member/pass', { headers: browserHeaders(session) });
    expect(passResponse.status).toBe(200);

    const pass = (await passResponse.json()) as {
      branch: { id: string };
      code: { offlineSeed?: string; value?: string; passes: Array<{ token: string }> };
    };
    expect(pass.code.offlineSeed).toBeUndefined();
    expect(pass.code.value).toBeUndefined();
    expect(pass.code.passes.length).toBeGreaterThan(1);

    const body = JSON.stringify({ token: pass.code.passes[0]!.token, branchId: pass.branch.id });
    const unauthenticatedReader = await app.request('/v1/door/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(unauthenticatedReader.status).toBe(401);

    const readerHeaders = {
      'content-type': 'application/json',
      'x-reader-id': 'demo-reader',
      'x-reader-key': process.env.SHARK_DEMO_READER_KEY ?? 'phase1-test-reader-secret',
    };
    const firstScan = await app.request('/v1/door/scan', { method: 'POST', headers: readerHeaders, body });
    expect(firstScan.status).toBe(200);
    const firstResult = (await firstScan.json()) as { granted: boolean; decision: string };
    expect(firstResult.granted).toBe(true);
    expect(firstResult.decision).toBe('granted');

    const replay = await app.request('/v1/door/scan', { method: 'POST', headers: readerHeaders, body });
    expect(replay.status).toBe(200);
    const replayResult = (await replay.json()) as { granted: boolean; decision: string };
    expect(replayResult.granted).toBe(false);
    expect(replayResult.decision).toBe('denied_token_replayed');
  });
});
