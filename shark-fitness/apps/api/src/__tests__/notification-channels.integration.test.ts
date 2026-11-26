import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { parseRuntimeConfig } from '../lib/config.js';
import {
  driversFromConfig,
  msg91Driver,
  resendDriver,
  setNotificationDrivers,
  twilioDriver,
  whatsappCloudDriver,
} from '../services/notifications/drivers.js';
import {
  channelAvailability,
  processNotificationQueue,
  queueNotification,
  type NotifyInput,
} from '../services/notifications/service.js';
import { blockedRequests } from './helpers/network-guard.js';
import { memberIdFor, setConsent, userIdFor } from './helpers/session.js';

/* ============================================================================
   Notification channels (P07 AC1; PF-COMM-002, PF-COMM-005).

   Real drivers are exercised only against fake provider servers on
   127.0.0.1. The network guard (helpers/network-guard.ts) refuses any other
   host for every test file; the last test here proves it is in force and that
   this suite never tried to reach a real provider.
   ========================================================================= */

const TENANT = 'ten_shark';
const EMAIL = 'aman@sharkfitness.in';
let userId = '';
let memberId = '';
let originalPhone: string | null = null;

/** 12:00 in Bengaluru on a weekday — outside the default 21:00–08:00 quiet hours. */
const NOON_IST = Date.UTC(2026, 10, 26, 6, 30);
/** 23:00 in Bengaluru the same day — inside quiet hours. */
const LATE_IST = Date.UTC(2026, 10, 26, 17, 30);
/** 08:00 the next morning in Bengaluru. */
const MORNING_IST = Date.UTC(2026, 10, 27, 2, 30);

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A provider stand-in: answers each request with the next scripted reply. */
class FakeProvider {
  server: Server;
  requests: Recorded[] = [];
  replies: Array<{ status: number; body: unknown }> = [];
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        this.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
        const reply = this.replies.shift() ?? { status: 200, body: {} };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  reset(replies: Array<{ status: number; body: unknown }> = []): void {
    this.requests = [];
    this.replies = replies;
  }
}

const fake = new FakeProvider();

function message(overrides: Partial<NotifyInput> = {}): NotifyInput {
  return {
    tenantId: TENANT,
    userId,
    memberId,
    channel: 'sms',
    purpose: 'operational',
    source: 'test',
    title: 'Class moved',
    body: 'Hi {{firstName}}, your 7am class is now in Studio 2.',
    variables: { firstName: 'Aman' },
    ...overrides,
  };
}

function row(deliveryId: string) {
  return db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, deliveryId)).get()!;
}

beforeAll(async () => {
  await fake.start();
  userId = userIdFor(EMAIL);
  memberId = memberIdFor(EMAIL);
  originalPhone = db.select({ phone: schema.users.phone }).from(schema.users).where(eq(schema.users.id, userId)).get()?.phone ?? null;
  db.update(schema.users).set({ phone: '+919812345678' }).where(eq(schema.users.id, userId)).run();
});

afterEach(() => {
  setNotificationDrivers(null);
  db.delete(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.source, 'test')).run();
});

afterAll(async () => {
  await fake.stop();
  db.update(schema.users).set({ phone: originalPhone }).where(eq(schema.users.id, userId)).run();
  db.delete(schema.notifications).where(and(eq(schema.notifications.userId, userId), like(schema.notifications.title, 'Test:%'))).run();
});

describe('the log driver (default everywhere)', () => {
  it('records the attempt as logged, not delivered, and calls nothing', async () => {
    expect(driversFromConfig(parseRuntimeConfig({})).sms.name).toBe('log');
    const queued = queueNotification(message(), NOON_IST);
    expect(queued.state).toBe('queued');

    const summary = await processNotificationQueue(NOON_IST);
    expect(summary.logged).toBeGreaterThanOrEqual(1);

    const saved = row(queued.deliveryId);
    expect(saved).toMatchObject({ state: 'logged', provider: 'log', providerMessageId: null, attempts: 1 });
    expect(saved.reason).toBe('Logged, not delivered: no SMS provider is configured.');
    expect(saved.destinationHint).toBe('+91•••••45678');
    expect(fake.requests).toHaveLength(0);
  });

  it('puts an in-app message in the inbox at once', () => {
    const queued = queueNotification(message({ channel: 'in_app', title: 'Test: in-app' }), NOON_IST);
    expect(queued.state).toBe('sent');
    const note = db.select().from(schema.notifications).where(eq(schema.notifications.id, queued.notificationId!)).get();
    expect(note).toMatchObject({ userId, title: 'Test: in-app', body: 'Hi Aman, your 7am class is now in Studio 2.' });
  });

  it('queues one message per dedupe key', () => {
    const first = queueNotification(message({ dedupeKey: 'test:class-moved:1' }), NOON_IST);
    const second = queueNotification(message({ dedupeKey: 'test:class-moved:1' }), NOON_IST);
    expect(second).toMatchObject({ deliveryId: first.deliveryId, duplicate: true });
    expect(db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.dedupeKey, 'test:class-moved:1')).all()).toHaveLength(1);
  });

  it('suppresses push until a push driver is registered (P04), and says why', () => {
    const queued = queueNotification(message({ channel: 'push' }), NOON_IST);
    expect(queued).toMatchObject({ state: 'suppressed', reason: 'push is not set up on this server.' });
    expect(channelAvailability().find((c) => c.channel === 'push')).toMatchObject({ available: false });
    expect(channelAvailability().find((c) => c.channel === 'sms')).toMatchObject({ available: true, delivers: false, driver: 'log' });
  });
});

describe('real drivers against local fakes', () => {
  it('records the provider id from Resend, Twilio, MSG91 and the WhatsApp Cloud API', async () => {
    setNotificationDrivers({
      email: resendDriver({ apiKey: 're_test', from: 'Shark <hello@example.test>' }, fetch, fake.url),
      sms: twilioDriver({ accountSid: 'ACtest', authToken: 'tok', from: '+15550001111' }, fetch, fake.url),
      whatsapp: whatsappCloudDriver({ accessToken: 'wa_test', phoneNumberId: '1234', language: 'en' }, fetch, fake.url),
    });
    fake.reset([
      { status: 200, body: { id: 're_abc123' } },
      { status: 201, body: { sid: 'SM_twilio_1' } },
      { status: 200, body: { messages: [{ id: 'wamid.HBgL' }] } },
    ]);

    const email = queueNotification(message({ channel: 'email', purpose: 'transactional' }), NOON_IST);
    await processNotificationQueue(NOON_IST);
    const sms = queueNotification(message({ purpose: 'transactional' }), NOON_IST);
    await processNotificationQueue(NOON_IST);
    const whatsapp = queueNotification(
      message({ channel: 'whatsapp', purpose: 'transactional', providerTemplate: 'class_moved' }),
      NOON_IST,
    );
    await processNotificationQueue(NOON_IST);

    expect(row(email.deliveryId)).toMatchObject({ state: 'sent', provider: 'resend', providerMessageId: 're_abc123' });
    expect(row(sms.deliveryId)).toMatchObject({ state: 'sent', provider: 'twilio', providerMessageId: 'SM_twilio_1' });
    expect(row(whatsapp.deliveryId)).toMatchObject({ state: 'sent', provider: 'whatsapp-cloud', providerMessageId: 'wamid.HBgL' });

    const [resendCall, twilioCall, whatsappCall] = fake.requests;
    expect(resendCall).toMatchObject({ path: '/emails' });
    expect(resendCall!.headers.authorization).toBe('Bearer re_test');
    expect(JSON.parse(resendCall!.body)).toMatchObject({ to: [EMAIL], subject: 'Class moved' });
    expect(twilioCall!.path).toBe('/2010-04-01/Accounts/ACtest/Messages.json');
    expect(new URLSearchParams(twilioCall!.body).get('Body')).toBe('Hi Aman, your 7am class is now in Studio 2.');
    expect(whatsappCall!.path).toBe('/1234/messages');
    expect(JSON.parse(whatsappCall!.body)).toMatchObject({
      to: '919812345678',
      type: 'template',
      template: { name: 'class_moved', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Aman' }] }] },
    });
  });

  it('sends MSG91 through a DLT flow and refuses a WhatsApp message without a template', async () => {
    setNotificationDrivers({
      sms: msg91Driver({ authKey: 'msg91_test', defaultFlowId: 'flow_default' }, fetch, fake.url),
      whatsapp: whatsappCloudDriver({ accessToken: 'wa_test', phoneNumberId: '1234', language: 'en' }, fetch, fake.url),
    });
    fake.reset([{ status: 200, body: { type: 'success', message: 'msg91-req-77' } }]);

    const sms = queueNotification(message({ purpose: 'transactional' }), NOON_IST);
    const whatsapp = queueNotification(message({ channel: 'whatsapp', purpose: 'transactional' }), NOON_IST);
    await processNotificationQueue(NOON_IST);

    expect(row(sms.deliveryId)).toMatchObject({ state: 'sent', provider: 'msg91', providerMessageId: 'msg91-req-77' });
    expect(JSON.parse(fake.requests[0]!.body)).toMatchObject({ template_id: 'flow_default', recipients: [{ mobiles: '919812345678', var1: 'Aman' }] });
    expect(row(whatsapp.deliveryId)).toMatchObject({ state: 'failed', reason: 'WhatsApp needs an approved template name for this message.' });
    expect(fake.requests).toHaveLength(1);
  });

  it('retries a 5xx a bounded number of times, then stops', async () => {
    setNotificationDrivers({ sms: twilioDriver({ accountSid: 'ACtest', authToken: 'tok', from: '+15550001111' }, fetch, fake.url) });
    fake.reset([
      { status: 503, body: { message: 'unavailable' } },
      { status: 500, body: { message: 'oops' } },
      { status: 502, body: { message: 'bad gateway' } },
      { status: 201, body: { sid: 'never-reached' } },
    ]);
    const queued = queueNotification(message(), NOON_IST);

    await processNotificationQueue(NOON_IST);
    expect(row(queued.deliveryId)).toMatchObject({ state: 'queued', attempts: 1, dueAt: NOON_IST + 60_000 });
    expect(row(queued.deliveryId).reason).toContain('Retry 2 of 3 is queued.');

    // Not due yet: nothing happens.
    await processNotificationQueue(NOON_IST + 30_000);
    expect(fake.requests).toHaveLength(1);

    await processNotificationQueue(NOON_IST + 60_000);
    expect(row(queued.deliveryId)).toMatchObject({ state: 'queued', attempts: 2, dueAt: NOON_IST + 60_000 + 300_000 });

    await processNotificationQueue(NOON_IST + 360_000);
    const final = row(queued.deliveryId);
    expect(final).toMatchObject({ state: 'failed', attempts: 3, providerMessageId: null });
    expect(final.reason).toContain('Twilio answered 502');
    expect(final.reason).toContain('Stopped after 3 attempts.');

    await processNotificationQueue(NOON_IST + 3_600_000);
    expect(fake.requests).toHaveLength(3);
  });

  it('does not retry a 4xx: the provider will refuse it again', async () => {
    setNotificationDrivers({ email: resendDriver({ apiKey: 're_test', from: 'x@example.test' }, fetch, fake.url) });
    fake.reset([{ status: 422, body: { message: 'Invalid `to` field' } }]);
    const queued = queueNotification(message({ channel: 'email' }), NOON_IST);
    await processNotificationQueue(NOON_IST);
    expect(row(queued.deliveryId)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(row(queued.deliveryId).reason).toContain('Resend answered 422');
    await processNotificationQueue(NOON_IST + 3_600_000);
    expect(fake.requests).toHaveLength(1);
  });

  it('retries when the provider does not answer at all', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    setNotificationDrivers({ email: resendDriver({ apiKey: 're_test', from: 'x@example.test' }, fetch, deadUrl) });
    const queued = queueNotification(message({ channel: 'email' }), NOON_IST);
    await processNotificationQueue(NOON_IST);
    expect(row(queued.deliveryId)).toMatchObject({ state: 'queued', attempts: 1 });
    expect(row(queued.deliveryId).reason).toContain('Resend did not answer');
  });
});

describe('checks that stop a send', () => {
  it('re-checks consent at send time: an opt-out after queueing prevents the send', async () => {
    setNotificationDrivers({ sms: twilioDriver({ accountSid: 'ACtest', authToken: 'tok', from: '+15550001111' }, fetch, fake.url) });
    fake.reset();
    const before = setConsent(userId, 'marketing_sms', true);
    try {
      const queued = queueNotification(message({ purpose: 'promotional', title: 'Offer' }), NOON_IST);
      expect(queued.state).toBe('queued');

      setConsent(userId, 'marketing_sms', false);
      await processNotificationQueue(NOON_IST);

      const saved = row(queued.deliveryId);
      expect(saved.state).toBe('suppressed');
      expect(saved.reason).toBe('They withdrew consent for SMS offers. (changed after this was queued; not sent).');
      expect(fake.requests).toHaveLength(0);
    } finally {
      setConsent(userId, 'marketing_sms', before);
    }
  });

  it('refuses a promotional message the member never agreed to, at enqueue', () => {
    const before = setConsent(userId, 'marketing_whatsapp', null);
    try {
      const queued = queueNotification(message({ channel: 'whatsapp', purpose: 'promotional', providerTemplate: 'offer' }), NOON_IST);
      expect(queued).toMatchObject({ state: 'suppressed', reason: 'They have not agreed to WhatsApp offers.' });
    } finally {
      setConsent(userId, 'marketing_whatsapp', before);
    }
  });

  it('refuses to send a message with a missing template variable, and records why', async () => {
    const queued = queueNotification(message({ body: 'Hi {{firstName}}, your plan ends on {{endsOn}}.', variables: { firstName: 'Aman' } }), NOON_IST);
    expect(queued.state).toBe('failed');
    expect(row(queued.deliveryId).reason).toBe('Not sent: the message needs {{endsOn}} and it has no value.');
    await processNotificationQueue(NOON_IST);
    expect(row(queued.deliveryId)).toMatchObject({ state: 'failed', attempts: 0 });
  });

  it('defers for quiet hours in the branch timezone, then sends in the morning', async () => {
    const queued = queueNotification(message(), LATE_IST);
    expect(queued).toMatchObject({ state: 'deferred', reason: 'Held for quiet hours at the branch.' });
    expect(row(queued.deliveryId).dueAt).toBe(MORNING_IST);

    await processNotificationQueue(LATE_IST + 30 * 60_000);
    expect(row(queued.deliveryId).state).toBe('deferred');

    await processNotificationQueue(MORNING_IST);
    expect(row(queued.deliveryId)).toMatchObject({ state: 'logged', attempts: 1 });
  });

  it('does not hold a transactional message or the in-app inbox for quiet hours', () => {
    expect(queueNotification(message({ purpose: 'transactional' }), LATE_IST).state).toBe('queued');
    expect(queueNotification(message({ channel: 'in_app', title: 'Test: late' }), LATE_IST).state).toBe('sent');
  });
});

describe('network guard', () => {
  it('refuses real provider hosts, and nothing in this suite tried one', async () => {
    expect(blockedRequests).toEqual([]);
    await expect(fetch('https://api.resend.com/emails', { method: 'POST' })).rejects.toThrow(/Network guard/);
    expect(blockedRequests).toEqual(['fetch api.resend.com']);
    blockedRequests.length = 0;
  });
});
