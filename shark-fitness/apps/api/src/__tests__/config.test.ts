import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig, RUNTIME_ENV_KEYS } from '../lib/config.js';

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

describe('OTP delivery configuration', () => {
  it('defaults both channels to the log sender with the documented limits', () => {
    const { otp } = parseRuntimeConfig({});
    expect(otp).toMatchObject({
      smsProvider: 'log',
      emailProvider: 'log',
      defaultCountryCode: '91',
      limits: { resendCooldownMs: 30_000, perDestinationPerDay: 10, perIpPerHour: 30 },
    });
  });

  it('treats an empty assignment as unset, as the OTP variables always have', () => {
    expect(parseRuntimeConfig({ SHARK_OTP_SMS_PROVIDER: '', SHARK_MSG91_AUTH_KEY: '', SHARK_OTP_RESEND_COOLDOWN_SEC: '' }).otp)
      .toMatchObject({ smsProvider: 'log', msg91: null, limits: { resendCooldownMs: 30_000 } });
  });

  it.each([
    [{ SHARK_OTP_SMS_PROVIDER: 'msg91' }, /SHARK_MSG91_AUTH_KEY is required when SHARK_OTP_SMS_PROVIDER=msg91/],
    [{ SHARK_OTP_SMS_PROVIDER: 'msg91', SHARK_MSG91_AUTH_KEY: 'key' }, /SHARK_MSG91_TEMPLATE_ID/],
    [{ SHARK_OTP_SMS_PROVIDER: 'twilio', SHARK_TWILIO_ACCOUNT_SID: 'AC1' }, /SHARK_TWILIO_AUTH_TOKEN/],
    [{ SHARK_OTP_EMAIL_PROVIDER: 'resend', SHARK_RESEND_API_KEY: 're_1' }, /SHARK_OTP_EMAIL_FROM/],
  ])('refuses a provider selected without its credentials: %j', (environment, message) => {
    expect(() => parseRuntimeConfig(environment)).toThrow(message);
    expect(() => parseRuntimeConfig(productionEnv(environment))).toThrow(message);
  });

  it('refuses unknown provider and channel names', () => {
    expect(() => parseRuntimeConfig({ SHARK_OTP_SMS_PROVIDER: 'carrier-pigeon' })).toThrow(/Unknown SHARK_OTP_SMS_PROVIDER/);
    expect(() => parseRuntimeConfig({ SHARK_OTP_EMAIL_PROVIDER: 'msg91' })).toThrow(/Unknown SHARK_OTP_EMAIL_PROVIDER/);
    expect(() => parseRuntimeConfig({ SHARK_TWILIO_CHANNEL: 'telegram' })).toThrow(/SHARK_TWILIO_CHANNEL/);
    expect(() => parseRuntimeConfig({ SHARK_OTP_DEFAULT_COUNTRY_CODE: '+91' })).toThrow(/SHARK_OTP_DEFAULT_COUNTRY_CODE/);
  });

  it('builds the selected provider credentials', () => {
    const { otp } = parseRuntimeConfig({
      SHARK_OTP_SMS_PROVIDER: 'twilio',
      SHARK_TWILIO_ACCOUNT_SID: 'AC1',
      SHARK_TWILIO_AUTH_TOKEN: 'tok',
      SHARK_TWILIO_FROM: '+15550001111',
      SHARK_TWILIO_CHANNEL: 'whatsapp',
      SHARK_OTP_EMAIL_PROVIDER: 'resend',
      SHARK_RESEND_API_KEY: 're_1',
      SHARK_OTP_EMAIL_FROM: 'Shark <no-reply@shark.in>',
    });
    expect(otp.twilio).toEqual({ accountSid: 'AC1', authToken: 'tok', from: '+15550001111', channel: 'whatsapp', contentSid: null });
    expect(otp.resend).toEqual({ apiKey: 're_1', from: 'Shark <no-reply@shark.in>' });
  });

  it.each([
    ['SHARK_OTP_RESEND_COOLDOWN_SEC', 'thirty'],
    ['SHARK_OTP_RESEND_COOLDOWN_SEC', '0'],
    ['SHARK_OTP_MAX_PER_DESTINATION_PER_DAY', '10.5'],
    ['SHARK_OTP_MAX_PER_DESTINATION_PER_DAY', '-1'],
    ['SHARK_OTP_MAX_PER_IP_PER_HOUR', 'many'],
  ])('refuses the non-numeric or out-of-range OTP limit %s=%s', (name, value) => {
    expect(() => parseRuntimeConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it('parses valid OTP limits into milliseconds and counts', () => {
    expect(parseRuntimeConfig({
      SHARK_OTP_RESEND_COOLDOWN_SEC: '45',
      SHARK_OTP_MAX_PER_DESTINATION_PER_DAY: '5',
      SHARK_OTP_MAX_PER_IP_PER_HOUR: '100',
    }).otp.limits).toEqual({ resendCooldownMs: 45_000, perDestinationPerDay: 5, perIpPerHour: 100 });
  });
});

describe('error reporting and metrics configuration', () => {
  const DSN = 'https://abc123public@errors.example/42';

  it('resolves auto to the DSN, then the endpoint, then console in development, otherwise none', () => {
    expect(parseRuntimeConfig({ SHARK_ERROR_DSN: DSN, SHARK_ERROR_REPORTING_ENDPOINT: 'https://hook.example/x' }).errorReporter)
      .toBe('sentry');
    expect(parseRuntimeConfig({ SHARK_ERROR_REPORTING_ENDPOINT: 'https://hook.example/x' }).errorReporter).toBe('http');
    expect(parseRuntimeConfig({}).errorReporter).toBe('console');
    expect(parseRuntimeConfig({ NODE_ENV: 'test' }).errorReporter).toBe('none');
    expect(parseRuntimeConfig(productionEnv()).errorReporter).toBe('none');
    expect(parseRuntimeConfig({ SHARK_ERROR_REPORTER: 'none', SHARK_ERROR_DSN: DSN }).errorReporter).toBe('none');
  });

  it('refuses an unknown reporter name', () => {
    expect(() => parseRuntimeConfig({ SHARK_ERROR_REPORTER: 'datadog' })).toThrow(/Unknown SHARK_ERROR_REPORTER/);
    expect(() => parseRuntimeConfig({ SHARK_ERROR_REPORTER: 'Sentry' })).toThrow(/SHARK_ERROR_REPORTER/);
  });

  it('refuses an explicit reporter without what it needs', () => {
    expect(() => parseRuntimeConfig({ SHARK_ERROR_REPORTER: 'sentry' })).toThrow(/SHARK_ERROR_DSN/);
    expect(() => parseRuntimeConfig({ SHARK_ERROR_REPORTER: 'http' })).toThrow(/SHARK_ERROR_REPORTING_ENDPOINT/);
  });

  it('derives the envelope URL and public key from the DSN, including a path prefix', () => {
    expect(parseRuntimeConfig({ SHARK_ERROR_DSN: DSN }).errorDsn).toMatchObject({
      publicKey: 'abc123public',
      envelopeUrl: 'https://errors.example/api/42/envelope/',
    });
    expect(parseRuntimeConfig({ SHARK_ERROR_DSN: 'https://key@glitchtip.example:8443/errors/7' }).errorDsn?.envelopeUrl)
      .toBe('https://glitchtip.example:8443/errors/api/7/envelope/');
  });

  it.each([
    ['not a URL', 'sentry-dsn'],
    ['no public key', 'https://errors.example/42'],
    ['no project id', 'https://key@errors.example/'],
    ['a non-numeric project id', 'https://key@errors.example/project'],
    ['a non-HTTP scheme', 'ftp://key@errors.example/42'],
  ])('refuses a malformed DSN: %s', (_case, dsn) => {
    expect(() => parseRuntimeConfig({ SHARK_ERROR_DSN: dsn })).toThrow(/SHARK_ERROR_DSN/);
  });

  it('refuses a non-HTTPS DSN in production but allows it in development', () => {
    expect(() => parseRuntimeConfig(productionEnv({ SHARK_ERROR_DSN: 'http://key@errors.example/42' })))
      .toThrow(/SHARK_ERROR_DSN must use HTTPS/);
    expect(parseRuntimeConfig(productionEnv({ SHARK_ERROR_DSN: DSN })).errorReporter).toBe('sentry');
    expect(parseRuntimeConfig({ SHARK_ERROR_DSN: 'http://key@127.0.0.1:9999/1' }).errorDsn?.protocol).toBe('http:');
  });

  it('keeps the DSN key out of configuration errors', () => {
    try {
      parseRuntimeConfig(productionEnv({ SHARK_ERROR_DSN: 'http://do-not-print-this-key@errors.example/42' }));
      throw new Error('expected configuration parsing to fail');
    } catch (error) {
      expect(String(error)).not.toContain('do-not-print-this-key');
    }
  });

  it('disables metrics without a token and refuses a short token in production', () => {
    expect(parseRuntimeConfig({}).metricsToken).toBeNull();
    expect(parseRuntimeConfig({ SHARK_METRICS_TOKEN: 'short-dev-token' }).metricsToken).toBe('short-dev-token');
    expect(() => parseRuntimeConfig(productionEnv({ SHARK_METRICS_TOKEN: 'x'.repeat(31) }))).toThrow(/SHARK_METRICS_TOKEN/);
    expect(parseRuntimeConfig(productionEnv({ SHARK_METRICS_TOKEN: 'x'.repeat(32) })).metricsToken).toBe('x'.repeat(32));
  });
});

describe('environment variable inventory', () => {
  const apiSource = resolve(import.meta.dirname, '..');

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
      return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
  }

  it('reads process.env only in lib/config.ts', () => {
    const offenders = sourceFiles(apiSource)
      .filter((path) => relative(apiSource, path) !== join('lib', 'config.ts'))
      .filter((path) => /process\s*\.\s*env|process\s*\[\s*['"]env['"]\s*\]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(apiSource, path));
    expect(offenders).toEqual([]);
  });

  it('documents every declared variable in shark-fitness/.env.example', () => {
    const example = readFileSync(resolve(apiSource, '../../../.env.example'), 'utf8');
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
    expect(RUNTIME_ENV_KEYS.length).toBeGreaterThan(40);
    expect(RUNTIME_ENV_KEYS.filter((key) => !documented.has(key))).toEqual([]);
  });
});

describe('web push and Android app links configuration', () => {
  const PUBLIC = 'BAQenkvqVtXvVxiX9KyqR5kCY5ie5dDK54FMIXJIdEvAqV4yF6-A3kJAKZA8_6UXuJCXWFhl3KznxMYlzPOUybg';
  // Test-only pair generated for this file; it signs nothing anywhere.
  const PRIVATE = '3pYXG6vs8wLR-StqkQcEHbUC5HnLnBKQjZd82XhC8lU';
  const FINGERPRINT = '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';

  it('leaves push off when no VAPID variable is set', () => {
    expect(parseRuntimeConfig({}).push).toEqual({ vapid: null, extraEndpointOrigins: [] });
    expect(parseRuntimeConfig({ SHARK_VAPID_PUBLIC_KEY: '', SHARK_VAPID_PRIVATE_KEY: '', SHARK_VAPID_SUBJECT: '' }).push.vapid).toBeNull();
  });

  it('accepts a complete VAPID configuration', () => {
    const config = parseRuntimeConfig(
      productionEnv({ SHARK_VAPID_PUBLIC_KEY: PUBLIC, SHARK_VAPID_PRIVATE_KEY: PRIVATE, SHARK_VAPID_SUBJECT: 'mailto:ops@fitness.example' }),
    );
    expect(config.push.vapid).toEqual({ publicKey: PUBLIC, privateKey: PRIVATE, subject: 'mailto:ops@fitness.example' });
  });

  it('refuses a partial VAPID configuration, naming what is missing', () => {
    expect(() => parseRuntimeConfig({ SHARK_VAPID_PUBLIC_KEY: PUBLIC, SHARK_VAPID_SUBJECT: 'mailto:ops@fitness.example' })).toThrow(
      /SHARK_VAPID_PRIVATE_KEY is missing/,
    );
  });

  it('refuses keys that are not P-256 VAPID keys and a subject push services cannot use', () => {
    const base = { SHARK_VAPID_PUBLIC_KEY: PUBLIC, SHARK_VAPID_PRIVATE_KEY: PRIVATE, SHARK_VAPID_SUBJECT: 'mailto:ops@fitness.example' };
    expect(() => parseRuntimeConfig({ ...base, SHARK_VAPID_PUBLIC_KEY: PUBLIC.slice(0, 40) })).toThrow(/SHARK_VAPID_PUBLIC_KEY/);
    expect(() => parseRuntimeConfig({ ...base, SHARK_VAPID_PRIVATE_KEY: 'short' })).toThrow(/SHARK_VAPID_PRIVATE_KEY/);
    expect(() => parseRuntimeConfig({ ...base, SHARK_VAPID_SUBJECT: 'ops@fitness.example' })).toThrow(/SHARK_VAPID_SUBJECT/);
    expect(() => parseRuntimeConfig({ ...base, SHARK_VAPID_SUBJECT: 'http://fitness.example' })).toThrow(/SHARK_VAPID_SUBJECT/);
  });

  it('reads Android app links, normalising fingerprints to upper case', () => {
    const config = parseRuntimeConfig({
      SHARK_ANDROID_PACKAGE: 'in.sharkfitness.member',
      SHARK_ANDROID_CERT_SHA256: `${FINGERPRINT.toLowerCase()}, ${FINGERPRINT.replace(/^14/, 'AB')}`,
    });
    expect(config.androidAppLinks).toEqual({
      packageName: 'in.sharkfitness.member',
      sha256CertFingerprints: [FINGERPRINT, FINGERPRINT.replace(/^14/, 'AB')],
    });
    expect(parseRuntimeConfig({}).androidAppLinks).toBeNull();
  });

  it('refuses a malformed signing-certificate fingerprint at boot', () => {
    for (const bad of ['14:6D:E9', FINGERPRINT.replaceAll(':', ''), `${FINGERPRINT}:00`, 'ZZ' + FINGERPRINT.slice(2)]) {
      expect(() => parseRuntimeConfig({ SHARK_ANDROID_PACKAGE: 'in.sharkfitness.member', SHARK_ANDROID_CERT_SHA256: bad })).toThrow(
        /SHARK_ANDROID_CERT_SHA256/,
      );
    }
  });

  it('refuses half an app-links configuration and a package id that is not one', () => {
    expect(() => parseRuntimeConfig({ SHARK_ANDROID_PACKAGE: 'in.sharkfitness.member' })).toThrow(/SHARK_ANDROID_CERT_SHA256/);
    expect(() => parseRuntimeConfig({ SHARK_ANDROID_CERT_SHA256: FINGERPRINT })).toThrow(/SHARK_ANDROID_PACKAGE/);
    expect(() => parseRuntimeConfig({ SHARK_ANDROID_PACKAGE: 'sharkfitness', SHARK_ANDROID_CERT_SHA256: FINGERPRINT })).toThrow(
      /SHARK_ANDROID_PACKAGE/,
    );
  });
});
