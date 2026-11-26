import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  channelLabel,
  consentAllows,
  insideWindow,
  maskDestination,
  notificationRetryDelayMs,
  quietHoursApply,
  renderTemplate,
  templateVariables,
  type NotificationChannel,
  type NotificationPurpose,
} from '@shark/domain';
import { db, schema } from '../../db/client.js';
import { id } from '../../lib/ids.js';
import { policyValue } from '../../lib/policy.js';
import { MINUTE, localMinutes, now } from '../../lib/time.js';
import { toE164 } from '../otp-delivery.js';
import { notificationDrivers, type DriverChannel } from './drivers.js';

/**
 * NotificationService — the one way the product reaches a member outside the
 * screen they are looking at (PF-COMM-002, PF-COMM-005).
 *
 * `queueNotification` records the intent and runs every check that can be run
 * now. An in-app message due now is written to the member's inbox on the spot
 * (it is a database row, not a network call). Every other channel waits for
 * `processNotificationQueue`, the scheduler job, which **checks consent and
 * quiet hours again** before handing the message to a driver — a member who
 * opts out between queueing and sending is not messaged (PF-COMM edge case).
 *
 * Every attempt leaves a `notification_deliveries` row with its outcome in
 * words: logged (no provider: recorded, not delivered), sent (with the
 * provider's id), deferred (quiet hours), suppressed (consent, destination,
 * channel unavailable) or failed (provider refused, retries exhausted, or a
 * template variable missing).
 */

export type DeliveryState = 'queued' | 'processing' | 'deferred' | 'logged' | 'sent' | 'suppressed' | 'failed';

export interface NotifyInput {
  tenantId: string;
  userId: string;
  memberId?: string | null;
  branchId?: string | null;
  channel: NotificationChannel;
  purpose: NotificationPurpose;
  /** automation | dunning | broadcast | message | community | coaching | task | system */
  source: string;
  sourceId?: string | null;
  /** The same key on the same channel is the same message: queued once. */
  dedupeKey?: string | null;
  /** In-app notification kind (icon/category in the member app). */
  kind?: string;
  /** The gym template this message came from, kept for the record. */
  templateCode?: string | null;
  title: string;
  /** Text, optionally with {{variables}} filled from `variables` at send time. */
  body: string;
  variables?: Record<string, string | number | null>;
  providerTemplate?: string | null;
  link?: string | null;
  /** Earliest send time; defaults to now. */
  dueAt?: number;
}

export interface QueueResult {
  deliveryId: string;
  state: DeliveryState;
  reason: string;
  duplicate: boolean;
  notificationId: string | null;
}

type DeliveryRow = typeof schema.notificationDeliveries.$inferSelect;

/* ——— Facts the checks read ————————————————————————————————— */

function consentsOf(tenantId: string, userId: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const row of db
    .select({ purpose: schema.consents.purpose, granted: schema.consents.granted })
    .from(schema.consents)
    .where(and(eq(schema.consents.tenantId, tenantId), eq(schema.consents.userId, userId)))
    .all()) {
    out[row.purpose] = row.granted;
  }
  return out;
}

interface Recipient {
  active: boolean;
  email: string | null;
  phone: string | null;
  branchId: string | null;
}

function recipientOf(tenantId: string, userId: string, memberId: string | null): Recipient {
  const user = db
    .select({ email: schema.users.email, phone: schema.users.phone, state: schema.users.accountState, deletedAt: schema.users.deletedAt })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), eq(schema.users.tenantId, tenantId)))
    .get();
  const member = db
    .select({ email: schema.members.email, phone: schema.members.phone, branchId: schema.members.homeBranchId })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.tenantId, tenantId),
        memberId ? eq(schema.members.id, memberId) : eq(schema.members.userId, userId),
        isNull(schema.members.deletedAt),
      ),
    )
    .get();
  return {
    // An invited member (no password yet) still gets their gym's messages on
    // email/SMS; a disabled, anonymised or deleted account gets nothing.
    active: Boolean(user && !user.deletedAt && (user.state === 'active' || user.state === 'invited')),
    email: user?.email ?? member?.email ?? null,
    phone: user?.phone ?? member?.phone ?? null,
    branchId: member?.branchId ?? null,
  };
}

function destinationFor(channel: NotificationChannel, recipient: Recipient, userId: string): string | null {
  if (channel === 'email') return recipient.email;
  if (channel === 'sms' || channel === 'whatsapp') return recipient.phone ? toE164(recipient.phone) : null;
  return userId;
}

function quietWindow(tenantId: string, branchId: string | null): { fromMin: number; toMin: number; timeZone: string } | null {
  if (!branchId) return null;
  const branch = db
    .select({ timezone: schema.branches.timezone })
    .from(schema.branches)
    .where(and(eq(schema.branches.id, branchId), eq(schema.branches.tenantId, tenantId)))
    .get();
  if (!branch) return null;
  const toMinutes = (clock: string) => {
    const [h = 0, m = 0] = clock.split(':').map(Number);
    return h * 60 + m;
  };
  return {
    fromMin: toMinutes(String(policyValue(tenantId, branchId, 'quietHoursFrom', '21:00'))),
    toMin: toMinutes(String(policyValue(tenantId, branchId, 'quietHoursTo', '08:00'))),
    timeZone: branch.timezone,
  };
}

/** The first whole minute after `atMs` outside the branch's quiet window. */
function quietEndsAt(atMs: number, window: { fromMin: number; toMin: number; timeZone: string }): number {
  const current = localMinutes(atMs, window.timeZone);
  const until = (window.toMin - current + 1440) % 1440 || 1440;
  let candidate = atMs - (atMs % MINUTE) + until * MINUTE;
  // A clock change inside the window: walk forward until really outside.
  for (let i = 0; i < 180 && insideWindow(window.fromMin, window.toMin, localMinutes(candidate, window.timeZone)); i++) {
    candidate += MINUTE;
  }
  return candidate;
}

/** Why a message would not go (or not yet), as a stable code for counting. */
export type ExclusionCode =
  | 'inactive'
  | 'no_consent'
  | 'opted_out'
  | 'channel_unavailable'
  | 'no_destination'
  | 'missing_variable'
  | 'quiet_hours';

type Check =
  | { kind: 'ok'; text: string; params: string[]; destination: string }
  | { kind: 'suppress'; code: ExclusionCode; reason: string }
  | { kind: 'fail'; code: ExclusionCode; reason: string }
  | { kind: 'defer'; code: 'quiet_hours'; dueAt: number; reason: string };

type CheckInput = Pick<DeliveryRow, 'tenantId' | 'userId' | 'memberId' | 'branchId' | 'channel' | 'purpose' | 'bodyTemplate' | 'variables'>;

/**
 * Everything that decides whether this message may go now. Run at enqueue and
 * again immediately before the driver is called.
 */
function check(row: CheckInput, atMs: number, stage: 'enqueue' | 'send'): Check {
  const channel = row.channel as NotificationChannel;
  const purpose = row.purpose as NotificationPurpose;
  const recipient = recipientOf(row.tenantId, row.userId, row.memberId);
  if (!recipient.active) return { kind: 'suppress', code: 'inactive', reason: 'The member account is not active.' };

  const consent = consentAllows(purpose, channel, consentsOf(row.tenantId, row.userId));
  if (!consent.allowed) {
    return {
      kind: 'suppress',
      code: consent.code === 'opted_out' ? 'opted_out' : 'no_consent',
      reason: stage === 'send' ? `${consent.reason} (changed after this was queued; not sent).` : consent.reason,
    };
  }

  if (channel !== 'in_app' && !notificationDrivers()[channel as DriverChannel].available) {
    return { kind: 'suppress', code: 'channel_unavailable', reason: `${channelLabel(channel)} is not set up on this server.` };
  }

  const destination = destinationFor(channel, recipient, row.userId);
  if (!destination) {
    return { kind: 'suppress', code: 'no_destination', reason: `No ${channel === 'email' ? 'email address' : 'mobile number'} on file.` };
  }

  // A variable that is missing now would reach the member as "{{firstName}}".
  const rendered = renderTemplate(row.bodyTemplate, row.variables);
  if (rendered.missing.length > 0) {
    return { kind: 'fail', code: 'missing_variable', reason: `Not sent: the message needs ${rendered.missing.map((v) => `{{${v}}}`).join(', ')} and it has no value.` };
  }

  if (quietHoursApply(purpose, channel)) {
    const window = quietWindow(row.tenantId, row.branchId ?? recipient.branchId);
    if (window && insideWindow(window.fromMin, window.toMin, localMinutes(atMs, window.timeZone))) {
      return { kind: 'defer', code: 'quiet_hours', dueAt: quietEndsAt(atMs, window), reason: 'Held for quiet hours at the branch.' };
    }
  }

  const params = templateVariables(row.bodyTemplate).map((name) => String(row.variables[name] ?? ''));
  return { kind: 'ok', text: rendered.text, params, destination };
}

function update(deliveryId: string, patch: Partial<DeliveryRow>, atMs: number): void {
  db.update(schema.notificationDeliveries)
    .set({ ...patch, lockedAt: null, updatedAt: atMs })
    .where(eq(schema.notificationDeliveries.id, deliveryId))
    .run();
}

/** Writes the in-app row. In-app is delivered when it is in the inbox. */
function deliverInApp(row: DeliveryRow, text: string, atMs: number): string {
  const notificationId = id('ntf');
  db.insert(schema.notifications)
    .values({
      id: notificationId,
      tenantId: row.tenantId,
      userId: row.userId,
      channel: 'in_app',
      kind: row.kind,
      title: row.title,
      body: text,
      link: row.link,
      templateCode: row.templateCode,
      state: 'sent',
      attempts: Math.max(1, row.attempts),
      lastError: null,
      createdAt: atMs,
      readAt: null,
    })
    .run();
  update(
    row.id,
    { state: 'sent', reason: '', provider: 'in_app', deliveredAt: atMs, notificationId, destinationHint: 'in the app' },
    atMs,
  );
  return notificationId;
}

/**
 * What would happen to a message for this person right now, without writing
 * anything — the broadcast preview and dry run use exactly the checks the
 * send path uses, so the preview cannot promise what the send will refuse.
 */
export function evaluateRecipient(
  input: Pick<NotifyInput, 'tenantId' | 'userId' | 'memberId' | 'branchId' | 'channel' | 'purpose' | 'body' | 'variables'>,
  atMs = now(),
): { outcome: 'send' | 'defer' | 'exclude'; code: ExclusionCode | null; reason: string } {
  const verdict = check(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      memberId: input.memberId ?? null,
      branchId: input.branchId ?? null,
      channel: input.channel,
      purpose: input.purpose,
      bodyTemplate: input.body,
      variables: input.variables ?? {},
    },
    atMs,
    'enqueue',
  );
  if (verdict.kind === 'ok') return { outcome: 'send', code: null, reason: '' };
  if (verdict.kind === 'defer') return { outcome: 'defer', code: verdict.code, reason: verdict.reason };
  return { outcome: 'exclude', code: verdict.code, reason: verdict.reason };
}

/* ——— Enqueue ——————————————————————————————————————————————— */

/**
 * Record a message for one person on one channel. Synchronous and safe inside
 * the caller's transaction. Returns the row's state after the checks that can
 * run now; in-app messages due now are already in the inbox.
 */
export function queueNotification(input: NotifyInput, atMs = now()): QueueResult {
  if (input.dedupeKey) {
    const existing = db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.tenantId, input.tenantId),
          eq(schema.notificationDeliveries.channel, input.channel),
          eq(schema.notificationDeliveries.dedupeKey, input.dedupeKey),
        ),
      )
      .get();
    if (existing) {
      return {
        deliveryId: existing.id,
        state: existing.state as DeliveryState,
        reason: 'Already queued for this event.',
        duplicate: true,
        notificationId: existing.notificationId,
      };
    }
  }

  const deliveryId = id('ndl');
  const dueAt = input.dueAt ?? atMs;
  db.insert(schema.notificationDeliveries)
    .values({
      id: deliveryId,
      tenantId: input.tenantId,
      branchId: input.branchId ?? null,
      userId: input.userId,
      memberId: input.memberId ?? null,
      channel: input.channel,
      purpose: input.purpose,
      source: input.source,
      sourceId: input.sourceId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      kind: input.kind ?? 'system',
      templateCode: input.templateCode ?? null,
      title: input.title,
      bodyTemplate: input.body,
      variables: input.variables ?? {},
      providerTemplate: input.providerTemplate ?? null,
      link: input.link ?? null,
      state: 'queued',
      reason: '',
      provider: null,
      providerMessageId: null,
      destinationHint: null,
      attempts: 0,
      dueAt,
      lockedAt: null,
      lastAttemptAt: null,
      deliveredAt: null,
      notificationId: null,
      createdAt: atMs,
      updatedAt: atMs,
    })
    .run();

  const row = db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, deliveryId)).get()!;
  const verdict = check(row, Math.max(atMs, dueAt), 'enqueue');
  if (verdict.kind === 'suppress' || verdict.kind === 'fail') {
    const state = verdict.kind === 'suppress' ? 'suppressed' : 'failed';
    update(deliveryId, { state, reason: verdict.reason }, atMs);
    return { deliveryId, state, reason: verdict.reason, duplicate: false, notificationId: null };
  }
  if (verdict.kind === 'defer') {
    update(deliveryId, { state: 'deferred', reason: verdict.reason, dueAt: verdict.dueAt }, atMs);
    return { deliveryId, state: 'deferred', reason: verdict.reason, duplicate: false, notificationId: null };
  }
  if (input.channel === 'in_app' && dueAt <= atMs) {
    const notificationId = deliverInApp({ ...row, attempts: 1 }, verdict.text, atMs);
    db.update(schema.notificationDeliveries)
      .set({ attempts: 1, lastAttemptAt: atMs })
      .where(eq(schema.notificationDeliveries.id, deliveryId))
      .run();
    return { deliveryId, state: 'sent', reason: '', duplicate: false, notificationId };
  }
  return { deliveryId, state: 'queued', reason: '', duplicate: false, notificationId: null };
}

/* ——— Send ———————————————————————————————————————————————— */

const STALE_LOCK_MS = 5 * MINUTE;

async function processOne(deliveryId: string, atMs: number): Promise<DeliveryState> {
  const claimed = db
    .update(schema.notificationDeliveries)
    .set({
      state: 'processing',
      attempts: sql`${schema.notificationDeliveries.attempts} + 1`,
      lockedAt: atMs,
      lastAttemptAt: atMs,
      updatedAt: atMs,
    })
    .where(
      and(
        eq(schema.notificationDeliveries.id, deliveryId),
        inArray(schema.notificationDeliveries.state, ['queued', 'deferred']),
        lte(schema.notificationDeliveries.dueAt, atMs),
      ),
    )
    .run();
  if (claimed.changes === 0) return 'queued';

  const row = db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, deliveryId)).get()!;
  const verdict = check(row, atMs, 'send');
  if (verdict.kind === 'suppress') {
    update(deliveryId, { state: 'suppressed', reason: verdict.reason }, atMs);
    return 'suppressed';
  }
  if (verdict.kind === 'fail') {
    update(deliveryId, { state: 'failed', reason: verdict.reason }, atMs);
    return 'failed';
  }
  if (verdict.kind === 'defer') {
    // A deferral is not an attempt.
    update(deliveryId, { state: 'deferred', reason: verdict.reason, dueAt: verdict.dueAt, attempts: Math.max(0, row.attempts - 1) }, atMs);
    return 'deferred';
  }

  const channel = row.channel as NotificationChannel;
  if (channel === 'in_app') {
    deliverInApp(row, verdict.text, atMs);
    return 'sent';
  }

  const driver = notificationDrivers()[channel as DriverChannel];
  const hint = maskDestination(channel, verdict.destination);
  const result = await driver.send({
    channel: channel as DriverChannel,
    to: verdict.destination,
    title: row.title,
    body: verdict.text,
    link: row.link,
    providerTemplate: row.providerTemplate,
    templateParams: verdict.params,
    tenantId: row.tenantId,
    userId: row.userId,
    deliveryId: row.id,
    kind: row.kind,
  });
  const doneAt = now() > atMs ? now() : atMs;

  if (result.outcome === 'logged') {
    update(
      deliveryId,
      {
        state: 'logged',
        reason: `Logged, not delivered: no ${channelLabel(channel)} provider is configured.`,
        provider: driver.name,
        destinationHint: hint,
      },
      doneAt,
    );
    return 'logged';
  }
  if (result.outcome === 'sent') {
    update(
      deliveryId,
      { state: 'sent', reason: '', provider: driver.name, providerMessageId: result.providerMessageId, destinationHint: hint, deliveredAt: doneAt },
      doneAt,
    );
    return 'sent';
  }
  if (result.outcome === 'retry' && row.attempts < MAX_NOTIFICATION_ATTEMPTS) {
    update(
      deliveryId,
      {
        state: 'queued',
        reason: `${result.error} Retry ${row.attempts + 1} of ${MAX_NOTIFICATION_ATTEMPTS} is queued.`,
        provider: driver.name,
        destinationHint: hint,
        dueAt: atMs + notificationRetryDelayMs(row.attempts),
      },
      doneAt,
    );
    return 'queued';
  }
  update(
    deliveryId,
    {
      state: 'failed',
      reason: result.outcome === 'retry' ? `${result.error} Stopped after ${row.attempts} attempts.` : result.error,
      provider: driver.name,
      destinationHint: hint,
    },
    doneAt,
  );
  return 'failed';
}

export interface QueueRunSummary {
  processed: number;
  sent: number;
  logged: number;
  deferred: number;
  suppressed: number;
  failed: number;
  retrying: number;
}

/** The scheduler job: sends what is due. Safe to call concurrently with itself
 *  (claims are atomic) and after a restart (stale claims are released). */
export async function processNotificationQueue(atMs = now(), limit = 100): Promise<QueueRunSummary> {
  db.update(schema.notificationDeliveries)
    .set({ state: 'queued', lockedAt: null, updatedAt: atMs })
    .where(and(eq(schema.notificationDeliveries.state, 'processing'), lte(schema.notificationDeliveries.lockedAt, atMs - STALE_LOCK_MS)))
    .run();

  const due = db
    .select({ id: schema.notificationDeliveries.id })
    .from(schema.notificationDeliveries)
    .where(
      and(
        or(eq(schema.notificationDeliveries.state, 'queued'), eq(schema.notificationDeliveries.state, 'deferred')),
        lte(schema.notificationDeliveries.dueAt, atMs),
      ),
    )
    .orderBy(schema.notificationDeliveries.dueAt)
    .limit(limit)
    .all();

  const summary: QueueRunSummary = { processed: 0, sent: 0, logged: 0, deferred: 0, suppressed: 0, failed: 0, retrying: 0 };
  for (const { id: deliveryId } of due) {
    const state = await processOne(deliveryId, atMs);
    summary.processed += 1;
    if (state === 'sent') summary.sent += 1;
    else if (state === 'logged') summary.logged += 1;
    else if (state === 'deferred') summary.deferred += 1;
    else if (state === 'suppressed') summary.suppressed += 1;
    else if (state === 'failed') summary.failed += 1;
    else if (state === 'queued') summary.retrying += 1;
  }
  return summary;
}

/* ——— Reading ————————————————————————————————————————————— */

/** What each channel can do on this server, for the Automations and
 *  Marketing screens ("SMS: logged only — no provider configured"). */
export function channelAvailability(): Array<{
  channel: NotificationChannel;
  available: boolean;
  delivers: boolean;
  driver: string;
  label: string;
  note: string;
}> {
  const drivers = notificationDrivers();
  const out: ReturnType<typeof channelAvailability> = [
    { channel: 'in_app', available: true, delivers: true, driver: 'in_app', label: 'In-app', note: 'Delivered to the member’s inbox in the app.' },
  ];
  for (const channel of ['push', 'email', 'sms', 'whatsapp'] as const) {
    const driver = drivers[channel];
    out.push({
      channel,
      available: driver.available,
      delivers: driver.delivers,
      driver: driver.name,
      label: channelLabel(channel),
      note: !driver.available
        ? `${channelLabel(channel)} is not set up on this server. Messages on it are recorded as not sent.`
        : driver.delivers
          ? `Sent through ${driver.name}.`
          : `No ${channelLabel(channel)} provider is configured: messages are recorded as logged, not delivered.`,
    });
  }
  return out;
}

/** Outcome counts for one source (a broadcast, an automation). */
export function deliveryOutcomes(tenantId: string, source: string, sourceId: string): Record<DeliveryState, number> & { total: number } {
  const counts: Record<DeliveryState, number> & { total: number } = {
    queued: 0,
    processing: 0,
    deferred: 0,
    logged: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
    total: 0,
  };
  for (const row of db
    .select({ state: schema.notificationDeliveries.state, n: sql<number>`count(*)` })
    .from(schema.notificationDeliveries)
    .where(
      and(
        eq(schema.notificationDeliveries.tenantId, tenantId),
        eq(schema.notificationDeliveries.source, source),
        eq(schema.notificationDeliveries.sourceId, sourceId),
      ),
    )
    .groupBy(schema.notificationDeliveries.state)
    .all()) {
    counts[row.state as DeliveryState] = row.n;
    counts.total += row.n;
  }
  return counts;
}
