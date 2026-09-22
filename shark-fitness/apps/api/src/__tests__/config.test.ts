import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from '../lib/config.js';

const STRONG_SECRET = 'A9!production-pass-secret-with-more-than-48-bytes!';

function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    SHARK_DB: '/var/lib/shark/shark.db',
    SHARK_PASS_SECRET: STRONG_SECRET,
    SHARK_PUBLIC_ORIGIN: 'https://fitness.example',
    ...overrides,
  };
}

describe('runtime configuration', () => {
  it('uses safe development defaults', () => {
    const config = parseRuntimeConfig({});

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(8787);
    expect(config.databasePath).toBe('data/shark.db');
    expect(config.serveStatic).toBe(false);
    expect(config.disableJobs).toBe(false);
    expect(config.echoOtp).toBe(false);
    expect(config.allowBearerAuth).toBe(false);
    expect(config.trustedProxyHops).toBe(0);
    expect(config.allowedOrigins).toContain('http://localhost:5173');
  });

  it('parses false as false instead of using JavaScript truthiness', () => {
    const config = parseRuntimeConfig({
      SHARK_SERVE_STATIC: 'false',
      SHARK_DISABLE_JOBS: 'false',
      SHARK_ECHO_OTP: 'false',
      SHARK_ALLOW_BEARER_AUTH: 'false',
    });

    expect(config.serveStatic).toBe(false);
    expect(config.disableJobs).toBe(false);
    expect(config.echoOtp).toBe(false);
    expect(config.allowBearerAuth).toBe(false);
  });

  it('parses the scheduler switch through the same exact boolean boundary', () => {
    expect(parseRuntimeConfig({ SHARK_DISABLE_JOBS: 'true' }).disableJobs).toBe(true);
    expect(() => parseRuntimeConfig({ SHARK_DISABLE_JOBS: '1' })).toThrow(/SHARK_DISABLE_JOBS/);
  });

  it('accepts only an explicit bounded trusted-proxy hop count', () => {
    expect(parseRuntimeConfig({ SHARK_TRUST_PROXY_HOPS: '1' }).trustedProxyHops).toBe(1);
    for (const value of ['-1', '1.5', '6', 'yes', ' 1']) {
      expect(() => parseRuntimeConfig({ SHARK_TRUST_PROXY_HOPS: value })).toThrow(/SHARK_TRUST_PROXY_HOPS/);
    }
  });

  it('rejects media bucket configuration until an upload provider exists', () => {
    expect(() => parseRuntimeConfig({ SHARK_MEDIA_BUCKET: 'photos-production' })).toThrow(/SHARK_MEDIA_BUCKET/);
    expect(parseRuntimeConfig({ SHARK_MEDIA_BUCKET: '' }).mediaBucket).toBeNull();
  });

  it.each(['TRUE', '1', 'yes', ' false '])('rejects the ambiguous boolean %j', (value) => {
    expect(() => parseRuntimeConfig({ SHARK_SERVE_STATIC: value })).toThrow(/SHARK_SERVE_STATIC/);
  });

  it.each(['0', '65536', '1.5', 'eighty', ' 8787'])('rejects the invalid port %j', (port) => {
    expect(() => parseRuntimeConfig({ PORT: port })).toThrow(/PORT/);
  });

  it('parses and validates reader JSON at boot', () => {
    const config = parseRuntimeConfig({
      SHARK_READER_KEYS_JSON: JSON.stringify({
        'front-door': { key: 'reader-secret-at-least-16', tenantSlug: 'shark', branchSlugs: ['koramangala'] },
      }),
    });

    expect(config.readerKeys['front-door']).toEqual({
      key: 'reader-secret-at-least-16',
      tenantSlug: 'shark',
      branchSlugs: ['koramangala'],
    });
  });

  it('requires stronger physical-reader credentials in production', () => {
    expect(() => parseRuntimeConfig(productionEnv({
      SHARK_READER_KEYS_JSON: JSON.stringify({
        door: { key: 'only-sixteen-byte-key', tenantSlug: 'shark', branchSlugs: ['koramangala'] },
      }),
    }))).toThrow(/Production reader keys/);
    expect(parseRuntimeConfig(productionEnv({
      SHARK_READER_KEYS_JSON: JSON.stringify({
        door: { key: 'reader-key-with-at-least-thirty-two-random-bytes', tenantSlug: 'shark', branchSlugs: ['koramangala'] },
      }),
    })).readerKeys.door).toBeTruthy();
  });

  it.each([
    ['not JSON', '{'],
    ['the wrong shape', '[]'],
    ['an invalid reader', '{"reader":{"key":"short","branchSlugs":[]}}'],
    ['a reader without a tenant', '{"reader":{"key":"reader-secret-at-least-16","branchSlugs":["koramangala"]}}'],
    ['a production wildcard tenant', '{"reader":{"key":"reader-secret-at-least-16","tenantSlug":"*","branchSlugs":["koramangala"]}}'],
  ])('rejects %s in SHARK_READER_KEYS_JSON', (_case, value) => {
    expect(() => parseRuntimeConfig({ SHARK_READER_KEYS_JSON: value })).toThrow(/SHARK_READER_KEYS_JSON/);
  });

  it('normalizes exact configured origins and removes duplicates', () => {
    const config = parseRuntimeConfig({
      SHARK_PUBLIC_ORIGIN: 'https://fitness.example/',
      SHARK_ALLOWED_ORIGINS: 'https://admin.example,https://fitness.example',
      RENDER_EXTERNAL_URL: 'https://render.example/',
    });

    expect(config.allowedOrigins).toEqual(expect.arrayContaining([
      'https://fitness.example',
      'https://admin.example',
      'https://render.example',
    ]));
    expect(config.allowedOrigins.filter((origin) => origin === 'https://fitness.example')).toHaveLength(1);
  });

  it('accepts an error collector URL with a path and rejects embedded credentials', () => {
    expect(parseRuntimeConfig({ SHARK_ERROR_REPORTING_ENDPOINT: 'https://errors.example/v1/envelopes' }).errorReportingEndpoint)
      .toBe('https://errors.example/v1/envelopes');
    expect(() => parseRuntimeConfig({ SHARK_ERROR_REPORTING_ENDPOINT: 'https://user:secret@errors.example/v1' }))
      .toThrow(/SHARK_ERROR_REPORTING_ENDPOINT/);
  });

  it('parses bounded operational retention and pruning settings once', () => {
    const config = parseRuntimeConfig({
      SHARK_IDEMPOTENCY_RETENTION_DAYS: '45',
      SHARK_OUTBOX_RETENTION_DAYS: '14',
      SHARK_OTP_RETENTION_HOURS: '48',
      SHARK_PRUNE_BATCH_SIZE: '250',
      SHARK_PRUNE_MAX_BATCHES: '4',
    });
    expect(config.retention.idempotencyKeysMs).toBe(45 * 86_400_000);
    expect(config.retention.outboxEventsMs).toBe(14 * 86_400_000);
    expect(config.retention.otpChallengesMs).toBe(48 * 3_600_000);
    expect(config.pruning).toEqual({ batchSize: 250, maxBatches: 4 });
  });

  it('accepts an explicit build identifier before platform-specific fallbacks', () => {
    expect(parseRuntimeConfig({
      SHARK_RELEASE: 'image-sha-abc123',
      RENDER_GIT_COMMIT: 'render-sha',
      GITHUB_SHA: 'github-sha',
    }).release).toBe('image-sha-abc123');
  });

  it.each([
    ['SHARK_IDEMPOTENCY_RETENTION_DAYS', '6'],
    ['SHARK_OUTBOX_RETENTION_DAYS', '1'],
    ['SHARK_PRUNE_BATCH_SIZE', '1001'],
    ['SHARK_PRUNE_MAX_BATCHES', '0'],
  ])('rejects unsafe maintenance setting %s=%s', (name, value) => {
    expect(() => parseRuntimeConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it.each([
    ['a path', 'https://fitness.example/admin'],
    ['credentials', 'https://user:pass@fitness.example'],
    ['a non-HTTP scheme', 'ftp://fitness.example'],
    ['an empty list item', 'https://one.example,,https://two.example'],
  ])('rejects an origin containing %s', (_case, origin) => {
    expect(() => parseRuntimeConfig({ SHARK_ALLOWED_ORIGINS: origin })).toThrow(/SHARK_ALLOWED_ORIGINS/);
  });

  it.each([
    ['an explicit database path', { SHARK_DB: undefined }],
    ['a strong pass secret', { SHARK_PASS_SECRET: 'too-short' }],
    ['at least one origin', { SHARK_PUBLIC_ORIGIN: undefined }],
    ['OTP echo to stay off', { SHARK_ECHO_OTP: 'true' }],
    ['bearer authentication to stay off', { SHARK_ALLOW_BEARER_AUTH: 'true' }],
    ['HTTPS origins', { SHARK_PUBLIC_ORIGIN: 'http://fitness.example' }],
    ['an HTTPS error collector', { SHARK_ERROR_REPORTING_ENDPOINT: 'http://errors.example/v1' }],
  ])('requires %s in production', (_case, overrides) => {
    expect(() => parseRuntimeConfig(productionEnv(overrides))).toThrow();
  });

  it('does not include secret values in configuration errors', () => {
    const secret = 'print-me-never';
    try {
      parseRuntimeConfig(productionEnv({ SHARK_PASS_SECRET: secret }));
      throw new Error('expected configuration parsing to fail');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain('SHARK_PASS_SECRET');
    }
  });

  it.each([
    [{ SHARK_PUBLIC_ORIGIN: 'https://public.example' }, 'https://public.example'],
    [{ SHARK_PUBLIC_ORIGIN: undefined, SHARK_ALLOWED_ORIGINS: 'https://allowed.example' }, 'https://allowed.example'],
    [{ SHARK_PUBLIC_ORIGIN: undefined, RENDER_EXTERNAL_URL: 'https://render.example' }, 'https://render.example'],
  ])('accepts each production origin source', (overrides, expectedOrigin) => {
    expect(parseRuntimeConfig(productionEnv(overrides)).allowedOrigins).toContain(expectedOrigin);
  });

  it.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])(
    'allows the loopback production smoke origin %s',
    (origin) => {
      expect(parseRuntimeConfig(productionEnv({ SHARK_PUBLIC_ORIGIN: origin })).allowedOrigins).toContain(origin);
    },
  );
});
