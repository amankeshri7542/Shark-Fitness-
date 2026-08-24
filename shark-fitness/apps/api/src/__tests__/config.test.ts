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
    ['HTTPS origins', { SHARK_PUBLIC_ORIGIN: 'http://fitness.example' }],
  ])('requires %s in production', (_case, overrides) => {
    expect(() => parseRuntimeConfig(productionEnv(overrides))).toThrow();
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
