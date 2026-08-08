import { Hono } from 'hono';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { channels, type AccessDecision, type MembershipState } from '@shark/contracts';
import {
  DENIAL_COPY,
  ROTATE_SECONDS,
  decideAccess,
  deriveCode,
  isEntitled,
  occupancyLabel,
  secondsUntilRotation,
} from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { id, token } from '../../lib/ids.js';
import { DAY, HOUR, MINUTE, isoDate, localMinutes, localTime, now, relativeTime } from '../../lib/time.js';
import { notFound } from '../../lib/errors.js';
import type { RequestContext } from '../../lib/context.js';

/**
 * Membership pass and check-in (UX-M03, PF-ATT).
 *
 * The member's phone holds a seed and derives the entry code offline; this
 * module derives the same value from the stored seed and burns the rotation
 * window, which is what makes a screenshot useless and a replay detectable
 * (PF-ATT-005). Every eligibility question is answered here by `decideAccess`
 * — the client is never trusted with a door decision (PF-ATT-002).
 */
export const passRoutes = new Hono();

/** How long a seed lives before the member's app has to fetch a new one. */
const TOKEN_TTL = 30 * DAY;

/** Sessions older than this are stale, not "inside" — the scheduler closes
 *  them nightly and occupancy counting agrees with it. */
const OPEN_SESSION_WINDOW = 6 * HOUR;

/* ============================================================================
   Service layer. Handlers below are adapters over these.
   ========================================================================= */

interface PassContext {
  member: typeof schema.members.$inferSelect;
  branch: typeof schema.branches.$inferSelect;
  membership: typeof schema.memberships.$inferSelect | null;
  membershipState: MembershipState;
  seed: string;
  tokenId: string;
  tokenExpiresAt: number;
  outstandingMinor: number;
  oldestOpenInvoiceId: string | null;
  openInvoiceCount: number;
  graceAllowsEntry: boolean;
  antiPassbackSeconds: number;
}

function memberOf(ctx: RequestContext): typeof schema.members.$inferSelect {
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, ctx.memberId ?? ''), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) throw notFound('Your membership');
  return member;
}

function branchOf(ctx: RequestContext, branchId: string): typeof schema.branches.$inferSelect {
  // Same message whether the branch is in another tenant or does not exist —
  // which branches exist elsewhere is not something a caller gets to learn.
  if (!ctx.branchIds.includes(branchId)) throw notFound('That branch');
  const branch = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, ctx.tenantId)))
    .get();
  if (!branch) throw notFound('That branch');
  return branch;
}

/**
 * The member's live seed. Issued lazily and reused: the code has to be
 * derivable from the same secret on both sides or the door check is theatre.
 */
function activeSeed(ctx: RequestContext, memberId: string): { id: string; seed: string; expiresAt: number } {
  const existing = db
    .select()
    .from(schema.accessTokens)
    .where(
      and(
        eq(schema.accessTokens.tenantId, ctx.tenantId),
        eq(schema.accessTokens.memberId, memberId),
        isNull(schema.accessTokens.revokedAt),
        gt(schema.accessTokens.expiresAt, now()),
      ),
    )
    .orderBy(desc(schema.accessTokens.issuedAt))
    .get();

  if (existing) return { id: existing.id, seed: existing.seed, expiresAt: existing.expiresAt };

  const row = {
    id: id('atk'),
    tenantId: ctx.tenantId,
    memberId,
    seed: token(16),
    issuedAt: now(),
    expiresAt: now() + TOKEN_TTL,
    revokedAt: null,
  };
  db.insert(schema.accessTokens).values(row).run();
  return { id: row.id, seed: row.seed, expiresAt: row.expiresAt };
}

function loadPassContext(ctx: RequestContext, branchId?: string): PassContext {
  const member = memberOf(ctx);
  const branch = branchOf(ctx, branchId ?? member.homeBranchId);

  const membership = db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.memberId, member.id),
        eq(schema.memberships.tenantId, ctx.tenantId),
        sql`${schema.memberships.state} != 'cancelled'`,
      ),
    )
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  const balance = db
    .select({
      total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}), 0)`,
      count: sql<number>`count(*)`,
      oldest: sql<string | null>`min(${schema.invoices.id})`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.memberId, member.id),
        eq(schema.invoices.tenantId, ctx.tenantId),
        sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
      ),
    )
    .get();

  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get();
  const policy = (tenant?.policy ?? {}) as Record<string, unknown>;
  const seed = activeSeed(ctx, member.id);

  return {
    member,
    branch,
    membership: membership ?? null,
    // No membership record at all is treated as expired: the door is closed,
    // and the copy points at reception rather than at a missing row.
    membershipState: (membership?.state ?? 'expired') as MembershipState,
    seed: seed.seed,
    tokenId: seed.id,
    tokenExpiresAt: seed.expiresAt,
    outstandingMinor: Math.max(0, balance?.total ?? 0),
    oldestOpenInvoiceId: balance?.oldest ?? null,
    openInvoiceCount: balance?.count ?? 0,
    graceAllowsEntry: policy.graceAllowsEntry === true,
    antiPassbackSeconds: typeof policy.antiPassbackSeconds === 'number' ? policy.antiPassbackSeconds : 90,
  };
}

function insideCount(tenantId: string, branchId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.tenantId, tenantId),
          eq(schema.checkIns.branchId, branchId),
          eq(schema.checkIns.decision, 'granted'),
          isNull(schema.checkIns.exitedAt),
          gt(schema.checkIns.enteredAt, now() - OPEN_SESSION_WINDOW),
        ),
      )
      .get()?.n ?? 0
  );
}

function occupancyOf(tenantId: string, branch: typeof schema.branches.$inferSelect) {
  const inside = insideCount(tenantId, branch.id);
  return {
    inside,
    capacity: branch.capacity,
    label: occupancyLabel(inside, branch.capacity),
    pct: Math.round((inside / Math.max(1, branch.capacity)) * 100),
  };
}

/** The member's currently open session at any branch they may enter. */
function openSession(tenantId: string, memberId: string) {
  return (
    db
      .select()
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.tenantId, tenantId),
          eq(schema.checkIns.memberId, memberId),
          eq(schema.checkIns.decision, 'granted'),
          isNull(schema.checkIns.exitedAt),
          gt(schema.checkIns.enteredAt, now() - OPEN_SESSION_WINDOW),
        ),
      )
      .orderBy(desc(schema.checkIns.enteredAt))
      .get() ?? null
  );
}

function lastGrantedEntry(tenantId: string, memberId: string): number | null {
  const row = db
    .select({ enteredAt: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        eq(schema.checkIns.memberId, memberId),
        eq(schema.checkIns.decision, 'granted'),
      ),
    )
    .orderBy(desc(schema.checkIns.enteredAt))
    .get();
  return row?.enteredAt ?? null;
}

/** Runs the domain door rules against the member's real state right now. */
function evaluate(
  pass: PassContext,
  ctx: RequestContext,
  opts: { tokenValid: boolean; tokenReplayed: boolean; alreadyInside: boolean; inside: number },
) {
  const access = pass.membership?.productSnapshot.access ?? null;
  const last = lastGrantedEntry(ctx.tenantId, pass.member.id);

  return decideAccess({
    membershipState: pass.membershipState,
    permittedBranchIds: ctx.branchIds,
    branchId: pass.branch.id,
    nowMinutes: localMinutes(now(), pass.branch.timezone),
    opensMinutes: pass.branch.opensMinutes,
    closesMinutes: pass.branch.closesMinutes,
    windowStartMin: access?.windowStartMin ?? null,
    windowEndMin: access?.windowEndMin ?? null,
    outstandingMinor: pass.outstandingMinor,
    graceAllowsEntry: pass.graceAllowsEntry,
    occupancy: opts.inside,
    capacity: pass.branch.capacity,
    tokenValid: opts.tokenValid,
    tokenReplayed: opts.tokenReplayed,
    secondsSinceLastCheckIn: last === null ? null : Math.round((now() - last) / 1000),
    antiPassbackSeconds: pass.antiPassbackSeconds,
    alreadyInside: opts.alreadyInside,
  });
}

type ResolutionKind = 'pay_outstanding' | 'contact_reception' | 'renew' | 'wait' | 'other_branch';

interface Resolution {
  kind: ResolutionKind;
  amountMinor: number | null;
  invoiceId: string | null;
  message: string;
  to: string | null;
}

/**
 * What the member can actually do about a denial. Always a route out —
 * a closed door with no next step is the failure the product PRD forbids.
 */
function resolutionFor(decision: AccessDecision, pass: PassContext): Resolution | null {
  if (decision === 'granted') return null;

  switch (decision) {
    case 'denied_grace_outstanding':
      return {
        kind: 'pay_outstanding',
        amountMinor: pass.outstandingMinor,
        invoiceId: pass.oldestOpenInvoiceId,
        message: 'Settle the balance in the app and your access comes back straight away.',
        to: '/billing',
      };
    case 'denied_membership_inactive':
      return pass.outstandingMinor > 0
        ? {
            kind: 'pay_outstanding',
            amountMinor: pass.outstandingMinor,
            invoiceId: pass.oldestOpenInvoiceId,
            message: 'Settle the balance in the app, or reception can restart your plan at the desk.',
            to: '/billing',
          }
        : {
            kind: 'renew',
            amountMinor: null,
            invoiceId: null,
            message: 'Renewing takes a minute in the app and your history carries over.',
            to: '/billing',
          };
    case 'denied_suspended':
    case 'denied_anti_passback':
      return {
        kind: 'contact_reception',
        amountMinor: null,
        invoiceId: null,
        message: 'Reception can look this up and let you in while it is sorted.',
        to: '/messages',
      };
    case 'denied_branch_not_permitted':
      return {
        kind: 'other_branch',
        amountMinor: null,
        invoiceId: null,
        message: `Your plan covers ${pass.member.homeBranchId === pass.branch.id ? 'your home branch' : 'your home branch only'}. Reception can add this one.`,
        to: '/messages',
      };
    case 'denied_capacity':
    case 'denied_outside_hours':
      return {
        kind: 'wait',
        amountMinor: null,
        invoiceId: null,
        message:
          decision === 'denied_capacity'
            ? 'The floor clears quickly — the occupancy strip on your home screen shows when.'
            : `This branch is open ${clockOf(pass.branch.opensMinutes)}–${clockOf(pass.branch.closesMinutes)}.`,
        to: null,
      };
    default:
      // Token problems: the fix is in the member's hand, not at the desk.
      return {
        kind: 'contact_reception',
        amountMinor: null,
        invoiceId: null,
        message: 'Pull down to refresh this screen and show the new code. Reception can let you in meanwhile.',
        to: null,
      };
  }
}

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function serialiseVisit(row: typeof schema.checkIns.$inferSelect, branchName: string, tz: string) {
  const granted = row.decision === 'granted';
  const durationMin = row.exitedAt ? Math.max(1, Math.round((row.exitedAt - row.enteredAt) / MINUTE)) : null;
  return {
    id: row.id,
    branchId: row.branchId,
    branchName,
    decision: row.decision as AccessDecision,
    granted,
    method: row.method,
    enteredAt: new Date(row.enteredAt).toISOString(),
    exitedAt: row.exitedAt ? new Date(row.exitedAt).toISOString() : null,
    dayLabel: new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(row.enteredAt),
    span: granted
      ? row.exitedAt
        ? `${localTime(row.enteredAt, tz)}–${localTime(row.exitedAt, tz)}`
        : `${localTime(row.enteredAt, tz)} · inside`
      : 'No entry',
    durationMin,
    open: granted && row.exitedAt === null,
    autoClosed: row.autoClosed,
    visitNumber: row.visitNumber,
    overrideByName: row.overrideByName,
    overrideReason: row.overrideReason,
    relativeTime: relativeTime(row.enteredAt),
    denialCopy: granted ? null : (DENIAL_COPY[row.decision as Exclude<AccessDecision, 'granted'>] ?? null),
  };
}

function recentVisits(ctx: RequestContext, memberId: string, limit: number) {
  const branchNames = new Map(
    db
      .select({ id: schema.branches.id, name: schema.branches.name, tz: schema.branches.timezone })
      .from(schema.branches)
      .where(eq(schema.branches.tenantId, ctx.tenantId))
      .all()
      .map((b) => [b.id, b] as const),
  );

  return db
    .select()
    .from(schema.checkIns)
    .where(and(eq(schema.checkIns.tenantId, ctx.tenantId), eq(schema.checkIns.memberId, memberId)))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(limit)
    .all()
    .map((row) => {
      const branch = branchNames.get(row.branchId);
      return serialiseVisit(row, branch?.name ?? 'Shark Fitness', branch?.tz ?? 'Asia/Kolkata');
    });
}

function emitOccupancy(tenantId: string, branch: typeof schema.branches.$inferSelect): void {
  const inside = insideCount(tenantId, branch.id);
  emit({
    tenantId,
    branchId: branch.id,
    channel: channels.branch(branch.id),
    topic: 'occupancy.changed',
    payload: {
      branchId: branch.id,
      branchName: branch.name,
      inside,
      capacity: branch.capacity,
      label: occupancyLabel(inside, branch.capacity),
    },
  });
}

/* ============================================================================
   GET / — the pass itself: live code, context, recent visits.
   ========================================================================= */

passRoutes.get(
  '/',
  zValidator('query', z.object({ branchId: z.string().min(1).optional() })),
  (c) => {
    const ctx = ctxOf(c);
    const { branchId } = c.req.valid('query');
    const pass = loadPassContext(ctx, branchId);
    const tz = pass.branch.timezone;

    const epochSeconds = Math.floor(now() / 1000);
    const code = deriveCode(pass.seed, epochSeconds);

    const inside = insideCount(ctx.tenantId, pass.branch.id);
    const session = openSession(ctx.tenantId, pass.member.id);
    const alreadyInside = session !== null && session.branchId === pass.branch.id;

    // A dry run of the door, so the pass can say VALID or explain itself
    // before the member walks up to it. Nothing is burnt here.
    const preview = evaluate(pass, ctx, {
      tokenValid: true,
      tokenReplayed: false,
      alreadyInside,
      inside,
    });

    const branches = db
      .select()
      .from(schema.branches)
      .where(eq(schema.branches.tenantId, ctx.tenantId))
      .all()
      .filter((b) => ctx.branchIds.includes(b.id))
      .map((b) => ({
        id: b.id,
        name: b.name,
        addressLine: b.addressLine,
        city: b.city,
        opensAt: clockOf(b.opensMinutes),
        closesAt: clockOf(b.closesMinutes),
        isHome: b.id === pass.member.homeBranchId,
        openNow: (() => {
          const minutes = localMinutes(now(), b.timezone);
          return minutes >= b.opensMinutes && minutes < b.closesMinutes;
        })(),
      }));

    return c.json({
      member: {
        id: pass.member.id,
        firstName: pass.member.firstName,
        name: `${pass.member.firstName} ${pass.member.lastName}`.trim(),
        initials: pass.member.initials,
        memberNo: pass.member.memberNo,
      },
      token: {
        tokenId: pass.tokenId,
        code,
        /** The client derives the same code offline from this. */
        offlineSeed: pass.seed,
        rotateSec: ROTATE_SECONDS,
        secondsUntilRotation: secondsUntilRotation(epochSeconds),
        serverEpochSeconds: epochSeconds,
        issuedAt: new Date(now()).toISOString(),
        expiresAt: new Date(pass.tokenExpiresAt).toISOString(),
      },
      branch: {
        id: pass.branch.id,
        name: pass.branch.name,
        addressLine: pass.branch.addressLine,
        city: pass.branch.city,
        timezone: tz,
        opensAt: clockOf(pass.branch.opensMinutes),
        closesAt: clockOf(pass.branch.closesMinutes),
      },
      branches,
      membership: pass.membership
        ? {
            id: pass.membership.id,
            productName: pass.membership.productName,
            state: pass.membership.state,
            endsOn: pass.membership.endsOn,
            graceEndsOn: pass.membership.graceEndsOn,
            entitled: isEntitled(pass.membershipState),
            allBranches: pass.membership.productSnapshot.access.allBranches,
          }
        : null,
      access: {
        decision: preview.decision,
        valid: preview.granted,
        overridable: preview.overridable,
        denialCopy:
          preview.decision === 'granted'
            ? null
            : DENIAL_COPY[preview.decision as Exclude<AccessDecision, 'granted'>],
        resolution: resolutionFor(preview.decision, pass),
      },
      outstanding: {
        totalMinor: pass.outstandingMinor,
        invoiceCount: pass.openInvoiceCount,
        invoiceId: pass.oldestOpenInvoiceId,
      },
      occupancy: occupancyOf(ctx.tenantId, pass.branch),
      session: session
        ? {
            checkInId: session.id,
            branchId: session.branchId,
            branchName:
              db.select({ name: schema.branches.name }).from(schema.branches).where(eq(schema.branches.id, session.branchId)).get()
                ?.name ?? pass.branch.name,
            enteredAt: new Date(session.enteredAt).toISOString(),
            enteredAtLocal: localTime(session.enteredAt, tz),
            elapsedMin: Math.max(0, Math.round((now() - session.enteredAt) / MINUTE)),
            visitNumber: session.visitNumber,
          }
        : null,
      today: isoDate(now(), tz),
      history: recentVisits(ctx, pass.member.id, 8),
    });
  },
);

/* ============================================================================
   GET /history — the full recent list.
   ========================================================================= */

passRoutes.get(
  '/history',
  zValidator('query', z.object({ limit: z.coerce.number().int().min(1).max(60).default(20) })),
  (c) => {
    const ctx = ctxOf(c);
    const member = memberOf(ctx);
    const { limit } = c.req.valid('query');
    const items = recentVisits(ctx, member.id, limit);

    const granted = items.filter((v) => v.granted);
    return c.json({
      items,
      total: items.length,
      summary: {
        visits: granted.length,
        deniedCount: items.length - granted.length,
        lastVisitAt: granted[0]?.enteredAt ?? null,
      },
    });
  },
);

/* ============================================================================
   POST /scan — a door scan for this member.

   Everything the door would check runs here (PF-ATT-002). The rotation window
   is burnt on presentation, so the same code cannot be shown twice — which is
   also what stops a rapid double-tap becoming a second session (PF-ATT-005).
   ========================================================================= */

const ScanBody = z.object({
  branchId: z.string().min(1),
  /** The code the phone derived. Omitted means "use the live one" — the app
   *  is the member's own, so it is deriving from the same seed anyway. */
  code: z.string().min(6).max(24).optional(),
  method: z.enum(['qr', 'staff', 'kiosk', 'device', 'manual']).default('qr'),
  /** Demo/QA affordance. Changes what the *reader* saw, never the rules:
   *  'deny' presents a stale code, so the refusal is a real domain outcome. */
  simulate: z.enum(['grant', 'deny']).optional(),
});

passRoutes.post('/scan', zValidator('json', ScanBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  const pass = loadPassContext(ctx, body.branchId);
  const tz = pass.branch.timezone;

  const epochSeconds = Math.floor(now() / 1000);
  const currentWindow = Math.floor(epochSeconds / ROTATE_SECONDS);

  // A member can be mid-stride through the door as the code turns over, so
  // the window just gone is still accepted — once.
  let matchedWindow: number | null = null;
  if (body.code) {
    const presented = body.code.trim().toUpperCase();
    for (const window of [currentWindow, currentWindow - 1]) {
      if (deriveCode(pass.seed, window * ROTATE_SECONDS) === presented) {
        matchedWindow = window;
        break;
      }
    }
  } else {
    matchedWindow = currentWindow;
  }

  const staleCode = body.simulate === 'deny';
  const tokenValid = matchedWindow !== null && !staleCode;
  const burnWindow = matchedWindow ?? currentWindow;

  const result = transact(() => {
    const replayed =
      tokenValid &&
      db
        .select({ id: schema.usedAccessWindows.id })
        .from(schema.usedAccessWindows)
        .where(
          and(
            eq(schema.usedAccessWindows.memberId, pass.member.id),
            eq(schema.usedAccessWindows.window, burnWindow),
          ),
        )
        .get() !== undefined;

    if (tokenValid && !replayed) {
      // Burn the window whatever the eligibility outcome. A code presented at
      // a reader is spent, and re-presenting it must not read as fresh.
      db.insert(schema.usedAccessWindows)
        .values({
          id: id('uaw'),
          tenantId: ctx.tenantId,
          memberId: pass.member.id,
          window: burnWindow,
          usedAt: now(),
        })
        .onConflictDoNothing()
        .run();
    }

    const session = openSession(ctx.tenantId, pass.member.id);
    const alreadyInside = session !== null && session.branchId === pass.branch.id;
    const inside = insideCount(ctx.tenantId, pass.branch.id);

    const outcome = evaluate(pass, ctx, {
      tokenValid,
      tokenReplayed: replayed,
      alreadyInside,
      inside,
    });

    /* — Granted, and already inside: the reader is a turnstile, so this is
         the way out (PF-ATT-003). ————————————————————————————————— */
    if (outcome.granted && alreadyInside && session) {
      db.update(schema.checkIns)
        .set({ exitedAt: now() })
        .where(eq(schema.checkIns.id, session.id))
        .run();
      return { mode: 'checked_out' as const, outcome, row: session, session };
    }

    /* — Granted entry ————————————————————————————————————————— */
    if (outcome.granted) {
      const lastVisit = db
        .select({ n: sql<number>`coalesce(max(${schema.checkIns.visitNumber}), 0)` })
        .from(schema.checkIns)
        .where(and(eq(schema.checkIns.tenantId, ctx.tenantId), eq(schema.checkIns.memberId, pass.member.id)))
        .get();

      const row = {
        id: id('chk'),
        tenantId: ctx.tenantId,
        branchId: pass.branch.id,
        memberId: pass.member.id,
        method: body.method,
        decision: 'granted',
        enteredAt: now(),
        exitedAt: null,
        autoClosed: false,
        overrideById: null,
        overrideByName: null,
        overrideReason: null,
        visitNumber: (lastVisit?.n ?? 0) + 1,
      };
      db.insert(schema.checkIns).values(row).run();
      db.update(schema.members)
        .set({ lastVisitAt: row.enteredAt, updatedAt: now() })
        .where(eq(schema.members.id, pass.member.id))
        .run();

      return { mode: 'checked_in' as const, outcome, row, session: null };
    }

    /* — Denied. Recorded, because a refused entry is part of the member's
         record and the floor screen has to be able to show it. ————— */
    const row = {
      id: id('chk'),
      tenantId: ctx.tenantId,
      branchId: pass.branch.id,
      memberId: pass.member.id,
      method: body.method,
      decision: outcome.decision,
      enteredAt: now(),
      exitedAt: null,
      autoClosed: false,
      overrideById: null,
      overrideByName: null,
      overrideReason: null,
      visitNumber: null,
    };
    db.insert(schema.checkIns).values(row).run();

    // A denial is an access-control event about a person: it is audited in the
    // same transaction that records it. Grants are the check-in row itself.
    audit(ctx, {
      action: 'access.denied',
      entityType: 'member',
      entityId: pass.member.id,
      entityLabel: `${pass.member.firstName} ${pass.member.lastName} · ${pass.member.memberNo}`,
      branchId: pass.branch.id,
      reason: outcome.decision,
      after: {
        decision: outcome.decision,
        branchId: pass.branch.id,
        method: body.method,
        simulated: body.simulate ?? null,
        overridable: outcome.overridable,
      },
    });

    return { mode: 'denied' as const, outcome, row, session: null };
  });

  /* — Fan out after the transaction. ————————————————————————— */

  const memberLabel = `${pass.member.firstName} ${pass.member.lastName}`.trim();

  if (result.mode === 'checked_in') {
    const payload = {
      checkInId: result.row.id,
      memberId: pass.member.id,
      memberName: memberLabel,
      memberNo: pass.member.memberNo,
      branchId: pass.branch.id,
      method: body.method,
      visitNumber: result.row.visitNumber,
      at: new Date(result.row.enteredAt).toISOString(),
    };
    emit({
      tenantId: ctx.tenantId,
      branchId: pass.branch.id,
      channel: channels.branch(pass.branch.id),
      topic: 'attendance.checked_in',
      payload,
    });
    emit({
      tenantId: ctx.tenantId,
      branchId: pass.branch.id,
      channel: channels.member(pass.member.id),
      topic: 'attendance.checked_in',
      payload,
    });
    emitOccupancy(ctx.tenantId, pass.branch);
  }

  if (result.mode === 'checked_out') {
    const payload = {
      checkInId: result.row.id,
      memberId: pass.member.id,
      memberName: memberLabel,
      branchId: pass.branch.id,
      durationMin: Math.max(1, Math.round((now() - result.row.enteredAt) / MINUTE)),
      at: new Date(now()).toISOString(),
    };
    emit({
      tenantId: ctx.tenantId,
      branchId: pass.branch.id,
      channel: channels.branch(pass.branch.id),
      topic: 'attendance.checked_out',
      payload,
    });
    emit({
      tenantId: ctx.tenantId,
      branchId: pass.branch.id,
      channel: channels.member(pass.member.id),
      topic: 'attendance.checked_out',
      payload,
    });
    emitOccupancy(ctx.tenantId, pass.branch);
  }

  if (result.mode === 'denied') {
    emit({
      tenantId: ctx.tenantId,
      branchId: pass.branch.id,
      channel: channels.branch(pass.branch.id),
      topic: 'attendance.denied',
      payload: {
        checkInId: result.row.id,
        memberId: pass.member.id,
        memberName: memberLabel,
        memberNo: pass.member.memberNo,
        branchId: pass.branch.id,
        decision: result.outcome.decision,
        overridable: result.outcome.overridable,
        at: new Date(result.row.enteredAt).toISOString(),
      },
    });
    emit({
      tenantId: ctx.tenantId,
      branchId: pass.branch.id,
      channel: channels.member(pass.member.id),
      topic: 'attendance.denied',
      payload: { decision: result.outcome.decision, branchId: pass.branch.id },
    });
  }

  const decision = result.mode === 'denied' ? result.outcome.decision : 'granted';
  const nextEpoch = Math.floor(now() / 1000);

  return c.json(
    {
      mode: result.mode,
      decision,
      granted: result.mode !== 'denied',
      memberId: pass.member.id,
      memberName: memberLabel,
      memberNo: pass.member.memberNo,
      checkInId: result.row.id,
      at: new Date(now()).toISOString(),
      visitNumber: result.mode === 'checked_in' ? result.row.visitNumber : (result.row.visitNumber ?? null),
      branchId: pass.branch.id,
      branchName: pass.branch.name,
      enteredAtLocal: localTime(result.row.enteredAt, tz),
      durationMin:
        result.mode === 'checked_out' ? Math.max(1, Math.round((now() - result.row.enteredAt) / MINUTE)) : null,
      occupancy: occupancyOf(ctx.tenantId, pass.branch),
      denialCopy:
        decision === 'granted' ? null : DENIAL_COPY[decision as Exclude<AccessDecision, 'granted'>],
      resolution: resolutionFor(decision as AccessDecision, pass),
      canOverride: result.mode === 'denied' ? result.outcome.overridable : false,
      token: {
        code: deriveCode(pass.seed, nextEpoch),
        rotateSec: ROTATE_SECONDS,
        secondsUntilRotation: secondsUntilRotation(nextEpoch),
      },
    },
    result.mode === 'denied' ? 200 : 200,
  );
});

/* ============================================================================
   POST /check-out — close the open session.
   ========================================================================= */

passRoutes.post(
  '/check-out',
  zValidator('json', z.object({ checkInId: z.string().min(1).optional() }).default({})),
  (c) => {
    const ctx = ctxOf(c);
    const member = memberOf(ctx);
    const requested = c.req.valid('json').checkInId;

    const closed = transact(() => {
      const session = openSession(ctx.tenantId, member.id);
      if (!session) return null;
      // An id from a stale screen must not close whatever happens to be open now.
      if (requested && requested !== session.id) return null;

      db.update(schema.checkIns).set({ exitedAt: now() }).where(eq(schema.checkIns.id, session.id)).run();
      return session;
    });

    if (!closed) {
      const pass = loadPassContext(ctx);
      return c.json({
        mode: 'already_out' as const,
        checkInId: null,
        durationMin: null,
        branchId: pass.branch.id,
        branchName: pass.branch.name,
        at: new Date(now()).toISOString(),
        occupancy: occupancyOf(ctx.tenantId, pass.branch),
      });
    }

    const branch = branchOf(ctx, closed.branchId);
    const durationMin = Math.max(1, Math.round((now() - closed.enteredAt) / MINUTE));
    const payload = {
      checkInId: closed.id,
      memberId: member.id,
      memberName: `${member.firstName} ${member.lastName}`.trim(),
      branchId: branch.id,
      durationMin,
      at: new Date(now()).toISOString(),
    };

    emit({
      tenantId: ctx.tenantId,
      branchId: branch.id,
      channel: channels.branch(branch.id),
      topic: 'attendance.checked_out',
      payload,
    });
    emit({
      tenantId: ctx.tenantId,
      branchId: branch.id,
      channel: channels.member(member.id),
      topic: 'attendance.checked_out',
      payload,
    });
    emitOccupancy(ctx.tenantId, branch);

    return c.json({
      mode: 'checked_out' as const,
      checkInId: closed.id,
      durationMin,
      branchId: branch.id,
      branchName: branch.name,
      enteredAtLocal: localTime(closed.enteredAt, branch.timezone),
      exitedAtLocal: localTime(now(), branch.timezone),
      at: new Date(now()).toISOString(),
      occupancy: occupancyOf(ctx.tenantId, branch),
    });
  },
);
