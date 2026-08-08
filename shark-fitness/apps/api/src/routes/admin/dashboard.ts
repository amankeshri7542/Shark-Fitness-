import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { occupancyLabel } from '@shark/domain';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requirePermission } from '../../lib/context.js';
import { DAY, HOUR, isoDate, now, relativeTime } from '../../lib/time.js';

export const dashboardRoutes = new Hono();

/**
 * Command Center (UX-A01).
 *
 * Exceptions before vanity metrics (PF-DASH-005): the alert list is computed
 * first and returned first, and every KPI carries its own freshness, its
 * definition, and where clicking it drills to.
 */
dashboardRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'dashboard.view');

  // Null active branch means "every branch this actor may see" — a regional
  // view, not a silent default to one location.
  const scope = ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
  const tz = 'Asia/Kolkata';
  const today = isoDate(now(), tz);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthStartMs = Date.parse(`${monthStart}T00:00:00+05:30`);
  const prevMonthStartMs = monthStartMs - 30 * DAY;

  const canSeeMoney = ctx.permissions.includes('billing.view');

  /* — Live floor ————————————————————————————————————————————— */

  const insideRows = db
    .select({ branchId: schema.checkIns.branchId, n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
        inArray(schema.checkIns.branchId, scope),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gte(schema.checkIns.enteredAt, now() - 6 * HOUR),
      ),
    )
    .groupBy(schema.checkIns.branchId)
    .all();

  const branches = db.select().from(schema.branches).where(inArray(schema.branches.id, scope)).all();
  const capacity = branches.reduce((total, b) => total + b.capacity, 0);
  const inside = insideRows.reduce((total, r) => total + r.n, 0);

  const todayStart = Date.parse(`${today}T00:00:00+05:30`);
  const todayCheckIns = db
    .select({ enteredAt: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(
      and(
        inArray(schema.checkIns.branchId, scope),
        eq(schema.checkIns.decision, 'granted'),
        gte(schema.checkIns.enteredAt, todayStart),
        lt(schema.checkIns.enteredAt, todayStart + DAY),
      ),
    )
    .all();

  const hourly = Array.from({ length: 24 }, () => 0);
  for (const row of todayCheckIns) {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(row.enteredAt),
    );
    if (hour >= 0 && hour < 24) hourly[hour] = (hourly[hour] ?? 0) + 1;
  }

  /* — KPIs ——————————————————————————————————————————————————— */

  const activeMembers = db
    .select({ n: sql<number>`count(distinct ${schema.members.id})` })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        inArray(schema.members.homeBranchId, scope),
        sql`${schema.members.lifecycle} in ('active','trial','corporate')`,
        isNull(schema.members.deletedAt),
      ),
    )
    .get();

  const joinedThisMonth = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        inArray(schema.members.homeBranchId, scope),
        gte(schema.members.joinedOn, monthStart),
      ),
    )
    .get();

  const revenueThisMonth = db
    .select({ total: sql<number>`coalesce(sum(${schema.payments.amountMinor}), 0)` })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.tenantId, ctx.tenantId),
        eq(schema.payments.state, 'succeeded'),
        gte(schema.payments.createdAt, monthStartMs),
      ),
    )
    .get();

  const revenuePrevMonth = db
    .select({ total: sql<number>`coalesce(sum(${schema.payments.amountMinor}), 0)` })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.tenantId, ctx.tenantId),
        eq(schema.payments.state, 'succeeded'),
        gte(schema.payments.createdAt, prevMonthStartMs),
        lt(schema.payments.createdAt, monthStartMs),
      ),
    )
    .get();

  const outstanding = db
    .select({
      total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}), 0)`,
      n: sql<number>`count(*)`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.tenantId, ctx.tenantId),
        sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
      ),
    )
    .get();

  const expiring = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.tenantId, ctx.tenantId),
        eq(schema.memberships.state, 'active'),
        eq(schema.memberships.autoRenew, false),
        sql`${schema.memberships.endsOn} <= ${isoDate(now() + 30 * DAY, tz)}`,
      ),
    )
    .get();

  const openLeads = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.tenantId, ctx.tenantId),
        inArray(schema.leads.branchId, scope),
        sql`${schema.leads.stage} not in ('won','lost','disqualified')`,
      ),
    )
    .get();

  const classesToday = db
    .select({
      total: sql<number>`count(*)`,
      booked: sql<number>`coalesce(sum(${schema.classSessions.booked}), 0)`,
      capacity: sql<number>`coalesce(sum(${schema.classSessions.capacity}), 0)`,
    })
    .from(schema.classSessions)
    .where(
      and(
        inArray(schema.classSessions.branchId, scope),
        gte(schema.classSessions.startsAt, todayStart),
        lt(schema.classSessions.startsAt, todayStart + DAY),
        sql`${schema.classSessions.state} != 'cancelled'`,
      ),
    )
    .get();

  const fillRate =
    (classesToday?.capacity ?? 0) > 0
      ? Math.round(((classesToday?.booked ?? 0) / (classesToday?.capacity ?? 1)) * 100)
      : 0;

  const change = (current: number, previous: number): number | null =>
    previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

  const rupees = (minor: number): string =>
    `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  const kpis = [
    {
      key: 'active_members',
      label: 'Active members',
      value: activeMembers?.n ?? 0,
      display: String(activeMembers?.n ?? 0),
      unit: null,
      previous: null,
      changePct: null,
      direction: 'flat' as const,
      goodDirection: 'up' as const,
      freshness: 'near_realtime' as const,
      asOf: new Date(now()).toISOString(),
      drillTo: '/members?lifecycle=active',
      unavailableReason: null,
      definition: 'Members whose lifecycle is active, trial or corporate, at the branches in scope.',
    },
    {
      key: 'inside_now',
      label: 'Inside now',
      value: inside,
      display: `${inside} / ${capacity}`,
      unit: null,
      previous: null,
      changePct: null,
      direction: 'flat' as const,
      goodDirection: 'neutral' as const,
      freshness: 'realtime' as const,
      asOf: new Date(now()).toISOString(),
      drillTo: '/floor',
      unavailableReason: null,
      definition: 'Open check-in sessions that have not been checked out, within the last six hours.',
    },
    {
      key: 'joined_month',
      label: 'Joined this month',
      value: joinedThisMonth?.n ?? 0,
      display: String(joinedThisMonth?.n ?? 0),
      unit: null,
      previous: null,
      changePct: null,
      direction: 'flat' as const,
      goodDirection: 'up' as const,
      freshness: 'batch' as const,
      asOf: new Date(now()).toISOString(),
      drillTo: '/members?joined=this_month',
      unavailableReason: null,
      definition: 'Members whose join date falls in the current calendar month.',
    },
    {
      key: 'revenue_month',
      label: 'Collected this month',
      value: canSeeMoney ? (revenueThisMonth?.total ?? 0) : 0,
      display: canSeeMoney ? rupees(revenueThisMonth?.total ?? 0) : '—',
      unit: null,
      previous: canSeeMoney ? (revenuePrevMonth?.total ?? 0) : null,
      changePct: canSeeMoney ? change(revenueThisMonth?.total ?? 0, revenuePrevMonth?.total ?? 0) : null,
      direction: ((revenueThisMonth?.total ?? 0) >= (revenuePrevMonth?.total ?? 0) ? 'up' : 'down') as 'up' | 'down',
      goodDirection: 'up' as const,
      freshness: 'near_realtime' as const,
      asOf: new Date(now()).toISOString(),
      drillTo: '/billing?state=paid',
      // A restricted metric says it is restricted rather than showing a zero.
      unavailableReason: canSeeMoney ? null : 'Your role does not include financial figures.',
      definition: 'Succeeded payments recorded in the current calendar month, tenant-wide.',
    },
    {
      key: 'outstanding',
      label: 'Outstanding',
      value: canSeeMoney ? (outstanding?.total ?? 0) : 0,
      display: canSeeMoney ? rupees(outstanding?.total ?? 0) : '—',
      unit: null,
      previous: null,
      changePct: null,
      direction: 'flat' as const,
      goodDirection: 'down' as const,
      freshness: 'near_realtime' as const,
      asOf: new Date(now()).toISOString(),
      drillTo: '/billing?state=overdue',
      unavailableReason: canSeeMoney ? null : 'Your role does not include financial figures.',
      definition: 'Invoice totals minus amounts paid, for invoices that are open, part-paid or overdue.',
    },
    {
      key: 'class_fill',
      label: "Today's fill rate",
      value: fillRate,
      display: `${fillRate}%`,
      unit: '%',
      previous: null,
      changePct: null,
      direction: 'flat' as const,
      goodDirection: 'up' as const,
      freshness: 'realtime' as const,
      asOf: new Date(now()).toISOString(),
      drillTo: '/schedule',
      unavailableReason: null,
      definition: 'Seats booked divided by seats offered across today’s non-cancelled classes.',
    },
    {
      key: 'open_leads',
      label: 'Open leads',
      value: openLeads?.n ?? 0,
      display: String(openLeads?.n ?? 0),
      unit: null,
      previous: null,
      changePct: null,
      direction: 'flat' as const,
      goodDirection: 'neutral' as const,
      freshness: 'near_realtime' as const,
      asOf: new Date(now()).toISOString(),
      drillTo: '/leads',
      unavailableReason: ctx.permissions.includes('lead.view') ? null : 'Your role does not include the sales pipeline.',
      definition: 'Leads not yet won, lost or disqualified.',
    },
    {
      key: 'expiring',
      label: 'Expiring, no renew',
      value: expiring?.n ?? 0,
      display: String(expiring?.n ?? 0),
      unit: null,
      previous: null,
      changePct: null,
      direction: 'flat' as const,
      goodDirection: 'down' as const,
      freshness: 'batch' as const,
      asOf: new Date(now()).toISOString(),
      drillTo: '/members?expiring=30',
      unavailableReason: null,
      definition: 'Active memberships ending within 30 days with auto-renew switched off.',
    },
  ];

  /* — Exceptions. These come first in the UI. ————————————————— */

  const alerts: Array<Record<string, unknown>> = [];

  const failedPayments = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.tenantId, ctx.tenantId),
        eq(schema.payments.state, 'failed'),
        gte(schema.payments.createdAt, now() - 14 * DAY),
      ),
    )
    .get();

  if ((failedPayments?.n ?? 0) > 0 && canSeeMoney) {
    alerts.push({
      id: 'failed_payments',
      severity: 'critical',
      kind: 'failed_payment',
      title: `${failedPayments?.n} payment${failedPayments?.n === 1 ? '' : 's'} failed`,
      detail: 'Members in grace lose access when it runs out. Clearing these first is worth more than any renewal call.',
      count: failedPayments?.n ?? 0,
      actionLabel: 'Open billing',
      actionTo: '/billing?state=failed',
    });
  }

  const denials = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
        inArray(schema.checkIns.branchId, scope),
        sql`${schema.checkIns.decision} != 'granted'`,
        gte(schema.checkIns.enteredAt, now() - DAY),
      ),
    )
    .get();

  if ((denials?.n ?? 0) > 0) {
    alerts.push({
      id: 'access_denials',
      severity: 'warning',
      kind: 'access_denied',
      title: `${denials?.n} entry denial${denials?.n === 1 ? '' : 's'} in 24 hours`,
      detail: 'Someone was turned away at the door. Worth a look before they stop coming.',
      count: denials?.n ?? 0,
      actionLabel: 'Open floor',
      actionTo: '/floor?filter=denied',
    });
  }

  const slaBreaches = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.tenantId, ctx.tenantId),
        sql`${schema.tickets.state} in ('open','pending_staff')`,
        sql`${schema.tickets.slaDueAt} < ${now()}`,
      ),
    )
    .get();

  if ((slaBreaches?.n ?? 0) > 0) {
    alerts.push({
      id: 'sla_breach',
      severity: 'critical',
      kind: 'sla_breach',
      title: `${slaBreaches?.n} support ticket${slaBreaches?.n === 1 ? '' : 's'} past its SLA`,
      detail: 'These are members already unhappy enough to write in.',
      count: slaBreaches?.n ?? 0,
      actionLabel: 'Open support',
      actionTo: '/support',
    });
  }

  const equipmentDown = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.workOrders)
    .where(
      and(
        inArray(schema.workOrders.branchId, scope),
        sql`${schema.workOrders.state} in ('open','assigned','in_progress','blocked')`,
        eq(schema.workOrders.severity, 'safety'),
      ),
    )
    .get();

  if ((equipmentDown?.n ?? 0) > 0) {
    alerts.push({
      id: 'equipment_safety',
      severity: 'critical',
      kind: 'equipment_down',
      title: `${equipmentDown?.n} safety work order${equipmentDown?.n === 1 ? '' : 's'} open`,
      detail: 'Equipment flagged as a safety issue is still on the floor.',
      count: equipmentDown?.n ?? 0,
      actionLabel: 'Open equipment',
      actionTo: '/equipment?severity=safety',
    });
  }

  const atRisk = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        inArray(schema.members.homeBranchId, scope),
        sql`${schema.members.riskScore} >= 55`,
      ),
    )
    .get();

  if ((atRisk?.n ?? 0) > 0) {
    alerts.push({
      id: 'member_risk',
      severity: 'warning',
      kind: 'member_risk',
      title: `${atRisk?.n} member${atRisk?.n === 1 ? '' : 's'} at high risk of leaving`,
      detail: 'Each one comes with its reasons and a suggested next step. A call, not an automated message.',
      count: atRisk?.n ?? 0,
      actionLabel: 'Open members',
      actionTo: '/members?risk=high',
    });
  }

  const lowStock = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.retailProducts)
    .where(eq(schema.retailProducts.tenantId, ctx.tenantId))
    .all().length;

  /* — Live activity feed ————————————————————————————————————— */

  const recentCheckIns = db
    .select({
      id: schema.checkIns.id,
      enteredAt: schema.checkIns.enteredAt,
      decision: schema.checkIns.decision,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      memberNo: schema.members.memberNo,
      branchId: schema.checkIns.branchId,
    })
    .from(schema.checkIns)
    .leftJoin(schema.members, eq(schema.members.id, schema.checkIns.memberId))
    .where(inArray(schema.checkIns.branchId, scope))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(12)
    .all();

  /* — Today's classes ————————————————————————————————————————— */

  const upcoming = db
    .select({
      id: schema.classSessions.id,
      startsAt: schema.classSessions.startsAt,
      booked: schema.classSessions.booked,
      capacity: schema.classSessions.capacity,
      state: schema.classSessions.state,
      name: schema.classTypes.name,
      roomName: schema.rooms.name,
      trainerName: schema.users.name,
      branchId: schema.classSessions.branchId,
    })
    .from(schema.classSessions)
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
    .leftJoin(schema.rooms, eq(schema.rooms.id, schema.classSessions.roomId))
    .leftJoin(schema.staff, eq(schema.staff.id, schema.classSessions.trainerId))
    .leftJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(
      and(
        inArray(schema.classSessions.branchId, scope),
        gte(schema.classSessions.startsAt, now() - HOUR),
        lt(schema.classSessions.startsAt, todayStart + DAY),
      ),
    )
    .orderBy(schema.classSessions.startsAt)
    .limit(8)
    .all();

  return c.json({
    scope: {
      branchIds: scope,
      branchNames: branches.map((b) => b.name),
      allBranches: !ctx.activeBranchId,
    },
    asOf: new Date(now()).toISOString(),
    alerts,
    kpis,
    occupancy: {
      inside,
      capacity,
      label: occupancyLabel(inside, capacity),
      hourly,
      currentHour: Number(
        new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now()),
      ),
      byBranch: branches.map((b) => ({
        id: b.id,
        name: b.name,
        inside: insideRows.find((r) => r.branchId === b.id)?.n ?? 0,
        capacity: b.capacity,
      })),
      opensHour: Math.floor((branches[0]?.opensMinutes ?? 300) / 60),
      closesHour: Math.floor((branches[0]?.closesMinutes ?? 1380) / 60),
    },
    activity: recentCheckIns.map((r) => ({
      id: r.id,
      at: new Date(r.enteredAt).toISOString(),
      relativeTime: relativeTime(r.enteredAt),
      granted: r.decision === 'granted',
      decision: r.decision,
      memberName: r.firstName ? `${r.firstName} ${r.lastName}` : 'Unknown',
      memberNo: r.memberNo ?? '—',
      branchName: branches.find((b) => b.id === r.branchId)?.name ?? '',
    })),
    classes: upcoming.map((s) => ({
      id: s.id,
      name: s.name,
      localTime: new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(s.startsAt),
      roomName: s.roomName ?? '',
      trainerName: s.trainerName ?? 'Unassigned',
      booked: s.booked,
      capacity: s.capacity,
      fillPct: Math.round((s.booked / Math.max(1, s.capacity)) * 100),
      cancelled: s.state === 'cancelled',
      branchName: branches.find((b) => b.id === s.branchId)?.name ?? '',
    })),
    counts: { lowStockProducts: lowStock },
  });
});
