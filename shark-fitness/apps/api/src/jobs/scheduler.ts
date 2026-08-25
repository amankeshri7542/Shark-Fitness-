import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { DAY_KEYS, deriveState, hoursFor } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { emit } from '../lib/events.js';
import { processDueDeliveries, runDueAutomations } from '../services/automations.js';
import { pruneOperationalData } from '../services/maintenance.js';
import { expireChallengeInvitations } from '../services/engagement-admin.js';
import { rollUpCompletedDays } from '../services/reports.js';
import { DAY, HOUR, MINUTE, addDays, isoDate, localClockOnDay, localDayIndex, now, startOfLocalDay } from '../lib/time.js';
import { id } from '../lib/ids.js';

/**
 * Cron-equivalent jobs (Engineering PRD §"Background processing").
 *
 * Every job is idempotent — running it twice must produce the same state as
 * running it once, because that is the only assumption that survives a restart
 * mid-run.
 */

type Job = { name: string; everyMs: number; run: () => void };

/** Memberships move to grace, then expire, on their dates rather than whenever
 *  someone next opens a screen. */
function expireMemberships(): void {
  const tenants = db.select().from(schema.tenants).all();

  for (const tenant of tenants) {
    const today = isoDate(now(), tenant.timezone);
    const graceDays = Number((tenant.policy as Record<string, unknown>)?.graceDays ?? 7);

    const rows = db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.tenantId, tenant.id),
          sql`${schema.memberships.state} in ('active','grace')`,
          isNotNull(schema.memberships.endsOn),
        ),
      )
      .all();

    for (const membership of rows) {
      const outstanding = db
        .select({ n: sql<number>`count(*)` })
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.memberId, membership.memberId),
            sql`${schema.invoices.state} in ('open','partially_paid','overdue')`,
          ),
        )
        .get();

      const next = deriveState({
        current: membership.state as 'active' | 'grace',
        endsOn: membership.endsOn,
        today,
        graceDays,
        hasOutstandingBalance: (outstanding?.n ?? 0) > 0,
      });

      if (next === membership.state) continue;

      transact(() => {
        db.update(schema.memberships)
          .set({ state: next, updatedAt: now(), version: membership.version + 1 })
          .where(eq(schema.memberships.id, membership.id))
          .run();

        db.insert(schema.membershipEvents)
          .values({
            id: `mev_${membership.id}_${next}_${today}`,
            tenantId: tenant.id,
            membershipId: membership.id,
            fromState: membership.state,
            toState: next,
            reason: next === 'grace' ? 'Term ended with a balance outstanding' : 'Term ended',
            actorId: null,
            actorName: 'System',
            source: 'system',
            effectiveAt: now(),
          })
          .onConflictDoNothing()
          .run();
      });

      emit({
        tenantId: tenant.id,
        channel: channels.member(membership.memberId),
        topic: 'membership.state_changed',
        payload: { membershipId: membership.id, from: membership.state, to: next },
      });
    }
  }
}

/** Nobody stays "inside" overnight. Sessions still open past closing are
 *  closed and flagged, so occupancy is not quietly wrong forever. */
function closingInstant(
  branch: typeof schema.branches.$inferSelect,
  enteredAt: number,
): number {
  const localDay = isoDate(enteredAt, branch.timezone);
  const day = DAY_KEYS[localDayIndex(enteredAt, branch.timezone)]!;
  const hours = hoursFor(branch.hours, day, {
    open: branch.opensMinutes,
    close: branch.closesMinutes,
  }).value;

  // 24:00 is a valid configured close but is not a JavaScript wall-clock
  // value. It is exactly the start of the following local calendar day.
  if (hours.closed || hours.close === 1440) {
    return startOfLocalDay(addDays(localDay, 1), branch.timezone);
  }
  const hour = Math.floor(hours.close / 60);
  const minute = hours.close % 60;
  return localClockOnDay(localDay, `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, branch.timezone);
}

function closeStaleCheckIns(atMs = now()): void {
  const branches = db.select().from(schema.branches).all();

  for (const branch of branches) {
    const open = db
      .select()
      .from(schema.checkIns)
      .where(
        and(
          eq(schema.checkIns.branchId, branch.id),
          isNull(schema.checkIns.exitedAt),
          eq(schema.checkIns.decision, 'granted'),
        ),
      )
      .all()
      .filter((row) => closingInstant(branch, row.enteredAt) <= atMs);

    for (const row of open) {
      db.update(schema.checkIns)
        .set({ exitedAt: atMs, autoClosed: true })
        .where(eq(schema.checkIns.id, row.id))
        .run();
    }

    if (open.length > 0) {
      emit({
        tenantId: branch.tenantId,
        branchId: branch.id,
        channel: channels.branch(branch.id),
        topic: 'occupancy.changed',
        payload: { branchId: branch.id, autoClosed: open.length },
      });
    }
  }
}

/** A waitlist offer that is not taken up inside its window passes on. */
function expireWaitlistOffers(): void {
  const stale = db
    .select()
    .from(schema.waitlistEntries)
    .where(
      and(
        eq(schema.waitlistEntries.state, 'offered'),
        isNotNull(schema.waitlistEntries.offerExpiresAt),
        lt(schema.waitlistEntries.offerExpiresAt, now()),
      ),
    )
    .all();

  for (const entry of stale) {
    db.update(schema.waitlistEntries)
      .set({ state: 'expired', resolvedAt: now() })
      .where(eq(schema.waitlistEntries.id, entry.id))
      .run();

    emit({
      tenantId: entry.tenantId,
      channel: channels.session(entry.sessionId),
      topic: 'waitlist.promoted',
      payload: { sessionId: entry.sessionId, expiredEntryId: entry.id },
    });
  }
}

/** Holds do not occupy a seat once they lapse. */
function releaseExpiredHolds(): void {
  const stale = db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.state, 'held'), isNotNull(schema.bookings.heldUntil), lt(schema.bookings.heldUntil, now())))
    .all();

  for (const booking of stale) {
    transact(() => {
      db.update(schema.bookings)
        .set({ state: 'cancelled', cancelledAt: now() })
        .where(eq(schema.bookings.id, booking.id))
        .run();
      db.update(schema.classSessions)
        .set({ booked: sql`max(0, ${schema.classSessions.booked} - 1)` })
        .where(eq(schema.classSessions.id, booking.sessionId))
        .run();
    });
  }
}

/**
 * Keep the report rollups warm (PF-RPT-006).
 *
 * Reports materialise any day they need on demand, so this is not what makes
 * them correct — it is what stops the first person to open Reports on a Monday
 * paying for a whole quarter's scan. The last few days are recomputed rather
 * than only the newest, because a day can still gain a late refund or a
 * corrected booking after it has ended.
 */
function rollUpMetrics(): void {
  for (const tenant of db.select({ id: schema.tenants.id }).from(schema.tenants).all()) {
    rollUpCompletedDays(tenant.id, 3);
  }
}

/**
 * Fire the automations that are due (PF-COMM-004).
 *
 * On the existing scheduler rather than a timer of its own. A second scheduler
 * is a second thing to reason about when a member is messaged twice, and the
 * answer to "which one fired?" should never be "both".
 *
 * Hourly, not by the minute: every trigger this product has is a daily or
 * per-occurrence event, and the suppression that matters — quiet hours — is
 * measured in hours. A minute-by-minute sweep would scan every member sixty
 * times an hour to change nothing.
 */
function runAutomations(): void {
  const { ran, sent } = runDueAutomations();
  if (ran > 0) console.log(`[jobs] automations ran ${ran}, sent ${sent}`);
}

function deliverQueuedAutomations(): void {
  const result = processDueDeliveries();
  if (result.processed > 0) {
    console.log(`[jobs] automation queue processed ${result.processed}, sent ${result.sent}, failed ${result.failed}`);
  }
  if (result.failed > 0) {
    throw new Error(`${result.failed} automation delivery attempt${result.failed === 1 ? '' : 's'} failed.`);
  }
}

function pruneOperationalRows(): void {
  const result = pruneOperationalData();
  const removed = Object.values(result).reduce((total, count) => total + count, 0);
  if (removed > 0) console.log(`[jobs] operational retention pruned ${removed} rows`);

  // Bookkeeping, not enforcement: every read path already treats a lapsed
  // invitation as unusable, so this only stops the stored state column from
  // saying `pending` about something nobody can accept.
  const expired = expireChallengeInvitations();
  if (expired > 0) console.log(`[jobs] expired ${expired} challenge invitations`);
}

const JOBS: Job[] = [
  { name: 'deliver-automation-queue', everyMs: MINUTE, run: deliverQueuedAutomations },
  { name: 'run-automations', everyMs: HOUR, run: runAutomations },
  { name: 'expire-memberships', everyMs: 6 * HOUR, run: expireMemberships },
  { name: 'roll-up-metrics', everyMs: 6 * HOUR, run: rollUpMetrics },
  { name: 'close-stale-check-ins', everyMs: 30 * MINUTE, run: closeStaleCheckIns },
  { name: 'expire-waitlist-offers', everyMs: MINUTE, run: expireWaitlistOffers },
  { name: 'release-expired-holds', everyMs: MINUTE, run: releaseExpiredHolds },
  { name: 'prune-operational-data', everyMs: DAY, run: pruneOperationalRows },
];

export function executeJob(job: Job, clock: () => number = now): void {
  const runId = id('jobr');
  const startedAt = clock();
  db.insert(schema.jobRuns)
    .values({
      id: runId,
      job: job.name,
      startedAt,
      finishedAt: null,
      status: 'running',
      durationMs: null,
      error: null,
    })
    .run();
  try {
    job.run();
    const finishedAt = clock();
    db.update(schema.jobRuns)
      .set({ status: 'succeeded', finishedAt, durationMs: Math.max(0, finishedAt - startedAt), error: null })
      .where(eq(schema.jobRuns.id, runId))
      .run();
  } catch (error) {
    const finishedAt = clock();
    db.update(schema.jobRuns)
      .set({
        status: 'failed',
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      })
      .where(eq(schema.jobRuns.id, runId))
      .run();
    throw error;
  }
}

export function startScheduler(): void {
  if (runtimeConfig.disableJobs) {
    console.log('[jobs] disabled');
    return;
  }

  for (const job of JOBS) {
    const tick = () => {
      try {
        executeJob(job);
      } catch (err) {
        console.error(`[jobs] ${job.name} failed`, err);
      }
    };
    tick();
    setInterval(tick, job.everyMs).unref();
  }
  console.log(`[jobs] ${JOBS.length} scheduled`);
}

/** What is scheduled, for the platform health surface (PF-PLAT-003). A job
 *  list nobody can see is a job list nobody notices has stopped. */
export const scheduledJobs = (
  atMs = now(),
  disabled = runtimeConfig.disableJobs,
): Array<{
  name: string;
  everyMinutes: number;
  lastRunAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'overdue' | 'disabled' | null;
  durationMs: number | null;
  error: string | null;
}> => JOBS.map((job) => {
  const latest = db
    .select()
    .from(schema.jobRuns)
    .where(eq(schema.jobRuns.job, job.name))
    .orderBy(sql`${schema.jobRuns.startedAt} desc`)
    .limit(1)
    .get();
  const overdueAfterMs = Math.max(5 * MINUTE, 2 * job.everyMs);
  const overdue = latest !== undefined && latest.status !== 'failed' && atMs - latest.startedAt > overdueAfterMs;
  return {
    name: job.name,
    everyMinutes: Math.round(job.everyMs / MINUTE),
    lastRunAt: latest ? new Date(latest.startedAt).toISOString() : null,
    status: disabled
      ? 'disabled'
      : overdue
        ? 'overdue'
        : latest
          ? (latest.status as 'running' | 'succeeded' | 'failed')
          : null,
    durationMs: latest?.durationMs ?? null,
    error: overdue
      ? `No run observed within ${Math.round(overdueAfterMs / MINUTE)} minutes.`
      : latest?.error ?? null,
  };
});

export const jobsForTest = {
  expireMemberships,
  closeStaleCheckIns,
  closingInstant,
  expireWaitlistOffers,
  releaseExpiredHolds,
  deliverQueuedAutomations,
  pruneOperationalRows,
  execute: (name: string, clock?: () => number): void => {
    const job = JOBS.find((candidate) => candidate.name === name);
    if (!job) throw new Error(`Unknown scheduled job: ${name}`);
    executeJob(job, clock);
  },
};
