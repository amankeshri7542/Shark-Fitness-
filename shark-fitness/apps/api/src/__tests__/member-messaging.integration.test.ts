import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { localDiskStorage, setMediaStorage, signMediaPath } from '../lib/media-storage.js';
import { call, headers, memberIdFor, signIn, type TestSession } from './helpers/session.js';

/* ============================================================================
   Member-started conversations, the staff Inbox and attachments (P07 AC2;
   PF-COMM-001, UX-M12, PRD 04 ENT-CHILD-001/003).
   ========================================================================= */

const AMAN = 'aman@sharkfitness.in';
const ROHIT = 'rohit@sharkfitness.in';
const COACH = 'rehan@sharkfitness.in'; // Aman's trainer
const OTHER_COACH = 'nikhil@sharkfitness.in';
const DESK = 'reception@sharkfitness.in';
const MANAGER = 'manager@sharkfitness.in';

const NOTE = 'INTERNAL-NOTE: knee history, ask about the physio letter (zebra-42)';
const created: string[] = [];
let mediaDir = '';
let amanId = '';
let originalDob: string | null = null;

let aman: TestSession;
let rohit: TestSession;
let coach: TestSession;
let otherCoach: TestSession;
let desk: TestSession;
let manager: TestSession;

const clientId = () => `cid-${Math.random().toString(36).slice(2, 12)}`;

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function start(session: TestSession, to: 'coach' | 'desk', body = 'Can I swap my Thursday session?'): Promise<Response> {
  const response = await call(session, 'POST', '/v1/member/messages/start', { to, topic: 'booking', body, clientId: clientId() });
  if (response.status === 201) created.push(((await response.clone().json()) as { conversationId: string }).conversationId);
  return response;
}

/** A small JPEG whose APP1 segment carries an Exif block with a GPS tag. */
function jpegWithGps(): Uint8Array {
  const exif = Buffer.from('Exif\0\0GPSLatitude=12.9352;GPSLongitude=77.6245', 'latin1');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif]);
  const dqt = Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x01]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, dqt, sos]));
}

async function upload(session: TestSession, conversationId: string, bytes: Uint8Array, name: string, type: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type }));
  const h = headers(session);
  delete (h as Record<string, string>)['content-type'];
  return app.request(`/v1/member/messages/${conversationId}/attachments`, { method: 'POST', headers: h, body: form });
}

beforeAll(async () => {
  mediaDir = mkdtempSync(join(tmpdir(), 'shark-media-test-'));
  setMediaStorage(localDiskStorage(mediaDir));
  amanId = memberIdFor(AMAN);
  originalDob = db.select({ dob: schema.members.dob }).from(schema.members).where(eq(schema.members.id, amanId)).get()?.dob ?? null;
  [aman, rohit, coach, otherCoach, desk, manager] = await Promise.all([
    signIn(AMAN),
    signIn(ROHIT),
    signIn(COACH),
    signIn(OTHER_COACH),
    signIn(DESK),
    signIn(MANAGER),
  ]);
});

afterAll(() => {
  setMediaStorage(undefined);
  rmSync(mediaDir, { recursive: true, force: true });
  db.update(schema.members).set({ dob: originalDob }).where(eq(schema.members.id, amanId)).run();
  if (created.length) {
    db.delete(schema.messageAttachments).where(inArray(schema.messageAttachments.conversationId, created)).run();
    db.delete(schema.conversationNotes).where(inArray(schema.conversationNotes.conversationId, created)).run();
    db.delete(schema.messages).where(inArray(schema.messages.conversationId, created)).run();
    db.delete(schema.notificationDeliveries).where(inArray(schema.notificationDeliveries.sourceId, created)).run();
    db.delete(schema.conversations).where(inArray(schema.conversations.id, created)).run();
  }
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, 'ten_shark')).get()!;
  const policy = { ...(tenant.policy as Record<string, unknown>) };
  delete policy.allowStaffMinorMessaging;
  db.update(schema.tenants).set({ policy: policy as never }).where(eq(schema.tenants.id, 'ten_shark')).run();
});

describe('starting a conversation', () => {
  it('offers the coach and the branch desk with their hours before anything is typed', async () => {
    const inbox = await json<{ start: { coach: { name: string; responseWindow: string }; desk: { name: string; responseWindow: string }; topics: unknown[]; blocked: boolean } }>(
      await call(aman, 'GET', '/v1/member/messages'),
    );
    expect(inbox.start.blocked).toBe(false);
    expect(inbox.start.coach.name).toBeTruthy();
    expect(inbox.start.coach.responseWindow).toMatch(/^Replies usually within/);
    expect(inbox.start.desk.name).toMatch(/front desk$/);
    expect(inbox.start.topics.length).toBeGreaterThan(3);
  });

  it('starts a coach thread the coach sees and the desk does not', async () => {
    const response = await start(aman, 'coach', 'My knee clicks on squats — should I keep going?');
    expect(response.status).toBe(201);
    const { conversationId, responseWindow } = await json<{ conversationId: string; responseWindow: string }>(response);
    expect(responseWindow).toMatch(/Replies usually within/);

    const mine = await json<{ items: Array<{ id: string; kind: string }> }>(await call(aman, 'GET', '/v1/member/messages'));
    expect(mine.items.find((i) => i.id === conversationId)?.kind).toBe('coach');

    const coachInbox = await json<{ items: Array<{ id: string; needsReply: boolean }> }>(await call(coach, 'GET', '/v1/admin/inbox'));
    expect(coachInbox.items.find((i) => i.id === conversationId)).toMatchObject({ needsReply: true });

    expect((await call(desk, 'GET', `/v1/admin/inbox/${conversationId}`)).status).toBe(404);
    expect((await call(otherCoach, 'GET', `/v1/admin/inbox/${conversationId}`)).status).toBe(404);
    expect((await call(manager, 'GET', `/v1/admin/inbox/${conversationId}`)).status).toBe(200);
  });

  it('starts a front-desk thread the desk sees and coaches do not', async () => {
    const response = await start(aman, 'desk');
    expect(response.status).toBe(201);
    const { conversationId } = await json<{ conversationId: string }>(response);

    const deskInbox = await json<{ items: Array<{ id: string; kindLabel: string }> }>(await call(desk, 'GET', '/v1/admin/inbox?filter=unassigned'));
    expect(deskInbox.items.find((i) => i.id === conversationId)?.kindLabel).toBe('Front desk');
    expect((await call(coach, 'GET', `/v1/admin/inbox/${conversationId}`)).status).toBe(404);
  });

  it('returns the same thread when a start is retried with the same client id', async () => {
    const id = clientId();
    const first = await call(aman, 'POST', '/v1/member/messages/start', { to: 'desk', topic: 'other', body: 'Lost a bottle', clientId: id });
    const { conversationId } = await json<{ conversationId: string }>(first);
    created.push(conversationId);
    const again = await json<{ conversationId: string; duplicate: boolean }>(
      await call(aman, 'POST', '/v1/member/messages/start', { to: 'desk', topic: 'other', body: 'Lost a bottle', clientId: id }),
    );
    expect(again).toEqual({ conversationId, duplicate: true });
  });
});

describe('minors (plan decision 16)', () => {
  it('refuses staff↔minor threads unless the gym turns them on', async () => {
    db.update(schema.members).set({ dob: '2011-03-14' }).where(eq(schema.members.id, amanId)).run();
    try {
      const options = await json<{ start: { blocked: boolean; blockedReason: string } }>(await call(aman, 'GET', '/v1/member/messages'));
      expect(options.start.blocked).toBe(true);

      const refused = await start(aman, 'coach');
      expect(refused.status).toBe(403);
      expect((await json<{ error: { message: string; details: { reason: string } } }>(refused)).error).toMatchObject({
        message: expect.stringMatching(/members under 18 are switched off/),
        details: { reason: 'minor_messaging_disabled' },
      });

      const owner = await signIn('owner@sharkfitness.in');
      expect((await call(owner, 'PATCH', '/v1/admin/settings/engagement', { allowStaffMinorMessaging: true })).status).toBe(200);
      expect((await start(aman, 'coach')).status).toBe(201);
      expect((await call(owner, 'PATCH', '/v1/admin/settings/engagement', { allowStaffMinorMessaging: false })).status).toBe(200);
    } finally {
      db.update(schema.members).set({ dob: originalDob }).where(eq(schema.members.id, amanId)).run();
    }
  });
});

describe('the staff inbox', () => {
  it('replies, assigns, reads — and internal notes never reach any member-facing payload', async () => {
    const { conversationId } = await json<{ conversationId: string }>(await start(aman, 'desk', 'Is the steam room open on Sunday?'));

    expect((await call(desk, 'POST', `/v1/admin/inbox/${conversationId}/notes`, { body: NOTE })).status).toBe(201);
    const reply = await call(desk, 'POST', `/v1/admin/inbox/${conversationId}/reply`, { body: 'Yes, 7am to 1pm on Sundays.', clientId: clientId() });
    expect(reply.status).toBe(201);

    const staffView = await json<{ notes: Array<{ body: string }>; conversation: { assignee: { name: string } | null } }>(
      await call(desk, 'GET', `/v1/admin/inbox/${conversationId}`),
    );
    expect(staffView.notes.map((n) => n.body)).toContain(NOTE);
    expect(staffView.conversation.assignee).not.toBeNull();

    // Every member-facing read that could plausibly carry thread content.
    const memberPaths = [
      '/v1/member/messages',
      `/v1/member/messages/${conversationId}`,
      '/v1/member/messages/tickets',
      '/v1/member/home',
      '/v1/me',
      '/v1/me/notifications',
    ];
    for (const path of memberPaths) {
      const response = await call(aman, 'GET', path);
      expect(response.status, path).toBe(200);
      const text = await response.text();
      expect(text, path).not.toContain('zebra-42');
      expect(text, path).not.toContain('INTERNAL-NOTE');
    }

    const thread = await json<{ items: Array<{ body: string; fromMe: boolean; state: string }> }>(
      await call(aman, 'GET', `/v1/member/messages/${conversationId}`),
    );
    expect(thread.items.map((m) => m.body)).toContain('Yes, 7am to 1pm on Sundays.');
    // The desk replying read the member's message.
    expect(thread.items.find((m) => m.fromMe)?.state).toBe('read');
  });

  it('assigns only to staff who work at the branch, and 404s outside scope', async () => {
    const { conversationId } = await json<{ conversationId: string }>(await start(aman, 'desk', 'Locker key'));
    const reef = await signIn('owner@reefathletic.in', 'reef');
    expect((await call(reef, 'GET', `/v1/admin/inbox/${conversationId}`)).status).toBe(404);
    const owner = await signIn('owner@sharkfitness.in');
    const bad = await call(owner, 'POST', `/v1/admin/inbox/${conversationId}/assign`, { staffId: 'stf_does_not_exist' });
    expect(bad.status).toBe(422);
    const thread = await json<{ assignable: Array<{ staffId: string; roleLabel: string }> }>(await call(owner, 'GET', `/v1/admin/inbox/${conversationId}`));
    const target = thread.assignable.find((s) => s.roleLabel === 'Front desk')!;
    expect((await call(owner, 'POST', `/v1/admin/inbox/${conversationId}/assign`, { staffId: target.staffId })).status).toBe(200);
  });
});

describe('attachments', () => {
  let conversationId = '';
  let jpegUrl = '';
  let attachmentId = '';

  beforeAll(async () => {
    conversationId = (await json<{ conversationId: string }>(await start(aman, 'coach', 'Photo of the bruise'))).conversationId;
  });

  it('stores a photo without its GPS metadata and serves it through a signed URL', async () => {
    const response = await upload(aman, conversationId, jpegWithGps(), 'bruise.jpg', 'image/jpeg');
    expect(response.status).toBe(201);
    const { attachment } = await json<{ attachment: { id: string; mimeType: string; url: string } }>(response);
    attachmentId = attachment.id;
    expect(attachment.mimeType).toBe('image/jpeg');
    expect(attachment.url).toMatch(new RegExp(`^/v1/attachments/${attachmentId}\\?exp=\\d+&sig=`));

    const sent = await call(aman, 'POST', `/v1/member/messages/${conversationId}`, { clientId: clientId(), body: 'Here it is', attachmentIds: [attachmentId] });
    expect(sent.status).toBe(201);

    const thread = await json<{ items: Array<{ attachments: Array<{ id?: string; url?: string }> }> }>(
      await call(aman, 'GET', `/v1/member/messages/${conversationId}`),
    );
    jpegUrl = thread.items.flatMap((m) => m.attachments).find((a) => a.id === attachmentId)!.url!;

    const file = await call(aman, 'GET', jpegUrl);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(bytes.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(bytes.includes(Buffer.from('Exif'))).toBe(false);

    // The coach on the thread can open it; the staff inbox signs its own URL.
    const staff = await json<{ messages: Array<{ attachments: Array<{ url: string }> }> }>(await call(coach, 'GET', `/v1/admin/inbox/${conversationId}`));
    const staffUrl = staff.messages.flatMap((m) => m.attachments)[0]!.url;
    expect((await call(coach, 'GET', staffUrl)).status).toBe(200);
  });

  it('refuses everyone else, even with a valid link', async () => {
    expect((await call(rohit, 'GET', jpegUrl)).status).toBe(404);
    expect((await call(desk, 'GET', jpegUrl)).status).toBe(404);
    expect((await call(otherCoach, 'GET', jpegUrl)).status).toBe(404);
    expect((await app.request(jpegUrl)).status).toBe(401);
  });

  it('refuses an expired or tampered link', async () => {
    const expired = signMediaPath(`/v1/attachments/${attachmentId}`, Date.now() - 10 * 60_000);
    expect((await call(aman, 'GET', expired)).status).toBe(403);
    expect((await call(aman, 'GET', jpegUrl.replace(/sig=.{4}/, 'sig=AAAA'))).status).toBe(403);
    expect((await call(aman, 'GET', `/v1/attachments/${attachmentId}`)).status).toBe(403);
  });

  it('accepts a PDF, refuses a disguised script and an oversized file', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    expect((await upload(aman, conversationId, pdf, 'physio-letter.pdf', 'application/pdf')).status).toBe(201);

    const script = new TextEncoder().encode('<script>alert(1)</script>');
    const spoofed = await upload(aman, conversationId, script, 'holiday.jpg', 'image/jpeg');
    expect(spoofed.status).toBe(422);

    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await upload(aman, conversationId, big, 'huge.jpg', 'image/jpeg')).status).toBe(413);
  });

  it('will not let a member attach a file into someone else’s thread', async () => {
    expect((await upload(rohit, conversationId, jpegWithGps(), 'x.jpg', 'image/jpeg')).status).toBe(404);
    const refused = await call(rohit, 'POST', `/v1/member/messages/${conversationId}`, { clientId: clientId(), body: 'hi', attachmentIds: [attachmentId] });
    expect(refused.status).toBe(404);
  });
});
