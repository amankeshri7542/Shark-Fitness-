import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { db, schema, transact } from '../db/client.js';
import { requirePermission, type RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, isoDate, now } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';

/**
 * Data-subject requests (PF-COMP).
 *
 * `POST /me/data-export` and `POST /me/deletion-request` were truthful and
 * were not a workflow: they wrote an audit row, flipped an account state, and
 * told the member honestly that a person would have to do the rest by hand.
 * Nothing recorded the request as a thing with a state, so there was no queue,
 * no clock, and no answer to "did we ever deal with that?" short of searching
 * the audit log.
 *
 * What this module will and will not do, stated plainly because the difference
 * is the whole design:
 *
 * **It will** keep the request as a row with a lifecycle and timestamps, check
 * legal holds before anything destructive, evaluate the tenant's retention
 * policy, build the export package as an internal artifact with a checksum,
 * compute a deterministic anonymisation plan, and execute that plan.
 *
 * **It will not** send anything anywhere. There is no email provider and no
 * object storage. The export exists inside the database and is handed over by
 * whoever hands it over, and the member is told exactly that rather than being
 * promised a download link that nothing would ever produce.
 *
 * **It will never delete accounting or audit evidence.** Erasure here is
 * pseudonymisation: the personal details are overwritten in place and the
 * invoices, payments, check-ins and audit rows keep pointing at a subject who
 * can no longer be identified from them. Deleting those rows would destroy the
 * gym's own books, and in most jurisdictions the obligation to keep them
 * outranks the right to have them erased. `audit_log` could not be deleted
 * anyway — a trigger refuses — and that is deliberate rather than incidental.
 */

export type PrivacyRequestRow = typeof schema.privacyRequests.$inferSelect;

/** Personal fields on `members` that erasure overwrites, and what with.
 *
 *  Listed rather than computed so the plan is reviewable before it runs, and
 *  so adding a column to `members` does not silently change what erasure does.
 */
const MEMBER_PII_FIELDS = [
  'firstName',
  'lastName',
  'initials',
  'email',
  'phone',
  'phoneNormalized',
  'emailNormalized',
  'dob',
  'gender',
  'addressLine',
  'emergencyContact',
] as const;

const USER_PII_FIELDS = ['name', 'initials', 'email', 'phone'] as const;

/**
 * Records that are kept whatever a member asks, and why.
 *
 * Not a policy toggle. Each of these is either the gym's statutory bookkeeping
 * or the evidence trail that makes the bookkeeping checkable, and a system
 * that let a request erase them would be destroying what it exists to protect.
 */
export const PRESERVED_RECORDS = [
  { table: 'invoices', reason: 'Statutory accounting record. Retained, with the subject pseudonymised.' },
  { table: 'payments', reason: 'Statutory accounting record. Retained, with the subject pseudonymised.' },
  { table: 'refunds', reason: 'Statutory accounting record. Retained, with the subject pseudonymised.' },
  { table: 'pos_orders', reason: 'Statutory accounting record. Retained, with the subject pseudonymised.' },
  { table: 'commission_lines', reason: 'Payroll evidence for staff, not subject data.' },
  { table: 'audit_log', reason: 'Append-only by database trigger. Cannot be edited or deleted by anyone.' },
  { table: 'consents', reason: 'Evidence of what was agreed and when. Erasing it erases the proof of lawful basis.' },
  { table: 'memberships', reason: 'Contract history behind the accounting. Retained, pseudonymised.' },
  { table: 'check_ins', reason: 'Attendance and safety record. Retained, pseudonymised.' },
] as const;

/* ============================================================================
   Legal holds
   ========================================================================= */

/** The live hold on a subject, if any. A released hold does not block. */
export function activeLegalHold(tenantId: string, subjectUserId: string) {
  return (
    db
      .select()
      .from(schema.legalHolds)
      .where(
        and(
          eq(schema.legalHolds.tenantId, tenantId),
          eq(schema.legalHolds.subjectUserId, subjectUserId),
          isNull(schema.legalHolds.releasedAt),
        ),
      )
      .get() ?? null
  );
}

export function placeLegalHold(
  ctx: RequestContext,
  input: { subjectUserId: string; reason: string; reference: string | null },
) {
  requirePermission(ctx, 'settings.manage');
  const atMs = now();
  const reason = input.reason.trim();
  if (reason.length < 4) throw invalid('A legal hold needs a reason of at least 4 characters.');

  const subject = db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, input.subjectUserId), eq(schema.users.tenantId, ctx.tenantId)))
    .get();
  if (!subject) throw notFound('That person');

  const existing = activeLegalHold(ctx.tenantId, input.subjectUserId);
  if (existing) throw precondition('That person is already under a legal hold.');

  const member = db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(and(eq(schema.members.userId, input.subjectUserId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();

  const holdId = id('hold');
  transact(() => {
    db.insert(schema.legalHolds)
      .values({
        id: holdId,
        tenantId: ctx.tenantId,
        subjectUserId: input.subjectUserId,
        subjectMemberId: member?.id ?? null,
        reason,
        reference: input.reference,
        placedByUserId: ctx.userId,
        placedAt: atMs,
        releasedAt: null,
        releasedByUserId: null,
        releaseReason: null,
      })
      .run();

    // Any deletion request already in flight stops here rather than racing the
    // hold. `on_hold` is its own state so a queue cannot show it as merely slow.
    db.update(schema.privacyRequests)
      .set({ state: 'on_hold', updatedAt: atMs })
      .where(
        and(
          eq(schema.privacyRequests.tenantId, ctx.tenantId),
          eq(schema.privacyRequests.subjectUserId, input.subjectUserId),
          eq(schema.privacyRequests.kind, 'deletion'),
          ne(schema.privacyRequests.state, 'completed'),
        ),
      )
      .run();

    audit(ctx, {
      action: 'legal_hold.placed',
      entityType: 'user',
      entityId: input.subjectUserId,
      entityLabel: subject.name,
      reason,
      after: { holdId, reference: input.reference },
    });
  });

  return { holdId, blockedDeletionRequests: true };
}

export function releaseLegalHold(ctx: RequestContext, holdId: string, releaseReason: string) {
  requirePermission(ctx, 'settings.manage');
  const atMs = now();
  const reason = releaseReason.trim();
  if (reason.length < 4) throw invalid('Releasing a legal hold needs a reason of at least 4 characters.');

  const hold = db
    .select()
    .from(schema.legalHolds)
    .where(and(eq(schema.legalHolds.id, holdId), eq(schema.legalHolds.tenantId, ctx.tenantId)))
    .get();
  if (!hold) throw notFound('That legal hold');
  if (hold.releasedAt !== null) throw precondition('That hold has already been released.');

  transact(() => {
    db.update(schema.legalHolds)
      .set({ releasedAt: atMs, releasedByUserId: ctx.userId, releaseReason: reason })
      .where(eq(schema.legalHolds.id, holdId))
      .run();

    // Requests go back to `in_review`, not to `completed`. Releasing a hold
    // unblocks a decision; it does not make one.
    db.update(schema.privacyRequests)
      .set({ state: 'in_review', updatedAt: atMs })
      .where(
        and(
          eq(schema.privacyRequests.tenantId, ctx.tenantId),
          eq(schema.privacyRequests.subjectUserId, hold.subjectUserId),
          eq(schema.privacyRequests.state, 'on_hold'),
        ),
      )
      .run();

    audit(ctx, {
      action: 'legal_hold.released',
      entityType: 'user',
      entityId: hold.subjectUserId,
      reason,
      before: { holdId, active: true },
      after: { holdId, active: false },
    });
  });

  return { ok: true as const };
}

export function listLegalHolds(ctx: RequestContext) {
  requirePermission(ctx, 'settings.manage');
  return {
    holds: db
      .select({ hold: schema.legalHolds, subjectName: schema.users.name })
      .from(schema.legalHolds)
      .innerJoin(schema.users, eq(schema.users.id, schema.legalHolds.subjectUserId))
      .where(eq(schema.legalHolds.tenantId, ctx.tenantId))
      .orderBy(desc(schema.legalHolds.placedAt))
      .all()
      .map((row) => ({ ...row.hold, subjectName: row.subjectName })),
  };
}

/* ============================================================================
   Requests
   ========================================================================= */

/**
 * Record a request. Called by the member's own endpoints and by the console on
 * a member's behalf.
 *
 * An open request of the same kind is returned rather than duplicated: a
 * member pressing the button twice has asked once.
 */
export function submitPrivacyRequest(
  ctx: { tenantId: string; userId: string; requestId?: string },
  input: { subjectUserId: string; kind: 'export' | 'deletion'; reason: string | null },
): { requestId: string; created: boolean; state: string } {
  const atMs = now();
  const subject = db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, input.subjectUserId), eq(schema.users.tenantId, ctx.tenantId)))
    .get();
  if (!subject) throw notFound('That person');

  const open = db
    .select()
    .from(schema.privacyRequests)
    .where(
      and(
        eq(schema.privacyRequests.tenantId, ctx.tenantId),
        eq(schema.privacyRequests.subjectUserId, input.subjectUserId),
        eq(schema.privacyRequests.kind, input.kind),
        ne(schema.privacyRequests.state, 'completed'),
        ne(schema.privacyRequests.state, 'refused'),
      ),
    )
    .get();
  if (open) return { requestId: open.id, created: false, state: open.state };

  const member = db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(and(eq(schema.members.userId, input.subjectUserId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();

  // A hold does not refuse the request — the member is entitled to ask — but
  // a deletion arrives already blocked, and the queue says so.
  const hold = activeLegalHold(ctx.tenantId, input.subjectUserId);
  const state = input.kind === 'deletion' && hold ? 'on_hold' : 'submitted';

  const requestId = id('dsr');
  db.insert(schema.privacyRequests)
    .values({
      id: requestId,
      tenantId: ctx.tenantId,
      subjectUserId: input.subjectUserId,
      subjectMemberId: member?.id ?? null,
      kind: input.kind,
      state,
      requestedByUserId: ctx.userId,
      reason: input.reason,
      submittedAt: atMs,
      reviewedAt: null,
      reviewedByUserId: null,
      completedAt: null,
      completedByUserId: null,
      outcomeNote: null,
      artifactId: null,
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();

  return { requestId, created: true, state };
}

function loadRequest(ctx: RequestContext, requestId: string): PrivacyRequestRow {
  const request = db
    .select()
    .from(schema.privacyRequests)
    .where(and(eq(schema.privacyRequests.id, requestId), eq(schema.privacyRequests.tenantId, ctx.tenantId)))
    .get();
  if (!request) throw notFound('That request');
  return request;
}

export function listPrivacyRequests(ctx: RequestContext, query: { state?: string } = {}) {
  requirePermission(ctx, 'settings.manage');
  const rows = db
    .select({ request: schema.privacyRequests, subjectName: schema.users.name })
    .from(schema.privacyRequests)
    .innerJoin(schema.users, eq(schema.users.id, schema.privacyRequests.subjectUserId))
    .where(
      and(
        eq(schema.privacyRequests.tenantId, ctx.tenantId),
        query.state ? eq(schema.privacyRequests.state, query.state) : undefined,
      ),
    )
    .orderBy(asc(schema.privacyRequests.submittedAt))
    .all();

  return {
    requests: rows.map((row) => ({
      ...row.request,
      subjectName: row.subjectName,
      onLegalHold: activeLegalHold(ctx.tenantId, row.request.subjectUserId) !== null,
    })),
    /** Said on the queue itself, not only in the member's message. */
    deliveryNote:
      'This system produces the export as an internal record. It does not email it or upload it anywhere — handing it to the member is a manual step.',
  };
}

/* ============================================================================
   Retention
   ========================================================================= */

export interface RetentionEvaluation {
  retentionDays: number;
  jurisdiction: string | null;
  /** The last day any subject record must be kept until, in branch-local
   *  terms. Null when the member is still active — retention runs from the
   *  end of the relationship, not from the request. */
  retainUntil: string | null;
  relationshipEndedOn: string | null;
  /** True when erasure would destroy something still inside its window. */
  withinRetentionWindow: boolean;
  preserved: typeof PRESERVED_RECORDS;
}

/**
 * What the tenant's own retention policy says about this subject.
 *
 * Evaluated rather than enforced: the policy is the gym's, the decision is a
 * person's, and the job of this function is to make sure that person is not
 * making it blind. A member still training has no retention end date at all,
 * which is itself the answer.
 */
export function evaluateRetention(tenantId: string, subjectMemberId: string | null): RetentionEvaluation {
  const tenant = db
    .select({ dataProcessing: schema.tenants.dataProcessing })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .get();
  const retentionDays = Number(tenant?.dataProcessing?.retentionDays ?? 1095);
  const jurisdiction = (tenant?.dataProcessing?.jurisdiction as string | undefined) ?? null;

  if (!subjectMemberId) {
    return {
      retentionDays,
      jurisdiction,
      retainUntil: null,
      relationshipEndedOn: null,
      withinRetentionWindow: false,
      preserved: PRESERVED_RECORDS,
    };
  }

  const member = db
    .select()
    .from(schema.members)
    .where(eq(schema.members.id, subjectMemberId))
    .get();
  if (!member) {
    return {
      retentionDays,
      jurisdiction,
      retainUntil: null,
      relationshipEndedOn: null,
      withinRetentionWindow: false,
      preserved: PRESERVED_RECORDS,
    };
  }

  const tz = branchTimeZone(tenantId, member.homeBranchId);

  // The relationship ends when the last membership does. A member with a live
  // membership has not left, so the clock has not started.
  const memberships = db
    .select()
    .from(schema.memberships)
    .where(eq(schema.memberships.memberId, subjectMemberId))
    .all();
  const live = memberships.some((row) => row.state === 'active' || row.state === 'frozen');
  const lastEnd = memberships
    .map((row) => row.endsOn)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

  const relationshipEndedOn = live ? null : lastEnd;
  const retainUntil = relationshipEndedOn
    ? isoDate(Date.parse(`${relationshipEndedOn}T00:00:00Z`) + retentionDays * DAY, tz)
    : null;

  return {
    retentionDays,
    jurisdiction,
    retainUntil,
    relationshipEndedOn,
    withinRetentionWindow: retainUntil !== null && isoDate(now(), tz) < retainUntil,
    preserved: PRESERVED_RECORDS,
  };
}

/* ============================================================================
   The anonymisation plan
   ========================================================================= */

export interface AnonymisationPlan {
  subjectUserId: string;
  subjectMemberId: string | null;
  /** Exactly what would be overwritten, field by field, with the value it
   *  would be overwritten with. Deterministic: the same subject produces the
   *  same plan every time it is computed, so a reviewer approves the thing
   *  that will actually run. */
  overwrites: Array<{ table: string; recordId: string; field: string; to: string | null }>;
  /** Rows that keep pointing at the subject, and why they are not deleted. */
  preserved: typeof PRESERVED_RECORDS;
  /** Anything that stops this running right now. */
  blockers: string[];
  pseudonym: string;
}

/**
 * A stable pseudonym for a subject.
 *
 * Derived from the id so the same person is the same "Former member 4f2a"
 * across every record and across repeated runs — which is what keeps an
 * invoice and a check-in recognisably the same anonymous person to an auditor,
 * without either being traceable back to a name.
 */
export function pseudonymFor(subjectUserId: string): string {
  return `Former member ${createHash('sha256').update(subjectUserId).digest('hex').slice(0, 6)}`;
}

export function anonymisationPlan(
  tenantId: string,
  subjectUserId: string,
  subjectMemberId: string | null,
): AnonymisationPlan {
  const pseudonym = pseudonymFor(subjectUserId);
  const overwrites: AnonymisationPlan['overwrites'] = [];
  const blockers: string[] = [];

  const hold = activeLegalHold(tenantId, subjectUserId);
  if (hold) blockers.push(`Legal hold in force: ${hold.reason}`);

  const retention = evaluateRetention(tenantId, subjectMemberId);
  if (retention.withinRetentionWindow) {
    blockers.push(
      `The tenant's retention policy keeps this record until ${retention.retainUntil} (${retention.retentionDays} days after the membership ended).`,
    );
  }

  const user = db.select().from(schema.users).where(eq(schema.users.id, subjectUserId)).get();
  if (user) {
    for (const field of USER_PII_FIELDS) {
      const to = field === 'name' ? pseudonym : field === 'initials' ? 'FM' : null;
      if (user[field] !== to) overwrites.push({ table: 'users', recordId: user.id, field, to });
    }
  }

  if (subjectMemberId) {
    const member = db.select().from(schema.members).where(eq(schema.members.id, subjectMemberId)).get();
    if (member) {
      for (const field of MEMBER_PII_FIELDS) {
        const to =
          field === 'firstName'
            ? pseudonym
            : field === 'lastName'
              ? ''
              : field === 'initials'
                ? 'FM'
                : null;
        overwrites.push({ table: 'members', recordId: member.id, field, to });
      }
    }
  }

  return { subjectUserId, subjectMemberId, overwrites, preserved: PRESERVED_RECORDS, blockers, pseudonym };
}

/* ============================================================================
   The export package
   ========================================================================= */

/**
 * Build the subject's data as one structured document.
 *
 * Produced into `privacy_artifacts` with a checksum. Not written to disk and
 * not uploaded: there is nowhere to upload it to, and a download link to
 * nothing would be a worse answer than the honest one.
 */
export function generateExportPackage(ctx: RequestContext, requestId: string) {
  requirePermission(ctx, 'settings.manage');
  const atMs = now();
  const request = loadRequest(ctx, requestId);
  if (request.kind !== 'export') throw invalid('That request is not an export request.');
  if (request.state === 'refused') throw precondition('That request was refused.');

  const user = db.select().from(schema.users).where(eq(schema.users.id, request.subjectUserId)).get();
  if (!user) throw notFound('That person');

  const member = request.subjectMemberId
    ? db.select().from(schema.members).where(eq(schema.members.id, request.subjectMemberId)).get()
    : null;

  const payload: Record<string, unknown> = {
    generatedAt: new Date(atMs).toISOString(),
    subject: {
      userId: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      accountState: user.accountState,
      createdAt: new Date(user.createdAt).toISOString(),
    },
    consents: db
      .select()
      .from(schema.consents)
      .where(eq(schema.consents.userId, user.id))
      .all(),
    notifications: db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, user.id))
      .all(),
  };

  if (member) {
    payload.member = {
      memberId: member.id,
      memberNo: member.memberNo,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phone: member.phone,
      dob: member.dob,
      gender: member.gender,
      addressLine: member.addressLine,
      emergencyContact: member.emergencyContact,
      homeBranchId: member.homeBranchId,
      lifecycle: member.lifecycle,
      joinedOn: new Date(member.createdAt).toISOString(),
    };
    payload.memberships = db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.memberId, member.id))
      .all();
    payload.invoices = db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.memberId, member.id))
      .all();
    payload.payments = db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.memberId, member.id))
      .all();
    payload.checkIns = db
      .select()
      .from(schema.checkIns)
      .where(eq(schema.checkIns.memberId, member.id))
      .all();
    payload.bookings = db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.memberId, member.id))
      .all();
    payload.measurements = db
      .select()
      .from(schema.measurements)
      .where(eq(schema.measurements.memberId, member.id))
      .all();
    payload.workouts = db
      .select()
      .from(schema.workouts)
      .where(eq(schema.workouts.memberId, member.id))
      .all();
  }

  // Stated inside the package, so the document itself is honest about what it
  // is and how it reached whoever is reading it.
  payload.notice = {
    producedBy: 'Shark Fitness, internally',
    delivery:
      'This package was generated inside the gym’s own system. It was not emailed and not uploaded anywhere; it is handed over by the privacy contact.',
    omitted:
      'Records belonging to other people, and internal staff notes about safety or disputes, are not included.',
  };

  const serialised = JSON.stringify(payload);
  const checksum = createHash('sha256').update(serialised).digest('hex');
  const artifactId = id('pka');

  transact(() => {
    db.insert(schema.privacyArtifacts)
      .values({
        id: artifactId,
        tenantId: ctx.tenantId,
        requestId,
        format: 'json',
        payload,
        byteSize: Buffer.byteLength(serialised, 'utf8'),
        checksum,
        generatedByUserId: ctx.userId,
        generatedAt: atMs,
      })
      .run();

    db.update(schema.privacyRequests)
      .set({
        artifactId,
        state: 'in_review',
        reviewedAt: request.reviewedAt ?? atMs,
        reviewedByUserId: request.reviewedByUserId ?? ctx.userId,
        updatedAt: atMs,
      })
      .where(eq(schema.privacyRequests.id, requestId))
      .run();

    audit(ctx, {
      action: 'privacy.export_generated',
      entityType: 'privacy_request',
      entityId: requestId,
      entityLabel: user.name,
      after: { artifactId, checksum, byteSize: Buffer.byteLength(serialised, 'utf8') },
    });
  });

  return {
    artifactId,
    checksum,
    byteSize: Buffer.byteLength(serialised, 'utf8'),
    /** The one thing this system cannot do, said where somebody will read it. */
    delivery: {
      sent: false,
      reason: 'no_delivery_provider_configured',
      message:
        'The package exists inside this system. There is no email or storage provider connected, so handing it to the member is a manual step.',
    },
  };
}

export function readExportPackage(ctx: RequestContext, requestId: string) {
  requirePermission(ctx, 'settings.manage');
  const request = loadRequest(ctx, requestId);
  if (!request.artifactId) throw notFound('An export package for that request');

  const artifact = db
    .select()
    .from(schema.privacyArtifacts)
    .where(eq(schema.privacyArtifacts.id, request.artifactId))
    .get();
  if (!artifact) throw notFound('That export package');

  audit(ctx, {
    action: 'privacy.export_read',
    entityType: 'privacy_request',
    entityId: requestId,
    after: { artifactId: artifact.id },
  });

  return artifact;
}

/* ============================================================================
   Review and completion
   ========================================================================= */

export function reviewPrivacyRequest(
  ctx: RequestContext,
  requestId: string,
  input: { decision: 'accept' | 'refuse'; note: string },
) {
  requirePermission(ctx, 'settings.manage');
  const atMs = now();
  const note = input.note.trim();
  if (note.length < 4) throw invalid('A decision needs a note of at least 4 characters.');

  const request = loadRequest(ctx, requestId);
  if (request.state === 'completed') throw precondition('That request is already completed.');
  if (request.state === 'on_hold') {
    throw precondition('That request is blocked by a legal hold. Release the hold before deciding it.');
  }

  const nextState = input.decision === 'refuse' ? 'refused' : 'in_review';

  transact(() => {
    db.update(schema.privacyRequests)
      .set({
        state: nextState,
        reviewedAt: atMs,
        reviewedByUserId: ctx.userId,
        outcomeNote: note,
        ...(input.decision === 'refuse' ? { completedAt: atMs, completedByUserId: ctx.userId } : {}),
        updatedAt: atMs,
      })
      .where(eq(schema.privacyRequests.id, requestId))
      .run();

    audit(ctx, {
      action: input.decision === 'refuse' ? 'privacy.request_refused' : 'privacy.request_accepted',
      entityType: 'privacy_request',
      entityId: requestId,
      reason: note,
      before: { state: request.state },
      after: { state: nextState },
    });
  });

  return { state: nextState };
}

export interface ErasureResult {
  requestId: string;
  applied: number;
  pseudonym: string;
  preserved: typeof PRESERVED_RECORDS;
}

/**
 * Execute the anonymisation plan.
 *
 * Refuses outright while a legal hold is in force, and refuses while the
 * tenant's own retention window still covers the record — a member cannot ask
 * a gym to break its own bookkeeping obligation, and the reason is returned so
 * the operator can answer them.
 *
 * What runs is exactly the plan that was computed, so a reviewer who read the
 * plan approved the thing that happened.
 */
export function applyErasure(ctx: RequestContext, requestId: string): ErasureResult {
  requirePermission(ctx, 'settings.manage');
  const atMs = now();
  const request = loadRequest(ctx, requestId);
  if (request.kind !== 'deletion') throw invalid('That request is not a deletion request.');
  if (request.state === 'completed') throw precondition('That request is already completed.');
  if (request.state === 'refused') throw precondition('That request was refused.');

  const plan = anonymisationPlan(ctx.tenantId, request.subjectUserId, request.subjectMemberId);
  if (plan.blockers.length > 0) {
    // A precondition, not a validation failure: the request is well formed and
    // the world is not ready for it.
    throw precondition(plan.blockers.join(' '));
  }

  let applied = 0;

  transact(() => {
    // Overwrite in place. Nothing is deleted, so every invoice, payment,
    // check-in and audit row keeps its foreign key and stops identifying
    // anybody. The audit trail could not be deleted regardless — a trigger
    // refuses — and that is the point rather than an obstacle.
    const userPatch: Record<string, unknown> = { updatedAt: atMs };
    const memberPatch: Record<string, unknown> = { updatedAt: atMs };
    for (const overwrite of plan.overwrites) {
      if (overwrite.table === 'users') userPatch[overwrite.field] = overwrite.to;
      if (overwrite.table === 'members') memberPatch[overwrite.field] = overwrite.to;
      applied += 1;
    }

    db.update(schema.users)
      .set({ ...userPatch, accountState: 'erased' })
      .where(eq(schema.users.id, request.subjectUserId))
      .run();

    if (request.subjectMemberId) {
      db.update(schema.members)
        .set(memberPatch)
        .where(eq(schema.members.id, request.subjectMemberId))
        .run();
    }

    // Every session goes. An erased account must not stay signed in anywhere.
    db.update(schema.sessions)
      .set({ revokedAt: atMs })
      .where(and(eq(schema.sessions.userId, request.subjectUserId), isNull(schema.sessions.revokedAt)))
      .run();

    db.update(schema.privacyRequests)
      .set({
        state: 'completed',
        completedAt: atMs,
        completedByUserId: ctx.userId,
        updatedAt: atMs,
      })
      .where(eq(schema.privacyRequests.id, requestId))
      .run();

    audit(ctx, {
      action: 'privacy.erasure_applied',
      entityType: 'privacy_request',
      entityId: requestId,
      after: {
        pseudonym: plan.pseudonym,
        fieldsOverwritten: applied,
        // Written onto the audit row so the record of the erasure states what
        // was kept, not only what was removed.
        preserved: PRESERVED_RECORDS.map((row) => row.table).join(', '),
      },
    });
  });

  return { requestId, applied, pseudonym: plan.pseudonym, preserved: PRESERVED_RECORDS };
}

/** Everything a reviewer needs on one screen before deciding. */
export function privacyRequestDetail(ctx: RequestContext, requestId: string) {
  requirePermission(ctx, 'settings.manage');
  const request = loadRequest(ctx, requestId);
  const subject = db
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, request.subjectUserId))
    .get();

  return {
    request: { ...request, subjectName: subject?.name ?? 'Unknown' },
    legalHold: activeLegalHold(ctx.tenantId, request.subjectUserId),
    retention: evaluateRetention(ctx.tenantId, request.subjectMemberId),
    plan: request.kind === 'deletion'
      ? anonymisationPlan(ctx.tenantId, request.subjectUserId, request.subjectMemberId)
      : null,
    artifact: request.artifactId
      ? db
          .select({
            id: schema.privacyArtifacts.id,
            checksum: schema.privacyArtifacts.checksum,
            byteSize: schema.privacyArtifacts.byteSize,
            generatedAt: schema.privacyArtifacts.generatedAt,
          })
          .from(schema.privacyArtifacts)
          .where(eq(schema.privacyArtifacts.id, request.artifactId))
          .get()
      : null,
  };
}
