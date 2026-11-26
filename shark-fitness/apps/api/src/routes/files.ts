import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { ctxOf } from '../middleware/index.js';
import { AppError, notFound } from '../lib/errors.js';
import { readMediaBytes, verifyMediaSignature } from '../services/media.js';
import { mayViewMedia } from '../services/progress-photos.js';

/**
 * `GET /v1/files/:id?v=&exp=&sig=` — the only way bytes leave private storage.
 *
 * Three checks, in order: the signature (made for this file, this viewer and
 * this expiry by this server), the expiry (five minutes), and — at the moment
 * of serving, not when the URL was made — whether the signed-in viewer is the
 * one it was made for and may still see the file. A photo made private, or
 * whose consent was withdrawn, stops loading for the coach on the next
 * request even with a URL in hand.
 *
 * A bad or expired signature is 403. A file the viewer may not see is 404, the
 * same as one that does not exist.
 */
export const fileRoutes = new Hono();

fileRoutes.get('/:id', (c) => {
  const ctx = ctxOf(c);
  const mediaId = c.req.param('id');
  const check = verifyMediaSignature({
    mediaId,
    viewer: c.req.query('v') ?? '',
    exp: c.req.query('exp') ?? '',
    sig: c.req.query('sig') ?? '',
  });
  if (check === 'invalid') throw new AppError('FORBIDDEN', 'That link is not valid.');
  if (check === 'expired') throw new AppError('FORBIDDEN', 'That link has expired. Reload the page to get a fresh one.');
  if (c.req.query('v') !== ctx.userId) throw notFound('That file');

  const media = db
    .select()
    .from(schema.mediaObjects)
    .where(and(eq(schema.mediaObjects.id, mediaId), eq(schema.mediaObjects.tenantId, ctx.tenantId)))
    .get();
  if (!media || media.deletedAt !== null || !mayViewMedia(ctx, mediaId)) throw notFound('That file');
  const bytes = readMediaBytes(media);
  if (!bytes) throw notFound('That file');

  return c.body(new Uint8Array(bytes), 200, {
    'content-type': media.contentType,
    'content-length': String(bytes.length),
    'cache-control': 'private, no-store',
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-site',
  });
});
