import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { createHmac, randomBytes } from 'node:crypto';
import {
  WEBHOOK_ENVELOPE_VERSION,
  WEBHOOK_TEST_EVENT,
  channels,
  type WebhookAttempt,
  type WebhookDelivery,
  type WebhookDeliveredType,
  type WebhookEndpoint,
  type WebhookEndpointInput,
  type WebhookEndpointPatch,
  type WebhookEnvelope,
  type WebhookEventType,
} from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { runtimeConfig } from '../lib/config.js';
import type { RequestContext } from '../lib/context.js';
import { invalid, notFound, precondition } from '../lib/errors.js';
import { emit, latestSeq } from '../lib/events.js';
import { decryptField, encryptField } from '../lib/field-encryption.js';
import { id } from '../lib/ids.js';
import { log } from '../lib/observability.js';
import { safePost, systemResolver, urlRefusal, type Resolver, type SafeHttpPolicy } from '../lib/safe-http.js';
import { DAY, HOUR, MINUTE, now } from '../lib/time.js';
import { integrationChannel } from './integration-events.js';

/* ============================================================================
   Outbound webhooks (PF-INT-003). docs/SECURITY.md "Webhooks" is the
   consumer-facing description; this is the machinery.

   Fan-out: each endpoint keeps a cursor into the outbox. A tick reads the
   integration events after it, writes one delivery per subscribed event with
   the exact body that will be signed, and moves the cursor.

   Delivery: attempt now, then 1 min, 5 min, 30 min, 2 h, 6 h and 12 h later;
   a delivery still failing 24 hours after it was created is given up. Fifteen
   failed attempts in a row disable the endpoint and tell the owners, because
   a receiver that has been down for a day needs a person, not more retries.

   Signing: `Shark-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
   "<t>.<body>">`. For 24 hours after a rotation a second `v1=` carries the
   old secret's signature, so a receiver can switch secrets without a gap.
   ========================================================================= */

export const RETRY_DELAYS_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 12 * HOUR] as const;
export const GIVE_UP_AFTER_MS = 24 * HOUR;
export const DISABLE_AFTER_CONSECUTIVE_FAILURES = 15;
export const ROTATION_OVERLAP_MS = DAY;
const LEASE_MS = 2 * MINUTE;
const FAN_OUT_BATCH = 500;
const DELIVERY_BATCH = 50;
const CONCURRENCY = 5;

type EndpointRow = typeof schema.webhookEndpoints.$inferSelect;
type DeliveryRow = typeof schema.webhookDeliveries.$inferSelect;

/* — Test seams (never used by the product) ———————————————————————— */

let resolver: Resolver = systemResolver;
let policyOverride: SafeHttpPolicy | null = null;

/** Lets the suite map host names without real DNS, and act as production. */
export function setWebhookNetworkForTest(options: { resolver?: Resolver | null; policy?: SafeHttpPolicy | null }): void {
  if (options.resolver !== undefined) resolver = options.resolver ?? systemResolver;
  if (options.policy !== undefined) policyOverride = options.policy;
}

function policy(): SafeHttpPolicy {
  return policyOverride ?? { production: runtimeConfig.isProduction };
}

/* — Secrets and signatures ——————————————————————————————————————— */

function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function secretsFor(endpoint: EndpointRow, at: number): string[] {
  const current = decryptField('webhook-secret', endpoint.id, endpoint.secretCiphertext);
  const previous =
    endpoint.previousSecretCiphertext && endpoint.previousSecretExpiresAt && endpoint.previousSecretExpiresAt > at
      ? decryptField('webhook-secret', endpoint.id, endpoint.previousSecretCiphertext)
      : null;
  return previous ? [current, previous] : [current];
}

export function signatureHeader(secrets: string[], timestamp: number, body: string): string {
  return [`t=${timestamp}`, ...secrets.map((secret) => `v1=${sign(secret, timestamp, body)}`)].join(',');
}

/* — Reads ———————————————————————————————————————————————————————— */

function iso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  const last = db
    .select()
    .from(schema.webhookAttempts)
    .where(eq(schema.webhookAttempts.endpointId, row.id))
    .orderBy(desc(schema.webhookAttempts.at))
    .limit(1)
    .get();
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events as WebhookEventType[],
    state: row.state as WebhookEndpoint['state'],
    disabledReason: row.disabledReason,
    disabledAt: iso(row.disabledAt),
    consecutiveFailures: row.consecutiveFailures,
    secretHint: row.secretHint,
    previousSecretExpiresAt: row.previousSecretExpiresAt && row.previousSecretExpiresAt > now() ? iso(row.previousSecretExpiresAt) : null,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    lastDelivery: last ? { at: iso(last.at)!, ok: last.ok, statusCode: last.statusCode } : null,
  };
}

export function loadEndpointInScope(ctx: RequestContext, endpointId: string): EndpointRow {
  const row = db
    .select()
    .from(schema.webhookEndpoints)
    .where(and(eq(schema.webhookEndpoints.id, endpointId), eq(schema.webhookEndpoints.tenantId, ctx.tenantId), isNull(schema.webhookEndpoints.deletedAt)))
    .get();
  if (!row) throw notFound('That endpoint');
  return row;
}

export function listEndpoints(ctx: RequestContext): WebhookEndpoint[] {
  return db
    .select()
    .from(schema.webhookEndpoints)
    .where(and(eq(schema.webhookEndpoints.tenantId, ctx.tenantId), isNull(schema.webhookEndpoints.deletedAt)))
    .orderBy(asc(schema.webhookEndpoints.createdAt))
    .all()
    .map(toEndpoint);
}

function toDelivery(row: DeliveryRow, attempts: Array<typeof schema.webhookAttempts.$inferSelect>): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType as WebhookDeliveredType,
    state: row.state as WebhookDelivery['state'],
    attempts: row.attempts,
    nextAttemptAt: row.state === 'pending' ? iso(row.nextAttemptAt) : null,
    createdAt: iso(row.createdAt)!,
    completedAt: iso(row.completedAt),
    replayOf: row.replayOf,
    test: row.test,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    log: attempts.map(
      (attempt): WebhookAttempt => ({
        attempt: attempt.attempt,
        at: iso(attempt.at)!,
        statusCode: attempt.statusCode,
        ok: attempt.ok,
        latencyMs: attempt.latencyMs,
        error: attempt.error,
        responseExcerpt: attempt.responseExcerpt,
      }),
    ),
  };
}

function deliveryById(deliveryId: string): WebhookDelivery {
  const row = db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, deliveryId)).get()!;
  const attempts = db.select().from(schema.webhookAttempts).where(eq(schema.webhookAttempts.deliveryId, deliveryId)).orderBy(asc(schema.webhookAttempts.attempt)).all();
  return toDelivery(row, attempts);
}

export function listDeliveries(ctx: RequestContext, endpointId: string, limit = 50): WebhookDelivery[] {
  loadEndpointInScope(ctx, endpointId);
  const rows = db
    .select()
    .from(schema.webhookDeliveries)
    .where(and(eq(schema.webhookDeliveries.endpointId, endpointId), eq(schema.webhookDeliveries.tenantId, ctx.tenantId)))
    .orderBy(desc(schema.webhookDeliveries.createdAt))
    .limit(limit)
    .all();
  const attempts = rows.length
    ? db.select().from(schema.webhookAttempts).where(inArray(schema.webhookAttempts.deliveryId, rows.map((row) => row.id))).orderBy(asc(schema.webhookAttempts.attempt)).all()
    : [];
  return rows.map((row) => toDelivery(row, attempts.filter((attempt) => attempt.deliveryId === row.id)));
}

/* — Writes ——————————————————————————————————————————————————————— */

function assertUrl(url: string): string {
  const refusal = urlRefusal(url, policy());
  if (refusal) throw invalid(refusal, [{ path: 'url', code: 'unsafe_url', message: refusal }]);
  return new URL(url).toString();
}

export function createEndpoint(ctx: RequestContext, input: WebhookEndpointInput): { endpoint: WebhookEndpoint; secret: string } {
  const url = assertUrl(input.url);
  const endpointId = id('whe');
  const secret = newSecret();
  const at = now();
  transact(() => {
    db.insert(schema.webhookEndpoints)
      .values({
        id: endpointId,
        tenantId: ctx.tenantId,
        url,
        description: input.description ?? '',
        events: [...new Set(input.events)],
        state: 'active',
        secretCiphertext: encryptField('webhook-secret', endpointId, secret),
        secretHint: secret.slice(-4),
        // Events from now on; an endpoint does not receive history.
        cursorSeq: latestSeq(),
        createdByUserId: ctx.userId,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    audit(ctx, {
      action: 'webhook.endpoint_created',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      entityLabel: new URL(url).host,
      after: { url, events: input.events.join(', ') },
    });
  });
  return { endpoint: toEndpoint(loadEndpointInScope(ctx, endpointId)), secret };
}

export function updateEndpoint(ctx: RequestContext, endpointId: string, patch: WebhookEndpointPatch): WebhookEndpoint {
  const row = loadEndpointInScope(ctx, endpointId);
  const url = patch.url !== undefined ? assertUrl(patch.url) : row.url;
  const next = {
    url,
    description: patch.description ?? row.description,
    events: patch.events ? [...new Set(patch.events)] : row.events,
    // Re-activating a disabled endpoint is how an owner says "fixed, try again".
    state: patch.state ?? row.state,
    ...(patch.state === 'active' ? { consecutiveFailures: 0, disabledAt: null, disabledReason: null } : {}),
    updatedAt: now(),
  };
  transact(() => {
    db.update(schema.webhookEndpoints).set(next).where(eq(schema.webhookEndpoints.id, endpointId)).run();
    if (patch.state === 'active' && row.state !== 'active') {
      // Anything that was waiting while it was off is due now.
      db.update(schema.webhookDeliveries)
        .set({ nextAttemptAt: now() })
        .where(and(eq(schema.webhookDeliveries.endpointId, endpointId), eq(schema.webhookDeliveries.state, 'pending')))
        .run();
    }
    audit(ctx, {
      action: 'webhook.endpoint_updated',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      entityLabel: new URL(url).host,
      before: { url: row.url, events: row.events.join(', '), state: row.state, description: row.description },
      after: { url: next.url, events: next.events.join(', '), state: next.state, description: next.description },
    });
  });
  return toEndpoint(loadEndpointInScope(ctx, endpointId));
}

export function deleteEndpoint(ctx: RequestContext, endpointId: string): void {
  const row = loadEndpointInScope(ctx, endpointId);
  transact(() => {
    db.update(schema.webhookEndpoints).set({ deletedAt: now(), state: 'paused', updatedAt: now() }).where(eq(schema.webhookEndpoints.id, endpointId)).run();
    db.update(schema.webhookDeliveries)
      .set({ state: 'failed', lastError: 'Endpoint deleted.', completedAt: now() })
      .where(and(eq(schema.webhookDeliveries.endpointId, endpointId), eq(schema.webhookDeliveries.state, 'pending')))
      .run();
    audit(ctx, { action: 'webhook.endpoint_deleted', entityType: 'webhook_endpoint', entityId: endpointId, entityLabel: new URL(row.url).host });
  });
}

/** New secret now; the old one keeps signing alongside it for 24 hours. */
export function rotateSecret(ctx: RequestContext, endpointId: string): { endpoint: WebhookEndpoint; secret: string } {
  const row = loadEndpointInScope(ctx, endpointId);
  const secret = newSecret();
  const at = now();
  transact(() => {
    db.update(schema.webhookEndpoints)
      .set({
        secretCiphertext: encryptField('webhook-secret', endpointId, secret),
        secretHint: secret.slice(-4),
        previousSecretCiphertext: row.secretCiphertext,
        previousSecretExpiresAt: at + ROTATION_OVERLAP_MS,
        updatedAt: at,
      })
      .where(eq(schema.webhookEndpoints.id, endpointId))
      .run();
    audit(ctx, {
      action: 'webhook.secret_rotated',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      entityLabel: new URL(row.url).host,
      after: { previousSecretValidUntil: new Date(at + ROTATION_OVERLAP_MS).toISOString() },
    });
  });
  return { endpoint: toEndpoint(loadEndpointInScope(ctx, endpointId)), secret };
}

export function revealSecret(ctx: RequestContext, endpointId: string): string {
  const row = loadEndpointInScope(ctx, endpointId);
  audit(ctx, { action: 'webhook.secret_revealed', entityType: 'webhook_endpoint', entityId: endpointId, entityLabel: new URL(row.url).host });
  return decryptField('webhook-secret', endpointId, row.secretCiphertext);
}

/* — Fan-out and delivery ————————————————————————————————————————— */

function envelope(eventId: string, type: WebhookDeliveredType, tenant: { id: string; slug: string }, occurredAt: number, data: Record<string, unknown>): string {
  const body: WebhookEnvelope = {
    id: eventId,
    type,
    version: WEBHOOK_ENVELOPE_VERSION,
    tenant,
    occurredAt: new Date(occurredAt).toISOString(),
    data: data as WebhookEnvelope['data'],
  };
  return JSON.stringify(body);
}

/** Moves every active endpoint's cursor forward, queueing what it subscribed to. */
export function fanOut(at = now()): number {
  let queued = 0;
  const endpoints = db
    .select()
    .from(schema.webhookEndpoints)
    .where(and(eq(schema.webhookEndpoints.state, 'active'), isNull(schema.webhookEndpoints.deletedAt)))
    .all();
  for (const endpoint of endpoints) {
    const events = db
      .select()
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.channel, integrationChannel(endpoint.tenantId)), gt(schema.outboxEvents.seq, endpoint.cursorSeq)))
      .orderBy(asc(schema.outboxEvents.seq))
      .limit(FAN_OUT_BATCH)
      .all();
    if (events.length === 0) continue;
    const tenant = db.select({ id: schema.tenants.id, slug: schema.tenants.slug }).from(schema.tenants).where(eq(schema.tenants.id, endpoint.tenantId)).get()!;
    transact(() => {
      for (const event of events) {
        const payload = event.payload as { type?: string; data?: Record<string, unknown> };
        if (!payload.type || !endpoint.events.includes(payload.type)) continue;
        const inserted = db
          .insert(schema.webhookDeliveries)
          .values({
            id: id('whd'),
            tenantId: endpoint.tenantId,
            endpointId: endpoint.id,
            eventId: event.id,
            eventType: payload.type,
            body: envelope(event.id, payload.type as WebhookEventType, tenant, event.at, payload.data ?? {}),
            state: 'pending',
            nextAttemptAt: at,
            createdAt: at,
          })
          .onConflictDoNothing()
          .run();
        queued += inserted.changes;
      }
      db.update(schema.webhookEndpoints).set({ cursorSeq: events.at(-1)!.seq }).where(eq(schema.webhookEndpoints.id, endpoint.id)).run();
    });
  }
  return queued;
}

/** When the next attempt is due after `attempts` failures, or null to give up. */
export function nextAttemptAfter(delivery: Pick<DeliveryRow, 'createdAt'>, attempts: number, at: number): number | null {
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (delay === undefined) return null;
  const next = at + delay;
  return next - delivery.createdAt > GIVE_UP_AFTER_MS ? null : next;
}

function disableEndpoint(endpoint: EndpointRow, at: number): void {
  const reason = `Disabled after ${DISABLE_AFTER_CONSECUTIVE_FAILURES} failed deliveries in a row. Fix the receiver, then turn the endpoint back on.`;
  db.update(schema.webhookEndpoints)
    .set({ state: 'disabled', disabledAt: at, disabledReason: reason, updatedAt: at })
    .where(eq(schema.webhookEndpoints.id, endpoint.id))
    .run();
  const owners = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, endpoint.tenantId), eq(schema.users.role, 'owner'), isNull(schema.users.deletedAt)))
    .all();
  const host = new URL(endpoint.url).host;
  for (const owner of owners) {
    db.insert(schema.notifications)
      .values({
        id: id('ntf'),
        tenantId: endpoint.tenantId,
        userId: owner.id,
        channel: 'in_app',
        kind: 'integration_down',
        title: `Webhook to ${host} turned off`,
        body: reason,
        link: '/settings?tab=integrations',
        createdAt: at,
      })
      .run();
  }
  db.insert(schema.auditLog)
    .values({
      id: id('aud'),
      tenantId: endpoint.tenantId,
      branchId: null,
      actorId: null,
      actorName: 'Shark Fitness (automatic)',
      actorRole: 'system',
      action: 'webhook.endpoint_disabled',
      entityType: 'webhook_endpoint',
      entityId: endpoint.id,
      entityLabel: host,
      reason,
      changes: [{ field: 'state', from: endpoint.state, to: 'disabled' }],
      at,
    })
    .run();
  emit({
    tenantId: endpoint.tenantId,
    channel: channels.tenant(endpoint.tenantId),
    topic: 'alert.raised',
    payload: { kind: 'integration_down', endpointId: endpoint.id },
  });
  log('warn', 'webhook_endpoint_disabled', { tenantId: endpoint.tenantId, endpointId: endpoint.id });
}

async function attempt(delivery: DeliveryRow, endpoint: EndpointRow, clock: () => number): Promise<void> {
  const sentAt = clock();
  const timestamp = Math.floor(sentAt / 1000);
  const result = await safePost(
    endpoint.url,
    delivery.body,
    {
      'content-type': 'application/json',
      'user-agent': 'SharkFitness-Webhooks/1',
      'shark-signature': signatureHeader(secretsFor(endpoint, sentAt), timestamp, delivery.body),
      'shark-event-id': delivery.eventId,
      'shark-event-type': delivery.eventType,
      'shark-delivery-id': delivery.id,
    },
    policy(),
    resolver,
  );
  const at = clock();
  const attemptNumber = delivery.attempts + 1;
  transact(() => {
    db.insert(schema.webhookAttempts)
      .values({
        id: id('wha'),
        tenantId: delivery.tenantId,
        deliveryId: delivery.id,
        endpointId: endpoint.id,
        attempt: attemptNumber,
        at,
        statusCode: result.statusCode,
        ok: result.ok,
        latencyMs: result.latencyMs,
        error: result.error,
        responseExcerpt: result.responseExcerpt,
      })
      .run();
    // A test send is one attempt, answered on the spot; it is never retried.
    const nextAt = result.ok || delivery.test ? null : nextAttemptAfter(delivery, attemptNumber, at);
    db.update(schema.webhookDeliveries)
      .set({
        attempts: attemptNumber,
        state: result.ok ? 'succeeded' : nextAt === null ? 'failed' : 'pending',
        nextAttemptAt: nextAt,
        leaseUntil: null,
        lastStatusCode: result.statusCode,
        lastError: result.error,
        completedAt: result.ok || nextAt === null ? at : null,
      })
      .where(eq(schema.webhookDeliveries.id, delivery.id))
      .run();
    // Test sends report on the receiver but do not count against it.
    if (delivery.test) return;
    const current = db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpoint.id)).get()!;
    const failures = result.ok ? 0 : current.consecutiveFailures + 1;
    db.update(schema.webhookEndpoints).set({ consecutiveFailures: failures }).where(eq(schema.webhookEndpoints.id, endpoint.id)).run();
    if (!result.ok && failures >= DISABLE_AFTER_CONSECUTIVE_FAILURES && current.state === 'active') disableEndpoint(current, at);
  });
}

/** Claims due deliveries for active endpoints and sends them, a few at a time. */
export async function deliverDue(clock: () => number = now): Promise<{ attempted: number; succeeded: number }> {
  const at = clock();
  const claimed = transact(() => {
    const due = db
      .select({ delivery: schema.webhookDeliveries, endpoint: schema.webhookEndpoints })
      .from(schema.webhookDeliveries)
      .innerJoin(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, schema.webhookDeliveries.endpointId))
      .where(
        and(
          eq(schema.webhookDeliveries.state, 'pending'),
          lte(schema.webhookDeliveries.nextAttemptAt, at),
          or(isNull(schema.webhookDeliveries.leaseUntil), lte(schema.webhookDeliveries.leaseUntil, at)),
          eq(schema.webhookEndpoints.state, 'active'),
          isNull(schema.webhookEndpoints.deletedAt),
        ),
      )
      .orderBy(asc(schema.webhookDeliveries.nextAttemptAt))
      .limit(DELIVERY_BATCH)
      .all();
    for (const row of due) {
      db.update(schema.webhookDeliveries).set({ leaseUntil: at + LEASE_MS }).where(eq(schema.webhookDeliveries.id, row.delivery.id)).run();
    }
    return due;
  });
  let succeeded = 0;
  for (let index = 0; index < claimed.length; index += CONCURRENCY) {
    await Promise.all(
      claimed.slice(index, index + CONCURRENCY).map(async ({ delivery, endpoint }) => {
        await attempt(delivery, endpoint, clock);
        if (db.select({ state: schema.webhookDeliveries.state }).from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, delivery.id)).get()?.state === 'succeeded') succeeded += 1;
      }),
    );
  }
  return { attempted: claimed.length, succeeded };
}

/** The scheduler's job: queue new events, then send what is due. */
export async function runWebhookDispatch(clock: () => number = now): Promise<{ queued: number; attempted: number; succeeded: number }> {
  const queued = fanOut(clock());
  const { attempted, succeeded } = await deliverDue(clock);
  return { queued, attempted, succeeded };
}

/** Sends one delivery right away (test send and replay), whatever its schedule. */
async function sendNow(deliveryId: string): Promise<WebhookDelivery> {
  const delivery = db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, deliveryId)).get()!;
  const endpoint = db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, delivery.endpointId)).get()!;
  db.update(schema.webhookDeliveries).set({ leaseUntil: now() + LEASE_MS }).where(eq(schema.webhookDeliveries.id, deliveryId)).run();
  await attempt(delivery, endpoint, now);
  return deliveryById(deliveryId);
}

export async function sendTestEvent(ctx: RequestContext, endpointId: string): Promise<WebhookDelivery> {
  const endpoint = loadEndpointInScope(ctx, endpointId);
  if (endpoint.state === 'disabled') throw precondition('Turn the endpoint back on before sending a test.');
  const tenant = db.select({ id: schema.tenants.id, slug: schema.tenants.slug }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get()!;
  const eventId = id('evt');
  const deliveryId = id('whd');
  const at = now();
  db.insert(schema.webhookDeliveries)
    .values({
      id: deliveryId,
      tenantId: ctx.tenantId,
      endpointId,
      eventId,
      eventType: WEBHOOK_TEST_EVENT,
      body: envelope(eventId, WEBHOOK_TEST_EVENT, tenant, at, { test: true }),
      state: 'pending',
      nextAttemptAt: null,
      test: true,
      createdAt: at,
    })
    .run();
  audit(ctx, { action: 'webhook.test_sent', entityType: 'webhook_endpoint', entityId: endpointId, entityLabel: new URL(endpoint.url).host });
  return sendNow(deliveryId);
}

/** Sends the same event (same id, so receivers can de-duplicate) once more. */
export async function replayDelivery(ctx: RequestContext, deliveryId: string): Promise<WebhookDelivery> {
  const original = db
    .select()
    .from(schema.webhookDeliveries)
    .where(and(eq(schema.webhookDeliveries.id, deliveryId), eq(schema.webhookDeliveries.tenantId, ctx.tenantId)))
    .get();
  if (!original) throw notFound('That delivery');
  const endpoint = loadEndpointInScope(ctx, original.endpointId);
  if (endpoint.state === 'disabled') throw precondition('Turn the endpoint back on before replaying.');
  const replayId = id('whd');
  const at = now();
  db.insert(schema.webhookDeliveries)
    .values({
      id: replayId,
      tenantId: ctx.tenantId,
      endpointId: original.endpointId,
      eventId: original.eventId,
      eventType: original.eventType,
      body: original.body,
      state: 'pending',
      nextAttemptAt: at,
      replayOf: original.id,
      test: original.test,
      createdAt: at,
    })
    .run();
  audit(ctx, {
    action: 'webhook.delivery_replayed',
    entityType: 'webhook_delivery',
    entityId: original.id,
    entityLabel: `${original.eventType} → ${new URL(endpoint.url).host}`,
  });
  return sendNow(replayId);
}

/** Disabled endpoints, for the Command Center alert. */
export function disabledEndpointCount(tenantId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.webhookEndpoints)
      .where(and(eq(schema.webhookEndpoints.tenantId, tenantId), eq(schema.webhookEndpoints.state, 'disabled'), isNull(schema.webhookEndpoints.deletedAt)))
      .get()?.n ?? 0
  );
}
