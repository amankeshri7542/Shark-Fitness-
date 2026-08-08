import { Hono } from 'hono';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { channels } from '@shark/contracts';
import {
  DENIAL_COPY,
  ROTATE_SECONDS,
  decideAccess,
  deriveCode,
  occupancyLabel,
  secondsUntilRotation,
} from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { notFound } from '../../lib/errors.js';
import { id, token } from '../../lib/ids.js';
import { HOUR, MINUTE, isoDate, localMinutes, now, relativeTime } from '../../lib/time.js';

export const passRoutes = new Hono();

/** The seed the member's device caches. Rotating codes derive from it offline. */
function activeToken(tenantId: string, memberId: string) {
  const existing = db
    .select()
    .from(schema.accessTokens)
    .where(
      and(
        eq(schema.accessTokens.memberId, memberId),
        isNull(schema.accessTokens.revokedAt),
        gt(schema.accessTokens.expiresAt, now()),
      ),
    )
    .orderBy(desc(schema.accessTokens.issuedAt))
    .get();

  if (existing) return existing;

  const created = {
    id: id('atk'),
    tenantId,
    memberId,
    seed: token(16),
    issuedAt: now(),
    expiresAt: now() + 30 * 86_400_000,
    revokedAt: null,
  };
  db.insert(schema.accessTokens).values(created).run();
  return created;
}

function occupancyOf(branchId: string) {
  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, branchId)).get();
  const inside = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
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

/* — The pass ————————————————————————————————————————————————— */

passRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;

  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get();
  if (!member) throw notFound('Your membership');

  const branchId = ctx.activeBranchId ?? member.homeBranchId;
  const { branch, inside, capacity, label } = occupancyOf(branchId);

  const access = activeToken(ctx.tenantId, memberId);
  const epoch = Math.floor(now() / 1000);

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} != 'cancelled'`))
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
    .where(eq(schema.checkIns.memberId, memberId))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(8)
    .all();

  const branchNames = new Map(
    db.select({ id: schema.branches.id, name: schema.branches.name }).from(schema.branches).all().map((b) => [b.id, b.name]),
  );

  const tz = branch?.timezone ?? 'Asia/Kolkata';

  return c.json({
    member: {
      name: `${member.firstName} ${member.lastName}`,
      memberNo: member.memberNo,
      initials: member.initials,
    },
    branch: { id: branchId, name: branch?.name ?? '', timezone: tz },
    code: {
      value: deriveCode(access.seed, epoch),
      rotateSec: ROTATE_SECONDS,
      secondsRemaining: secondsUntilRotation(epoch),
      // The device keeps rotating from this with no network. The server derives
      // the same value, so a screenshot is stale within 30 seconds.
      offlineSeed: access.seed,
      serverEpoch: epoch,
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
    /** Precomputed so the client shows the true state before any scan. */
    willBeAdmitted: (() => {
      if (!membership) return false;
      const decision = decideAccess({
        membershipState: membership.state as 'active',
        permittedBranchIds: ctx.branchIds,
        branchId,
        nowMinutes: localMinutes(now(), tz),
        opensMinutes: branch?.opensMinutes ?? 0,
        closesMinutes: branch?.closesMinutes ?? 1440,
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
      });
      return decision.granted;
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
      day: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(
        h.enteredAt,
      ),
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

/* — The door ————————————————————————————————————————————————— */

const ScanBody = z.object({
  branchId: z.string().optional(),
  code: z.string().optional(),
  /** Demo affordance: force a denial so the refused path is walkable. */
  simulate: z.enum(['grant', 'deny']).optional(),
});

passRoutes.post('/scan', validate('json', ScanBody), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const body = c.req.valid('json');

  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get();
  if (!member) throw notFound('Your membership');

  const branchId = body.branchId ?? ctx.activeBranchId ?? member.homeBranchId;
  const { branch, inside, capacity, label } = occupancyOf(branchId);
  if (!branch) throw notFound('That branch');

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} != 'cancelled'`))
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
        eq(schema.checkIns.memberId, memberId),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, now() - 6 * HOUR),
      ),
    )
    .get();

  const access = activeToken(ctx.tenantId, memberId);
  const epoch = Math.floor(now() / 1000);
  const window = Math.floor(epoch / ROTATE_SECONDS);

  // A code from a screenshot lands on a window that has already been burnt.
  const replayed = Boolean(
    db
      .select({ id: schema.usedAccessWindows.id })
      .from(schema.usedAccessWindows)
      .where(and(eq(schema.usedAccessWindows.memberId, memberId), eq(schema.usedAccessWindows.window, window)))
      .get(),
  );

  const expected = deriveCode(access.seed, epoch);
  const tokenValid = body.code ? body.code === expected : true;

  const lastCheckIn = db
    .select({ enteredAt: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(and(eq(schema.checkIns.memberId, memberId), eq(schema.checkIns.decision, 'granted')))
    .orderBy(desc(schema.checkIns.enteredAt))
    .get();

  const policy = (db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get()?.policy ??
    {}) as Record<string, unknown>;

  const outcome =
    body.simulate === 'deny'
      ? { decision: 'denied_grace_outstanding' as const, granted: false, overridable: true }
      : decideAccess({
          membershipState: (membership?.state ?? 'expired') as 'active',
          permittedBranchIds: ctx.branchIds,
          branchId,
          nowMinutes: localMinutes(now(), branch.timezone),
          opensMinutes: branch.opensMinutes,
          closesMinutes: branch.closesMinutes,
          windowStartMin: membership?.productSnapshot.access.windowStartMin ?? null,
          windowEndMin: membership?.productSnapshot.access.windowEndMin ?? null,
          outstandingMinor: outstanding?.total ?? 0,
          graceAllowsEntry: Boolean(policy.graceAllowsEntry),
          occupancy: inside,
          capacity,
          tokenValid,
          tokenReplayed: replayed,
          secondsSinceLastCheckIn: lastCheckIn ? Math.round((now() - lastCheckIn.enteredAt) / 1000) : null,
          antiPassbackSeconds: Number(policy.antiPassbackSeconds ?? 90),
          alreadyInside: Boolean(openSession),
        });

  const checkInId = id('chk');
  let visitNumber: number | null = null;

  transact(() => {
    if (outcome.granted) {
      const visits = db
        .select({ n: sql<number>`count(*)` })
        .from(schema.checkIns)
        .where(and(eq(schema.checkIns.memberId, memberId), eq(schema.checkIns.decision, 'granted')))
        .get();
      visitNumber = (visits?.n ?? 0) + 1;

      db.insert(schema.usedAccessWindows)
        .values({ id: id('uaw'), tenantId: ctx.tenantId, memberId, window, usedAt: now() })
        .onConflictDoNothing()
        .run();

      db.update(schema.members).set({ lastVisitAt: now() }).where(eq(schema.members.id, memberId)).run();
    }

    db.insert(schema.checkIns)
      .values({
        id: checkInId,
        tenantId: ctx.tenantId,
        branchId,
        memberId,
        method: 'qr',
        decision: outcome.decision,
        enteredAt: now(),
        exitedAt: null,
        autoClosed: false,
        overrideById: null,
        overrideByName: null,
        overrideReason: null,
        visitNumber,
      })
      .run();
  });

  if (!outcome.granted) {
    audit(ctx, {
      action: 'attendance.denied',
      entityType: 'member',
      entityId: memberId,
      entityLabel: member.memberNo,
      reason: outcome.decision,
      branchId,
    });
  }

  emit({
    tenantId: ctx.tenantId,
    branchId,
    channel: channels.branch(branchId),
    topic: outcome.granted ? 'attendance.checked_in' : 'attendance.denied',
    payload: { memberId, memberNo: member.memberNo, decision: outcome.decision, checkInId },
  });

  const nowInside = outcome.granted ? inside + 1 : inside;

  return c.json({
    decision: outcome.decision,
    granted: outcome.granted,
    checkInId: outcome.granted ? checkInId : null,
    at: new Date(now()).toISOString(),
    visitNumber,
    memberName: `${member.firstName} ${member.lastName}`,
    firstName: member.firstName,
    branchName: branch.name,
    occupancy: { inside: nowInside, capacity, label: occupancyLabel(nowInside, capacity) },
    // Denial copy is server-owned so the door and the app can never disagree,
    // and it never exposes why a security check failed.
    message: outcome.granted ? null : DENIAL_COPY[outcome.decision as keyof typeof DENIAL_COPY],
    resolution:
      !outcome.granted && (outcome.decision === 'denied_grace_outstanding' || outcome.decision === 'denied_membership_inactive')
        ? {
            kind: (outstanding?.total ?? 0) > 0 ? ('pay_outstanding' as const) : ('contact_reception' as const),
            amountMinor: outstanding?.total ?? null,
            invoiceId: outstanding?.firstId ?? null,
            message:
              (outstanding?.total ?? 0) > 0
                ? 'Settling the balance restores access immediately.'
                : 'Reception can sort this out in a minute.',
          }
        : null,
    graceEndsOn: membership?.graceEndsOn ?? null,
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
    .where(eq(schema.checkIns.memberId, ctx.memberId!))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(60)
    .all();

  const tz = 'Asia/Kolkata';
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
