import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { formatMoney } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { invalid, notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { isoDate, now } from '../lib/time.js';

/**
 * Members directory bulk actions (Design PRD §5.5): tag, assign a coach,
 * message and export a selection.
 *
 * Every action resolves the selection through the same scope the directory
 * list uses — tenant, branch scope and, for a trainer, their own roster — and
 * refuses the whole batch if any id falls outside it. A partial success would
 * leave the operator unsure which rows changed, and a per-row 403 would
 * confirm that a member exists somewhere the caller cannot see.
 */

type MemberRow = typeof schema.members.$inferSelect;

export function membersInScope(ctx: RequestContext, memberIds: string[]): MemberRow[] {
  const ids = [...new Set(memberIds)];
  const scope = ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
  const filters = [
    eq(schema.members.tenantId, ctx.tenantId),
    inArray(schema.members.id, ids),
    inArray(schema.members.homeBranchId, scope),
    isNull(schema.members.deletedAt),
    isNull(schema.members.mergedIntoId),
  ];
  if (ctx.role === 'trainer') filters.push(eq(schema.members.trainerId, ctx.staffId ?? ''));

  const rows = db.select().from(schema.members).where(and(...filters)).all();
  if (rows.length !== ids.length) {
    const missing = ids.length - rows.length;
    throw notFound(missing === 1 ? 'One of the selected members' : `${missing} of the selected members`);
  }
  // Keep the order the operator selected in, so an export reads like the screen.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((memberId) => byId.get(memberId)!);
}

/* ——— Tags ——————————————————————————————————————————————————— */

/** Tags are short lowercase slugs ("pt-client", "early-bird"), so "PT Client"
 *  and "pt-client" do not become two filters that mean the same thing. */
export function normalizeTag(raw: string): string {
  const tag = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag)) {
    throw invalid('A tag is 1–32 letters, numbers or dashes.', [{ path: 'tag', code: 'invalid_tag', message: 'Use letters, numbers or dashes' }]);
  }
  return tag;
}

export function bulkTag(ctx: RequestContext, input: { memberIds: string[]; tag: string; mode: 'add' | 'remove' }) {
  const tag = normalizeTag(input.tag);
  const members = membersInScope(ctx, input.memberIds);
  const at = now();
  let changed = 0;

  transact(() => {
    for (const m of members) {
      const has = m.tags.includes(tag);
      if ((input.mode === 'add' && has) || (input.mode === 'remove' && !has)) continue;
      const tags = input.mode === 'add' ? [...m.tags, tag] : m.tags.filter((t) => t !== tag);
      db.update(schema.members)
        .set({ tags, version: m.version + 1, updatedAt: at })
        .where(eq(schema.members.id, m.id))
        .run();
      audit(ctx, {
        action: input.mode === 'add' ? 'member.tag_added' : 'member.tag_removed',
        entityType: 'member',
        entityId: m.id,
        entityLabel: m.memberNo,
        branchId: m.homeBranchId,
        before: { tags: m.tags },
        after: { tags },
      });
      changed += 1;
    }
  });

  const unchanged = members.length - changed;
  const verb = input.mode === 'add' ? 'Tagged' : 'Removed the tag from';
  return {
    ok: true,
    tag,
    changed,
    unchanged,
    message:
      changed === 0
        ? input.mode === 'add'
          ? `Everyone selected already has “${tag}”.`
          : `Nobody selected had “${tag}”.`
        : `${verb} ${changed} ${changed === 1 ? 'member' : 'members'} “${tag}”.${unchanged > 0 ? ` ${unchanged} already matched.` : ''}`,
  };
}

/* ——— Coach assignment ———————————————————————————————————————— */

/** Active trainers the caller could hand a member to — the picker behind
 *  "Assign trainer". Reception cannot read the staff module, so this is
 *  served from the members module with only what the picker needs. */
export function assignableTrainers(ctx: RequestContext) {
  const scope = ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
  const rows = db
    .select({ id: schema.staff.id, name: schema.users.name, branchIds: schema.staff.branchIds })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(
      and(
        eq(schema.staff.tenantId, ctx.tenantId),
        eq(schema.staff.employmentStatus, 'active'),
        eq(schema.users.role, 'trainer'),
      ),
    )
    .all()
    .filter((s) => s.branchIds.some((b) => scope.includes(b)));

  const counts = new Map(
    rows.length
      ? db
          .select({ trainerId: schema.members.trainerId, n: sql<number>`count(*)` })
          .from(schema.members)
          .where(
            and(
              eq(schema.members.tenantId, ctx.tenantId),
              inArray(
                schema.members.trainerId,
                rows.map((r) => r.id),
              ),
              isNull(schema.members.deletedAt),
            ),
          )
          .groupBy(schema.members.trainerId)
          .all()
          .map((r) => [r.trainerId, r.n])
      : [],
  );

  return {
    items: rows
      .map((r) => ({ id: r.id, name: r.name, branchIds: r.branchIds, memberCount: counts.get(r.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function bulkAssignTrainer(ctx: RequestContext, input: { memberIds: string[]; trainerId: string | null }) {
  const members = membersInScope(ctx, input.memberIds);

  let trainerName: string | null = null;
  if (input.trainerId) {
    const trainer = db
      .select({ id: schema.staff.id, name: schema.users.name, branchIds: schema.staff.branchIds })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(
        and(
          eq(schema.staff.id, input.trainerId),
          eq(schema.staff.tenantId, ctx.tenantId),
          eq(schema.staff.employmentStatus, 'active'),
          eq(schema.users.role, 'trainer'),
        ),
      )
      .get();
    if (!trainer) throw notFound('That trainer');

    // A coach who never works at a member's branch cannot actually coach them.
    const outside = members.filter((m) => !trainer.branchIds.includes(m.homeBranchId));
    if (outside.length > 0) {
      throw invalid(
        `${trainer.name} does not work at the home branch of ${outside.length} selected ${outside.length === 1 ? 'member' : 'members'}.`,
        [{ path: 'trainerId', code: 'outside_branch', message: 'Pick a trainer from the members’ branch' }],
      );
    }
    trainerName = trainer.name;
  }

  const at = now();
  let changed = 0;
  transact(() => {
    for (const m of members) {
      if (m.trainerId === input.trainerId) continue;
      db.update(schema.members)
        .set({ trainerId: input.trainerId, version: m.version + 1, updatedAt: at })
        .where(eq(schema.members.id, m.id))
        .run();
      audit(ctx, {
        action: input.trainerId ? 'member.trainer_assigned' : 'member.trainer_removed',
        entityType: 'member',
        entityId: m.id,
        entityLabel: m.memberNo,
        branchId: m.homeBranchId,
        before: { trainerId: m.trainerId },
        after: { trainerId: input.trainerId },
      });
      changed += 1;
    }
  });

  const noun = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`;
  return {
    ok: true,
    changed,
    unchanged: members.length - changed,
    message:
      changed === 0
        ? 'Nothing changed. Everyone selected already had that coach.'
        : trainerName
          ? `Assigned ${noun(changed)} to ${trainerName}.`
          : `Removed the coach from ${noun(changed)}.`,
  };
}

/* ——— Message ——————————————————————————————————————————————— */

/**
 * Posts the same note into each member's reception conversation, creating it
 * when they have none, so it lands in Messages in the member app exactly like
 * a one-to-one reply from the desk. It does not send SMS, WhatsApp or email:
 * no outbound sender is configured in this deployment, and the response says
 * so rather than implying a delivery that did not happen.
 */
export function bulkMessage(ctx: RequestContext, input: { memberIds: string[]; body: string }) {
  const body = input.body.trim();
  if (body.length === 0) throw invalid('Write a message first.', [{ path: 'body', code: 'empty', message: 'Required' }]);

  const members = membersInScope(ctx, input.memberIds);
  const at = now();
  const branchNames = new Map(
    db.select({ id: schema.branches.id, name: schema.branches.name }).from(schema.branches).all().map((b) => [b.id, b.name]),
  );

  const existing = db
    .select({ id: schema.conversations.id, memberId: schema.conversations.memberId })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.tenantId, ctx.tenantId),
        eq(schema.conversations.kind, 'reception'),
        eq(schema.conversations.state, 'open'),
        inArray(
          schema.conversations.memberId,
          members.map((m) => m.id),
        ),
      ),
    )
    .orderBy(desc(schema.conversations.lastMessageAt))
    .all();
  const conversationFor = new Map<string, string>();
  for (const row of existing) if (row.memberId && !conversationFor.has(row.memberId)) conversationFor.set(row.memberId, row.id);

  const sent: Array<{ memberId: string; conversationId: string; messageId: string; branchId: string }> = [];
  let created = 0;

  transact(() => {
    for (const m of members) {
      let conversationId = conversationFor.get(m.id);
      if (!conversationId) {
        conversationId = id('cnv');
        db.insert(schema.conversations)
          .values({
            id: conversationId,
            tenantId: ctx.tenantId,
            kind: 'reception',
            title: `${branchNames.get(m.homeBranchId) ?? 'Front desk'} reception`,
            memberId: m.id,
            staffId: ctx.staffId,
            ticketId: null,
            state: 'open',
            muted: false,
            lastMessageAt: at,
            createdAt: at,
          })
          .run();
        created += 1;
      } else {
        db.update(schema.conversations)
          .set({ lastMessageAt: at })
          .where(eq(schema.conversations.id, conversationId))
          .run();
      }

      const messageId = id('msg');
      db.insert(schema.messages)
        .values({
          id: messageId,
          tenantId: ctx.tenantId,
          conversationId,
          senderUserId: ctx.userId,
          senderName: ctx.name,
          senderRole: ctx.role,
          body,
          attachments: [],
          state: 'sent',
          clientId: null,
          createdAt: at,
          readAt: null,
          safetyFlagged: false,
        })
        .run();
      sent.push({ memberId: m.id, conversationId, messageId, branchId: m.homeBranchId });
    }

    audit(ctx, {
      action: 'member.bulk_messaged',
      entityType: 'member_bulk',
      entityId: id('blk'),
      entityLabel: `${members.length} members`,
      before: null,
      after: { memberIds: members.map((m) => m.id), body },
    });
  });

  for (const s of sent) {
    emit({
      tenantId: ctx.tenantId,
      branchId: s.branchId,
      channel: channels.member(s.memberId),
      topic: 'message.created',
      payload: { conversationId: s.conversationId, messageId: s.messageId },
    });
  }

  const withoutApp = members.filter((m) => !m.userId).length;
  return {
    ok: true,
    sent: sent.length,
    conversationsCreated: created,
    withoutApp,
    message:
      `Sent to ${sent.length} ${sent.length === 1 ? 'member' : 'members'} in the app.` +
      (withoutApp > 0 ? ` ${withoutApp} ${withoutApp === 1 ? 'has' : 'have'} not signed in to the app yet and will see it when they do.` : ''),
  };
}

/* ——— Export ——————————————————————————————————————————————— */

/**
 * A cell that starts with = + - @ (or a tab/CR) is run as a formula by Excel
 * and Sheets, so a member named "=HYPERLINK(...)" could execute on the
 * operator's machine. Such cells are prefixed with an apostrophe. Phone
 * numbers like "+91 98450 12345" are left alone: they are not formulas and
 * mangling every phone in the file would make the export useless.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  const phoneLike = /^[+-]?[\d\s()-]+$/.test(text);
  if (/^[=+\-@\t\r]/.test(text) && !phoneLike) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportMembersCsv(ctx: RequestContext, memberIds: string[]): { filename: string; csv: string; count: number } {
  const members = membersInScope(ctx, memberIds);
  const ids = members.map((m) => m.id);
  const canSeeBalances = ctx.permissions.includes('billing.view');

  const branchNames = new Map(
    db.select({ id: schema.branches.id, name: schema.branches.name }).from(schema.branches).all().map((b) => [b.id, b.name]),
  );
  const trainerNames = new Map(
    db
      .select({ id: schema.staff.id, name: schema.users.name })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.staff.tenantId, ctx.tenantId))
      .all()
      .map((s) => [s.id, s.name]),
  );
  const memberships = new Map(
    db
      .select({
        memberId: schema.memberships.memberId,
        state: schema.memberships.state,
        productName: schema.memberships.productName,
        endsOn: schema.memberships.endsOn,
        createdAt: schema.memberships.createdAt,
      })
      .from(schema.memberships)
      .where(and(inArray(schema.memberships.memberId, ids), sql`${schema.memberships.state} != 'cancelled'`))
      .orderBy(schema.memberships.createdAt)
      .all()
      .map((m) => [m.memberId, m]),
  );
  const balances = canSeeBalances
    ? new Map(
        db
          .select({
            memberId: schema.invoices.memberId,
            due: sql<number>`sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor})`,
          })
          .from(schema.invoices)
          .where(
            and(
              inArray(schema.invoices.memberId, ids),
              sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
            ),
          )
          .groupBy(schema.invoices.memberId)
          .all()
          .map((b) => [b.memberId, b.due]),
      )
    : null;

  const header = [
    'Member no',
    'First name',
    'Last name',
    'Email',
    'Phone',
    'Lifecycle',
    'Home branch',
    'Coach',
    'Plan',
    'Membership state',
    'Ends on',
    'Joined on',
    'Last visit',
    'Risk score',
    'Tags',
    ...(canSeeBalances ? ['Balance due'] : []),
  ];

  const lines = members.map((m) => {
    const membership = memberships.get(m.id);
    const due = balances?.get(m.id) ?? 0;
    return [
      m.memberNo,
      m.firstName,
      m.lastName,
      m.email,
      m.phone,
      m.lifecycle,
      branchNames.get(m.homeBranchId) ?? '',
      m.trainerId ? (trainerNames.get(m.trainerId) ?? '') : '',
      membership?.productName ?? '',
      membership?.state ?? '',
      membership?.endsOn ?? '',
      m.joinedOn,
      m.lastVisitAt ? isoDate(m.lastVisitAt, 'Asia/Kolkata') : '',
      m.riskScore,
      m.tags.join('; '),
      ...(canSeeBalances ? [due > 0 ? formatMoney(due, 'INR') : ''] : []),
    ]
      .map(csvCell)
      .join(',');
  });

  audit(ctx, {
    action: 'member.exported',
    entityType: 'member_bulk',
    entityId: id('blk'),
    entityLabel: `${members.length} members`,
    before: null,
    after: { memberIds: ids, columns: header },
  });

  const stamp = isoDate(now(), 'Asia/Kolkata');
  return {
    filename: `members-${stamp}.csv`,
    // A BOM so Excel opens the UTF-8 file with names like "Zoë" intact.
    csv: `\uFEFF${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`,
    count: members.length,
  };
}
