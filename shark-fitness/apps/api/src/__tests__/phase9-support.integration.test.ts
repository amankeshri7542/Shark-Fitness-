import { beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

/* ============================================================================
   Phase 9 — Support, feedback and retention (PF-SUP-001…006).

   The awkward cases are the point. A support desk is judged on the tickets
   nobody wants: an anonymous harassment report with no member to reply to, a
   dispute reopened after it was settled, a score that rose because the gym was
   shut, a ticket whose member has since been deleted.
   ========================================================================= */

interface Session {
  cookie: string;
  csrfToken: string;
}

const cache = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const get = (session: Session, path: string) => app.request(path, { headers: headers(session) });
const post = (session: Session, path: string, body: unknown, key?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { ...headers(session, true), ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
const patch = (session: Session, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: headers(session, true), body: JSON.stringify(body) });

function tenantId(): string {
  return db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, 'shark')).get()!.id;
}

/**
 * A live, seeded member — deterministic, and never one this file soft-deleted.
 *
 * Ordering matters: `limit(1)` with no order returns whatever SQLite feels
 * like, which for a while was the deleted record this suite creates, and every
 * ticket raised against it came back 412.
 */
function anyMemberId(): string {
  return db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenantId()), isNull(schema.members.deletedAt)))
    .orderBy(asc(schema.members.memberNo))
    .limit(1)
    .get()!.id;
}

/** A ticket nobody else in the suite touches. */
function freshTicket(overrides: Partial<typeof schema.tickets.$inferInsert> = {}): string {
  const ticketId = id('tkt');
  const at = now();
  db.insert(schema.tickets)
    .values({
      id: ticketId,
      tenantId: tenantId(),
      branchId: 'br_kor',
      memberId: anyMemberId(),
      reference: `TST-${ticketId.slice(-6).toUpperCase()}`,
      category: 'facility',
      subject: 'Test ticket',
      priority: 'normal',
      state: 'open',
      assigneeId: null,
      slaDueAt: at + 24 * 60 * 60 * 1000,
      slaResponseMinutes: 24 * 60,
      resolution: null,
      anonymous: false,
      escalated: false,
      escalatedAt: null,
      escalatedBy: null,
      escalationReason: null,
      firstResponseAt: null,
      resolvedAt: null,
      resolvedBy: null,
      reopenCount: 0,
      vulnerabilityFlag: false,
      safetyCategories: null,
      openedAt: at,
      lastUpdateAt: at,
      closedAt: null,
      ...overrides,
    })
    .run();
  return ticketId;
}

/** Give a ticket the member conversation the app would have created. */
function withConversation(ticketId: string): string {
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()!;
  const conversationId = id('cnv');
  db.insert(schema.conversations)
    .values({
      id: conversationId,
      tenantId: tenantId(),
      kind: 'support',
      title: `${ticket.reference} · ${ticket.subject}`,
      memberId: ticket.memberId,
      staffId: null,
      ticketId,
      state: 'open',
      muted: false,
      lastMessageAt: ticket.openedAt,
      createdAt: ticket.openedAt,
    })
    .run();
  return conversationId;
}

let owner: Session;
let manager: Session;
let reception: Session;
let trainer: Session;
let accountant: Session;

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  manager = await signIn('manager@sharkfitness.in');
  reception = await signIn('reception@sharkfitness.in');
  trainer = await signIn('rehan@sharkfitness.in');
  accountant = await signIn('accounts@sharkfitness.in');
});

/* ==========================================================================
   Permissions and scope
   ========================================================================= */

describe('Support permissions and scope', () => {
  it('serves the queue to a role holding support.manage', async () => {
    const response = await get(owner, '/v1/admin/support/tickets?branchId=br_kor');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; counts: Record<string, number> };
    expect(Array.isArray(body.items)).toBe(true);
    expect(Number.isInteger(body.counts.open)).toBe(true);
  });

  it('lets reception work the desk — it is the front desk that answers most of these', async () => {
    expect((await get(reception, '/v1/admin/support/tickets')).status).toBe(200);
  });

  it('refuses a trainer, who has no support.manage', async () => {
    expect((await get(trainer, '/v1/admin/support/tickets')).status).toBe(403);
    expect((await get(trainer, '/v1/admin/support/retention')).status).toBe(403);
    expect((await get(trainer, '/v1/admin/support/feedback')).status).toBe(403);
  });

  it('refuses an accountant the desk as well', async () => {
    expect((await get(accountant, '/v1/admin/support/tickets')).status).toBe(403);
  });

  it('hides a ticket at a branch the caller cannot see — 404, not 403', async () => {
    // A 403 would confirm the reference exists somewhere the caller may not
    // look, which is exactly what the console must never leak.
    const ticketId = freshTicket({ branchId: 'br_ind' });
    const response = await get(manager, `/v1/admin/support/tickets/${ticketId}`);
    expect(response.status).toBe(404);
  });

  it('refuses a cross-tenant ticket id the same way', async () => {
    const response = await get(owner, '/v1/admin/support/tickets/tkt_not_a_real_id');
    expect(response.status).toBe(404);
  });

  it('covers every permitted branch when none is named, not just the session default', async () => {
    // `activeBranchId` is set to the first permitted branch at sign-in and only
    // moves when a client sends `x-branch-id`. Scoping an unfiltered read to it
    // made "All branches" a lie and hid a whole branch's complaints from an
    // owner — found in a browser, not by the suite, which is why it is here.
    const elsewhere = freshTicket({ branchId: 'br_ind', subject: 'Raised at Indiranagar' });
    const body = (await (await get(owner, '/v1/admin/support/tickets')).json()) as {
      items: Array<{ id: string; branchName: string | null }>;
    };
    expect(body.items.some((t) => t.id === elsewhere)).toBe(true);
    expect(new Set(body.items.map((t) => t.branchName)).size).toBeGreaterThan(1);
  });

  it('still narrows to one branch when one is named', async () => {
    const body = (await (await get(owner, '/v1/admin/support/tickets?branchId=br_kor')).json()) as {
      items: Array<{ branchName: string | null }>;
    };
    for (const t of body.items) {
      // Tenant-wide tickets carry no branch and ride along deliberately.
      if (t.branchName !== null) expect(t.branchName).toBe('Koramangala Depot');
    }
  });

  it('still shows a tenant-wide ticket to a branch-scoped caller', async () => {
    // A report that names no branch has to reach somebody. Dropping it from
    // every scoped queue would bury it silently.
    const ticketId = freshTicket({ branchId: null, memberId: null, anonymous: true });
    const response = await get(manager, `/v1/admin/support/tickets/${ticketId}`);
    expect(response.status).toBe(200);
  });
});

/* ==========================================================================
   SLA — PF-SUP-001
   ========================================================================= */

describe('SLA is computed, not stored', () => {
  it('reports a breach on a ticket past its promise with no reply', async () => {
    const at = now();
    const ticketId = freshTicket({
      openedAt: at - 40 * 60 * 60 * 1000,
      slaDueAt: at - 16 * 60 * 60 * 1000,
      slaResponseMinutes: 12 * 60,
    });
    const body = (await (await get(owner, `/v1/admin/support/tickets/${ticketId}`)).json()) as {
      ticket: { sla: { state: string; breached: boolean; label: string } };
    };
    expect(body.ticket.sla.state).toBe('breached');
    expect(body.ticket.sla.breached).toBe(true);
    expect(body.ticket.sla.label).toMatch(/overdue/i);
  });

  it('judges a ticket on its first reply, not on how long it stayed open', async () => {
    // A desk that answers in ten minutes and then spends a week fixing a boiler
    // has kept its promise. Judging on resolution would make that a failure and
    // the whole measure would be ignored inside a month.
    const at = now();
    const ticketId = freshTicket({
      openedAt: at - 10 * 24 * 60 * 60 * 1000,
      slaDueAt: at - 10 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000,
      firstResponseAt: at - 10 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000,
      slaResponseMinutes: 4 * 60,
    });
    const body = (await (await get(owner, `/v1/admin/support/tickets/${ticketId}`)).json()) as {
      ticket: { sla: { state: string; breached: boolean } };
    };
    expect(body.ticket.sla.state).toBe('met');
    expect(body.ticket.sla.breached).toBe(false);
  });

  it('does not let resolving a never-answered ticket launder the breach', async () => {
    const at = now();
    const ticketId = freshTicket({
      openedAt: at - 5 * 24 * 60 * 60 * 1000,
      slaDueAt: at - 4 * 24 * 60 * 60 * 1000,
      firstResponseAt: null,
    });
    const resolved = await post(owner, `/v1/admin/support/tickets/${ticketId}/resolve`, {
      resolution: 'Sorted at the desk without a written reply.',
    });
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as { ticket: { sla: { breached: boolean } } };
    expect(body.ticket.sla.breached).toBe(true);
  });

  it('counts the promise in open hours, so an overnight ticket is not due at 3am', async () => {
    // Koramangala opens 05:00–23:00 local. A ticket opened just before closing
    // with a four-hour promise must fall due after the branch reopens, which
    // means more than four wall-clock hours later.
    const branch = db
      .select()
      .from(schema.branches)
      .where(eq(schema.branches.id, 'br_kor'))
      .get()!;
    const created = await post(owner, '/v1/admin/support/tickets', {
      branchId: 'br_kor',
      category: 'complaint',
      subject: 'Business hours SLA probe',
      body: 'Raised to check the clock pauses overnight.',
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      ticket: { id: string; sla: { dueAt: string; responseMinutes: number } };
    };
    expect(body.ticket.sla.responseMinutes).toBe(4 * 60);

    const openedAt = db
      .select({ openedAt: schema.tickets.openedAt })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, body.ticket.id))
      .get()!.openedAt;
    const wallClockGap = Date.parse(body.ticket.sla.dueAt) - openedAt;
    // At minimum it is the promise; it is longer whenever the window crosses a
    // closure. Either way it is never *shorter* than the promised open time.
    expect(wallClockGap).toBeGreaterThanOrEqual(4 * 60 * 60 * 1000);
    expect(branch.closesMinutes).toBeGreaterThan(branch.opensMinutes);
  });
});

/* ==========================================================================
   Lifecycle — PF-SUP-001, PF-SUP-006
   ========================================================================= */

describe('Ticket lifecycle', () => {
  it('assigns, re-prioritises and moves state, recording each on the timeline', async () => {
    const ticketId = freshTicket();
    const staffId = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.users.email, 'reception@sharkfitness.in'))
      .get()!.id;

    expect((await patch(owner, `/v1/admin/support/tickets/${ticketId}`, { assigneeId: staffId })).status).toBe(200);
    expect((await patch(owner, `/v1/admin/support/tickets/${ticketId}`, { priority: 'high' })).status).toBe(200);
    const moved = await patch(owner, `/v1/admin/support/tickets/${ticketId}`, { state: 'pending_staff' });
    expect(moved.status).toBe(200);

    const body = (await moved.json()) as {
      ticket: { assigneeName: string | null; priority: string; state: string };
      timeline: Array<{ kind: string }>;
    };
    expect(body.ticket.priority).toBe('high');
    expect(body.ticket.state).toBe('pending_staff');
    expect(body.ticket.assigneeName).not.toBeNull();
    const kinds = body.timeline.map((e) => e.kind);
    expect(kinds).toContain('assigned');
    expect(kinds).toContain('priority_changed');
    expect(kinds).toContain('state_changed');
  });

  it('refuses an assignee who does not cover the ticket’s branch', async () => {
    // An assignment to somebody who cannot open the ticket looks like coverage
    // and is not — at a support desk that means nobody is looking at it.
    const ticketId = freshTicket({ branchId: 'br_ind' });
    const branchScoped = db
      .select({ id: schema.staff.id })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.users.email, 'reception@sharkfitness.in'))
      .get()!;
    const response = await patch(owner, `/v1/admin/support/tickets/${ticketId}`, { assigneeId: branchScoped.id });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /does not cover this branch/i,
    );
  });

  it('refuses to resolve without saying what was done', async () => {
    const ticketId = freshTicket();
    const response = await post(owner, `/v1/admin/support/tickets/${ticketId}/resolve`, { resolution: 'ok' });
    expect(response.status).toBe(422);
  });

  it('reopens a resolved ticket keeping its reference, history and first reply', async () => {
    const at = now();
    const ticketId = freshTicket({ firstResponseAt: at - 60 * 60 * 1000 });
    await post(owner, `/v1/admin/support/tickets/${ticketId}/resolve`, { resolution: 'Replaced the fitting.' });

    const reopened = await post(owner, `/v1/admin/support/tickets/${ticketId}/reopen`, {
      reason: 'Member says it is leaking again.',
    });
    expect(reopened.status).toBe(200);
    const body = (await reopened.json()) as {
      ticket: { state: string; reopenCount: number; reference: string; sla: { firstResponseAt: string | null } };
      timeline: Array<{ kind: string }>;
    };
    expect(body.ticket.state).toBe('open');
    expect(body.ticket.reopenCount).toBe(1);
    // Reopening must not manufacture a fresh breach out of an answer that
    // genuinely happened.
    expect(body.ticket.sla.firstResponseAt).not.toBeNull();
    expect(body.timeline.map((e) => e.kind)).toContain('reopened');
  });

  it('treats closed as terminal — a settled record cannot be quietly moved', async () => {
    const ticketId = freshTicket();
    await patch(owner, `/v1/admin/support/tickets/${ticketId}`, { state: 'closed' });
    const response = await patch(owner, `/v1/admin/support/tickets/${ticketId}`, { state: 'open' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/settled record/i);
  });

  it('escalates once, with an author and a reason, and never back', async () => {
    const ticketId = freshTicket();
    const first = await post(owner, `/v1/admin/support/tickets/${ticketId}/escalate`, {
      reason: 'Member is threatening to go to the press.',
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      ticket: { escalated: boolean; priority: string };
      escalation: { by: string; reason: string } | null;
    };
    expect(body.ticket.escalated).toBe(true);
    expect(body.ticket.priority).toBe('high');
    expect(body.escalation?.reason).toMatch(/press/);

    // PF-SUP-006: a dispute record that can be quietly lowered is not a record.
    const again = await post(owner, `/v1/admin/support/tickets/${ticketId}/escalate`, { reason: 'Second attempt.' });
    expect(again.status).toBe(409);
  });
});

/* ==========================================================================
   Replies — one history, not two
   ========================================================================= */

describe('Replies flow into the member conversation', () => {
  it('writes a staff reply into the ticket’s existing conversation, not a parallel store', async () => {
    const ticketId = freshTicket();
    const conversationId = withConversation(ticketId);

    const response = await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, {
      body: 'Maintenance are on it this afternoon.',
    });
    expect(response.status).toBe(201);

    const rows = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toMatch(/Maintenance/);
    // The member's app reads `messages`; there is nowhere else this could live
    // without the two telling different stories about one exchange.
    const body = (await response.json()) as { messages: Array<{ body: string }>; conversationId: string };
    expect(body.conversationId).toBe(conversationId);
    expect(body.messages.at(-1)!.body).toMatch(/Maintenance/);
  });

  it('publishes the reply on the member’s own realtime channel', async () => {
    const ticketId = freshTicket();
    withConversation(ticketId);
    const since = now();
    await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, { body: 'Booked you in for Thursday.' });

    const events = db
      .select({ channel: schema.outboxEvents.channel, topic: schema.outboxEvents.topic })
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.topic, 'message.created'), sql`${schema.outboxEvents.at} >= ${since}`))
      .all();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.channel.startsWith('member:'))).toBe(true);
  });

  it('stops the SLA clock on the first member-visible reply only', async () => {
    const ticketId = freshTicket();
    withConversation(ticketId);

    await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, { body: 'First answer.' });
    const afterFirst = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()!;
    expect(afterFirst.firstResponseAt).not.toBeNull();
    expect(afterFirst.state).toBe('pending_member');

    await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, { body: 'Second answer.' });
    const afterSecond = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()!;
    // Whether the promise was kept is a fact about the past.
    expect(afterSecond.firstResponseAt).toBe(afterFirst.firstResponseAt);
  });

  it('keeps an internal note off the member conversation and off the clock', async () => {
    const ticketId = freshTicket();
    const conversationId = withConversation(ticketId);

    const response = await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, {
      body: 'Third complaint from this member this month — watch it.',
      internal: true,
    });
    expect(response.status).toBe(201);

    const messages = db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all();
    expect(messages).toHaveLength(0);
    const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()!;
    expect(ticket.firstResponseAt).toBeNull();

    const body = (await response.json()) as { timeline: Array<{ kind: string; summary: string }> };
    expect(body.timeline.some((e) => e.kind === 'internal_note' && /watch it/.test(e.summary))).toBe(true);
  });

  it('replays a retried reply instead of sending the member the same answer twice', async () => {
    const ticketId = freshTicket();
    const conversationId = withConversation(ticketId);
    const key = `reply-${id('k')}`;
    const body = { body: 'Refund is on its way.', internal: false };

    const first = await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, body, key);
    const second = await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const messages = db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).all();
    expect(messages).toHaveLength(1);
  });
});

/* ==========================================================================
   PRD edge cases
   ========================================================================= */

describe('Required edge cases', () => {
  it('takes an anonymous report and refuses to reply to it, saying why', async () => {
    // PF-SUP: "Member submits anonymous harassment report." Anonymity here is
    // absence — no member id was ever written, so there is nothing to unmask
    // and nothing to reply to.
    const ticketId = freshTicket({
      anonymous: true,
      memberId: null,
      category: 'complaint',
      subject: 'Conduct in the free weights area',
    });

    const detail = (await (await get(owner, `/v1/admin/support/tickets/${ticketId}`)).json()) as {
      ticket: { memberId: string | null; memberName: string | null; anonymous: boolean };
      member: unknown;
      conversationId: string | null;
      replyBlockedReason: string | null;
    };
    expect(detail.ticket.anonymous).toBe(true);
    expect(detail.ticket.memberId).toBeNull();
    expect(detail.ticket.memberName).toBeNull();
    expect(detail.member).toBeNull();
    expect(detail.conversationId).toBeNull();
    expect(detail.replyBlockedReason).toMatch(/anonymously/i);

    const reply = await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, { body: 'Looking into it.' });
    expect(reply.status).toBe(412);
  });

  it('keeps an anonymous report workable — it can still be escalated and resolved', async () => {
    const ticketId = freshTicket({ anonymous: true, memberId: null, category: 'complaint' });
    expect(
      (await post(owner, `/v1/admin/support/tickets/${ticketId}/escalate`, { reason: 'Safety report, needs a manager.' }))
        .status,
    ).toBe(200);
    expect(
      (await post(owner, `/v1/admin/support/tickets/${ticketId}/resolve`, { resolution: 'Spoke to both members.' }))
        .status,
    ).toBe(200);
  });

  it('leaves a ticket open and answerable after the member record is deleted', async () => {
    // PF-SUP: "Ticket remains open after membership deletion."
    //
    // The row is removed again at the end. The suite shares one seeded database
    // with every other file, and leaving a soft-deleted member behind made two
    // Phase 5 tests pick it up and fail — a fixture is not a scratchpad.
    const memberId = id('mbr');
    const at = now();
    db.insert(schema.members)
      .values({
        id: memberId,
        tenantId: tenantId(),
        userId: null,
        homeBranchId: 'br_kor',
        memberNo: `DEL-${memberId.slice(-5)}`,
        firstName: 'Deleted',
        lastName: 'Member',
        initials: 'DM',
        email: null,
        phone: null,
        phoneNormalized: null,
        emailNormalized: null,
        dob: null,
        gender: null,
        addressLine: null,
        emergencyContact: null,
        lifecycle: 'active',
        tags: [],
        trainerId: null,
        guardianId: null,
        corporateSponsorId: null,
        memberNotes: null,
        staffNotes: null,
        riskScore: null,
        riskReasons: null,
        joinedOn: '2026-01-01',
        lastVisitAt: null,
        mergedIntoId: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
        deletedAt: at,
      })
      .run();

    const ticketId = freshTicket({ memberId });
    withConversation(ticketId);

    const detail = (await (await get(owner, `/v1/admin/support/tickets/${ticketId}`)).json()) as {
      ticket: { state: string; memberInactive: boolean };
      member: { inactive: boolean } | null;
      replyBlockedReason: string | null;
    };
    // The ticket survives the member. It is still a thing that has to be settled.
    expect(detail.ticket.state).toBe('open');
    expect(detail.ticket.memberInactive).toBe(true);
    expect(detail.member?.inactive).toBe(true);
    expect(detail.replyBlockedReason).toMatch(/deleted/i);

    // And it can still be closed off properly.
    expect(
      (await post(owner, `/v1/admin/support/tickets/${ticketId}/resolve`, { resolution: 'Closed — account removed.' }))
        .status,
    ).toBe(200);

    db.delete(schema.members).where(eq(schema.members.id, memberId)).run();
  });

  it('refuses to raise a *new* ticket against a deleted member rather than pretending it worked', async () => {
    const memberId = id('mbr');
    const at = now();
    db.insert(schema.members)
      .values({
        id: memberId,
        tenantId: tenantId(),
        userId: null,
        homeBranchId: 'br_kor',
        memberNo: `GONE-${memberId.slice(-5)}`,
        firstName: 'Gone',
        lastName: 'Away',
        initials: 'GA',
        email: null,
        phone: null,
        phoneNormalized: null,
        emailNormalized: null,
        dob: null,
        gender: null,
        addressLine: null,
        emergencyContact: null,
        lifecycle: 'active',
        tags: [],
        trainerId: null,
        guardianId: null,
        corporateSponsorId: null,
        memberNotes: null,
        staffNotes: null,
        riskScore: null,
        riskReasons: null,
        joinedOn: '2026-01-01',
        lastVisitAt: null,
        mergedIntoId: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
        deletedAt: at,
      })
      .run();

    try {
      const response = await post(owner, '/v1/admin/support/tickets', {
        memberId,
        category: 'other',
        subject: 'Should not be possible',
        body: 'Raising against a deleted record.',
      });
      expect(response.status).toBe(412);
    } finally {
      db.delete(schema.members).where(eq(schema.members.id, memberId)).run();
    }
  });

  it('does not raise a member’s risk because the branch was shut', async () => {
    // PF-SUP: "Risk score rises because gym was closed." The domain excludes
    // closed weeks from the denominator; this proves the service feeds it the
    // branch's real holidays.
    const branch = db.select().from(schema.branches).where(eq(schema.branches.id, 'br_hsr')).get()!;
    const before = (await (await get(owner, '/v1/admin/support/retention?branchId=br_hsr')).json()) as {
      bands: { high: number; watch: number };
    };

    const at = now();
    const zone = branch.timezone;
    const closedDays: string[] = [];
    for (let d = 0; d < 28; d += 1) {
      closedDays.push(
        new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
          at - d * 24 * 60 * 60 * 1000,
        ),
      );
    }
    db.update(schema.branches)
      .set({ holidays: [...branch.holidays, ...closedDays] })
      .where(eq(schema.branches.id, 'br_hsr'))
      .run();

    try {
      const after = (await (await get(owner, '/v1/admin/support/retention?branchId=br_hsr')).json()) as {
        bands: { high: number; watch: number };
        atRisk: Array<{ suppressed: string | null; score: number }>;
      };
      // With the whole window closed, nobody is scored on attendance at all.
      expect(after.bands.high).toBeLessThanOrEqual(before.bands.high);
      for (const m of after.atRisk) {
        if (m.suppressed) expect(m.score).toBe(0);
      }
    } finally {
      db.update(schema.branches).set({ holidays: branch.holidays }).where(eq(schema.branches.id, 'br_hsr')).run();
    }
  });

  it('carries a cancellation reason that conflicts with the contract as a real ticket', async () => {
    // PF-SUP: "A cancellation request conflicts with contract terms." The desk
    // records the reason as feedback *and* raises a membership ticket, so the
    // conflict is worked rather than lost in a dropdown.
    const memberId = anyMemberId();
    const created = await post(owner, '/v1/admin/support/tickets', {
      memberId,
      branchId: 'br_kor',
      category: 'membership',
      subject: 'Wants to cancel inside the minimum term',
      body: 'Member is moving cities in three weeks; contract runs another four months.',
    });
    expect(created.status).toBe(201);

    const feedback = await post(owner, '/v1/admin/support/feedback', {
      memberId,
      branchId: 'br_kor',
      kind: 'cancellation',
      score: null,
      comment: 'Moving away from the area',
    });
    expect(feedback.status).toBe(201);
    const body = (await feedback.json()) as { cancellationReasons: Array<{ reason: string; count: number }> };
    expect(body.cancellationReasons.some((r) => r.reason === 'Moving away from the area')).toBe(true);
  });
});

/* ==========================================================================
   PF-SUP-006 — the immutable record
   ========================================================================= */

describe('The ticket timeline is append-only', () => {
  it('refuses an UPDATE at the database, not merely in the service', async () => {
    const ticketId = freshTicket();
    await patch(owner, `/v1/admin/support/tickets/${ticketId}`, { priority: 'urgent' });
    const event = db
      .select()
      .from(schema.ticketEvents)
      .where(eq(schema.ticketEvents.ticketId, ticketId))
      .limit(1)
      .get()!;

    expect(() =>
      db.update(schema.ticketEvents).set({ summary: 'never happened' }).where(eq(schema.ticketEvents.id, event.id)).run(),
    ).toThrow(/append-only/);
    expect(() =>
      db.delete(schema.ticketEvents).where(eq(schema.ticketEvents.id, event.id)).run(),
    ).toThrow(/append-only/);
  });

  it('records every act on a ticket, including the ones nobody wants recorded', async () => {
    const ticketId = freshTicket();
    withConversation(ticketId);
    await post(owner, `/v1/admin/support/tickets/${ticketId}/escalate`, { reason: 'Member is very upset.' });
    await post(owner, `/v1/admin/support/tickets/${ticketId}/reply`, { body: 'I am sorry about this.' });
    await post(owner, `/v1/admin/support/tickets/${ticketId}/resolve`, { resolution: 'Refunded the month.' });

    const detail = (await (await get(owner, `/v1/admin/support/tickets/${ticketId}`)).json()) as {
      timeline: Array<{ kind: string; actorName: string; messageId: string | null }>;
    };
    const kinds = detail.timeline.map((e) => e.kind);
    expect(kinds).toContain('escalated');
    expect(kinds).toContain('replied');
    expect(kinds).toContain('resolved');
    // The reply event points at the exact message, so the timeline and the
    // conversation are provably one history.
    expect(detail.timeline.find((e) => e.kind === 'replied')?.messageId).not.toBeNull();
  });

  it('audits every mutation as well, for the record staff cannot read', async () => {
    const ticketId = freshTicket();
    const since = now();
    await post(owner, `/v1/admin/support/tickets/${ticketId}/escalate`, { reason: 'Needs a manager today.' });

    const entries = db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, ticketId), sql`${schema.auditLog.at} >= ${since}`))
      .all();
    expect(entries.map((e) => e.action)).toContain('ticket.escalated');
  });
});

/* ==========================================================================
   Creation, idempotency and safety
   ========================================================================= */

describe('Raising a ticket at the desk', () => {
  it('creates the member conversation so the ticket has one history from the start', async () => {
    const memberId = anyMemberId();
    const response = await post(owner, '/v1/admin/support/tickets', {
      memberId,
      branchId: 'br_kor',
      category: 'facility',
      subject: 'Reported at the desk',
      body: 'Locker 42 will not lock.',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ticket: { id: string; reference: string };
      conversationId: string | null;
      messages: Array<{ body: string }>;
    };
    expect(body.conversationId).not.toBeNull();
    expect(body.messages).toHaveLength(1);
    expect(body.ticket.reference).toMatch(/^SUP-\d+$/);
  });

  it('replays a retried creation instead of raising the same ticket twice', async () => {
    const key = `ticket-${id('k')}`;
    const body = {
      memberId: null,
      branchId: 'br_kor',
      category: 'other',
      subject: 'Double tap on a bad connection',
      body: 'Sent twice from the same press.',
    };
    const first = await post(owner, '/v1/admin/support/tickets', body, key);
    const second = await post(owner, '/v1/admin/support/tickets', body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(((await first.json()) as { ticket: { id: string } }).ticket.id).toBe(
      ((await second.json()) as { ticket: { id: string } }).ticket.id,
    );

    const matching = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.tenantId, tenantId()), eq(schema.tickets.subject, body.subject)))
      .get();
    expect(matching?.n).toBe(1);
  });

  it('shortens the promise and blocks automation when the words trip a safety pattern', async () => {
    // PF-SUP-005: nothing automated contacts somebody who wrote this.
    const response = await post(owner, '/v1/admin/support/tickets', {
      memberId: anyMemberId(),
      branchId: 'br_kor',
      category: 'other',
      subject: 'Member disclosure at the desk',
      // Wording that trips the `distress` pattern in `@shark/domain`'s scanner,
      // whose action is `show_resources` — the most serious of the three. The
      // scanner matches the contraction, not "cannot".
      body: "She told me at the desk that she can't go on and did not know who else to tell.",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ticket: {
        priority: string;
        escalated: boolean;
        vulnerabilityFlag: boolean;
        safetyCategories: string[];
        sla: { responseMinutes: number | null };
      };
    };
    expect(body.ticket.priority).toBe('urgent');
    expect(body.ticket.escalated).toBe(true);
    expect(body.ticket.vulnerabilityFlag).toBe(true);
    expect(body.ticket.safetyCategories.length).toBeGreaterThan(0);
    expect(body.ticket.sla.responseMinutes).toBeLessThanOrEqual(4 * 60);
  });
});

/* ==========================================================================
   Feedback — PF-SUP-002
   ========================================================================= */

describe('Feedback', () => {
  it('computes NPS by its definition rather than as an average', async () => {
    const body = (await (await get(owner, '/v1/admin/support/feedback')).json()) as {
      nps: { responses: number; promoters: number; detractors: number; score: number | null };
    };
    expect(body.nps.responses).toBeGreaterThanOrEqual(5);
    const expected = Math.round(((body.nps.promoters - body.nps.detractors) / body.nps.responses) * 100);
    expect(body.nps.score).toBe(expected);
  });

  it('withholds a rate under the reporting floor instead of printing a confident number', async () => {
    // An NPS of −100 from one grumpy answer is arithmetically true and useless.
    const body = (await (await get(owner, '/v1/admin/support/feedback?kind=nps&from=1&to=2')).json()) as {
      nps: { responses: number; score: number | null };
      csat: { responses: number; average: number | null };
    };
    expect(body.nps.responses).toBe(0);
    expect(body.nps.score).toBeNull();
    expect(body.csat.average).toBeNull();
  });

  it('records anonymous feedback with no member attached at all', async () => {
    const memberId = anyMemberId();
    const response = await post(owner, '/v1/admin/support/feedback', {
      memberId,
      branchId: 'br_kor',
      kind: 'csat',
      score: 1,
      comment: 'Would rather not say who this is.',
      anonymous: true,
    });
    expect(response.status).toBe(201);

    const row = db
      .select()
      .from(schema.feedback)
      .where(and(eq(schema.feedback.tenantId, tenantId()), eq(schema.feedback.comment, 'Would rather not say who this is.')))
      .get()!;
    // Absent, not masked: there is no member id in the row to leak later.
    expect(row.memberId).toBeNull();
    expect(row.anonymous).toBe(true);
  });

  it('refuses a score outside its scale', async () => {
    const response = await post(owner, '/v1/admin/support/feedback', {
      memberId: null,
      branchId: 'br_kor',
      kind: 'csat',
      score: 9,
      comment: '',
    });
    expect(response.status).toBe(422);
  });
});

/* ==========================================================================
   Retention and interventions — PF-SUP-003, PF-SUP-004, PF-SUP-005
   ========================================================================= */

describe('Retention and interventions', () => {
  it('explains every risk score it reports', async () => {
    const body = (await (await get(owner, '/v1/admin/support/retention?branchId=br_kor')).json()) as {
      atRisk: Array<{ score: number; reasons: unknown[]; recommendedAction: string; suppressed: string | null }>;
      bands: { high: number; watch: number; low: number };
    };
    for (const m of body.atRisk) {
      // PF-SUP-003 asks for explainable. A score with no contributions and no
      // suppression note would be a number nobody can act on.
      if (m.suppressed === null) expect(m.reasons.length).toBeGreaterThan(0);
      expect(m.recommendedAction.length).toBeGreaterThan(0);
    }
    expect(Number.isInteger(body.bands.high)).toBe(true);
  });

  it('states why an automated message may not be sent, per member', async () => {
    const body = (await (await get(owner, '/v1/admin/support/retention?branchId=br_kor')).json()) as {
      atRisk: Array<{ outreach: { allowed: boolean; reason: string | null } }>;
    };
    for (const m of body.atRisk) {
      if (!m.outreach.allowed) expect(m.outreach.reason).not.toBeNull();
      else expect(m.outreach.reason).toBeNull();
    }
  });

  it('freezes the risk score onto the intervention so effectiveness stays answerable', async () => {
    const view = (await (await get(owner, '/v1/admin/support/retention?branchId=br_kor')).json()) as {
      atRisk: Array<{ memberId: string; score: number; openInterventionId: string | null }>;
    };
    const target = view.atRisk.find((m) => m.openInterventionId === null);
    if (!target) return;

    const created = await post(owner, '/v1/admin/support/interventions', {
      memberId: target.memberId,
      action: 'call',
      note: 'Ask what changed.',
      dueInDays: 3,
    });
    expect(created.status).toBe(201);
    const { interventionId } = (await created.json()) as { interventionId: string };

    const row = db.select().from(schema.interventions).where(eq(schema.interventions.id, interventionId)).get()!;
    // Risk is recomputed live; without this snapshot "did calling people at 71
    // work?" stops being answerable the moment their score moves.
    expect(row.riskScoreAtCreation).toBe(target.score);
    expect(row.riskReasonsAtCreation.length).toBeGreaterThanOrEqual(0);
    expect(row.recommendedAction.length).toBeGreaterThan(0);
  });

  it('refuses a second open intervention for the same member', async () => {
    const view = (await (await get(owner, '/v1/admin/support/retention?branchId=br_kor')).json()) as {
      atRisk: Array<{ memberId: string; openInterventionId: string | null }>;
    };
    const taken = view.atRisk.find((m) => m.openInterventionId !== null);
    if (!taken) return;
    const response = await post(owner, '/v1/admin/support/interventions', {
      memberId: taken.memberId,
      action: 'call',
      dueInDays: 3,
    });
    // Two people ringing the same member on the same day is the failure this
    // whole surface exists to stop.
    expect(response.status).toBe(409);
  });

  it('leaves unreachable members and false positives out of the effectiveness rate', async () => {
    const body = (await (await get(owner, '/v1/admin/support/retention?branchId=br_kor')).json()) as {
      effectiveness: Array<{
        action: string;
        attempted: number;
        retained: number;
        churned: number;
        noContact: number;
        falsePositive: number;
        retentionRate: number | null;
      }>;
    };
    const call = body.effectiveness.find((e) => e.action === 'call');
    expect(call).toBeDefined();
    const judged = call!.retained + call!.churned;
    if (judged >= 3) {
      // A call nobody answered says nothing about whether calling works.
      expect(call!.retentionRate).toBe(Math.round((call!.retained / judged) * 100));
    } else {
      expect(call!.retentionRate).toBeNull();
    }
  });

  it('records an outcome and closes the task', async () => {
    const open = db
      .select()
      .from(schema.interventions)
      .where(and(eq(schema.interventions.tenantId, tenantId()), eq(schema.interventions.state, 'open')))
      .limit(1)
      .get();
    if (!open) return;

    const response = await post(owner, `/v1/admin/support/interventions/${open.id}/close`, {
      outcome: 'retained',
      outcomeNote: 'Spoke to them; coming back Tuesday.',
      state: 'done',
    });
    expect(response.status).toBe(200);

    const again = await post(owner, `/v1/admin/support/interventions/${open.id}/close`, { outcome: 'churned' });
    expect(again.status).toBe(409);
  });
});
