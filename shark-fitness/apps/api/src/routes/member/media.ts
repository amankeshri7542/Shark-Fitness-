import { Hono } from 'hono';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { notFound } from '../../lib/errors.js';
import { id } from '../../lib/ids.js';
import { isoDate, now } from '../../lib/time.js';

/**
 * On-demand library.
 *
 * This tenant has no video hosting: every seeded asset carries
 * `playbackUrl: null`, and the `video_minutes` usage meter is provisioned with
 * a limit of zero. That is the real state of the product, so this module is a
 * metadata catalogue that says so plainly rather than a player that fails.
 *
 * Three consequences shape the code below.
 *
 * 1. Playback is never asserted. Each row reports why it cannot be played —
 *    the plan does not include it, the tenant has no video allowance, or the
 *    asset has no source — and the client renders that sentence instead of a
 *    broken control.
 * 2. Entitlement is evaluated server-side against the member's own membership,
 *    so a locked asset cannot be unlocked by editing the client.
 * 3. Progress and favourites are still real. They are the parts that work
 *    without a video pipeline, and they survive a later switch to one.
 */
export const mediaRoutes = new Hono();

/** Why an asset cannot be played right now. `null` means it can. */
type Block = 'no_video_allowance' | 'not_in_plan' | 'no_source' | null;

const BLOCK_COPY: Record<Exclude<Block, null>, string> = {
  no_video_allowance:
    'Streaming is not switched on for this gym yet. The plan and the coaching notes below are the useful part for now.',
  not_in_plan: 'Your membership does not include this one. Reception can tell you what would.',
  no_source: 'This one has no video attached yet. It is listed so you can find it when it lands.',
};

/** The tenant's video allowance for the current month. Zero is a real answer,
 *  not a missing row — an absent meter is treated as no allowance. */
function videoAllowance(tenantId: string, atMs: number): { used: number; limit: number; period: string } {
  const period = isoDate(atMs, 'Asia/Kolkata').slice(0, 7);
  const row = db
    .select()
    .from(schema.usageMeters)
    .where(
      and(
        eq(schema.usageMeters.tenantId, tenantId),
        eq(schema.usageMeters.meter, 'video_minutes'),
        eq(schema.usageMeters.period, period),
      ),
    )
    .get();
  return { used: row?.used ?? 0, limit: row?.limitValue ?? 0, period };
}

/**
 * The product kinds this member currently holds. Drives `requiredProductKinds`.
 *
 * The kind lives inside the membership's product snapshot rather than in a
 * column, which is deliberate elsewhere in the system: the snapshot is what the
 * member actually bought, so a later catalogue edit cannot retroactively grant
 * or revoke access to a video.
 */
function heldProductKinds(tenantId: string, memberId: string): string[] {
  return db
    .select({ snapshot: schema.memberships.productSnapshot })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.tenantId, tenantId),
        eq(schema.memberships.memberId, memberId),
        sql`${schema.memberships.state} in ('active','grace','frozen')`,
      ),
    )
    .all()
    .map((row) => row.snapshot?.kind as string | undefined)
    .filter((kind): kind is string => typeof kind === 'string');
}

function blockFor(
  asset: { requiredProductKinds: string[]; playbackUrl: string | null },
  held: string[],
  allowance: { limit: number },
): Block {
  if (asset.requiredProductKinds.length > 0 && !asset.requiredProductKinds.some((kind) => held.includes(kind))) {
    return 'not_in_plan';
  }
  if (allowance.limit <= 0) return 'no_video_allowance';
  if (!asset.playbackUrl) return 'no_source';
  return null;
}

const ListQuery = z.object({
  category: z.string().optional(),
  level: z.enum(['all', 'beginner', 'intermediate', 'advanced']).default('all'),
  favourites: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(60).optional(),
});

mediaRoutes.get('/', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const query = c.req.valid('query');
  const atMs = now();

  const allowance = videoAllowance(ctx.tenantId, atMs);
  const held = heldProductKinds(ctx.tenantId, memberId);

  // Expired assets are gone; unpublished ones have not arrived.
  const assets = db
    .select()
    .from(schema.mediaAssets)
    .where(
      and(
        eq(schema.mediaAssets.tenantId, ctx.tenantId),
        sql`${schema.mediaAssets.publishedAt} <= ${atMs}`,
        or(isNull(schema.mediaAssets.expiresAt), gt(schema.mediaAssets.expiresAt, atMs)),
      ),
    )
    .orderBy(desc(schema.mediaAssets.publishedAt))
    .all();

  const progress = new Map<string, typeof schema.mediaProgress.$inferSelect>();
  for (const row of db
    .select()
    .from(schema.mediaProgress)
    .where(and(eq(schema.mediaProgress.tenantId, ctx.tenantId), eq(schema.mediaProgress.memberId, memberId)))
    .all()) {
    progress.set(row.assetId, row);
  }

  const needle = query.q?.toLowerCase();

  const items = assets
    .filter((a) => (query.category && query.category !== 'all' ? a.category === query.category : true))
    .filter((a) => (query.level === 'all' ? true : a.level === query.level))
    .filter((a) => (query.favourites === 'true' ? (progress.get(a.id)?.favourite ?? false) : true))
    .filter((a) =>
      needle ? a.title.toLowerCase().includes(needle) || a.trainerName.toLowerCase().includes(needle) : true,
    )
    .map((asset) => {
      const mine = progress.get(asset.id);
      const block = blockFor(asset, held, allowance);
      return {
        id: asset.id,
        title: asset.title,
        category: asset.category,
        trainerName: asset.trainerName,
        durationSec: asset.durationSec,
        durationLabel: `${Math.round(asset.durationSec / 60)} min`,
        level: asset.level,
        equipment: asset.equipment,
        posterColor: asset.posterColor,
        hasCaptions: asset.hasCaptions,
        publishedAt: new Date(asset.publishedAt).toISOString(),
        // Never a URL the client cannot use. Null plus a reason, always.
        playbackUrl: block === null ? asset.playbackUrl : null,
        playable: block === null,
        blockedReason: block,
        blockedMessage: block ? BLOCK_COPY[block] : null,
        positionSec: mine?.positionSec ?? 0,
        progressPct:
          asset.durationSec > 0 ? Math.min(100, Math.round(((mine?.positionSec ?? 0) / asset.durationSec) * 100)) : 0,
        favourite: mine?.favourite ?? false,
        completedAt: mine?.completedAt ? new Date(mine.completedAt).toISOString() : null,
      };
    });

  const categoryCounts = new Map<string, number>();
  for (const asset of assets) categoryCounts.set(asset.category, (categoryCounts.get(asset.category) ?? 0) + 1);

  return c.json({
    // Stated once at the top so the whole screen can explain itself rather than
    // each card apologising separately.
    streaming: {
      enabled: allowance.limit > 0,
      usedMinutes: allowance.used,
      limitMinutes: allowance.limit,
      period: allowance.period,
      message:
        allowance.limit > 0
          ? null
          : 'This gym has not switched on video streaming. Everything is listed with its plan, coach and kit so you can still follow along on the floor.',
    },
    filters: {
      category: query.category ?? 'all',
      level: query.level,
      favourites: query.favourites === 'true',
    },
    categories: [
      { value: 'all', label: 'All', count: assets.length },
      ...[...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, label: value.replace(/_/g, ' '), count })),
    ],
    total: items.length,
    items,
  });
});

mediaRoutes.get('/:assetId', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const atMs = now();

  const asset = db
    .select()
    .from(schema.mediaAssets)
    .where(and(eq(schema.mediaAssets.id, c.req.param('assetId')), eq(schema.mediaAssets.tenantId, ctx.tenantId)))
    .get();
  if (!asset) throw notFound('That session');

  const allowance = videoAllowance(ctx.tenantId, atMs);
  const held = heldProductKinds(ctx.tenantId, memberId);
  const block = blockFor(asset, held, allowance);

  const mine = db
    .select()
    .from(schema.mediaProgress)
    .where(
      and(
        eq(schema.mediaProgress.tenantId, ctx.tenantId),
        eq(schema.mediaProgress.memberId, memberId),
        eq(schema.mediaProgress.assetId, asset.id),
      ),
    )
    .get();

  return c.json({
    asset: {
      id: asset.id,
      title: asset.title,
      category: asset.category,
      trainerName: asset.trainerName,
      durationSec: asset.durationSec,
      durationLabel: `${Math.round(asset.durationSec / 60)} min`,
      level: asset.level,
      equipment: asset.equipment,
      posterColor: asset.posterColor,
      hasCaptions: asset.hasCaptions,
      publishedAt: new Date(asset.publishedAt).toISOString(),
      playbackUrl: block === null ? asset.playbackUrl : null,
      playable: block === null,
      blockedReason: block,
      blockedMessage: block ? BLOCK_COPY[block] : null,
      positionSec: mine?.positionSec ?? 0,
      favourite: mine?.favourite ?? false,
      completedAt: mine?.completedAt ? new Date(mine.completedAt).toISOString() : null,
    },
  });
});

const ProgressBody = z.object({
  positionSec: z.number().int().min(0).optional(),
  favourite: z.boolean().optional(),
  completed: z.boolean().optional(),
});

/**
 * Progress and favourites. Upserted rather than appended: this is a bookmark,
 * not a ledger, and a member scrubbing a video should not grow a row per seek.
 */
mediaRoutes.post('/:assetId/progress', validate('json', ProgressBody), (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  const body = c.req.valid('json');
  const atMs = now();

  const asset = db
    .select()
    .from(schema.mediaAssets)
    .where(and(eq(schema.mediaAssets.id, c.req.param('assetId')), eq(schema.mediaAssets.tenantId, ctx.tenantId)))
    .get();
  if (!asset) throw notFound('That session');

  const existing = db
    .select()
    .from(schema.mediaProgress)
    .where(
      and(
        eq(schema.mediaProgress.tenantId, ctx.tenantId),
        eq(schema.mediaProgress.memberId, memberId),
        eq(schema.mediaProgress.assetId, asset.id),
      ),
    )
    .get();

  const positionSec = Math.min(body.positionSec ?? existing?.positionSec ?? 0, asset.durationSec);
  const favourite = body.favourite ?? existing?.favourite ?? false;
  const completedAt =
    body.completed === true ? (existing?.completedAt ?? atMs) : body.completed === false ? null : (existing?.completedAt ?? null);

  if (existing) {
    db.update(schema.mediaProgress)
      .set({ positionSec, favourite, completedAt, updatedAt: atMs })
      .where(eq(schema.mediaProgress.id, existing.id))
      .run();
  } else {
    db.insert(schema.mediaProgress)
      .values({
        id: id('mpr'),
        tenantId: ctx.tenantId,
        memberId,
        assetId: asset.id,
        positionSec,
        favourite,
        completedAt,
        updatedAt: atMs,
      })
      .run();
  }

  return c.json({
    progress: {
      assetId: asset.id,
      positionSec,
      favourite,
      completedAt: completedAt ? new Date(completedAt).toISOString() : null,
      progressPct: asset.durationSec > 0 ? Math.min(100, Math.round((positionSec / asset.durationSec) * 100)) : 0,
    },
  });
});
