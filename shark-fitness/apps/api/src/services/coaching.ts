import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { HABIT_TEMPLATES } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { addDays, isoDate, now, relativeTime } from '../lib/time.js';
import { queueNotification } from './notifications/service.js';

/**
 * Nutrition & Habits — the coach's view (P07; PF-NUTR-002/003, PF-STAFF-005).
 *
 * A trainer sees the members assigned to them and nobody else; managers see
 * their branches. A member who switched the nutrition and recovery module off
 * (PF-NUTR-006) is not listed and their record is not found here: opting out
 * means a coach stops looking, not that the data is greyed out.
 *
 * Check-in notes are the member's own words to their coach. They are shown
 * here and nowhere else — never in reports, never in an event payload.
 */

type Member = typeof schema.members.$inferSelect;

function optedOutIds(tenantId: string, memberIds: string[]): Set<string> {
  if (memberIds.length === 0) return new Set();
  return new Set(
    db
      .select({ memberId: schema.nutritionTargets.memberId })
      .from(schema.nutritionTargets)
      .where(and(eq(schema.nutritionTargets.tenantId, tenantId), inArray(schema.nutritionTargets.memberId, memberIds), eq(schema.nutritionTargets.enabled, false)))
      .all()
      .map((r) => r.memberId),
  );
}

/** Members this coach may see: assigned (trainer) or in branch scope (managers). */
function coachedMembers(ctx: RequestContext): Member[] {
  const scope = branchScope(ctx);
  return db
    .select()
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, ctx.tenantId),
        inArray(schema.members.homeBranchId, scope),
        isNull(schema.members.deletedAt),
        isNull(schema.members.mergedIntoId),
        ctx.role === 'trainer' ? eq(schema.members.trainerId, ctx.staffId ?? '') : undefined,
      ),
    )
    .all();
}

function loadCoachedMember(ctx: RequestContext, memberId: string): Member {
  requirePermission(ctx, 'training.assign');
  const member = db.select().from(schema.members).where(and(eq(schema.members.id, memberId), eq(schema.members.tenantId, ctx.tenantId))).get();
  const visible =
    member &&
    member.deletedAt === null &&
    branchScope(ctx).includes(member.homeBranchId) &&
    (ctx.role !== 'trainer' || member.trainerId === ctx.staffId) &&
    !optedOutIds(ctx.tenantId, [member.id]).has(member.id);
  if (!visible) throw notFound('That member');
  return member;
}

function today(member: Member, atMs: number): string {
  return isoDate(atMs, branchTimeZone(member.tenantId, member.homeBranchId));
}

/** Share of the last `days` days on which each daily habit met its target. */
function adherence(habits: Array<typeof schema.habits.$inferSelect>, logs: Array<typeof schema.habitLogs.$inferSelect>, todayIso: string, days: number) {
  const from = addDays(todayIso, -(days - 1));
  const daily = habits.filter((h) => h.cadence === 'daily');
  if (daily.length === 0) return null;
  let met = 0;
  for (const habit of daily) {
    met += logs.filter((l) => l.habitId === habit.id && l.onDate >= from && l.onDate <= todayIso && l.value >= habit.target).length;
  }
  return Math.round((met / (daily.length * days)) * 100);
}

export function coachingRoster(ctx: RequestContext) {
  requirePermission(ctx, 'training.assign');
  const atMs = now();
  const members = coachedMembers(ctx);
  const optedOut = optedOutIds(ctx.tenantId, members.map((m) => m.id));
  const visible = members.filter((m) => !optedOut.has(m.id));
  const ids = visible.map((m) => m.id);

  const habits = ids.length
    ? db.select().from(schema.habits).where(and(inArray(schema.habits.memberId, ids), eq(schema.habits.active, true))).all()
    : [];
  const since = isoDate(atMs - 8 * 86_400_000, 'UTC');
  const logs = ids.length
    ? db.select().from(schema.habitLogs).where(and(inArray(schema.habitLogs.memberId, ids), gte(schema.habitLogs.onDate, since))).all()
    : [];
  const checkIns = ids.length
    ? db.select().from(schema.weeklyCheckIns).where(inArray(schema.weeklyCheckIns.memberId, ids)).orderBy(desc(schema.weeklyCheckIns.weekStart)).all()
    : [];

  const items = visible.map((member) => {
    const t = today(member, atMs);
    const own = habits.filter((h) => h.memberId === member.id);
    const latest = checkIns.find((c) => c.memberId === member.id && c.submittedAt !== null);
    const waiting = checkIns.filter((c) => c.memberId === member.id && c.submittedAt !== null && !c.coachReply);
    return {
      memberId: member.id,
      name: `${member.firstName} ${member.lastName}`.trim(),
      initials: member.initials,
      memberNo: member.memberNo,
      habits: own.length,
      adherence7: adherence(own, logs.filter((l) => l.memberId === member.id), t, 7),
      lastCheckIn: latest
        ? {
            weekStart: latest.weekStart,
            submittedRelative: relativeTime(latest.submittedAt!, atMs),
            replied: Boolean(latest.coachReply),
          }
        : null,
      awaitingReply: waiting.length,
      /** A check-in a safety phrase routed to a person, not yet answered. */
      flagged: waiting.some((c) => c.safetyEscalated),
    };
  });
  items.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.awaitingReply - a.awaitingReply || a.name.localeCompare(b.name));
  return {
    items,
    counts: { flagged: items.filter((i) => i.flagged).length, awaitingReply: items.reduce((n, i) => n + i.awaitingReply, 0) },
    templates: HABIT_TEMPLATES,
  };
}

export function coachingDetail(ctx: RequestContext, memberId: string) {
  const member = loadCoachedMember(ctx, memberId);
  const atMs = now();
  const t = today(member, atMs);
  const habits = db.select().from(schema.habits).where(and(eq(schema.habits.memberId, member.id), eq(schema.habits.active, true))).all();
  const logs = db
    .select()
    .from(schema.habitLogs)
    .where(and(eq(schema.habitLogs.memberId, member.id), gte(schema.habitLogs.onDate, addDays(t, -27))))
    .all();
  const checkIns = db
    .select()
    .from(schema.weeklyCheckIns)
    .where(eq(schema.weeklyCheckIns.memberId, member.id))
    .orderBy(desc(schema.weeklyCheckIns.weekStart))
    .limit(8)
    .all();
  const days = Array.from({ length: 7 }, (_, i) => addDays(t, i - 6));

  return {
    member: { id: member.id, name: `${member.firstName} ${member.lastName}`.trim(), memberNo: member.memberNo, initials: member.initials },
    habits: habits.map((h) => {
      const own = logs.filter((l) => l.habitId === h.id);
      return {
        id: h.id,
        name: h.name,
        target: h.target,
        unit: h.unit,
        cadence: h.cadence,
        fromTemplate: h.templateKey,
        adherence7: adherence([h], own, t, 7),
        adherence28: adherence([h], own, t, 28),
        week: days.map((date) => {
          const value = own.find((l) => l.onDate === date)?.value ?? null;
          return { date, value, met: value !== null && value >= h.target };
        }),
      };
    }),
    adherence7: adherence(habits, logs, t, 7),
    checkIns: checkIns.map((c) => ({
      id: c.id,
      weekStart: c.weekStart,
      submitted: c.submittedAt !== null,
      submittedRelative: c.submittedAt ? relativeTime(c.submittedAt, atMs) : null,
      scores: { adherence: c.adherence, energy: c.energy, hunger: c.hunger, sleep: c.sleep, soreness: c.soreness, mood: c.mood },
      note: c.note,
      coachReply: c.coachReply,
      coachReplyByName: c.coachReplyByName,
      coachRepliedRelative: c.coachRepliedAt ? relativeTime(c.coachRepliedAt, atMs) : null,
      safetyEscalated: c.safetyEscalated,
      safetySignals: c.safetySignals,
    })),
    templates: HABIT_TEMPLATES.map((tpl) => ({ ...tpl, assigned: habits.some((h) => h.templateKey === tpl.key) })),
  };
}

function notifyMember(ctx: RequestContext, member: Member, title: string, body: string, key: string): void {
  if (!member.userId) return;
  queueNotification({
    tenantId: ctx.tenantId,
    userId: member.userId,
    memberId: member.id,
    branchId: member.homeBranchId,
    channel: 'in_app',
    purpose: 'coaching',
    source: 'coaching',
    sourceId: key,
    dedupeKey: `coaching:${key}`,
    kind: 'coach',
    title,
    body,
    link: '/habits',
  });
}

export function assignHabitTemplate(ctx: RequestContext, memberId: string, templateKey: string) {
  const member = loadCoachedMember(ctx, memberId);
  const template = HABIT_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) throw invalid('That habit template does not exist.');
  const existing = db
    .select({ id: schema.habits.id })
    .from(schema.habits)
    .where(and(eq(schema.habits.memberId, member.id), eq(schema.habits.active, true), eq(schema.habits.templateKey, template.key)))
    .get();
  if (existing) throw conflict(`${member.firstName} already has “${template.name}”.`);
  const habitId = id('hbt');
  transact(() => {
    db.insert(schema.habits)
      .values({
        id: habitId,
        tenantId: ctx.tenantId,
        memberId: member.id,
        name: template.name,
        icon: template.icon,
        cadence: template.cadence,
        target: template.target,
        unit: template.unit,
        active: true,
        createdAt: now(),
        templateKey: template.key,
        assignedByStaffId: ctx.staffId,
      })
      .run();
    audit(ctx, {
      action: 'coaching.habit_assigned',
      entityType: 'habit',
      entityId: habitId,
      entityLabel: template.name,
      branchId: member.homeBranchId,
      after: { memberId: member.id, templateKey: template.key },
    });
    notifyMember(ctx, member, 'A new habit from your coach', `${ctx.name} added “${template.name}” to your habits. ${template.why}`, `habit:${habitId}`);
  });
  return { habitId };
}

export function replyToCheckIn(ctx: RequestContext, checkInId: string, reply: string) {
  requirePermission(ctx, 'training.assign');
  const row = db.select().from(schema.weeklyCheckIns).where(and(eq(schema.weeklyCheckIns.id, checkInId), eq(schema.weeklyCheckIns.tenantId, ctx.tenantId))).get();
  if (!row) throw notFound('That check-in');
  const member = loadCoachedMember(ctx, row.memberId);
  if (row.submittedAt === null) throw invalid('That check-in has not been sent yet.');
  const text = reply.trim();
  if (text.length < 2) throw invalid('Write a reply.');
  const atMs = now();
  transact(() => {
    db.update(schema.weeklyCheckIns)
      .set({ coachReply: text, coachRepliedAt: atMs, coachReplyByName: ctx.name })
      .where(eq(schema.weeklyCheckIns.id, row.id))
      .run();
    // The audit row records that a reply exists, not what it says.
    audit(ctx, {
      action: 'coaching.check_in_replied',
      entityType: 'weekly_check_in',
      entityId: row.id,
      entityLabel: `Week of ${row.weekStart}`,
      branchId: member.homeBranchId,
      after: { replied: true },
    });
    notifyMember(ctx, member, `${ctx.name} replied to your check-in`, text.length > 120 ? `${text.slice(0, 117)}…` : text, `checkin:${row.id}:${atMs}`);
  });
  return { ok: true as const };
}
