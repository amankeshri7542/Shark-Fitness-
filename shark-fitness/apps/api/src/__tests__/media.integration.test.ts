import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';

/**
 * Member library. The tenant has no video allowance, so the interesting
 * behaviour is how honestly the API degrades rather than how it streams.
 */
interface Session { cookie: string; csrfToken: string }
const cache = new Map<string, Session>();

async function signIn(email: string): Promise<Session> {
  const cached = cache.get(email);
  if (cached) return cached;
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  const session = { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrfToken: body.csrfToken };
  cache.set(email, session);
  return session;
}

const MEMBER = 'aman@sharkfitness.in';

function headers(session: Session, unsafe = false): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: 'http://localhost:5173',
    ...(unsafe ? { 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } : {}),
  };
}

interface Asset {
  id: string;
  playable: boolean;
  playbackUrl: string | null;
  blockedReason: string | null;
  blockedMessage: string | null;
  favourite: boolean;
  progressPct: number;
}

describe('Member library', () => {
  it('lists the catalogue and explains why nothing plays', async () => {
    const session = await signIn(MEMBER);
    const response = await app.request('/v1/member/media', { headers: headers(session) });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      streaming: { enabled: boolean; limitMinutes: number; message: string | null };
      items: Asset[];
      categories: Array<{ value: string }>;
    };

    // The seed provisions a zero video allowance on purpose.
    expect(body.streaming.enabled).toBe(false);
    expect(body.streaming.limitMinutes).toBe(0);
    expect(body.streaming.message).toBeTruthy();
    expect(body.items.length).toBeGreaterThan(0);

    // Nothing claims to be playable, and every refusal carries a sentence.
    for (const asset of body.items) {
      expect(asset.playable).toBe(false);
      expect(asset.playbackUrl).toBeNull();
      expect(asset.blockedReason).not.toBeNull();
      expect(asset.blockedMessage).toBeTruthy();
    }
    expect(body.categories[0]?.value).toBe('all');
  });

  it('never leaks a playback URL for an asset outside the member’s plan', async () => {
    const session = await signIn(MEMBER);

    // Give one asset a real source and a plan requirement nobody holds.
    const asset = db.select().from(schema.mediaAssets).get()!;
    db.update(schema.mediaAssets)
      .set({ playbackUrl: 'https://cdn.example.test/secret.m3u8', requiredProductKinds: ['nonexistent_kind'] })
      .where(eq(schema.mediaAssets.id, asset.id))
      .run();

    const response = await app.request(`/v1/member/media/${asset.id}`, { headers: headers(session) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { asset: Asset };

    expect(body.asset.blockedReason).toBe('not_in_plan');
    expect(body.asset.playable).toBe(false);
    expect(body.asset.playbackUrl).toBeNull();
    expect(JSON.stringify(body)).not.toContain('secret.m3u8');

    db.update(schema.mediaAssets)
      .set({ playbackUrl: null, requiredProductKinds: [] })
      .where(eq(schema.mediaAssets.id, asset.id))
      .run();
  });

  it('saves progress once per asset instead of appending a row per seek', async () => {
    const session = await signIn(MEMBER);
    const asset = db.select().from(schema.mediaAssets).get()!;

    for (const positionSec of [30, 90, 150]) {
      const response = await app.request(`/v1/member/media/${asset.id}/progress`, {
        method: 'POST',
        headers: headers(session, true),
        body: JSON.stringify({ positionSec, favourite: true }),
      });
      expect(response.status).toBe(200);
    }

    const rows = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.mediaProgress)
      .where(eq(schema.mediaProgress.assetId, asset.id))
      .get();
    expect(rows?.n).toBe(1);

    const stored = db.select().from(schema.mediaProgress).where(eq(schema.mediaProgress.assetId, asset.id)).get();
    expect(stored?.positionSec).toBe(150);
    expect(stored?.favourite).toBe(true);

    // A saved asset comes back through the favourites filter.
    const listed = await app.request('/v1/member/media?favourites=true', { headers: headers(session) });
    const body = (await listed.json()) as { items: Asset[] };
    expect(body.items.some((a) => a.id === asset.id && a.favourite)).toBe(true);
  });

  it('clamps a position past the end of the asset', async () => {
    const session = await signIn(MEMBER);
    const asset = db.select().from(schema.mediaAssets).get()!;

    const response = await app.request(`/v1/member/media/${asset.id}/progress`, {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify({ positionSec: asset.durationSec + 10_000 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { progress: { positionSec: number; progressPct: number } };
    expect(body.progress.positionSec).toBe(asset.durationSec);
    expect(body.progress.progressPct).toBe(100);
  });

  it('returns 404 for an asset that does not exist', async () => {
    const session = await signIn(MEMBER);
    const response = await app.request('/v1/member/media/med_does_not_exist', { headers: headers(session) });
    expect(response.status).toBe(404);
  });

  it('refuses an unauthenticated request', async () => {
    const response = await app.request('/v1/member/media', { headers: { origin: 'http://localhost:5173' } });
    expect(response.status).toBe(401);
  });

  it('hides an unpublished or expired asset', async () => {
    const session = await signIn(MEMBER);
    const asset = db.select().from(schema.mediaAssets).get()!;

    db.update(schema.mediaAssets)
      .set({ expiresAt: Date.now() - 1_000 })
      .where(eq(schema.mediaAssets.id, asset.id))
      .run();

    const response = await app.request('/v1/member/media', { headers: headers(session) });
    const body = (await response.json()) as { items: Asset[] };
    expect(body.items.some((a) => a.id === asset.id)).toBe(false);

    db.update(schema.mediaAssets)
      .set({ expiresAt: null })
      .where(eq(schema.mediaAssets.id, asset.id))
      .run();
  });
});
