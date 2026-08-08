import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { PasswordSignInInput, StartOtpInput, VerifyOtpInput } from '@shark/contracts';
import { validate } from '../middleware/validate.js';
import { authenticate, ctxOf, rateLimit } from '../middleware/index.js';
import { revokeSession, signInWithPassword, startOtp, verifyOtp, viewerFor } from '../services/auth.js';
import { db, schema } from '../db/client.js';
import { DAY } from '../lib/time.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearCsrfCookie,
  csrfTokenFrom,
  issueCsrfCookie,
} from '../lib/security.js';

export const authRoutes = new Hono();

const clientIp = (c: { req: { header: (k: string) => string | undefined } }) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';

authRoutes.get('/tenants', (c) => {
  const rows = db
    .select({ slug: schema.tenants.slug, displayName: schema.tenants.displayName, currency: schema.tenants.currency })
    .from(schema.tenants)
    .where(eq(schema.tenants.status, 'active'))
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

function setBrowserSession(c: Parameters<typeof setCookie>[0], rawToken: string): string {
  setCookie(c, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: (30 * DAY) / 1000,
    secure: process.env.NODE_ENV === 'production',
  });

  if (getCookie(c, CSRF_COOKIE)) clearCsrfCookie(c);
  return issueCsrfCookie(c);
}
