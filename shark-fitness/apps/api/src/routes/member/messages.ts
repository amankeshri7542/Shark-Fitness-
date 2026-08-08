import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { channels } from '@shark/contracts';
import { scanForSafety, type SafetySignal } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { conflict, invalid, notFound, precondition } from '../../lib/errors.js';
import { id, initialsOf } from '../../lib/ids.js';
import { HOUR, MINUTE, isoDate, localMinutes, now, relativeTime } from '../../lib/time.js';

export const messagesRoutes = new Hono();

/**
 * Member messaging and support (UX-M12, PF-SUP).
 *
 * Two rules shape this file.
 *
 * 1. Nobody waits in the dark. Every conversation carries the hours its
 *    counterpart actually works and the reply window they actually hold to, so
 *    a message sent at 23:40 says "reception opens at 6am" instead of sitting
 *    there silently (UX-M12 "outside hours").
 * 2. A message is never blocked. `scanForSafety` from @shark/domain flags a
 *    body that mentions injury, distress or a medical symptom; the message is
 *    still delivered exactly as written, the thread is escalated to a human and
 *    automated coaching stops (PF-SUP-005, PF-AI-005). Nothing here replies
 *    with advice and nothing here diagnoses.
 */

/* ============================================================================
   Staff hours and reply windows
   ========================================================================= */

type ConversationKind = 'coach' | 'reception' | 'support' | 'group';

/** What each counterpart actually commits to. Clamped to the branch's own
 *  opening hours below, so a gym that shuts at 8pm never promises 9pm. */
const WINDOW: Record<ConversationKind, { fromMin: number; toMin: number; within: string }> = {
  coach: { fromMin: 9 * 60, toMin: 21 * 60, within: 'a few hours' },
  reception: { fromMin: 6 * 60, toMin: 23 * 60, within: 'an hour' },
  support: { fromMin: 9 * 60, toMin: 18 * 60, within: 'one working day' },
  group: { fromMin: 9 * 60, toMin: 21 * 60, within: 'a few hours' },
};

function hourLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

interface Branchish {
  timezone: string;
  opensMinutes: number;
  closesMinutes: number;
  holidays: string[];
  name: string;
}

interface HoursView {
  fromMin: number;
  toMin: number;
  hoursLabel: string;
  responseWindow: string;
  outsideHours: boolean;
  /** Why it is outside hours, in the member's words. Null when it is not. */
  outsideNote: string | null;
  opensLabel: string;
}

function hoursFor(kind: ConversationKind, branch: Branchish, at: number): HoursView {
  const spec = WINDOW[kind] ?? WINDOW.coach;
  const fromMin =
    kind === 'reception' ? branch.opensMinutes : Math.max(spec.fromMin, branch.opensMinutes);
  const toMin = kind === 'reception' ? branch.closesMinutes : Math.min(spec.toMin, branch.closesMinutes);

  const hoursLabel = `${hourLabel(fromMin)}–${hourLabel(toMin)}`;
  const minutesNow = localMinutes(at, branch.timezone);
  const onHoliday = branch.holidays.includes(isoDate(at, branch.timezone));
  const closed = onHoliday || minutesNow < fromMin || minutesNow >= toMin;

  return {
    fromMin,
    toMin,
    hoursLabel,
    responseWindow: `Replies usually within ${spec.within}, ${hoursLabel}`,
    outsideHours: closed,
    outsideNote: !closed
      ? null
      : onHoliday
        ? `${branch.name} is closed today. Your message is saved and answered when the desk reopens.`
        : minutesNow < fromMin
          ? `It is outside ${hoursLabel}. Your message is saved and answered from ${hourLabel(fromMin)}.`
          : `It is outside ${hoursLabel}. Your message is saved and answered from ${hourLabel(fromMin)} tomorrow.`,
    opensLabel: hourLabel(fromMin),
  };
}

/* ============================================================================
   Attachments
   ========================================================================= */

/**
 * There is no object store wired up in this deployment, so the app cannot put a
 * file anywhere a coach could open it. The policy is reported rather than
 * hidden, and a send that carries files is refused with an explanation instead
 * of silently dropping them (UX-M12 "failed attachment").
 */
function attachmentPolicy(): { enabled: boolean; maxSizeMb: number; accept: string[]; reason: string | null } {
  const bucket = process.env.SHARK_MEDIA_BUCKET ?? '';
  if (!bucket) {
    return {
      enabled: false,
      maxSizeMb: 0,
      accept: [],
      reason:
        'Photos and files cannot be sent from the app yet. Show it at reception, or describe it here and someone will come and look.',
    };
  }
  return { enabled: true, maxSizeMb: 10, accept: ['image/jpeg', 'image/png', 'application/pdf'], reason: null };
}

/* ============================================================================
   Shared reads
   ========================================================================= */

function memberAndBranch(memberId: string): { member: typeof schema.members.$inferSelect; branch: Branchish } {
  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get();
  if (!member) throw notFound('Your membership');

  const row = db.select().from(schema.branches).where(eq(schema.branches.id, member.homeBranchId)).get();
  const branch: Branchish = {
    timezone: row?.timezone ?? 'Asia/Kolkata',
    opensMinutes: row?.opensMinutes ?? 6 * 60,
    closesMinutes: row?.closesMinutes ?? 23 * 60,
    holidays: row?.holidays ?? [],
    name: row?.name ?? 'Your gym',
  };
  return { member, branch };
}

interface Counterpart {
  staffId: string | null;
  userId: string | null;
  name: string;
  initials: string;
  role: string;
}

const ROLE_LABEL: Record<string, string> = {
  trainer: 'Coach',
  reception: 'Reception',
  manager: 'Branch manager',
  owner: 'Owner',
  accountant: 'Accounts',
  support: 'Support',
  member: 'Member',
};

function counterpartFor(staffId: string | null, fallbackTitle: string, fallbackRole: string): Counterpart {
  if (!staffId) {
    return { staffId: null, userId: null, name: fallbackTitle, initials: initialsOf(fallbackTitle), role: fallbackRole };
  }
  const row = db
    .select({ userId: schema.users.id, name: schema.users.name, initials: schema.users.initials, role: schema.users.role })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(eq(schema.staff.id, staffId))
    .get();
  if (!row) {
    return { staffId, userId: null, name: fallbackTitle, initials: initialsOf(fallbackTitle), role: fallbackRole };
  }
  return {
    staffId,
    userId: row.userId,
    name: row.name,
    initials: row.initials,
    role: ROLE_LABEL[row.role] ?? fallbackRole,
  };
}

/**
 * Who is actually handling this thread now, and whether that is a different
 * person from the one the member has been talking to (UX-M12 "staff
 * reassigned"). For a coach thread the member's current trainer wins — a coach
 * leaving is exactly the case the member must not discover by being ignored.
 */
function handoverFor(
  conversation: typeof schema.conversations.$inferSelect,
  memberTrainerId: string | null,
): { counterpart: Counterpart; reassignment: { previousName: string; note: string } | null } {
  const assigned = counterpartFor(conversation.staffId, conversation.title, 'Gym team');

  const currentStaffId =
    conversation.kind === 'coach' && memberTrainerId ? memberTrainerId : conversation.staffId;

  const current =
    currentStaffId && currentStaffId !== conversation.staffId
      ? counterpartFor(currentStaffId, conversation.title, 'Gym team')
      : assigned;

  if (current.staffId !== assigned.staffId && assigned.name !== current.name) {
    return {
      counterpart: current,
      reassignment: {
        previousName: assigned.name,
        note: `${assigned.name} has handed this over to ${current.name}. The whole thread came across, so you do not have to repeat yourself.`,
      },
    };
  }

  // Nobody reassigned, but the last person who replied is not the one on the
  // record — a cover shift. Worth saying, for the same reason.
  const lastStaffMessage = db
    .select({ senderUserId: schema.messages.senderUserId, senderName: schema.messages.senderName })
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversation.id), ne(schema.messages.senderRole, 'member')))
    .orderBy(desc(schema.messages.createdAt))
    .get();

  if (
    lastStaffMessage &&
    current.userId &&
    lastStaffMessage.senderUserId !== current.userId &&
    lastStaffMessage.senderName !== current.name
  ) {
    return {
      counterpart: current,
      reassignment: {
        previousName: lastStaffMessage.senderName,
        note: `${lastStaffMessage.senderName} answered you last; ${current.name} is on this thread now.`,
      },
    };
  }

  return { counterpart: current, reassignment: null };
}

function unreadCount(conversationId: string, userId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          ne(schema.messages.senderUserId, userId),
          isNull(schema.messages.readAt),
        ),
      )
      .get()?.n ?? 0
  );
}

/* ============================================================================
   SLA
   ========================================================================= */

type SlaState = 'resolved' | 'breached' | 'due_soon' | 'on_track' | 'none';

/** Hours the gym gives itself, by what the member is asking about. */
const SLA_HOURS: Record<string, number> = {
  billing: 8,
  membership: 24,
  facility: 24,
  class: 12,
  app: 48,
  complaint: 4,
  other: 24,
};

function slaView(ticket: typeof schema.tickets.$inferSelect, at: number): {
  state: SlaState;
  label: string;
  dueInMin: number | null;
} {
  if (ticket.state === 'resolved' || ticket.state === 'closed') {
    return { state: 'resolved', label: ticket.state === 'closed' ? 'Closed' : 'Resolved', dueInMin: null };
  }
  if (ticket.slaDueAt === null) {
    return { state: 'none', label: 'No reply time set', dueInMin: null };
  }

  const dueInMin = Math.round((ticket.slaDueAt - at) / MINUTE);
  if (dueInMin < 0) {
    return {
      state: 'breached',
      label: 'Past the reply time we promised',
      dueInMin,
    };
  }
  if (dueInMin <= 4 * 60) {
    return { state: 'due_soon', label: `Reply due in ${dueInMin < 60 ? `${dueInMin} min` : `${Math.round(dueInMin / 60)}h`}`, dueInMin };
  }
  return {
    state: 'on_track',
    label: dueInMin < 24 * 60 ? `Reply due in ${Math.round(dueInMin / 60)}h` : `Reply due in ${Math.round(dueInMin / (60 * 24))} days`,
    dueInMin,
  };
}

/* ============================================================================
   Safety
   ========================================================================= */

/** What the member is told when their own message trips a pattern. Plain
 *  register, no diagnosis, no lecture — it says who is now involved. */
function safetyNotice(signals: SafetySignal[]): {
  flagged: boolean;
  categories: string[];
  note: string;
  showResources: boolean;
} | null {
  if (signals.length === 0) return null;
  const showResources = signals.some((s) => s.action === 'show_resources');
  return {
    flagged: true,
    categories: signals.map((s) => s.category),
    note: showResources
      ? 'A person on the team has been alerted and will read this now. If you need someone outside the gym, reception can share local support numbers.'
      : signals.some((s) => s.action === 'block_automation')
        ? 'Your message is sent as written. A coach reviews it before your plan changes again — nothing automatic will adjust your training in the meantime.'
        : 'Your message is sent as written and a person will answer it, not an automated reply.',
    showResources,
  };
}

/* ============================================================================
   GET /tickets — support tickets with SLA state
   Registered before /:conversationId so the literal path always wins.
   ========================================================================= */

messagesRoutes.get('/tickets', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const at = now();

  const rows = db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.tenantId, ctx.tenantId), eq(schema.tickets.memberId, memberId)))
    .orderBy(desc(schema.tickets.lastUpdateAt))
    .limit(50)
    .all();

  const items = rows.map((t) => {
    const sla = slaView(t, at);
    const assignee = t.assigneeId ? counterpartFor(t.assigneeId, 'The gym team', 'Gym team') : null;
    const conversation = db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.ticketId, t.id), eq(schema.conversations.memberId, memberId)))
      .get();

    return {
      id: t.id,
      reference: t.reference,
      category: t.category,
      subject: t.subject,
      priority: t.priority,
      state: t.state,
      escalated: t.escalated,
      openedAt: new Date(t.openedAt).toISOString(),
      openedRelative: relativeTime(t.openedAt),
      lastUpdateAt: new Date(t.lastUpdateAt).toISOString(),
      lastUpdateRelative: relativeTime(t.lastUpdateAt),
      slaDueAt: t.slaDueAt === null ? null : new Date(t.slaDueAt).toISOString(),
      slaState: sla.state,
      slaLabel: sla.label,
      slaDueInMin: sla.dueInMin,
      assigneeName: assignee?.name ?? null,
      resolution: t.resolution,
      conversationId: conversation?.id ?? null,
    };
  });

  return c.json({
    items,
    openCount: items.filter((t) => t.state !== 'resolved' && t.state !== 'closed').length,
    categories: Object.keys(SLA_HOURS).map((key) => ({ value: key, replyHours: SLA_HOURS[key]! })),
  });
});

/* ============================================================================
   POST /tickets — open a ticket
   ========================================================================= */

const TicketOpenInput = z.object({
  category: z.enum(['billing', 'membership', 'facility', 'class', 'app', 'complaint', 'other']),
  subject: z.string().trim().min(3).max(120),
  body: z.string().trim().min(1).max(4000),
  anonymous: z.boolean().optional().default(false),
});

messagesRoutes.post('/tickets', zValidator('json', TicketOpenInput), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const input = c.req.valid('json');
  const at = now();
  const { member, branch } = memberAndBranch(memberId);

  const signals = scanForSafety(input.body);
  const notice = safetyNotice(signals);

  // A double-tap on a phone with one bar must not raise two tickets. There is
  // no idempotency index on this table, so the guard is a short window on the
  // same subject rather than a claimed guarantee.
  if (!input.anonymous) {
    const recent = db
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.tenantId, ctx.tenantId),
          eq(schema.tickets.memberId, memberId),
          eq(schema.tickets.subject, input.subject),
          eq(schema.tickets.category, input.category),
        ),
      )
      .orderBy(desc(schema.tickets.openedAt))
      .get();

    if (recent && at - recent.openedAt < 5 * MINUTE) {
      const conversation = db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.ticketId, recent.id))
        .get();
      return c.json({
        ticket: { id: recent.id, reference: recent.reference, state: recent.state },
        conversationId: conversation?.id ?? null,
        anonymous: false,
        duplicate: true,
        message: `You already opened ${recent.reference} for this a moment ago. It is with the team.`,
        safety: notice,
      });
    }
  }

  const existingRefs = db
    .select({ reference: schema.tickets.reference })
    .from(schema.tickets)
    .where(eq(schema.tickets.tenantId, ctx.tenantId))
    .all();
  const nextNumber =
    existingRefs.reduce((max, r) => Math.max(max, Number.parseInt(r.reference.replace(/\D/g, ''), 10) || 0), 1000) + 1;
  const reference = `SUP-${nextNumber}`;

  const escalated = signals.length > 0 || input.category === 'complaint';
  const priority = signals.some((s) => s.action === 'show_resources')
    ? 'urgent'
    : escalated || input.category === 'billing'
      ? 'high'
      : 'normal';
  const slaHours = signals.length > 0 ? Math.min(SLA_HOURS[input.category] ?? 24, 4) : (SLA_HOURS[input.category] ?? 24);

  const ticketId = id('tkt');
  const conversationId = input.anonymous ? null : id('cnv');
  const messageId = input.anonymous ? null : id('msg');

  transact(() => {
    db.insert(schema.tickets)
      .values({
        id: ticketId,
        tenantId: ctx.tenantId,
        branchId: member.homeBranchId,
        // An anonymous report keeps the member link out of the ticket entirely.
        // Nothing in the staff queue can walk back to this person.
        memberId: input.anonymous ? null : memberId,
        reference,
        category: input.category,
        subject: input.subject,
        priority,
        state: 'open',
        assigneeId: null,
        slaDueAt: at + slaHours * HOUR,
        resolution: null,
        anonymous: input.anonymous,
        escalated,
        openedAt: at,
        lastUpdateAt: at,
        closedAt: null,
      })
      .run();

    if (conversationId && messageId) {
      db.insert(schema.conversations)
        .values({
          id: conversationId,
          tenantId: ctx.tenantId,
          kind: 'support',
          title: `${reference} · ${input.subject}`,
          memberId,
          staffId: null,
          ticketId,
          state: 'open',
          muted: false,
          lastMessageAt: at,
          createdAt: at,
        })
        .run();

      db.insert(schema.messages)
        .values({
          id: messageId,
          tenantId: ctx.tenantId,
          conversationId,
          senderUserId: ctx.userId,
          senderName: ctx.name,
          senderRole: 'member',
          body: input.body,
          attachments: [],
          state: 'sent',
          clientId: null,
          createdAt: at,
          readAt: at,
          safetyFlagged: signals.length > 0,
        })
        .run();

      db.insert(schema.notifications)
        .values({
          id: id('ntf'),
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          channel: 'in_app',
          kind: 'system',
          title: `${reference} opened`,
          body: `We will reply within ${slaHours} hours. You can follow it in Messages.`,
          link: `/messages/${conversationId}`,
          templateCode: null,
          state: 'sent',
          attempts: 0,
          lastError: null,
          createdAt: at,
          readAt: null,
        })
        .run();
    }

    // PF-SUP-006: an immutable record exists for every report, including an
    // anonymous one. The actor lives in the restricted audit log, never in the
    // ticket the front desk sees.
    audit(ctx, {
      action: 'ticket.opened',
      entityType: 'ticket',
      entityId: ticketId,
      entityLabel: reference,
      branchId: member.homeBranchId,
      after: {
        category: input.category,
        priority,
        anonymous: input.anonymous,
        escalated,
        safety: signals.map((s) => s.category),
      },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId: member.homeBranchId,
      channel: channels.branch(member.homeBranchId),
      topic: escalated ? 'alert.raised' : 'notification.created',
      payload: {
        kind: 'ticket',
        ticketId,
        reference,
        category: input.category,
        priority,
        escalated,
        anonymous: input.anonymous,
      },
    });

    if (conversationId && messageId) {
      emit({
        tenantId: ctx.tenantId,
        branchId: member.homeBranchId,
        channel: channels.member(memberId),
        topic: 'message.created',
        payload: { conversationId, messageId, ticketId, reference },
      });
    }
  });

  const hours = hoursFor('support', branch, at);

  return c.json(
    {
      ticket: {
        id: ticketId,
        reference,
        category: input.category,
        subject: input.subject,
        priority,
        state: 'open',
        slaDueAt: new Date(at + slaHours * HOUR).toISOString(),
        slaLabel: `Reply due in ${slaHours}h`,
      },
      conversationId,
      anonymous: input.anonymous,
      duplicate: false,
      message: input.anonymous
        ? `Report ${reference} is with the team. It is not linked to your account, so nobody can see it came from you — which also means we cannot reply here. Write the reference down if you want to ask about it at reception.`
        : `${reference} is open. Someone will reply within ${slaHours} hours${hours.outsideHours ? `, from ${hours.opensLabel}` : ''}.`,
      responseWindow: hours.responseWindow,
      outsideHours: hours.outsideHours,
      safety: notice,
    },
    201,
  );
});

/* ============================================================================
   GET / — the inbox
   ========================================================================= */

messagesRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const at = now();
  const { member, branch } = memberAndBranch(memberId);

  const rows = db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.tenantId, ctx.tenantId), eq(schema.conversations.memberId, memberId)))
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(50)
    .all();

  const items = rows.map((conversation) => {
    const kind = conversation.kind as ConversationKind;
    const hours = hoursFor(kind, branch, at);
    const { counterpart, reassignment } = handoverFor(conversation, member.trainerId);

    const last = db
      .select({
        body: schema.messages.body,
        senderUserId: schema.messages.senderUserId,
        senderName: schema.messages.senderName,
        createdAt: schema.messages.createdAt,
        safetyFlagged: schema.messages.safetyFlagged,
        attachments: schema.messages.attachments,
      })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversation.id))
      .orderBy(desc(schema.messages.createdAt))
      .get();

    const ticket = conversation.ticketId
      ? db.select().from(schema.tickets).where(eq(schema.tickets.id, conversation.ticketId)).get()
      : null;

    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      counterpartName: counterpart.name,
      counterpartInitials: counterpart.initials,
      counterpartRole: counterpart.role,
      lastMessage: last?.body ?? 'No messages yet.',
      lastMessageFromMe: last ? last.senderUserId === ctx.userId : false,
      lastMessageAt: new Date(last?.createdAt ?? conversation.lastMessageAt).toISOString(),
      lastMessageRelative: relativeTime(last?.createdAt ?? conversation.lastMessageAt),
      lastMessageFlagged: last?.safetyFlagged ?? false,
      unread: unreadCount(conversation.id, ctx.userId),
      muted: conversation.muted,
      state: conversation.state,
      responseWindow: hours.responseWindow,
      hoursLabel: hours.hoursLabel,
      outsideHours: hours.outsideHours,
      outsideNote: hours.outsideNote,
      reassignment,
      ticket: ticket
        ? {
            id: ticket.id,
            reference: ticket.reference,
            state: ticket.state,
            slaState: slaView(ticket, at).state,
            slaLabel: slaView(ticket, at).label,
          }
        : null,
    };
  });

  const openTickets = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.tenantId, ctx.tenantId),
        eq(schema.tickets.memberId, memberId),
        sql`${schema.tickets.state} not in ('resolved','closed')`,
      ),
    )
    .get();

  return c.json({
    items,
    unreadTotal: items.reduce((sum, i) => sum + i.unread, 0),
    openTicketCount: openTickets?.n ?? 0,
    branch: { id: member.homeBranchId, name: branch.name, timezone: branch.timezone },
    desk: hoursFor('reception', branch, at),
    attachments: attachmentPolicy(),
  });
});

/* ============================================================================
   GET /:conversationId — the thread
   ========================================================================= */

const ThreadQuery = z.object({
  /** Epoch ms of the oldest message already on screen. Pages backwards. */
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
});

messagesRoutes.get('/:conversationId', zValidator('query', ThreadQuery), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const conversationId = c.req.param('conversationId');
  const { cursor, limit } = c.req.valid('query');
  const at = now();
  const { member, branch } = memberAndBranch(memberId);

  const conversation = db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.tenantId, ctx.tenantId),
        eq(schema.conversations.memberId, memberId),
      ),
    )
    .get();
  if (!conversation) throw notFound('That conversation');

  const where = cursor
    ? and(eq(schema.messages.conversationId, conversationId), lt(schema.messages.createdAt, cursor))
    : eq(schema.messages.conversationId, conversationId);

  // Newest-first off the index, then flipped so the thread reads downwards.
  const page = db.select().from(schema.messages).where(where).orderBy(desc(schema.messages.createdAt)).limit(limit + 1).all();

  const hasMore = page.length > limit;
  const window = hasMore ? page.slice(0, limit) : page;
  const ordered = [...window].reverse();

  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .get()?.n ?? 0;

  const kind = conversation.kind as ConversationKind;
  const hours = hoursFor(kind, branch, at);
  const { counterpart, reassignment } = handoverFor(conversation, member.trainerId);

  const ticket = conversation.ticketId
    ? db.select().from(schema.tickets).where(eq(schema.tickets.id, conversation.ticketId)).get()
    : null;

  const items = ordered.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderName: m.senderName,
    senderInitials: initialsOf(m.senderName),
    senderRole: m.senderRole,
    fromMe: m.senderUserId === ctx.userId,
    body: m.body,
    createdAt: new Date(m.createdAt).toISOString(),
    relativeTime: relativeTime(m.createdAt),
    state: m.senderUserId === ctx.userId ? (m.readAt ? 'read' : 'sent') : m.state,
    // An attachment with no url never made it to storage. The thread says so
    // rather than rendering a dead link (UX-M12 "failed attachment").
    attachments: m.attachments.map((a) => ({ ...a, failed: !a.url })),
    clientId: m.clientId,
    safetyFlagged: m.safetyFlagged,
  }));

  const flaggedByMe = ordered.some((m) => m.safetyFlagged && m.senderUserId === ctx.userId);

  return c.json({
    conversation: {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      counterpartName: counterpart.name,
      counterpartInitials: counterpart.initials,
      counterpartRole: counterpart.role,
      muted: conversation.muted,
      state: conversation.state,
      responseWindow: hours.responseWindow,
      hoursLabel: hours.hoursLabel,
      outsideHours: hours.outsideHours,
      outsideNote: hours.outsideNote,
      reassignment,
      ticket: ticket
        ? {
            id: ticket.id,
            reference: ticket.reference,
            state: ticket.state,
            subject: ticket.subject,
            slaState: slaView(ticket, at).state,
            slaLabel: slaView(ticket, at).label,
          }
        : null,
      safetyNotice: flaggedByMe
        ? 'A person is on this thread because of something you wrote. Nothing you sent was hidden or changed.'
        : null,
    },
    items,
    nextCursor: hasMore && window.length > 0 ? String(window[window.length - 1]!.createdAt) : null,
    total,
    unread: unreadCount(conversation.id, ctx.userId),
    attachments: attachmentPolicy(),
  });
});

/* ============================================================================
   POST /:conversationId — send
   ========================================================================= */

const SendInput = z.object({
  /** Generated on the device before the request. Doubles as the idempotency
   *  key, so an outbox replay is a no-op (unique on conversation + clientId). */
  clientId: z.string().min(8).max(64),
  body: z.string().trim().min(1).max(4000),
  attachments: z
    .array(z.object({ name: z.string().min(1).max(200), url: z.string().max(1000), sizeBytes: z.number().int().min(0) }))
    .max(5)
    .optional()
    .default([]),
});

messagesRoutes.post('/:conversationId', zValidator('json', SendInput), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const conversationId = c.req.param('conversationId');
  const input = c.req.valid('json');
  const at = now();
  const { member, branch } = memberAndBranch(memberId);

  const conversation = db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.tenantId, ctx.tenantId),
        eq(schema.conversations.memberId, memberId),
      ),
    )
    .get();
  if (!conversation) throw notFound('That conversation');

  if (conversation.state === 'closed') {
    throw precondition('This conversation is closed. Open a new one and reception will pick it up.');
  }

  const policy = attachmentPolicy();
  if (input.attachments.length > 0 && !policy.enabled) {
    throw invalid(policy.reason ?? 'Attachments are not available.');
  }

  // Idempotent on clientId. The outbox replays the same entry after a dropped
  // connection; the member must not see their message twice.
  const existing = db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.clientId, input.clientId)))
    .get();

  if (existing) {
    if (existing.senderUserId !== ctx.userId) {
      throw conflict('That message id belongs to someone else in this thread.');
    }
    return c.json({
      message: {
        id: existing.id,
        conversationId,
        senderName: existing.senderName,
        senderInitials: initialsOf(existing.senderName),
        senderRole: existing.senderRole,
        fromMe: true,
        body: existing.body,
        createdAt: new Date(existing.createdAt).toISOString(),
        relativeTime: relativeTime(existing.createdAt),
        state: existing.readAt ? 'read' : 'sent',
        attachments: existing.attachments.map((a) => ({ ...a, failed: !a.url })),
        clientId: existing.clientId,
        safetyFlagged: existing.safetyFlagged,
      },
      duplicate: true,
      safety: safetyNotice(scanForSafety(existing.body)),
      responseWindow: hoursFor(conversation.kind as ConversationKind, branch, at).responseWindow,
      outsideHours: hoursFor(conversation.kind as ConversationKind, branch, at).outsideHours,
    });
  }

  // PF-SUP-005 / PF-AI-005. The scan never blocks the send. It escalates.
  const signals = scanForSafety(input.body);
  const notice = safetyNotice(signals);
  const messageId = id('msg');

  transact(() => {
    db.insert(schema.messages)
      .values({
        id: messageId,
        tenantId: ctx.tenantId,
        conversationId,
        senderUserId: ctx.userId,
        senderName: ctx.name,
        senderRole: 'member',
        body: input.body,
        attachments: input.attachments,
        state: 'sent',
        clientId: input.clientId,
        createdAt: at,
        readAt: null,
        safetyFlagged: signals.length > 0,
      })
      .run();

    db.update(schema.conversations)
      .set({ lastMessageAt: at, state: 'open' })
      .where(eq(schema.conversations.id, conversationId))
      .run();

    if (conversation.ticketId) {
      db.update(schema.tickets)
        .set({ lastUpdateAt: at, state: 'pending_staff' })
        .where(eq(schema.tickets.id, conversation.ticketId))
        .run();
    }

    if (signals.length > 0) {
      // Route it to a person. The counterpart on the thread gets a notification
      // they cannot mute, and the branch hears an alert.
      const { counterpart } = handoverFor(conversation, member.trainerId);
      if (counterpart.userId) {
        db.insert(schema.notifications)
          .values({
            id: id('ntf'),
            tenantId: ctx.tenantId,
            userId: counterpart.userId,
            channel: 'in_app',
            kind: 'system',
            title: 'A message needs a person',
            body: `${member.firstName} ${member.lastName} mentioned ${signals.map((s) => s.category.replace('_', ' ')).join(', ')}. Read it before anything automated runs.`,
            link: `/messages/${conversationId}`,
            templateCode: null,
            state: 'sent',
            attempts: 0,
            lastError: null,
            createdAt: at,
            readAt: null,
          })
          .run();
      }

      audit(ctx, {
        action: 'message.safety_flagged',
        entityType: 'message',
        entityId: messageId,
        entityLabel: conversation.title,
        branchId: member.homeBranchId,
        after: {
          categories: signals.map((s) => s.category),
          actions: signals.map((s) => s.action),
          conversationId,
        },
      });

      emit({
        tenantId: ctx.tenantId,
        branchId: member.homeBranchId,
        channel: channels.branch(member.homeBranchId),
        topic: 'alert.raised',
        payload: {
          kind: 'message_safety',
          conversationId,
          messageId,
          categories: signals.map((s) => s.category),
          memberId,
        },
      });
    }

    emit({
      tenantId: ctx.tenantId,
      branchId: member.homeBranchId,
      channel: channels.member(memberId),
      topic: 'message.created',
      payload: {
        conversationId,
        messageId,
        clientId: input.clientId,
        senderRole: 'member',
        safetyFlagged: signals.length > 0,
      },
    });
  });

  const hours = hoursFor(conversation.kind as ConversationKind, branch, at);

  return c.json(
    {
      message: {
        id: messageId,
        conversationId,
        senderName: ctx.name,
        senderInitials: initialsOf(ctx.name),
        senderRole: 'member',
        fromMe: true,
        body: input.body,
        createdAt: new Date(at).toISOString(),
        relativeTime: relativeTime(at),
        state: 'sent',
        attachments: input.attachments.map((a) => ({ ...a, failed: !a.url })),
        clientId: input.clientId,
        safetyFlagged: signals.length > 0,
      },
      duplicate: false,
      safety: notice,
      responseWindow: hours.responseWindow,
      outsideHours: hours.outsideHours,
      outsideNote: hours.outsideNote,
    },
    201,
  );
});

/* ============================================================================
   POST /:conversationId/read
   ========================================================================= */

messagesRoutes.post('/:conversationId/read', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const conversationId = c.req.param('conversationId');

  const conversation = db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.tenantId, ctx.tenantId),
        eq(schema.conversations.memberId, memberId),
      ),
    )
    .get();
  if (!conversation) throw notFound('That conversation');

  const at = now();
  const unread = db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        ne(schema.messages.senderUserId, ctx.userId),
        isNull(schema.messages.readAt),
      ),
    )
    .all();

  for (const row of unread) {
    db.update(schema.messages)
      .set({ readAt: at, state: 'read' })
      .where(eq(schema.messages.id, row.id))
      .run();
  }

  return c.json({ ok: true, marked: unread.length, unread: 0 });
});

/* ============================================================================
   POST /:conversationId/mute
   ========================================================================= */

const MuteInput = z.object({ muted: z.boolean() });

messagesRoutes.post('/:conversationId/mute', zValidator('json', MuteInput), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const conversationId = c.req.param('conversationId');
  const { muted } = c.req.valid('json');

  const conversation = db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.tenantId, ctx.tenantId),
        eq(schema.conversations.memberId, memberId),
      ),
    )
    .get();
  if (!conversation) throw notFound('That conversation');

  db.update(schema.conversations).set({ muted }).where(eq(schema.conversations.id, conversationId)).run();

  return c.json({
    ok: true,
    muted,
    message: muted
      ? 'Muted. The thread stays here and messages still arrive — you just will not be notified.'
      : 'Notifications are back on for this thread.',
  });
});

/* Ordering note: Hono matches the literal `/tickets` routes above before the
   `/:conversationId` parameter routes, which is why they are declared first.
   `asc` is imported for the paging read below; keep it referenced. */
void asc;
