import { z } from 'zod';

const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
] as const;

const DEVELOPMENT_PASS_SECRET = 'development-only-pass-secret-change-before-deploying';
/** 32 bytes, published here on purpose: it protects nothing but local and test
 * databases. Production refuses to start without its own key. */
const DEVELOPMENT_MFA_ENCRYPTION_KEY = Buffer.from('shark-development-only-mfa-key!!', 'utf8');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const ExactBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');
const Port = z
  .string()
  .regex(/^\d+$/, 'PORT must be an integer between 1 and 65535.')
  .transform(Number)
  .refine((value) => value >= 1 && value <= 65_535, 'PORT must be between 1 and 65535.');
const TrustedProxyHops = z
  .string()
  .regex(/^\d+$/, 'SHARK_TRUST_PROXY_HOPS must be an integer between 0 and 5.')
  .transform(Number)
  .refine((value) => value <= 5, 'SHARK_TRUST_PROXY_HOPS must be between 0 and 5.');

function boundedInteger(variable: string, minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^\d+$/, `${variable} must be an integer between ${minimum} and ${maximum}.`)
    .transform(Number)
    .refine((value) => value >= minimum && value <= maximum, `${variable} must be between ${minimum} and ${maximum}.`);
}

const Origin = z.string().trim().min(1).transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a valid HTTP or HTTPS origin.' });
    return z.NEVER;
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use an exact HTTP or HTTPS origin without a path.' });
    return z.NEVER;
  }
  return url.origin;
});

const OptionalOrigin = Origin.optional();
const HttpEndpoint = z.string().trim().min(1).transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a valid HTTP or HTTPS URL.' });
    return z.NEVER;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use an HTTP or HTTPS URL without embedded credentials.' });
    return z.NEVER;
  }
  return url.toString();
});
const OriginList = z.preprocess(
  (value) => {
    if (value === undefined) return [];
    if (typeof value !== 'string') return value;
    if (value.trim() === '') return [];
    return value.split(',');
  },
  z.array(Origin),
);

/** Optional values that historically treated an empty assignment (`KEY=`) as
 * "not set". The OTP variables shipped that way in .env.example, so they keep it. */
const blankAsUnset = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const OptionalText = z.preprocess(blankAsUnset, z.string().trim().min(1).optional());

function providerName<const T extends readonly [string, ...string[]]>(variable: string, names: T) {
  return z.preprocess(
    blankAsUnset,
    z
      .enum(names, {
        errorMap: (_issue, ctx) => ({
          message: `Unknown ${variable} "${String(ctx.data).slice(0, 40)}". Use ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}.`,
        }),
      })
      .optional(),
  );
}

export const ERROR_REPORTERS = ['auto', 'none', 'console', 'http', 'sentry'] as const;
export type ErrorReporterName = Exclude<(typeof ERROR_REPORTERS)[number], 'auto'>;

/** A Sentry-protocol DSN: `https://<public key>@<host>[/<path>]/<project id>`.
 * Any Sentry-compatible collector (Sentry, GlitchTip, self-hosted) issues one. */
export interface ErrorDsn {
  dsn: string;
  publicKey: string;
  envelopeUrl: string;
  protocol: 'http:' | 'https:';
  hostname: string;
}

const Dsn = z.string().trim().min(1).transform((value, ctx): ErrorDsn => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SHARK_ERROR_DSN is not a valid DSN URL.' });
    return z.NEVER;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username === '' ||
    !projectId ||
    !/^\d+$/.test(projectId) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SHARK_ERROR_DSN must look like https://<public key>@<host>/<numeric project id>.',
    });
    return z.NEVER;
  }
  const prefix = segments.length > 0 ? `/${segments.join('/')}` : '';
  return {
    dsn: url.toString(),
    publicKey: decodeURIComponent(url.username),
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    protocol: url.protocol,
    hostname: url.hostname,
  };
});

const Reader = z.object({
  key: z.string().min(16),
  tenantSlug: z.string().trim().min(1).refine((value) => value !== '*', 'must identify one tenant'),
  branchSlugs: z.array(z.string().trim().min(1)).min(1),
}).strict();

const ReaderKeys = z.preprocess(
  (value) => {
    if (value === undefined) return {};
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
  z.record(Reader),
);

const RuntimeEnvironmentShape = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    PORT: Port.optional(),
    SHARK_DB: z.string().trim().min(1).optional(),
    SHARK_SERVE_STATIC: ExactBoolean.optional(),
    SHARK_DISABLE_JOBS: ExactBoolean.optional(),
    SHARK_PASS_SECRET: z.string().trim().min(1).optional(),
    SHARK_PUBLIC_ORIGIN: OptionalOrigin,
    SHARK_ALLOWED_ORIGINS: OriginList,
    SHARK_ECHO_OTP: ExactBoolean.optional(),
    SHARK_ALLOW_BEARER_AUTH: ExactBoolean.optional(),
    SHARK_TRUST_PROXY_HOPS: TrustedProxyHops.optional(),
    SHARK_READER_KEYS_JSON: ReaderKeys,
    SHARK_DEMO_READER_KEY: z.string().min(1).optional(),
    SHARK_MEDIA_BUCKET: z.string().transform((value) => value.trim()).optional(),
    SHARK_ERROR_REPORTING_ENDPOINT: HttpEndpoint.optional(),
    SHARK_ERROR_REPORTER: providerName('SHARK_ERROR_REPORTER', ERROR_REPORTERS),
    SHARK_ERROR_DSN: Dsn.optional(),
    SHARK_METRICS_TOKEN: z.string().min(1).optional(),
    /** AES-256-GCM key for TOTP and webhook secrets at rest: 32 bytes, base64. */
    SHARK_MFA_ENCRYPTION_KEY: z.preprocess(
      blankAsUnset,
      z
        .string()
        .trim()
        .transform((value, ctx) => {
          const key = /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : Buffer.alloc(0);
          if (key.length !== 32) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'SHARK_MFA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).',
            });
            return z.NEVER;
          }
          return key;
        })
        .optional(),
    ),
    /** Send the Content-Security-Policy as report-only (rollout and debugging). */
    SHARK_CSP_REPORT_ONLY: ExactBoolean.optional(),
    SHARK_OTP_SMS_PROVIDER: providerName('SHARK_OTP_SMS_PROVIDER', ['log', 'msg91', 'twilio'] as const),
    SHARK_OTP_EMAIL_PROVIDER: providerName('SHARK_OTP_EMAIL_PROVIDER', ['log', 'resend'] as const),
    SHARK_OTP_DEFAULT_COUNTRY_CODE: z.preprocess(
      blankAsUnset,
      z.string().regex(/^[1-9]\d{0,2}$/, 'SHARK_OTP_DEFAULT_COUNTRY_CODE must be 1 to 3 digits, without +.').optional(),
    ),
    SHARK_MSG91_AUTH_KEY: OptionalText,
    SHARK_MSG91_TEMPLATE_ID: OptionalText,
    SHARK_TWILIO_ACCOUNT_SID: OptionalText,
    SHARK_TWILIO_AUTH_TOKEN: OptionalText,
    SHARK_TWILIO_FROM: OptionalText,
    SHARK_TWILIO_CHANNEL: providerName('SHARK_TWILIO_CHANNEL', ['sms', 'whatsapp'] as const),
    SHARK_TWILIO_CONTENT_SID: OptionalText,
    SHARK_RESEND_API_KEY: OptionalText,
    SHARK_OTP_EMAIL_FROM: OptionalText,
    SHARK_OTP_RESEND_COOLDOWN_SEC: z.preprocess(blankAsUnset, boundedInteger('SHARK_OTP_RESEND_COOLDOWN_SEC', 1, 3_600).optional()),
    SHARK_OTP_MAX_PER_DESTINATION_PER_DAY: z.preprocess(
      blankAsUnset,
      boundedInteger('SHARK_OTP_MAX_PER_DESTINATION_PER_DAY', 1, 1_000).optional(),
    ),
    SHARK_OTP_MAX_PER_IP_PER_HOUR: z.preprocess(blankAsUnset, boundedInteger('SHARK_OTP_MAX_PER_IP_PER_HOUR', 1, 10_000).optional()),
    SHARK_IDEMPOTENCY_RETENTION_DAYS: boundedInteger('SHARK_IDEMPOTENCY_RETENTION_DAYS', 7, 365).optional(),
    SHARK_OUTBOX_RETENTION_DAYS: boundedInteger('SHARK_OUTBOX_RETENTION_DAYS', 7, 365).optional(),
    SHARK_SESSION_RETENTION_DAYS: boundedInteger('SHARK_SESSION_RETENTION_DAYS', 1, 365).optional(),
    SHARK_OTP_RETENTION_HOURS: boundedInteger('SHARK_OTP_RETENTION_HOURS', 1, 168).optional(),
    SHARK_ACCESS_WINDOW_RETENTION_HOURS: boundedInteger('SHARK_ACCESS_WINDOW_RETENTION_HOURS', 1, 168).optional(),
    SHARK_AUTOMATION_RETENTION_DAYS: boundedInteger('SHARK_AUTOMATION_RETENTION_DAYS', 7, 730).optional(),
    SHARK_JOB_RUN_RETENTION_DAYS: boundedInteger('SHARK_JOB_RUN_RETENTION_DAYS', 7, 365).optional(),
    SHARK_PRUNE_BATCH_SIZE: boundedInteger('SHARK_PRUNE_BATCH_SIZE', 1, 1_000).optional(),
    SHARK_PRUNE_MAX_BATCHES: boundedInteger('SHARK_PRUNE_MAX_BATCHES', 1, 10).optional(),
    SHARK_RELEASE: z.string().trim().min(1).max(200).optional(),
    RENDER_EXTERNAL_URL: OptionalOrigin,
    RENDER_GIT_COMMIT: z.string().trim().optional(),
    GITHUB_SHA: z.string().trim().optional(),
  });

/** Every environment variable the API reads. A unit test keeps
 * shark-fitness/.env.example in step with this list, and another refuses
 * `process.env` anywhere else under src/. */
export const RUNTIME_ENV_KEYS = Object.keys(RuntimeEnvironmentShape.shape) as Array<keyof typeof RuntimeEnvironmentShape.shape>;

const OTP_CREDENTIALS = {
  msg91: ['SHARK_MSG91_AUTH_KEY', 'SHARK_MSG91_TEMPLATE_ID'],
  twilio: ['SHARK_TWILIO_ACCOUNT_SID', 'SHARK_TWILIO_AUTH_TOKEN', 'SHARK_TWILIO_FROM'],
  resend: ['SHARK_RESEND_API_KEY', 'SHARK_OTP_EMAIL_FROM'],
} as const;

const RuntimeEnvironment = RuntimeEnvironmentShape.superRefine((environment, ctx) => {
    if (environment.SHARK_MEDIA_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_MEDIA_BUCKET'],
        message: 'SHARK_MEDIA_BUCKET is not supported until an object-storage upload provider is implemented.',
      });
    }
    for (const [variable, provider] of [
      ['SHARK_OTP_SMS_PROVIDER', environment.SHARK_OTP_SMS_PROVIDER],
      ['SHARK_OTP_EMAIL_PROVIDER', environment.SHARK_OTP_EMAIL_PROVIDER],
    ] as const) {
      if (!provider || provider === 'log') continue;
      for (const key of OTP_CREDENTIALS[provider]) {
        if (!environment[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when ${variable}=${provider}.`,
          });
        }
      }
    }
    if (environment.SHARK_ERROR_REPORTER === 'sentry' && !environment.SHARK_ERROR_DSN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_ERROR_DSN'],
        message: 'SHARK_ERROR_REPORTER=sentry needs SHARK_ERROR_DSN.',
      });
    }
    if (environment.SHARK_ERROR_REPORTER === 'http' && !environment.SHARK_ERROR_REPORTING_ENDPOINT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_ERROR_REPORTING_ENDPOINT'],
        message: 'SHARK_ERROR_REPORTER=http needs SHARK_ERROR_REPORTING_ENDPOINT.',
      });
    }
    if (environment.NODE_ENV !== 'production') return;

    if (!environment.SHARK_DB) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SHARK_DB'], message: 'SHARK_DB is required in production.' });
    }
    if (!environment.SHARK_PASS_SECRET || Buffer.byteLength(environment.SHARK_PASS_SECRET, 'utf8') < 48) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_PASS_SECRET'],
        message: 'SHARK_PASS_SECRET must contain at least 48 bytes in production.',
      });
    }

    const originSources = [
      ...environment.SHARK_ALLOWED_ORIGINS.map((origin) => ({ origin, variable: 'SHARK_ALLOWED_ORIGINS' })),
      ...(environment.SHARK_PUBLIC_ORIGIN
        ? [{ origin: environment.SHARK_PUBLIC_ORIGIN, variable: 'SHARK_PUBLIC_ORIGIN' }]
        : []),
      ...(environment.RENDER_EXTERNAL_URL
        ? [{ origin: environment.RENDER_EXTERNAL_URL, variable: 'RENDER_EXTERNAL_URL' }]
        : []),
    ];
    if (originSources.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_PUBLIC_ORIGIN'],
        message: 'Configure SHARK_PUBLIC_ORIGIN, SHARK_ALLOWED_ORIGINS, or RENDER_EXTERNAL_URL in production.',
      });
    }
    for (const { origin, variable } of originSources) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [variable],
          message: `Production origin ${origin} must use HTTPS.`,
        });
      }
    }

    if (!environment.SHARK_MFA_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_MFA_ENCRYPTION_KEY'],
        message: 'SHARK_MFA_ENCRYPTION_KEY is required in production (openssl rand -base64 32).',
      });
    }

    if (environment.SHARK_ECHO_OTP === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_ECHO_OTP'],
        message: 'SHARK_ECHO_OTP must be false in production.',
      });
    }
    if (environment.SHARK_ALLOW_BEARER_AUTH === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_ALLOW_BEARER_AUTH'],
        message: 'SHARK_ALLOW_BEARER_AUTH is a development-only switch and must be false in production.',
      });
    }
    for (const readerId of Object.keys(environment.SHARK_READER_KEYS_JSON)) {
      const reader = environment.SHARK_READER_KEYS_JSON[readerId]!;
      if (Buffer.byteLength(reader.key, 'utf8') < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SHARK_READER_KEYS_JSON', readerId, 'key'],
          message: 'Production reader keys must contain at least 32 bytes.',
        });
      }
    }
    if (environment.SHARK_ERROR_REPORTING_ENDPOINT) {
      const url = new URL(environment.SHARK_ERROR_REPORTING_ENDPOINT);
      if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SHARK_ERROR_REPORTING_ENDPOINT'],
          message: 'SHARK_ERROR_REPORTING_ENDPOINT must use HTTPS in production.',
        });
      }
    }
    if (environment.SHARK_ERROR_DSN && environment.SHARK_ERROR_DSN.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_ERROR_DSN'],
        message: 'SHARK_ERROR_DSN must use HTTPS in production.',
      });
    }
    if (environment.SHARK_METRICS_TOKEN !== undefined && environment.SHARK_METRICS_TOKEN.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_METRICS_TOKEN'],
        message: 'SHARK_METRICS_TOKEN must be at least 32 characters in production.',
      });
    }
  });

export interface ReaderConfig {
  key: string;
  /** Exact customer tenant. The development-only demo reader uses `*`. */
  tenantSlug: string;
  branchSlugs: string[];
}

export interface RuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  databasePath: string;
  serveStatic: boolean;
  disableJobs: boolean;
  passSecret: string;
  allowedOrigins: string[];
  echoOtp: boolean;
  allowBearerAuth: boolean;
  trustedProxyHops: number;
  readerKeys: Record<string, ReaderConfig>;
  demoReaderKey: string;
  mediaBucket: string | null;
  errorReportingEndpoint: string | null;
  errorDsn: ErrorDsn | null;
  /** The reporter `auto` resolved to: DSN, then endpoint, then console in
   * development, otherwise none. */
  errorReporter: ErrorReporterName;
  /** Bearer token for GET /metrics. Null disables the endpoint (404). */
  metricsToken: string | null;
  /** 32-byte key for field encryption (TOTP and webhook secrets). */
  mfaEncryptionKey: Buffer;
  cspReportOnly: boolean;
  otp: OtpConfig;
  release: string;
  retention: {
    idempotencyKeysMs: number;
    outboxEventsMs: number;
    sessionsMs: number;
    otpChallengesMs: number;
    usedAccessWindowsMs: number;
    automationHistoryMs: number;
    jobRunsMs: number;
  };
  pruning: { batchSize: number; maxBatches: number };
}

export interface OtpConfig {
  smsProvider: 'log' | 'msg91' | 'twilio';
  emailProvider: 'log' | 'resend';
  /** Used when a stored phone number has no + prefix. */
  defaultCountryCode: string;
  msg91: { authKey: string; templateId: string } | null;
  twilio: { accountSid: string; authToken: string; from: string; channel: 'sms' | 'whatsapp'; contentSid: string | null } | null;
  resend: { apiKey: string; from: string } | null;
  limits: { resendCooldownMs: number; perDestinationPerDay: number; perIpPerHour: number };
}

export function parseRuntimeConfig(environment: Record<string, string | undefined>): RuntimeConfig {
  const parsed = RuntimeEnvironment.parse(environment);
  const nodeEnv = parsed.NODE_ENV ?? 'development';
  const configuredOrigins = [
    ...parsed.SHARK_ALLOWED_ORIGINS,
    parsed.SHARK_PUBLIC_ORIGIN,
    parsed.RENDER_EXTERNAL_URL,
    ...(nodeEnv === 'production' ? [] : LOCAL_ORIGINS),
  ].filter((origin): origin is string => Boolean(origin));

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: parsed.PORT ?? 8787,
    databasePath: parsed.SHARK_DB ?? 'data/shark.db',
    serveStatic: parsed.SHARK_SERVE_STATIC ?? false,
    disableJobs: parsed.SHARK_DISABLE_JOBS ?? false,
    passSecret: parsed.SHARK_PASS_SECRET ?? DEVELOPMENT_PASS_SECRET,
    allowedOrigins: [...new Set(configuredOrigins)],
    echoOtp: parsed.SHARK_ECHO_OTP ?? false,
    allowBearerAuth: parsed.SHARK_ALLOW_BEARER_AUTH ?? false,
    trustedProxyHops: parsed.SHARK_TRUST_PROXY_HOPS ?? 0,
    readerKeys: parsed.SHARK_READER_KEYS_JSON,
    demoReaderKey: parsed.SHARK_DEMO_READER_KEY ?? 'demo-reader-secret-change-me',
    mediaBucket: parsed.SHARK_MEDIA_BUCKET || null,
    errorReportingEndpoint: parsed.SHARK_ERROR_REPORTING_ENDPOINT ?? null,
    errorDsn: parsed.SHARK_ERROR_DSN ?? null,
    errorReporter: resolveErrorReporter(parsed.SHARK_ERROR_REPORTER ?? 'auto', {
      dsn: Boolean(parsed.SHARK_ERROR_DSN),
      endpoint: Boolean(parsed.SHARK_ERROR_REPORTING_ENDPOINT),
      nodeEnv,
    }),
    metricsToken: parsed.SHARK_METRICS_TOKEN ?? null,
    mfaEncryptionKey: parsed.SHARK_MFA_ENCRYPTION_KEY ?? DEVELOPMENT_MFA_ENCRYPTION_KEY,
    cspReportOnly: parsed.SHARK_CSP_REPORT_ONLY ?? false,
    otp: {
      smsProvider: parsed.SHARK_OTP_SMS_PROVIDER ?? 'log',
      emailProvider: parsed.SHARK_OTP_EMAIL_PROVIDER ?? 'log',
      defaultCountryCode: parsed.SHARK_OTP_DEFAULT_COUNTRY_CODE ?? '91',
      msg91:
        parsed.SHARK_MSG91_AUTH_KEY && parsed.SHARK_MSG91_TEMPLATE_ID
          ? { authKey: parsed.SHARK_MSG91_AUTH_KEY, templateId: parsed.SHARK_MSG91_TEMPLATE_ID }
          : null,
      twilio:
        parsed.SHARK_TWILIO_ACCOUNT_SID && parsed.SHARK_TWILIO_AUTH_TOKEN && parsed.SHARK_TWILIO_FROM
          ? {
              accountSid: parsed.SHARK_TWILIO_ACCOUNT_SID,
              authToken: parsed.SHARK_TWILIO_AUTH_TOKEN,
              from: parsed.SHARK_TWILIO_FROM,
              channel: parsed.SHARK_TWILIO_CHANNEL ?? 'sms',
              contentSid: parsed.SHARK_TWILIO_CONTENT_SID ?? null,
            }
          : null,
      resend:
        parsed.SHARK_RESEND_API_KEY && parsed.SHARK_OTP_EMAIL_FROM
          ? { apiKey: parsed.SHARK_RESEND_API_KEY, from: parsed.SHARK_OTP_EMAIL_FROM }
          : null,
      limits: {
        resendCooldownMs: (parsed.SHARK_OTP_RESEND_COOLDOWN_SEC ?? 30) * 1_000,
        perDestinationPerDay: parsed.SHARK_OTP_MAX_PER_DESTINATION_PER_DAY ?? 10,
        perIpPerHour: parsed.SHARK_OTP_MAX_PER_IP_PER_HOUR ?? 30,
      },
    },
    release: parsed.SHARK_RELEASE || parsed.RENDER_GIT_COMMIT || parsed.GITHUB_SHA || 'local',
    retention: {
      idempotencyKeysMs: (parsed.SHARK_IDEMPOTENCY_RETENTION_DAYS ?? 30) * DAY_MS,
      outboxEventsMs: (parsed.SHARK_OUTBOX_RETENTION_DAYS ?? 7) * DAY_MS,
      sessionsMs: (parsed.SHARK_SESSION_RETENTION_DAYS ?? 30) * DAY_MS,
      otpChallengesMs: (parsed.SHARK_OTP_RETENTION_HOURS ?? 24) * HOUR_MS,
      usedAccessWindowsMs: (parsed.SHARK_ACCESS_WINDOW_RETENTION_HOURS ?? 24) * HOUR_MS,
      automationHistoryMs: (parsed.SHARK_AUTOMATION_RETENTION_DAYS ?? 90) * DAY_MS,
      jobRunsMs: (parsed.SHARK_JOB_RUN_RETENTION_DAYS ?? 30) * DAY_MS,
    },
    pruning: {
      batchSize: parsed.SHARK_PRUNE_BATCH_SIZE ?? 1_000,
      maxBatches: parsed.SHARK_PRUNE_MAX_BATCHES ?? 10,
    },
  };
}

function resolveErrorReporter(
  choice: (typeof ERROR_REPORTERS)[number],
  available: { dsn: boolean; endpoint: boolean; nodeEnv: RuntimeConfig['nodeEnv'] },
): ErrorReporterName {
  if (choice !== 'auto') return choice;
  if (available.dsn) return 'sentry';
  if (available.endpoint) return 'http';
  return available.nodeEnv === 'development' ? 'console' : 'none';
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export const runtimeConfig = parseRuntimeConfig(process.env);
