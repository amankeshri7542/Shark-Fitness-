import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { PublicClassesQuery, PublicLeadInput, PublicTrialRequestInput } from '@shark/contracts';
import { AppError } from '../lib/errors.js';
import { allowedOrigins } from '../lib/security.js';
import { capBody } from './client-errors.js';
import { clientIp, rateLimit } from '../middleware/index.js';
import { validate } from '../middleware/validate.js';
import {
  publicClasses,
  publicSite,
  resolvePublicTenant,
  submitWebsiteEnquiry,
  type EnquiryKind,
  type PublicTenant,
} from '../services/public-site.js';

/**
 * The public website's API, mounted at `/v1/public/:tenantSlug`.
 *
 * No session is read and no cookie is set. Reads are cached briefly by the
 * browser and rate-limited per IP. Writes need a known Origin (the CSRF
 * boundary here, as on /v1/client-errors), are limited to five per IP per ten
 * minutes per form and to a per-tenant budget, accept an `Idempotency-Key`,
 * and never send anything to the visitor.
 */
export const publicRoutes = new Hono<{ Variables: { publicTenant: PublicTenant } }>();

export const PUBLIC_FORM_IP_MAX = 5;
export const PUBLIC_FORM_IP_WINDOW_MS = 10 * 60_000;
export const PUBLIC_FORM_TENANT_MAX = 300;
export const PUBLIC_FORM_TENANT_WINDOW_MS = 60 * 60_000;
const PUBLIC_BODY_MAX_BYTES = 16 * 1024;

const resolveTenant: MiddlewareHandler = async (c, next) => {
  c.set('publicTenant', resolvePublicTenant(c.req.param('tenantSlug') ?? ''));
  await next();
};

const requireKnownOrigin: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')?.replace(/\/$/, '');
  if (!origin || !allowedOrigins().has(origin)) {
    throw new AppError('FORBIDDEN', 'This form can only be sent from the gym’s website.');
  }
  await next();
};

const publicTenantId = (c: Context): string => (c.get('publicTenant') as PublicTenant).id;

const cappedBody = capBody(PUBLIC_BODY_MAX_BYTES, 'That form is larger than we accept. Shorten the message and try again.');

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
};

function idempotencyKeyOf(c: Context): string | undefined {
  const key = c.req.header('idempotency-key');
  if (key === undefined || key === '') return undefined;
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw new AppError('VALIDATION_FAILED', 'The Idempotency-Key header must be 8–100 letters, digits, dashes or underscores.');
  }
  return key;
}

/* ——— Reads ————————————————————————————————————————————————————— */

const readLimit = rateLimit(120, 60_000, { identity: 'ip', bucket: 'public-read-ip' });

publicRoutes.get('/site', readLimit, resolveTenant, (c) => {
  c.header('cache-control', 'public, max-age=300');
  return c.json(publicSite(c.get('publicTenant')));
});

publicRoutes.get('/classes', readLimit, resolveTenant, validate('query', PublicClassesQuery), (c) => {
  c.header('cache-control', 'public, max-age=60');
  return c.json(publicClasses(c.get('publicTenant'), c.req.valid('query')));
});

/* ——— Writes ———————————————————————————————————————————————————— */

function submission(kind: EnquiryKind, schema: typeof PublicLeadInput | typeof PublicTrialRequestInput) {
  return [
    rateLimit(PUBLIC_FORM_IP_MAX, PUBLIC_FORM_IP_WINDOW_MS, { identity: 'ip', bucket: `public-${kind}-ip` }),
    requireKnownOrigin,
    resolveTenant,
    rateLimit(PUBLIC_FORM_TENANT_MAX, PUBLIC_FORM_TENANT_WINDOW_MS, { identity: publicTenantId, bucket: 'public-forms-tenant' }),
    noStore,
    cappedBody,
    validate('json', schema),
  ] as const;
}

publicRoutes.post('/leads', ...submission('contact', PublicLeadInput), (c) => {
  const receipt = submitWebsiteEnquiry(c.get('publicTenant'), c.req.valid('json'), {
    kind: 'contact',
    requestId: c.get('requestId') ?? 'unknown',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? '',
    idempotencyKey: idempotencyKeyOf(c),
  });
  return c.json(receipt, 202);
});

publicRoutes.post('/trial-requests', ...submission('trial', PublicTrialRequestInput), (c) => {
  const receipt = submitWebsiteEnquiry(c.get('publicTenant'), c.req.valid('json'), {
    kind: 'trial',
    requestId: c.get('requestId') ?? 'unknown',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? '',
    idempotencyKey: idempotencyKeyOf(c),
  });
  return c.json(receipt, 202);
});
