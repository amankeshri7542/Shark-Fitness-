import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { DAY_KEYS, deriveState, hoursFor } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { emit } from '../lib/events.js';
import { processDueDeliveries, runDueAutomations } from '../services/automations.js';
import { pruneOperationalData } from '../services/maintenance.js';
import { expireChallengeInvitations } from '../services/engagement-admin.js';
import { extendActiveSeries } from '../services/schedule-series.js';
import { runDueDunning } from '../services/dunning.js';
import { rollUpCompletedDays } from '../services/reports.js';
import { DAY, HOUR, MINUTE, addDays, isoDate, localClockOnDay, localDayIndex, now, startOfLocalDay } from '../lib/time.js';
import { id } from '../lib/ids.js';
import { log, reportException } from '../lib/observability.js';
import { redactSensitiveText } from '../lib/redaction.js';

/**
 * Cron-equivalent jobs (Engineering PRD §"Background processing").
 *
 * Every job is idempotent — running it twice must produce the same state as
 * running it once, because that is the only assumption that survives a restart
 * mid-run.
 */

type Job = { name: string; everyMs: number; run: () => unknown };
type JobSummary = Record<string, string | number | boolean | null>;

/** Memberships move to grace, then expire, on their dates rather than whenever
 *  someone next opens a screen. */
function expireMemberships(): JobSummary {
  const tenants = db.select().from(schema.tenants).all();
  let membershipsTransitioned = 0;

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
      membershipsTransitioned += 1;
    }
  }
  return { membershipsTransitioned };
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

function closeStaleCheckIns(atMs = now()): JobSummary {
  const branches = db.select().from(schema.branches).all();
  let checkInsClosed = 0;

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
      checkInsClosed += open.length;
      emit({
        tenantId: branch.tenantId,
        branchId: branch.id,
        channel: channels.branch(branch.id),
        topic: 'occupancy.changed',
        payload: { branchId: branch.id, autoClosed: open.length },
      });
    }
  }
  return { checkInsClosed };
}

/** A waitlist offer that is not taken up inside its window passes on. */
function expireWaitlistOffers(): JobSummary {
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
  return { offersExpired: stale.length };
}

/** Holds do not occupy a seat once they lapse. */
function releaseExpiredHolds(): JobSummary {
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
  return { holdsReleased: stale.length };
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
function rollUpMetrics(): JobSummary {
  const tenants = db.select({ id: schema.tenants.id }).from(schema.tenants).all();
  for (const tenant of tenants) {
    rollUpCompletedDays(tenant.id, 3);
  }
  return { tenantsRolledUp: tenants.length };
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
function runAutomations(): JobSummary {
  const { ran, sent } = runDueAutomations();
  if (ran > 0) log('info', 'scheduler_automations_completed', { ran, sent });
  return { ran, sent };
}

function deliverQueuedAutomations(): JobSummary {
  const result = processDueDeliveries();
  if (result.processed > 0) {
    log('info', 'scheduler_automation_delivery_completed', result);
  }
  if (result.failed > 0) {
    throw new Error(`${result.failed} automation delivery attempt${result.failed === 1 ? '' : 's'} failed.`);
  }
  return safeSummary(result);
}

/** Advance every dunning step that is due.
 *
 *  Re-entrant: each step is claimed by a conditional update before any work
 *  happens, so a second worker finds it taken and moves on. That matters more
 *  here than in the other jobs because the work sends a message to a member. */
function advanceDunning(): JobSummary {
  const result = runDueDunning();
  if (result.sent + result.escalated + result.recovered > 0) {
    log('info', 'scheduler_dunning_completed', { ...result });
  }
  return safeSummary(result);
}

/** Roll every active recurring class forward to the horizon.
 *
 *  Idempotent by construction — occurrence identity is a unique index — so a
 *  second instance running this costs a wasted read rather than a duplicated
 *  timetable. That is deliberate: of the eight jobs here it is the one most
 *  likely to be running when somebody scales out by accident. */
function extendSeriesHorizon(): JobSummary {
  const result = extendActiveSeries();
  if (result.created > 0) {
    log('info', 'scheduler_series_extended', result);
  }
  return safeSummary(result);
}

function pruneOperationalRows(): JobSummary {
  const result = pruneOperationalData();
  const removed = Object.values(result).reduce((total, count) => total + count, 0);
  if (removed > 0) log('info', 'scheduler_operational_data_pruned', { removed });

  // Bookkeeping, not enforcement: every read path already treats a lapsed
  // invitation as unusable, so this only stops the stored state column from
  // saying `pending` about something nobody can accept.
  const expired = expireChallengeInvitations();
  if (expired > 0) log('info', 'scheduler_challenge_invitations_expired', { expired });
  return { ...result, challengeInvitationsExpired: expired };
}

const JOBS: Job[] = [
  { name: 'deliver-automation-queue', everyMs: MINUTE, run: deliverQueuedAutomations },
  { name: 'run-automations', everyMs: HOUR, run: runAutomations },
  { name: 'expire-memberships', everyMs: 6 * HOUR, run: expireMemberships },
  { name: 'roll-up-metrics', everyMs: 6 * HOUR, run: rollUpMetrics },
  { name: 'close-stale-check-ins', everyMs: 30 * MINUTE, run: closeStaleCheckIns },
  { name: 'expire-waitlist-offers', everyMs: MINUTE, run: expireWaitlistOffers },
  { name: 'release-expired-holds', everyMs: MINUTE, run: releaseExpiredHolds },
  { name: 'run-dunning', everyMs: 15 * MINUTE, run: advanceDunning },
  { name: 'extend-class-series', everyMs: 6 * HOUR, run: extendSeriesHorizon },
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
      summary: null,
      errorCategory: null,
      buildId: runtimeConfig.release,
    })
    .run();
  try {
    const summary = safeSummary(job.run());
    const finishedAt = clock();
    db.update(schema.jobRuns)
      .set({
        status: 'succeeded',
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        error: null,
        errorCategory: null,
        summary,
      })
      .where(eq(schema.jobRuns.id, runId))
      .run();
    log('info', 'scheduler_job_finished', {
      job: job.name,
      runId,
      outcome: 'succeeded',
      durationMs: Math.max(0, finishedAt - startedAt),
      summary,
    });
  } catch (error) {
    const finishedAt = clock();
    const errorCategory = categoryFor(error);
    const errorMessage = safeErrorMessage(error);
    db.update(schema.jobRuns)
      .set({
        status: 'failed',
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        error: errorMessage,
        errorCategory,
        summary: {},
      })
      .where(eq(schema.jobRuns.id, runId))
      .run();
    log('error', 'scheduler_job_finished', {
      job: job.name,
      runId,
      outcome: 'failed',
      durationMs: Math.max(0, finishedAt - startedAt),
      errorCategory,
      errorMessage,
    });
    throw error;
  }
}

function safeSummary(value: unknown): JobSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const summary: JobSummary = {};
  for (const [key, item] of Object.entries(value).slice(0, 24)) {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      summary[key.slice(0, 80)] = typeof item === 'string' ? redactSensitiveText(item, 200) : item;
    } else if (Array.isArray(item)) {
      summary[`${key.slice(0, 70)}Count`] = item.length;
    }
  }
  return summary;
}

function categoryFor(error: unknown): string {
  return (error instanceof Error ? error.name : 'UnknownError').slice(0, 120);
}

function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

export function startScheduler(): void {
  if (runtimeConfig.disableJobs) {
    log('info', 'scheduler_disabled');
    return;
  }

  for (const job of JOBS) {
    const tick = () => {
      try {
        executeJob(job);
      } catch (err) {
        reportException(err, { job: job.name, source: 'scheduler' });
      }
    };
    tick();
    setInterval(tick, job.everyMs).unref();
  }
  log('info', 'scheduler_started', { jobCount: JOBS.length });
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
  summary: JobSummary;
  buildId: string | null;
  lastSuccessfulRunAt: string | null;
  lastFailedRunAt: string | null;
  lastFailureCategory: string | null;
  lastFailureMessage: string | null;
  nextExpectedAt: string | null;
  health: 'healthy' | 'stale' | 'failing' | 'never' | 'disabled';
}> => JOBS.map((job) => {
  const latest = db
    .select()
    .from(schema.jobRuns)
    .where(eq(schema.jobRuns.job, job.name))
    .orderBy(sql`${schema.jobRuns.startedAt} desc`)
    .limit(1)
    .get();
  const latestSuccess = db
    .select()
    .from(schema.jobRuns)
    .where(and(eq(schema.jobRuns.job, job.name), eq(schema.jobRuns.status, 'succeeded')))
    .orderBy(sql`${schema.jobRuns.startedAt} desc`)
    .limit(1)
    .get();
  const latestFailure = db
    .select()
    .from(schema.jobRuns)
    .where(and(eq(schema.jobRuns.job, job.name), eq(schema.jobRuns.status, 'failed')))
    .orderBy(sql`${schema.jobRuns.startedAt} desc`)
    .limit(1)
    .get();
  const overdueAfterMs = Math.max(5 * MINUTE, 2 * job.everyMs);
  const overdue = latest !== undefined && latest.status !== 'failed' && atMs - latest.startedAt > overdueAfterMs;
  const health = disabled
    ? 'disabled'
    : !latest
      ? 'never'
      : latest.status === 'failed'
        ? 'failing'
        : overdue
          ? 'stale'
          : 'healthy';
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
    summary: latest?.summary ?? {},
    buildId: latest?.buildId ?? null,
    lastSuccessfulRunAt: latestSuccess ? new Date(latestSuccess.finishedAt ?? latestSuccess.startedAt).toISOString() : null,
    lastFailedRunAt: latestFailure ? new Date(latestFailure.finishedAt ?? latestFailure.startedAt).toISOString() : null,
    lastFailureCategory: latestFailure?.errorCategory ?? null,
    lastFailureMessage: latestFailure?.error ?? null,
    nextExpectedAt: !disabled && latest ? new Date(latest.startedAt + job.everyMs).toISOString() : null,
    health,
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
