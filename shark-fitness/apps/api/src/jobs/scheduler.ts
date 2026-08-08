import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { deriveState } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { emit } from '../lib/events.js';
import { HOUR, MINUTE, isoDate, now } from '../lib/time.js';

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
function closeStaleCheckIns(): void {
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
          lt(schema.checkIns.enteredAt, now() - 6 * HOUR),
        ),
      )
      .all();

    for (const row of open) {
      db.update(schema.checkIns)
        .set({ exitedAt: now(), autoClosed: true })
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

const JOBS: Job[] = [
  { name: 'expire-memberships', everyMs: 6 * HOUR, run: expireMemberships },
  { name: 'close-stale-check-ins', everyMs: 30 * MINUTE, run: closeStaleCheckIns },
  { name: 'expire-waitlist-offers', everyMs: MINUTE, run: expireWaitlistOffers },
  { name: 'release-expired-holds', everyMs: MINUTE, run: releaseExpiredHolds },
];

export function startScheduler(): void {
  if (process.env.SHARK_DISABLE_JOBS === 'true') {
    console.log('[jobs] disabled');
    return;
  }

  for (const job of JOBS) {
    const tick = () => {
      try {
        job.run();
      } catch (err) {
        console.error(`[jobs] ${job.name} failed`, err);
      }
    };
    tick();
    setInterval(tick, job.everyMs).unref();
  }
  console.log(`[jobs] ${JOBS.length} scheduled`);
}

export const jobsForTest = { expireMemberships, closeStaleCheckIns, expireWaitlistOffers, releaseExpiredHolds };
