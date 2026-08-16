import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { channels } from '@shark/contracts';
import { applyFreeze, canTransition, formatMoney, levelFor } from '@shark/domain';
import { db, schema, transact } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { requireAssignedMember, requirePermission } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emit } from '../../lib/events.js';
import { conflict, notFound, precondition } from '../../lib/errors.js';
import { id } from '../../lib/ids.js';
import { DAY, addDays, isoDate, now, relativeTime } from '../../lib/time.js';
import { memberTrainingSummary } from '../../services/training-admin.js';

export const membersRoutes = new Hono();

const ListQuery = z.object({
  q: z.string().optional(),
  lifecycle: z.string().optional(),
  risk: z.enum(['high', 'watch', 'any']).optional(),
  expiring: z.coerce.number().int().optional(),
  trainerId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Directory (UX-A04). Task-focused columns, not every field in the table. */
membersRoutes.get('/', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'member.view');
  const q = c.req.valid('query');

  const scope = ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
  const filters = [
    eq(schema.members.tenantId, ctx.tenantId),
    inArray(schema.members.homeBranchId, scope),
    isNull(schema.members.deletedAt),
    isNull(schema.members.mergedIntoId),
  ];

  // Trainers see their own roster and nobody else's (PF-STAFF-005).
  if (ctx.role === 'trainer' && ctx.staffId) {
    filters.push(eq(schema.members.trainerId, ctx.staffId));
  }
  if (q.trainerId) filters.push(eq(schema.members.trainerId, q.trainerId));
  if (q.lifecycle && q.lifecycle !== 'all') filters.push(eq(schema.members.lifecycle, q.lifecycle));
  if (q.risk === 'high') filters.push(sql`${schema.members.riskScore} >= 55`);
  if (q.risk === 'watch') filters.push(sql`${schema.members.riskScore} >= 28`);

  if (q.q) {
    const term = `%${q.q.toLowerCase()}%`;
    filters.push(
      or(
        like(sql`lower(${schema.members.firstName})`, term),
        like(sql`lower(${schema.members.lastName})`, term),
        like(sql`lower(${schema.members.email})`, term),
        like(sql`lower(${schema.members.memberNo})`, term),
        like(schema.members.phone, term),
      )!,
    );
  }

  const where = and(...filters);

  const total = db.select({ n: sql<number>`count(*)` }).from(schema.members).where(where).get();

  const rows = db
    .select({
      id: schema.members.id,
      memberNo: schema.members.memberNo,
      firstName: schema.members.firstName,
      lastName: schema.members.lastName,
      initials: schema.members.initials,
      email: schema.members.email,
      phone: schema.members.phone,
      lifecycle: schema.members.lifecycle,
      homeBranchId: schema.members.homeBranchId,
      joinedOn: schema.members.joinedOn,
      lastVisitAt: schema.members.lastVisitAt,
      riskScore: schema.members.riskScore,
      riskReasons: schema.members.riskReasons,
      trainerId: schema.members.trainerId,
      tags: schema.members.tags,
    })
    .from(schema.members)
    .where(where)
    .orderBy(desc(schema.members.lastVisitAt))
    .limit(q.limit)
    .offset(q.offset)
    .all();

  const branchNames = new Map(
    db.select({ id: schema.branches.id, name: schema.branches.name }).from(schema.branches).all().map((b) => [b.id, b.name]),
  );

  const trainerNames = new Map(
    db
      .select({ id: schema.staff.id, name: schema.users.name })
      .from(schema.staff)
      .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
      .all()
      .map((s) => [s.id, s.name]),
  );

  const memberIds = rows.map((r) => r.id);

  const memberships = memberIds.length
    ? db
        .select({
          memberId: schema.memberships.memberId,
          state: schema.memberships.state,
          productName: schema.memberships.productName,
          endsOn: schema.memberships.endsOn,
          autoRenew: schema.memberships.autoRenew,
        })
        .from(schema.memberships)
        .where(and(inArray(schema.memberships.memberId, memberIds), sql`${schema.memberships.state} != 'cancelled'`))
        .all()
    : [];

  const balances = memberIds.length
    ? db
        .select({
          memberId: schema.invoices.memberId,
          due: sql<number>`sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor})`,
        })
        .from(schema.invoices)
        .where(
          and(
            inArray(schema.invoices.memberId, memberIds),
            sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
          ),
        )
        .groupBy(schema.invoices.memberId)
        .all()
    : [];

  const canSeeBalances = ctx.permissions.includes('billing.view');

  return c.json({
    total: total?.n ?? 0,
    offset: q.offset,
    limit: q.limit,
    scopeNote:
      ctx.role === 'trainer'
        ? 'Showing the members assigned to you.'
        : ctx.activeBranchId
          ? `Showing ${branchNames.get(ctx.activeBranchId) ?? 'this branch'}.`
          : `Showing all ${scope.length} branches you can see.`,
    columns: {
      balanceVisible: canSeeBalances,
    },
    items: rows.map((m) => {
      const membership = memberships.find((x) => x.memberId === m.id);
      const due = balances.find((b) => b.memberId === m.id)?.due ?? 0;
      const daysSinceVisit = m.lastVisitAt ? Math.floor((now() - m.lastVisitAt) / DAY) : null;
      return {
        id: m.id,
        memberNo: m.memberNo,
        name: `${m.firstName} ${m.lastName}`,
        initials: m.initials,
        email: m.email,
        phone: m.phone,
        lifecycle: m.lifecycle,
        branchName: branchNames.get(m.homeBranchId) ?? '',
        trainerName: m.trainerId ? (trainerNames.get(m.trainerId) ?? null) : null,
        joinedOn: m.joinedOn,
        lastVisitLabel: m.lastVisitAt ? relativeTime(m.lastVisitAt) : 'Never',
        daysSinceVisit,
        membershipState: membership?.state ?? null,
        productName: membership?.productName ?? null,
        endsOn: membership?.endsOn ?? null,
        autoRenew: membership?.autoRenew ?? null,
        balanceMinor: canSeeBalances ? due : null,
        balanceLabel: canSeeBalances && due > 0 ? formatMoney(due, 'INR') : null,
        riskScore: m.riskScore,
        riskBand: m.riskScore === null ? null : m.riskScore >= 55 ? 'high' : m.riskScore >= 28 ? 'watch' : 'low',
        riskReasons: (m.riskReasons ?? []).map((r) => r.label),
        tags: m.tags,
      };
    }),
  });
});

/** Member 360 (UX-A05). */
membersRoutes.get('/:memberId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'member.view');
  const memberId = c.req.param('memberId');

  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) throw notFound('That member');

  requireAssignedMember(ctx, member.trainerId);

  const canSeeBalances = ctx.permissions.includes('billing.view');
  const canSeeStaffNotes = ctx.permissions.includes('member.notes.private');

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} != 'cancelled'`))
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  const history = db
    .select()
    .from(schema.membershipEvents)
    .where(eq(schema.membershipEvents.membershipId, membership?.id ?? ''))
    .orderBy(desc(schema.membershipEvents.effectiveAt))
    .limit(20)
    .all();

  const invoices = canSeeBalances
    ? db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.memberId, memberId))
        .orderBy(desc(schema.invoices.issuedOn))
        .limit(12)
        .all()
    : [];

  const visits = db
    .select()
    .from(schema.checkIns)
    .where(eq(schema.checkIns.memberId, memberId))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(15)
    .all();

  const workouts = db
    .select({
      id: schema.workouts.id,
      title: schema.workouts.title,
      startedAt: schema.workouts.startedAt,
      volumeKg: schema.workouts.volumeKg,
      totalSets: schema.workouts.totalSets,
      durationSec: schema.workouts.durationSec,
    })
    .from(schema.workouts)
    .where(and(eq(schema.workouts.memberId, memberId), eq(schema.workouts.state, 'completed')))
    .orderBy(desc(schema.workouts.startedAt))
    .limit(10)
    .all();

  const bookings = db
    .select({
      id: schema.bookings.id,
      state: schema.bookings.state,
      startsAt: schema.classSessions.startsAt,
      name: schema.classTypes.name,
    })
    .from(schema.bookings)
    .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
    .where(eq(schema.bookings.memberId, memberId))
    .orderBy(desc(schema.classSessions.startsAt))
    .limit(10)
    .all();

  const credits = db
    .select({ kind: schema.credits.kind, balance: sql<number>`sum(${schema.credits.delta})` })
    .from(schema.credits)
    .where(eq(schema.credits.memberId, memberId))
    .groupBy(schema.credits.kind)
    .all();

  const xp = db
    .select({ total: sql<number>`coalesce(sum(${schema.xpLedger.delta}), 0)` })
    .from(schema.xpLedger)
    .where(eq(schema.xpLedger.memberId, memberId))
    .get();

  const auditTrail = ctx.permissions.includes('audit.view')
    ? db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.entityType, 'member'), eq(schema.auditLog.entityId, memberId)))
        .orderBy(desc(schema.auditLog.at))
        .limit(15)
        .all()
    : [];

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, member.homeBranchId)).get();
  const trainer = member.trainerId
    ? db
        .select({ name: schema.users.name })
        .from(schema.staff)
        .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
        .where(eq(schema.staff.id, member.trainerId))
        .get()
    : null;

  const outstanding = invoices
    .filter((i) => ['open', 'partially_paid', 'overdue'].includes(i.state))
    .reduce((total, i) => total + (i.totalMinor - i.paidMinor), 0);

  return c.json({
    member: {
      id: member.id,
      memberNo: member.memberNo,
      name: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      lastName: member.lastName,
      initials: member.initials,
      email: member.email,
      phone: member.phone,
      dob: member.dob,
      addressLine: member.addressLine,
      emergencyContact: member.emergencyContact,
      lifecycle: member.lifecycle,
      joinedOn: member.joinedOn,
      lastVisitLabel: member.lastVisitAt ? relativeTime(member.lastVisitAt) : 'Never',
      branchName: branch?.name ?? '',
      trainerId: member.trainerId,
      trainerName: trainer?.name ?? null,
      tags: member.tags,
      memberNotes: member.memberNotes,
      // Private staff notes are omitted entirely rather than nulled, so a
      // client cannot infer that there is something it may not read.
      ...(canSeeStaffNotes ? { staffNotes: member.staffNotes } : {}),
      riskScore: member.riskScore,
      riskBand: member.riskScore === null ? null : member.riskScore >= 55 ? 'high' : member.riskScore >= 28 ? 'watch' : 'low',
      riskReasons: member.riskReasons ?? [],
      version: member.version,
    },
    training: memberTrainingSummary(ctx, memberId),
    level: levelFor(xp?.total ?? 0),
    membership: membership
      ? {
          id: membership.id,
          productName: membership.productName,
          state: membership.state,
          startedOn: membership.startedOn,
          endsOn: membership.endsOn,
          autoRenew: membership.autoRenew,
          freezeDaysUsed: membership.freezeDaysUsed,
          freezeRules: membership.productSnapshot.freeze,
          cancellation: membership.productSnapshot.cancellation,
          priceLabel: formatMoney(membership.priceMinor, membership.currency),
          version: membership.version,
        }
      : null,
    membershipHistory: history.map((h) => ({
      id: h.id,
      from: h.fromState,
      to: h.toState,
      reason: h.reason,
      actorName: h.actorName,
      source: h.source,
      at: new Date(h.effectiveAt).toISOString(),
      relativeTime: relativeTime(h.effectiveAt),
    })),
    billing: canSeeBalances
      ? {
          outstandingMinor: outstanding,
          outstandingLabel: formatMoney(outstanding, 'INR'),
          invoices: invoices.map((i) => ({
            id: i.id,
            number: i.number,
            state: i.state,
            issuedOn: i.issuedOn,
            dueOn: i.dueOn,
            totalLabel: formatMoney(i.totalMinor, i.currency),
            dueMinor: i.totalMinor - i.paidMinor,
            dueLabel: formatMoney(i.totalMinor - i.paidMinor, i.currency),
          })),
        }
      : null,
    credits: credits.map((x) => ({ kind: x.kind, balance: x.balance })),
    visits: visits.map((v) => ({
      id: v.id,
      at: new Date(v.enteredAt).toISOString(),
      relativeTime: relativeTime(v.enteredAt),
      granted: v.decision === 'granted',
      decision: v.decision,
      minutes: v.exitedAt ? Math.round((v.exitedAt - v.enteredAt) / 60_000) : null,
      overrideByName: v.overrideByName,
      overrideReason: v.overrideReason,
    })),
    workouts: workouts.map((w) => ({
      id: w.id,
      title: w.title,
      at: new Date(w.startedAt).toISOString(),
      relativeTime: relativeTime(w.startedAt),
      volumeKg: Math.round(w.volumeKg),
      sets: w.totalSets,
      minutes: Math.round(w.durationSec / 60),
    })),
    bookings: bookings.map((b) => ({
      id: b.id,
      name: b.name,
      state: b.state,
      at: new Date(b.startsAt).toISOString(),
      relativeTime: relativeTime(b.startsAt),
    })),
    audit: auditTrail.map((a) => ({
      id: a.id,
      action: a.action,
      actorName: a.actorName,
      reason: a.reason,
      changes: a.changes,
      relativeTime: relativeTime(a.at),
    })),
  });
});

/* — Actions ————————————————————————————————————————————————— */

const FreezeBody = z.object({
  days: z.number().int().min(1).max(180),
  reason: z.string().min(4),
});

membersRoutes.post('/:memberId/freeze', validate('json', FreezeBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'membership.manage');
  const memberId = c.req.param('memberId');
  const { days, reason } = c.req.valid('json');

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), eq(schema.memberships.state, 'active')))
    .get();
  if (!membership) throw notFound('An active membership');

  const rules = membership.productSnapshot.freeze;
  const outcome = applyFreeze({
    endsOn: membership.endsOn,
    freezeDays: days,
    daysUsed: membership.freezeDaysUsed,
    maxDaysPerTerm: rules.maxDaysPerTerm,
    minDaysPerFreeze: rules.minDaysPerFreeze,
    extendsExpiry: rules.extendsExpiry,
    allowed: rules.allowed,
  });

  if (!outcome.ok) throw precondition(outcome.message);

  const transition = canTransition({ from: 'active', to: 'frozen', reason, actorRole: 'staff' });
  if (!transition.ok) throw conflict(transition.message);

  transact(() => {
    db.update(schema.memberships)
      .set({
        state: 'frozen',
        endsOn: outcome.newEndsOn,
        freezeDaysUsed: outcome.daysUsed,
        freezeStartedOn: isoDate(now(), 'Asia/Kolkata'),
        updatedAt: now(),
        version: membership.version + 1,
      })
      .where(eq(schema.memberships.id, membership.id))
      .run();

    db.insert(schema.membershipEvents)
      .values({
        id: id('mev'),
        tenantId: ctx.tenantId,
        membershipId: membership.id,
        fromState: 'active',
        toState: 'frozen',
        reason,
        actorId: ctx.userId,
        actorName: ctx.name,
        source: 'staff',
        effectiveAt: now(),
      })
      .run();

    db.update(schema.members).set({ lifecycle: 'frozen', updatedAt: now() }).where(eq(schema.members.id, memberId)).run();

    audit(ctx, {
      action: 'membership.frozen',
      entityType: 'member',
      entityId: memberId,
      entityLabel: membership.productName,
      reason,
      before: { state: 'active', endsOn: membership.endsOn, freezeDaysUsed: membership.freezeDaysUsed },
      after: { state: 'frozen', endsOn: outcome.newEndsOn, freezeDaysUsed: outcome.daysUsed },
    });
  });

  emit({
    tenantId: ctx.tenantId,
    channel: channels.member(memberId),
    topic: 'membership.state_changed',
    payload: { membershipId: membership.id, from: 'active', to: 'frozen' },
  });

  return c.json({
    ok: true,
    newEndsOn: outcome.newEndsOn,
    freezeDaysUsed: outcome.daysUsed,
    message: rules.extendsExpiry
      ? `Frozen for ${days} days. The end date moved to ${outcome.newEndsOn}.`
      : `Frozen for ${days} days. This plan does not extend the end date.`,
  });
});

membersRoutes.post('/:memberId/unfreeze', validate('json', z.object({ reason: z.string().min(4) })), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'membership.manage');
  const memberId = c.req.param('memberId');
  const { reason } = c.req.valid('json');

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), eq(schema.memberships.state, 'frozen')))
    .get();
  if (!membership) throw notFound('A frozen membership');

  transact(() => {
    db.update(schema.memberships)
      .set({ state: 'active', freezeStartedOn: null, updatedAt: now(), version: membership.version + 1 })
      .where(eq(schema.memberships.id, membership.id))
      .run();
    db.insert(schema.membershipEvents)
      .values({
        id: id('mev'),
        tenantId: ctx.tenantId,
        membershipId: membership.id,
        fromState: 'frozen',
        toState: 'active',
        reason,
        actorId: ctx.userId,
        actorName: ctx.name,
        source: 'staff',
        effectiveAt: now(),
      })
      .run();
    db.update(schema.members).set({ lifecycle: 'active', updatedAt: now() }).where(eq(schema.members.id, memberId)).run();
    audit(ctx, {
      action: 'membership.unfrozen',
      entityType: 'member',
      entityId: memberId,
      entityLabel: membership.productName,
      reason,
      before: { state: 'frozen' },
      after: { state: 'active' },
    });
  });

  return c.json({ ok: true, message: 'Membership is active again.' });
});

const CancelBody = z.object({
  reason: z.string().min(4),
  immediate: z.boolean().default(false),
});

membersRoutes.post('/:memberId/cancel', validate('json', CancelBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'membership.manage');
  const memberId = c.req.param('memberId');
  const { reason, immediate } = c.req.valid('json');

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} not in ('cancelled','expired')`))
    .get();
  if (!membership) throw notFound('An active membership');

  const policy = membership.productSnapshot.cancellation;
  const effectiveOn = immediate
    ? isoDate(now(), 'Asia/Kolkata')
    : addDays(isoDate(now(), 'Asia/Kolkata'), policy.noticeDays);

  const target = immediate ? 'cancelled' : 'cancel_scheduled';
  const transition = canTransition({
    from: membership.state as 'active',
    to: target,
    reason,
    actorRole: 'staff',
  });
  if (!transition.ok) throw conflict(transition.message);

  transact(() => {
    db.update(schema.memberships)
      .set({
        state: target,
        cancelEffectiveOn: effectiveOn,
        autoRenew: false,
        updatedAt: now(),
        version: membership.version + 1,
      })
      .where(eq(schema.memberships.id, membership.id))
      .run();

    db.insert(schema.membershipEvents)
      .values({
        id: id('mev'),
        tenantId: ctx.tenantId,
        membershipId: membership.id,
        fromState: membership.state,
        toState: target,
        reason,
        actorId: ctx.userId,
        actorName: ctx.name,
        source: 'staff',
        effectiveAt: now(),
      })
      .run();

    audit(ctx, {
      action: immediate ? 'membership.cancelled' : 'membership.cancel_scheduled',
      entityType: 'member',
      entityId: memberId,
      entityLabel: membership.productName,
      reason,
      before: { state: membership.state, autoRenew: membership.autoRenew },
      after: { state: target, cancelEffectiveOn: effectiveOn },
    });
  });

  emit({
    tenantId: ctx.tenantId,
    channel: channels.member(memberId),
    topic: 'membership.state_changed',
    payload: { membershipId: membership.id, from: membership.state, to: target },
  });

  return c.json({
    ok: true,
    effectiveOn,
    message: immediate
      ? 'Cancelled with immediate effect. Access ends now.'
      : `Cancellation scheduled for ${effectiveOn}, after the ${policy.noticeDays}-day notice period. Access continues until then.`,
  });
});

const NoteBody = z.object({
  memberNotes: z.string().max(4000).optional(),
  staffNotes: z.string().max(4000).optional(),
  version: z.number().int(),
});

membersRoutes.patch('/:memberId/notes', validate('json', NoteBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'member.edit');
  const memberId = c.req.param('memberId');
  const body = c.req.valid('json');

  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get();
  if (!member) throw notFound('That member');

  // Optimistic concurrency: someone else's edit must not vanish silently.
  if (member.version !== body.version) {
    throw conflict('Someone else changed this member while you were editing. Reload to see their version.');
  }

  if (body.staffNotes !== undefined) requirePermission(ctx, 'member.notes.private');

  db.update(schema.members)
    .set({
      ...(body.memberNotes !== undefined ? { memberNotes: body.memberNotes } : {}),
      ...(body.staffNotes !== undefined ? { staffNotes: body.staffNotes } : {}),
      version: member.version + 1,
      updatedAt: now(),
    })
    .where(eq(schema.members.id, memberId))
    .run();

  audit(ctx, {
    action: 'member.notes_updated',
    entityType: 'member',
    entityId: memberId,
    entityLabel: member.memberNo,
    before: { memberNotes: member.memberNotes, staffNotes: member.staffNotes },
    after: { memberNotes: body.memberNotes ?? member.memberNotes, staffNotes: body.staffNotes ?? member.staffNotes },
  });

  return c.json({ ok: true, version: member.version + 1 });
});
