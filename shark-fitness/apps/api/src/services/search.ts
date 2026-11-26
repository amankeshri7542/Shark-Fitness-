import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { formatMoney } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { branchScope, type RequestContext } from '../lib/context.js';
import { invalid } from '../lib/errors.js';
import { DAY, now } from '../lib/time.js';

/**
 * Console search for the command palette (P07; PRD 01 §4.2, Design PRD
 * "Global search").
 *
 * One query, five kinds of thing, each behind the permission that already
 * guards its own screen and each limited to the caller's branches; a trainer
 * finds only the members assigned to them. A result is a label, a line of
 * context and the console path it opens — nothing a screen would not show.
 */

export const SEARCH_TYPES = ['member', 'lead', 'invoice', 'class', 'staff'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string;
  to: string;
  /** Extra ids an action needs (an invoice's member, a class's branch). */
  meta?: Record<string, string>;
}

const PER_TYPE = 6;

/** A LIKE pattern for user text, with its wildcards escaped. */
function like(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function can(ctx: RequestContext, permission: string): boolean {
  return (ctx.permissions as string[]).includes(permission);
}

export function consoleSearch(ctx: RequestContext, rawQuery: string, types: SearchType[] = [...SEARCH_TYPES], options: { outstandingOnly?: boolean } = {}) {
  const q = rawQuery.trim();
  if (q.length < 2) throw invalid('Type at least two characters.');
  const pattern = like(q);
  const scope = branchScope(ctx);
  const branchNames = new Map(
    db.select({ id: schema.branches.id, name: schema.branches.name }).from(schema.branches).where(eq(schema.branches.tenantId, ctx.tenantId)).all().map((b) => [b.id, b.name] as const),
  );
  const results: SearchResult[] = [];
  const digits = q.replace(/\D/g, '');

  if (types.includes('member') && can(ctx, 'member.view')) {
    const rows = db
      .select()
      .from(schema.members)
      .where(
        and(
          eq(schema.members.tenantId, ctx.tenantId),
          inArray(schema.members.homeBranchId, scope),
          isNull(schema.members.deletedAt),
          isNull(schema.members.mergedIntoId),
          ctx.role === 'trainer' ? eq(schema.members.trainerId, ctx.staffId ?? '') : undefined,
          or(
            sql`lower(${schema.members.firstName} || ' ' || ${schema.members.lastName}) like ${pattern} escape '\\'`,
            sql`lower(${schema.members.memberNo}) like ${pattern} escape '\\'`,
            sql`lower(coalesce(${schema.members.email}, '')) like ${pattern} escape '\\'`,
            digits.length >= 4 ? sql`coalesce(${schema.members.phoneNormalized}, '') like ${`%${digits}%`}` : undefined,
          ),
        ),
      )
      .orderBy(asc(schema.members.firstName))
      .limit(PER_TYPE)
      .all();
    for (const m of rows) {
      results.push({
        type: 'member',
        id: m.id,
        title: `${m.firstName} ${m.lastName}`.trim(),
        subtitle: `${m.memberNo} · ${branchNames.get(m.homeBranchId) ?? ''} · ${m.lifecycle}`,
        to: `/members/${m.id}`,
        meta: { memberNo: m.memberNo, branchId: m.homeBranchId },
      });
    }
  }

  if (types.includes('lead') && can(ctx, 'lead.view')) {
    for (const l of db
      .select()
      .from(schema.leads)
      .where(
        and(
          eq(schema.leads.tenantId, ctx.tenantId),
          inArray(schema.leads.branchId, scope),
          or(
            sql`lower(${schema.leads.name}) like ${pattern} escape '\\'`,
            sql`lower(coalesce(${schema.leads.email}, '')) like ${pattern} escape '\\'`,
            digits.length >= 4 ? sql`coalesce(${schema.leads.phoneNormalized}, '') like ${`%${digits}%`}` : undefined,
          ),
        ),
      )
      .orderBy(desc(schema.leads.updatedAt))
      .limit(PER_TYPE)
      .all()) {
      results.push({ type: 'lead', id: l.id, title: l.name, subtitle: `Lead · ${l.stage.replace(/_/g, ' ')} · ${branchNames.get(l.branchId) ?? ''}`, to: `/leads/${l.id}` });
    }
  }

  if (types.includes('invoice') && can(ctx, 'billing.view')) {
    for (const row of db
      .select({ invoice: schema.invoices, firstName: schema.members.firstName, lastName: schema.members.lastName })
      .from(schema.invoices)
      .innerJoin(schema.members, eq(schema.members.id, schema.invoices.memberId))
      .where(
        and(
          eq(schema.invoices.tenantId, ctx.tenantId),
          inArray(schema.invoices.branchId, scope),
          options.outstandingOnly ? inArray(schema.invoices.state, ['open', 'partially_paid', 'overdue']) : undefined,
          or(
            sql`lower(${schema.invoices.number}) like ${pattern} escape '\\'`,
            sql`lower(${schema.members.firstName} || ' ' || ${schema.members.lastName}) like ${pattern} escape '\\'`,
          ),
        ),
      )
      .orderBy(desc(schema.invoices.createdAt))
      .limit(PER_TYPE)
      .all()) {
      const due = row.invoice.totalMinor - row.invoice.paidMinor;
      results.push({
        type: 'invoice',
        id: row.invoice.id,
        title: `${row.invoice.number} · ${row.firstName} ${row.lastName}`.trim(),
        subtitle: `${row.invoice.state.replace(/_/g, ' ')} · ${due > 0 ? `${formatMoney(due, row.invoice.currency)} due` : formatMoney(row.invoice.totalMinor, row.invoice.currency)}`,
        to: `/billing?invoice=${row.invoice.id}`,
        meta: { memberId: row.invoice.memberId },
      });
    }
  }

  if (types.includes('class') && can(ctx, 'schedule.view')) {
    const atMs = now();
    for (const row of db
      .select({ session: schema.classSessions, name: schema.classTypes.name })
      .from(schema.classSessions)
      .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
      .where(
        and(
          inArray(schema.classSessions.branchId, scope),
          gte(schema.classSessions.startsAt, atMs - 2 * 60 * 60_000),
          lte(schema.classSessions.startsAt, atMs + 7 * DAY),
          sql`lower(${schema.classTypes.name}) like ${pattern} escape '\\'`,
        ),
      )
      .orderBy(asc(schema.classSessions.startsAt))
      .limit(PER_TYPE)
      .all()) {
      const branch = branchNames.get(row.session.branchId) ?? '';
      const timeZone = branchTimeZone(ctx.tenantId, row.session.branchId);
      const when = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone }).format(row.session.startsAt);
      results.push({
        type: 'class',
        id: row.session.id,
        title: row.name,
        subtitle: `${when} · ${branch} · ${row.session.booked}/${row.session.capacity} booked`,
        to: '/schedule',
      });
    }
  }

  if (types.includes('staff') && can(ctx, 'staff.view')) {
    for (const row of db
      .select({ staffId: schema.staff.id, name: schema.users.name, role: schema.users.role, branchIds: schema.staff.branchIds })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .where(and(eq(schema.staff.tenantId, ctx.tenantId), sql`lower(${schema.users.name}) like ${pattern} escape '\\'`))
      .limit(PER_TYPE * 2)
      .all()
      .filter((s) => s.branchIds.some((b) => scope.includes(b)) && !s.role.startsWith('platform'))
      .slice(0, PER_TYPE)) {
      results.push({ type: 'staff', id: row.staffId, title: row.name, subtitle: `Staff · ${row.role.replace(/_/g, ' ')}`, to: `/staff/${row.staffId}` });
    }
  }

  return { query: q, results };
}
