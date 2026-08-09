import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requirePermission } from '../../lib/context.js';
import { DAY, isoDate, now } from '../../lib/time.js';
import {
  closeAllVisits,
  hourlyArrivals,
  isOverridable,
  loadBranchInScope,
  manualCheckIn,
  manualCheckOut,
  occupancyByBranch,
  overrideCheckIn,
} from '../../services/attendance.js';
import { loadMemberInScope, memberScopeCondition } from '../../services/members.js';

/**
 * Attendance and Live Occupancy — the front desk (UX-A08, PF-ATT).
 *
 * A thin adapter over `services/attendance.ts`. Two rules shape it:
 *
 * 1. Reading the floor and changing it are different permissions. `attendance.view`
 *    sees who is inside; `attendance.checkin` admits and releases people;
 *    `attendance.override` is the only way to contradict a refusal. Reception
 *    deliberately holds the first two and not the third (Compliance PRD §Reception).
 * 2. Scope is always the branches the caller can see. A null active branch means
 *    "every branch in my scope", matching the Command Center, rather than a
 *    silent default to one location that hides the rest.
 */
export const attendanceRoutes = new Hono();

/** The console renders `method` through the CheckInMethod enum, but the reader
 *  path writes the literal `signed_qr` (services/access.ts). Normalising here
 *  keeps a door scan from showing up as an unlabelled row. */
function displayMethod(method: string): string {
  return method === 'signed_qr' ? 'qr' : method;
}

function scopeOf(ctx: { activeBranchId: string | null; branchIds: string[] }): string[] {
  return ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
}

/* ============================================================================
   GET /current — who is inside right now, plus the occupancy header.
   ========================================================================= */

attendanceRoutes.get('/current', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'attendance.view');

  const atMs = now();
  const scope = scopeOf(ctx);
  const occupancy = occupancyByBranch(ctx.tenantId, scope, atMs);

  const inside = scope.length
    ? db
        .select({
          id: schema.checkIns.id,
          branchId: schema.checkIns.branchId,
          memberId: schema.checkIns.memberId,
          method: schema.checkIns.method,
          enteredAt: schema.checkIns.enteredAt,
          visitNumber: schema.checkIns.visitNumber,
          overrideByName: schema.checkIns.overrideByName,
          overrideReason: schema.checkIns.overrideReason,
          memberNo: schema.members.memberNo,
          firstName: schema.members.firstName,
          lastName: schema.members.lastName,
          initials: schema.members.initials,
        })
        .from(schema.checkIns)
        .leftJoin(schema.members, eq(schema.members.id, schema.checkIns.memberId))
        .where(
          and(
            eq(schema.checkIns.tenantId, ctx.tenantId),
            inArray(schema.checkIns.branchId, scope),
            eq(schema.checkIns.decision, 'granted'),
            isNull(schema.checkIns.exitedAt),
            gte(schema.checkIns.enteredAt, atMs - 6 * 3_600_000),
          ),
        )
        .orderBy(desc(schema.checkIns.enteredAt))
        .all()
    : [];

  const totals = occupancy.reduce(
    (acc, b) => ({ inside: acc.inside + b.inside, capacity: acc.capacity + b.capacity }),
    { inside: 0, capacity: 0 },
  );

  return c.json({
    at: new Date(atMs).toISOString(),
    totals,
    branches: occupancy,
    items: inside.map((row) => ({
      checkInId: row.id,
      branchId: row.branchId,
      memberId: row.memberId,
      memberNo: row.memberNo,
      name: row.firstName ? `${row.firstName} ${row.lastName}` : 'Unknown member',
      initials: row.initials ?? '··',
      method: displayMethod(row.method),
      enteredAt: new Date(row.enteredAt).toISOString(),
      minutesInside: Math.max(0, Math.round((atMs - row.enteredAt) / 60_000)),
      visitNumber: row.visitNumber,
      overrideByName: row.overrideByName,
      overrideReason: row.overrideReason,
    })),
  });
});

/* ============================================================================
   GET /occupancy — the header on its own, for cheap polling and the trace.
   ========================================================================= */

attendanceRoutes.get('/occupancy', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'attendance.view');

  const atMs = now();
  const scope = scopeOf(ctx);
  const branches = occupancyByBranch(ctx.tenantId, scope, atMs);

  const tz =
    db
      .select({ timezone: schema.branches.timezone })
      .from(schema.branches)
      .where(and(eq(schema.branches.tenantId, ctx.tenantId), inArray(schema.branches.id, scope.length ? scope : ['—'])))
      .get()?.timezone ?? 'Asia/Kolkata';

  const totals = branches.reduce(
    (acc, b) => ({ inside: acc.inside + b.inside, capacity: acc.capacity + b.capacity }),
    { inside: 0, capacity: 0 },
  );

  return c.json({
    at: new Date(atMs).toISOString(),
    timezone: tz,
    totals,
    branches,
    hourly: hourlyArrivals(ctx.tenantId, scope, atMs, tz),
    currentHour: Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(atMs)),
    // The Occupancy contract carries an `areas` breakdown, but no zone or area
    // table exists in the schema. Rooms are booking resources, not floor zones,
    // so this stays empty rather than inventing a number the desk would trust.
    areas: [] as Array<{ name: string; busy: 'free' | 'steady' | 'busy'; free: number | null }>,
  });
});

/* ============================================================================
   GET / — the day's door feed. Honours the Command Center's ?filter=denied
   deep link (routes/admin/dashboard.ts links to /floor?filter=denied).
   ========================================================================= */

const FeedQuery = z.object({
  filter: z.enum(['all', 'denied', 'granted', 'overridden']).default('all'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  memberId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

attendanceRoutes.get('/', validate('query', FeedQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'attendance.view');

  const query = c.req.valid('query');
  const atMs = now();
  const scope = scopeOf(ctx);

  if (scope.length === 0) {
    return c.json({ date: null, filter: query.filter, total: 0, hasMore: false, breakdown: {}, items: [] });
  }

  const tz =
    db
      .select({ timezone: schema.branches.timezone })
      .from(schema.branches)
      .where(and(eq(schema.branches.tenantId, ctx.tenantId), inArray(schema.branches.id, scope)))
      .get()?.timezone ?? 'Asia/Kolkata';

  const date = query.date ?? isoDate(atMs, tz);
  const anchor = Date.parse(`${date}T00:00:00Z`);

  const filters = [
    eq(schema.checkIns.tenantId, ctx.tenantId),
    inArray(schema.checkIns.branchId, scope),
    // Widened either side of the UTC day, then narrowed on the branch-local
    // date below, so this holds in any zone.
    gte(schema.checkIns.enteredAt, anchor - DAY),
    lt(schema.checkIns.enteredAt, anchor + 2 * DAY),
  ];
  if (query.memberId) filters.push(eq(schema.checkIns.memberId, query.memberId));

  const rows = db
    .select({
      id: schema.checkIns.id,
      branchId: schema.checkIns.branchId,
      memberId: schema.checkIns.memberId,
      method: schema.checkIns.method,
      decision: schema.checkIns.decision,
      enteredAt: schema.checkIns.enteredAt,
      exitedAt: schema.checkIns.exitedAt,
      autoClosed: schema.checkIns.autoClosed,
      overrideByName: schema.checkIns.overrideByName,
      overrideReason: schema.checkIns.overrideReason,
      visitNumber: schema.checkIns.visitNumber,
      memberNo: schema.members.memberNo,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      initials: schema.members.initials,
    })
    .from(schema.checkIns)
    .leftJoin(schema.members, eq(schema.members.id, schema.checkIns.memberId))
    .where(and(...filters))
    .orderBy(desc(schema.checkIns.enteredAt))
    .all()
    .filter((row) => isoDate(row.enteredAt, tz) === date);

  // The breakdown counts the whole filtered day, not the page, so a truncated
  // table never understates how many denials there were.
  const breakdown = {
    all: rows.length,
    granted: rows.filter((r) => r.decision === 'granted').length,
    denied: rows.filter((r) => r.decision !== 'granted').length,
    overridden: rows.filter((r) => r.overrideReason !== null).length,
  };

  const matched = rows.filter((row) => {
    if (query.filter === 'granted') return row.decision === 'granted';
    if (query.filter === 'denied') return row.decision !== 'granted';
    if (query.filter === 'overridden') return row.overrideReason !== null;
    return true;
  });

  const page = matched.slice(query.offset, query.offset + query.limit);

  return c.json({
    date,
    timezone: tz,
    filter: query.filter,
    total: matched.length,
    hasMore: query.offset + page.length < matched.length,
    breakdown,
    items: page.map((row) => ({
      checkInId: row.id,
      branchId: row.branchId,
      memberId: row.memberId,
      memberNo: row.memberNo,
      name: row.firstName ? `${row.firstName} ${row.lastName}` : 'Unknown member',
      initials: row.initials ?? '··',
      method: displayMethod(row.method),
      decision: row.decision,
      granted: row.decision === 'granted',
      canOverride: isOverridable(row.decision) && atMs - row.enteredAt <= 30 * 60_000,
      enteredAt: new Date(row.enteredAt).toISOString(),
      exitedAt: row.exitedAt === null ? null : new Date(row.exitedAt).toISOString(),
      durationMin: row.exitedAt === null ? null : Math.max(0, Math.round((row.exitedAt - row.enteredAt) / 60_000)),
      autoClosed: row.autoClosed,
      inside: row.decision === 'granted' && row.exitedAt === null,
      overrideByName: row.overrideByName,
      overrideReason: row.overrideReason,
      visitNumber: row.visitNumber,
    })),
  });
});

/* ============================================================================
   GET /search — member lookup for the desk. The manual check-in path (PF-ATT-001)
   starts here: name, member number or phone.
   ========================================================================= */

const SearchQuery = z.object({ q: z.string().trim().min(2).max(60) });

attendanceRoutes.get('/search', validate('query', SearchQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'attendance.view');

  const { q } = c.req.valid('query');
  const scope = scopeOf(ctx);
  if (scope.length === 0) return c.json({ items: [] });

  const atMs = now();
  const like = `%${q.toLowerCase()}%`;

  const rows = db
    .select({
      id: schema.members.id,
      memberNo: schema.members.memberNo,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      initials: schema.members.initials,
      homeBranchId: schema.members.homeBranchId,
      lifecycle: schema.members.lifecycle,
    })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        isNull(schema.members.deletedAt),
        isNull(schema.members.mergedIntoId),
        memberScopeCondition({ tenantId: ctx.tenantId, branchIds: scope }),
        sql`(lower(${schema.members.firstName} || ' ' || ${schema.members.lastName}) like ${like}
             or lower(${schema.members.memberNo}) like ${like}
             or coalesce(${schema.members.phoneNormalized}, '') like ${like})`,
      ),
    )
    .orderBy(schema.members.firstName)
    .limit(12)
    .all();

  const openVisits = new Map<string, number>();
  if (rows.length > 0) {
    for (const visit of db
      .select({ memberId: schema.checkIns.memberId, enteredAt: schema.checkIns.enteredAt })
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.tenantId, ctx.tenantId),
          inArray(
            schema.checkIns.memberId,
            rows.map((r) => r.id),
          ),
          eq(schema.checkIns.decision, 'granted'),
          isNull(schema.checkIns.exitedAt),
          gte(schema.checkIns.enteredAt, atMs - 6 * 3_600_000),
        ),
      )
      .all()) {
      if (visit.memberId) openVisits.set(visit.memberId, visit.enteredAt);
    }
  }

  return c.json({
    items: rows.map((row) => ({
      memberId: row.id,
      memberNo: row.memberNo,
      name: `${row.firstName} ${row.lastName}`,
      initials: row.initials,
      homeBranchId: row.homeBranchId,
      lifecycle: row.lifecycle,
      insideSince: openVisits.has(row.id) ? new Date(openVisits.get(row.id)!).toISOString() : null,
    })),
  });
});

/* ============================================================================
   Mutations
   ========================================================================= */

const CheckInBody = z.object({
  memberId: z.string().min(1),
  branchId: z.string().min(1),
  method: z.enum(['staff', 'kiosk']).default('staff'),
});

attendanceRoutes.post('/check-in', validate('json', CheckInBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'attendance.checkin');
  return c.json(manualCheckIn(ctx, c.req.valid('json')));
});

const CheckOutBody = z.object({ checkInId: z.string().min(1) });

attendanceRoutes.post('/check-out', validate('json', CheckOutBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'attendance.checkin');
  return c.json(manualCheckOut(ctx, c.req.valid('json')));
});

const OverrideBody = z.object({
  checkInId: z.string().min(1),
  reason: z.string().trim().min(4).max(280),
});

attendanceRoutes.post('/override', validate('json', OverrideBody), (c) => {
  const ctx = ctxOf(c);
  // Deliberately not attendance.checkin. Reception admits members; only a
  // manager contradicts a refusal, and the reason is recorded against them.
  requirePermission(ctx, 'attendance.override');
  return c.json(overrideCheckIn(ctx, c.req.valid('json')));
});

const CloseAllBody = z.object({
  branchId: z.string().min(1),
  reason: z.string().trim().min(4).max(280),
});

attendanceRoutes.post('/close-all', validate('json', CloseAllBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'attendance.override');
  return c.json(closeAllVisits(ctx, c.req.valid('json')));
});

/* ============================================================================
   GET /member/:memberId — one member's attendance, for Member 360 (PF-MEM-001).
   ========================================================================= */

attendanceRoutes.get('/member/:memberId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'attendance.view');

  const memberId = c.req.param('memberId');
  const member = loadMemberInScope(ctx, memberId);

  const rows = db
    .select()
    .from(schema.checkIns)
    .where(and(eq(schema.checkIns.tenantId, ctx.tenantId), eq(schema.checkIns.memberId, member.id)))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(60)
    .all();

  return c.json({
    member: { id: member.id, memberNo: member.memberNo, name: `${member.firstName} ${member.lastName}` },
    total: rows.length,
    items: rows.map((row) => ({
      checkInId: row.id,
      branchId: row.branchId,
      method: displayMethod(row.method),
      decision: row.decision,
      granted: row.decision === 'granted',
      enteredAt: new Date(row.enteredAt).toISOString(),
      exitedAt: row.exitedAt === null ? null : new Date(row.exitedAt).toISOString(),
      durationMin: row.exitedAt === null ? null : Math.max(0, Math.round((row.exitedAt - row.enteredAt) / 60_000)),
      autoClosed: row.autoClosed,
      overrideByName: row.overrideByName,
      overrideReason: row.overrideReason,
      visitNumber: row.visitNumber,
    })),
  });
});
