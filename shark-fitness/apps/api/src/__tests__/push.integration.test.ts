import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import webpush from 'web-push';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { addDays, isoDate, localClockOnDay, now } from '../lib/time.js';
import { deliverDuePushes, notifyPaymentOutcome, notifyUser, quietHoursFor } from '../services/notifications.js';
import { isAllowedPushEndpoint } from '../services/push.js';
import { createSession } from '../services/auth.js';
import { startFakePushService, verifyVapid, type FakePushService } from './fixtures/fake-push-service.js';

/**
 * Web Push, end to end against a local fake push service (PHASE-PLAN P04
 * criterion 8). Nothing here may reach a real push service: every outbound
 * request is checked against the fake's origin.
 */

const ORIGIN = 'http://localhost:5173';
const TZ = 'Asia/Kolkata';
const VAPID = webpush.generateVAPIDKeys();
const originalPush = runtimeConfig.push;
let service: FakePushService;
let fetchSpy: { mock: { calls: Array<[unknown, ...unknown[]]> }; mockRestore: () => void };

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}
const sessions = new Map<string, BrowserSession>();

async function signIn(email: string): Promise<BrowserSession> {
  const cached = sessions.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const cookie = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${cookie}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  sessions.set(email, session);
  return session;
}

function call(session: BrowserSession, method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/v1${path}`, {
      method,
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        'x-csrf-token': session.csrfToken,
        'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Test',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const aman = () => signIn('aman@sharkfitness.in');
const rohit = () => signIn('rohit@sharkfitness.in');
const reception = () => signIn('reception@sharkfitness.in');

function userByEmail(email: string) {
  return db.select().from(schema.users).where(eq(schema.users.email, email)).get()!;
}
function memberOf(userId: string) {
  return db.select().from(schema.members).where(eq(schema.members.userId, userId)).get()!;
}

/** Midday and 23:00 in the branch's zone, both safely after now. */
function clockTomorrow(clock: string): number {
  return localClockOnDay(addDays(isoDate(now(), TZ), 1), clock, TZ);
}

async function subscribe(session: BrowserSession, kind: 'ok' | 'gone' | 'busy' = 'ok') {
  const browser = service.browser(kind);
  const response = await call(session, 'POST', '/me/push-subscriptions', { endpoint: browser.endpoint, keys: browser.keys });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return { browser, id };
}

function setConsent(userId: string, granted: boolean): void {
  db.update(schema.consents)
    .set({ granted })
    .where(and(eq(schema.consents.userId, userId), eq(schema.consents.purpose, 'push_notifications')))
    .run();
}

beforeAll(async () => {
  service = await startFakePushService();
  runtimeConfig.push = {
    vapid: { publicKey: VAPID.publicKey, privateKey: VAPID.privateKey, subject: 'mailto:ops@sharkfitness.example' },
    extraEndpointOrigins: [service.origin],
  };
});

afterAll(async () => {
  runtimeConfig.push = originalPush;
  await service.close();
});

beforeEach(() => {
  service.received.length = 0;
  db.delete(schema.pushDeliveries).run();
  db.delete(schema.pushSubscriptions).run();
  // The network guard: anything other than the fake push service fails the test.
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;
});

afterEach(() => {
  for (const [input] of fetchSpy.mock.calls) {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    expect(url.origin, 'push requests may only reach the local fake push service').toBe(service.origin);
  }
  fetchSpy.mockRestore();
});

describe('push subscriptions API', () => {
  it('says push is off, and offers nothing, when VAPID is not configured', async () => {
    const saved = runtimeConfig.push;
    runtimeConfig.push = { vapid: null, extraEndpointOrigins: [] };
    try {
      const response = await call(await aman(), 'GET', '/me/push-subscriptions');
      expect(await response.json()).toEqual({ available: false, publicKey: null, items: [] });
      const browser = service.browser('ok');
      const refused = await call(await aman(), 'POST', '/me/push-subscriptions', { endpoint: browser.endpoint, keys: browser.keys });
      expect(refused.status).toBe(412);
    } finally {
      runtimeConfig.push = saved;
    }
  });

  it('subscribes, records the consent, lists the device without its endpoint, and unsubscribes', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    setConsent(user.id, false);
    const { browser, id } = await subscribe(await aman());

    const listed = await call(await aman(), 'GET', '/me/push-subscriptions');
    const body = (await listed.json()) as { available: boolean; publicKey: string; items: Array<Record<string, unknown>> };
    expect(body.available).toBe(true);
    expect(body.publicKey).toBe(VAPID.publicKey);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id, userAgent: expect.stringContaining('Pixel 7') });
    expect(JSON.stringify(body)).not.toContain(browser.endpoint);

    const consent = db
      .select()
      .from(schema.consents)
      .where(and(eq(schema.consents.userId, user.id), eq(schema.consents.purpose, 'push_notifications')))
      .get();
    expect(consent?.granted).toBe(true);
    const audit = db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id)).all();
    expect(audit.map((row) => row.action)).toContain('push.subscribed');

    const removed = await call(await aman(), 'DELETE', `/me/push-subscriptions/${id}`);
    expect(removed.status).toBe(200);
    expect(db.select().from(schema.pushSubscriptions).all()).toHaveLength(0);
  });

  it('refuses an endpoint that is not a browser push service (no server-side request forgery)', async () => {
    const browser = service.browser('ok');
    for (const endpoint of [
      'http://169.254.169.254/latest/meta-data',
      'https://internal.sharkfitness.example/push',
      'https://fcm.googleapis.com.evil.example/send/x',
      'http://fcm.googleapis.com/fcm/send/x',
    ]) {
      const response = await call(await aman(), 'POST', '/me/push-subscriptions', { endpoint, keys: browser.keys });
      expect(response.status).toBe(422);
    }
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QGx')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
  });

  it('rejects malformed browser keys', async () => {
    const browser = service.browser('ok');
    const response = await call(await aman(), 'POST', '/me/push-subscriptions', {
      endpoint: browser.endpoint,
      keys: { p256dh: 'not-a-key', auth: browser.keys.auth },
    });
    expect(response.status).toBe(422);
  });

  it('moves a phone to whoever registers it now, and never lets one person delete another’s device', async () => {
    const { browser, id } = await subscribe(await aman());
    const again = await call(await rohit(), 'POST', '/me/push-subscriptions', { endpoint: browser.endpoint, keys: browser.keys });
    expect(again.status).toBe(201);
    const rows = db.select().from(schema.pushSubscriptions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userByEmail('rohit@sharkfitness.in').id);

    const notTheirs = await call(await aman(), 'DELETE', `/me/push-subscriptions/${id}`);
    expect(notTheirs.status).toBe(404);
  });
});

describe('push delivery', () => {
  it('sends an encrypted payload with only title, body and deep link, signed with VAPID', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    const { browser } = await subscribe(await aman());
    const at = clockTomorrow('12:00');

    notifyUser(
      {
        tenantId: user.tenantId,
        userId: user.id,
        kind: 'session_cancelled',
        title: 'Apex HIIT is cancelled',
        body: 'Your 18:30 class today will not run. Nothing was charged.',
        link: '/book',
        push: { category: 'booking', dedupeKey: 'test:encrypted' },
      },
      at,
    );
    const result = await deliverDuePushes(at);
    expect(result.sent).toBe(1);
    expect(service.received).toHaveLength(1);

    const request = service.received[0]!;
    expect(request.headers['content-encoding']).toBe('aes128gcm');
    expect(Number(request.headers.ttl)).toBeGreaterThan(0);
    expect(request.headers.urgency).toBe('high');
    const claims = verifyVapid(request.headers.authorization, { publicKey: VAPID.publicKey, audience: service.origin });
    expect(claims.sub).toBe('mailto:ops@sharkfitness.example');
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
    expect(claims.exp * 1000).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);

    // The body is ciphertext: nothing readable on the wire.
    expect(request.body.toString('latin1')).not.toContain('Apex');
    const payload = JSON.parse(browser.decrypt(request.body)) as Record<string, unknown>;
    expect(payload).toEqual({
      title: 'Apex HIIT is cancelled',
      body: 'Your 18:30 class today will not run. Nothing was charged.',
      path: '/book',
      tag: 'test:encrypted',
    });

    const delivery = db.select().from(schema.pushDeliveries).get()!;
    expect(delivery).toMatchObject({ state: 'sent', devicesSent: 1 });
    expect(db.select().from(schema.pushSubscriptions).get()!.lastSuccessAt).toBe(at);
  });

  it('removes a subscription the push service says is gone (410)', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    await subscribe(await aman(), 'gone');
    const at = clockTomorrow('12:00');
    notifyUser(
      { tenantId: user.tenantId, userId: user.id, kind: 'payment_due', title: 'A payment is outstanding', body: 'x', link: '/billing', push: { category: 'payment', dedupeKey: 'test:gone' } },
      at,
    );
    const result = await deliverDuePushes(at);
    expect(result).toMatchObject({ sent: 0, failed: 1, devicesRemoved: 1 });
    expect(db.select().from(schema.pushSubscriptions).all()).toHaveLength(0);
    expect(db.select().from(schema.pushDeliveries).get()).toMatchObject({ state: 'failed', reason: 'devices_gone' });
  });

  it('retries a busy push service, then gives up after three attempts', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    await subscribe(await aman(), 'busy');
    let at = clockTomorrow('12:00');
    notifyUser(
      { tenantId: user.tenantId, userId: user.id, kind: 'k', title: 't', body: 'b', link: '/', push: { category: 'message', dedupeKey: 'test:busy' } },
      at,
    );
    expect((await deliverDuePushes(at)).retried).toBe(1);
    at += 6 * 60_000;
    expect((await deliverDuePushes(at)).retried).toBe(1);
    at += 11 * 60_000;
    expect((await deliverDuePushes(at)).failed).toBe(1);
    expect(service.received).toHaveLength(3);
    expect(db.select().from(schema.pushSubscriptions).get()!.failureCount).toBe(3);
  });

  it('defers through quiet hours in the branch timezone, then sends', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    await subscribe(await aman());
    const late = clockTomorrow('23:00');
    notifyUser(
      { tenantId: user.tenantId, userId: user.id, branchId: 'br_kor', kind: 'k', title: 'Your coach replied', body: 'b', link: '/messages', push: { category: 'message', dedupeKey: 'test:quiet' } },
      late,
    );

    const night = await deliverDuePushes(late);
    expect(night).toMatchObject({ sent: 0, deferred: 1 });
    expect(service.received).toHaveLength(0);
    const deferred = db.select().from(schema.pushDeliveries).get()!;
    const morning = localClockOnDay(addDays(isoDate(late, TZ), 1), '08:00', TZ);
    expect(deferred).toMatchObject({ state: 'queued', reason: 'quiet_hours', dueAt: morning });
    expect(quietHoursFor(user.tenantId, 'br_kor', late)?.endsAt).toBe(morning);

    expect((await deliverDuePushes(morning - 60_000)).sent).toBe(0);
    expect((await deliverDuePushes(morning)).sent).toBe(1);
    expect(service.received).toHaveLength(1);
  });

  it('drops a push that quiet hours would make pointless', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    await subscribe(await aman());
    const late = clockTomorrow('23:00');
    notifyUser(
      { tenantId: user.tenantId, userId: user.id, branchId: 'br_kor', kind: 'waitlist_offer', title: 'A seat opened up', body: 'b', link: '/book', push: { category: 'booking', dedupeKey: 'test:offer', expiresAt: late + 30 * 60_000 } },
      late,
    );
    expect((await deliverDuePushes(late)).suppressed).toBe(1);
    expect(db.select().from(schema.pushDeliveries).get()).toMatchObject({ state: 'suppressed', reason: 'quiet_hours_until_expiry' });
    expect(service.received).toHaveLength(0);
  });

  it('sends nothing without the member’s push consent', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    await subscribe(await aman());
    setConsent(user.id, false);
    const at = clockTomorrow('12:00');
    notifyUser(
      { tenantId: user.tenantId, userId: user.id, kind: 'k', title: 't', body: 'b', link: '/', push: { category: 'booking', dedupeKey: 'test:consent' } },
      at,
    );
    expect((await deliverDuePushes(at)).suppressed).toBe(1);
    expect(db.select().from(schema.pushDeliveries).get()).toMatchObject({ state: 'suppressed', reason: 'no_consent' });
    expect(service.received).toHaveLength(0);
    setConsent(user.id, true);
  });

  it('pushes one logical event once, however often it is raised', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    await subscribe(await aman());
    const at = clockTomorrow('12:00');
    for (let i = 0; i < 3; i += 1) {
      notifyPaymentOutcome(
        { tenantId: user.tenantId, userId: user.id, branchId: 'br_kor', invoiceId: 'inv_dupe', invoiceNumber: 'SF-1', amountMinor: 250000, currency: 'INR', outcome: 'failed', attemptRef: 'pay_1' },
        at,
      );
    }
    expect(db.select().from(schema.pushDeliveries).all()).toHaveLength(1);
    expect((await deliverDuePushes(at)).sent).toBe(1);
    expect(await deliverDuePushes(at)).toMatchObject({ sent: 0 });
    expect(service.received).toHaveLength(1);
  });

  it('never queues a push for a phone whose session has ended', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    const { id } = await subscribe(await aman());
    const sessionId = db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, id)).get()!.sessionId!;
    const revokedAt = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!.revokedAt;
    db.update(schema.sessions).set({ revokedAt: now() }).where(eq(schema.sessions.id, sessionId)).run();
    try {
      notifyUser(
        { tenantId: user.tenantId, userId: user.id, kind: 'k', title: 't', body: 'b', link: '/', push: { category: 'booking', dedupeKey: 'test:revoked' } },
        clockTomorrow('12:00'),
      );
      expect(db.select().from(schema.pushDeliveries).all()).toHaveLength(0);
    } finally {
      db.update(schema.sessions).set({ revokedAt }).where(eq(schema.sessions.id, sessionId)).run();
    }
  });

  it('never lets a support (impersonation) session receive the member’s pushes', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    const operator = userByEmail('owner@sharkfitness.in');
    const created = createSession(user.id, user.tenantId, '127.0.0.1', 'support browser', operator.id);
    const support = { cookie: `shark_session=${created.token}; shark_csrf=support-csrf`, csrfToken: 'support-csrf' };
    const browser = service.browser('ok');
    const refused = await call(support, 'POST', '/me/push-subscriptions', { endpoint: browser.endpoint, keys: browser.keys });
    expect(refused.status).toBe(403);
    expect(db.select().from(schema.pushSubscriptions).all()).toHaveLength(0);

    // A row tied to a support session (registered before this rule) gets nothing.
    const { id } = await subscribe(await aman());
    db.update(schema.pushSubscriptions).set({ sessionId: created.sessionId }).where(eq(schema.pushSubscriptions.id, id)).run();
    notifyUser(
      { tenantId: user.tenantId, userId: user.id, kind: 'k', title: 't', body: 'b', link: '/', push: { category: 'booking', dedupeKey: 'test:support' } },
      clockTomorrow('12:00'),
    );
    expect(db.select().from(schema.pushDeliveries).all()).toHaveLength(0);
  });

  it('pushes a staff message to the member: who wrote, never what they wrote', async () => {
    const user = userByEmail('aman@sharkfitness.in');
    const { browser } = await subscribe(await aman());
    const member = memberOf(user.id);
    const sent = await call(await reception(), 'POST', '/admin/members/bulk/message', {
      memberIds: [member.id],
      body: 'Your physio note about the left knee is ready.',
    });
    expect(sent.status).toBe(200);

    const queued = db.select().from(schema.pushDeliveries).all();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ category: 'message', userId: user.id });
    expect(queued[0]!.path).toMatch(/^\/messages\/cnv_/);

    const result = await deliverDuePushes(clockTomorrow('12:00'));
    expect(result.sent).toBe(1);
    const payload = JSON.parse(browser.decrypt(service.received[0]!.body)) as { title: string; body: string; path: string };
    expect(payload.title).toMatch(/^New message from \S+$/);
    expect(JSON.stringify(payload)).not.toContain('knee');
  });
});
