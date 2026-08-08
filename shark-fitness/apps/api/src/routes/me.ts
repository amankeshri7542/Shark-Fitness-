import { Hono } from 'hono';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { db, schema } from '../db/client.js';
import { ctxOf } from '../middleware/index.js';
import { listSessions, revokeSession, viewerFor } from '../services/auth.js';
import { audit } from '../lib/audit.js';
import { id } from '../lib/ids.js';
import { now, relativeTime } from '../lib/time.js';
import { notFound } from '../lib/errors.js';

export const meRoutes = new Hono();

meRoutes.get('/', (c) => c.json({ viewer: viewerFor(ctxOf(c).userId) }));

/* — Branches this actor may act in. Drives the branch switcher. ————— */
meRoutes.get('/branches', (c) => {
  const ctx = ctxOf(c);
  const rows = db
    .select()
    .from(schema.branches)
    .where(eq(schema.branches.tenantId, ctx.tenantId))
    .all()
    .filter((b) => ctx.branchIds.includes(b.id))
    .map((b) => ({
      id: b.id,
      tenantId: b.tenantId,
      name: b.name,
      slug: b.slug,
      addressLine: b.addressLine,
      city: b.city,
      timezone: b.timezone,
      capacity: b.capacity,
      opensAt: minutesToClock(b.opensMinutes),
      closesAt: minutesToClock(b.closesMinutes),
      state: b.state,
      amenities: b.amenities,
      phone: b.phone,
    }));
  return c.json({ items: rows, activeBranchId: ctx.activeBranchId });
});

/* — Preferences ————————————————————————————————————————————— */

const PreferencesInput = z.object({
  register: z.enum(['predator', 'plain']).optional(),
  unitSystem: z.enum(['metric', 'imperial']).optional(),
  theme: z.enum(['dark', 'light', 'system']).optional(),
  haptics: z.boolean().optional(),
  reducedMotion: z.boolean().optional(),
});

meRoutes.patch('/preferences', validate('json', PreferencesInput), (c) => {
  const ctx = ctxOf(c);
  const patch = c.req.valid('json');
  const user = db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).get();
  if (!user) throw notFound('Your account');

  const merged = { ...(user.preferences ?? {}), ...patch };
  db.update(schema.users)
    .set({ preferences: merged, updatedAt: now() })
    .where(eq(schema.users.id, ctx.userId))
    .run();

  return c.json({ viewer: viewerFor(ctx.userId) });
});

/* — Consent (Compliance PRD). Withdrawal is as easy as granting. ——— */

const CONSENT_CATALOGUE = [
  { purpose: 'terms', required: true, description: 'Terms of membership' },
  { purpose: 'privacy', required: true, description: 'How your data is handled' },
  { purpose: 'marketing_email', required: false, description: 'Offers and news by email' },
  { purpose: 'marketing_sms', required: false, description: 'Offers and news by SMS' },
  { purpose: 'marketing_whatsapp', required: false, description: 'Offers and news on WhatsApp' },
  { purpose: 'progress_photos', required: false, description: 'Store progress photos for you' },
  { purpose: 'health_data', required: false, description: 'Import steps and sleep from your phone' },
  { purpose: 'community_visibility', required: false, description: 'Show your name on gym leaderboards' },
] as const;

meRoutes.get('/consents', (c) => {
  const ctx = ctxOf(c);
  const stored = db
    .select()
    .from(schema.consents)
    .where(eq(schema.consents.userId, ctx.userId))
    .all();

  const items = CONSENT_CATALOGUE.map((entry) => {
    const row = stored.find((s) => s.purpose === entry.purpose);
    return {
      purpose: entry.purpose,
      granted: row?.granted ?? false,
      version: row?.version ?? '1.0',
      updatedAt: new Date(row?.updatedAt ?? Date.now()).toISOString(),
      required: entry.required,
      description: entry.description,
    };
  });
  return c.json({ items });
});

const ConsentInput = z.object({
  purpose: z.enum(CONSENT_CATALOGUE.map((c) => c.purpose) as [string, ...string[]]),
  granted: z.boolean(),
});

meRoutes.put('/consents', validate('json', ConsentInput), (c) => {
  const ctx = ctxOf(c);
  const { purpose, granted } = c.req.valid('json');

  const existing = db
    .select()
    .from(schema.consents)
    .where(and(eq(schema.consents.userId, ctx.userId), eq(schema.consents.purpose, purpose)))
    .get();

  if (existing) {
    db.update(schema.consents)
      .set({ granted, updatedAt: now(), ip: ctx.ip })
      .where(eq(schema.consents.id, existing.id))
      .run();
  } else {
    db.insert(schema.consents)
      .values({
        id: id('con'),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        purpose,
        granted,
        version: '1.0',
        updatedAt: now(),
        ip: ctx.ip,
      })
      .run();
  }

  audit(ctx, {
    action: granted ? 'consent.granted' : 'consent.withdrawn',
    entityType: 'consent',
    entityId: `${ctx.userId}:${purpose}`,
    entityLabel: purpose,
    before: { granted: existing?.granted ?? false },
    after: { granted },
  });

  return c.json({ ok: true });
});

/* — Devices and sessions ——————————————————————————————————— */

meRoutes.get('/sessions', (c) => {
  const ctx = ctxOf(c);
  return c.json({ items: listSessions(ctx.userId, '') });
});

meRoutes.delete('/sessions/:id', (c) => {
  const ctx = ctxOf(c);
  const sessionId = c.req.param('id');
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session || session.userId !== ctx.userId) throw notFound('That session');

  revokeSession(sessionId);
  audit(ctx, {
    action: 'session.revoked',
    entityType: 'session',
    entityId: sessionId,
    entityLabel: session.userAgent,
  });
  return c.json({ ok: true });
});

/* — Notifications ——————————————————————————————————————————— */

meRoutes.get('/notifications', (c) => {
  const ctx = ctxOf(c);
  const items = db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, ctx.userId))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(50)
    .all()
    .map((n) => ({
      id: n.id,
      channel: n.channel,
      title: n.title,
      body: n.body,
      createdAt: new Date(n.createdAt).toISOString(),
      relativeTime: relativeTime(n.createdAt),
      readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
      link: n.link,
      kind: n.kind,
    }));

  const unread = items.filter((n) => !n.readAt).length;
  return c.json({ items, unread });
});

meRoutes.post('/notifications/read', validate('json', z.object({ ids: z.array(z.string()).optional() })), (c) => {
  const ctx = ctxOf(c);
  const { ids } = c.req.valid('json');

  const targets = ids?.length
    ? ids
    : db
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, ctx.userId), isNull(schema.notifications.readAt)))
        .all()
        .map((r) => r.id);

  for (const notificationId of targets) {
    db.update(schema.notifications)
      .set({ readAt: now() })
      .where(and(eq(schema.notifications.id, notificationId), eq(schema.notifications.userId, ctx.userId)))
      .run();
  }
  return c.json({ ok: true, marked: targets.length });
});

/* — Data export and deletion (Compliance PRD) ————————————————— */

meRoutes.post('/data-export', (c) => {
  const ctx = ctxOf(c);
  audit(ctx, {
    action: 'data.export_requested',
    entityType: 'user',
    entityId: ctx.userId,
    entityLabel: ctx.name,
  });
  return c.json({
    ok: true,
    message:
      'Your export is being prepared. You will get a link within 24 hours; it stays valid for 7 days.',
  });
});

meRoutes.post('/deletion-request', validate('json', z.object({ reason: z.string().max(500).optional() })), (c) => {
  const ctx = ctxOf(c);
  const { reason } = c.req.valid('json');

  db.update(schema.users)
    .set({ accountState: 'deletion_requested', updatedAt: now() })
    .where(eq(schema.users.id, ctx.userId))
    .run();

  audit(ctx, {
    action: 'account.deletion_requested',
    entityType: 'user',
    entityId: ctx.userId,
    entityLabel: ctx.name,
    reason: reason ?? null,
  });

  return c.json({
    ok: true,
    message:
      'Your request is recorded. Financial and safety records that the law requires us to keep are retained; everything else is removed within 30 days. You can cancel this before then.',
  });
});

function minutesToClock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
