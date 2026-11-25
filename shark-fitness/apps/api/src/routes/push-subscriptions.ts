import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { db, schema, transact } from '../db/client.js';
import { ctxOf } from '../middleware/index.js';
import { audit } from '../lib/audit.js';
import { runtimeConfig } from '../lib/config.js';
import { invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { endpointHash, isAllowedPushEndpoint, pushConfigured } from '../services/push.js';
import { PUSH_CONSENT_PURPOSE } from '../services/notifications.js';

/**
 * This person's Web Push devices (PF-COMM-002).
 *
 * GET tells the app whether push exists on this server at all (the app shows
 * no push UI otherwise) and lists the person's devices, without endpoints.
 * POST registers the browser's subscription; switching push on is the
 * member's consent to the `push_notifications` purpose and is recorded as
 * such. DELETE removes one device.
 */
export const pushSubscriptionRoutes = new Hono();

const Base64Url = (bytes: number, label: string) =>
  z
    .string()
    .trim()
    .max(200)
    .refine((value) => /^[A-Za-z0-9_-]+={0,2}$/.test(value) && Buffer.from(value.replace(/=+$/, ''), 'base64url').length === bytes, {
      message: `${label} is not a valid browser push key.`,
    });

const SubscriptionInput = z.object({
  endpoint: z.string().trim().url().max(2048),
  keys: z.object({
    p256dh: Base64Url(65, 'keys.p256dh'),
    auth: Base64Url(16, 'keys.auth'),
  }),
});

function deviceRows(tenantId: string, userId: string) {
  return db
    .select({
      id: schema.pushSubscriptions.id,
      userAgent: schema.pushSubscriptions.userAgent,
      createdAt: schema.pushSubscriptions.createdAt,
      lastSuccessAt: schema.pushSubscriptions.lastSuccessAt,
    })
    .from(schema.pushSubscriptions)
    .where(and(eq(schema.pushSubscriptions.tenantId, tenantId), eq(schema.pushSubscriptions.userId, userId)))
    .orderBy(desc(schema.pushSubscriptions.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      createdAt: new Date(row.createdAt).toISOString(),
      lastSuccessAt: row.lastSuccessAt ? new Date(row.lastSuccessAt).toISOString() : null,
    }));
}

pushSubscriptionRoutes.get('/', (c) => {
  const ctx = ctxOf(c);
  const available = pushConfigured();
  return c.json({
    available,
    publicKey: available ? runtimeConfig.push.vapid!.publicKey : null,
    items: available ? deviceRows(ctx.tenantId, ctx.userId) : [],
  });
});

pushSubscriptionRoutes.post('/', validate('json', SubscriptionInput), (c) => {
  const ctx = ctxOf(c);
  if (!pushConfigured()) throw precondition('Push notifications are not set up on this server.');
  const input = c.req.valid('json');
  if (!isAllowedPushEndpoint(input.endpoint)) {
    throw invalid('That push address is not from a browser push service.', [
      { path: 'endpoint', code: 'invalid_endpoint', message: 'Use the subscription your browser created.' },
    ]);
  }

  const hash = endpointHash(input.endpoint);
  const at = now();
  // The browser registering now, for the device list in Profile.
  const userAgent = (c.req.header('user-agent') ?? ctx.userAgent).slice(0, 300) || null;
  const subscriptionId = transact(() => {
    const existing = db
      .select({ id: schema.pushSubscriptions.id, userId: schema.pushSubscriptions.userId, tenantId: schema.pushSubscriptions.tenantId })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.endpointHash, hash))
      .get();

    let rowId: string;
    if (existing) {
      // Same browser registering again: refresh keys and the live session.
      // If it belonged to somebody else (a phone handed over without signing
      // out), it is theirs no longer.
      rowId = existing.id;
      db.update(schema.pushSubscriptions)
        .set({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent,
          failureCount: 0,
          ...(existing.userId !== ctx.userId || existing.tenantId !== ctx.tenantId ? { createdAt: at, lastSuccessAt: null } : {}),
        })
        .where(eq(schema.pushSubscriptions.id, existing.id))
        .run();
    } else {
      rowId = id('psub');
      db.insert(schema.pushSubscriptions)
        .values({
          id: rowId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          endpointHash: hash,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent,
          createdAt: at,
          lastSuccessAt: null,
          lastFailureAt: null,
          failureCount: 0,
        })
        .run();
    }

    grantPushConsent(ctx, at);
    audit(ctx, {
      action: existing ? 'push.subscription_refreshed' : 'push.subscribed',
      entityType: 'push_subscription',
      entityId: rowId,
      entityLabel: 'Phone notifications',
      after: { userAgent: userAgent?.slice(0, 120) ?? null },
    });
    return rowId;
  });

  return c.json({ id: subscriptionId }, 201);
});

pushSubscriptionRoutes.delete('/:subscriptionId', (c) => {
  const ctx = ctxOf(c);
  const subscriptionId = c.req.param('subscriptionId');
  const row = db
    .select({ id: schema.pushSubscriptions.id })
    .from(schema.pushSubscriptions)
    .where(
      and(
        eq(schema.pushSubscriptions.id, subscriptionId),
        eq(schema.pushSubscriptions.tenantId, ctx.tenantId),
        eq(schema.pushSubscriptions.userId, ctx.userId),
      ),
    )
    .get();
  if (!row) throw notFound('That device');

  transact(() => {
    db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, row.id)).run();
    audit(ctx, {
      action: 'push.unsubscribed',
      entityType: 'push_subscription',
      entityId: row.id,
      entityLabel: 'Phone notifications',
    });
  });
  return c.json({ ok: true });
});

/** Turning push on is the consent. Withdrawing it is in Profile › Your data. */
function grantPushConsent(ctx: ReturnType<typeof ctxOf>, at: number): void {
  const existing = db
    .select({ id: schema.consents.id, granted: schema.consents.granted })
    .from(schema.consents)
    .where(
      and(
        eq(schema.consents.tenantId, ctx.tenantId),
        eq(schema.consents.userId, ctx.userId),
        eq(schema.consents.purpose, PUSH_CONSENT_PURPOSE),
      ),
    )
    .get();
  if (existing?.granted) return;
  if (existing) {
    db.update(schema.consents).set({ granted: true, updatedAt: at, ip: ctx.ip }).where(eq(schema.consents.id, existing.id)).run();
  } else {
    db.insert(schema.consents)
      .values({ id: id('con'), tenantId: ctx.tenantId, userId: ctx.userId, purpose: PUSH_CONSENT_PURPOSE, granted: true, version: '1.0', updatedAt: at, ip: ctx.ip })
      .run();
  }
  audit(ctx, {
    action: 'consent.granted',
    entityType: 'consent',
    entityId: `${ctx.userId}:${PUSH_CONSENT_PURPOSE}`,
    entityLabel: 'Phone notifications',
    after: { purpose: PUSH_CONSENT_PURPOSE, granted: true, via: 'push_subscription' },
  });
}
