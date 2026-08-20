import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type {
  AttendanceReport,
  MembershipReport,
  MoneyByCurrency,
  ReportExport,
  ReportFreshness,
  ReportKind,
  ReportMeta,
  ReportPeriod,
  RetentionReport,
  RevenueReport,
  TrainerReport,
} from '@shark/contracts';
import {
  arpuMinor,
  cohortOf,
  compare,
  daysInPeriod,
  netMinor,
  previousPeriod,
  rateBp,
  toCsv,
} from '@shark/domain';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchTimeZone } from '../lib/branch-time.js';
import type { RequestContext } from '../lib/context.js';
import { requireBranch, requirePermission } from '../lib/context.js';
import { invalid } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { isoDate, localDayRange, localHour, now, startOfLocalDay } from '../lib/time.js';

/**
 * Reports and analytics (PF-RPT-001…006).
 *
 * Route files are thin adapters; every rule below lives here.
 *
 * Five decisions shape the module.
 *
 * **`report.view` and `report.financial` are separate permissions, and the
 * separation is the point.** A branch manager holds the first and not the
 * second: they open Reports, work the attendance, membership and trainer
 * figures, and see revenue as *absent*. Withheld money is `null` with its name
 * in `meta.restricted`, never a zero — a zero renders as a real number and
 * "revenue this month: ₹0" is something a person escalates.
 *
 * **No `branchId` means every branch the caller may see.** `activeBranchId` is
 * seeded at sign-in to the first permitted branch and only moves when a client
 * sends `x-branch-id`, so scoping an unfiltered read to it makes "all
 * branches" a lie. Support learned this in Phase 9; a report that quietly
 * covers one of three branches is the same bug with worse consequences,
 * because the number looks authoritative.
 *
 * **Every boundary is computed in the branch's timezone**, through
 * `branchTimeZone` and `startOfLocalDay`. A range is stated in dates and the
 * tables store epoch milliseconds, so somebody has to decide when a day
 * begins; doing it in the server's zone puts a 23:30 sale in Bengaluru into
 * the previous day's takings whenever the process runs in UTC.
 *
 * **Money is never summed across currencies.** A range spanning a currency
 * change has no single total, so `totals` is null and `byCurrency` carries
 * each one separately.
 *
 * **The daily series is cached in `metric_rollups`** (PF-RPT-006). Complete
 * days are computed once and stored; the current day is recomputed every time
 * because it is still moving. A figure served from the store says so, with the
 * instant it was computed.
 */

/* ——— Scope and periods ————————————————————————————————————— */

/**
 * Which branches a report covers.
 *
 * No `branchId` means every branch the caller may see — see the module note.
 * An explicit one is checked against the caller's own list, so a report cannot
 * be widened by asking for a branch the role does not hold.
 */
function scopeFor(ctx: RequestContext, branchId?: string | null): string[] {
  if (branchId) {
    requireBranch(ctx, branchId);
    return [branchId];
  }
  return ctx.branchIds;
}

export interface ReportRange {
  from: string;
  to: string;
  branchId?: string | null;
}

/** The zone a report's dates are computed in: the branch's, or the tenant's. */
function zoneFor(ctx: RequestContext, branchIds: string[]): string {
  return branchTimeZone(ctx.tenantId, branchIds.length === 1 ? branchIds[0]! : null);
}

function periodOf(from: string, to: string, label: string): ReportPeriod {
  return { from, to, days: daysInPeriod(from, to), label };
}

function validateRange(range: ReportRange): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) {
    throw invalid('A report range needs two calendar dates.');
  }
  if (range.to < range.from) throw invalid('A report range ends before it starts.');
  if (daysInPeriod(range.from, range.to) > 400) {
    throw invalid('A report covers at most 400 days. Narrow the range.');
  }
}

/**
 * Whether anything at all existed before this period.
 *
 * This is what turns a comparison into `null` rather than a fall from zero.
 * The tenant's earliest invoice, membership or check-in is the horizon: a
 * range that starts before it has no prior period to compare against, and
 * saying "down 100%" about a month the gym did not exist in is a fabrication
 * somebody will act on.
 */
function hasHistoryBefore(tenantId: string, branchIds: string[], beforeMs: number): boolean {
  if (branchIds.length === 0) return false;
  const earliest = db
    .select({ n: sql<number>`min(${schema.invoices.createdAt})` })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.tenantId, tenantId), inArray(schema.invoices.branchId, branchIds)))
    .get()?.n;
  const earliestVisit = db
    .select({ n: sql<number>`min(${schema.checkIns.enteredAt})` })
    .from(schema.checkIns)
    .where(and(eq(schema.checkIns.tenantId, tenantId), inArray(schema.checkIns.branchId, branchIds)))
    .get()?.n;
  const horizon = Math.min(earliest ?? Number.POSITIVE_INFINITY, earliestVisit ?? Number.POSITIVE_INFINITY);
  return Number.isFinite(horizon) && horizon < beforeMs;
}

function metaFor(
  ctx: RequestContext,
  range: ReportRange,
  branchIds: string[],
  timeZone: string,
  freshness: ReportFreshness,
  computedAtMs: number,
  restricted: string[],
): ReportMeta {
  const prior = previousPeriod(range.from, range.to);
  const comparable = hasHistoryBefore(ctx.tenantId, branchIds, startOfLocalDay(range.to, timeZone));
  const names = branchNames(ctx.tenantId);
  return {
    period: periodOf(range.from, range.to, `${range.from} to ${range.to}`),
    comparison: comparable ? periodOf(prior.from, prior.to, `${prior.from} to ${prior.to}`) : null,
    timeZone,
    branchIds,
    scopeNote:
      branchIds.length === 1
        ? `${names.get(branchIds[0]!) ?? 'This branch'} only.`
        : `All ${branchIds.length} branches you can see.`,
    freshness,
    computedAt: new Date(computedAtMs).toISOString(),
    restricted,
    canSeeFinancial: ctx.permissions.includes('report.financial'),
    canExport: ctx.permissions.includes('report.export'),
  };
}

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

/** Every local date in the range, inclusive. */
function daysBetweenInclusive(from: string, to: string): string[] {
  const out: string[] = [];
  let at = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (at <= end) {
    out.push(new Date(at).toISOString().slice(0, 10));
    at += 86_400_000;
  }
  return out;
}

/* ——— The rollup store (PF-RPT-006) ————————————————————————— */

/**
 * Daily aggregates, computed once per complete day and kept.
 *
 * The alternative is rescanning every invoice, check-in and booking on every
 * page view, which PF-RPT-006 exists to forbid. Only *complete* days are
 * stored: the current day is still moving, so it is recomputed on every read
 * and never written. That is also why a report says which of the two it is —
 * a figure from the store carries the instant it was computed, and a figure
 * that includes today does not pretend to be older than it is.
 */
const ROLLUP_METRICS = [
  'revenue_gross_minor',
  'revenue_refunded_minor',
  'revenue_invoices',
  'checkins',
  'no_shows',
  'joins',
  'cancellations',
] as const;
type RollupMetric = (typeof ROLLUP_METRICS)[number];

type DayMap = Map<string, number>;
const keyOf = (metric: string, branchId: string, day: string): string => `${metric}|${branchId}|${day}`;

/** Compute every rollup metric for a span, bucketed into local days. */
function computeDaily(tenantId: string, branchIds: string[], fromDay: string, toDay: string, tz: string): DayMap {
  const out: DayMap = new Map();
  if (branchIds.length === 0) return out;
  const { from, to } = localDayRange(fromDay, toDay, tz);
  const add = (metric: RollupMetric, branchId: string, day: string, value: number): void => {
    const k = keyOf(metric, branchId, day);
    out.set(k, (out.get(k) ?? 0) + value);
  };

  // Invoices carry the money. A voided invoice never counted, so it is
  // excluded rather than netted — voiding says it should not have been raised.
  const invoices = db
    .select({
      branchId: schema.invoices.branchId,
      createdAt: schema.invoices.createdAt,
      totalMinor: schema.invoices.totalMinor,
      refundedMinor: schema.invoices.refundedMinor,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.tenantId, tenantId),
        inArray(schema.invoices.branchId, branchIds),
        eq(schema.invoices.voided, false),
        gte(schema.invoices.createdAt, from),
        lt(schema.invoices.createdAt, to),
      ),
    )
    .all();
  for (const row of invoices) {
    const day = isoDate(row.createdAt, tz);
    add('revenue_gross_minor', row.branchId, day, row.totalMinor);
    add('revenue_refunded_minor', row.branchId, day, row.refundedMinor);
    add('revenue_invoices', row.branchId, day, 1);
  }

  const visits = db
    .select({ branchId: schema.checkIns.branchId, enteredAt: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        inArray(schema.checkIns.branchId, branchIds),
        eq(schema.checkIns.decision, 'granted'),
        gte(schema.checkIns.enteredAt, from),
        lt(schema.checkIns.enteredAt, to),
      ),
    )
    .all();
  for (const row of visits) add('checkins', row.branchId, isoDate(row.enteredAt, tz), 1);

  // A no-show is the state a booking is actually moved into when the class
  // runs without the member. Inferring it from a missing attendance stamp
  // instead swept up every confirmed seat on a session that had merely ended,
  // and cancelled seats are not no-shows either — the member told us.
  const noShows = db
    .select({ branchId: schema.classSessions.branchId, startsAt: schema.classSessions.startsAt })
    .from(schema.bookings)
    .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
    .where(
      and(
        eq(schema.bookings.tenantId, tenantId),
        inArray(schema.classSessions.branchId, branchIds),
        eq(schema.bookings.state, 'no_show'),
        gte(schema.classSessions.startsAt, from),
        lt(schema.classSessions.startsAt, to),
      ),
    )
    .all();
  for (const row of noShows) add('no_shows', row.branchId, isoDate(row.startsAt, tz), 1);

  // Memberships hang off the member's home branch — a membership is sold to a
  // person, not to a counter.
  const joins = db
    .select({ branchId: schema.members.homeBranchId, createdAt: schema.memberships.createdAt })
    .from(schema.memberships)
    .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
    .where(
      and(
        eq(schema.memberships.tenantId, tenantId),
        inArray(schema.members.homeBranchId, branchIds),
        gte(schema.memberships.createdAt, from),
        lt(schema.memberships.createdAt, to),
      ),
    )
    .all();
  for (const row of joins) add('joins', row.branchId, isoDate(row.createdAt, tz), 1);

  // A cancellation is a transition *into* the cancelled state, dated by when
  // it took effect rather than when somebody typed it.
  const cancellations = db
    .select({ branchId: schema.members.homeBranchId, at: schema.membershipEvents.effectiveAt })
    .from(schema.membershipEvents)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.membershipEvents.membershipId))
    .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
    .where(
      and(
        eq(schema.membershipEvents.tenantId, tenantId),
        inArray(schema.members.homeBranchId, branchIds),
        eq(schema.membershipEvents.toState, 'cancelled'),
        gte(schema.membershipEvents.effectiveAt, from),
        lt(schema.membershipEvents.effectiveAt, to),
      ),
    )
    .all();
  for (const row of cancellations) add('cancellations', row.branchId, isoDate(row.at, tz), 1);

  return out;
}

/**
 * The daily series for a range, from the store where possible.
 *
 * Returns the values plus how fresh they are: `batch` when every day came from
 * a stored rollup, `near_realtime` when the range includes today or anything
 * had to be computed on the way through.
 */
function dailySeries(
  tenantId: string,
  branchIds: string[],
  fromDay: string,
  toDay: string,
  tz: string,
): { values: DayMap; freshness: ReportFreshness; computedAt: number } {
  const today = isoDate(now(), tz);
  const days = daysBetweenInclusive(fromDay, toDay);
  const complete = days.filter((d) => d < today);
  const openDays = days.filter((d) => d >= today);

  const values: DayMap = new Map();
  let oldestComputedAt = now();
  let servedFromStore = complete.length > 0;

  if (complete.length > 0 && branchIds.length > 0) {
    const stored = db
      .select()
      .from(schema.metricRollups)
      .where(
        and(
          eq(schema.metricRollups.tenantId, tenantId),
          eq(schema.metricRollups.period, 'day'),
          inArray(schema.metricRollups.branchId, branchIds),
          inArray(schema.metricRollups.metric, [...ROLLUP_METRICS]),
          gte(schema.metricRollups.onDate, complete[0]!),
          sql`${schema.metricRollups.onDate} <= ${complete[complete.length - 1]!}`,
        ),
      )
      .all();

    const have = new Set<string>();
    for (const row of stored) {
      if (!row.branchId) continue;
      values.set(keyOf(row.metric, row.branchId, row.onDate), row.value);
      have.add(`${row.branchId}|${row.onDate}`);
      oldestComputedAt = Math.min(oldestComputedAt, row.computedAt);
    }

    // Any complete day with nothing stored for any branch has never been
    // rolled up. Compute the whole missing span once and keep it.
    const missing = complete.filter((day) => branchIds.some((b) => !have.has(`${b}|${day}`)));
    if (missing.length > 0) {
      servedFromStore = false;
      const computed = computeDaily(tenantId, branchIds, missing[0]!, missing[missing.length - 1]!, tz);
      const at = now();
      const rows: Array<typeof schema.metricRollups.$inferInsert> = [];
      for (const day of missing) {
        for (const branchId of branchIds) {
          if (have.has(`${branchId}|${day}`)) continue;
          for (const metric of ROLLUP_METRICS) {
            const value = computed.get(keyOf(metric, branchId, day)) ?? 0;
            values.set(keyOf(metric, branchId, day), value);
            rows.push({ id: id('rlp'), tenantId, branchId, metric, period: 'day', onDate: day, value, computedAt: at });
          }
        }
      }
      // A concurrent request may have written the same day; the unique index
      // is the arbiter and a duplicate is not an error worth failing a read on.
      for (const row of rows) {
        db.insert(schema.metricRollups).values(row).onConflictDoNothing().run();
      }
      oldestComputedAt = Math.min(oldestComputedAt, at);
    }
  }

  // Today is still moving, so it is never stored and never cached.
  if (openDays.length > 0) {
    const live = computeDaily(tenantId, branchIds, openDays[0]!, openDays[openDays.length - 1]!, tz);
    for (const [k, v] of live) values.set(k, v);
  }

  return {
    values,
    freshness: openDays.length > 0 ? 'near_realtime' : servedFromStore ? 'batch' : 'near_realtime',
    computedAt: openDays.length > 0 ? now() : oldestComputedAt,
  };
}

const sumMetric = (values: DayMap, metric: RollupMetric, branchIds: string[], days: string[]): number => {
  let total = 0;
  for (const day of days) for (const b of branchIds) total += values.get(keyOf(metric, b, day)) ?? 0;
  return total;
};

/* ——— Revenue ————————————————————————————————————————————— */

export function revenueReport(ctx: RequestContext, range: ReportRange): RevenueReport {
  requirePermission(ctx, 'report.view');
  validateRange(range);
  const branchIds = scopeFor(ctx, range.branchId);
  const tz = zoneFor(ctx, branchIds);
  const canSeeMoney = ctx.permissions.includes('report.financial');

  const series = dailySeries(ctx.tenantId, branchIds, range.from, range.to, tz);
  const days = daysBetweenInclusive(range.from, range.to);

  const restricted: string[] = [];
  if (!canSeeMoney) {
    restricted.push('totals', 'byCurrency', 'byProduct', 'byMethod', 'series.money');
  }

  const meta = metaFor(ctx, range, branchIds, tz, series.freshness, series.computedAt, restricted);

  // Revenue is money end to end. Without `report.financial` the shape is
  // returned with every figure absent rather than zeroed, and the console
  // renders a permission state over it.
  if (!canSeeMoney) {
    return {
      meta,
      totals: null,
      byCurrency: [],
      mixedCurrency: false,
      seriesCurrency: null,
      series: [],
      byBranch: [],
      byProduct: [],
      byMethod: [],
    };
  }

  const byCurrency = revenueByCurrency(ctx.tenantId, branchIds, range.from, range.to, tz);
  const mixedCurrency = byCurrency.length > 1;
  const seriesCurrency = byCurrency.length > 0
    ? [...byCurrency].sort((a, b) => b.invoices - a.invoices)[0]!.currency
    : null;

  const gross = sumMetric(series.values, 'revenue_gross_minor', branchIds, days);
  const refunded = sumMetric(series.values, 'revenue_refunded_minor', branchIds, days);
  const invoices = sumMetric(series.values, 'revenue_invoices', branchIds, days);

  // The comparison window, only when there is history behind it.
  let priorGross: number | null = null;
  let priorNet: number | null = null;
  let priorInvoices: number | null = null;
  if (meta.comparison) {
    const prior = dailySeries(ctx.tenantId, branchIds, meta.comparison.from, meta.comparison.to, tz);
    const priorDays = daysBetweenInclusive(meta.comparison.from, meta.comparison.to);
    priorGross = sumMetric(prior.values, 'revenue_gross_minor', branchIds, priorDays);
    priorInvoices = sumMetric(prior.values, 'revenue_invoices', branchIds, priorDays);
    priorNet = netMinor(priorGross, sumMetric(prior.values, 'revenue_refunded_minor', branchIds, priorDays));
  }

  if (mixedCurrency) restricted.push('totals:mixed-currency');

  const payingMembers = distinctPayers(ctx.tenantId, branchIds, range.from, range.to, tz);
  const totalsBlock = mixedCurrency
    ? null
    : {
        grossMinor: compare(gross, priorGross),
        netMinor: compare(netMinor(gross, refunded), priorNet),
        refundedMinor: refunded,
        discountMinor: byCurrency[0]?.discountMinor ?? 0,
        taxMinor: byCurrency[0]?.taxMinor ?? 0,
        invoices: compare(invoices, priorInvoices),
        arpuMinor: arpuMinor(netMinor(gross, refunded), payingMembers),
      };

  return {
    meta: { ...meta, restricted },
    totals: totalsBlock,
    byCurrency,
    mixedCurrency,
    seriesCurrency,
    series: days.map((date) => {
      const g = sumMetric(series.values, 'revenue_gross_minor', branchIds, [date]);
      const r = sumMetric(series.values, 'revenue_refunded_minor', branchIds, [date]);
      return {
        date,
        grossMinor: g,
        netMinor: netMinor(g, r),
        refundedMinor: r,
        invoices: sumMetric(series.values, 'revenue_invoices', branchIds, [date]),
      };
    }),
    byBranch: branchIds
      .map((branchId) => ({
        branchId,
        branchName: branchNames(ctx.tenantId).get(branchId) ?? branchId,
        netMinor: netMinor(
          sumMetric(series.values, 'revenue_gross_minor', [branchId], days),
          sumMetric(series.values, 'revenue_refunded_minor', [branchId], days),
        ),
        invoices: sumMetric(series.values, 'revenue_invoices', [branchId], days),
      }))
      .sort((a, b) => b.netMinor - a.netMinor),
    byProduct: revenueByProduct(ctx.tenantId, branchIds, range.from, range.to, tz),
    byMethod: revenueByMethod(ctx.tenantId, branchIds, range.from, range.to, tz),
  };
}

function revenueByCurrency(
  tenantId: string,
  branchIds: string[],
  fromDay: string,
  toDay: string,
  tz: string,
): MoneyByCurrency[] {
  if (branchIds.length === 0) return [];
  const { from, to } = localDayRange(fromDay, toDay, tz);
  return db
    .select({
      currency: schema.invoices.currency,
      grossMinor: sql<number>`sum(${schema.invoices.totalMinor})`,
      refundedMinor: sql<number>`sum(${schema.invoices.refundedMinor})`,
      discountMinor: sql<number>`sum(${schema.invoices.discountMinor})`,
      taxMinor: sql<number>`sum(${schema.invoices.taxMinor})`,
      invoices: sql<number>`count(*)`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.tenantId, tenantId),
        inArray(schema.invoices.branchId, branchIds),
        eq(schema.invoices.voided, false),
        gte(schema.invoices.createdAt, from),
        lt(schema.invoices.createdAt, to),
      ),
    )
    .groupBy(schema.invoices.currency)
    .all()
    .map((row) => ({
      currency: row.currency,
      grossMinor: row.grossMinor ?? 0,
      netMinor: netMinor(row.grossMinor ?? 0, row.refundedMinor ?? 0),
      refundedMinor: row.refundedMinor ?? 0,
      discountMinor: row.discountMinor ?? 0,
      taxMinor: row.taxMinor ?? 0,
      invoices: row.invoices ?? 0,
    }));
}

function revenueByProduct(
  tenantId: string,
  branchIds: string[],
  fromDay: string,
  toDay: string,
  tz: string,
): RevenueReport['byProduct'] {
  if (branchIds.length === 0) return [];
  const { from, to } = localDayRange(fromDay, toDay, tz);
  return db
    .select({
      productName: schema.invoiceLines.description,
      netMinor: sql<number>`sum(${schema.invoiceLines.totalMinor})`,
      count: sql<number>`count(*)`,
    })
    .from(schema.invoiceLines)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.invoiceLines.invoiceId))
    .where(
      and(
        eq(schema.invoices.tenantId, tenantId),
        inArray(schema.invoices.branchId, branchIds),
        eq(schema.invoices.voided, false),
        gte(schema.invoices.createdAt, from),
        lt(schema.invoices.createdAt, to),
      ),
    )
    .groupBy(schema.invoiceLines.description)
    .all()
    .map((row) => ({ productId: null, productName: row.productName, netMinor: row.netMinor ?? 0, count: row.count ?? 0 }))
    .sort((a, b) => b.netMinor - a.netMinor)
    .slice(0, 20);
}

function revenueByMethod(
  tenantId: string,
  branchIds: string[],
  fromDay: string,
  toDay: string,
  tz: string,
): RevenueReport['byMethod'] {
  if (branchIds.length === 0) return [];
  const { from, to } = localDayRange(fromDay, toDay, tz);
  return db
    .select({
      method: schema.payments.method,
      amountMinor: sql<number>`sum(${schema.payments.amountMinor})`,
      payments: sql<number>`count(*)`,
    })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.tenantId, tenantId),
        eq(schema.payments.state, 'succeeded'),
        inArray(schema.payments.branchId, branchIds),
        gte(schema.payments.createdAt, from),
        lt(schema.payments.createdAt, to),
      ),
    )
    .groupBy(schema.payments.method)
    .all()
    .map((row) => ({ method: row.method, amountMinor: row.amountMinor ?? 0, payments: row.payments ?? 0 }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

function distinctPayers(tenantId: string, branchIds: string[], fromDay: string, toDay: string, tz: string): number {
  if (branchIds.length === 0) return 0;
  const { from, to } = localDayRange(fromDay, toDay, tz);
  return (
    db
      .select({ n: sql<number>`count(distinct ${schema.invoices.memberId})` })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.tenantId, tenantId),
          inArray(schema.invoices.branchId, branchIds),
          eq(schema.invoices.voided, false),
          gte(schema.invoices.createdAt, from),
          lt(schema.invoices.createdAt, to),
        ),
      )
      .get()?.n ?? 0
  );
}

/* ——— Membership ————————————————————————————————————————— */

export function membershipReport(ctx: RequestContext, range: ReportRange): MembershipReport {
  requirePermission(ctx, 'report.view');
  validateRange(range);
  const branchIds = scopeFor(ctx, range.branchId);
  const tz = zoneFor(ctx, branchIds);
  const canSeeMoney = ctx.permissions.includes('report.financial');

  const series = dailySeries(ctx.tenantId, branchIds, range.from, range.to, tz);
  const days = daysBetweenInclusive(range.from, range.to);

  const joins = sumMetric(series.values, 'joins', branchIds, days);
  const cancellations = sumMetric(series.values, 'cancellations', branchIds, days);

  let priorJoins: number | null = null;
  let priorCancellations: number | null = null;
  const restricted = canSeeMoney ? [] : ['ltvMinor'];
  const meta = metaFor(ctx, range, branchIds, tz, series.freshness, series.computedAt, restricted);

  if (meta.comparison) {
    const prior = dailySeries(ctx.tenantId, branchIds, meta.comparison.from, meta.comparison.to, tz);
    const priorDays = daysBetweenInclusive(meta.comparison.from, meta.comparison.to);
    priorJoins = sumMetric(prior.values, 'joins', branchIds, priorDays);
    priorCancellations = sumMetric(prior.values, 'cancellations', branchIds, priorDays);
  }

  const { from, to } = localDayRange(range.from, range.to, tz);
  const counted = (predicate: ReturnType<typeof and>): number =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.membershipEvents)
      .innerJoin(schema.memberships, eq(schema.memberships.id, schema.membershipEvents.membershipId))
      .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
      .where(predicate)
      .get()?.n ?? 0;

  const inScope = branchIds.length > 0;
  const freezes = inScope
    ? counted(
        and(
          eq(schema.membershipEvents.tenantId, ctx.tenantId),
          inArray(schema.members.homeBranchId, branchIds),
          eq(schema.membershipEvents.toState, 'frozen'),
          gte(schema.membershipEvents.effectiveAt, from),
          lt(schema.membershipEvents.effectiveAt, to),
        ),
      )
    : 0;
  const renewals = inScope
    ? db
        .select({ n: sql<number>`count(*)` })
        .from(schema.memberships)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
        .where(
          and(
            eq(schema.memberships.tenantId, ctx.tenantId),
            inArray(schema.members.homeBranchId, branchIds),
            isNotNull(schema.memberships.previousMembershipId),
            gte(schema.memberships.createdAt, from),
            lt(schema.memberships.createdAt, to),
          ),
        )
        .get()?.n ?? 0
    : 0;

  const activeAtEnd = inScope
    ? db
        .select({ n: sql<number>`count(*)` })
        .from(schema.memberships)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
        .where(
          and(
            eq(schema.memberships.tenantId, ctx.tenantId),
            inArray(schema.members.homeBranchId, branchIds),
            eq(schema.memberships.state, 'active'),
          ),
        )
        .get()?.n ?? 0
    : 0;

  // Churn is cancellations over the base that could have churned — the active
  // count plus the ones that left. Dividing by the survivors alone flatters it.
  const churnBase = activeAtEnd + cancellations;

  // Lifetime value is money, so it is withheld rather than zeroed for a role
  // without `report.financial`.
  const ltvMinor = canSeeMoney && inScope
    ? db
        .select({ n: sql<number>`coalesce(avg(${schema.memberships.priceMinor}), 0)` })
        .from(schema.memberships)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
        .where(and(eq(schema.memberships.tenantId, ctx.tenantId), inArray(schema.members.homeBranchId, branchIds)))
        .get()?.n ?? 0
    : null;

  return {
    meta,
    joins: compare(joins, priorJoins),
    cancellations: compare(cancellations, priorCancellations),
    freezes: compare(freezes, null),
    renewals: compare(renewals, null),
    activeAtEnd,
    churnBp: rateBp(cancellations, churnBase),
    netChange: joins - cancellations,
    ltvMinor: ltvMinor === null ? null : Math.round(ltvMinor),
    series: days.map((date) => ({
      date,
      joins: sumMetric(series.values, 'joins', branchIds, [date]),
      cancellations: sumMetric(series.values, 'cancellations', branchIds, [date]),
    })),
    byProduct: membershipByProduct(ctx.tenantId, branchIds, from, to),
  };
}

function membershipByProduct(
  tenantId: string,
  branchIds: string[],
  from: number,
  to: number,
): MembershipReport['byProduct'] {
  if (branchIds.length === 0) return [];
  return db
    .select({
      productId: schema.memberships.productId,
      productName: schema.memberships.productName,
      joins: sql<number>`sum(case when ${schema.memberships.createdAt} >= ${from} and ${schema.memberships.createdAt} < ${to} then 1 else 0 end)`,
      cancellations: sql<number>`sum(case when ${schema.memberships.state} = 'cancelled' then 1 else 0 end)`,
      activeAtEnd: sql<number>`sum(case when ${schema.memberships.state} = 'active' then 1 else 0 end)`,
    })
    .from(schema.memberships)
    .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
    .where(and(eq(schema.memberships.tenantId, tenantId), inArray(schema.members.homeBranchId, branchIds)))
    .groupBy(schema.memberships.productId, schema.memberships.productName)
    .all()
    .map((r) => ({
      productId: r.productId,
      productName: r.productName,
      joins: r.joins ?? 0,
      cancellations: r.cancellations ?? 0,
      activeAtEnd: r.activeAtEnd ?? 0,
    }))
    .sort((a, b) => b.activeAtEnd - a.activeAtEnd);
}

/* ——— Attendance ————————————————————————————————————————— */

export function attendanceReport(ctx: RequestContext, range: ReportRange): AttendanceReport {
  requirePermission(ctx, 'report.view');
  validateRange(range);
  const branchIds = scopeFor(ctx, range.branchId);
  const tz = zoneFor(ctx, branchIds);

  const series = dailySeries(ctx.tenantId, branchIds, range.from, range.to, tz);
  const days = daysBetweenInclusive(range.from, range.to);
  const { from, to } = localDayRange(range.from, range.to, tz);

  const visits = sumMetric(series.values, 'checkins', branchIds, days);
  const noShows = sumMetric(series.values, 'no_shows', branchIds, days);

  const meta = metaFor(ctx, range, branchIds, tz, series.freshness, series.computedAt, []);

  let priorVisits: number | null = null;
  let priorNoShows: number | null = null;
  let priorUnique: number | null = null;
  if (meta.comparison) {
    const prior = dailySeries(ctx.tenantId, branchIds, meta.comparison.from, meta.comparison.to, tz);
    const priorDays = daysBetweenInclusive(meta.comparison.from, meta.comparison.to);
    priorVisits = sumMetric(prior.values, 'checkins', branchIds, priorDays);
    priorNoShows = sumMetric(prior.values, 'no_shows', branchIds, priorDays);
    const pr = localDayRange(meta.comparison.from, meta.comparison.to, tz);
    priorUnique = uniqueVisitors(ctx.tenantId, branchIds, pr.from, pr.to);
  }

  const inScope = branchIds.length > 0;
  const uniqueMembers = inScope ? uniqueVisitors(ctx.tenantId, branchIds, from, to) : 0;

  // Occupancy across every session that ran in range: seats taken over seats
  // offered. Sessions with no capacity recorded cannot contribute a rate.
  const sessions = inScope
    ? db
        .select({
          branchId: schema.classSessions.branchId,
          booked: sql<number>`sum(${schema.classSessions.booked})`,
          capacity: sql<number>`sum(${schema.classSessions.capacity})`,
        })
        .from(schema.classSessions)
        .where(
          and(
            eq(schema.classSessions.tenantId, ctx.tenantId),
            inArray(schema.classSessions.branchId, branchIds),
            gte(schema.classSessions.startsAt, from),
            lt(schema.classSessions.startsAt, to),
          ),
        )
        .groupBy(schema.classSessions.branchId)
        .all()
    : [];
  const totalBooked = sessions.reduce((n, s) => n + (s.booked ?? 0), 0);
  const totalCapacity = sessions.reduce((n, s) => n + (s.capacity ?? 0), 0);

  // Peak hours, in the reporting zone rather than the server's — the whole
  // point of the figure is which hour of the local day is busiest.
  const hours = new Map<number, number>();
  if (inScope) {
    for (const row of db
      .select({ enteredAt: schema.checkIns.enteredAt })
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.tenantId, ctx.tenantId),
          inArray(schema.checkIns.branchId, branchIds),
          eq(schema.checkIns.decision, 'granted'),
          gte(schema.checkIns.enteredAt, from),
          lt(schema.checkIns.enteredAt, to),
        ),
      )
      .all()) {
      const hour = localHour(row.enteredAt, tz);
      hours.set(hour, (hours.get(hour) ?? 0) + 1);
    }
  }

  const names = branchNames(ctx.tenantId);
  const bookedByBranch = new Map(sessions.map((s) => [s.branchId, s]));

  return {
    meta,
    visits: compare(visits, priorVisits),
    uniqueMembers: compare(uniqueMembers, priorUnique),
    noShows: compare(noShows, priorNoShows),
    noShowRateBp: rateBp(noShows, totalBooked),
    occupancyBp: rateBp(totalBooked, totalCapacity),
    series: days.map((date) => ({
      date,
      visits: sumMetric(series.values, 'checkins', branchIds, [date]),
      noShows: sumMetric(series.values, 'no_shows', branchIds, [date]),
    })),
    byHour: Array.from({ length: 24 }, (_unused, hour) => ({ hour, visits: hours.get(hour) ?? 0 })),
    byBranch: branchIds
      .map((branchId) => {
        const s = bookedByBranch.get(branchId);
        return {
          branchId,
          branchName: names.get(branchId) ?? branchId,
          visits: sumMetric(series.values, 'checkins', [branchId], days),
          occupancyBp: rateBp(s?.booked ?? 0, s?.capacity ?? 0),
        };
      })
      .sort((a, b) => b.visits - a.visits),
  };
}

function uniqueVisitors(tenantId: string, branchIds: string[], from: number, to: number): number {
  if (branchIds.length === 0) return 0;
  return (
    db
      .select({ n: sql<number>`count(distinct ${schema.checkIns.memberId})` })
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.tenantId, tenantId),
          inArray(schema.checkIns.branchId, branchIds),
          eq(schema.checkIns.decision, 'granted'),
          isNotNull(schema.checkIns.memberId),
          gte(schema.checkIns.enteredAt, from),
          lt(schema.checkIns.enteredAt, to),
        ),
      )
      .get()?.n ?? 0
  );
}

/* ——— Trainer ————————————————————————————————————————————— */

export function trainerReport(ctx: RequestContext, range: ReportRange): TrainerReport {
  requirePermission(ctx, 'report.view');
  validateRange(range);
  const branchIds = scopeFor(ctx, range.branchId);
  const tz = zoneFor(ctx, branchIds);
  const { from, to } = localDayRange(range.from, range.to, tz);
  const at = now();

  const meta = metaFor(ctx, range, branchIds, tz, 'near_realtime', at, []);
  if (branchIds.length === 0) return { meta, rows: [] };

  const sessions = db
    .select({
      trainerId: schema.classSessions.trainerId,
      sessionsLed: sql<number>`count(*)`,
      seatsBooked: sql<number>`sum(${schema.classSessions.booked})`,
      seatsCapacity: sql<number>`sum(${schema.classSessions.capacity})`,
    })
    .from(schema.classSessions)
    .where(
      and(
        eq(schema.classSessions.tenantId, ctx.tenantId),
        inArray(schema.classSessions.branchId, branchIds),
        isNotNull(schema.classSessions.trainerId),
        gte(schema.classSessions.startsAt, from),
        lt(schema.classSessions.startsAt, to),
      ),
    )
    .groupBy(schema.classSessions.trainerId)
    .all();

  const attendance = db
    .select({
      trainerId: schema.classSessions.trainerId,
      attended: sql<number>`sum(case when ${schema.bookings.state} = 'attended' then 1 else 0 end)`,
      noShows: sql<number>`sum(case when ${schema.bookings.state} = 'no_show' then 1 else 0 end)`,
    })
    .from(schema.bookings)
    .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
    .where(
      and(
        eq(schema.bookings.tenantId, ctx.tenantId),
        inArray(schema.classSessions.branchId, branchIds),
        isNotNull(schema.classSessions.trainerId),
        gte(schema.classSessions.startsAt, from),
        lt(schema.classSessions.startsAt, to),
      ),
    )
    .groupBy(schema.classSessions.trainerId)
    .all();
  const attendanceBy = new Map(attendance.map((a) => [a.trainerId, a]));

  // Retention by coach: of the members assigned to them, how many are still
  // active. A coach with two members and both still here is 100% on a base of
  // two, which is why the base travels alongside the rate.
  const coached = db
    .select({
      trainerId: schema.members.trainerId,
      membersCoached: sql<number>`count(*)`,
      stillActive: sql<number>`sum(case when ${schema.members.lifecycle} = 'active' then 1 else 0 end)`,
    })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        inArray(schema.members.homeBranchId, branchIds),
        isNotNull(schema.members.trainerId),
      ),
    )
    .groupBy(schema.members.trainerId)
    .all();
  const coachedBy = new Map(coached.map((c) => [c.trainerId, c]));

  const staffNames = new Map(
    db
      .select({ id: schema.staff.id, name: schema.users.name })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(eq(schema.staff.tenantId, ctx.tenantId))
      .all()
      .map((s) => [s.id, s.name]),
  );

  const trainerIds = new Set<string>();
  for (const s of sessions) if (s.trainerId) trainerIds.add(s.trainerId);
  for (const c of coached) if (c.trainerId) trainerIds.add(c.trainerId);

  const rows = [...trainerIds].map((trainerId) => {
    const s = sessions.find((row) => row.trainerId === trainerId);
    const a = attendanceBy.get(trainerId);
    const c = coachedBy.get(trainerId);
    return {
      trainerId,
      trainerName: staffNames.get(trainerId) ?? 'Unknown',
      sessionsLed: s?.sessionsLed ?? 0,
      seatsBooked: s?.seatsBooked ?? 0,
      seatsCapacity: s?.seatsCapacity ?? 0,
      utilisationBp: rateBp(s?.seatsBooked ?? 0, s?.seatsCapacity ?? 0),
      attended: a?.attended ?? 0,
      noShows: a?.noShows ?? 0,
      membersCoached: c?.membersCoached ?? 0,
      retentionBp: rateBp(c?.stillActive ?? 0, c?.membersCoached ?? 0),
    };
  });

  return { meta, rows: rows.sort((x, y) => y.sessionsLed - x.sessionsLed) };
}

/* ——— Retention ————————————————————————————————————————— */

export function retentionReport(ctx: RequestContext, range: ReportRange): RetentionReport {
  requirePermission(ctx, 'report.view');
  validateRange(range);
  const branchIds = scopeFor(ctx, range.branchId);
  const tz = zoneFor(ctx, branchIds);
  const canSeeMoney = ctx.permissions.includes('report.financial');
  const at = now();

  const meta = metaFor(ctx, range, branchIds, tz, 'near_realtime', at, canSeeMoney ? [] : ['atRiskValueMinor']);
  if (branchIds.length === 0) {
    return { meta, bands: { high: 0, watch: 0, low: 0 }, cohorts: [], atRiskValueMinor: null };
  }

  const members = db
    .select({
      id: schema.members.id,
      joinedOn: schema.members.joinedOn,
      lifecycle: schema.members.lifecycle,
      riskScore: schema.members.riskScore,
    })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        inArray(schema.members.homeBranchId, branchIds),
        sql`${schema.members.deletedAt} is null`,
      ),
    )
    .all();

  // Bands match the thresholds the member directory and Support already use,
  // so the same member is not "high risk" on one screen and "watch" on another.
  const bands = { high: 0, watch: 0, low: 0 };
  for (const m of members) {
    // A member who has never been scored is not low risk — but the band chart
    // counts people, so an unscored member sits in the lowest band rather than
    // vanishing from a total the console prints as the branch's headcount.
    const score = m.riskScore ?? 0;
    if (score >= 55) bands.high += 1;
    else if (score >= 28) bands.watch += 1;
    else bands.low += 1;
  }

  const byCohort = new Map<string, { joined: number; stillActive: number }>();
  for (const m of members) {
    const key = cohortOf(m.joinedOn);
    const held = byCohort.get(key) ?? { joined: 0, stillActive: 0 };
    held.joined += 1;
    if (m.lifecycle === 'active') held.stillActive += 1;
    byCohort.set(key, held);
  }

  const atRiskValueMinor = canSeeMoney
    ? db
        .select({ n: sql<number>`coalesce(sum(${schema.memberships.priceMinor}), 0)` })
        .from(schema.memberships)
        .innerJoin(schema.members, eq(schema.members.id, schema.memberships.memberId))
        .where(
          and(
            eq(schema.memberships.tenantId, ctx.tenantId),
            inArray(schema.members.homeBranchId, branchIds),
            eq(schema.memberships.state, 'active'),
            sql`${schema.members.riskScore} >= 55`,
          ),
        )
        .get()?.n ?? 0
    : null;

  return {
    meta,
    bands,
    cohorts: [...byCohort.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cohort, v]) => ({
        cohort,
        joined: v.joined,
        stillActive: v.stillActive,
        retainedBp: rateBp(v.stillActive, v.joined),
      })),
    atRiskValueMinor,
  };
}

/* ——— Export (PF-RPT-003, PF-RPT-005) ————————————————————— */

export interface ExportInput extends ReportRange {
  kind: ReportKind;
}

/**
 * A report as CSV.
 *
 * Three rules, each of which is the difference between an export and a leak.
 *
 * **`report.export` is required, and it is a separate permission.** Reading a
 * figure on a screen and walking out with the whole set in a file are
 * different acts; a role may hold the first without the second.
 *
 * **The file is the complete filtered set, not the page on screen.** A user
 * exporting after scrolling one page of results expects the export to match
 * the filters, not the scroll position — an export that silently stops at 50
 * rows is worse than no export, because the recipient cannot see what is
 * missing.
 *
 * **Every export is audited with the filters that produced it.** PF-RPT-005
 * asks for exports of personal or financial data to be logged; the filter set
 * is what makes that log answerable later, because "somebody exported revenue"
 * without the range or the branches does not tell you what left the building.
 *
 * Withheld financial columns stay empty rather than zeroed, exactly as they do
 * on the wire — a zero in a spreadsheet is a number somebody will total.
 */
export function exportReport(ctx: RequestContext, input: ExportInput): ReportExport {
  requirePermission(ctx, 'report.view');
  requirePermission(ctx, 'report.export');
  validateRange(input);

  const range: ReportRange = { from: input.from, to: input.to, branchId: input.branchId };
  const built = buildExport(ctx, input.kind, range);

  // Audited *before* the body is handed back, and with the filter set, so the
  // log answers "what left the building" rather than merely "something did".
  audit(ctx, {
    action: 'report.export',
    entityType: 'report',
    entityId: input.kind,
    branchId: range.branchId ?? null,
    after: {
      kind: input.kind,
      from: range.from,
      to: range.to,
      branchIds: built.branchIds,
      rows: built.rows.length,
      includedFinancial: ctx.permissions.includes('report.financial'),
    },
  });

  return {
    filename: `shark-${input.kind}-${range.from}-to-${range.to}.csv`,
    contentType: 'text/csv',
    rows: built.rows.length,
    csv: toCsv(built.headers, built.rows),
  };
}

function buildExport(
  ctx: RequestContext,
  kind: ReportKind,
  range: ReportRange,
): { headers: string[]; rows: Array<Array<unknown>>; branchIds: string[] } {
  if (kind === 'revenue') {
    const report = revenueReport(ctx, range);
    // Every day in range, not a page of them. `series` is already the whole
    // period because the rollup covers it day by day.
    return {
      branchIds: report.meta.branchIds,
      headers: ['date', 'invoices', 'gross_minor', 'refunded_minor', 'net_minor', 'currency'],
      rows: report.series.map((p) => [
        p.date,
        p.invoices,
        report.totals || report.byCurrency.length > 0 ? p.grossMinor : null,
        report.totals || report.byCurrency.length > 0 ? p.refundedMinor : null,
        report.totals || report.byCurrency.length > 0 ? p.netMinor : null,
        report.seriesCurrency,
      ]),
    };
  }

  if (kind === 'membership') {
    const report = membershipReport(ctx, range);
    return {
      branchIds: report.meta.branchIds,
      headers: ['date', 'joins', 'cancellations'],
      rows: report.series.map((p) => [p.date, p.joins, p.cancellations]),
    };
  }

  if (kind === 'attendance') {
    const report = attendanceReport(ctx, range);
    return {
      branchIds: report.meta.branchIds,
      headers: ['date', 'visits', 'no_shows'],
      rows: report.series.map((p) => [p.date, p.visits, p.noShows]),
    };
  }

  if (kind === 'trainer') {
    const report = trainerReport(ctx, range);
    return {
      branchIds: report.meta.branchIds,
      headers: [
        'trainer',
        'sessions_led',
        'seats_booked',
        'seats_capacity',
        'utilisation_bp',
        'attended',
        'no_shows',
        'members_coached',
        'retention_bp',
      ],
      rows: report.rows.map((r) => [
        r.trainerName,
        r.sessionsLed,
        r.seatsBooked,
        r.seatsCapacity,
        r.utilisationBp,
        r.attended,
        r.noShows,
        r.membersCoached,
        r.retentionBp,
      ]),
    };
  }

  const report = retentionReport(ctx, range);
  return {
    branchIds: report.meta.branchIds,
    headers: ['cohort', 'joined', 'still_active', 'retained_bp'],
    rows: report.cohorts.map((c) => [c.cohort, c.joined, c.stillActive, c.retainedBp]),
  };
}

/** Names for the branch ids a report covers, for the console's scope note. */
export function reportBranches(ctx: RequestContext): Array<{ id: string; name: string }> {
  requirePermission(ctx, 'report.view');
  const names = branchNames(ctx.tenantId);
  return ctx.branchIds.map((branchId) => ({ id: branchId, name: names.get(branchId) ?? branchId }));
}

/* ——— Keeping the store warm ——————————————————————————————— */

/**
 * Compute and store rollups for recently completed days.
 *
 * Called by the nightly job and by the seed. Reports also materialise days on
 * demand, so this is not what makes them correct — it is what stops the first
 * person to open Reports on a Monday morning paying for a whole quarter's
 * scan. Only complete days are written; today is always recomputed live.
 *
 * Idempotent by the unique index on (tenant, branch, metric, period, date), so
 * running it twice is the same as running it once.
 */
export function rollUpCompletedDays(tenantId: string, lookbackDays = 3): number {
  const branches = db
    .select({ id: schema.branches.id })
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, tenantId))
    .all();
  if (branches.length === 0) return 0;

  let written = 0;
  const at = now();

  for (const branch of branches) {
    const tz = branchTimeZone(tenantId, branch.id);
    const today = isoDate(at, tz);
    const days: string[] = [];
    for (let back = 1; back <= lookbackDays; back += 1) {
      days.push(new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10));
    }
    days.sort();

    const computed = computeDaily(tenantId, [branch.id], days[0]!, days[days.length - 1]!, tz);
    for (const day of days) {
      for (const metric of ROLLUP_METRICS) {
        const value = computed.get(keyOf(metric, branch.id, day)) ?? 0;
        const existing = db
          .select({ id: schema.metricRollups.id })
          .from(schema.metricRollups)
          .where(
            and(
              eq(schema.metricRollups.tenantId, tenantId),
              eq(schema.metricRollups.branchId, branch.id),
              eq(schema.metricRollups.metric, metric),
              eq(schema.metricRollups.period, 'day'),
              eq(schema.metricRollups.onDate, day),
            ),
          )
          .get();
        if (existing) {
          // A day can still gain a late refund or a corrected booking, so a
          // stored day is refreshed rather than left as first computed.
          db.update(schema.metricRollups)
            .set({ value, computedAt: at })
            .where(eq(schema.metricRollups.id, existing.id))
            .run();
        } else {
          db.insert(schema.metricRollups)
            .values({ id: id('rlp'), tenantId, branchId: branch.id, metric, period: 'day', onDate: day, value, computedAt: at })
            .run();
        }
        written += 1;
      }
    }
  }
  return written;
}

/** Backfill a span, for the seed. Complete days only. */
export function backfillRollups(tenantId: string, days: number): number {
  return rollUpCompletedDays(tenantId, days);
}
