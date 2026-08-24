import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, inArray } from 'drizzle-orm';
import { PasswordSignInInput, StartOtpInput, VerifyOtpInput } from '@shark/contracts';
import { validate } from '../middleware/validate.js';
import { authenticate, clientIp, ctxOf, rateLimit } from '../middleware/index.js';
import {
  OPERATIONAL_TENANT_STATUSES,
  revokeSession,
  signInWithPassword,
  startOtp,
  verifyOtp,
  viewerFor,
} from '../services/auth.js';
import { db, schema } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { DAY } from '../lib/time.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearCsrfCookie,
  csrfTokenFrom,
  issueCsrfCookie,
} from '../lib/security.js';

export const authRoutes = new Hono();

authRoutes.get('/tenants', (c) => {
  const rows = db
    .select({ slug: schema.tenants.slug, displayName: schema.tenants.displayName, currency: schema.tenants.currency })
    .from(schema.tenants)
    .where(
      and(
        eq(schema.tenants.kind, 'customer'),
        inArray(schema.tenants.status, OPERATIONAL_TENANT_STATUSES),
      ),
    )
    .all();
  return c.json({ items: rows });
});

authRoutes.post('/otp/start', rateLimit(10, 60_000), validate('json', StartOtpInput), (c) => {
  const body = c.req.valid('json');
  return c.json(
    startOtp({
      identifier: body.identifier,
      ...(body.tenantSlug ? { tenantSlug: body.tenantSlug } : {}),
      ip: clientIp(c),
    }),
  );
});

authRoutes.post('/otp/verify', rateLimit(20, 60_000), validate('json', VerifyOtpInput), (c) => {
  const body = c.req.valid('json');
  const result = verifyOtp({
    challengeId: body.challengeId,
    code: body.code,
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? '',
  });
  const csrfToken = setBrowserSession(c, result.token);
  return c.json({ viewer: result.viewer, csrfToken });
});

authRoutes.post('/password', rateLimit(10, 60_000), validate('json', PasswordSignInInput), (c) => {
  const body = c.req.valid('json');
  const result = signInWithPassword({
    tenantSlug: body.tenantSlug,
    email: body.email,
    password: body.password,
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? '',
  });
  const csrfToken = setBrowserSession(c, result.token);
  return c.json({ viewer: result.viewer, csrfToken });
});

authRoutes.get('/csrf', authenticate, (c) => {
  const csrfToken = csrfTokenFrom(c) ?? issueCsrfCookie(c);
  return c.json({ csrfToken });
});

authRoutes.post('/sign-out', authenticate, (c) => {
  revokeSession(ctxOf(c).sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  clearCsrfCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/session', authenticate, (c) => {
  return c.json({ viewer: viewerFor(ctxOf(c).userId) });
});

/**
 * Writes the browser session cookie and issues a matching CSRF token.
 *
 * Exported because starting a support session swaps the cookie for a borrowed
 * one, and it must carry exactly the same flags — a second hand-rolled
 * `Set-Cookie` that quietly forgot `httpOnly` would be a real hole.
 */
export function setBrowserSession(c: Parameters<typeof setCookie>[0], rawToken: string): string {
  setCookie(c, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: (30 * DAY) / 1000,
    secure: runtimeConfig.isProduction,
  });

  if (getCookie(c, CSRF_COOKIE)) clearCsrfCookie(c);
  return issueCsrfCookie(c);
}
