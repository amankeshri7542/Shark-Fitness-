import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { id } from '../lib/ids.js';
import { DAY, now } from '../lib/time.js';
import { NO_PROVIDER, resolvePaymentProvider, submitRetry } from '../lib/payment-provider.js';
import { dunningForInvoice, openDunning, runDueDunning, stopDunning } from '../services/dunning.js';

/* ============================================================================
   Dunning (PF-BILL-005).

   A failed payment wrote one `dunning_attempts` row and stopped. Nothing
   advanced it, nothing told the member, nothing closed it when the debt was
   settled, and nothing escalated it when it was not. The table described a
   process that did not run.

   The property these tests exist for, above all others: **the system never
   claims to have charged anybody.** There is no payment provider, and every
   attempt records that rather than glossing it as a retry.

   Also covered: durability across a restart, idempotency of scheduling,
   scheduler re-entrancy, quiet hours, recovery, and escalation.
   ========================================================================= */

interface Session { cookie: string; csrfToken: string }
const cache = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

const OWNER = 'owner@sharkfitness.in';
const TENANT = 'ten_shark';

const createdInvoiceIds: string[] = [];
let memberId = '';
let memberUserId = '';

beforeAll(() => {
  const member = db
    .select({ id: schema.members.id, userId: schema.members.userId })
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, TENANT), eq(schema.members.homeBranchId, 'br_kor')))
    .get()!;
  memberId = member.id;
  memberUserId = member.userId!;
});

afterAll(() => {
  if (createdInvoiceIds.length > 0) {
    db.delete(schema.dunningAttempts).where(inArray(schema.dunningAttempts.invoiceId, createdInvoiceIds)).run();
    db.delete(schema.payments).where(inArray(schema.payments.invoiceId, createdInvoiceIds)).run();
    db.delete(schema.invoices).where(inArray(schema.invoices.id, createdInvoiceIds)).run();
  }
});

/** An unpaid invoice this suite owns. */
function makeInvoice(totalMinor = 500_000): string {
  const invoiceId = id('inv');
  db.insert(schema.invoices)
    .values({
      id: invoiceId,
      tenantId: TENANT,
      branchId: 'br_kor',
      memberId,
      number: `DUN-${invoiceId.slice(-6)}`,
      state: 'overdue',
      issuedOn: '2026-01-01',
      dueOn: '2026-01-15',
      currency: 'INR',
      subtotalMinor: totalMinor,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor,
      paidMinor: 0,
      refundedMinor: 0,
      voided: false,
      voidReason: null,
      refType: null,
      refId: null,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  createdInvoiceIds.push(invoiceId);
  return invoiceId;
}

function attemptsFor(invoiceId: string) {
  return db
    .select()
    .from(schema.dunningAttempts)
    .where(eq(schema.dunningAttempts.invoiceId, invoiceId))
    .orderBy(asc(schema.dunningAttempts.attempt))
    .all();
}

/** Quiet hours are 21:00–08:00 in Asia/Kolkata, and this suite must not pass
 *  or fail on the hour it happens to run at. 14:00 IST is comfortably outside
 *  the window on any date. */
function middayIST(daysFromNow = 0): number {
  const day = new Date(now() + daysFromNow * DAY).toISOString().slice(0, 10);
  return Date.parse(`${day}T14:00:00+05:30`);
}

function midnightIST(daysFromNow = 0): number {
  const day = new Date(now() + daysFromNow * DAY).toISOString().slice(0, 10);
  return Date.parse(`${day}T02:00:00+05:30`);
}

describe('the provider boundary is honest', () => {
  it('has no provider, and says so with a reason code rather than a silence', () => {
    expect(resolvePaymentProvider()).toBeNull();

    const result = submitRetry({
      tenantId: TENANT,
      invoiceId: 'inv_whatever',
      memberId: 'mem_whatever',
      amountMinor: 100_000,
      currency: 'INR',
      idempotencyKey: 'probe',
    });
    expect(result.submitted).toBe(false);
    expect(result).toMatchObject({ reason: NO_PROVIDER, provider: null });
    // There is no branch that can return a success. If one is ever added it
    // must come with an adapter, and this assertion is the tripwire.
    expect('providerRef' in result).toBe(false);
  });
});

describe('opening a case', () => {
  it('schedules the first attempt and does not restart a sequence already running', () => {
    const invoiceId = makeInvoice();
    const first = openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    expect(first).toMatchObject({ opened: true, attempt: 1 });

    // A second failure on a debt already three reminders deep must not reset
    // the clock in anybody's favour.
    const second = openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined again' });
    expect(second.opened).toBe(false);
    expect(attemptsFor(invoiceId).length).toBe(1);
  });

  it('refuses to chase a voided invoice', () => {
    const invoiceId = makeInvoice();
    db.update(schema.invoices).set({ voided: true, state: 'void' }).where(eq(schema.invoices.id, invoiceId)).run();
    expect(() => openDunning({ tenantId: TENANT }, { invoiceId, reason: 'x' })).toThrow();
  });

  it('holds one row per invoice per attempt at the database', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    const step = attemptsFor(invoiceId)[0]!;

    expect(() =>
      db.insert(schema.dunningAttempts).values({ ...step, id: id('dun') }).run(),
    ).toThrow(/UNIQUE|constraint/i);
  });
});

describe('running the sequence', () => {
  it('records that the retry could not be submitted, and tells the member the truth', () => {
    const invoiceId = makeInvoice(250_000);
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });

    const result = runDueDunning(middayIST());
    expect(result.retriesUnavailable).toBeGreaterThan(0);

    const step = attemptsFor(invoiceId)[0]!;
    expect(step.state).toBe('sent');
    // The honest columns.
    expect(step.retrySubmitted).toBe(false);
    expect(step.retryOutcome).toBe(NO_PROVIDER);
    expect(step.providerRef).toBeNull();

    // The member was told. Asserted through the step's own linked
    // notification rather than a count: the worker is tenant-wide and will
    // legitimately have advanced other invoices in this file on the same run.
    expect(step.notificationId).toBeTruthy();
    const notification = db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, step.notificationId!))
      .get()!;
    expect(notification.userId).toBe(memberUserId);
    expect(notification.kind).toBe('payment_due');
    // And the message does not claim a charge was tried.
    expect(notification.body).toMatch(/cannot collect it automatically/i);
    expect(notification.body).not.toMatch(/we (tried|attempted|charged)|retrying/i);
  });

  it('schedules the next attempt with a backoff, and only one of it', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    const at = middayIST();
    runDueDunning(at);

    const after = attemptsFor(invoiceId);
    expect(after.length).toBe(2);
    expect(after[1]!.attempt).toBe(2);
    expect(after[1]!.state).toBe('scheduled');
    expect(after[1]!.scheduledFor).toBeGreaterThan(at);

    // Running again before the next step is due changes nothing.
    const idle = runDueDunning(at + 60_000);
    expect(idle.sent).toBe(0);
    expect(attemptsFor(invoiceId).length).toBe(2);
  });

  it('defers into quiet hours instead of messaging a member at 02:00', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });

    // Tomorrow's 02:00 IST: today's is already behind us, so the step would
    // never be due and the run would consider nothing.
    const night = midnightIST(1);
    const result = runDueDunning(night);
    expect(result.deferred).toBeGreaterThan(0);

    const step = attemptsFor(invoiceId)[0]!;
    expect(step.state).toBe('deferred');
    expect(step.sentAt).toBeNull();
    // Rescheduled forward, never into the past — a deferral that lands behind
    // `now` would spin the worker.
    expect(step.scheduledFor).toBeGreaterThan(night);
    // And nothing was sent.
    expect(step.notificationId).toBeNull();

    // The deferred step still runs once the window has passed.
    runDueDunning(step.scheduledFor + 60_000);
    expect(attemptsFor(invoiceId)[0]!.state).toBe('sent');
  });

  it('escalates after the final attempt rather than chasing for ever', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });

    // Walk the whole plan, jumping the clock to each scheduled step.
    for (let i = 0; i < 8; i += 1) {
      const live = attemptsFor(invoiceId).find(
        (row) => row.state === 'scheduled' || row.state === 'deferred',
      );
      if (!live) break;
      // Always at midday so quiet hours never enter into it.
      const at = Math.max(live.scheduledFor, middayIST());
      runDueDunning(Date.parse(`${new Date(at).toISOString().slice(0, 10)}T14:00:00+05:30`));
    }

    const all = attemptsFor(invoiceId);
    const final = all.at(-1)!;
    expect(final.state).toBe('escalated');
    expect(final.stopReason).toBe('escalated_to_staff');
    // No further step was queued behind it.
    expect(all.some((row) => row.state === 'scheduled' || row.state === 'deferred')).toBe(false);

    // Escalation is on the audit trail, and says nobody was charged.
    const entry = db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, invoiceId), eq(schema.auditLog.action, 'dunning.escalated')))
      .get();
    expect(entry).toBeTruthy();
    // The audit log keeps a field-level diff rather than raw payloads, and the
    // "nobody was charged" fact has to survive into it.
    expect(JSON.stringify(entry!.changes)).toContain(NO_PROVIDER);
  });

  it('stops the moment the debt is settled, without waiting for the next step', () => {
    const invoiceId = makeInvoice(100_000);
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    runDueDunning(middayIST());
    expect(attemptsFor(invoiceId).some((row) => row.state === 'scheduled')).toBe(true);

    // The member pays at the desk.
    db.update(schema.invoices)
      .set({ paidMinor: 100_000, state: 'paid' })
      .where(eq(schema.invoices.id, invoiceId))
      .run();
    stopDunning(TENANT, invoiceId, 'recovered');

    const after = attemptsFor(invoiceId);
    expect(after.some((row) => row.state === 'scheduled' || row.state === 'deferred')).toBe(false);
    expect(after.some((row) => row.stopReason === 'recovered')).toBe(true);

    // And a later run does not message them.
    const result = runDueDunning(middayIST(30));
    expect(result.sent).toBe(0);
  });

  it('recovers a debt paid without anyone telling the worker', () => {
    const invoiceId = makeInvoice(100_000);
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });

    // Settled directly, so the only thing that can notice is the worker's own
    // check before it sends.
    db.update(schema.invoices)
      .set({ paidMinor: 100_000, state: 'paid' })
      .where(eq(schema.invoices.id, invoiceId))
      .run();

    const result = runDueDunning(middayIST());
    expect(result.recovered).toBeGreaterThan(0);
    expect(attemptsFor(invoiceId)[0]!.stopReason).toBe('recovered');
  });

  it('stops chasing an invoice that was voided underneath it', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    db.update(schema.invoices).set({ voided: true, state: 'void' }).where(eq(schema.invoices.id, invoiceId)).run();

    runDueDunning(middayIST());
    expect(attemptsFor(invoiceId)[0]!.stopReason).toBe('invoice_voided');
  });
});

describe('the worker is safe to run twice', () => {
  it('sends one message even when two runs race the same step', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });

    const before = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, memberUserId), eq(schema.notifications.kind, 'payment_due')))
      .all().length;

    const at = middayIST();
    runDueDunning(at);
    // A second worker arriving immediately finds nothing due: the step it
    // would have taken is already `sent`, and the next one is days away.
    const second = runDueDunning(at);
    expect(second.sent).toBe(0);

    const after = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, memberUserId), eq(schema.notifications.kind, 'payment_due')))
      .all().length;
    expect(after).toBe(before + 1);
  });

  it('does not strand a sequence whose worker died holding the lock', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    const step = attemptsFor(invoiceId)[0]!;

    // A worker claimed it and never came back.
    const at = middayIST();
    db.update(schema.dunningAttempts)
      .set({ lockedAt: at - 60_000 })
      .where(eq(schema.dunningAttempts.id, step.id))
      .run();

    // Still inside the lock timeout: left alone.
    expect(runDueDunning(at).sent).toBe(0);
    expect(attemptsFor(invoiceId)[0]!.state).toBe('scheduled');

    // Past it: reclaimed and advanced.
    expect(runDueDunning(at + 10 * 60_000).sent).toBe(1);
    expect(attemptsFor(invoiceId)[0]!.state).toBe('sent');
  });

  it('survives a restart, because the state is a column and not a computation', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    runDueDunning(middayIST());

    // Re-read every row from the database, as a fresh process would.
    const reread = attemptsFor(invoiceId);
    expect(reread[0]!.state).toBe('sent');
    expect(reread[0]!.sentAt).toBeTruthy();
    expect(reread[1]!.state).toBe('scheduled');
    expect(reread[1]!.scheduledFor).toBeGreaterThan(reread[0]!.sentAt!);
  });
});

describe('what the console is told', () => {
  it('states that automatic collection is unavailable, with the reason', async () => {
    const owner = await signIn(OWNER);
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    runDueDunning(middayIST());

    const response = await app.request(`/v1/admin/billing/invoices/${invoiceId}/dunning`, {
      headers: headers(owner),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      automaticCollection: { available: boolean; reason: string; message: string };
      attempts: Array<{ retrySubmitted: boolean; retryOutcome: string | null }>;
      nextAttemptAt: number | null;
    };

    expect(body.automaticCollection.available).toBe(false);
    expect(body.automaticCollection.reason).toBe(NO_PROVIDER);
    expect(body.automaticCollection.message).toMatch(/cannot be retried automatically/i);
    expect(body.attempts[0]!.retrySubmitted).toBe(false);
    expect(body.attempts[0]!.retryOutcome).toBe(NO_PROVIDER);
    expect(body.nextAttemptAt).toBeTruthy();
  });

  it('refuses an invoice at a branch the caller cannot see', async () => {
    const manager = await signIn('manager@sharkfitness.in');
    const indInvoice = db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.tenantId, TENANT), eq(schema.invoices.branchId, 'br_ind')))
      .get()!;

    const response = await app.request(`/v1/admin/billing/invoices/${indInvoice.id}/dunning`, {
      headers: headers(manager),
    });
    // Not found, not forbidden.
    expect(response.status).toBe(404);
  });

  it('never reports a retry as submitted anywhere in the payload', () => {
    const invoiceId = makeInvoice();
    openDunning({ tenantId: TENANT }, { invoiceId, reason: 'Card declined' });
    runDueDunning(middayIST());

    const ctx = {
      tenantId: TENANT,
      branchIds: ['br_kor'],
      activeBranchId: null,
      permissions: ['billing.view'],
      role: 'owner',
    } as unknown as Parameters<typeof dunningForInvoice>[0];
    const view = dunningForInvoice(ctx, invoiceId);
    expect(JSON.stringify(view)).not.toMatch(/"retrySubmitted":true/);
    expect(view.attempts.every((row) => row.retrySubmitted === false)).toBe(true);
  });
});
