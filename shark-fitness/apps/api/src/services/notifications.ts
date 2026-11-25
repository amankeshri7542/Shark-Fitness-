import { and, asc, eq, gt, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { formatMoney, insideQuietHours } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { branchPolicy } from '../lib/policy.js';
import { id } from '../lib/ids.js';
import { log } from '../lib/observability.js';
import { MINUTE, addDays, isoDate, localClockOnDay, localMinutes, now } from '../lib/time.js';
import { pushConfigured, sendPush, type PushMessage } from './push.js';

/**
 * Member notifications: the in-app inbox plus, where the member has turned it
 * on, a push to their phone (PF-COMM-002, PRD 03 §5.6).
 *
 * `notifyUser` is synchronous and safe inside `transact()`: it writes the
 * in-app row and, for a push category, a durable `push_deliveries` row. The
 * HTTP work happens later in `deliverDuePushes`, outside any transaction,
 * kicked right after the write and swept every minute by the scheduler.
 *
 * Push rules, checked at delivery time rather than when queued, because the
 * answer can change in between:
 * - Purpose consent: the member's `push_notifications` consent must be
 *   granted (it is granted when they switch push on, and they can withdraw it
 *   in Profile › Your data).
 * - Quiet hours, in the branch's own timezone (tenant/branch policy
 *   quietHoursFrom/To, default 21:00–08:00): the push waits until they end,
 *   or is dropped if by then it would be pointless (`expiresAt`).
 * - Dedupe: one push per (person, dedupe key), whatever retries or restarts.
 * - Devices whose push service answers 404/410 are deleted.
 * - Only devices registered by a still-live session receive anything.
 *
 * Further channels (email, SMS, WhatsApp) are P07's; this module is the seam.
 */

export type PushCategory = 'class_reminder' | 'booking' | 'message' | 'payment';

export const PUSH_CONSENT_PURPOSE = 'push_notifications';

/** Every category is a service message today. A marketing category would map
 *  to its own purpose here, and would need that consent instead. */
const CATEGORY_PURPOSE: Record<PushCategory, string> = {
  class_reminder: PUSH_CONSENT_PURPOSE,
  booking: PUSH_CONSENT_PURPOSE,
  message: PUSH_CONSENT_PURPOSE,
  payment: PUSH_CONSENT_PURPOSE,
};

const CATEGORY_DELIVERY: Record<PushCategory, { ttlSec: number; urgency: 'normal' | 'high' }> = {
  class_reminder: { ttlSec: 2 * 60 * 60, urgency: 'normal' },
  booking: { ttlSec: 6 * 60 * 60, urgency: 'high' },
  message: { ttlSec: 24 * 60 * 60, urgency: 'normal' },
  payment: { ttlSec: 24 * 60 * 60, urgency: 'normal' },
};

const MAX_ATTEMPTS = 3;
const BATCH = 100;
const STALE_LOCK_MS = 5 * MINUTE;

export interface NotifyInput {
  tenantId: string;
  userId: string;
  /** Whose quiet hours apply. Falls back to the member's home branch. */
  branchId?: string | null;
  kind: string;
  title: string;
  body: string;
  /** In-app route the notification opens. */
  link: string | null;
  templateCode?: string | null;
  /** Default true. Messages skip it: the message itself is the in-app record. */
  inApp?: boolean;
  push?: {
    category: PushCategory;
    /** The logical event: the same key is pushed once per person. */
    dedupeKey: string;
    /** After this instant the push is pointless and is dropped. */
    expiresAt?: number | null;
  };
}

/** Writes the notification. Returns the in-app notification id (or null). */
export function notifyUser(input: NotifyInput, atMs: number = now()): string | null {
  let notificationId: string | null = null;
  if (input.inApp !== false) {
    notificationId = id('ntf');
    db.insert(schema.notifications)
      .values({
        id: notificationId,
        tenantId: input.tenantId,
        userId: input.userId,
        channel: 'in_app',
        kind: input.kind,
        title: input.title,
        body: input.body,
        link: input.link,
        templateCode: input.templateCode ?? null,
        state: 'sent',
        attempts: 1,
        lastError: null,
        createdAt: atMs,
        readAt: null,
      })
      .run();
  }

  if (input.push && pushConfigured() && hasLiveDevice(input.tenantId, input.userId, atMs)) {
    const queued = db
      .insert(schema.pushDeliveries)
      .values({
        id: id('psh'),
        tenantId: input.tenantId,
        userId: input.userId,
        branchId: input.branchId ?? null,
        category: input.push.category,
        dedupeKey: input.push.dedupeKey,
        notificationId,
        title: input.title.slice(0, 120),
        body: input.body.slice(0, 240),
        path: input.link ?? '/notifications',
        state: 'queued',
        reason: '',
        dueAt: atMs,
        expiresAt: input.push.expiresAt ?? null,
        attempts: 0,
        lockedAt: null,
        devicesSent: 0,
        createdAt: atMs,
        updatedAt: atMs,
        sentAt: null,
      })
      .onConflictDoNothing()
      .run();
    if (queued.changes > 0) requestPushFlush();
  }
  return notificationId;
}

/* — Payment outcome: the seam the payment provider integration calls ——— */

/**
 * Tells the member how a payment went (P02's settlement and webhook paths
 * call this; staff-recorded payments can too). Plain register, always.
 * Deduplicated per invoice and outcome, so a replayed webhook pushes once.
 */
export function notifyPaymentOutcome(
  input: {
    tenantId: string;
    userId: string;
    branchId: string | null;
    invoiceId: string;
    invoiceNumber: string;
    amountMinor: number;
    currency: string;
    outcome: 'succeeded' | 'failed';
    /** Provider attempt id, so a second failed attempt is a second push. */
    attemptRef?: string;
  },
  atMs: number = now(),
): string | null {
  const amount = formatMoney(input.amountMinor, input.currency);
  const succeeded = input.outcome === 'succeeded';
  return notifyUser(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      branchId: input.branchId,
      kind: succeeded ? 'payment_succeeded' : 'payment_failed',
      title: succeeded ? 'Payment received' : 'Payment did not go through',
      body: succeeded
        ? `${amount} for invoice ${input.invoiceNumber} is paid. Your receipt is in Billing.`
        : `${amount} for invoice ${input.invoiceNumber} was not taken. Nothing was charged. You can try again in Billing.`,
      link: '/billing',
      templateCode: succeeded ? 'payment.succeeded' : 'payment.failed',
      push: {
        category: 'payment',
        dedupeKey: `payment:${input.invoiceId}:${input.outcome}:${input.attemptRef ?? 'final'}`,
      },
    },
    atMs,
  );
}

/* — A message from the gym ———————————————————————————————————— */

/**
 * A staff member wrote to a member (support reply, coach or front desk). The
 * message itself is the in-app record, so this only pushes. The lock screen
 * shows who wrote, never what they wrote: gym conversations touch injuries,
 * health and money.
 */
export function notifyNewMessage(
  input: { tenantId: string; memberId: string; branchId: string | null; conversationId: string; messageId: string; senderName: string },
  atMs: number = now(),
): void {
  const member = db
    .select({ userId: schema.members.userId })
    .from(schema.members)
    .where(and(eq(schema.members.id, input.memberId), eq(schema.members.tenantId, input.tenantId)))
    .get();
  if (!member?.userId) return;
  const firstName = input.senderName.trim().split(/\s+/)[0] || 'the gym';
  notifyUser(
    {
      tenantId: input.tenantId,
      userId: member.userId,
      branchId: input.branchId,
      kind: 'message',
      title: `New message from ${firstName}`,
      body: 'Tap to read it in Messages.',
      link: `/messages/${input.conversationId}`,
      inApp: false,
      push: { category: 'message', dedupeKey: `message:${input.messageId}` },
    },
    atMs,
  );
}

/* — Devices ———————————————————————————————————————————————— */

function liveDevices(tenantId: string, userId: string, atMs: number) {
  return db
    .select({
      id: schema.pushSubscriptions.id,
      endpoint: schema.pushSubscriptions.endpoint,
      p256dh: schema.pushSubscriptions.p256dh,
      auth: schema.pushSubscriptions.auth,
    })
    .from(schema.pushSubscriptions)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.pushSubscriptions.sessionId))
    .where(
      and(
        eq(schema.pushSubscriptions.tenantId, tenantId),
        eq(schema.pushSubscriptions.userId, userId),
        eq(schema.sessions.userId, userId),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, atMs),
      ),
    )
    .all();
}

function hasLiveDevice(tenantId: string, userId: string, atMs: number): boolean {
  return liveDevices(tenantId, userId, atMs).length > 0;
}

/* — Delivery ——————————————————————————————————————————————— */

let flushTimer: ReturnType<typeof setImmediate> | null = null;

/** Send what was just queued without waiting for the next minute's sweep.
 *  Runs after the current (synchronous) transaction has committed. Tests call
 *  `deliverDuePushes` themselves, with a fake push service. */
function requestPushFlush(): void {
  if (runtimeConfig.nodeEnv === 'test' || flushTimer) return;
  flushTimer = setImmediate(() => {
    flushTimer = null;
    void deliverDuePushes().catch((error: unknown) =>
      log('error', 'push_delivery_failed', { message: error instanceof Error ? error.message : String(error) }),
    );
  });
}

export interface PushRunResult {
  sent: number;
  deferred: number;
  suppressed: number;
  failed: number;
  retried: number;
  devicesRemoved: number;
}

let running: Promise<PushRunResult> | null = null;

/** Sends every due push. Overlapping calls share one run. */
export function deliverDuePushes(atMs: number = now()): Promise<PushRunResult> {
  running ??= runDeliveries(atMs).finally(() => {
    running = null;
  });
  return running;
}

async function runDeliveries(atMs: number): Promise<PushRunResult> {
  const result: PushRunResult = { sent: 0, deferred: 0, suppressed: 0, failed: 0, retried: 0, devicesRemoved: 0 };
  if (!pushConfigured()) return result;

  // A crash mid-send leaves rows 'sending'. Put them back after a while; the
  // push service collapses a repeat by tag, so a rare double is harmless.
  db.update(schema.pushDeliveries)
    .set({ state: 'queued', lockedAt: null, updatedAt: atMs })
    .where(and(eq(schema.pushDeliveries.state, 'sending'), lt(schema.pushDeliveries.lockedAt, atMs - STALE_LOCK_MS)))
    .run();

  const due = db
    .select({ id: schema.pushDeliveries.id })
    .from(schema.pushDeliveries)
    .where(and(eq(schema.pushDeliveries.state, 'queued'), lte(schema.pushDeliveries.dueAt, atMs)))
    .orderBy(asc(schema.pushDeliveries.dueAt))
    .limit(BATCH)
    .all();

  for (const { id: deliveryId } of due) {
    const claimed = db
      .update(schema.pushDeliveries)
      .set({ state: 'sending', lockedAt: atMs, updatedAt: atMs })
      .where(and(eq(schema.pushDeliveries.id, deliveryId), eq(schema.pushDeliveries.state, 'queued')))
      .run();
    if (claimed.changes === 0) continue;
    const delivery = db.select().from(schema.pushDeliveries).where(eq(schema.pushDeliveries.id, deliveryId)).get();
    if (!delivery) continue;
    await deliverOne(delivery, atMs, result);
  }
  return result;
}

type Delivery = typeof schema.pushDeliveries.$inferSelect;

function finish(delivery: Delivery, atMs: number, patch: Partial<Delivery>): void {
  db.update(schema.pushDeliveries)
    .set({ lockedAt: null, updatedAt: atMs, ...patch })
    .where(eq(schema.pushDeliveries.id, delivery.id))
    .run();
}

async function deliverOne(delivery: Delivery, atMs: number, result: PushRunResult): Promise<void> {
  const category = delivery.category as PushCategory;

  if (delivery.expiresAt !== null && atMs >= delivery.expiresAt) {
    finish(delivery, atMs, { state: 'suppressed', reason: 'expired' });
    result.suppressed += 1;
    return;
  }

  if (!consentGranted(delivery.tenantId, delivery.userId, CATEGORY_PURPOSE[category] ?? PUSH_CONSENT_PURPOSE)) {
    finish(delivery, atMs, { state: 'suppressed', reason: 'no_consent' });
    result.suppressed += 1;
    return;
  }

  const quiet = quietHoursFor(delivery.tenantId, delivery.branchId ?? homeBranchOf(delivery.tenantId, delivery.userId), atMs);
  if (quiet) {
    if (delivery.expiresAt !== null && quiet.endsAt >= delivery.expiresAt) {
      finish(delivery, atMs, { state: 'suppressed', reason: 'quiet_hours_until_expiry' });
      result.suppressed += 1;
    } else {
      finish(delivery, atMs, { state: 'queued', reason: 'quiet_hours', dueAt: quiet.endsAt });
      result.deferred += 1;
    }
    return;
  }

  const devices = liveDevices(delivery.tenantId, delivery.userId, atMs);
  if (devices.length === 0) {
    finish(delivery, atMs, { state: 'suppressed', reason: 'no_device' });
    result.suppressed += 1;
    return;
  }

  const message: PushMessage = { title: delivery.title, body: delivery.body, path: delivery.path, tag: delivery.dedupeKey.slice(0, 64) };
  const outcomes = await Promise.all(
    devices.map(async (device) => ({ device, outcome: await sendPush(device, message, CATEGORY_DELIVERY[category]) })),
  );

  const gone = outcomes.filter((o) => o.outcome === 'gone').map((o) => o.device.id);
  if (gone.length > 0) {
    db.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.id, gone)).run();
    result.devicesRemoved += gone.length;
  }
  const sentTo = outcomes.filter((o) => o.outcome === 'sent').map((o) => o.device.id);
  if (sentTo.length > 0) {
    db.update(schema.pushSubscriptions)
      .set({ lastSuccessAt: atMs, failureCount: 0 })
      .where(inArray(schema.pushSubscriptions.id, sentTo))
      .run();
  }
  const failedOn = outcomes.filter((o) => o.outcome === 'retry' || o.outcome === 'rejected').map((o) => o.device.id);
  if (failedOn.length > 0) {
    db.update(schema.pushSubscriptions)
      .set({ lastFailureAt: atMs, failureCount: sql`${schema.pushSubscriptions.failureCount} + 1` })
      .where(inArray(schema.pushSubscriptions.id, failedOn))
      .run();
  }

  const attempts = delivery.attempts + 1;
  if (sentTo.length > 0) {
    finish(delivery, atMs, { state: 'sent', reason: '', attempts, devicesSent: sentTo.length, sentAt: atMs });
    result.sent += 1;
  } else if (outcomes.some((o) => o.outcome === 'retry') && attempts < MAX_ATTEMPTS) {
    finish(delivery, atMs, { state: 'queued', reason: 'push_service_unavailable', attempts, dueAt: atMs + attempts * 5 * MINUTE });
    result.retried += 1;
  } else {
    finish(delivery, atMs, { state: 'failed', reason: gone.length === outcomes.length ? 'devices_gone' : 'push_service_refused', attempts });
    result.failed += 1;
  }
}

function consentGranted(tenantId: string, userId: string, purpose: string): boolean {
  const row = db
    .select({ granted: schema.consents.granted })
    .from(schema.consents)
    .where(and(eq(schema.consents.tenantId, tenantId), eq(schema.consents.userId, userId), eq(schema.consents.purpose, purpose)))
    .get();
  return row?.granted === true;
}

function homeBranchOf(tenantId: string, userId: string): string | null {
  return (
    db
      .select({ branchId: schema.members.homeBranchId })
      .from(schema.members)
      .where(and(eq(schema.members.tenantId, tenantId), eq(schema.members.userId, userId)))
      .get()?.branchId ?? null
  );
}

/** Inside quiet hours: when they end. Outside: null. Same policy keys and
 *  defaults as dunning, read in the branch's own timezone. */
export function quietHoursFor(tenantId: string, branchId: string | null, atMs: number): { endsAt: number } | null {
  const tz = branchTimeZone(tenantId, branchId);
  const from = String(branchPolicy(tenantId, branchId, 'quietHoursFrom', '21:00').value);
  const to = String(branchPolicy(tenantId, branchId, 'quietHoursTo', '08:00').value);
  const [fromH = 21, fromM = 0] = from.split(':').map(Number);
  const [toH = 8, toM = 0] = to.split(':').map(Number);
  const fromMin = fromH * 60 + fromM;
  const toMin = toH * 60 + toM;
  const current = localMinutes(atMs, tz);
  if (!insideQuietHours(current, fromMin, toMin)) return null;
  const today = isoDate(atMs, tz);
  const endDay = current >= toMin ? addDays(today, 1) : today;
  const clock = `${String(Math.floor(toMin / 60)).padStart(2, '0')}:${String(toMin % 60).padStart(2, '0')}`;
  const endsAt = localClockOnDay(endDay, clock, tz);
  return { endsAt: endsAt > atMs ? endsAt : atMs + 60 * MINUTE };
}
