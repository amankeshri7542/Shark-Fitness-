import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { emit } from '../lib/events.js';
import { conflict, invalid } from '../lib/errors.js';
import { id, initialsOf } from '../lib/ids.js';
import { now, relativeTime } from '../lib/time.js';
import {
  assertMinorRule,
  attachmentsByMessage,
  loadConversationForStaff,
  memberIsMinor,
  staffCanSee,
} from './messaging.js';
import { queueNotification } from './notifications/service.js';

/**
 * The staff Inbox (P07; PF-COMM-001, PF-SUP-004).
 *
 * Member-started threads with a coach or a branch desk. Staff can assign a
 * thread, mark it read, reply, and keep **internal notes**. Notes live in
 * `conversation_notes` and are only ever read here: no member route selects
 * that table, so a note cannot leak through a serializer someone forgot to
 * filter.
 */

type Conversation = typeof schema.conversations.$inferSelect;

export type InboxFilter = 'all' | 'mine' | 'unassigned' | 'unread' | 'closed';

const STAFF_ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  regional_manager: 'Regional manager',
  branch_manager: 'Branch manager',
  reception: 'Front desk',
  trainer: 'Coach',
  accountant: 'Accounts',
};

function staffNames(staffIds: string[]): Map<string, { name: string; initials: string }> {
  const ids = [...new Set(staffIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ staffId: schema.staff.id, name: schema.users.name, initials: schema.users.initials })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(inArray(schema.staff.id, ids))
      .all()
      .map((r) => [r.staffId, { name: r.name, initials: r.initials }] as const),
  );
}

function unreadForStaff(conversation: Conversation): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversation.id),
          eq(schema.messages.senderRole, 'member'),
          conversation.staffReadAt ? gt(schema.messages.createdAt, conversation.staffReadAt) : undefined,
        ),
      )
      .get()?.n ?? 0
  );
}

export function listInbox(ctx: RequestContext, filter: InboxFilter, q?: string) {
  requirePermission(ctx, 'inbox.view');
  const scope = branchScope(ctx);
  const rows = db
    .select({ conversation: schema.conversations, member: schema.members })
    .from(schema.conversations)
    .innerJoin(schema.members, eq(schema.members.id, schema.conversations.memberId))
    .where(
      and(
        eq(schema.conversations.tenantId, ctx.tenantId),
        inArray(schema.conversations.kind, ['coach', 'reception']),
        or(inArray(schema.conversations.branchId, scope), and(isNull(schema.conversations.branchId), inArray(schema.members.homeBranchId, scope))),
        filter === 'closed' ? eq(schema.conversations.state, 'closed') : ne(schema.conversations.state, 'closed'),
        filter === 'mine' ? eq(schema.conversations.assignedStaffId, ctx.staffId ?? '') : undefined,
        filter === 'unassigned' ? isNull(schema.conversations.assignedStaffId) : undefined,
        q
          ? sql`(lower(${schema.members.firstName} || ' ' || ${schema.members.lastName}) like ${`%${q.toLowerCase()}%`} or lower(${schema.conversations.title}) like ${`%${q.toLowerCase()}%`})`
          : undefined,
      ),
    )
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(200)
    .all()
    .filter(({ conversation, member }) => staffCanSee(ctx, conversation, member));

  const names = staffNames(rows.map((r) => r.conversation.assignedStaffId ?? ''));
  const items = rows
    .map(({ conversation, member }) => {
      const last = db
        .select({ body: schema.messages.body, senderRole: schema.messages.senderRole, createdAt: schema.messages.createdAt, safetyFlagged: schema.messages.safetyFlagged })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversation.id))
        .orderBy(desc(schema.messages.createdAt))
        .get();
      const unread = unreadForStaff(conversation);
      const assignee = conversation.assignedStaffId ? names.get(conversation.assignedStaffId) : null;
      return {
        id: conversation.id,
        kind: conversation.kind,
        kindLabel: conversation.kind === 'coach' ? 'Coach' : 'Front desk',
        topic: conversation.topic,
        title: conversation.title,
        state: conversation.state,
        member: {
          id: member.id,
          name: `${member.firstName} ${member.lastName}`.trim(),
          initials: member.initials,
          memberNo: member.memberNo,
          minor: memberIsMinor(member),
        },
        assignee: conversation.assignedStaffId ? { staffId: conversation.assignedStaffId, name: assignee?.name ?? 'Staff member' } : null,
        lastMessage: last?.body.slice(0, 140) ?? '',
        lastFromMember: last?.senderRole === 'member',
        lastMessageAt: new Date(conversation.lastMessageAt).toISOString(),
        lastMessageRelative: relativeTime(conversation.lastMessageAt),
        unread,
        needsReply: last?.senderRole === 'member',
        safetyFlagged: last?.safetyFlagged ?? false,
      };
    })
    .filter((item) => filter !== 'unread' || item.unread > 0);

  return {
    items,
    counts: {
      unread: items.filter((i) => i.unread > 0).length,
      needsReply: items.filter((i) => i.needsReply).length,
    },
  };
}

export function inboxThread(ctx: RequestContext, conversationId: string) {
  requirePermission(ctx, 'inbox.view');
  const { conversation, member } = loadConversationForStaff(ctx, conversationId);
  const messages = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversation.id))
    .orderBy(schema.messages.createdAt)
    .all();
  const files = attachmentsByMessage(messages.map((m) => m.id));
  const notes = db
    .select()
    .from(schema.conversationNotes)
    .where(eq(schema.conversationNotes.conversationId, conversation.id))
    .orderBy(schema.conversationNotes.createdAt)
    .all();

  // Who could take this thread: staff in the branch whose role can see it.
  const branchId = conversation.branchId ?? member.homeBranchId;
  const assignable = db
    .select({ staffId: schema.staff.id, name: schema.users.name, role: schema.users.role, branchIds: schema.staff.branchIds })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(and(eq(schema.staff.tenantId, ctx.tenantId), eq(schema.users.accountState, 'active')))
    .all()
    .filter((s) => s.branchIds.includes(branchId))
    .filter((s) => assignableRoles(conversation.kind).includes(s.role))
    .map((s) => ({ staffId: s.staffId, name: s.name, roleLabel: STAFF_ROLE_LABEL[s.role] ?? s.role }));

  const names = staffNames([conversation.assignedStaffId ?? '']);
  return {
    conversation: {
      id: conversation.id,
      kind: conversation.kind,
      kindLabel: conversation.kind === 'coach' ? 'Coach' : 'Front desk',
      topic: conversation.topic,
      title: conversation.title,
      state: conversation.state,
      branchId,
      assignee: conversation.assignedStaffId
        ? { staffId: conversation.assignedStaffId, name: names.get(conversation.assignedStaffId)?.name ?? 'Staff member' }
        : null,
      member: {
        id: member.id,
        name: `${member.firstName} ${member.lastName}`.trim(),
        initials: member.initials,
        memberNo: member.memberNo,
        minor: memberIsMinor(member),
      },
      unread: unreadForStaff(conversation),
    },
    messages: messages.map((m) => ({
      id: m.id,
      senderName: m.senderName,
      senderInitials: initialsOf(m.senderName),
      fromMember: m.senderRole === 'member',
      fromMe: m.senderUserId === ctx.userId,
      body: m.body,
      createdAt: new Date(m.createdAt).toISOString(),
      relativeTime: relativeTime(m.createdAt),
      readByMember: m.senderRole !== 'member' ? m.readAt !== null : null,
      safetyFlagged: m.safetyFlagged,
      attachments: files.get(m.id) ?? [],
    })),
    notes: notes.map((n) => ({
      id: n.id,
      authorName: n.authorName,
      body: n.body,
      createdAt: new Date(n.createdAt).toISOString(),
      relativeTime: relativeTime(n.createdAt),
    })),
    assignable,
    /** Shown above the composer: the member cannot see notes, only replies. */
    notesPrivacy: 'Notes are only visible to staff. The member never sees them.',
  };
}

export function markInboxRead(ctx: RequestContext, conversationId: string): { ok: true } {
  requirePermission(ctx, 'inbox.view');
  const { conversation } = loadConversationForStaff(ctx, conversationId);
  const at = now();
  transact(() => {
    db.update(schema.conversations).set({ staffReadAt: at }).where(eq(schema.conversations.id, conversation.id)).run();
    // The member sees "read" on their own messages.
    db.update(schema.messages)
      .set({ readAt: at, state: 'read' })
      .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.senderRole, 'member'), isNull(schema.messages.readAt)))
      .run();
  });
  return { ok: true };
}

export function replyInInbox(ctx: RequestContext, conversationId: string, input: { body: string; clientId: string }) {
  requirePermission(ctx, 'inbox.view');
  const { conversation, member } = loadConversationForStaff(ctx, conversationId);
  if (conversation.state === 'closed') throw conflict('This conversation is closed. Reopen it to reply.');
  assertMinorRule(member);

  const existing = db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.clientId, input.clientId)))
    .get();
  if (existing) {
    if (existing.senderUserId !== ctx.userId) throw conflict('That message id belongs to someone else.');
    return { messageId: existing.id, duplicate: true };
  }

  const at = now();
  const messageId = id('msg');
  transact(() => {
    db.insert(schema.messages)
      .values({
        id: messageId,
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        senderUserId: ctx.userId,
        senderName: ctx.name,
        senderRole: ctx.role,
        body: input.body,
        attachments: [],
        state: 'sent',
        clientId: input.clientId,
        createdAt: at,
        readAt: null,
        safetyFlagged: false,
      })
      .run();
    db.update(schema.conversations)
      .set({
        lastMessageAt: at,
        staffReadAt: at,
        // Whoever answers an unassigned thread owns it from then on.
        assignedStaffId: conversation.assignedStaffId ?? ctx.staffId,
      })
      .where(eq(schema.conversations.id, conversation.id))
      .run();
    db.update(schema.messages)
      .set({ readAt: at, state: 'read' })
      .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.senderRole, 'member'), isNull(schema.messages.readAt)))
      .run();

    if (member.userId && !conversation.muted) {
      queueNotification(
        {
          tenantId: ctx.tenantId,
          userId: member.userId,
          memberId: member.id,
          branchId: member.homeBranchId,
          channel: 'in_app',
          purpose: 'operational',
          source: 'message',
          sourceId: conversation.id,
          dedupeKey: `reply:${messageId}`,
          kind: 'message',
          title: `${ctx.name} replied`,
          body: input.body.length > 120 ? `${input.body.slice(0, 117)}…` : input.body,
          link: `/messages/${conversation.id}`,
        },
        at,
      );
    }
    emit({
      tenantId: ctx.tenantId,
      branchId: member.homeBranchId,
      channel: channels.member(member.id),
      topic: 'message.created',
      payload: { conversationId: conversation.id, messageId, senderRole: 'staff' },
    });
  });
  return { messageId, duplicate: false };
}

export function addInboxNote(ctx: RequestContext, conversationId: string, body: string) {
  requirePermission(ctx, 'inbox.view');
  const { conversation, member } = loadConversationForStaff(ctx, conversationId);
  const noteId = id('cnt');
  transact(() => {
    db.insert(schema.conversationNotes)
      .values({
        id: noteId,
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        authorUserId: ctx.userId,
        authorName: ctx.name,
        body,
        createdAt: now(),
      })
      .run();
    // The audit row says a note exists, never what it says.
    audit(ctx, {
      action: 'conversation.note_added',
      entityType: 'conversation',
      entityId: conversation.id,
      entityLabel: conversation.title,
      branchId: conversation.branchId ?? member.homeBranchId,
      after: { noteId },
    });
  });
  return { noteId };
}

/** Who may hold a thread: coaches take coach threads, the desk takes desk
 *  threads, managers either. Assigning is a grant of access, so it is checked
 *  here and not only in the picker. */
function assignableRoles(kind: string): string[] {
  return kind === 'coach'
    ? ['trainer', 'owner', 'regional_manager', 'branch_manager']
    : ['reception', 'owner', 'regional_manager', 'branch_manager'];
}

export function assignInbox(ctx: RequestContext, conversationId: string, staffId: string | null) {
  requirePermission(ctx, 'inbox.view');
  const { conversation, member } = loadConversationForStaff(ctx, conversationId);
  const branchId = conversation.branchId ?? member.homeBranchId;
  let assigneeUserId: string | null = null;
  if (staffId) {
    const target = db
      .select({ userId: schema.staff.userId, branchIds: schema.staff.branchIds, state: schema.users.accountState, role: schema.users.role })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.staff.id, staffId), eq(schema.staff.tenantId, ctx.tenantId)))
      .get();
    if (!target || target.state !== 'active' || !target.branchIds.includes(branchId)) {
      throw invalid('That person does not work at this branch.');
    }
    if (!assignableRoles(conversation.kind).includes(target.role)) {
      throw invalid(conversation.kind === 'coach' ? 'Only a coach or a manager can take a coach thread.' : 'Only the front desk or a manager can take a desk thread.');
    }
    assigneeUserId = target.userId;
  }
  transact(() => {
    db.update(schema.conversations).set({ assignedStaffId: staffId }).where(eq(schema.conversations.id, conversation.id)).run();
    audit(ctx, {
      action: 'conversation.assigned',
      entityType: 'conversation',
      entityId: conversation.id,
      entityLabel: conversation.title,
      branchId,
      before: { assignedStaffId: conversation.assignedStaffId },
      after: { assignedStaffId: staffId },
    });
    if (assigneeUserId && assigneeUserId !== ctx.userId) {
      queueNotification({
        tenantId: ctx.tenantId,
        userId: assigneeUserId,
        branchId,
        channel: 'in_app',
        purpose: 'operational',
        source: 'message',
        sourceId: conversation.id,
        kind: 'message',
        title: 'A conversation was assigned to you',
        body: `${ctx.name} assigned you ${member.firstName}'s thread.`,
        link: `/inbox?conversation=${conversation.id}`,
      });
    }
  });
  return { ok: true as const, assignedStaffId: staffId };
}

export function setInboxState(ctx: RequestContext, conversationId: string, state: 'open' | 'closed') {
  requirePermission(ctx, 'inbox.view');
  const { conversation, member } = loadConversationForStaff(ctx, conversationId);
  if (conversation.state === state) return { ok: true as const, state };
  transact(() => {
    db.update(schema.conversations).set({ state }).where(eq(schema.conversations.id, conversation.id)).run();
    audit(ctx, {
      action: state === 'closed' ? 'conversation.closed' : 'conversation.reopened',
      entityType: 'conversation',
      entityId: conversation.id,
      entityLabel: conversation.title,
      branchId: conversation.branchId ?? member.homeBranchId,
      before: { state: conversation.state },
      after: { state },
    });
  });
  return { ok: true as const, state };
}
