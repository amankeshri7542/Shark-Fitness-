import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { WebhookEnvelope } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { resetRateLimitsForTest } from '../middleware/index.js';
import { HOUR, MINUTE, now } from '../lib/time.js';
import { safePost } from '../lib/safe-http.js';
import { EXCLUDED_KEY_PATTERN } from '../services/integration-events.js';
import { totpCodeFor } from '../services/mfa.js';
import {
  DISABLE_AFTER_CONSECUTIVE_FAILURES,
  RETRY_DELAYS_MS,
  runWebhookDispatch,
  setWebhookNetworkForTest,
} from '../services/webhooks.js';
import { Browser, auditActions, newGym, type TestGym } from './helpers/browser.js';

/** PF-INT-003: signed, retried, SSRF-safe outbound webhooks, against a local receiver. */

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let port = 0;
const received: Received[] = [];
let answer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.writeHead(200).end('ok');

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      answer(req, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

beforeEach(() => {
  resetRateLimitsForTest();
  received.length = 0;
  answer = (_req, res) => res.writeHead(200).end('ok');
});
afterEach(() => {
  setWebhookNetworkForTest({ resolver: null, policy: null });
  // Each test owns its endpoints: retire them so a later test's clock jump
  // does not wake an earlier test's pending retries.
  db.update(schema.webhookEndpoints).set({ deletedAt: now(), state: 'paused' }).run();
});

async function ownerOf(gym: TestGym): Promise<Browser> {
  const browser = new Browser();
  await browser.signIn(gym.slug, gym.owner.email, gym.owner.password);
  const started = await browser.json<{ secret: string }>('/auth/mfa/enrol/start', { method: 'POST' });
  expect((await browser.request('/auth/mfa/enrol/confirm', { body: { code: totpCodeFor(started.body.secret) } })).status).toBe(200);
  return browser;
}

async function setup(events: string[] = ['lead.created', 'lead.converted', 'member.created']) {
  const gym = newGym('hooks');
  const owner = await ownerOf(gym);
  const created = await owner.json<{ endpoint: { id: string; secretHint: string }; secret: string }>('/admin/integrations/webhooks', {
    body: { url: `http://127.0.0.1:${port}/hook`, description: 'CRM sync', events },
  });
  expect(created.status).toBe(201);
  expect(created.body.secret).toMatch(/^whsec_[\w-]{43}$/);
  expect(created.body.endpoint.secretHint).toBe(created.body.secret.slice(-4));
  return { gym, owner, endpointId: created.body.endpoint.id, secret: created.body.secret };
}

async function createLead(owner: Browser, gym: TestGym, name = 'Priya Raman'): Promise<string> {
  const response = await owner.json<{ id: string }>('/admin/leads', {
    body: { name, email: `${name.split(' ')[0]!.toLowerCase()}.lead@example.com`, phone: '+91 98450 12345', source: 'walk_in', branchId: gym.branchId },
  });
  expect(response.status).toBe(201);
  return response.body.id;
}

function parseSignature(header: string): { t: number; v1: string[] } {
  const parts = header.split(',').map((part) => part.split('='));
  return { t: Number(parts.find(([key]) => key === 't')![1]), v1: parts.filter(([key]) => key === 'v1').map(([, value]) => value!) };
}

/** The verification recipe documented for consumers in docs/SECURITY.md. */
function verifies(secret: string, header: string, body: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const { t, v1 } = parseSignature(header);
  if (Math.abs(nowSec - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return v1.includes(expected);
}

function deliveriesOf(endpointId: string) {
  return db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.endpointId, endpointId)).all();
}

describe('delivery and signing', () => {
  it('signs every delivery so the documented HMAC recipe verifies it', async () => {
    const { gym, owner, secret } = await setup();
    await createLead(owner, gym);
    const run = await runWebhookDispatch();
    expect(run).toMatchObject({ queued: 1, attempted: 1, succeeded: 1 });
    expect(received).toHaveLength(1);
    const [delivery] = received;
    expect(delivery!.headers['content-type']).toBe('application/json');
    expect(delivery!.headers['shark-event-type']).toBe('lead.created');
    expect(verifies(secret, String(delivery!.headers['shark-signature']), delivery!.body)).toBe(true);
    expect(verifies(secret, String(delivery!.headers['shark-signature']), `${delivery!.body} `)).toBe(false);
    expect(verifies('whsec_wrong', String(delivery!.headers['shark-signature']), delivery!.body)).toBe(false);

    const envelope = WebhookEnvelope.parse(JSON.parse(delivery!.body));
    expect(envelope).toMatchObject({ type: 'lead.created', version: 1, tenant: { id: gym.tenantId, slug: gym.slug } });
    expect(envelope.id).toBe(delivery!.headers['shark-event-id']);
    // Nothing is sent twice.
    expect((await runWebhookDispatch()).attempted).toBe(0);
  });

  it('sends minimal data: no names, contact details, notes or other excluded fields', async () => {
    const { gym, owner } = await setup();
    const leadId = await createLead(owner, gym, 'Kavya Iyer');
    expect((await owner.request(`/admin/leads/${leadId}/convert`, { method: 'POST' })).status).toBe(200);
    await runWebhookDispatch();
    expect(received.map((entry) => entry.headers['shark-event-type']).sort()).toEqual(['lead.converted', 'lead.created', 'member.created']);
    for (const entry of received) {
      expect(entry.body).not.toMatch(/Kavya|Iyer|kavya\.lead@example\.com|98450|12345/);
      const envelope = WebhookEnvelope.parse(JSON.parse(entry.body));
      for (const key of Object.keys(envelope.data)) expect(key).not.toMatch(EXCLUDED_KEY_PATTERN);
    }
  });

  it('sends only the events an endpoint subscribed to, and nothing from before it existed', async () => {
    const gym = newGym('subscribe');
    const owner = await ownerOf(gym);
    await createLead(owner, gym, 'Before Endpoint');
    const created = await owner.json<{ endpoint: { id: string } }>('/admin/integrations/webhooks', {
      body: { url: `http://127.0.0.1:${port}/hook`, events: ['lead.converted'] },
    });
    await createLead(owner, gym, 'After Endpoint');
    await runWebhookDispatch();
    expect(received).toHaveLength(0);
    expect(deliveriesOf(created.body.endpoint.id)).toHaveLength(0);
  });

  it('records a test send without counting it against the endpoint', async () => {
    const { owner, endpointId } = await setup();
    answer = (_req, res) => res.writeHead(500).end('receiver down');
    const test = await owner.json<{ delivery: { eventType: string; state: string; log: Array<{ statusCode: number; responseExcerpt: string }> } }>(
      `/admin/integrations/webhooks/${endpointId}/test`,
      { method: 'POST' },
    );
    expect(test.status).toBe(200);
    // One attempt, never retried.
    expect(test.body.delivery).toMatchObject({ eventType: 'webhook.test', state: 'failed', nextAttemptAt: null });
    expect(test.body.delivery.log[0]).toMatchObject({ statusCode: 500, responseExcerpt: 'receiver down' });
    expect(db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpointId)).get()!.consecutiveFailures).toBe(0);
  });
});

describe('retries', () => {
  it('retries a 500 on the backoff schedule and gives up within 24 hours', async () => {
    const { gym, owner, endpointId } = await setup();
    answer = (_req, res) => res.writeHead(500).end('nope');
    await createLead(owner, gym);
    const start = now();
    await runWebhookDispatch(() => start);
    let [delivery] = deliveriesOf(endpointId);
    expect(delivery).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: start + RETRY_DELAYS_MS[0] });

    // Not due yet: nothing is sent early.
    await runWebhookDispatch(() => start + 30_000);
    expect(received).toHaveLength(1);

    let clock = start;
    for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
      clock += delay;
      await runWebhookDispatch(() => clock);
      [delivery] = deliveriesOf(endpointId);
      expect(delivery!.attempts).toBe(index + 2);
    }
    expect(delivery).toMatchObject({ state: 'failed', nextAttemptAt: null });
    expect(delivery!.completedAt! - start).toBeLessThanOrEqual(24 * HOUR);
    expect(received).toHaveLength(RETRY_DELAYS_MS.length + 1);
    const attempts = db.select().from(schema.webhookAttempts).where(eq(schema.webhookAttempts.deliveryId, delivery!.id)).all();
    expect(attempts.map((row) => row.statusCode)).toEqual(Array(RETRY_DELAYS_MS.length + 1).fill(500));
    expect(attempts.every((row) => row.responseExcerpt === 'nope' && row.latencyMs >= 0)).toBe(true);
  });

  it('succeeds on a later attempt and resets the failure count', async () => {
    const { gym, owner, endpointId } = await setup();
    let failures = 2;
    answer = (_req, res) => (failures-- > 0 ? res.writeHead(503).end() : res.writeHead(204).end());
    await createLead(owner, gym);
    const start = now();
    await runWebhookDispatch(() => start);
    await runWebhookDispatch(() => start + MINUTE);
    await runWebhookDispatch(() => start + MINUTE + 5 * MINUTE);
    expect(deliveriesOf(endpointId)[0]).toMatchObject({ state: 'succeeded', attempts: 3 });
    expect(db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpointId)).get()!.consecutiveFailures).toBe(0);
  });

  it(`turns an endpoint off after ${DISABLE_AFTER_CONSECUTIVE_FAILURES} failures in a row and tells the owner`, async () => {
    const { gym, owner, endpointId } = await setup();
    answer = (_req, res) => res.writeHead(500).end();
    for (let index = 0; index < DISABLE_AFTER_CONSECUTIVE_FAILURES + 2; index += 1) await createLead(owner, gym, `Lead Number${index}`);
    await runWebhookDispatch();
    const endpoint = db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpointId)).get()!;
    expect(endpoint.state).toBe('disabled');
    expect(endpoint.disabledReason).toMatch(/15 failed deliveries/);
    // Attempts stop at the threshold even though more were due.
    expect(received.length).toBeLessThanOrEqual(DISABLE_AFTER_CONSECUTIVE_FAILURES + 4);
    received.length = 0;
    await runWebhookDispatch(() => now() + HOUR);
    expect(received).toHaveLength(0);

    const notification = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.tenantId, gym.tenantId), eq(schema.notifications.kind, 'integration_down')))
      .get();
    expect(notification).toMatchObject({ userId: gym.owner.userId, link: '/settings?tab=integrations' });
    expect(auditActions(gym.tenantId, endpointId)).toContain('webhook.endpoint_disabled');
    const dashboard = await owner.json<{ alerts: Array<{ kind: string; actionTo: string }> }>('/admin/dashboard');
    expect(dashboard.body.alerts).toContainEqual(expect.objectContaining({ kind: 'integration_down', actionTo: '/settings?tab=integrations' }));

    // Turning it back on resets the count and sends the backlog.
    answer = (_req, res) => res.writeHead(200).end();
    const resumed = await owner.json<{ endpoint: { state: string; consecutiveFailures: number } }>(`/admin/integrations/webhooks/${endpointId}`, {
      method: 'PATCH',
      body: { state: 'active' },
    });
    expect(resumed.body.endpoint).toMatchObject({ state: 'active', consecutiveFailures: 0 });
    await runWebhookDispatch();
    expect(received.length).toBeGreaterThan(0);
  });
});

describe('replay and rotation', () => {
  it('replays a delivery with the same event id', async () => {
    const { gym, owner, endpointId } = await setup();
    await createLead(owner, gym);
    await runWebhookDispatch();
    const [original] = deliveriesOf(endpointId);
    const replay = await owner.json<{ delivery: { replayOf: string; eventId: string; state: string } }>(
      `/admin/integrations/webhooks/deliveries/${original!.id}/replay`,
      { method: 'POST' },
    );
    expect(replay.status).toBe(200);
    expect(replay.body.delivery).toMatchObject({ replayOf: original!.id, eventId: original!.eventId, state: 'succeeded' });
    expect(received).toHaveLength(2);
    expect(received[1]!.headers['shark-event-id']).toBe(received[0]!.headers['shark-event-id']);
    expect(received[1]!.body).toBe(received[0]!.body);
    expect(auditActions(gym.tenantId, original!.id)).toContain('webhook.delivery_replayed');
    const log = await owner.json<{ items: Array<{ id: string; log: unknown[] }> }>(`/admin/integrations/webhooks/${endpointId}/deliveries`);
    expect(log.body.items).toHaveLength(2);
  });

  it('dual-signs with the old and new secrets for 24 hours after a rotation', async () => {
    const { gym, owner, endpointId, secret: oldSecret } = await setup();
    const rotated = await owner.json<{ secret: string; endpoint: { previousSecretExpiresAt: string } }>(
      `/admin/integrations/webhooks/${endpointId}/rotate-secret`,
      { method: 'POST' },
    );
    expect(rotated.status).toBe(200);
    const newSecret = rotated.body.secret;
    expect(newSecret).not.toBe(oldSecret);
    expect(Date.parse(rotated.body.endpoint.previousSecretExpiresAt) - now()).toBeGreaterThan(23 * HOUR);

    await createLead(owner, gym);
    await runWebhookDispatch();
    const header = String(received[0]!.headers['shark-signature']);
    expect(parseSignature(header).v1).toHaveLength(2);
    expect(verifies(newSecret, header, received[0]!.body)).toBe(true);
    expect(verifies(oldSecret, header, received[0]!.body)).toBe(true);

    // A day later only the new secret signs.
    await createLead(owner, gym, 'Next Day');
    const later = now() + 24 * HOUR + MINUTE;
    await runWebhookDispatch(() => later);
    const nextHeader = String(received[1]!.headers['shark-signature']);
    expect(parseSignature(nextHeader).v1).toHaveLength(1);
    expect(verifies(newSecret, nextHeader, received[1]!.body, Math.floor(later / 1000))).toBe(true);
    expect(verifies(oldSecret, nextHeader, received[1]!.body, Math.floor(later / 1000))).toBe(false);
    expect(auditActions(gym.tenantId, endpointId)).toEqual(expect.arrayContaining(['webhook.endpoint_created', 'webhook.secret_rotated']));
  });

  it('keeps secrets out of the audit log, the database and the endpoint list', async () => {
    const { gym, owner, endpointId, secret } = await setup();
    const revealed = await owner.json<{ secret: string }>(`/admin/integrations/webhooks/${endpointId}/secret`);
    expect(revealed.body.secret).toBe(secret);
    const rows = db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, gym.tenantId)).all();
    expect(rows.map((row) => row.action)).toContain('webhook.secret_revealed');
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpointId)).get())).not.toContain(secret);
    const list = await owner.request('/admin/integrations/webhooks');
    expect(await list.text()).not.toContain(secret);
  });
});

describe('SSRF defences', () => {
  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['the metadata address over https', 'https://169.254.169.254/latest/meta-data/'],
    ['a 10.x address', 'https://10.1.2.3/hook'],
    ['a 192.168 address', 'https://192.168.1.10/hook'],
    ['localhost in production', 'https://localhost/hook'],
    ['loopback in production', 'https://127.0.0.1/hook'],
    ['IPv6 loopback in production', 'https://[::1]/hook'],
    ['an IPv4-mapped private address', 'https://[::ffff:10.0.0.1]/hook'],
    ['plain http in production', 'http://hooks.example.com/hook'],
    ['credentials in the URL', 'https://user:pass@hooks.example.com/hook'],
  ])('refuses %s when the endpoint is saved', async (_label, url) => {
    setWebhookNetworkForTest({ policy: { production: true } });
    const gym = newGym('ssrf');
    const owner = await ownerOf(gym);
    const response = await owner.json<{ error: { code: string } }>('/admin/integrations/webhooks', { body: { url, events: ['lead.created'] } });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a host name that resolves to a private address, without connecting', async () => {
    const { gym, owner, endpointId } = await setup();
    setWebhookNetworkForTest({ resolver: async () => [{ address: '10.0.0.7', family: 4 }] });
    db.update(schema.webhookEndpoints).set({ url: 'http://hooks.rebind.example/hook' }).where(eq(schema.webhookEndpoints.id, endpointId)).run();
    await createLead(owner, gym);
    await runWebhookDispatch();
    expect(received).toHaveLength(0);
    const attempt = db.select().from(schema.webhookAttempts).where(eq(schema.webhookAttempts.endpointId, endpointId)).get()!;
    expect(attempt.error).toMatch(/resolves to a private, link-local or reserved address; not contacted/);
    // Any one bad address in the answer is enough to refuse.
    setWebhookNetworkForTest({ resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }] });
    const mixed = await safePost('http://hooks.mixed.example/hook', '{}', {}, { production: false }, async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    expect(mixed.ok).toBe(false);
    expect(mixed.error).toMatch(/not contacted/);
  });

  it('does not follow a redirect', async () => {
    const { gym, owner, endpointId } = await setup();
    answer = (_req, res) => res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    await createLead(owner, gym);
    await runWebhookDispatch();
    expect(received).toHaveLength(1);
    const attempt = db.select().from(schema.webhookAttempts).where(eq(schema.webhookAttempts.endpointId, endpointId)).get()!;
    expect(attempt).toMatchObject({ ok: false, statusCode: 302 });
    expect(attempt.error).toMatch(/redirect/);
  });

  it('reads at most 64 KB of an answer', async () => {
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(1024 * 1024));
    };
    const result = await safePost(`http://127.0.0.1:${port}/big`, '{}', {}, { production: false });
    expect(result.ok).toBe(true);
    expect(result.responseExcerpt).toHaveLength(1024);
  });

  it('gives up on a receiver that does not answer within 5 seconds', async () => {
    answer = () => undefined; // never responds
    const result = await safePost(`http://127.0.0.1:${port}/slow`, '{}', {}, { production: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No answer within 5 seconds/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(4_900);
  }, 10_000);
});
