import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema, sqlite, transact } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { AppError, invalid, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { ImageRejected, cleanImage } from '../lib/media-image.js';
import { mediaStorage } from '../lib/media-storage.js';
import { now } from '../lib/time.js';

/**
 * Private media (P05): storing, signing and destroying files.
 *
 * A stored file is reachable only by a URL signed for one viewer that lives
 * five minutes, and the server re-checks that viewer's right to see it when
 * the URL is used (routes/files.ts). Deleting a file removes the bytes and
 * keeps the row as a tombstone.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const SIGNED_URL_TTL_SEC = 300;

type MediaRow = typeof schema.mediaObjects.$inferSelect;

/** Derived from the deployment secret, for this one purpose. */
function signingKey(): Buffer {
  return createHmac('sha256', runtimeConfig.passSecret).update('shark-media-url-v1').digest();
}

function signature(mediaId: string, viewerUserId: string, expiresAtSec: number): string {
  return createHmac('sha256', signingKey()).update(`${mediaId}.${viewerUserId}.${expiresAtSec}`).digest('base64url');
}

/** A URL for one viewer, good for five minutes. */
export function signMediaUrl(mediaId: string, viewerUserId: string, atMs = now()): { url: string; expiresAt: string } {
  const expiresAtSec = Math.floor(atMs / 1000) + SIGNED_URL_TTL_SEC;
  const query = new URLSearchParams({ v: viewerUserId, exp: String(expiresAtSec), sig: signature(mediaId, viewerUserId, expiresAtSec) });
  return { url: `/v1/files/${mediaId}?${query}`, expiresAt: new Date(expiresAtSec * 1000).toISOString() };
}

export function verifyMediaSignature(
  input: { mediaId: string; viewer: string; exp: string; sig: string },
  atMs = now(),
): 'ok' | 'expired' | 'invalid' {
  const expiresAtSec = Number(input.exp);
  if (!Number.isSafeInteger(expiresAtSec)) return 'invalid';
  const expected = Buffer.from(signature(input.mediaId, input.viewer, expiresAtSec));
  const given = Buffer.from(input.sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  // A URL that claims to live longer than any we issue was not issued by us.
  if (expiresAtSec - Math.floor(atMs / 1000) > SIGNED_URL_TTL_SEC) return 'invalid';
  if (expiresAtSec * 1000 <= atMs) return 'expired';
  return 'ok';
}

export function tenantQuotaBytes(tenantId: string): number {
  const quotas = db.select({ quotas: schema.tenants.quotas }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()?.quotas as
    | { storageMb?: number }
    | undefined;
  return (quotas?.storageMb ?? runtimeConfig.mediaQuotaMb) * 1024 * 1024;
}

export function tenantUsageBytes(tenantId: string): number {
  return (
    db
      .select({ total: sql<number>`coalesce(sum(${schema.mediaObjects.byteSize}), 0)` })
      .from(schema.mediaObjects)
      .where(and(eq(schema.mediaObjects.tenantId, tenantId), isNull(schema.mediaObjects.deletedAt)))
      .get()?.total ?? 0
  );
}

/**
 * Checks, cleans and stores an image. The caller writes whatever row points
 * at it, in `afterStore`, inside the same transaction as the media row — if
 * that fails, the file is removed again.
 */
export function storeImage<T>(
  input: { tenantId: string; ownerMemberId: string; purpose: string; bytes: Buffer },
  afterStore: (media: MediaRow) => T,
): { media: MediaRow; result: T; removedMetadata: string[] } {
  const storage = mediaStorage();
  if (!storage) throw precondition('Photo storage is not switched on for this gym yet. Nothing was uploaded.');
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'That file is over 10 MB. Choose a smaller photo.');
  }

  let clean;
  try {
    clean = cleanImage(input.bytes);
  } catch (error) {
    if (error instanceof ImageRejected) throw invalid(error.message);
    throw error;
  }

  if (tenantUsageBytes(input.tenantId) + clean.bytes.length > tenantQuotaBytes(input.tenantId)) {
    throw new AppError('QUOTA_EXCEEDED', 'This gym has used all of its photo storage. Nothing was uploaded. The gym can free space or raise the limit.');
  }

  const atMs = now();
  const mediaId = id('med');
  const ext = clean.type === 'image/jpeg' ? 'jpg' : clean.type === 'image/png' ? 'png' : 'webp';
  const storageKey = `${input.tenantId}/${new Date(atMs).getUTCFullYear()}/${mediaId}.${ext}`;
  const sha256 = createHash('sha256').update(clean.bytes).digest('hex');

  storage.put(storageKey, clean.bytes);
  try {
    return transact(() => {
      db.insert(schema.mediaObjects)
        .values({
          id: mediaId,
          tenantId: input.tenantId,
          ownerMemberId: input.ownerMemberId,
          purpose: input.purpose,
          storageKey,
          contentType: clean.type,
          byteSize: clean.bytes.length,
          width: clean.width,
          height: clean.height,
          sha256,
          createdAt: atMs,
          deletedAt: null,
          deletedReason: null,
        })
        .run();
      const media = db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, mediaId)).get()!;
      return { media, result: afterStore(media), removedMetadata: clean.removed };
    });
  } catch (error) {
    storage.delete(storageKey);
    throw error;
  }
}

/** Bytes for a live media row, or null if gone. */
export function readMediaBytes(media: MediaRow): Buffer | null {
  if (media.deletedAt !== null) return null;
  return mediaStorage()?.get(media.storageKey) ?? null;
}

/**
 * Destroys the bytes and leaves the row as a tombstone (what was held, its
 * checksum, when and why it went). Idempotent. Inside or outside a
 * transaction; the file is removed only once the tombstone is committed.
 */
export function destroyMedia(mediaId: string, reason: string, atMs = now()): boolean {
  const media = db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, mediaId)).get();
  if (!media || media.deletedAt !== null) return false;
  db.update(schema.mediaObjects).set({ deletedAt: atMs, deletedReason: reason }).where(eq(schema.mediaObjects.id, mediaId)).run();
  if (sqlite.inTransaction) {
    // A later step of the caller's transaction may still fail and roll the
    // row back to live; the bytes must still be there if it does. SQLite
    // transactions here are synchronous, so by the time a microtask runs the
    // outcome is settled.
    if (pendingUnlinks.length === 0) queueMicrotask(unlinkCommitted);
    pendingUnlinks.push({ mediaId, storageKey: media.storageKey });
  } else {
    mediaStorage()?.delete(media.storageKey);
  }
  return true;
}

const pendingUnlinks: Array<{ mediaId: string; storageKey: string }> = [];

/** Removes the files whose tombstones committed; a rolled-back one keeps its file. */
export function unlinkCommitted(): void {
  for (const { mediaId, storageKey } of pendingUnlinks.splice(0)) {
    const row = db.select({ deletedAt: schema.mediaObjects.deletedAt }).from(schema.mediaObjects).where(eq(schema.mediaObjects.id, mediaId)).get();
    if (row && row.deletedAt !== null) mediaStorage()?.delete(storageKey);
  }
}
