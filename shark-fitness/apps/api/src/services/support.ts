import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import type {
  AtRiskMember,
  FeedbackEntry,
  FeedbackSummary,
  Intervention,
  InterventionAction,
  InterventionOutcome,
  InterventionState,
  RetentionView,
  TicketCategory,
  TicketDetail,
  TicketEvent,
  TicketEventKind,
  TicketMemberContext,
  TicketMessage,
  TicketPriority,
  TicketQueue,
  TicketSla,
  TicketState,
  TicketSummary,
} from '@shark/contracts';
import {
  canSendAutomatedOutreach,
  csatSummary,
  interventionEffectiveness,
  npsSummary,
  retentionRisk,
  scanForSafety,
  slaDeadline,
  slaView,
  transitionRefusal,
  type RiskReason,
} from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchTimeZone } from '../lib/branch-time.js';
import type { RequestContext } from '../lib/context.js';
import { requireBranch, requirePermission } from '../lib/context.js';
import { conflict, invalid, notFound, precondition } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { isoDate, localMinutes, now } from '../lib/time.js';

/**
 * Support, feedback and retention (PF-SUP-001…006).
 *
 * Route files are thin adapters; every rule below lives here.
 *
 * Four decisions shape the module and are worth not re-litigating.
 *
 * **One history, not two.** A support ticket already owns a `conversations`
 * row with `kind: 'support'` and a `ticket_id`, created by the member app. A
 * staff reply is a `messages` row in *that* conversation — the same table the
 * member's phone reads and the same `message.created` event it already
 * listens to. Building a staff-side reply store would have produced two
 * records of one exchange that disagree the first time either side edits or
 * deletes, and a dispute is precisely when that matters.
 *
 * **The SLA is computed, never stored.** Only the promise (`slaDueAt`,
 * `slaResponseMinutes`) and the facts (`openedAt`, `firstResponseAt`) are
 * persisted. Whether that promise was kept is derived on every read, so it
 * cannot drift when the policy changes, and it stops at the *first reply*
 * rather than at resolution.
 *
 * **The clock runs in open hours.** A four-hour promise made at 22:40 does not
 * fall due at 02:40 when nobody was there to answer. `slaDeadline` walks
 * forward through the branch's own opening hours in the branch's own timezone.
 *
 * **Anonymity is absence, not masking.** An anonymous report carries no
 * `member_id` and no conversation. There is nothing to unmask because nothing
 * was written down, which also means the desk cannot reply — stated plainly
 * rather than discovered by a failing button.
 */

const DAY = 86_400_000;

/**
 * The reply promise per category, in minutes of *open* time.
 *
 * These mirror the hours the member app already quotes when a ticket is
 * opened; both now read this table so the desk and the member cannot be told
 * two different numbers about the same ticket.
 */
export const RESPONSE_MINUTES: Record<string, number> = {
  billing: 8 * 60,
  membership: 24 * 60,
  facility: 24 * 60,
  class: 12 * 60,
  app: 48 * 60,
  complaint: 4 * 60,
  other: 24 * 60,
};

/** A safety signal shortens whatever the category promised, never lengthens it. */
const SAFETY_CEILING_MINUTES = 4 * 60;

type TicketRow = typeof schema.tickets.$inferSelect;

/* ——— Scope ————————————————————————————————————————————————— */

/**
 * A ticket outside the caller's branches does not exist as far as they are
 * concerned — 404, never 403, so the console cannot confirm that a reference
 * belongs to a branch they may not see.
 *
 * Tenant-wide tickets (`branch_id IS NULL`) are visible to anyone with the
 * permission: an anonymous report that names no branch has to reach somebody,
 * and dropping it from every scoped queue would silently bury it.
 */
function ticketInScope(ctx: RequestContext, ticketId: string): TicketRow {
  const ticket = db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.id, ticketId), eq(schema.tickets.tenantId, ctx.tenantId)))
    .get();
  if (!ticket) throw notFound('That ticket');
  if (ticket.branchId !== null && !ctx.branchIds.includes(ticket.branchId)) throw notFound('That ticket');
  return ticket;
}

/**
 * Which branches a read covers.
 *
 * No `branchId` means **every branch the caller may see**, not the one their
 * session happens to default to. `activeBranchId` is set at sign-in to the
 * first permitted branch and only moves when a client sends `x-branch-id`, so
 * scoping to it made "All branches" in the console a lie: a complaint raised at
 * Indiranagar simply never appeared in an owner's queue. On a module whose
 * whole job is that nothing gets missed, that is the worst possible default.
 *
 * A ticket is also visible when it names no branch at all — see the `isNull`
 * arm at each call site.
 */
function scopeFor(ctx: RequestContext, branchId?: string | null): string[] {
  if (branchId) {
    requireBranch(ctx, branchId);
    return [branchId];
  }
  return ctx.branchIds;
}

/* ——— Names ————————————————————————————————————————————————— */

function branchNames(tenantId: string): Map<string, string> {
  return new Map(
    db
      .select({ id: schema.branches.id, name: schema.branches.name })
      .from(schema.branches)
      .where(eq(schema.branches.tenantId, tenantId))
      .all()
      .map((b) => [b.id, b.name]),
  );
}

interface MemberBrief {
  name: string;
  memberNo: string;
  lifecycle: string;
  deletedAt: number | null;
}

function memberBriefs(tenantId: string, memberIds: string[]): Map<string, MemberBrief> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return new Map();
  return new Map(
    db
      .select({
        id: schema.members.id,
        firstName: schema.members.firstName,
        lastName: schema.members.lastName,
        memberNo: schema.members.memberNo,
        lifecycle: schema.members.lifecycle,
        deletedAt: schema.members.deletedAt,
      })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId), inArray(schema.members.id, unique)))
      .all()
      .map((m) => [
        m.id,
        {
          name: `${m.firstName} ${m.lastName}`.trim(),
          memberNo: m.memberNo,
          lifecycle: m.lifecycle,
          deletedAt: m.deletedAt,
        },
      ]),
  );
}

function staffNames(tenantId: string): Map<string, string> {
  return new Map(
    db
      .select({ id: schema.staff.id, name: schema.users.name })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.staff.tenantId, tenantId), eq(schema.staff.employmentStatus, 'active')))
      .all()
      .map((s) => [s.id, s.name]),
  );
}

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/* ——— SLA ——————————————————————————————————————————————————— */

interface BranchHours {
  opensMinutes: number;
  closesMinutes: number;
  holidays: string[];
  timezone: string;
}

function hoursFor(tenantId: string, branchId: string | null): BranchHours {
  const branch = branchId
    ? db
        .select({
          opensMinutes: schema.branches.opensMinutes,
          closesMinutes: schema.branches.closesMinutes,
          holidays: schema.branches.holidays,
          timezone: schema.branches.timezone,
        })
        .from(schema.branches)
        .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, tenantId)))
        .get()
    : null;
  // A tenant-wide ticket has no shop floor to be open or shut, so its clock
  // runs continuously — the honest reading of "somebody, somewhere, owns this".
  if (!branch) return { opensMinutes: 0, closesMinutes: 1440, holidays: [], timezone: branchTimeZone(tenantId, null) };
  return branch;
}

/**
 * The deadline for a promise made now, in the branch's own open hours.
 *
 * Exported because the member app makes the same promise when a member opens a
 * ticket, and the two must not disagree.
 */
export function responseDeadline(
  tenantId: string,
  branchId: string | null,
  openedAt: number,
  responseMinutes: number,
): number | null {
  const hours = hoursFor(tenantId, branchId);
  const holidays = new Set(hours.holidays);
  return slaDeadline({
    openedAt,
    responseMinutes,
    hours: { opensMinutes: hours.opensMinutes, closesMinutes: hours.closesMinutes },
    localMinutesAt: (ms) => localMinutes(ms, hours.timezone),
    closedOn: (ms) => holidays.has(isoDate(ms, hours.timezone)),
  });
}

/** How long this ticket should have been answered in, given its category and
 *  whether the member's own words tripped a safety pattern. */
export function promisedMinutes(category: string, safetyFlagged: boolean): number {
  const base = RESPONSE_MINUTES[category] ?? RESPONSE_MINUTES.other!;
  return safetyFlagged ? Math.min(base, SAFETY_CEILING_MINUTES) : base;
}

function slaOf(ticket: TicketRow, at: number): TicketSla {
  const view = slaView({
    state: ticket.state,
    slaDueAt: ticket.slaDueAt,
    firstResponseAt: ticket.firstResponseAt,
    now: at,
  });
  return {
    state: view.state,
    label: view.label,
    dueInMinutes: view.dueInMinutes,
    breached: view.breached,
    dueAt: isoOrNull(ticket.slaDueAt),
    responseMinutes: ticket.slaResponseMinutes,
    firstResponseAt: isoOrNull(ticket.firstResponseAt),
  };
}

/* ——— Serialisation ————————————————————————————————————————— */

function toSummary(
  row: TicketRow,
  at: number,
  branches: Map<string, string>,
  members: Map<string, MemberBrief>,
  staff: Map<string, string>,
): TicketSummary {
  const member = row.memberId ? members.get(row.memberId) : undefined;
  return {
    id: row.id,
    reference: row.reference,
    branchId: row.branchId,
    branchName: row.branchId ? (branches.get(row.branchId) ?? row.branchId) : null,
    // An anonymous ticket has no member id at all, so there is nothing here to
    // withhold — the field is null because nothing was ever recorded.
    memberId: row.anonymous ? null : row.memberId,
    memberName: row.anonymous ? null : (member?.name ?? null),
    // The ticket outlives the member record (PF-SUP edge case). Say so rather
    // than rendering a blank where a name used to be.
    memberInactive: member ? member.deletedAt !== null || member.lifecycle === 'deleted' : row.memberId !== null,
    category: row.category as TicketCategory,
    subject: row.subject,
    priority: row.priority as TicketPriority,
    state: row.state as TicketState,
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeId ? (staff.get(row.assigneeId) ?? null) : null,
    anonymous: row.anonymous,
    escalated: row.escalated,
    vulnerabilityFlag: row.vulnerabilityFlag,
    safetyCategories: row.safetyCategories ?? [],
    reopenCount: row.reopenCount,
    sla: slaOf(row, at),
    openedAt: iso(row.openedAt),
    lastUpdateAt: iso(row.lastUpdateAt),
    resolvedAt: isoOrNull(row.resolvedAt),
    closedAt: isoOrNull(row.closedAt),
  };
}

function toEvent(row: typeof schema.ticketEvents.$inferSelect): TicketEvent {
  return {
    id: row.id,
    kind: row.kind as TicketEventKind,
    actorName: row.actorName,
    actorRole: row.actorRole,
    summary: row.summary,
    messageId: row.messageId,
    at: iso(row.at),
  };
}

function toMessage(row: typeof schema.messages.$inferSelect): TicketMessage {
  return {
    id: row.id,
    senderName: row.senderName,
    senderRole: row.senderRole,
    fromMember: row.senderRole === 'member',
    body: row.body,
    attachments: row.attachments,
    safetyFlagged: row.safetyFlagged,
    readAt: isoOrNull(row.readAt),
    at: iso(row.createdAt),
  };
}

/* ——— The immutable timeline ————————————————————————————————— */

/**
 * Append one event. Never updates: `ticket_events` is guarded by
 * `BEFORE UPDATE`/`BEFORE DELETE` triggers, so a correction is a new row and a
 * dispute cannot be quietly rewritten by whoever is being disputed with
 * (PF-SUP-006).
 */
function recordEvent(
  ctx: RequestContext,
  ticketId: string,
  kind: TicketEventKind,
  summary: string,
  detail?: Record<string, unknown>,
  messageId?: string,
): void {
  db.insert(schema.ticketEvents)
    .values({
      id: id('tev'),
      tenantId: ctx.tenantId,
      ticketId,
      kind,
      actorId: ctx.staffId,
      actorName: ctx.name,
      actorRole: ctx.role,
      summary,
      detail: detail ?? null,
      messageId: messageId ?? null,
      at: now(),
    })
    .run();
}

function emitTicketUpdated(ctx: RequestContext, ticket: TicketRow, change: string): void {
  emit({
    tenantId: ctx.tenantId,
    branchId: ticket.branchId,
    // A tenant-wide ticket reaches everyone; a branch ticket reaches its desk.
    channel: ticket.branchId ? channels.branch(ticket.branchId) : channels.tenant(ctx.tenantId),
    topic: 'ticket.updated',
    payload: {
      ticketId: ticket.id,
      reference: ticket.reference,
      change,
      state: ticket.state,
      priority: ticket.priority,
      escalated: ticket.escalated,
    },
  });
}

/* ——— Queue (PF-SUP-001) ————————————————————————————————————— */

export interface QueueFilters {
  branchId?: string | null;
  state?: string | null;
  priority?: string | null;
  category?: string | null;
  assigneeId?: string | null;
  /** 'breached' | 'unassigned' | 'escalated' | 'mine' */
  flag?: string | null;
  search?: string | null;
  limit?: number;
}

export function ticketQueue(ctx: RequestContext, filters: QueueFilters = {}): TicketQueue {
  requirePermission(ctx, 'support.manage');
  const at = now();
  const scope = scopeFor(ctx, filters.branchId);

  // Branch-scoped OR tenant-wide. A report that names no branch still has to
  // land in somebody's queue.
  const visible = or(inArray(schema.tickets.branchId, scope), isNull(schema.tickets.branchId));
  const all = db
    .select()
    .from(schema.tickets)
    .where(and(eq(schema.tickets.tenantId, ctx.tenantId), visible))
    .orderBy(desc(schema.tickets.lastUpdateAt))
    .all();

  const branches = branchNames(ctx.tenantId);
  const members = memberBriefs(
    ctx.tenantId,
    all.filter((t) => !t.anonymous && t.memberId).map((t) => t.memberId!),
  );
  const staff = staffNames(ctx.tenantId);

  const summaries = all.map((row) => toSummary(row, at, branches, members, staff));

  // Counts describe the whole permitted scope, not the filtered page. A breach
  // you filtered out is still a breach, and a queue that hides it while you
  // read a different tab is worse than no counter.
  const counts = {
    open: summaries.filter((t) => t.state === 'open').length,
    // Waiting on us and waiting on the member are counted apart: one is work
    // sitting in the building, the other is somebody else's turn.
    pendingStaff: summaries.filter((t) => t.state === 'pending_staff').length,
    pendingMember: summaries.filter((t) => t.state === 'pending_member').length,
    resolved: summaries.filter((t) => t.state === 'resolved').length,
    closed: summaries.filter((t) => t.state === 'closed').length,
    breached: summaries.filter((t) => t.sla.breached && t.state !== 'closed').length,
    unassigned: summaries.filter((t) => t.assigneeId === null && t.state !== 'closed' && t.state !== 'resolved')
      .length,
    escalated: summaries.filter((t) => t.escalated && t.state !== 'closed').length,
    mine: summaries.filter((t) => t.assigneeId !== null && t.assigneeId === ctx.staffId).length,
  };

  const needle = (filters.search ?? '').trim().toLowerCase();
  const items = summaries
    .filter((t) => {
      if (filters.state && t.state !== filters.state) return false;
      if (filters.priority && t.priority !== filters.priority) return false;
      if (filters.category && t.category !== filters.category) return false;
      if (filters.assigneeId === 'unassigned' && t.assigneeId !== null) return false;
      if (filters.assigneeId && filters.assigneeId !== 'unassigned' && t.assigneeId !== filters.assigneeId) {
        return false;
      }
      if (filters.flag === 'breached' && !(t.sla.breached && t.state !== 'closed')) return false;
      if (filters.flag === 'unassigned' && t.assigneeId !== null) return false;
      if (filters.flag === 'escalated' && !t.escalated) return false;
      if (filters.flag === 'mine' && t.assigneeId !== ctx.staffId) return false;
      if (!needle) return true;
      return (
        t.reference.toLowerCase().includes(needle) ||
        t.subject.toLowerCase().includes(needle) ||
        (t.memberName ?? '').toLowerCase().includes(needle) ||
        (t.assigneeName ?? '').toLowerCase().includes(needle)
      );
    })
    // Breaches first, then urgency, then oldest — the order a desk works in.
    .sort((a, b) => {
      const live = (t: TicketSummary): number => (t.state === 'closed' || t.state === 'resolved' ? 1 : 0);
      if (live(a) !== live(b)) return live(a) - live(b);
      if (a.sla.breached !== b.sla.breached) return a.sla.breached ? -1 : 1;
      const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
      if (rank[a.priority] !== rank[b.priority]) return (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
      return Date.parse(a.openedAt) - Date.parse(b.openedAt);
    })
    .slice(0, filters.limit ?? 200);

  return {
    items,
    counts,
    assignees: [...staff.entries()].map(([sid, name]) => ({ id: sid, name })).sort((a, b) => a.name.localeCompare(b.name)),
    categories: Object.keys(RESPONSE_MINUTES).map((value) => ({
      value: value as TicketCategory,
      responseMinutes: RESPONSE_MINUTES[value]!,
    })),
    asOf: iso(at),
  };
}

/* ——— Detail ———————————————————————————————————————————————— */

function memberContext(ctx: RequestContext, memberId: string): TicketMemberContext | null {
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) return null;

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), eq(schema.memberships.tenantId, ctx.tenantId)))
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  // Balance is money. Reception holds `billing.view`, a trainer does not, and
  // the support desk is not a reason to widen that.
  const canSeeBalance = ctx.permissions.includes('billing.view');
  const due = canSeeBalance
    ? (db
        .select({
          total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor} - ${schema.invoices.refundedMinor}), 0)`,
        })
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.tenantId, ctx.tenantId),
            eq(schema.invoices.memberId, memberId),
            eq(schema.invoices.state, 'open'),
          ),
        )
        .get()?.total ?? 0)
    : null;

  const openTickets = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.tenantId, ctx.tenantId),
        eq(schema.tickets.memberId, memberId),
        inArray(schema.tickets.state, ['open', 'pending_member', 'pending_staff']),
      ),
    )
    .get();

  const branches = branchNames(ctx.tenantId);

  return {
    memberId: member.id,
    memberNo: member.memberNo,
    name: `${member.firstName} ${member.lastName}`.trim(),
    lifecycle: member.lifecycle,
    homeBranchName: branches.get(member.homeBranchId) ?? member.homeBranchId,
    joinedOn: member.joinedOn,
    lastVisitAt: isoOrNull(member.lastVisitAt),
    membershipState: membership?.state ?? null,
    membershipProduct: membership?.productName ?? null,
    membershipEndsOn: membership?.endsOn ?? null,
    balanceMinor: due,
    openTickets: openTickets?.n ?? 0,
    riskScore: member.riskScore,
    riskBand:
      member.riskScore === null ? null : member.riskScore >= 55 ? 'high' : member.riskScore >= 28 ? 'watch' : 'low',
    inactive: member.deletedAt !== null || member.lifecycle === 'deleted',
  };
}

function conversationFor(tenantId: string, ticketId: string) {
  return db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.tenantId, tenantId), eq(schema.conversations.ticketId, ticketId)))
    .get();
}

/**
 * Why a reply cannot be sent, in the words the desk needs.
 *
 * Stated up front on the detail response rather than discovered by pressing a
 * button that fails — three of these four are permanent facts about the ticket,
 * not transient errors.
 */
function replyBlockedReason(ticket: TicketRow, conversationId: string | null, member: TicketMemberContext | null): string | null {
  if (ticket.anonymous) {
    return 'This was reported anonymously, so there is no member to reply to. Nothing links it to a person — that was the promise made when it was submitted.';
  }
  if (!conversationId) {
    return 'This ticket has no member conversation. It was raised at the desk rather than in the app, so answer the member the way they contacted you.';
  }
  if (ticket.state === 'closed') {
    return 'This ticket is closed. Reopen it if the member has come back about the same thing.';
  }
  if (member?.inactive) {
    return 'This member’s record has been deleted. The ticket stays open so it can be settled, but a reply would have nowhere to go.';
  }
  return null;
}

export function ticketDetail(ctx: RequestContext, ticketId: string): TicketDetail {
  requirePermission(ctx, 'support.manage');
  const ticket = ticketInScope(ctx, ticketId);
  const at = now();

  const branches = branchNames(ctx.tenantId);
  const members = memberBriefs(ctx.tenantId, ticket.memberId && !ticket.anonymous ? [ticket.memberId] : []);
  const staff = staffNames(ctx.tenantId);

  const conversation = conversationFor(ctx.tenantId, ticket.id);
  const messages = conversation
    ? db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversation.id))
        .orderBy(asc(schema.messages.createdAt))
        .all()
        .map(toMessage)
    : [];

  const timeline = db
    .select()
    .from(schema.ticketEvents)
    .where(and(eq(schema.ticketEvents.tenantId, ctx.tenantId), eq(schema.ticketEvents.ticketId, ticket.id)))
    .orderBy(asc(schema.ticketEvents.at))
    .all()
    .map(toEvent);

  const member = ticket.memberId && !ticket.anonymous ? memberContext(ctx, ticket.memberId) : null;

  return {
    ticket: toSummary(ticket, at, branches, members, staff),
    conversationId: conversation?.id ?? null,
    messages,
    timeline,
    member,
    replyBlockedReason: replyBlockedReason(ticket, conversation?.id ?? null, member),
    resolution: ticket.resolution,
    escalation:
      ticket.escalatedAt !== null
        ? {
            at: iso(ticket.escalatedAt),
            by: ticket.escalatedBy ?? 'Unknown',
            reason: ticket.escalationReason ?? '',
          }
        : null,
  };
}

/* ——— Create (PF-SUP-001) ———————————————————————————————————— */

export interface TicketCreateInput {
  memberId?: string | null;
  branchId?: string | null;
  category: string;
  subject: string;
  body: string;
  priority?: string;
}

function nextReference(tenantId: string): string {
  const rows = db
    .select({ reference: schema.tickets.reference })
    .from(schema.tickets)
    .where(eq(schema.tickets.tenantId, tenantId))
    .all();
  const highest = rows.reduce(
    (max, r) => Math.max(max, Number.parseInt(r.reference.replace(/\D/g, ''), 10) || 0),
    1000,
  );
  return `SUP-${highest + 1}`;
}

/**
 * Raise a ticket at the desk — a walk-in complaint, a phone call, a
 * conversation on the gym floor.
 *
 * The member app has its own path for this and keeps it; both write the same
 * shape, both create the same conversation, and both compute the promise from
 * `RESPONSE_MINUTES`, so a ticket is the same object whichever door it came in
 * through.
 */
export function createTicket(ctx: RequestContext, input: TicketCreateInput) {
  requirePermission(ctx, 'support.manage');
  const at = now();

  let branchId = input.branchId ?? ctx.activeBranchId ?? null;
  if (branchId) requireBranch(ctx, branchId);

  let member: typeof schema.members.$inferSelect | undefined;
  if (input.memberId) {
    member = db
      .select()
      .from(schema.members)
      .where(and(eq(schema.members.id, input.memberId), eq(schema.members.tenantId, ctx.tenantId)))
      .get();
    if (!member) throw notFound('That member');
    if (member.deletedAt !== null) {
      throw precondition('That member record has been deleted. Raise the ticket without a member instead.');
    }
    // A ticket belongs where the member trains unless the desk said otherwise.
    branchId = branchId ?? member.homeBranchId;
  }

  const signals = scanForSafety(input.body);
  const safetyCategories = signals.map((s) => s.category);
  const escalated = signals.length > 0 || input.category === 'complaint';
  const priority =
    signals.some((s) => s.action === 'show_resources')
      ? 'urgent'
      : (input.priority ?? (escalated || input.category === 'billing' ? 'high' : 'normal'));

  const responseMinutes = promisedMinutes(input.category, signals.length > 0);
  const slaDueAt = responseDeadline(ctx.tenantId, branchId, at, responseMinutes);

  const ticketId = id('tkt');
  const reference = nextReference(ctx.tenantId);
  const conversationId = member ? id('cnv') : null;
  const messageId = member ? id('msg') : null;

  transact(() => {
    db.insert(schema.tickets)
      .values({
        id: ticketId,
        tenantId: ctx.tenantId,
        branchId,
        memberId: member?.id ?? null,
        reference,
        category: input.category,
        subject: input.subject,
        priority,
        state: 'open',
        assigneeId: null,
        slaDueAt,
        slaResponseMinutes: responseMinutes,
        resolution: null,
        anonymous: false,
        escalated,
        escalatedAt: escalated ? at : null,
        escalatedBy: escalated ? ctx.name : null,
        escalationReason: escalated ? (signals.length > 0 ? 'Safety wording in the report' : 'Complaint') : null,
        firstResponseAt: null,
        resolvedAt: null,
        resolvedBy: null,
        reopenCount: 0,
        vulnerabilityFlag: signals.some((s) => s.action === 'show_resources'),
        safetyCategories: safetyCategories.length > 0 ? safetyCategories : null,
        openedAt: at,
        lastUpdateAt: at,
        closedAt: null,
      })
      .run();

    // A member ticket gets the same conversation the app would have made, so
    // the member can see and answer it in Messages like any other.
    if (member && conversationId && messageId) {
      db.insert(schema.conversations)
        .values({
          id: conversationId,
          tenantId: ctx.tenantId,
          kind: 'support',
          title: `${reference} · ${input.subject}`,
          memberId: member.id,
          staffId: ctx.staffId,
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
          senderRole: ctx.role,
          body: input.body,
          attachments: [],
          state: 'sent',
          clientId: null,
          createdAt: at,
          readAt: null,
          safetyFlagged: signals.length > 0,
        })
        .run();
    }

    recordEvent(ctx, ticketId, 'opened', `${ctx.name} raised ${reference} at the desk`, {
      category: input.category,
      priority,
      escalated,
      safety: safetyCategories,
    });

    audit(ctx, {
      action: 'ticket.opened',
      entityType: 'ticket',
      entityId: ticketId,
      entityLabel: reference,
      branchId,
      after: { category: input.category, priority, escalated, memberId: member?.id ?? null, source: 'staff' },
    });

    emit({
      tenantId: ctx.tenantId,
      branchId,
      channel: branchId ? channels.branch(branchId) : channels.tenant(ctx.tenantId),
      topic: escalated ? 'alert.raised' : 'ticket.updated',
      payload: { kind: 'ticket', ticketId, reference, category: input.category, priority, escalated, change: 'opened' },
    });

    if (member && conversationId && messageId) {
      emit({
        tenantId: ctx.tenantId,
        branchId,
        channel: channels.member(member.id),
        topic: 'message.created',
        payload: { conversationId, messageId, ticketId, reference },
      });
    }
  });

  return ticketDetail(ctx, ticketId);
}

/* ——— Reply (PF-SUP-001) ————————————————————————————————————— */

export interface TicketReplyInput {
  body: string;
  internal?: boolean;
}

/**
 * Answer the member, in the conversation the ticket already owns.
 *
 * A member-visible reply is a `messages` row and a `message.created` on the
 * member's channel — the same record and the same event their phone already
 * reads. An internal note never touches the conversation at all; it lives only
 * on the immutable timeline, so "did they see this?" is answerable by looking
 * at where it was written rather than by trusting a flag.
 *
 * The first *member-visible* reply stops the SLA clock. An internal note does
 * not, because nobody outside the building has heard anything.
 */
export function replyToTicket(ctx: RequestContext, ticketId: string, input: TicketReplyInput) {
  requirePermission(ctx, 'support.manage');
  const ticket = ticketInScope(ctx, ticketId);
  const at = now();
  const internal = input.internal ?? false;

  if (!internal) {
    const conversation = conversationFor(ctx.tenantId, ticket.id);
    const member = ticket.memberId && !ticket.anonymous ? memberContext(ctx, ticket.memberId) : null;
    const blocked = replyBlockedReason(ticket, conversation?.id ?? null, member);
    if (blocked) throw precondition(blocked);

    transact(() => {
      const messageId = id('msg');
      db.insert(schema.messages)
        .values({
          id: messageId,
          tenantId: ctx.tenantId,
          conversationId: conversation!.id,
          senderUserId: ctx.userId,
          senderName: ctx.name,
          senderRole: ctx.role,
          body: input.body,
          attachments: [],
          state: 'sent',
          clientId: null,
          createdAt: at,
          readAt: null,
          safetyFlagged: false,
        })
        .run();

      db.update(schema.conversations)
        .set({ lastMessageAt: at, staffId: ctx.staffId ?? conversation!.staffId })
        .where(eq(schema.conversations.id, conversation!.id))
        .run();

      db.update(schema.tickets)
        .set({
          // Only the *first* reply, and never re-stamped. Whether the promise
          // was kept is a fact about the past.
          firstResponseAt: ticket.firstResponseAt ?? at,
          // Answering hands the ball to the member. A ticket that was waiting
          // on us is no longer; one that was already waiting on the member, or
          // resolved, keeps its state until somebody moves it deliberately.
          state: ticket.state === 'open' || ticket.state === 'pending_staff' ? 'pending_member' : ticket.state,
          lastUpdateAt: at,
        })
        .where(eq(schema.tickets.id, ticket.id))
        .run();

      recordEvent(
        ctx,
        ticket.id,
        'replied',
        `${ctx.name} replied to the member`,
        { firstResponse: ticket.firstResponseAt === null },
        messageId,
      );

      audit(ctx, {
        action: 'ticket.replied',
        entityType: 'ticket',
        entityId: ticket.id,
        entityLabel: ticket.reference,
        branchId: ticket.branchId,
        after: { messageId, firstResponse: ticket.firstResponseAt === null },
      });

      emit({
        tenantId: ctx.tenantId,
        branchId: ticket.branchId,
        channel: channels.member(ticket.memberId!),
        topic: 'message.created',
        payload: { conversationId: conversation!.id, messageId, ticketId: ticket.id, reference: ticket.reference },
      });
      emitTicketUpdated(
        ctx,
        {
          ...ticket,
          state: ticket.state === 'open' || ticket.state === 'pending_staff' ? 'pending_member' : ticket.state,
        },
        'replied',
      );
    });

    return ticketDetail(ctx, ticket.id);
  }

  // Internal note: timeline only. Never a message, never an event to the member.
  transact(() => {
    db.update(schema.tickets).set({ lastUpdateAt: at }).where(eq(schema.tickets.id, ticket.id)).run();
    recordEvent(ctx, ticket.id, 'internal_note', input.body);
    audit(ctx, {
      action: 'ticket.note',
      entityType: 'ticket',
      entityId: ticket.id,
      entityLabel: ticket.reference,
      branchId: ticket.branchId,
      after: { internal: true },
    });
  });

  return ticketDetail(ctx, ticket.id);
}

/* ——— Assignment, priority, state ————————————————————————————— */

export interface TicketPatchInput {
  assigneeId?: string | null;
  priority?: string;
  state?: string;
  vulnerabilityFlag?: boolean;
}

/**
 * An assignee must actually be able to reach the ticket.
 *
 * A ticket moved to another branch, or a member whose home branch changed,
 * can leave it owned by somebody with no access to it — an assignment that
 * looks like coverage and is not. Refused rather than silently cleared,
 * because at a support desk the silent version means nobody is looking at it.
 */
function assertAssignable(ctx: RequestContext, staffId: string, ticket: TicketRow): void {
  const assignee = db
    .select({ branchIds: schema.staff.branchIds, status: schema.staff.employmentStatus })
    .from(schema.staff)
    .where(and(eq(schema.staff.id, staffId), eq(schema.staff.tenantId, ctx.tenantId)))
    .get();
  if (!assignee) throw notFound('That staff member');
  if (assignee.status !== 'active') throw invalid('That staff member is not active.');
  if (ticket.branchId !== null && !assignee.branchIds.includes(ticket.branchId)) {
    throw invalid('That person does not cover this branch, so they could not act on the ticket.');
  }
}

export function updateTicket(ctx: RequestContext, ticketId: string, patch: TicketPatchInput) {
  requirePermission(ctx, 'support.manage');
  const ticket = ticketInScope(ctx, ticketId);
  const at = now();

  const changes: Partial<typeof schema.tickets.$inferInsert> = { lastUpdateAt: at };
  const events: Array<{ kind: TicketEventKind; summary: string; detail?: Record<string, unknown> }> = [];

  if (patch.assigneeId !== undefined && patch.assigneeId !== ticket.assigneeId) {
    if (patch.assigneeId !== null) assertAssignable(ctx, patch.assigneeId, ticket);
    changes.assigneeId = patch.assigneeId;
    const staff = staffNames(ctx.tenantId);
    events.push({
      kind: 'assigned',
      summary:
        patch.assigneeId === null
          ? `${ctx.name} unassigned the ticket`
          : `${ctx.name} assigned it to ${staff.get(patch.assigneeId) ?? 'a colleague'}`,
      detail: { from: ticket.assigneeId, to: patch.assigneeId },
    });
  }

  if (patch.priority !== undefined && patch.priority !== ticket.priority) {
    changes.priority = patch.priority;
    events.push({
      kind: 'priority_changed',
      summary: `${ctx.name} moved priority from ${ticket.priority} to ${patch.priority}`,
      detail: { from: ticket.priority, to: patch.priority },
    });
  }

  if (patch.vulnerabilityFlag !== undefined && patch.vulnerabilityFlag !== ticket.vulnerabilityFlag) {
    changes.vulnerabilityFlag = patch.vulnerabilityFlag;
    events.push({
      kind: 'internal_note',
      summary: patch.vulnerabilityFlag
        ? `${ctx.name} flagged this member as vulnerable — automated outreach is now blocked`
        : `${ctx.name} cleared the vulnerability flag`,
      detail: { vulnerabilityFlag: patch.vulnerabilityFlag },
    });
  }

  if (patch.state !== undefined && patch.state !== ticket.state) {
    const refusal = transitionRefusal(ticket.state as TicketState, patch.state as TicketState);
    if (refusal) throw conflict(refusal);

    // Resolving needs a resolution, which is `resolveTicket`'s job — this path
    // handles the transitions that carry no explanation.
    if (patch.state === 'resolved') {
      throw invalid('Resolving a ticket needs a resolution. Use the resolve action so the record says what was done.');
    }
    if (patch.state === 'open' && ticket.state === 'resolved') {
      throw invalid('Reopening needs a reason. Use the reopen action.');
    }

    changes.state = patch.state;
    if (patch.state === 'closed') {
      changes.closedAt = at;
    }
    events.push({
      kind: 'state_changed',
      summary: `${ctx.name} moved it from ${ticket.state} to ${patch.state}`,
      detail: { from: ticket.state, to: patch.state },
    });
  }

  if (events.length === 0) return ticketDetail(ctx, ticket.id);

  transact(() => {
    db.update(schema.tickets).set(changes).where(eq(schema.tickets.id, ticket.id)).run();
    for (const e of events) recordEvent(ctx, ticket.id, e.kind, e.summary, e.detail);
    audit(ctx, {
      action: 'ticket.updated',
      entityType: 'ticket',
      entityId: ticket.id,
      entityLabel: ticket.reference,
      branchId: ticket.branchId,
      before: { state: ticket.state, priority: ticket.priority, assigneeId: ticket.assigneeId },
      after: changes,
    });
    emitTicketUpdated(ctx, { ...ticket, ...changes } as TicketRow, events[0]!.kind);
  });

  return ticketDetail(ctx, ticket.id);
}

/* ——— Resolve, reopen, escalate ——————————————————————————————— */

export function resolveTicket(ctx: RequestContext, ticketId: string, resolution: string) {
  requirePermission(ctx, 'support.manage');
  const ticket = ticketInScope(ctx, ticketId);
  const at = now();

  const refusal = transitionRefusal(ticket.state as TicketState, 'resolved');
  if (refusal) throw conflict(refusal);
  if (resolution.trim().length < 4) throw invalid('Say what was done. A resolution is the record this ticket leaves.');

  transact(() => {
    db.update(schema.tickets)
      .set({ state: 'resolved', resolution: resolution.trim(), resolvedAt: at, resolvedBy: ctx.name, lastUpdateAt: at })
      .where(eq(schema.tickets.id, ticket.id))
      .run();
    recordEvent(ctx, ticket.id, 'resolved', `${ctx.name} resolved it: ${resolution.trim()}`, { resolution });
    audit(ctx, {
      action: 'ticket.resolved',
      entityType: 'ticket',
      entityId: ticket.id,
      entityLabel: ticket.reference,
      branchId: ticket.branchId,
      after: { resolution: resolution.trim(), neverAnswered: ticket.firstResponseAt === null },
    });
    emitTicketUpdated(ctx, { ...ticket, state: 'resolved' }, 'resolved');
  });

  return ticketDetail(ctx, ticket.id);
}

/**
 * The same dispute came back.
 *
 * Reopening keeps the reference, the timeline and the original promise. It does
 * *not* reset `firstResponseAt`: the desk did answer the first time, and
 * pretending otherwise would let a reopened ticket manufacture a fresh breach
 * out of history that already happened.
 */
export function reopenTicket(ctx: RequestContext, ticketId: string, reason: string) {
  requirePermission(ctx, 'support.manage');
  const ticket = ticketInScope(ctx, ticketId);
  const at = now();

  const refusal = transitionRefusal(ticket.state as TicketState, 'open');
  if (refusal) throw conflict(refusal);
  if (reason.trim().length < 4) throw invalid('Say why it is being reopened.');

  transact(() => {
    db.update(schema.tickets)
      .set({
        state: 'open',
        resolvedAt: null,
        resolvedBy: null,
        closedAt: null,
        reopenCount: ticket.reopenCount + 1,
        lastUpdateAt: at,
      })
      .where(eq(schema.tickets.id, ticket.id))
      .run();
    recordEvent(ctx, ticket.id, 'reopened', `${ctx.name} reopened it: ${reason.trim()}`, {
      reason,
      reopenCount: ticket.reopenCount + 1,
    });
    audit(ctx, {
      action: 'ticket.reopened',
      entityType: 'ticket',
      entityId: ticket.id,
      entityLabel: ticket.reference,
      branchId: ticket.branchId,
      after: { reason: reason.trim(), reopenCount: ticket.reopenCount + 1 },
    });
    emitTicketUpdated(ctx, { ...ticket, state: 'open' }, 'reopened');
  });

  return ticketDetail(ctx, ticket.id);
}

/**
 * Escalate — PF-SUP-006.
 *
 * Escalation is one-way. Un-escalating a dispute or a safety report would be
 * the single most attractive thing to do to a record somebody is about to be
 * held to, so the flag is raised with an author and a reason and never lowered;
 * the ticket is resolved or closed instead.
 */
export function escalateTicket(ctx: RequestContext, ticketId: string, reason: string) {
  requirePermission(ctx, 'support.manage');
  const ticket = ticketInScope(ctx, ticketId);
  const at = now();

  if (ticket.escalated) throw conflict('This ticket is already escalated. Escalation is not reversible.');
  if (reason.trim().length < 4) throw invalid('Say why it is being escalated.');

  transact(() => {
    db.update(schema.tickets)
      .set({
        escalated: true,
        escalatedAt: at,
        escalatedBy: ctx.name,
        escalationReason: reason.trim(),
        // An escalated ticket that was going to be answered tomorrow is not.
        priority: ticket.priority === 'urgent' ? 'urgent' : 'high',
        lastUpdateAt: at,
      })
      .where(eq(schema.tickets.id, ticket.id))
      .run();
    recordEvent(ctx, ticket.id, 'escalated', `${ctx.name} escalated it: ${reason.trim()}`, { reason });
    audit(ctx, {
      action: 'ticket.escalated',
      entityType: 'ticket',
      entityId: ticket.id,
      entityLabel: ticket.reference,
      branchId: ticket.branchId,
      after: { reason: reason.trim(), by: ctx.name },
    });
    emit({
      tenantId: ctx.tenantId,
      branchId: ticket.branchId,
      channel: ticket.branchId ? channels.branch(ticket.branchId) : channels.tenant(ctx.tenantId),
      topic: 'alert.raised',
      payload: {
        kind: 'ticket',
        ticketId: ticket.id,
        reference: ticket.reference,
        escalated: true,
        reason: reason.trim(),
      },
    });
  });

  return ticketDetail(ctx, ticket.id);
}

/* ——— Feedback (PF-SUP-002) —————————————————————————————————— */

export interface FeedbackFilters {
  branchId?: string | null;
  kind?: string | null;
  from?: number | null;
  to?: number | null;
  limit?: number;
}

export function feedbackSummary(ctx: RequestContext, filters: FeedbackFilters = {}): FeedbackSummary {
  requirePermission(ctx, 'support.manage');
  const at = now();
  const scope = scopeFor(ctx, filters.branchId);
  const from = filters.from ?? at - 90 * DAY;
  const to = filters.to ?? at;

  const rows = db
    .select()
    .from(schema.feedback)
    .where(
      and(
        eq(schema.feedback.tenantId, ctx.tenantId),
        or(inArray(schema.feedback.branchId, scope), isNull(schema.feedback.branchId)),
        sql`${schema.feedback.createdAt} >= ${from}`,
        sql`${schema.feedback.createdAt} <= ${to}`,
      ),
    )
    .orderBy(desc(schema.feedback.createdAt))
    .all();

  const branches = branchNames(ctx.tenantId);
  const members = memberBriefs(
    ctx.tenantId,
    rows.filter((r) => !r.anonymous && r.memberId).map((r) => r.memberId!),
  );
  const ticketRefs = new Map(
    db
      .select({ id: schema.tickets.id, reference: schema.tickets.reference })
      .from(schema.tickets)
      .where(eq(schema.tickets.tenantId, ctx.tenantId))
      .all()
      .map((t) => [t.id, t.reference]),
  );

  const items: FeedbackEntry[] = rows.slice(0, filters.limit ?? 200).map((r) => ({
    id: r.id,
    kind: r.kind as FeedbackEntry['kind'],
    score: r.score,
    comment: r.comment,
    anonymous: r.anonymous,
    branchId: r.branchId,
    branchName: r.branchId ? (branches.get(r.branchId) ?? r.branchId) : null,
    // Anonymity is absence: there is no member id on the row to reveal.
    memberId: r.anonymous ? null : r.memberId,
    memberName: r.anonymous ? null : (r.memberId ? (members.get(r.memberId)?.name ?? null) : null),
    subjectType: r.subjectType,
    subjectLabel: r.subjectLabel,
    ticketId: r.ticketId,
    ticketReference: r.ticketId ? (ticketRefs.get(r.ticketId) ?? null) : null,
    at: iso(r.createdAt),
  }));

  const scoresOf = (kind: string): number[] =>
    rows.filter((r) => r.kind === kind && r.score !== null).map((r) => r.score!);

  const nps = npsSummary(scoresOf('nps'));
  const csat = csatSummary(scoresOf('csat'));

  const meanOf = (kind: string): number | null => {
    const scores = scoresOf(kind);
    if (scores.length < 5) return null;
    return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  };

  const reasons = new Map<string, number>();
  for (const r of rows.filter((x) => x.kind === 'cancellation')) {
    const key = r.comment.trim() || 'No reason given';
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  return {
    items,
    nps,
    csat,
    cancellationReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    classRating: meanOf('class'),
    trainerRating: meanOf('trainer'),
    anonymousCount: rows.filter((r) => r.anonymous).length,
    asOf: iso(at),
  };
}

export interface FeedbackCreateInput {
  memberId?: string | null;
  branchId?: string | null;
  kind: string;
  score?: number | null;
  comment?: string;
  anonymous?: boolean;
  subjectType?: string | null;
  subjectId?: string | null;
  subjectLabel?: string | null;
}

/**
 * Record feedback taken at the desk — a cancellation reason, a comment card,
 * a rating somebody gave in person.
 *
 * `anonymous` drops the member id before the row is written rather than after,
 * so an anonymous response has no author to leak even to a later query, and no
 * audit `after` block carries the member either.
 */
export function recordFeedback(ctx: RequestContext, input: FeedbackCreateInput) {
  requirePermission(ctx, 'support.manage');
  const at = now();
  const anonymous = input.anonymous ?? false;

  let branchId = input.branchId ?? ctx.activeBranchId ?? null;
  if (branchId) requireBranch(ctx, branchId);

  let memberId: string | null = null;
  if (input.memberId && !anonymous) {
    const member = db
      .select({ id: schema.members.id, homeBranchId: schema.members.homeBranchId })
      .from(schema.members)
      .where(and(eq(schema.members.id, input.memberId), eq(schema.members.tenantId, ctx.tenantId)))
      .get();
    if (!member) throw notFound('That member');
    memberId = member.id;
    branchId = branchId ?? member.homeBranchId;
  }

  const bounds: Record<string, [number, number]> = {
    nps: [0, 10],
    csat: [1, 5],
    class: [1, 5],
    trainer: [1, 5],
    facility: [1, 5],
  };
  const bound = bounds[input.kind];
  if (bound && input.score !== null && input.score !== undefined) {
    if (input.score < bound[0] || input.score > bound[1]) {
      throw invalid(`A ${input.kind} score is ${bound[0]}–${bound[1]}.`);
    }
  }

  const feedbackId = id('fbk');
  transact(() => {
    db.insert(schema.feedback)
      .values({
        id: feedbackId,
        tenantId: ctx.tenantId,
        branchId,
        memberId,
        kind: input.kind,
        score: input.score ?? null,
        comment: (input.comment ?? '').trim(),
        anonymous,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        subjectLabel: input.subjectLabel ?? null,
        ticketId: null,
        createdAt: at,
      })
      .run();

    audit(ctx, {
      action: 'feedback.recorded',
      entityType: 'feedback',
      entityId: feedbackId,
      entityLabel: input.kind,
      branchId,
      // Deliberately no member id when anonymous: the audit log is permanent,
      // so writing the author here would undo the promise for ever.
      after: { kind: input.kind, score: input.score ?? null, anonymous, memberId },
    });
  });

  return feedbackSummary(ctx, { branchId: filtersBranch(branchId, ctx) });
}

/** Keep the follow-up read inside the caller's scope without widening it. */
function filtersBranch(branchId: string | null, ctx: RequestContext): string | null {
  return branchId && ctx.branchIds.includes(branchId) ? branchId : null;
}

/* ——— Retention (PF-SUP-003, PF-SUP-004, PF-SUP-005) ————————— */

const WEEK = 7 * DAY;

/**
 * Recompute one member's risk from the ledgers.
 *
 * Live, not read from `members.risk_score`. The stored column is a nightly
 * snapshot for the directory; a support desk deciding who to call today needs
 * the number as it is now, and the PRD's own edge case — a score that rose
 * because the gym was shut — is only excludable if the closure weeks are
 * counted at the moment of asking.
 */
function riskFor(
  ctx: RequestContext,
  member: typeof schema.members.$inferSelect,
  at: number,
  branchHolidays: Map<string, Set<string>>,
  branchTz: Map<string, string>,
) {
  const since = at - 4 * WEEK;
  const visits = db
    .select({ at: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, ctx.tenantId),
        eq(schema.checkIns.memberId, member.id),
        eq(schema.checkIns.decision, 'allowed'),
        sql`${schema.checkIns.enteredAt} >= ${at - 12 * WEEK}`,
      ),
    )
    .all();

  const weekly: [number, number, number, number] = [0, 0, 0, 0];
  let baselineVisits = 0;
  for (const v of visits) {
    const weeksAgo = Math.floor((at - v.at) / WEEK);
    if (weeksAgo >= 0 && weeksAgo < 4) weekly[weeksAgo] = (weekly[weeksAgo] ?? 0) + 1;
    else if (weeksAgo >= 4 && weeksAgo < 12) baselineVisits += 1;
  }

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, member.id), eq(schema.memberships.tenantId, ctx.tenantId)))
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  const failedPayment = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.tenantId, ctx.tenantId),
        eq(schema.payments.memberId, member.id),
        eq(schema.payments.state, 'failed'),
        sql`${schema.payments.createdAt} >= ${since}`,
      ),
    )
    .get();

  const openComplaints = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.tenantId, ctx.tenantId),
        eq(schema.tickets.memberId, member.id),
        eq(schema.tickets.category, 'complaint'),
        inArray(schema.tickets.state, ['open', 'pending_member', 'pending_staff']),
      ),
    )
    .get();

  // PF-SUP-003 edge case: a week the branch was shut is not the member's
  // disengagement, so those weeks come out of the denominator entirely.
  const tz = branchTz.get(member.homeBranchId) ?? 'Asia/Kolkata';
  const holidays = branchHolidays.get(member.homeBranchId) ?? new Set<string>();
  let branchClosedWeeks = 0;
  for (let w = 0; w < 4; w += 1) {
    let closedDays = 0;
    for (let d = 0; d < 7; d += 1) {
      if (holidays.has(isoDate(at - w * WEEK - d * DAY, tz))) closedDays += 1;
    }
    if (closedDays >= 4) branchClosedWeeks += 1;
  }

  const endsOnMs = membership?.endsOn ? Date.parse(`${membership.endsOn}T00:00:00Z`) : null;
  const joinedMs = Date.parse(`${member.joinedOn}T00:00:00Z`);

  return retentionRisk({
    weeklySessions: weekly,
    baselineWeekly: baselineVisits / 8,
    daysSinceLastVisit: member.lastVisitAt === null ? null : Math.floor((at - member.lastVisitAt) / DAY),
    hasFailedPayment: (failedPayment?.n ?? 0) > 0,
    daysUntilExpiry: endsOnMs === null ? null : Math.floor((endsOnMs - at) / DAY),
    autoRenew: membership?.autoRenew ?? false,
    unansweredCoachMessages: 0,
    openComplaints: openComplaints?.n ?? 0,
    branchClosedWeeks,
    daysSinceJoined: Number.isFinite(joinedMs) ? Math.floor((at - joinedMs) / DAY) : 999,
  });
}

export interface RetentionFilters {
  branchId?: string | null;
  band?: string | null;
  limit?: number;
}

export function retentionView(ctx: RequestContext, filters: RetentionFilters = {}): RetentionView {
  requirePermission(ctx, 'support.manage');
  const at = now();
  const scope = scopeFor(ctx, filters.branchId);
  const branches = branchNames(ctx.tenantId);

  const branchRows = db
    .select({ id: schema.branches.id, holidays: schema.branches.holidays, timezone: schema.branches.timezone })
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, ctx.tenantId))
    .all();
  const branchHolidays = new Map(branchRows.map((b) => [b.id, new Set(b.holidays)]));
  const branchTz = new Map(branchRows.map((b) => [b.id, b.timezone]));

  const members = db
    .select()
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        inArray(schema.members.homeBranchId, scope),
        isNull(schema.members.deletedAt),
        ne(schema.members.lifecycle, 'deleted'),
      ),
    )
    .all();

  const openInterventions = new Map(
    db
      .select({ id: schema.interventions.id, memberId: schema.interventions.memberId })
      .from(schema.interventions)
      .where(and(eq(schema.interventions.tenantId, ctx.tenantId), eq(schema.interventions.state, 'open')))
      .all()
      .map((i) => [i.memberId, i.id]),
  );

  const vulnerable = new Set(
    db
      .select({ memberId: schema.tickets.memberId })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.tenantId, ctx.tenantId), eq(schema.tickets.vulnerabilityFlag, true)))
      .all()
      .map((t) => t.memberId)
      .filter((m): m is string => m !== null),
  );

  const optedOut = new Set(
    db
      .select({ userId: schema.consents.userId })
      .from(schema.consents)
      .where(
        and(
          eq(schema.consents.tenantId, ctx.tenantId),
          eq(schema.consents.purpose, 'marketing'),
          eq(schema.consents.granted, false),
        ),
      )
      .all()
      .map((c) => c.userId),
  );

  const bands = { high: 0, watch: 0, low: 0 };
  const atRisk: AtRiskMember[] = [];

  for (const member of members) {
    const risk = riskFor(ctx, member, at, branchHolidays, branchTz);
    bands[risk.band] += 1;
    if (risk.band === 'low' && !filters.band) continue;
    if (filters.band && risk.band !== filters.band) continue;

    const tz = branchTz.get(member.homeBranchId) ?? 'Asia/Kolkata';
    const branchRow = branchRows.find((b) => b.id === member.homeBranchId);
    const branchOpen = db
      .select({ opensMinutes: schema.branches.opensMinutes, closesMinutes: schema.branches.closesMinutes })
      .from(schema.branches)
      .where(eq(schema.branches.id, member.homeBranchId))
      .get();
    const localNow = localMinutes(at, tz);
    const insideQuietHours =
      branchOpen === undefined ||
      localNow < branchOpen.opensMinutes ||
      localNow >= branchOpen.closesMinutes ||
      (branchRow ? branchRow.holidays.includes(isoDate(at, tz)) : false);

    const sentLast7d = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.tenantId, ctx.tenantId),
          member.userId ? eq(schema.notifications.userId, member.userId) : sql`0 = 1`,
          sql`${schema.notifications.createdAt} >= ${at - WEEK}`,
        ),
      )
      .get();

    // PF-SUP-005 in one call. The guard is in the domain and shared with every
    // other outreach path, so widening it here cannot quietly widen it there.
    const outreach = canSendAutomatedOutreach({
      optedOut: member.userId ? optedOut.has(member.userId) : false,
      insideQuietHours,
      messagesSentLast7d: sentLast7d?.n ?? 0,
      hasOpenComplaint: risk.reasons.some((r) => r.code === 'open_complaint'),
      isVulnerabilityFlagged: vulnerable.has(member.id),
    });

    const membership = db
      .select({ endsOn: schema.memberships.endsOn })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.memberId, member.id), eq(schema.memberships.tenantId, ctx.tenantId)))
      .orderBy(desc(schema.memberships.createdAt))
      .get();

    atRisk.push({
      memberId: member.id,
      memberNo: member.memberNo,
      name: `${member.firstName} ${member.lastName}`.trim(),
      branchId: member.homeBranchId,
      branchName: branches.get(member.homeBranchId) ?? member.homeBranchId,
      score: risk.score,
      band: risk.band,
      reasons: risk.reasons as RiskReason[],
      recommendedAction: risk.recommendedAction,
      suppressed: risk.suppressed,
      lastVisitAt: isoOrNull(member.lastVisitAt),
      membershipEndsOn: membership?.endsOn ?? null,
      openInterventionId: openInterventions.get(member.id) ?? null,
      outreach,
    });
  }

  atRisk.sort((a, b) => b.score - a.score);

  const interventionRows = db
    .select()
    .from(schema.interventions)
    .where(and(eq(schema.interventions.tenantId, ctx.tenantId), inArray(schema.interventions.branchId, scope)))
    .orderBy(desc(schema.interventions.createdAt))
    .all();

  const interventionMembers = memberBriefs(
    ctx.tenantId,
    interventionRows.map((i) => i.memberId),
  );
  const ticketRefs = new Map(
    db
      .select({ id: schema.tickets.id, reference: schema.tickets.reference })
      .from(schema.tickets)
      .where(eq(schema.tickets.tenantId, ctx.tenantId))
      .all()
      .map((t) => [t.id, t.reference]),
  );

  const interventions: Intervention[] = interventionRows.map((row) => ({
    id: row.id,
    memberId: row.memberId,
    memberName: interventionMembers.get(row.memberId)?.name ?? 'Former member',
    branchId: row.branchId,
    branchName: branches.get(row.branchId) ?? row.branchId,
    ticketId: row.ticketId,
    ticketReference: row.ticketId ? (ticketRefs.get(row.ticketId) ?? null) : null,
    riskScoreAtCreation: row.riskScoreAtCreation,
    riskBandAtCreation: row.riskBandAtCreation as Intervention['riskBandAtCreation'],
    riskReasonsAtCreation: row.riskReasonsAtCreation,
    recommendedAction: row.recommendedAction,
    action: row.action as InterventionAction,
    note: row.note,
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeName,
    dueAt: iso(row.dueAt),
    overdue: row.state === 'open' && row.dueAt < at,
    state: row.state as InterventionState,
    outcome: row.outcome as InterventionOutcome | null,
    outcomeNote: row.outcomeNote,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    completedAt: isoOrNull(row.completedAt),
  }));

  return {
    atRisk: atRisk.slice(0, filters.limit ?? 100),
    interventions: interventions.slice(0, 200),
    effectiveness: interventionEffectiveness(
      interventionRows.map((r) => ({
        action: r.action,
        outcome: r.outcome,
        riskBandAtCreation: r.riskBandAtCreation,
      })),
    ) as RetentionView['effectiveness'],
    bands,
    asOf: iso(at),
  };
}

/* ——— Interventions (PF-SUP-004) —————————————————————————————— */

export interface InterventionCreateInput {
  memberId: string;
  action: string;
  note?: string;
  assigneeId?: string | null;
  dueInDays?: number;
  ticketId?: string | null;
}

export function createIntervention(ctx: RequestContext, input: InterventionCreateInput) {
  requirePermission(ctx, 'support.manage');
  const at = now();

  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, input.memberId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) throw notFound('That member');
  requireBranch(ctx, member.homeBranchId);
  if (member.deletedAt !== null) throw precondition('That member record has been deleted.');

  // One open task per member. Two people ringing the same member on the same
  // day about the same score is the failure this whole surface exists to stop.
  const existing = db
    .select({ id: schema.interventions.id })
    .from(schema.interventions)
    .where(
      and(
        eq(schema.interventions.tenantId, ctx.tenantId),
        eq(schema.interventions.memberId, member.id),
        eq(schema.interventions.state, 'open'),
      ),
    )
    .get();
  if (existing) throw conflict('There is already an open intervention for this member.');

  const branchRows = db
    .select({ id: schema.branches.id, holidays: schema.branches.holidays, timezone: schema.branches.timezone })
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, ctx.tenantId))
    .all();
  const risk = riskFor(
    ctx,
    member,
    at,
    new Map(branchRows.map((b) => [b.id, new Set(b.holidays)])),
    new Map(branchRows.map((b) => [b.id, b.timezone])),
  );

  if (input.assigneeId) assertStaffActive(ctx, input.assigneeId);
  const staff = staffNames(ctx.tenantId);
  const interventionId = id('itv');
  const dueAt = at + (input.dueInDays ?? 3) * DAY;

  transact(() => {
    db.insert(schema.interventions)
      .values({
        id: interventionId,
        tenantId: ctx.tenantId,
        branchId: member.homeBranchId,
        memberId: member.id,
        ticketId: input.ticketId ?? null,
        // Frozen. Risk moves; the reason this task was created must not.
        riskScoreAtCreation: risk.score,
        riskBandAtCreation: risk.band,
        riskReasonsAtCreation: risk.reasons,
        recommendedAction: risk.recommendedAction,
        action: input.action,
        note: (input.note ?? '').trim(),
        assigneeId: input.assigneeId ?? null,
        assigneeName: input.assigneeId ? (staff.get(input.assigneeId) ?? null) : null,
        dueAt,
        state: 'open',
        outcome: null,
        outcomeNote: null,
        createdBy: ctx.name,
        createdAt: at,
        completedAt: null,
      })
      .run();

    audit(ctx, {
      action: 'intervention.created',
      entityType: 'intervention',
      entityId: interventionId,
      entityLabel: member.memberNo,
      branchId: member.homeBranchId,
      after: { memberId: member.id, action: input.action, riskScore: risk.score, band: risk.band },
    });
  });

  return { interventionId };
}

function assertStaffActive(ctx: RequestContext, staffId: string): void {
  const row = db
    .select({ status: schema.staff.employmentStatus })
    .from(schema.staff)
    .where(and(eq(schema.staff.id, staffId), eq(schema.staff.tenantId, ctx.tenantId)))
    .get();
  if (!row) throw notFound('That staff member');
  if (row.status !== 'active') throw invalid('That staff member is not active.');
}

export interface InterventionCloseInput {
  outcome: string;
  outcomeNote?: string;
  state?: string;
}

/**
 * Record what happened. This is the half of PF-SUP-004 that makes the other
 * half worth anything — an intervention with no outcome is a task list, not
 * effectiveness tracking.
 */
export function closeIntervention(ctx: RequestContext, interventionId: string, input: InterventionCloseInput) {
  requirePermission(ctx, 'support.manage');
  const row = db
    .select()
    .from(schema.interventions)
    .where(and(eq(schema.interventions.id, interventionId), eq(schema.interventions.tenantId, ctx.tenantId)))
    .get();
  if (!row) throw notFound('That intervention');
  if (!ctx.branchIds.includes(row.branchId)) throw notFound('That intervention');
  if (row.state !== 'open') throw conflict('That intervention is already closed.');

  const at = now();
  const state = input.state === 'dismissed' ? 'dismissed' : 'done';

  transact(() => {
    db.update(schema.interventions)
      .set({
        state,
        outcome: input.outcome,
        outcomeNote: (input.outcomeNote ?? '').trim() || null,
        completedAt: at,
      })
      .where(eq(schema.interventions.id, interventionId))
      .run();

    audit(ctx, {
      action: 'intervention.closed',
      entityType: 'intervention',
      entityId: interventionId,
      entityLabel: row.memberId,
      branchId: row.branchId,
      before: { state: row.state },
      after: { state, outcome: input.outcome, riskScoreAtCreation: row.riskScoreAtCreation },
    });
  });

  return { interventionId, state, outcome: input.outcome };
}
