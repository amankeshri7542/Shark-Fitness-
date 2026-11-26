import { and, desc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { db, schema, transact } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { requirePermission, type RequestContext } from '../lib/context.js';
import { invalid, notFound, precondition } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { policyValue } from '../lib/policy.js';
import { DAY, now } from '../lib/time.js';
import { destroyMedia, signMediaUrl, storeImage, unlinkCommitted } from './media.js';
import { loadMemberInScope } from './members.js';

/**
 * Progress photos (P05; PF-PROG-004/006; PRD 04 privacy).
 *
 * - Nothing is stored without the member's photo consent at the current
 *   version (`PHOTO_CONSENT_VERSION`); the version is kept on every photo.
 * - Private by default. "My coach" shares a photo with the member's assigned
 *   coach and nobody else: not other trainers, not managers, not the owner.
 * - Withdrawing consent hides every photo from the coach at once (the check
 *   runs on every list and every file request) and schedules the files for
 *   destruction after the gym's retention period; consenting again before
 *   then cancels it.
 * - Deleting a photo destroys the file and leaves a tombstone.
 */

export const PHOTO_CONSENT_PURPOSE = 'progress_photos';
/** Bump when the consent text changes; older consent no longer allows uploads. */
export const PHOTO_CONSENT_VERSION = '2.0';
export const PHOTO_CONSENT_TEXT =
  'Shark Fitness stores the progress photos you upload so you can compare them over time. They are private to you unless you share one with your assigned coach. You can delete any photo, or withdraw this consent, at any time; withdrawn photos are hidden from your coach straight away and deleted after the retention period.';
export const PHOTO_RETENTION_DAYS_DEFAULT = 30;

export type PhotoVisibility = 'private' | 'coach';
type PhotoRow = typeof schema.progressPhotos.$inferSelect;

export function photoRetentionDays(tenantId: string): number {
  return Number(policyValue(tenantId, null, 'photoRetentionDaysAfterWithdrawal', PHOTO_RETENTION_DAYS_DEFAULT));
}

export function photoConsent(tenantId: string, userId: string | null) {
  const row = userId
    ? db
        .select()
        .from(schema.consents)
        .where(and(eq(schema.consents.tenantId, tenantId), eq(schema.consents.userId, userId), eq(schema.consents.purpose, PHOTO_CONSENT_PURPOSE)))
        .get()
    : undefined;
  const granted = row?.granted === true;
  return {
    granted,
    version: row?.version ?? null,
    current: granted && row?.version === PHOTO_CONSENT_VERSION,
    currentVersion: PHOTO_CONSENT_VERSION,
    text: PHOTO_CONSENT_TEXT,
  };
}

function ownMember(ctx: RequestContext) {
  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, ctx.memberId ?? ''), eq(schema.members.tenantId, ctx.tenantId)))
    .get();
  if (!member) throw notFound('Your membership');
  return member;
}

function view(photo: PhotoRow, viewerUserId: string, media: typeof schema.mediaObjects.$inferSelect | undefined) {
  const signed = photo.mediaId && media && media.deletedAt === null ? signMediaUrl(photo.mediaId, viewerUserId) : null;
  return {
    id: photo.id,
    takenOn: photo.takenOn,
    pose: photo.pose,
    visibility: photo.visibility as PhotoVisibility,
    createdAt: new Date(photo.createdAt).toISOString(),
    width: media?.width ?? null,
    height: media?.height ?? null,
    url: signed?.url ?? null,
    urlExpiresAt: signed?.expiresAt ?? null,
    deleteAfter: photo.deleteAfter === null ? null : new Date(photo.deleteAfter).toISOString(),
  };
}

function livePhotos(memberId: string): PhotoRow[] {
  return db
    .select()
    .from(schema.progressPhotos)
    .where(and(eq(schema.progressPhotos.memberId, memberId), isNull(schema.progressPhotos.deletedAt), isNotNull(schema.progressPhotos.mediaId)))
    .orderBy(desc(schema.progressPhotos.takenOn), desc(schema.progressPhotos.createdAt))
    .all();
}

function mediaFor(photos: PhotoRow[]) {
  const map = new Map<string, typeof schema.mediaObjects.$inferSelect>();
  for (const photo of photos) {
    if (!photo.mediaId) continue;
    const media = db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, photo.mediaId)).get();
    if (media) map.set(media.id, media);
  }
  return map;
}

/* ——— The member ————————————————————————————————————————————— */

export function listOwnPhotos(ctx: RequestContext) {
  const member = ownMember(ctx);
  const photos = livePhotos(member.id);
  const media = mediaFor(photos);
  return {
    consent: photoConsent(ctx.tenantId, ctx.userId),
    retentionDays: photoRetentionDays(ctx.tenantId),
    items: photos.map((photo) => view(photo, ctx.userId, photo.mediaId ? media.get(photo.mediaId) : undefined)),
  };
}

export function uploadPhoto(
  ctx: RequestContext,
  input: { bytes: Buffer; takenOn: string; pose: string; visibility: PhotoVisibility },
) {
  const member = ownMember(ctx);
  const consent = photoConsent(ctx.tenantId, ctx.userId);
  if (!consent.current) {
    throw precondition(
      consent.granted
        ? 'The photo consent has been updated. Read it and agree again before uploading.'
        : 'Agree to photo storage first. Nothing was uploaded.',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.takenOn)) throw invalid('Choose the date the photo was taken.');

  const { result, removedMetadata } = storeImage({ tenantId: ctx.tenantId, ownerMemberId: member.id, purpose: 'progress_photo', bytes: input.bytes }, (media) => {
    const photoId = id('pph');
    db.insert(schema.progressPhotos)
      .values({
        id: photoId,
        tenantId: ctx.tenantId,
        memberId: member.id,
        takenOn: input.takenOn,
        pose: input.pose,
        storageKey: media.storageKey,
        visibility: input.visibility,
        consentGiven: true,
        pending: false,
        createdAt: media.createdAt,
        deletedAt: null,
        mediaId: media.id,
        consentVersion: PHOTO_CONSENT_VERSION,
        deleteAfter: null,
      })
      .run();
    audit(ctx, {
      action: 'progress_photo.uploaded',
      entityType: 'progress_photo',
      entityId: photoId,
      after: { takenOn: input.takenOn, pose: input.pose, visibility: input.visibility, mediaId: media.id, bytes: media.byteSize },
    });
    return db.select().from(schema.progressPhotos).where(eq(schema.progressPhotos.id, photoId)).get()!;
  });
  const media = db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, result.mediaId!)).get();
  return { photo: view(result, ctx.userId, media), removedMetadata };
}

function loadOwnPhoto(ctx: RequestContext, photoId: string): PhotoRow {
  const member = ownMember(ctx);
  const photo = db
    .select()
    .from(schema.progressPhotos)
    .where(and(eq(schema.progressPhotos.id, photoId), eq(schema.progressPhotos.memberId, member.id), isNull(schema.progressPhotos.deletedAt)))
    .get();
  if (!photo) throw notFound('That photo');
  return photo;
}

export function setPhotoVisibility(ctx: RequestContext, photoId: string, visibility: PhotoVisibility) {
  const photo = loadOwnPhoto(ctx, photoId);
  // Sharing needs the consent the member agreed to be the current one, as an
  // upload does: an outdated version is not agreement to the current terms.
  const consent = photoConsent(ctx.tenantId, ctx.userId);
  if (visibility === 'coach' && !consent.current) {
    throw precondition(
      consent.granted
        ? 'The photo consent has been updated. Read it and agree again before sharing a photo.'
        : 'Photo consent is withdrawn, so photos cannot be shared. Agree to photo storage again first.',
    );
  }
  transact(() => {
    db.update(schema.progressPhotos).set({ visibility }).where(eq(schema.progressPhotos.id, photo.id)).run();
    audit(ctx, { action: 'progress_photo.visibility_changed', entityType: 'progress_photo', entityId: photo.id, before: { visibility: photo.visibility }, after: { visibility } });
  });
  return { id: photo.id, visibility };
}

export function deletePhoto(ctx: RequestContext, photoId: string) {
  const photo = loadOwnPhoto(ctx, photoId);
  transact(() => {
    db.update(schema.progressPhotos).set({ deletedAt: now() }).where(eq(schema.progressPhotos.id, photo.id)).run();
    if (photo.mediaId) destroyMedia(photo.mediaId, 'Deleted by the member');
    audit(ctx, { action: 'progress_photo.deleted', entityType: 'progress_photo', entityId: photo.id, before: { takenOn: photo.takenOn }, after: { deleted: true } });
  });
  unlinkCommitted();
  return { ok: true };
}

/**
 * Called by `PUT /v1/me/consents` when the photo consent changes. Withdrawal
 * schedules every live photo for destruction; consenting again cancels any
 * destruction that has not happened yet. Inside the consent transaction.
 */
export function onPhotoConsentChanged(ctx: RequestContext, granted: boolean): { scheduled: number; cancelled: number } {
  const member = db.select().from(schema.members).where(and(eq(schema.members.userId, ctx.userId), eq(schema.members.tenantId, ctx.tenantId))).get();
  if (!member) return { scheduled: 0, cancelled: 0 };
  const photos = livePhotos(member.id);
  if (!granted) {
    const deleteAfter = now() + photoRetentionDays(ctx.tenantId) * DAY;
    const pending = photos.filter((photo) => photo.deleteAfter === null);
    for (const photo of pending) {
      db.update(schema.progressPhotos).set({ deleteAfter }).where(eq(schema.progressPhotos.id, photo.id)).run();
    }
    if (pending.length > 0) {
      audit(ctx, {
        action: 'progress_photo.deletion_scheduled',
        entityType: 'member',
        entityId: member.id,
        reason: 'Photo consent withdrawn',
        after: { photos: pending.length, deleteAfter: new Date(deleteAfter).toISOString() },
      });
    }
    return { scheduled: pending.length, cancelled: 0 };
  }
  const scheduled = photos.filter((photo) => photo.deleteAfter !== null);
  for (const photo of scheduled) {
    db.update(schema.progressPhotos).set({ deleteAfter: null }).where(eq(schema.progressPhotos.id, photo.id)).run();
  }
  if (scheduled.length > 0) {
    audit(ctx, { action: 'progress_photo.deletion_cancelled', entityType: 'member', entityId: member.id, after: { photos: scheduled.length } });
  }
  return { scheduled: 0, cancelled: scheduled.length };
}

/** Scheduler: destroys photos whose withdrawal period has run out. */
export function purgeWithdrawnPhotos(atMs = now()): { photosDeleted: number } {
  const due = db
    .select()
    .from(schema.progressPhotos)
    .where(and(isNull(schema.progressPhotos.deletedAt), isNotNull(schema.progressPhotos.deleteAfter), lte(schema.progressPhotos.deleteAfter, atMs)))
    .all();
  for (const photo of due) {
    transact(() => {
      db.update(schema.progressPhotos).set({ deletedAt: atMs }).where(eq(schema.progressPhotos.id, photo.id)).run();
      if (photo.mediaId) destroyMedia(photo.mediaId, 'Photo consent withdrawn; retention period ended', atMs);
    });
  }
  unlinkCommitted();
  return { photosDeleted: due.length };
}

/* ——— The coach ————————————————————————————————————————————— */

/** Whether this staff member is the member's assigned coach. */
function isAssignedCoach(ctx: RequestContext, member: { trainerId: string | null }): boolean {
  return ctx.staffId !== null && member.trainerId === ctx.staffId;
}

function sharedWithCoach(photo: PhotoRow, consentGranted: boolean): boolean {
  return photo.visibility === 'coach' && consentGranted && photo.deleteAfter === null && photo.deletedAt === null;
}

export function coachPhotos(ctx: RequestContext, memberId: string) {
  requirePermission(ctx, 'member.view');
  const member = loadMemberInScope(ctx, memberId);
  // A trainer who is not this member's coach does not learn the member exists.
  if (ctx.role === 'trainer' && !isAssignedCoach(ctx, member)) throw notFound('That member');
  if (!isAssignedCoach(ctx, member)) {
    return {
      access: 'not_assigned' as const,
      message: 'Progress photos are shared only with the member’s assigned coach.',
      items: [],
    };
  }
  const consent = photoConsent(ctx.tenantId, member.userId);
  const photos = livePhotos(member.id).filter((photo) => sharedWithCoach(photo, consent.granted));
  const media = mediaFor(photos);
  return {
    access: 'coach' as const,
    message: photos.length === 0 ? 'The member has not shared any progress photos with you.' : null,
    items: photos.map((photo) => view(photo, ctx.userId, photo.mediaId ? media.get(photo.mediaId) : undefined)),
  };
}

/**
 * The file-serving check: may this signed-in viewer see this media right
 * now? Answers false rather than throwing, so the caller can say 404 either
 * way.
 */
export function mayViewMedia(ctx: RequestContext, mediaId: string): boolean {
  const photo = db
    .select()
    .from(schema.progressPhotos)
    .where(and(eq(schema.progressPhotos.mediaId, mediaId), eq(schema.progressPhotos.tenantId, ctx.tenantId)))
    .get();
  if (!photo || photo.deletedAt !== null) return false;
  const member = db.select().from(schema.members).where(eq(schema.members.id, photo.memberId)).get();
  if (!member) return false;
  if (ctx.memberId === member.id) return true;
  if (!isAssignedCoach(ctx, member)) return false;
  return sharedWithCoach(photo, photoConsent(ctx.tenantId, member.userId).granted);
}

/** Erasure: every photo of this member is destroyed. Inside the caller's
 *  transaction. Returns how many were destroyed. */
export function erasePhotosOf(memberId: string, atMs = now()): number {
  const photos = livePhotos(memberId);
  for (const photo of photos) {
    db.update(schema.progressPhotos).set({ deletedAt: atMs }).where(eq(schema.progressPhotos.id, photo.id)).run();
    if (photo.mediaId) destroyMedia(photo.mediaId, 'Erased on a privacy request', atMs);
  }
  return photos.length;
}

/** For the privacy export: what is held, without the bytes. */
export function photosForExport(memberId: string) {
  return db
    .select()
    .from(schema.progressPhotos)
    .where(eq(schema.progressPhotos.memberId, memberId))
    .all()
    .map((photo) => {
      const media = photo.mediaId ? db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, photo.mediaId)).get() : undefined;
      return {
        id: photo.id,
        takenOn: photo.takenOn,
        pose: photo.pose,
        visibility: photo.visibility,
        uploadedAt: new Date(photo.createdAt).toISOString(),
        consentVersion: photo.consentVersion,
        deletedAt: photo.deletedAt === null ? null : new Date(photo.deletedAt).toISOString(),
        file: media ? { contentType: media.contentType, bytes: media.byteSize, width: media.width, height: media.height, sha256: media.sha256 } : null,
        note: photo.deletedAt === null ? 'The image itself is available from the member app or on request to the privacy contact.' : 'Deleted; only this record remains.',
      };
    });
}
