import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { now } from '../lib/time.js';
import { signMediaUrl } from '../services/media.js';
import { purgeWithdrawnPhotos } from '../services/progress-photos.js';
import { JPEG_WITH_GPS, PNG_WITH_TEXT } from './fixtures/images.js';
import { ORIGIN, TENANT, createMember, get, headers, send, signIn, signInMember, type FixtureMember, type Session } from './support/fixtures.js';

/**
 * Private media and progress photos (P05; PF-PROG-004/006; PRD 04 privacy).
 * Uploads go through the real multipart route into the real media directory
 * (`data/test/media` beside the test database), and files come back only
 * through `GET /v1/files/:id` with a signed URL.
 */

let owner: Session;
let coach: Session;
let otherCoach: Session;
let coachStaffId: string;

beforeAll(async () => {
  owner = await signIn('owner@sharkfitness.in');
  coach = await signIn('rehan@sharkfitness.in');
  otherCoach = await signIn('nikhil@sharkfitness.in');
  const rehan = db.select().from(schema.users).where(eq(schema.users.email, 'rehan@sharkfitness.in')).get()!;
  coachStaffId = db.select().from(schema.staff).where(eq(schema.staff.userId, rehan.id)).get()!.id;
});

interface PhotoView {
  id: string;
  url: string | null;
  visibility: string;
  deleteAfter: string | null;
  takenOn: string;
}

async function memberWithConsent(label: string, consent = true): Promise<FixtureMember & { session: Session }> {
  const member = createMember({ withLogin: true, firstName: label });
  db.update(schema.members).set({ trainerId: coachStaffId }).where(eq(schema.members.id, member.memberId)).run();
  const session = await signInMember(member);
  if (consent) {
    const granted = await send(session, 'PUT', '/v1/me/consents', { purpose: 'progress_photos', granted: true });
    expect(granted.status).toBe(200);
  }
  return { ...member, session };
}

function upload(session: Session, file: Blob, fields: Record<string, string> = {}, name = 'photo.jpg') {
  const form = new FormData();
  form.set('file', file, name);
  form.set('purpose', fields.purpose ?? 'progress_photo');
  form.set('takenOn', fields.takenOn ?? '2026-11-20');
  form.set('pose', fields.pose ?? 'front');
  form.set('visibility', fields.visibility ?? 'private');
  return app.request('/v1/member/media/uploads', { method: 'POST', headers: headers(session), body: form });
}

async function uploaded(session: Session, visibility = 'private', bytes = JPEG_WITH_GPS): Promise<PhotoView> {
  const response = await upload(session, new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), { visibility });
  expect(response.status).toBe(201);
  return ((await response.json()) as { photo: PhotoView }).photo;
}

const fetchFile = (session: Session | null, url: string) =>
  app.request(url, { headers: session ? headers(session) : { origin: ORIGIN } });

function mediaOf(photoId: string) {
  const photo = db.select().from(schema.progressPhotos).where(eq(schema.progressPhotos.id, photoId)).get()!;
  return db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, photo.mediaId!)).get()!;
}

const filePath = (storageKey: string) => join(runtimeConfig.mediaDir!, storageKey);

async function coachList(session: Session, memberId: string) {
  const response = await get(session, `/v1/admin/members/${memberId}/progress-photos`);
  return { status: response.status, body: (await response.json()) as { access?: string; items: PhotoView[] } };
}

describe('uploads', () => {
  it('stores a JPEG without its EXIF/GPS, and hands it back only through a signed URL', async () => {
    const member = await memberWithConsent('Exif');
    const photo = await uploaded(member.session);
    const media = mediaOf(photo.id);
    expect(media).toMatchObject({ contentType: 'image/jpeg', width: 64, height: 48, ownerMemberId: member.memberId, deletedAt: null });

    const onDisk = readFileSync(filePath(media.storageKey));
    expect(onDisk.includes(Buffer.from('Exif'))).toBe(false);
    expect(onDisk.includes(Buffer.from('TestCam'))).toBe(false);
    // Outside the API's static roots, and not under the repository's web builds.
    expect(filePath(media.storageKey)).not.toMatch(/\/dist\//);

    expect(photo.url).toMatch(/^\/v1\/files\/med_[a-z0-9]+\?v=.+&exp=\d+&sig=/);
    const served = await fetchFile(member.session, photo.url!);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(served.headers.get('cache-control')).toBe('private, no-store');
    const body = Buffer.from(await served.arrayBuffer());
    expect(body.equals(onDisk)).toBe(true);
    expect(body.includes(Buffer.from('Exif'))).toBe(false);
  });

  it('strips PNG text chunks too', async () => {
    const member = await memberWithConsent('Png');
    const photo = await uploaded(member.session, 'private', PNG_WITH_TEXT);
    const onDisk = readFileSync(filePath(mediaOf(photo.id).storageKey));
    expect(onDisk.includes(Buffer.from('Someone Private'))).toBe(false);
  });

  it('refuses a file over 10 MB with 413', async () => {
    const member = await memberWithConsent('Big');
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    JPEG_WITH_GPS.copy(big, 0, 0, 4);
    const response = await upload(member.session, new Blob([new Uint8Array(big)], { type: 'image/jpeg' }));
    expect(response.status).toBe(413);
  });

  it('refuses a script dressed as a JPEG with 422', async () => {
    const member = await memberWithConsent('Spoof');
    const response = await upload(member.session, new Blob(['<script>alert(1)</script>'], { type: 'image/jpeg' }), {}, 'holiday.jpg');
    expect(response.status).toBe(422);
    expect(db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.ownerMemberId, member.memberId)).all()).toHaveLength(0);
  });

  it('refuses an upload without photo consent, and stores nothing', async () => {
    const member = await memberWithConsent('NoConsent', false);
    const response = await upload(member.session, new Blob([new Uint8Array(JPEG_WITH_GPS)], { type: 'image/jpeg' }));
    expect(response.status).toBe(412);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('Agree to photo storage first');
  });

  it('records the consent version on the photo', async () => {
    const member = await memberWithConsent('Version');
    const photo = await uploaded(member.session);
    const row = db.select().from(schema.progressPhotos).where(eq(schema.progressPhotos.id, photo.id)).get()!;
    expect(row.consentVersion).toBe('2.0');
    const consent = db.select().from(schema.consents).where(and(eq(schema.consents.userId, member.userId!), eq(schema.consents.purpose, 'progress_photos'))).get()!;
    expect(consent).toMatchObject({ granted: true, version: '2.0' });
  });

  it('enforces the gym storage quota', async () => {
    const member = await memberWithConsent('Quota');
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, TENANT)).get()!;
    db.update(schema.tenants).set({ quotas: { ...tenant.quotas, storageMb: 0 } }).where(eq(schema.tenants.id, TENANT)).run();
    try {
      const response = await upload(member.session, new Blob([new Uint8Array(JPEG_WITH_GPS)], { type: 'image/jpeg' }));
      expect(response.status).toBe(429);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED');
    } finally {
      db.update(schema.tenants).set({ quotas: tenant.quotas }).where(eq(schema.tenants.id, TENANT)).run();
    }
  });
});

describe('signed URLs', () => {
  it('an expired URL is 403; a tampered one is 403', async () => {
    const member = await memberWithConsent('Expired');
    const photo = await uploaded(member.session);
    const mediaId = mediaOf(photo.id).id;
    const stale = signMediaUrl(mediaId, member.userId!, now() - 6 * 60_000);
    expect((await fetchFile(member.session, stale.url)).status).toBe(403);
    expect((await fetchFile(member.session, photo.url!.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
  });

  it("another member cannot use or obtain a member's photo URL: 404", async () => {
    const owner_ = await memberWithConsent('Owner');
    const other = await memberWithConsent('Other');
    const photo = await uploaded(owner_.session);
    const mediaId = mediaOf(photo.id).id;
    // Someone else's link, used from another account.
    expect((await fetchFile(other.session, photo.url!)).status).toBe(404);
    // A validly signed link for the other member to a file that is not theirs.
    expect((await fetchFile(other.session, signMediaUrl(mediaId, other.userId!).url)).status).toBe(404);
    // And the photo is not in their list, nor can they change it.
    const list = (await (await get(other.session, '/v1/member/progress/photos')).json()) as { items: PhotoView[] };
    expect(list.items.some((p) => p.id === photo.id)).toBe(false);
    expect((await send(other.session, 'DELETE', `/v1/member/progress/photos/${photo.id}`)).status).toBe(404);
  });

  it('a signed-out request is refused', async () => {
    const member = await memberWithConsent('Anon');
    const photo = await uploaded(member.session);
    expect((await fetchFile(null, photo.url!)).status).toBe(401);
  });
});

describe('coach access', () => {
  it('the assigned coach sees "my coach" photos only; private photos stay private', async () => {
    const member = await memberWithConsent('Coach');
    const shared = await uploaded(member.session, 'coach');
    const hidden = await uploaded(member.session, 'private');

    const list = await coachList(coach, member.memberId);
    expect(list.status).toBe(200);
    expect(list.body.items.map((p) => p.id)).toEqual([shared.id]);
    expect((await fetchFile(coach, list.body.items[0]!.url!)).status).toBe(200);

    const coachUserId = db.select().from(schema.users).where(eq(schema.users.email, 'rehan@sharkfitness.in')).get()!.id;
    expect((await fetchFile(coach, signMediaUrl(mediaOf(hidden.id).id, coachUserId).url)).status).toBe(404);

    // Made private again: the coach's existing link stops working at once.
    const coachUrl = list.body.items[0]!.url!;
    expect((await send(member.session, 'PATCH', `/v1/member/progress/photos/${shared.id}`, { visibility: 'private' })).status).toBe(200);
    expect((await fetchFile(coach, coachUrl)).status).toBe(404);
    expect((await coachList(coach, member.memberId)).body.items).toHaveLength(0);
  });

  it('a trainer who is not the assigned coach cannot see the member at all; an owner sees no photos', async () => {
    const member = await memberWithConsent('Unassigned');
    const shared = await uploaded(member.session, 'coach');
    expect((await coachList(otherCoach, member.memberId)).status).toBe(404);
    const ownerView = await coachList(owner, member.memberId);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body).toMatchObject({ access: 'not_assigned', items: [] });
    const ownerUserId = db.select().from(schema.users).where(eq(schema.users.email, 'owner@sharkfitness.in')).get()!.id;
    expect((await fetchFile(owner, signMediaUrl(mediaOf(shared.id).id, ownerUserId).url)).status).toBe(404);
  });

  it('withdrawing consent hides photos from the coach immediately and deletes them after the retention period', async () => {
    const member = await memberWithConsent('Withdraw');
    const shared = await uploaded(member.session, 'coach');
    const coachUrl = (await coachList(coach, member.memberId)).body.items[0]!.url!;
    expect((await fetchFile(coach, coachUrl)).status).toBe(200);

    const withdrawn = await send(member.session, 'PUT', '/v1/me/consents', { purpose: 'progress_photos', granted: false });
    expect(withdrawn.status).toBe(200);
    expect(((await withdrawn.json()) as { photos: { scheduled: number } }).photos.scheduled).toBe(1);

    expect((await fetchFile(coach, coachUrl)).status).toBe(404);
    expect((await coachList(coach, member.memberId)).body.items).toHaveLength(0);
    // The member still sees their own photo, marked for deletion.
    const own = (await (await get(member.session, '/v1/member/progress/photos')).json()) as { items: PhotoView[]; retentionDays: number };
    expect(own.items[0]!.deleteAfter).not.toBeNull();

    const media = mediaOf(shared.id);
    expect(existsSync(filePath(media.storageKey))).toBe(true);
    purgeWithdrawnPhotos(now() + (own.retentionDays + 1) * 86_400_000);
    expect(existsSync(filePath(media.storageKey))).toBe(false);
    const tombstone = db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id)).get()!;
    expect(tombstone.deletedAt).not.toBeNull();
    expect(tombstone.deletedReason).toContain('consent withdrawn');
    expect(tombstone.sha256).toBe(media.sha256);
  });

  it('consenting again before the retention period ends cancels the deletion', async () => {
    const member = await memberWithConsent('Regrant');
    const photo = await uploaded(member.session, 'coach');
    await send(member.session, 'PUT', '/v1/me/consents', { purpose: 'progress_photos', granted: false });
    await send(member.session, 'PUT', '/v1/me/consents', { purpose: 'progress_photos', granted: true });
    expect(db.select().from(schema.progressPhotos).where(eq(schema.progressPhotos.id, photo.id)).get()!.deleteAfter).toBeNull();
    expect((await coachList(coach, member.memberId)).body.items).toHaveLength(1);
  });
});

describe('deletion and export', () => {
  it('deleting a photo destroys the file and keeps a tombstone', async () => {
    const member = await memberWithConsent('Delete');
    const photo = await uploaded(member.session);
    const media = mediaOf(photo.id);
    expect((await send(member.session, 'DELETE', `/v1/member/progress/photos/${photo.id}`)).status).toBe(200);
    expect(existsSync(filePath(media.storageKey))).toBe(false);
    expect(db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id)).get()).toMatchObject({ deletedReason: 'Deleted by the member' });
    expect((await fetchFile(member.session, photo.url!)).status).toBe(404);
    const audit = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, photo.id), eq(schema.auditLog.action, 'progress_photo.deleted'))).get();
    expect(audit).toBeTruthy();
  });

  it('the privacy export lists the member’s photos, deleted ones included, without the images', async () => {
    const member = await memberWithConsent('Export');
    const kept = await uploaded(member.session);
    const gone = await uploaded(member.session);
    await send(member.session, 'DELETE', `/v1/member/progress/photos/${gone.id}`);

    const requested = await send(
      owner,
      'POST',
      '/v1/admin/privacy/requests',
      { subjectUserId: member.userId, kind: 'export', reason: 'Member asked for a copy of their data.' },
      { 'idempotency-key': `export-${member.memberId}` },
    );
    expect(requested.status).toBe(201);
    const { requestId } = (await requested.json()) as { requestId: string };
    const artifactResponse = await send(owner, 'POST', `/v1/admin/privacy/requests/${requestId}/export`, undefined, { 'idempotency-key': `export-run-${member.memberId}` });
    expect(artifactResponse.status).toBe(201);
    const artifact = db.select().from(schema.privacyArtifacts).where(eq(schema.privacyArtifacts.requestId, requestId)).get()!;
    const photos = (artifact.payload as { progressPhotos: Array<{ id: string; deletedAt: string | null; file: { sha256: string } | null }> }).progressPhotos;
    expect(photos.map((p) => p.id).sort()).toEqual([kept.id, gone.id].sort());
    expect(photos.find((p) => p.id === gone.id)!.deletedAt).not.toBeNull();
    expect(JSON.stringify(photos)).not.toContain('storageKey');
  });
});
