import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gte, like } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { call, memberIdFor, signIn, userIdFor, type TestSession } from './helpers/session.js';

/* ============================================================================
   Nutrition & Habits, the coach view (P07 AC5; PF-NUTR-002/003/005/006,
   PF-STAFF-005).
   ========================================================================= */

const WEEK = '2026-02-02'; // a Monday this suite owns
const NOTE = "I've been skipping meals this week and felt dizzy after Tuesday's session";

let aman: TestSession;
let rehan: TestSession; // Aman's coach
let nikhil: TestSession; // Rohit's coach
let manager: TestSession;
let accountant: TestSession;
let amanId = '';
let rohitId = '';
let targetsBefore: typeof schema.nutritionTargets.$inferSelect | undefined;
const startedAt = Date.now();

interface Roster {
  items: Array<{ memberId: string; flagged: boolean; awaitingReply: number }>;
}

async function roster(session: TestSession): Promise<Roster> {
  const response = await call(session, 'GET', '/v1/admin/coaching/members');
  expect(response.status).toBe(200);
  return (await response.json()) as Roster;
}

beforeAll(async () => {
  [aman, rehan, nikhil, manager, accountant] = await Promise.all([
    signIn('aman@sharkfitness.in'),
    signIn('rehan@sharkfitness.in'),
    signIn('nikhil@sharkfitness.in'),
    signIn('manager@sharkfitness.in'),
    signIn('accounts@sharkfitness.in'),
  ]);
  amanId = memberIdFor('aman@sharkfitness.in');
  rohitId = memberIdFor('rohit@sharkfitness.in');
  targetsBefore = db.select().from(schema.nutritionTargets).where(eq(schema.nutritionTargets.memberId, amanId)).get();
});

afterAll(() => {
  db.delete(schema.weeklyCheckIns).where(and(eq(schema.weeklyCheckIns.memberId, amanId), eq(schema.weeklyCheckIns.weekStart, WEEK))).run();
  db.delete(schema.habits).where(and(eq(schema.habits.memberId, amanId), eq(schema.habits.templateKey, 'mobility'))).run();
  db.delete(schema.tickets).where(and(eq(schema.tickets.memberId, amanId), gte(schema.tickets.openedAt, startedAt), like(schema.tickets.reference, 'SAF-%'))).run();
  // Put Aman's nutrition settings back exactly as the seed left them.
  db.delete(schema.nutritionTargets).where(eq(schema.nutritionTargets.memberId, amanId)).run();
  if (targetsBefore) db.insert(schema.nutritionTargets).values(targetsBefore).run();
});

describe('who a coach sees', () => {
  it('shows a trainer only the members assigned to them (PF-STAFF-005)', async () => {
    const rehanIds = (await roster(rehan)).items.map((i) => i.memberId);
    const nikhilIds = (await roster(nikhil)).items.map((i) => i.memberId);
    expect(rehanIds).toContain(amanId);
    expect(rehanIds).not.toContain(rohitId);
    expect(nikhilIds).toContain(rohitId);
    expect(nikhilIds).not.toContain(amanId);

    expect((await call(rehan, 'GET', `/v1/admin/coaching/members/${amanId}`)).status).toBe(200);
    expect((await call(rehan, 'GET', `/v1/admin/coaching/members/${rohitId}`)).status).toBe(404);
    const managerIds = (await roster(manager)).items.map((i) => i.memberId);
    expect(managerIds).toEqual(expect.arrayContaining([amanId, rohitId]));
    expect((await call(accountant, 'GET', '/v1/admin/coaching/members')).status).toBe(403);
  });

  it('leaves out members who switched the module off (PF-NUTR-006)', async () => {
    const off = await call(aman, 'POST', '/v1/member/habits/opt-out', { optedOut: true });
    expect(off.status).toBe(200);
    try {
      expect((await roster(rehan)).items.map((i) => i.memberId)).not.toContain(amanId);
      expect((await call(rehan, 'GET', `/v1/admin/coaching/members/${amanId}`)).status).toBe(404);
    } finally {
      expect((await call(aman, 'POST', '/v1/member/habits/opt-out', { optedOut: false })).status).toBe(200);
    }
    expect((await roster(rehan)).items.map((i) => i.memberId)).toContain(amanId);
  });
});

describe('weekly check-ins', () => {
  it('routes a check-in with a safety phrase to the coach as a flag, and never to analytics', async () => {
    const outboxBefore = db.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents).all().length;

    const sent = await call(aman, 'POST', '/v1/member/habits/check-in', {
      weekStart: WEEK,
      adherence: 2,
      energy: 2,
      hunger: 4,
      sleep: 2,
      soreness: 3,
      mood: 2,
      note: NOTE,
    });
    expect(sent.status).toBe(200);
    const body = (await sent.json()) as { safety: { escalated: boolean; categories: string[] } };
    expect(body.safety.escalated).toBe(true);
    expect(body.safety.categories).toEqual(expect.arrayContaining(['disordered_eating', 'medical']));

    // The coach sees a flag on the roster and the words in the detail.
    expect((await roster(rehan)).items.find((i) => i.memberId === amanId)).toMatchObject({ flagged: true });
    const detail = (await (await call(rehan, 'GET', `/v1/admin/coaching/members/${amanId}`)).json()) as {
      checkIns: Array<{ weekStart: string; note: string; safetyEscalated: boolean }>;
    };
    expect(detail.checkIns.find((c) => c.weekStart === WEEK)).toMatchObject({ note: NOTE, safetyEscalated: true });
    const coachNote = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userIdFor('rehan@sharkfitness.in')), eq(schema.notifications.kind, 'safety'), gte(schema.notifications.createdAt, startedAt)))
      .get();
    expect(coachNote?.title).toBe('A check-in needs you to read it');
    expect(coachNote?.body).not.toContain('skipping');

    // Re-sending the week with gentler words cannot clear the flag or the words.
    const resent = await call(aman, 'POST', '/v1/member/habits/check-in', {
      weekStart: WEEK, adherence: 4, energy: 4, hunger: 3, sleep: 4, soreness: 2, mood: 4, note: 'All fine actually',
    });
    expect(resent.status).toBe(409);
    expect((await roster(rehan)).items.find((i) => i.memberId === amanId)).toMatchObject({ flagged: true });

    // No analytics: nothing reaches the integrations (webhook) stream, and no
    // event anywhere carries the member's words.
    const newEvents = db.select().from(schema.outboxEvents).all().slice(outboxBefore);
    expect(newEvents.some((e) => e.channel.startsWith('integrations:'))).toBe(false);
    expect(newEvents.every((e) => !JSON.stringify(e.payload).includes('skipping'))).toBe(true);
    const audits = db.select().from(schema.auditLog).where(gte(schema.auditLog.at, startedAt)).all();
    expect(audits.every((a) => !JSON.stringify(a).includes('skipping meals'))).toBe(true);
    const metricRows = db.select().from(schema.metricRollups).all();
    expect(metricRows.every((m) => !JSON.stringify(m).includes('skipping'))).toBe(true);
  });

  it('lets the coach reply, which reaches the member and clears the flag', async () => {
    const detail = (await (await call(rehan, 'GET', `/v1/admin/coaching/members/${amanId}`)).json()) as {
      checkIns: Array<{ id: string; weekStart: string }>;
    };
    const checkIn = detail.checkIns.find((c) => c.weekStart === WEEK)!;
    expect((await call(nikhil, 'POST', `/v1/admin/coaching/check-ins/${checkIn.id}/reply`, { reply: 'Not your coach' })).status).toBe(404);
    const reply = await call(rehan, 'POST', `/v1/admin/coaching/check-ins/${checkIn.id}/reply`, {
      reply: 'Thank you for telling me. Let’s talk before your next session — no changes to your plan until then.',
    });
    expect(reply.status).toBe(200);
    const row = db.select().from(schema.weeklyCheckIns).where(eq(schema.weeklyCheckIns.id, checkIn.id)).get()!;
    expect(row.coachReplyByName).toBeTruthy();
    const memberNote = db
      .select()
      .from(schema.notificationDeliveries)
      .where(and(eq(schema.notificationDeliveries.userId, userIdFor('aman@sharkfitness.in')), eq(schema.notificationDeliveries.source, 'coaching'), gte(schema.notificationDeliveries.createdAt, startedAt)))
      .all();
    expect(memberNote.some((n) => n.purpose === 'coaching' && n.state === 'sent')).toBe(true);
    expect((await roster(rehan)).items.find((i) => i.memberId === amanId)?.flagged).toBe(false);
  });
});

describe('habit templates', () => {
  it('assigns a template once and tells the member', async () => {
    const first = await call(rehan, 'POST', `/v1/admin/coaching/members/${amanId}/habits`, { templateKey: 'mobility' });
    expect(first.status).toBe(201);
    const again = await call(rehan, 'POST', `/v1/admin/coaching/members/${amanId}/habits`, { templateKey: 'mobility' });
    expect(again.status).toBe(409);
    expect((await call(rehan, 'POST', `/v1/admin/coaching/members/${amanId}/habits`, { templateKey: 'not-a-template' })).status).toBe(422);
    expect((await call(nikhil, 'POST', `/v1/admin/coaching/members/${amanId}/habits`, { templateKey: 'water' })).status).toBe(404);

    const habits = (await (await call(aman, 'GET', '/v1/member/habits')).json()) as { habits?: Array<{ name: string }>; items?: Array<{ name: string }> };
    const names = (habits.habits ?? habits.items ?? []).map((h) => h.name);
    expect(names).toContain('Mobility 10 minutes');
  });
});
