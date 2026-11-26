import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { DAY, now } from '../lib/time.js';
import { call, signIn, staffIdFor, userIdFor, type TestSession } from './helpers/session.js';
import { createMember } from './support/fixtures.js';

/* ============================================================================
   Console communication verbs no other suite reached (P08 route coverage):
   cancelling a broadcast, marking an inbox thread read, closing/reopening
   it, and logging an activity on a lead. Each test makes its own broadcast,
   conversation or lead, and removes them afterwards.
   ========================================================================= */

const TENANT = 'ten_shark';

let owner: TestSession;
let manager: TestSession; // branch_manager, br_kor only
let reception: TestSession; // reception, br_kor only
let trainer: TestSession; // rehan, every branch
let reefOwner: TestSession;

const createdBroadcastIds: string[] = [];
const createdConversationIds: string[] = [];
const createdLeadIds: string[] = [];

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

function auditRows(entityId: string, action: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.entityId, entityId), eq(schema.auditLog.action, action)))
    .all();
}

beforeAll(async () => {
  [owner, manager, reception, trainer, reefOwner] = await Promise.all([
    signIn('owner@sharkfitness.in'),
    signIn('manager@sharkfitness.in'),
    signIn('reception@sharkfitness.in'),
    signIn('rehan@sharkfitness.in'),
    signIn('owner@reefathletic.in', 'reef'),
  ]);
});

afterAll(() => {
  if (createdBroadcastIds.length) db.delete(schema.broadcasts).where(inArray(schema.broadcasts.id, createdBroadcastIds)).run();
  if (createdConversationIds.length) {
    db.delete(schema.messages).where(inArray(schema.messages.conversationId, createdConversationIds)).run();
    db.delete(schema.conversations).where(inArray(schema.conversations.id, createdConversationIds)).run();
  }
  if (createdLeadIds.length) {
    db.delete(schema.leadActivities).where(inArray(schema.leadActivities.leadId, createdLeadIds)).run();
    db.delete(schema.leads).where(inArray(schema.leads.id, createdLeadIds)).run();
  }
});

/* ——— POST /v1/admin/broadcasts/:broadcastId/cancel ————————————————————— */

const draft = {
  name: 'P08 cancel me',
  channel: 'in_app',
  purpose: 'operational' as const,
  segment: { statuses: ['active'], branchIds: ['br_kor'] },
  title: 'Pool closed',
  body: 'Hi {{firstName}}, the steam room is closed for cleaning on Monday.',
};

async function createBroadcast(session: TestSession): Promise<string> {
  const response = await call(session, 'POST', '/v1/admin/broadcasts', draft, { 'idempotency-key': `p08-bct-${id('k')}` });
  expect(response.status).toBe(201);
  const { broadcast } = await json<{ broadcast: { id: string } }>(response);
  createdBroadcastIds.push(broadcast.id);
  return broadcast.id;
}

const broadcastRow = (broadcastId: string) => db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, broadcastId)).get()!;

describe('POST /v1/admin/broadcasts/:broadcastId/cancel', () => {
  it('cancels a draft, sends nothing, and audits it', async () => {
    const broadcastId = await createBroadcast(manager);
    expect(broadcastRow(broadcastId).state).toBe('draft');

    const response = await call(manager, 'POST', `/v1/admin/broadcasts/${broadcastId}/cancel`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });

    expect(broadcastRow(broadcastId).state).toBe('cancelled');
    const audits = auditRows(broadcastId, 'broadcast.cancelled');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: TENANT, entityLabel: 'P08 cancel me', actorId: userIdFor('manager@sharkfitness.in') });
    const deliveries = db
      .select()
      .from(schema.notificationDeliveries)
      .where(and(eq(schema.notificationDeliveries.source, 'broadcast'), eq(schema.notificationDeliveries.sourceId, broadcastId)))
      .all();
    expect(deliveries).toHaveLength(0);

    // The detail view tells the same story.
    const detail = await json<{ broadcast: { state: string } }>(await call(manager, 'GET', `/v1/admin/broadcasts/${broadcastId}`));
    expect(detail.broadcast.state).toBe('cancelled');
  });

  it('refuses to cancel a broadcast that has already gone out', async () => {
    const broadcastId = await createBroadcast(manager);
    db.update(schema.broadcasts).set({ state: 'sent' }).where(eq(schema.broadcasts.id, broadcastId)).run();

    const response = await call(manager, 'POST', `/v1/admin/broadcasts/${broadcastId}/cancel`);
    expect(response.status).toBe(409);
    expect(errorCode(await json(response))).toBe('CONFLICT');
    expect(broadcastRow(broadcastId).state).toBe('sent');
    expect(auditRows(broadcastId, 'broadcast.cancelled')).toHaveLength(0);
  });

  it('hides a broadcast made with a wider scope, another gym’s, and refuses a role without broadcast.send', async () => {
    // The owner's broadcast covers every branch; a one-branch manager cannot see it.
    const broadcastId = await createBroadcast(owner);
    expect((await call(manager, 'POST', `/v1/admin/broadcasts/${broadcastId}/cancel`)).status).toBe(404);
    expect((await call(reefOwner, 'POST', `/v1/admin/broadcasts/${broadcastId}/cancel`)).status).toBe(404);
    expect((await call(trainer, 'POST', `/v1/admin/broadcasts/${broadcastId}/cancel`)).status).toBe(403);
    expect(broadcastRow(broadcastId).state).toBe('draft');
  });
});

/* ——— POST /v1/admin/inbox/:conversationId/read and /state ——————————————— */

function insertConversation(input: { branchId: string; kind: 'reception' | 'coach'; state?: 'open' | 'closed' }): { conversationId: string; memberId: string; messageIds: string[] } {
  const member = createMember({ branchId: input.branchId, state: null, withLogin: true, firstName: 'Inboxer' });
  const conversationId = id('cnv');
  const at = now();
  db.insert(schema.conversations)
    .values({
      id: conversationId,
      tenantId: TENANT,
      kind: input.kind,
      title: `P08 ${input.kind} thread`,
      memberId: member.memberId,
      staffId: null,
      ticketId: null,
      state: input.state ?? 'open',
      muted: false,
      lastMessageAt: at,
      createdAt: at - DAY,
      branchId: input.branchId,
      topic: 'general',
      assignedStaffId: null,
      staffReadAt: null,
      startedBy: 'member',
    })
    .run();
  createdConversationIds.push(conversationId);
  const messageIds = [id('msg'), id('msg'), id('msg')];
  const rows = [
    { id: messageIds[0]!, senderUserId: member.userId!, senderName: 'Inboxer Member', senderRole: 'member', body: 'Is the pool open?' },
    { id: messageIds[1]!, senderUserId: userIdFor('reception@sharkfitness.in'), senderName: 'Reception', senderRole: 'reception', body: 'Checking.' },
    { id: messageIds[2]!, senderUserId: member.userId!, senderName: 'Inboxer Member', senderRole: 'member', body: 'Thanks!' },
  ];
  rows.forEach((row, index) => {
    db.insert(schema.messages)
      .values({ ...row, tenantId: TENANT, conversationId, attachments: [], state: 'sent', clientId: null, createdAt: at - (3 - index) * 60_000, readAt: null })
      .run();
  });
  return { conversationId, memberId: member.memberId, messageIds };
}

const conversation = (conversationId: string) => db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get()!;
const message = (messageId: string) => db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()!;

describe('POST /v1/admin/inbox/:conversationId/read', () => {
  it('stamps the shared read time and marks only the member’s messages read', async () => {
    const { conversationId, messageIds } = insertConversation({ branchId: 'br_kor', kind: 'reception' });
    const before = now();
    const unreadBefore = await json<{ items: Array<{ id: string }> }>(await call(reception, 'GET', '/v1/admin/inbox?filter=unread'));
    expect(unreadBefore.items.map((item) => item.id)).toContain(conversationId);

    const response = await call(reception, 'POST', `/v1/admin/inbox/${conversationId}/read`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });

    expect(conversation(conversationId).staffReadAt).toBeGreaterThanOrEqual(before);
    for (const memberMessage of [messageIds[0]!, messageIds[2]!]) {
      expect(message(memberMessage)).toMatchObject({ state: 'read' });
      expect(message(memberMessage).readAt).toBeGreaterThanOrEqual(before);
    }
    // The desk's own reply is not "read by staff".
    expect(message(messageIds[1]!)).toMatchObject({ state: 'sent', readAt: null });

    // The shared inbox no longer counts it as unread.
    const unread = await json<{ items: Array<{ id: string }> }>(await call(reception, 'GET', '/v1/admin/inbox?filter=unread'));
    expect(unread.items.map((item) => item.id)).not.toContain(conversationId);
  });

  it('answers 404 to staff who cannot see the thread, and leaves it unread', async () => {
    const ind = insertConversation({ branchId: 'br_ind', kind: 'reception' });
    expect((await call(manager, 'POST', `/v1/admin/inbox/${ind.conversationId}/read`)).status).toBe(404);
    expect((await call(reefOwner, 'POST', `/v1/admin/inbox/${ind.conversationId}/read`)).status).toBe(404);
    // A trainer sees coach threads only, never the front desk's.
    expect((await call(trainer, 'POST', `/v1/admin/inbox/${ind.conversationId}/read`)).status).toBe(404);
    expect(conversation(ind.conversationId).staffReadAt).toBeNull();
    expect(message(ind.messageIds[0]!).readAt).toBeNull();
  });
});

describe('POST /v1/admin/inbox/:conversationId/state', () => {
  it('closes and reopens a thread, auditing each change once', async () => {
    const { conversationId } = insertConversation({ branchId: 'br_kor', kind: 'coach' });

    const closed = await call(manager, 'POST', `/v1/admin/inbox/${conversationId}/state`, { state: 'closed' });
    expect(closed.status).toBe(200);
    expect(await json(closed)).toEqual({ ok: true, state: 'closed' });
    expect(conversation(conversationId).state).toBe('closed');
    const closeAudit = auditRows(conversationId, 'conversation.closed');
    expect(closeAudit).toHaveLength(1);
    expect(closeAudit[0]).toMatchObject({ branchId: 'br_kor', actorId: userIdFor('manager@sharkfitness.in') });

    // A closed thread refuses replies until it is reopened.
    const reply = await call(manager, 'POST', `/v1/admin/inbox/${conversationId}/reply`, { body: 'Hello again', clientId: `p08-${id('c')}` });
    expect(reply.status).toBe(409);

    // Closing again is a no-op, not a second audit entry.
    expect((await call(manager, 'POST', `/v1/admin/inbox/${conversationId}/state`, { state: 'closed' })).status).toBe(200);
    expect(auditRows(conversationId, 'conversation.closed')).toHaveLength(1);

    const reopened = await call(manager, 'POST', `/v1/admin/inbox/${conversationId}/state`, { state: 'open' });
    expect(await json(reopened)).toEqual({ ok: true, state: 'open' });
    expect(conversation(conversationId).state).toBe('open');
    expect(auditRows(conversationId, 'conversation.reopened')).toHaveLength(1);
  });

  it('refuses an unknown state (422) and a thread out of scope (404)', async () => {
    const { conversationId } = insertConversation({ branchId: 'br_kor', kind: 'reception' });
    const bad = await call(manager, 'POST', `/v1/admin/inbox/${conversationId}/state`, { state: 'archived' });
    expect(bad.status).toBe(422);
    expect(errorCode(await json(bad))).toBe('VALIDATION_FAILED');

    const ind = insertConversation({ branchId: 'br_ind', kind: 'reception' });
    expect((await call(reception, 'POST', `/v1/admin/inbox/${ind.conversationId}/state`, { state: 'closed' })).status).toBe(404);
    expect(conversation(ind.conversationId).state).toBe('open');
    expect(auditRows(ind.conversationId, 'conversation.closed')).toHaveLength(0);
  });
});

/* ——— POST /v1/admin/leads/:leadId/activities ———————————————————————— */

function insertLead(branchId: string): string {
  const leadId = id('led');
  const at = now();
  db.insert(schema.leads)
    .values({
      id: leadId,
      tenantId: TENANT,
      branchId,
      name: 'Meera P08 Lead',
      phone: null,
      email: null,
      phoneNormalized: null,
      emailNormalized: null,
      source: 'walk_in',
      campaign: null,
      stage: 'contacted',
      ownerId: staffIdFor('reception@sharkfitness.in'),
      expectedValueMinor: 0,
      nextActionAt: at - DAY,
      nextActionLabel: 'Call back',
      lastTouchedAt: at - 3 * DAY,
      lossReason: null,
      convertedMemberId: null,
      duplicateOfId: null,
      tags: [],
      createdAt: at - 5 * DAY,
      updatedAt: at - 3 * DAY,
    })
    .run();
  createdLeadIds.push(leadId);
  return leadId;
}

const lead = (leadId: string) => db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).get()!;

describe('POST /v1/admin/leads/:leadId/activities', () => {
  it('logs the activity, touches the lead and sets its next action', async () => {
    const leadId = insertLead('br_kor');
    const before = now();
    const nextActionAt = new Date(before + 2 * DAY).toISOString();

    const response = await call(reception, 'POST', `/v1/admin/leads/${leadId}/activities`, {
      kind: 'call',
      body: 'Spoke for five minutes; wants an evening trial.',
      nextActionAt,
      nextActionLabel: 'Book the evening trial',
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });

    const activity = db.select().from(schema.leadActivities).where(eq(schema.leadActivities.leadId, leadId)).orderBy(desc(schema.leadActivities.at)).get()!;
    expect(activity).toMatchObject({
      tenantId: TENANT,
      kind: 'call',
      body: 'Spoke for five minutes; wants an evening trial.',
      actorId: userIdFor('reception@sharkfitness.in'),
      fromStage: null,
      toStage: null,
    });
    const row = lead(leadId);
    expect(row.lastTouchedAt).toBeGreaterThanOrEqual(before);
    expect(row.nextActionAt).toBe(Date.parse(nextActionAt));
    expect(row.nextActionLabel).toBe('Book the evening trial');
    expect(row.stage).toBe('contacted');

    // The lead's timeline shows it.
    const detail = await json<{ activities: Array<{ kind: string; body: string }> }>(await call(reception, 'GET', `/v1/admin/leads/${leadId}`));
    expect(detail.activities.some((a) => a.kind === 'call' && a.body.startsWith('Spoke for five minutes'))).toBe(true);
  });

  it('leaves the next action alone when the activity does not mention it, and clears it on null', async () => {
    const leadId = insertLead('br_kor');
    const original = lead(leadId);
    expect((await call(manager, 'POST', `/v1/admin/leads/${leadId}/activities`, { kind: 'note', body: 'Prefers WhatsApp.' })).status).toBe(200);
    expect(lead(leadId)).toMatchObject({ nextActionAt: original.nextActionAt, nextActionLabel: original.nextActionLabel });

    expect((await call(manager, 'POST', `/v1/admin/leads/${leadId}/activities`, { kind: 'message', body: 'Sent the timetable.', nextActionAt: null, nextActionLabel: null })).status).toBe(200);
    expect(lead(leadId)).toMatchObject({ nextActionAt: null, nextActionLabel: null });
    expect(db.select().from(schema.leadActivities).where(eq(schema.leadActivities.leadId, leadId)).all()).toHaveLength(2);
  });

  it('refuses a bad kind or empty body (422), a lead out of scope (404) and a role without lead.manage (403)', async () => {
    const leadId = insertLead('br_kor');
    const badKind = await call(reception, 'POST', `/v1/admin/leads/${leadId}/activities`, { kind: 'carrier_pigeon', body: 'Sent a bird.' });
    expect(badKind.status).toBe(422);
    expect(errorCode(await json(badKind))).toBe('VALIDATION_FAILED');
    expect((await call(reception, 'POST', `/v1/admin/leads/${leadId}/activities`, { kind: 'note', body: '' })).status).toBe(422);

    const indLead = insertLead('br_ind');
    expect((await call(manager, 'POST', `/v1/admin/leads/${indLead}/activities`, { kind: 'note', body: 'Not mine.' })).status).toBe(404);
    expect((await call(reefOwner, 'POST', `/v1/admin/leads/${leadId}/activities`, { kind: 'note', body: 'Not ours.' })).status).toBe(404);
    expect((await call(trainer, 'POST', `/v1/admin/leads/${leadId}/activities`, { kind: 'note', body: 'Trainer note.' })).status).toBe(403);

    expect(db.select().from(schema.leadActivities).where(inArray(schema.leadActivities.leadId, [leadId, indLead])).all()).toHaveLength(0);
  });
});
