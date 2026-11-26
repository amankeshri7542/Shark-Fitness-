import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { BranchState, MembershipState } from '@shark/contracts';
import { branchTrades, decideAccess, isEntitled, occupancyLabel } from '@shark/domain';
import { db, schema } from '../db/client.js';
import type { RequestContext } from '../lib/context.js';
import { notFound } from '../lib/errors.js';
import { issuePassBatch, PASS_WINDOW_SECONDS } from '../lib/pass-token.js';
import { openWindow, policyValue } from '../lib/policy.js';
import { HOUR, MINUTE, localMinutes, now, relativeTime } from '../lib/time.js';
import { reconcileMembershipDates } from './membership-dates.js';
import { memberBranchIds } from './members.js';

/**
 * The member's entry pass (PF-ATT-001/005, UX-M03).
 *
 * The pass carries a short run of signed, single-use 30-second tokens. The
 * phone rotates through them on its own clock, synced to the server's epoch,
 * and fetches a fresh run before the last one ends. A short run, rather than
 * the old ten-minute batch, keeps a copied screen useful for minutes at most,
 * and every token is still burnt on first use at the desk.
 *
 * Which state the member is in decides whether a code is issued at all: a
 * frozen, expired, suspended or cancelled membership gets no code, only the
 * reason and what to do about it. Copy here is the plain register only.
 */

/** Windows issued per fetch: the current one plus five ahead (3 minutes). */
export const PASS_BATCH_WINDOWS = 6;

export type PassState = 'active' | 'grace' | 'frozen' | 'expired' | 'suspended' | 'cancelled' | 'pending' | 'none';

const CODE_STATES: readonly PassState[] = ['active', 'grace'];

function passStateFor(membershipState: string | null): PassState {
  switch (membershipState) {
    case null:
      return 'none';
    case 'active':
    case 'cancel_scheduled':
      return 'active';
    case 'grace':
      return 'grace';
    case 'frozen':
      return 'frozen';
    case 'expired':
      return 'expired';
    case 'suspended':
      return 'suspended';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

/** What the member reads when there is no code to show. Plain, specific, and
 *  always with the next step. */
const STATE_NOTICE: Record<PassState, { title: string; body: string; action: 'billing' | 'reception' | null } | null> = {
  active: null,
  grace: {
    title: 'Payment overdue',
    body: 'Your last payment did not go through. You can still check in while the grace period runs. Pay in Billing to keep your access.',
    action: 'billing',
  },
  frozen: {
    title: 'Membership frozen',
    body: 'Your membership is frozen, so there is no entry code. Reception can unfreeze it, or it restarts on the date in Billing.',
    action: 'billing',
  },
  expired: {
    title: 'Membership ended',
    body: 'Your membership has ended, so there is no entry code. Renew it in Billing or at reception.',
    action: 'billing',
  },
  suspended: {
    title: 'Access on hold',
    body: 'Your access is on hold, so there is no entry code. Please speak to reception.',
    action: 'reception',
  },
  cancelled: {
    title: 'Membership cancelled',
    body: 'Your membership was cancelled, so there is no entry code. Choose a plan in Billing or ask reception.',
    action: 'billing',
  },
  pending: {
    title: 'Membership not started',
    body: 'Your membership starts once the first payment clears. Check Billing for anything still due.',
    action: 'billing',
  },
  none: {
    title: 'No membership yet',
    body: 'You do not have a membership yet. Reception can set one up in a few minutes.',
    action: 'reception',
  },
};

function latestMembership(tenantId: string, memberId: string) {
  return db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.memberId, memberId)))
    .orderBy(desc(schema.memberships.createdAt))
    .get();
}

function insideCount(tenantId: string, branchId: string, atMs: number): number {
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
          gt(schema.checkIns.enteredAt, atMs - 6 * HOUR),
        ),
      )
      .get()?.n ?? 0
  );
}

export function memberPass(ctx: RequestContext, requestedBranchId?: string) {
  const memberId = ctx.memberId;
  if (!memberId) throw notFound('Your membership');
  reconcileMembershipDates(memberId);
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId), isNull(schema.members.deletedAt)))
    .get();
  if (!member) throw notFound('Your membership');

  // Entitled branches are what the door decides on (services/access.ts): home
  // plus every branch the member was added to (PF-ATT-002).
  const entitledIds = memberBranchIds(member);
  const branchRows = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.tenantId, ctx.tenantId), inArray(schema.branches.id, entitledIds)))
    .all();
  const branchId =
    requestedBranchId && entitledIds.includes(requestedBranchId)
      ? requestedBranchId
      : ctx.activeBranchId && entitledIds.includes(ctx.activeBranchId)
        ? ctx.activeBranchId
        : member.homeBranchId;
  if (requestedBranchId && !entitledIds.includes(requestedBranchId)) throw notFound('That branch');
  const branch = branchRows.find((row) => row.id === branchId);
  if (!branch) throw notFound('That branch');

  const atMs = now();
  const epoch = Math.floor(atMs / 1000);
  // The latest term decides: a cancelled latest term means no code, even when
  // an older one exists.
  const membership = latestMembership(ctx.tenantId, memberId);
  const state = passStateFor(membership?.state ?? null);

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
        sql`${schema.invoices.voided} = 0 and ${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`,
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
        gt(schema.checkIns.enteredAt, atMs - 6 * HOUR),
      ),
    )
    .orderBy(desc(schema.checkIns.enteredAt))
    .get();

  const inside = insideCount(ctx.tenantId, branch.id, atMs);
  const hours = openWindow(branch, atMs);
  const graceAllowsEntry = Boolean(policyValue(ctx.tenantId, branch.id, 'graceAllowsEntry', false));

  // Advisory only. The desk re-decides everything when it scans the code.
  const decision =
    membership && isEntitled(membership.state as MembershipState)
      ? decideAccess({
          membershipState: membership.state as MembershipState,
          permittedBranchIds: entitledIds,
          branchId: branch.id,
          branchTrading: branchTrades(branch.state as BranchState),
          nowMinutes: localMinutes(atMs, branch.timezone),
          opensMinutes: hours.openMinutes,
          closesMinutes: hours.closeMinutes,
          windowStartMin: membership.productSnapshot.access.windowStartMin,
          windowEndMin: membership.productSnapshot.access.windowEndMin,
          outstandingMinor: outstanding?.total ?? 0,
          graceAllowsEntry,
          occupancy: inside,
          capacity: branch.capacity,
          tokenValid: true,
          tokenReplayed: false,
          secondsSinceLastCheckIn: null,
          antiPassbackSeconds: 0,
          alreadyInside: Boolean(openSession),
        })
      : null;

  // Grace lets a member in only when the branch allows it. Showing a code the
  // desk will refuse is worse than saying plainly what to do.
  const graceBlocked = state === 'grace' && decision?.decision === 'denied_grace_outstanding';
  const showCode = CODE_STATES.includes(state) && !graceBlocked;
  const notice =
    state === 'grace'
      ? graceBlocked
        ? {
            title: 'Payment overdue',
            body: 'There is an unpaid balance on your account, so there is no entry code. Pay it in Billing or at reception and your code comes back straight away.',
            action: 'billing' as const,
          }
        : {
            ...STATE_NOTICE.grace!,
            body: membership?.graceEndsOn
              ? `Your last payment did not go through. You can still check in until ${membership.graceEndsOn}. Pay in Billing to keep your access.`
              : STATE_NOTICE.grace!.body,
          }
      : STATE_NOTICE[state];

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
  const clock = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);

  return {
    member: { name: `${member.firstName} ${member.lastName}`, memberNo: member.memberNo, initials: member.initials },
    branch: { id: branch.id, name: branch.name, timezone: tz },
    branches: branchRows
      .map((row) => ({ id: row.id, name: row.name, home: row.id === member.homeBranchId }))
      .sort((a, b) => Number(b.home) - Number(a.home) || a.name.localeCompare(b.name)),
    state,
    notice,
    code: showCode
      ? {
          rotateSec: PASS_WINDOW_SECONDS,
          serverEpoch: epoch,
          serverTime: new Date(atMs).toISOString(),
          passes: issuePassBatch(ctx.tenantId, memberId, epoch, PASS_BATCH_WINDOWS),
        }
      : null,
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
    willBeAdmitted: decision?.granted ?? false,
    advisory: decision && !decision.granted ? decision.decision : null,
    openSession: openSession
      ? {
          id: openSession.id,
          enteredAt: new Date(openSession.enteredAt).toISOString(),
          minutesInside: Math.round((atMs - openSession.enteredAt) / MINUTE),
        }
      : null,
    occupancy: { inside, capacity: branch.capacity, label: occupancyLabel(inside, branch.capacity) },
    history: history.map((h) => ({
      id: h.id,
      day: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(h.enteredAt),
      span: h.decision !== 'granted' ? 'Refused' : h.exitedAt ? `${clock(h.enteredAt)} – ${clock(h.exitedAt)}` : 'Inside now',
      granted: h.decision === 'granted',
      branchName: branchNames.get(h.branchId) ?? '',
      relativeTime: relativeTime(h.enteredAt),
    })),
  };
}
