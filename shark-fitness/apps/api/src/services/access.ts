import { reconcileMembershipDates } from './membership-dates.js';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { channels, type BranchState } from '@shark/contracts';
import { DENIAL_COPY, branchTrades, decideAccess, occupancyLabel } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { openWindow, policyValue } from '../lib/policy.js';
import type { RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { verifyPassToken } from '../lib/pass-token.js';
import { HOUR, localMinutes, now } from '../lib/time.js';

export interface ScanActor {
  requestId: string;
  name: string;
  ip: string;
  userAgent: string;
}

export interface ScanResult {
  granted: boolean;
  decision: string;
  /** `admitted`, `already_checked_in` (the same code scanned twice: no second
   *  visit is written) or `denied`. */
  outcome: 'admitted' | 'already_checked_in' | 'denied';
  checkInId: string | null;
  /** The recorded refusal, for the desk's override path (attendance.override). */
  denialCheckInId: string | null;
  overridable: boolean;
  memberId: string | null;
  memberNo: string | null;
  initials: string | null;
  at: string;
  visitNumber: number | null;
  memberName: string | null;
  firstName: string | null;
  branchName: string | null;
  occupancy: { inside: number; capacity: number; label: string } | null;
  message: string | null;
  resolution: { kind: string; amountMinor: number | null; invoiceId: string | null; message: string } | null;
  graceEndsOn: string | null;
}

export function scanSignedPass(input: {
  rawToken: string;
  branchId: string;
  actor: ScanActor;
  allowedTenantSlug?: string;
  allowedBranchSlugs?: string[];
  /** A member of staff scanning at the desk: the code must belong to their
   *  gym, and the audit names them rather than a reader. */
  staff?: RequestContext;
}): ScanResult {
  const verified = verifyPassToken(input.rawToken);
  const staff = input.staff;

  if (!verified.valid && verified.reason !== 'expired') {
    if (staff) auditEarlyDenial(staff, input.branchId, 'denied_token_invalid', null);
    return deniedToken('denied_token_invalid');
  }

  const { tenantId, memberId, window } = verified.payload;

  // A genuine code from another gym. Said plainly, without naming its owner or
  // recording a visit in either gym.
  if (staff && tenantId !== staff.tenantId) {
    auditEarlyDenial(staff, input.branchId, 'denied_wrong_tenant', null);
    return deniedToken('denied_wrong_tenant');
  }

  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, tenantId), isNull(schema.members.deletedAt)))
    .get();
  if (!member) {
    if (staff) auditEarlyDenial(staff, input.branchId, 'denied_token_invalid', null);
    return deniedToken('denied_token_invalid');
  }

  const branch = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.id, input.branchId), eq(schema.branches.tenantId, tenantId)))
    .get();
  if (!branch) throw notFound('That branch');

  const tenant = db
    .select({ slug: schema.tenants.slug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .get();
  if (
    input.allowedTenantSlug &&
    input.allowedTenantSlug !== '*' &&
    input.allowedTenantSlug !== tenant?.slug
  ) {
    return deniedToken('denied_branch_not_permitted');
  }

  if (
    input.allowedBranchSlugs &&
    !input.allowedBranchSlugs.includes('*') &&
    !input.allowedBranchSlugs.includes(branch.slug)
  ) {
    return deniedToken('denied_branch_not_permitted');
  }

  const extraBranches = db
    .select({ branchId: schema.memberBranches.branchId })
    .from(schema.memberBranches)
    .where(eq(schema.memberBranches.memberId, memberId))
    .all()
    .map((row) => row.branchId);
  const permittedBranchIds = [...new Set([member.homeBranchId, ...extraBranches])];

  reconcileMembershipDates(memberId);
  const membership = db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.tenantId, tenantId),
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
        eq(schema.invoices.tenantId, tenantId),
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
        eq(schema.checkIns.tenantId, tenantId),
        eq(schema.checkIns.memberId, memberId),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, now() - 6 * HOUR),
      ),
    )
    .get();

  const inside = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, tenantId),
        eq(schema.checkIns.branchId, branch.id),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, now() - 6 * HOUR),
      ),
    )
    .get()?.n ?? 0;

  const lastCheckIn = db
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

  // Branch-resolved, not tenant-wide. Door hardware differs by site, and the
  // settings screen lets a branch override both of these (PF-TEN-003).
  const hours = openWindow(branch, now());
  const graceAllowsEntry = policyValue(tenantId, branch.id, 'graceAllowsEntry', false);
  const antiPassbackSeconds = policyValue(tenantId, branch.id, 'antiPassbackSeconds', 90);

  const alreadyUsed = Boolean(
    db
      .select({ id: schema.usedAccessWindows.id })
      .from(schema.usedAccessWindows)
      .where(
        and(
          eq(schema.usedAccessWindows.tenantId, tenantId),
          eq(schema.usedAccessWindows.memberId, memberId),
          eq(schema.usedAccessWindows.window, window),
        ),
      )
      .get(),
  );

  // The same code scanned twice at the desk (a double tap, a slow screen, a
  // wedge scanner that fires twice): the first scan already admitted them on
  // this window, so say so and write nothing new (PRD 01 §6.2 "Double scan
  // creates one attendance event").
  // At the desk, a member already inside this branch is never admitted twice:
  // the same code scanned again (a double tap, a wedge scanner firing twice)
  // or a fresh one shown a minute later both read "Already checked in", and
  // nothing new is written (PRD 01 §6.2 "Double scan creates one attendance
  // event"). The code is not burnt, so it stays usable for a real entry later.
  // The door reader keeps its own rules (a burnt window reads as replayed).
  if (staff && verified.valid && openSession && openSession.branchId === branch.id) {
    audit(staff, {
      action: 'attendance.scan_duplicate',
      entityType: 'member',
      entityId: memberId,
      entityLabel: member.memberNo,
      reason: 'already_checked_in',
      branchId: branch.id,
      after: { checkInId: openSession.id },
    });
    return {
      decision: 'granted',
      granted: true,
      outcome: 'already_checked_in',
      checkInId: openSession.id,
      denialCheckInId: null,
      overridable: false,
      memberId,
      memberNo: member.memberNo,
      initials: member.initials,
      at: new Date(openSession.enteredAt).toISOString(),
      visitNumber: openSession.visitNumber,
      memberName: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      branchName: branch.name,
      occupancy: { inside, capacity: branch.capacity, label: occupancyLabel(inside, branch.capacity) },
      message: 'Already checked in.',
      resolution: null,
      graceEndsOn: membership?.graceEndsOn ?? null,
    };
  }

  let outcome = !verified.valid
    ? // Expired but genuine: the member is known, the code is not usable.
      { decision: 'denied_token_expired' as const, granted: false, overridable: true }
    : decideAccess({
        membershipState: (membership?.state ?? 'expired') as 'active',
        permittedBranchIds,
        branchId: branch.id,
        branchTrading: branchTrades(branch.state as BranchState),
        nowMinutes: localMinutes(now(), branch.timezone),
        // The day's own hours where the branch sets them, the branch's typical
        // day otherwise, and a holiday closes the door outright (PF-TEN-002).
        opensMinutes: hours.openMinutes,
        closesMinutes: hours.closeMinutes,
        windowStartMin: membership?.productSnapshot.access.windowStartMin ?? null,
        windowEndMin: membership?.productSnapshot.access.windowEndMin ?? null,
        outstandingMinor: outstanding?.total ?? 0,
        graceAllowsEntry: Boolean(graceAllowsEntry),
        occupancy: inside,
        capacity: branch.capacity,
        tokenValid: true,
        tokenReplayed: alreadyUsed,
        secondsSinceLastCheckIn: lastCheckIn ? Math.round((now() - lastCheckIn.enteredAt) / 1000) : null,
        antiPassbackSeconds: Number(antiPassbackSeconds),
        alreadyInside: Boolean(openSession),
      });

  const checkInId = id('chk');
  let visitNumber: number | null = null;

  transact(() => {
    if (outcome.granted) {
      const burned = db
        .insert(schema.usedAccessWindows)
        .values({ id: id('uaw'), tenantId, memberId, window, usedAt: now() })
        .onConflictDoNothing()
        .run();

      if (burned.changes === 0) {
        outcome = { decision: 'denied_token_replayed', granted: false, overridable: false };
      } else {
        const visits = db
          .select({ n: sql<number>`count(*)` })
          .from(schema.checkIns)
          .where(
            and(
              eq(schema.checkIns.tenantId, tenantId),
              eq(schema.checkIns.memberId, memberId),
              eq(schema.checkIns.decision, 'granted'),
            ),
          )
          .get();
        visitNumber = (visits?.n ?? 0) + 1;
        db.update(schema.members).set({ lastVisitAt: now() }).where(eq(schema.members.id, memberId)).run();
      }
    }

    db.insert(schema.checkIns)
      .values({
        id: checkInId,
        tenantId,
        branchId: branch.id,
        memberId,
        method: staff ? 'qr' : 'signed_qr',
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

  const auditCtx: RequestContext = staff ?? readerContext(input.actor, tenantId, branch.id);

  audit(auditCtx, {
    action: outcome.granted ? 'attendance.checked_in' : 'attendance.denied',
    entityType: 'member',
    entityId: memberId,
    entityLabel: member.memberNo,
    reason: outcome.granted ? null : outcome.decision,
    branchId: branch.id,
  });

  emit({
    tenantId,
    branchId: branch.id,
    channel: channels.branch(branch.id),
    topic: outcome.granted ? 'attendance.checked_in' : 'attendance.denied',
    payload: { memberId, memberNo: member.memberNo, decision: outcome.decision, checkInId, source: staff ? 'desk_scan' : 'door' },
  });
  if (outcome.granted) {
    emit({
      tenantId,
      branchId: branch.id,
      channel: channels.member(memberId),
      topic: 'attendance.checked_in',
      payload: { checkInId, branchName: branch.name },
    });
  }

  const nowInside = outcome.granted ? inside + 1 : inside;
  return {
    decision: outcome.decision,
    granted: outcome.granted,
    outcome: outcome.granted ? 'admitted' : 'denied',
    checkInId: outcome.granted ? checkInId : null,
    denialCheckInId: outcome.granted ? null : checkInId,
    overridable: !outcome.granted && outcome.overridable,
    memberId,
    memberNo: member.memberNo,
    initials: member.initials,
    at: new Date(now()).toISOString(),
    visitNumber,
    memberName: `${member.firstName} ${member.lastName}`,
    firstName: member.firstName,
    branchName: branch.name,
    occupancy: {
      inside: nowInside,
      capacity: branch.capacity,
      label: occupancyLabel(nowInside, branch.capacity),
    },
    message: outcome.granted ? null : DENIAL_COPY[outcome.decision as keyof typeof DENIAL_COPY],
    resolution:
      !outcome.granted &&
      (outcome.decision === 'denied_grace_outstanding' || outcome.decision === 'denied_membership_inactive')
        ? {
            kind: (outstanding?.total ?? 0) > 0 ? 'pay_outstanding' : 'contact_reception',
            amountMinor: outstanding?.total ?? null,
            invoiceId: outstanding?.firstId ?? null,
            message:
              (outstanding?.total ?? 0) > 0
                ? 'Settling the balance restores access immediately.'
                : 'Reception can sort this out in a minute.',
          }
        : null,
    graceEndsOn: membership?.graceEndsOn ?? null,
  };
}

function deniedToken(decision: 'denied_token_invalid' | 'denied_branch_not_permitted' | 'denied_wrong_tenant'): ScanResult {
  return {
    granted: false,
    decision,
    outcome: 'denied',
    checkInId: null,
    denialCheckInId: null,
    overridable: false,
    memberId: null,
    memberNo: null,
    initials: null,
    at: new Date(now()).toISOString(),
    visitNumber: null,
    memberName: null,
    firstName: null,
    branchName: null,
    occupancy: null,
    message: DENIAL_COPY[decision],
    resolution: null,
    graceEndsOn: null,
  };
}

function readerContext(actor: ScanActor, tenantId: string, branchId: string): RequestContext {
  return {
    requestId: actor.requestId,
    sessionId: `reader:${actor.name}`,
    authMethod: 'reader',
    tenantId,
    userId: `reader:${actor.name}`,
    memberId: null,
    staffId: null,
    role: 'reception',
    name: actor.name,
    branchIds: [branchId],
    activeBranchId: branchId,
    permissions: [],
    ip: actor.ip,
    userAgent: actor.userAgent,
    impersonatorId: null,
  };
}

/** A refusal decided before any member is known (forged, unreadable or another
 *  gym's code) is still a decision at the desk, and is audited as one. */
function auditEarlyDenial(staff: RequestContext, branchId: string, decision: string, memberId: string | null): void {
  audit(staff, {
    action: 'attendance.denied',
    entityType: 'pass',
    entityId: memberId ?? 'unidentified',
    reason: decision,
    branchId,
  });
}
