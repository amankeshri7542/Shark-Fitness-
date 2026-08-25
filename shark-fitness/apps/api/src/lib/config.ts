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
const OriginList = z.preprocess(
  (value) => {
    if (value === undefined) return [];
    if (typeof value !== 'string') return value;
    if (value.trim() === '') return [];
    return value.split(',');
  },
  z.array(Origin),
);

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

const RuntimeEnvironment = z
  .object({
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
    SHARK_ERROR_REPORTING_ENDPOINT: OptionalOrigin,
    RENDER_EXTERNAL_URL: OptionalOrigin,
    RENDER_GIT_COMMIT: z.string().trim().optional(),
    GITHUB_SHA: z.string().trim().optional(),
  })
  .superRefine((environment, ctx) => {
    if (environment.SHARK_MEDIA_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_MEDIA_BUCKET'],
        message: 'SHARK_MEDIA_BUCKET is not supported until an object-storage upload provider is implemented.',
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

    if (environment.SHARK_ECHO_OTP === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHARK_ECHO_OTP'],
        message: 'SHARK_ECHO_OTP must be false in production.',
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
  release: string;
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
    release: parsed.RENDER_GIT_COMMIT || parsed.GITHUB_SHA || 'local',
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export const runtimeConfig = parseRuntimeConfig(process.env);
