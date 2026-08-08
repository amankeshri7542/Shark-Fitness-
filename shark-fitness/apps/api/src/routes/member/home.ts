import { Hono } from 'hono';
import { and, desc, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm';
import { computeStreak, isEntitled, levelFor, occupancyLabel } from '@shark/domain';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { DAY, HOUR, isoDate, localTime, now, relativeTime } from '../../lib/time.js';
import { notFound } from '../../lib/errors.js';

export const homeRoutes = new Hono();

/**
 * Member Home (UX-M02) — "what should I do now?".
 *
 * The card order is decided here, by explicit priority rules, not by a feed
 * algorithm (Design PRD §5.7). A membership problem outranks everything; a
 * live class outranks the day's workout; a rest day says so rather than
 * showing an empty training card.
 */
homeRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const today = isoDate(now(), 'Asia/Kolkata');

  const member = db.select().from(schema.members).where(eq(schema.members.id, memberId)).get();
  if (!member) throw notFound('Your membership');

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, member.homeBranchId)).get();
  const tz = branch?.timezone ?? 'Asia/Kolkata';

  /* — Membership and access ————————————————————————————————— */

  const membership = db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.memberId, memberId), sql`${schema.memberships.state} != 'cancelled'`))
    .orderBy(desc(schema.memberships.createdAt))
    .get();

  const outstanding = db
    .select({
      total: sql<number>`coalesce(sum(${schema.invoices.totalMinor} - ${schema.invoices.paidMinor}), 0)`,
      count: sql<number>`count(*)`,
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

  const membershipIssue =
    membership && !isEntitled(membership.state as 'active')
      ? {
          severity: 'blocking' as const,
          title: membership.state === 'expired' ? 'Your membership has ended' : 'Your membership is on hold',
          body:
            membership.state === 'expired'
              ? 'Renew in the app or at reception and your history carries over.'
              : 'Reception can sort this out in a minute.',
          action: { label: 'See options', to: '/billing' },
        }
      : (outstanding?.total ?? 0) > 0
        ? {
            severity: 'warning' as const,
            title: 'There is a balance outstanding',
            body:
              membership?.state === 'grace'
                ? `Your membership is in its grace period until ${membership.graceEndsOn}. Settling this restores full access.`
                : 'Settle it in the app or at reception whenever suits.',
            action: { label: 'Settle now', to: '/billing' },
          }
        : null;

  /* — Today's training ——————————————————————————————————————— */

  const assignment = db
    .select()
    .from(schema.assignments)
    .where(and(eq(schema.assignments.memberId, memberId), eq(schema.assignments.state, 'active')))
    .get();

  const dayIndex = (new Date(now()).getUTCDay() + 6) % 7;

  const programDay = assignment
    ? db
        .select()
        .from(schema.programDays)
        .where(
          and(
            eq(schema.programDays.programId, assignment.programId),
            eq(schema.programDays.week, assignment.currentWeek),
            eq(schema.programDays.dayIndex, dayIndex),
          ),
        )
        .get()
    : null;

  const itemCount = programDay
    ? (db
        .select({ n: sql<number>`count(*)` })
        .from(schema.programItems)
        .where(eq(schema.programItems.programDayId, programDay.id))
        .get()?.n ?? 0)
    : 0;

  const setCount = programDay
    ? db
        .select({ sets: schema.programItems.sets })
        .from(schema.programItems)
        .where(eq(schema.programItems.programDayId, programDay.id))
        .all()
        .reduce((total, row) => total + row.sets.length, 0)
    : 0;

  // An unfinished session from earlier today is resumable rather than lost.
  const openWorkout = db
    .select()
    .from(schema.workouts)
    .where(and(eq(schema.workouts.memberId, memberId), eq(schema.workouts.state, 'in_progress')))
    .orderBy(desc(schema.workouts.startedAt))
    .get();

  const doneToday = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.workouts)
    .where(
      and(
        eq(schema.workouts.memberId, memberId),
        eq(schema.workouts.state, 'completed'),
        gte(schema.workouts.startedAt, Date.parse(`${today}T00:00:00+05:30`)),
      ),
    )
    .get();

  const training = programDay
    ? {
        state: programDay.isRest
          ? ('rest' as const)
          : (doneToday?.n ?? 0) > 0
            ? ('done' as const)
            : openWorkout
              ? ('in_progress' as const)
              : ('ready' as const),
        programDayId: programDay.id,
        assignmentId: assignment?.id ?? null,
        title: programDay.label,
        focus: programDay.focus,
        blockLabel: `Block ${assignment?.currentBlock ?? 'A'} · Week ${assignment?.currentWeek ?? 1}`,
        exerciseCount: itemCount,
        setCount,
        estimatedMin: programDay.estimatedMin,
        coachName: assignment
          ? (db
              .select({ name: schema.users.name })
              .from(schema.staff)
              .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
              .where(eq(schema.staff.id, assignment.trainerId ?? ''))
              .get()?.name ?? null)
          : null,
        resumeClientId: openWorkout?.clientId ?? null,
        completedSets: openWorkout
          ? (db
              .select({ n: sql<number>`count(*)` })
              .from(schema.workoutSets)
              .where(eq(schema.workoutSets.workoutId, openWorkout.id))
              .get()?.n ?? 0)
          : 0,
      }
    : {
        state: 'no_program' as const,
        programDayId: null,
        assignmentId: null,
        title: 'No plan assigned yet',
        focus: '',
        blockLabel: '',
        exerciseCount: 0,
        setCount: 0,
        estimatedMin: 0,
        coachName: null,
        resumeClientId: null,
        completedSets: 0,
      };

  /* — Next booking ——————————————————————————————————————————— */

  const nextBooking = db
    .select({
      bookingId: schema.bookings.id,
      seatNo: schema.bookings.seatNo,
      sessionId: schema.classSessions.id,
      startsAt: schema.classSessions.startsAt,
      capacity: schema.classSessions.capacity,
      booked: schema.classSessions.booked,
      state: schema.classSessions.state,
      cancelledReason: schema.classSessions.cancelledReason,
      className: schema.classTypes.name,
      roomName: schema.rooms.name,
      branchId: schema.classSessions.branchId,
      trainerName: schema.users.name,
    })
    .from(schema.bookings)
    .innerJoin(schema.classSessions, eq(schema.classSessions.id, schema.bookings.sessionId))
    .innerJoin(schema.classTypes, eq(schema.classTypes.id, schema.classSessions.classTypeId))
    .leftJoin(schema.rooms, eq(schema.rooms.id, schema.classSessions.roomId))
    .leftJoin(schema.staff, eq(schema.staff.id, schema.classSessions.trainerId))
    .leftJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(
      and(
        eq(schema.bookings.memberId, memberId),
        eq(schema.bookings.state, 'confirmed'),
        gt(schema.classSessions.startsAt, now() - HOUR),
      ),
    )
    .orderBy(schema.classSessions.startsAt)
    .get();

  /* — Occupancy ——————————————————————————————————————————————— */

  const inside = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.branchId, member.homeBranchId),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
        gt(schema.checkIns.enteredAt, now() - 6 * HOUR),
      ),
    )
    .get();

  const capacity = branch?.capacity ?? 100;
  const insideNow = inside?.n ?? 0;

  /* — Streak, level, recovery pulse ————————————————————————— */

  const sessionDates = db
    .select({ startedAt: schema.workouts.startedAt })
    .from(schema.workouts)
    .where(and(eq(schema.workouts.memberId, memberId), eq(schema.workouts.state, 'completed')))
    .orderBy(desc(schema.workouts.startedAt))
    .limit(120)
    .all()
    .map((r) => isoDate(r.startedAt, tz));

  const streakRow = db.select().from(schema.streaksTable).where(eq(schema.streaksTable.memberId, memberId)).get();
  const streak = computeStreak({
    sessionDates,
    today,
    weeklyTarget: streakRow?.weeklyTarget ?? 4,
    restDaysAllowed: streakRow?.restDaysAllowed ?? 2,
  });

  const xp = db
    .select({ total: sql<number>`coalesce(sum(${schema.xpLedger.delta}), 0)` })
    .from(schema.xpLedger)
    .where(eq(schema.xpLedger.memberId, memberId))
    .get();

  const level = levelFor(xp?.total ?? 0);

  const monthVolume = db
    .select({ total: sql<number>`coalesce(sum(${schema.workouts.volumeKg}), 0)` })
    .from(schema.workouts)
    .where(and(eq(schema.workouts.memberId, memberId), gt(schema.workouts.startedAt, now() - 30 * DAY)))
    .get();

  /* — Coach note and challenge ——————————————————————————————— */

  const coachMessage = db
    .select({
      body: schema.messages.body,
      senderName: schema.messages.senderName,
      createdAt: schema.messages.createdAt,
      conversationId: schema.messages.conversationId,
      readAt: schema.messages.readAt,
    })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(
      and(
        eq(schema.conversations.memberId, memberId),
        eq(schema.conversations.kind, 'coach'),
        sql`${schema.messages.senderRole} != 'member'`,
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .get();

  const adaptive = db
    .select()
    .from(schema.adaptiveDecisions)
    .where(and(eq(schema.adaptiveDecisions.memberId, memberId), eq(schema.adaptiveDecisions.memberDecision, 'pending')))
    .orderBy(desc(schema.adaptiveDecisions.createdAt))
    .get();

  const challenge = db
    .select({
      id: schema.challenges.id,
      name: schema.challenges.name,
      endsOn: schema.challenges.endsOn,
      teamTarget: schema.challenges.teamTarget,
      metricLabel: schema.challenges.metricLabel,
      score: schema.challengeParticipants.score,
    })
    .from(schema.challengeParticipants)
    .innerJoin(schema.challenges, eq(schema.challenges.id, schema.challengeParticipants.challengeId))
    .where(
      and(
        eq(schema.challengeParticipants.memberId, memberId),
        gte(schema.challenges.endsOn, today),
      ),
    )
    .get();

  const challengeStanding = challenge
    ? db
        .select({ n: sql<number>`count(*)` })
        .from(schema.challengeParticipants)
        .where(
          and(
            eq(schema.challengeParticipants.challengeId, challenge.id),
            gt(schema.challengeParticipants.score, challenge.score),
          ),
        )
        .get()
    : null;

  const unread = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, ctx.userId), isNull(schema.notifications.readAt)))
    .get();

  /* — Card order. Explicit, inspectable, no feed algorithm. ————— */

  const order: string[] = [];
  if (membershipIssue) order.push('membership_issue');
  if (nextBooking && nextBooking.startsAt - now() < 3 * HOUR) order.push('next_booking');
  order.push('training');
  if (adaptive) order.push('adaptive');
  if (!order.includes('next_booking') && nextBooking) order.push('next_booking');
  order.push('stats');
  if (coachMessage && !coachMessage.readAt) order.push('coach');
  order.push('occupancy');
  if (challenge) order.push('challenge');

  return c.json({
    member: {
      firstName: member.firstName,
      initials: member.initials,
      memberNo: member.memberNo,
    },
    branch: {
      id: member.homeBranchId,
      name: branch?.name ?? '',
      timezone: tz,
    },
    today: {
      date: today,
      label: new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      }).format(now()),
    },
    order,
    membership: membership
      ? {
          id: membership.id,
          productName: membership.productName,
          state: membership.state,
          endsOn: membership.endsOn,
          autoRenew: membership.autoRenew,
          allBranches: membership.productSnapshot.access.allBranches,
          entitled: isEntitled(membership.state as 'active'),
        }
      : null,
    membershipIssue,
    outstanding: {
      totalMinor: outstanding?.total ?? 0,
      invoiceCount: outstanding?.count ?? 0,
    },
    training,
    nextBooking: nextBooking
      ? {
          bookingId: nextBooking.bookingId,
          sessionId: nextBooking.sessionId,
          name: nextBooking.className,
          roomName: nextBooking.roomName ?? '',
          trainerName: nextBooking.trainerName ?? 'Coach',
          localTime: localTime(nextBooking.startsAt, tz),
          startsAt: new Date(nextBooking.startsAt).toISOString(),
          isToday: isoDate(nextBooking.startsAt, tz) === today,
          seatNo: nextBooking.seatNo,
          capacity: nextBooking.capacity,
          cancelled: nextBooking.state === 'cancelled',
          cancelledReason: nextBooking.cancelledReason,
          startsInMin: Math.round((nextBooking.startsAt - now()) / 60_000),
        }
      : null,
    occupancy: {
      inside: insideNow,
      capacity,
      label: occupancyLabel(insideNow, capacity),
      pct: Math.round((insideNow / Math.max(1, capacity)) * 100),
    },
    streak: {
      current: streak.current,
      longest: streak.longest,
      thisWeek: streak.thisWeek,
      weeklyTarget: streakRow?.weeklyTarget ?? 4,
      week: streak.week,
      atRisk: streak.atRisk,
    },
    level: {
      level: level.level,
      name: level.name,
      xp: level.xp,
      progressPct: level.progressPct,
      xpIntoLevel: level.xpIntoLevel,
      xpForNextLevel: level.xpForNextLevel,
      nextName: level.nextName,
    },
    monthVolumeKg: Math.round(monthVolume?.total ?? 0),
    coachMessage: coachMessage
      ? {
          body: coachMessage.body,
          senderName: coachMessage.senderName,
          relativeTime: relativeTime(coachMessage.createdAt),
          conversationId: coachMessage.conversationId,
          unread: !coachMessage.readAt,
        }
      : null,
    adaptive: adaptive
      ? {
          id: adaptive.id,
          headline: adaptive.headline,
          explanation: adaptive.explanation,
          reviewedByName: adaptive.reviewedByName,
          rulesVersion: adaptive.rulesVersion,
        }
      : null,
    challenge: challenge
      ? {
          id: challenge.id,
          name: challenge.name,
          daysLeft: Math.max(0, Math.round((Date.parse(`${challenge.endsOn}T23:59:59Z`) - now()) / DAY)),
          rank: (challengeStanding?.n ?? 0) + 1,
          score: challenge.score,
          metricLabel: challenge.metricLabel,
        }
      : null,
    unreadNotifications: unread?.n ?? 0,
  });
});

/** The occupancy strip polls this when the socket is down. */
homeRoutes.get('/occupancy/:branchId', (c) => {
  const ctx = ctxOf(c);
  const branchId = c.req.param('branchId');
  if (!ctx.branchIds.includes(branchId)) throw notFound('That branch');

  const branch = db.select().from(schema.branches).where(eq(schema.branches.id, branchId)).get();
  if (!branch) throw notFound('That branch');

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

  const todayStart = Date.parse(`${isoDate(now(), branch.timezone)}T00:00:00+05:30`);
  const rows = db
    .select({ enteredAt: schema.checkIns.enteredAt })
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.branchId, branchId),
        eq(schema.checkIns.decision, 'granted'),
        gte(schema.checkIns.enteredAt, todayStart),
        lt(schema.checkIns.enteredAt, todayStart + DAY),
      ),
    )
    .all();

  const hourly = Array.from({ length: 24 }, () => 0);
  for (const row of rows) {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: branch.timezone, hour: '2-digit', hour12: false }).format(
        row.enteredAt,
      ),
    );
    if (hour >= 0 && hour < 24) hourly[hour] = (hourly[hour] ?? 0) + 1;
  }

  const insideNow = inside?.n ?? 0;
  return c.json({
    branchId,
    branchName: branch.name,
    inside: insideNow,
    capacity: branch.capacity,
    label: occupancyLabel(insideNow, branch.capacity),
    at: new Date(now()).toISOString(),
    hourly,
    currentHour: Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: branch.timezone, hour: '2-digit', hour12: false }).format(now()),
    ),
    areas: [
      { name: 'Free weights', busy: insideNow > branch.capacity * 0.6 ? 'busy' : 'steady', free: null },
      { name: 'Platform', busy: 'steady', free: 2 },
      { name: 'Cardio', busy: insideNow > branch.capacity * 0.8 ? 'busy' : 'free', free: 6 },
    ],
  });
});
