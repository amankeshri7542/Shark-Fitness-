import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { app, PROTECTED_API_IP_MAX } from '../app.js';
import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import {
  RATE_LIMIT_MAX_IDENTITIES,
  clientIpFromAddresses,
  errorHandler,
  rateLimit,
  rateLimitBucketCountForTest,
  resetRateLimitsForTest,
} from '../middleware/index.js';

interface Session {
  cookie: string;
  csrfToken: string;
}

async function signIn(email: string, tenantSlug = 'shark'): Promise<Session> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
      'x-forwarded-for': '203.0.113.30',
    },
    body: JSON.stringify({ tenantSlug, email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  return {
    cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`,
    csrfToken: body.csrfToken,
  };
}

function exportReport(session: Session) {
  return app.request('/v1/admin/reports/export', {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      origin: 'http://localhost:5173',
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.30',
    },
    body: JSON.stringify({ kind: 'revenue', from: '2026-08-01', to: '2026-08-18' }),
  });
}

beforeEach(() => resetRateLimitsForTest());
afterEach(() => resetRateLimitsForTest());

describe('HTTP rate limiting', () => {
  it('ignores forwarded headers unless a trusted proxy hop is configured', () => {
    expect(clientIpFromAddresses('198.51.100.20', '203.0.113.9, 198.51.100.8', 0)).toBe('198.51.100.20');
    expect(clientIpFromAddresses('198.51.100.20', '203.0.113.9, 198.51.100.8', 1)).toBe('198.51.100.8');
    expect(clientIpFromAddresses('198.51.100.20', '203.0.113.9, 198.51.100.8', 2)).toBe('203.0.113.9');
    expect(clientIpFromAddresses('198.51.100.20', 'not-an-ip', 1)).toBe('198.51.100.20');
    expect(clientIpFromAddresses('198.51.100.20', '203.0.113.9', 2)).toBe('198.51.100.20');
  });

  it('limits invalid protected-route tokens before session resolution and ignores spoofed forwarding headers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (let attempt = 0; attempt < PROTECTED_API_IP_MAX; attempt += 1) {
        const response = await app.request('/v1/me', {
          headers: {
            authorization: `Bearer invalid-${attempt}`,
            'x-forwarded-for': `198.51.${Math.floor(attempt / 256)}.${attempt % 256}`,
          },
        });
        expect(response.status).toBe(401);
      }

      const limited = await app.request('/v1/me', {
        headers: { authorization: 'Bearer invalid-last', 'x-forwarded-for': '192.0.2.99' },
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    } finally {
      log.mockRestore();
    }
  });

  it('returns 429 with Retry-After while isolating the same IP by authenticated actor and tenant', async () => {
    const owner = await signIn('owner@sharkfitness.in');
    const accountant = await signIn('accounts@sharkfitness.in');
    const reefOwner = await signIn('owner@reefathletic.in', 'reef');

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await exportReport(owner)).status).toBe(200);
    }

    const limited = await exportReport(owner);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    const body = (await limited.json()) as { error: { code: string; retryAfterSec: number } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryAfterSec).toBeGreaterThan(0);

    // Same network address, but neither a different actor in the tenant nor
    // an actor in another tenant inherits the exhausted owner's bucket.
    expect((await exportReport(accountant)).status).toBe(200);
    expect((await exportReport(reefOwner)).status).toBe(200);
  });

  it('keeps attacker-controlled identity cardinality within a fixed memory bound', async () => {
    const probe = new Hono();
    probe.onError(errorHandler);
    probe.use('*', rateLimit(1, 60_000, { trustedProxyHops: 1 }));
    probe.get('/probe', (c) => c.json({ ok: true }));

    for (let index = 0; index < RATE_LIMIT_MAX_IDENTITIES; index += 1) {
      const response = await probe.request('/probe', {
        headers: { 'x-forwarded-for': `198.51.${Math.floor(index / 256)}.${index % 256}` },
      });
      expect(response.status).toBe(200);
    }
    expect(rateLimitBucketCountForTest()).toBe(RATE_LIMIT_MAX_IDENTITIES);

    // New identities share one fixed overflow bucket once the bound is full;
    // no untrusted header can make the Map grow further.
    expect((await probe.request('/probe', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status).toBe(200);
    expect((await probe.request('/probe', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status).toBe(429);
    expect(rateLimitBucketCountForTest()).toBe(RATE_LIMIT_MAX_IDENTITIES);
  });

  it('periodically releases expired identity buckets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      const probe = new Hono();
      probe.onError(errorHandler);
      probe.use('*', rateLimit(1, 1_000, { trustedProxyHops: 1 }));
      probe.get('/probe', (c) => c.json({ ok: true }));

      for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
        expect((await probe.request('/probe', { headers: { 'x-forwarded-for': ip } })).status).toBe(200);
      }
      expect(rateLimitBucketCountForTest()).toBe(3);

      vi.advanceTimersByTime(1_001);
      for (let request = 0; request < 125; request += 1) {
        await probe.request('/probe', { headers: { 'x-forwarded-for': '198.51.100.1' } });
      }

      // The 128th request through this limiter runs the sweep. The three stale
      // identities are gone; only the current window remains.
      expect(rateLimitBucketCountForTest()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies dedicated budgets to door scans and manual automation runs', async () => {
    const scanRequest = () => app.request('/v1/door/scan', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.88',
        'x-reader-id': 'unknown-reader',
        'x-reader-key': 'invalid-reader-key',
      },
      body: JSON.stringify({ token: 'x'.repeat(32), branchId: 'br_kor' }),
    });

    for (let attempt = 0; attempt < 120; attempt += 1) {
      expect((await scanRequest()).status).toBe(401);
    }
    const limitedScan = await scanRequest();
    expect(limitedScan.status).toBe(429);
    expect(limitedScan.headers.get('retry-after')).toMatch(/^\d+$/);

    const owner = await signIn('owner@sharkfitness.in');
    const automationId = db
      .select({ id: schema.automations.id })
      .from(schema.automations)
      .where(eq(schema.automations.name, 'Renewal nudge'))
      .get()!.id;
    const manualRun = () => app.request(`/v1/admin/automations/${automationId}/run`, {
      method: 'POST',
      headers: {
        cookie: owner.cookie,
        origin: 'http://localhost:5173',
        'x-csrf-token': owner.csrfToken,
        'x-forwarded-for': '198.51.100.88',
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await manualRun()).status).toBe(200);
    }
    const limitedRun = await manualRun();
    expect(limitedRun.status).toBe(429);
    expect(limitedRun.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it('treats inherited object property names as unknown reader ids', async () => {
    const response = await app.request('/v1/door/scan', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-reader-id': 'toString',
        'x-reader-key': 'irrelevant',
      },
      body: JSON.stringify({ token: 'x'.repeat(32), branchId: 'br_kor' }),
    });

    expect(response.status).toBe(401);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});
