import { Hono } from 'hono';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { decideAccess, occupancyLabel } from '@shark/domain';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { emit } from '../../lib/events.js';
import { notFound } from '../../lib/errors.js';
import { issuePassBatch, PASS_WINDOW_SECONDS } from '../../lib/pass-token.js';
import { HOUR, MINUTE, isoDate, localMinutes, now, relativeTime } from '../../lib/time.js';

export const passRoutes = new Hono();

function occupancyOf(tenantId: string, branchId: string) {
  const branch = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, tenantId)))
    .get();
  const inside = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        eq(schema.checkIns.branchId, branchId),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, now() - 6 * HOUR),
      ),
    )
    .get();
  const count = inside?.n ?? 0;
  const capacity = branch?.capacity ?? 100;
  return { branch, inside: count, capacity, label: occupancyLabel(count, capacity) };
}

passRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) throw notFound('Your membership');

  const branchId = ctx.activeBranchId ?? member.homeBranchId;
  const { branch, inside, capacity, label } = occupancyOf(ctx.tenantId, branchId);
  if (!branch) throw notFound('That branch');

  const epoch = Math.floor(now() / 1000);
  const membership = db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.tenantId, ctx.tenantId),
        eq(schema.memberships.memberId, memberId),
        sql`${schema.memberships.state} != 'cancelled'`,
      ),
    )
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  const outstanding = db
    .select({
      total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}), 0)`,
      firstId: sql<string | null>`min(${schema.invoices.id})`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.tenantId, ctx.tenantId),
        eq(schema.invoices.memberId, memberId),
        sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
      ),
    )
    .get();

  const openSession = db
    .select()
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, ctx.tenantId),
        eq(schema.checkIns.memberId, memberId),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, now() - 6 * HOUR),
      ),
    )
    .orderBy(desc(schema.checkIns.enteredAt))
    .get();

  const history = db
    .select({
      id: schema.checkIns.id,
      enteredAt: schema.checkIns.enteredAt,
      exitedAt: schema.checkIns.exitedAt,
      decision: schema.checkIns.decision,
      branchId: schema.checkIns.branchId,
    })
    .from(schema.checkIns)
    .where(and(eq(schema.checkIns.tenantId, ctx.tenantId), eq(schema.checkIns.memberId, memberId)))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(8)
    .all();

  const branchNames = new Map(
    db
      .select({ id: schema.branches.id, name: schema.branches.name })
      .from(schema.branches)
      .where(eq(schema.branches.tenantId, ctx.tenantId))
      .all()
      .map((b) => [b.id, b.name]),
  );
  const tz = branch.timezone;

  return c.json({
    member: { name: `${member.firstName} ${member.lastName}`, memberNo: member.memberNo, initials: member.initials },
    branch: { id: branchId, name: branch.name, timezone: tz },
    code: {
      rotateSec: PASS_WINDOW_SECONDS,
      serverEpoch: epoch,
      passes: issuePassBatch(ctx.tenantId, memberId, epoch),
    },
    membership: membership
      ? {
          state: membership.state,
          productName: membership.productName,
          endsOn: membership.endsOn,
          graceEndsOn: membership.graceEndsOn,
        }
      : null,
    outstandingMinor: outstanding?.total ?? 0,
    outstandingInvoiceId: outstanding?.firstId ?? null,
    willBeAdmitted: (() => {
      if (!membership) return false;
      return decideAccess({
        membershipState: membership.state as 'active',
        permittedBranchIds: ctx.branchIds,
        branchId,
        nowMinutes: localMinutes(now(), tz),
        opensMinutes: branch.opensMinutes,
        closesMinutes: branch.closesMinutes,
        windowStartMin: membership.productSnapshot.access.windowStartMin,
        windowEndMin: membership.productSnapshot.access.windowEndMin,
        outstandingMinor: outstanding?.total ?? 0,
        graceAllowsEntry: false,
        occupancy: inside,
        capacity,
        tokenValid: true,
        tokenReplayed: false,
        secondsSinceLastCheckIn: null,
        antiPassbackSeconds: 0,
        alreadyInside: Boolean(openSession),
      }).granted;
    })(),
    openSession: openSession
      ? {
          id: openSession.id,
          enteredAt: new Date(openSession.enteredAt).toISOString(),
          minutesInside: Math.round((now() - openSession.enteredAt) / MINUTE),
        }
      : null,
    occupancy: { inside, capacity, label },
    history: history.map((h) => ({
      id: h.id,
      day: new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }).format(h.enteredAt),
      span:
        h.decision !== 'granted'
          ? 'Refused'
          : h.exitedAt
            ? `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(h.enteredAt)} – ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(h.exitedAt)}`
            : 'Inside now',
      granted: h.decision === 'granted',
      branchName: branchNames.get(h.branchId) ?? '',
      relativeTime: relativeTime(h.enteredAt),
    })),
  });
});

passRoutes.post('/check-out', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const open = db
    .select()
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, ctx.tenantId),
        eq(schema.checkIns.memberId, memberId),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
      ),
    )
    .orderBy(desc(schema.checkIns.enteredAt))
    .get();
  if (!open) throw notFound('An open session');

  db.update(schema.checkIns).set({ exitedAt: now() }).where(eq(schema.checkIns.id, open.id)).run();
  emit({
    tenantId: ctx.tenantId,
    branchId: open.branchId,
    channel: channels.branch(open.branchId),
    topic: 'attendance.checked_out',
    payload: { memberId, checkInId: open.id },
  });
  return c.json({
    ok: true,
    minutesInside: Math.round((now() - open.enteredAt) / MINUTE),
    at: new Date(now()).toISOString(),
  });
});

passRoutes.get('/history', (c) => {
  const ctx = ctxOf(c);
  const rows = db
    .select()
    .from(schema.checkIns)
    .where(and(eq(schema.checkIns.tenantId, ctx.tenantId), eq(schema.checkIns.memberId, ctx.memberId!)))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(60)
    .all();

  const branch = ctx.activeBranchId
    ? db.select().from(schema.branches).where(eq(schema.branches.id, ctx.activeBranchId)).get()
    : null;
  const tz = branch?.timezone ?? 'Asia/Kolkata';
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      date: isoDate(r.enteredAt, tz),
      granted: r.decision === 'granted',
      decision: r.decision,
      minutes: r.exitedAt ? Math.round((r.exitedAt - r.enteredAt) / MINUTE) : null,
      relativeTime: relativeTime(r.enteredAt),
    })),
  });
});
