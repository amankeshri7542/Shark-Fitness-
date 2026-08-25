import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { DUNNING_OFFSETS_DAYS, dunningPlan, formatMoney, insideQuietHours } from '@shark/domain';
import { db, schema, transact } from '../db/client.js';
import { branchScope, requirePermission, type RequestContext } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { invalid, notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { DAY, addDays, isoDate, localClockOnDay, localMinutes, now } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { branchPolicy } from '../lib/policy.js';
import { NO_PROVIDER, submitRetry } from '../lib/payment-provider.js';

/**
 * Dunning (PF-BILL-005) — the internal state machine.
 *
 * A failed payment used to write one `dunning_attempts` row and stop. Nothing
 * advanced it, nothing told the member, nothing recovered it when the debt was
 * settled, and nothing escalated it when it was not. The table described a
 * process that did not run.
 *
 * It runs now, and it is careful about one thing above all others:
 *
 * **It never claims to have charged anybody.** There is no payment provider —
 * see `lib/payment-provider.ts`, which is the seam where one would go. Every
 * attempt asks it for a retry and records what came back; today that is always
 * `no_payment_provider_configured`, written onto the row. What the member gets
 * is a truthful in-app message asking them to settle at the desk, because that
 * is the only collection this system can actually perform.
 *
 * Three properties that make it safe to run on a timer:
 *
 * - **Durable.** The step's state is a column, not a computation over the
 *   clock. A restart resumes where it stopped.
 * - **Idempotent.** One row per (invoice, attempt), enforced by a unique
 *   index, so "schedule the next step" is safe to execute twice.
 * - **Scheduler-safe.** A step is claimed by a conditional update before any
 *   work happens; a second worker finds it claimed and moves on. That matters
 *   more here than elsewhere because the work sends a message to a member.
 */

const LOCK_TIMEOUT_MS = 5 * 60_000;

export type DunningAttempt = typeof schema.dunningAttempts.$inferSelect;

/* ============================================================================
   Opening a case
   ========================================================================= */

/**
 * A payment failed; start or continue the sequence for this invoice.
 *
 * Idempotent by design: an invoice already in dunning keeps the sequence it
 * has rather than restarting at attempt one, because a second failure on a
 * debt that is already three reminders deep should not reset the clock in the
 * member's favour or the gym's.
 */
export function openDunning(
  ctx: { tenantId: string; userId?: string },
  input: { invoiceId: string; reason: string },
): { opened: boolean; attempt: number } {
  const atMs = now();
  const invoice = db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, input.invoiceId), eq(schema.invoices.tenantId, ctx.tenantId)))
    .get();
  if (!invoice) throw notFound('That invoice');
  if (invoice.voided) throw invalid('A voided invoice is not collected.');

  const existing = db
    .select()
    .from(schema.dunningAttempts)
    .where(
      and(
        eq(schema.dunningAttempts.tenantId, ctx.tenantId),
        eq(schema.dunningAttempts.invoiceId, input.invoiceId),
        inArray(schema.dunningAttempts.state, ['scheduled', 'deferred']),
      ),
    )
    .get();
  if (existing) return { opened: false, attempt: existing.attempt };

  const plan = dunningPlan(preferredChannels(ctx.tenantId, invoice.branchId));
  const first = plan[0]!;

  scheduleStep(ctx.tenantId, input.invoiceId, first.attempt, first.channel, atMs);
  return { opened: true, attempt: first.attempt };
}

/** Channels the tenant is willing to use. Only `in_app` can actually be
 *  delivered by this system; the rest are recorded as the intent and would be
 *  honoured by whichever provider is wired up later. */
function preferredChannels(tenantId: string, branchId: string): string[] {
  const configured = branchPolicy<string[]>(tenantId, branchId, 'dunningChannels', ['in_app', 'email']).value;
  return Array.isArray(configured) && configured.length > 0 ? configured : ['in_app', 'email'];
}

/** Insert one step, tolerating the race. The unique index is the authority. */
function scheduleStep(
  tenantId: string,
  invoiceId: string,
  attempt: number,
  channel: string,
  scheduledFor: number,
): void {
  try {
    db.insert(schema.dunningAttempts)
      .values({
        id: id('dun'),
        tenantId,
        invoiceId,
        attempt,
        channel,
        scheduledFor,
        state: 'scheduled',
        sentAt: null,
        stopReason: null,
        retrySubmitted: false,
        retryOutcome: null,
        providerRef: null,
        notificationId: null,
        lockedAt: null,
        attempts: 0,
        lastError: null,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  } catch (error) {
    // Already scheduled by another writer. That is the desired end state.
    if (String(error).includes('UNIQUE') || String(error).includes('constraint')) return;
    throw error;
  }
}

/* ============================================================================
   Running the sequence
   ========================================================================= */

export interface DunningRunResult {
  considered: number;
  sent: number;
  deferred: number;
  recovered: number;
  stopped: number;
  escalated: number;
  /** Retries that could not be submitted because no provider exists. Counted
   *  rather than hidden, so the number is visible in the job log. */
  retriesUnavailable: number;
}

/**
 * Advance every step that is due. The scheduler's entry point.
 *
 * Deliberately one function rather than a per-invoice call: the ordering that
 * matters is by `scheduledFor`, and the recovery check has to happen before
 * the send so a member who paid this morning is not chased this afternoon.
 */
export function runDueDunning(atMs = now()): DunningRunResult {
  const result: DunningRunResult = {
    considered: 0,
    sent: 0,
    deferred: 0,
    recovered: 0,
    stopped: 0,
    escalated: 0,
    retriesUnavailable: 0,
  };

  const due = db
    .select()
    .from(schema.dunningAttempts)
    .where(
      and(
        inArray(schema.dunningAttempts.state, ['scheduled', 'deferred']),
        lte(schema.dunningAttempts.scheduledFor, atMs),
        // Not claimed, or claimed long enough ago that the worker holding it
        // is gone. Without the second clause a crash mid-step would strand the
        // sequence for ever.
        or(
          isNull(schema.dunningAttempts.lockedAt),
          lte(schema.dunningAttempts.lockedAt, atMs - LOCK_TIMEOUT_MS),
        ),
      ),
    )
    .orderBy(asc(schema.dunningAttempts.scheduledFor))
    .all();

  for (const step of due) {
    result.considered += 1;
    // Claim it. The `where` restates the state and lock we read, so if another
    // worker took it in between, this updates nothing and we skip.
    const claimed = db
      .update(schema.dunningAttempts)
      .set({ lockedAt: atMs, attempts: step.attempts + 1, updatedAt: atMs })
      .where(
        and(
          eq(schema.dunningAttempts.id, step.id),
          eq(schema.dunningAttempts.state, step.state),
          step.lockedAt === null
            ? isNull(schema.dunningAttempts.lockedAt)
            : eq(schema.dunningAttempts.lockedAt, step.lockedAt),
        ),
      )
      .run();
    if (claimed.changes === 0) continue;

    try {
      advanceStep(step, atMs, result);
    } catch (error) {
      db.update(schema.dunningAttempts)
        .set({ lockedAt: null, lastError: String(error).slice(0, 500), updatedAt: atMs })
        .where(eq(schema.dunningAttempts.id, step.id))
        .run();
    }
  }

  return result;
}

function advanceStep(step: DunningAttempt, atMs: number, result: DunningRunResult): void {
  const invoice = db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, step.invoiceId))
    .get();

  // The invoice vanished, or was voided. Either way there is nothing to chase.
  if (!invoice || invoice.voided) {
    closeStep(step, atMs, invoice ? 'invoice_voided' : 'invoice_missing');
    result.stopped += 1;
    return;
  }

  const outstandingMinor = invoice.totalMinor - invoice.paidMinor - invoice.refundedMinor;
  if (outstandingMinor <= 0) {
    // Recovered. Checked before the send so somebody who paid this morning is
    // not chased this afternoon.
    closeStep(step, atMs, 'recovered');
    result.recovered += 1;
    emit({
      tenantId: invoice.tenantId,
      branchId: invoice.branchId,
      channel: channels.member(invoice.memberId),
      topic: 'invoice.updated',
      payload: { invoiceId: invoice.id, dunning: 'recovered' },
    });
    return;
  }

  const tz = branchTimeZone(invoice.tenantId, invoice.branchId);
  const quietFrom = String(branchPolicy(invoice.tenantId, invoice.branchId, 'quietHoursFrom', '21:00').value);
  const quietTo = String(branchPolicy(invoice.tenantId, invoice.branchId, 'quietHoursTo', '08:00').value);
  const [fromH = 21, fromM = 0] = quietFrom.split(':').map(Number);
  const [toH = 8, toM = 0] = quietTo.split(':').map(Number);

  // A payment reminder at 02:00 is a complaint, not a collection. Defer rather
  // than skip: the step keeps its place in the sequence.
  if (insideQuietHours(localMinutes(atMs, tz), fromH * 60 + fromM, toH * 60 + toM)) {
    db.update(schema.dunningAttempts)
      .set({
        state: 'deferred',
        // Next whole hour past the end of quiet hours, in the branch's zone.
        scheduledFor: quietHoursEnd(atMs, tz, toH * 60 + toM),
        lockedAt: null,
        updatedAt: atMs,
      })
      .where(eq(schema.dunningAttempts.id, step.id))
      .run();
    result.deferred += 1;
    return;
  }

  // Ask for a retry. There is no provider, so this always comes back refused —
  // and that refusal is written down rather than glossed over.
  const retry = submitRetry({
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    memberId: invoice.memberId,
    amountMinor: outstandingMinor,
    currency: invoice.currency,
    idempotencyKey: `dunning:${invoice.id}:${step.attempt}`,
  });
  if (!retry.submitted) result.retriesUnavailable += 1;

  const plan = dunningPlan(preferredChannels(invoice.tenantId, invoice.branchId));
  const isFinal = step.attempt >= DUNNING_OFFSETS_DAYS.length;

  transact(() => {
    const notificationId = notifyMember(invoice, step, outstandingMinor, retry.submitted, isFinal, atMs);

    db.update(schema.dunningAttempts)
      .set({
        state: isFinal ? 'escalated' : 'sent',
        sentAt: atMs,
        lockedAt: null,
        retrySubmitted: retry.submitted,
        // The honest column. Today: `no_payment_provider_configured`.
        retryOutcome: retry.submitted ? 'submitted' : retry.reason,
        providerRef: retry.submitted ? retry.providerRef : null,
        notificationId,
        stopReason: isFinal ? 'escalated_to_staff' : null,
        updatedAt: atMs,
      })
      .where(eq(schema.dunningAttempts.id, step.id))
      .run();

    if (isFinal) {
      result.escalated += 1;
      audit(
        systemContext(invoice.tenantId, invoice.branchId),
        {
          action: 'dunning.escalated',
          entityType: 'invoice',
          entityId: invoice.id,
          entityLabel: invoice.number,
          branchId: invoice.branchId,
          after: {
            attempts: step.attempt,
            outstandingMinor,
            // Said explicitly on the audit row: nobody was charged.
            retryOutcome: retry.submitted ? 'submitted' : retry.reason,
          },
        },
      );
    } else {
      const next = plan.find((s) => s.attempt === step.attempt + 1);
      if (next) {
        const offsetDays = next.offsetDays - (plan.find((s) => s.attempt === step.attempt)?.offsetDays ?? 0);
        scheduleStep(
          invoice.tenantId,
          invoice.id,
          next.attempt,
          next.channel,
          atMs + Math.max(1, offsetDays) * DAY,
        );
      }
      result.sent += 1;
    }
  });
}

/** The next instant outside quiet hours, in the branch's zone. */
function quietHoursEnd(atMs: number, timeZone: string, endMinutes: number): number {
  const current = localMinutes(atMs, timeZone);
  const day = isoDate(atMs, timeZone);
  // Past the end already means the window wraps midnight and we are before it;
  // the end is tomorrow morning.
  const targetDay = current >= endMinutes ? addDays(day, 1) : day;
  const clock = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
  return localClockSafe(targetDay, clock, timeZone, atMs);
}

/** `localClockOnDay` with a floor of "later than now", so a deferral can never
 *  schedule into the past and spin the worker. */
function localClockSafe(isoDay: string, clock: string, timeZone: string, atMs: number): number {
  const resolved = localClockOnDay(isoDay, clock, timeZone);
  return resolved > atMs ? resolved : atMs + 60 * 60_000;
}


/**
 * Tell the member, truthfully.
 *
 * The wording is the point. The system cannot take a payment, so it does not
 * say it tried and failed, and it does not say it will try again. It says what
 * is owed and where to settle it.
 */
function notifyMember(
  invoice: typeof schema.invoices.$inferSelect,
  step: DunningAttempt,
  outstandingMinor: number,
  retrySubmitted: boolean,
  isFinal: boolean,
  atMs: number,
): string | null {
  const member = db
    .select({ userId: schema.members.userId })
    .from(schema.members)
    .where(eq(schema.members.id, invoice.memberId))
    .get();
  if (!member?.userId) return null;

  const amount = formatMoney(outstandingMinor, invoice.currency);
  const body = retrySubmitted
    ? `We are retrying the payment of ${amount} for invoice ${invoice.number}.`
    : isFinal
      ? `Invoice ${invoice.number} still has ${amount} outstanding. We cannot collect it automatically, so please settle it at reception — the team has been asked to get in touch.`
      : `Invoice ${invoice.number} has ${amount} outstanding. We cannot collect it automatically, so please settle it at reception or in the app.`;

  const notificationId = id('ntf');
  db.insert(schema.notifications)
    .values({
      id: notificationId,
      tenantId: invoice.tenantId,
      userId: member.userId,
      channel: 'in_app',
      kind: 'payment_due',
      title: isFinal ? 'Your membership payment is overdue' : 'A payment is outstanding',
      body,
      link: '/billing',
      templateCode: `dunning.attempt_${step.attempt}`,
      state: 'sent',
      attempts: 1,
      lastError: null,
      createdAt: atMs,
      readAt: null,
    })
    .run();
  return notificationId;
}

function closeStep(step: DunningAttempt, atMs: number, reason: string): void {
  db.update(schema.dunningAttempts)
    .set({ state: 'stopped', stopReason: reason, lockedAt: null, updatedAt: atMs })
    .where(eq(schema.dunningAttempts.id, step.id))
    .run();

  // Anything still queued for this invoice goes with it. A recovered debt must
  // not produce a reminder next week.
  db.update(schema.dunningAttempts)
    .set({ state: 'stopped', stopReason: reason, lockedAt: null, updatedAt: atMs })
    .where(
      and(
        eq(schema.dunningAttempts.invoiceId, step.invoiceId),
        inArray(schema.dunningAttempts.state, ['scheduled', 'deferred']),
      ),
    )
    .run();
}

/** Audit rows need an actor. Jobs have none, and inventing a user id would put
 *  a person's name on something they did not do. */
function systemContext(tenantId: string, branchId: string): RequestContext {
  return {
    requestId: `job:${id('req')}`,
    sessionId: 'system',
    authMethod: 'bearer',
    tenantId,
    userId: 'system',
    memberId: null,
    staffId: null,
    role: 'platform_admin',
    name: 'Dunning scheduler',
    branchIds: [branchId],
    activeBranchId: branchId,
    permissions: [],
    ip: '127.0.0.1',
    userAgent: 'shark-scheduler',
    impersonatorId: null,
  };
}

/**
 * Stop dunning an invoice, because the money arrived or the debt was written
 * off. Called by the payment and void paths.
 */
export function stopDunning(tenantId: string, invoiceId: string, reason: string): number {
  const atMs = now();
  const open = db
    .select()
    .from(schema.dunningAttempts)
    .where(
      and(
        eq(schema.dunningAttempts.tenantId, tenantId),
        eq(schema.dunningAttempts.invoiceId, invoiceId),
        inArray(schema.dunningAttempts.state, ['scheduled', 'deferred']),
      ),
    )
    .all();
  if (open.length === 0) return 0;

  db.update(schema.dunningAttempts)
    .set({ state: 'stopped', stopReason: reason, lockedAt: null, updatedAt: atMs })
    .where(
      and(
        eq(schema.dunningAttempts.tenantId, tenantId),
        eq(schema.dunningAttempts.invoiceId, invoiceId),
        inArray(schema.dunningAttempts.state, ['scheduled', 'deferred']),
      ),
    )
    .run();
  return open.length;
}

/* ============================================================================
   Reads
   ========================================================================= */

/** The dunning state of one invoice, for the console's invoice screen. */
export function dunningForInvoice(ctx: RequestContext, invoiceId: string) {
  requirePermission(ctx, 'billing.view');
  const invoice = db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, ctx.tenantId)))
    .get();
  if (!invoice || !branchScope(ctx).includes(invoice.branchId)) throw notFound('That invoice');

  const attempts = db
    .select()
    .from(schema.dunningAttempts)
    .where(eq(schema.dunningAttempts.invoiceId, invoiceId))
    .orderBy(asc(schema.dunningAttempts.attempt))
    .all();

  const live = attempts.find((row) => row.state === 'scheduled' || row.state === 'deferred') ?? null;

  return {
    invoiceId,
    outstandingMinor: invoice.totalMinor - invoice.paidMinor - invoice.refundedMinor,
    currency: invoice.currency,
    totalSteps: DUNNING_OFFSETS_DAYS.length,
    attempts: attempts.map((row) => ({
      attempt: row.attempt,
      channel: row.channel,
      state: row.state,
      scheduledFor: row.scheduledFor,
      sentAt: row.sentAt,
      stopReason: row.stopReason,
      retrySubmitted: row.retrySubmitted,
      retryOutcome: row.retryOutcome,
    })),
    nextAttemptAt: live?.scheduledFor ?? null,
    escalated: attempts.some((row) => row.state === 'escalated'),
    /**
     * Stated on every read, because the console must not imply a retry that
     * cannot happen. This is the string a UI shows next to "retry payment".
     */
    automaticCollection: {
      available: false,
      reason: NO_PROVIDER,
      message:
        'No payment provider is connected, so this charge cannot be retried automatically. The member has been asked to settle it at reception or in the app.',
    },
  };
}
