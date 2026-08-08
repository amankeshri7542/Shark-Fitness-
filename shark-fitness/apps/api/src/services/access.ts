import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { DENIAL_COPY, decideAccess, occupancyLabel } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
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
  checkInId: string | null;
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
  allowedBranchSlugs?: string[];
}): ScanResult {
  const verified = verifyPassToken(input.rawToken);
  if (!verified.valid) {
    return deniedToken('denied_token_invalid');
  }

  const { tenantId, memberId, window } = verified.payload;
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, tenantId), isNull(schema.members.deletedAt)))
    .get();
  if (!member) return deniedToken('denied_token_invalid');

  const branch = db
    .select()
    .from(schema.branches)
    .where(and(eq(schema.branches.id, input.branchId), eq(schema.branches.tenantId, tenantId)))
    .get();
  if (!branch) throw notFound('That branch');

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
        sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
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

  const policy = (db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()?.policy ??
    {}) as Record<string, unknown>;

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

  let outcome = decideAccess({
    membershipState: (membership?.state ?? 'expired') as 'active',
    permittedBranchIds,
    branchId: branch.id,
    nowMinutes: localMinutes(now(), branch.timezone),
    opensMinutes: branch.opensMinutes,
    closesMinutes: branch.closesMinutes,
    windowStartMin: membership?.productSnapshot.access.windowStartMin ?? null,
    windowEndMin: membership?.productSnapshot.access.windowEndMin ?? null,
    outstandingMinor: outstanding?.total ?? 0,
    graceAllowsEntry: Boolean(policy.graceAllowsEntry),
    occupancy: inside,
    capacity: branch.capacity,
    tokenValid: true,
    tokenReplayed: alreadyUsed,
    secondsSinceLastCheckIn: lastCheckIn ? Math.round((now() - lastCheckIn.enteredAt) / 1000) : null,
    antiPassbackSeconds: Number(policy.antiPassbackSeconds ?? 90),
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
        method: 'signed_qr',
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

  const auditCtx: RequestContext = {
    requestId: input.actor.requestId,
    sessionId: `reader:${input.actor.name}`,
    authMethod: 'reader',
    tenantId,
    userId: `reader:${input.actor.name}`,
    memberId: null,
    staffId: null,
    role: 'reception',
    name: input.actor.name,
    branchIds: [branch.id],
    activeBranchId: branch.id,
    permissions: [],
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
    impersonatorId: null,
  };

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
    payload: { memberId, memberNo: member.memberNo, decision: outcome.decision, checkInId },
  });

  const nowInside = outcome.granted ? inside + 1 : inside;
  return {
    decision: outcome.decision,
    granted: outcome.granted,
    checkInId: outcome.granted ? checkInId : null,
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

function deniedToken(decision: 'denied_token_invalid' | 'denied_branch_not_permitted'): ScanResult {
  return {
    granted: false,
    decision,
    checkInId: null,
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
