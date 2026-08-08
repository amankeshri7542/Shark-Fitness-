import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { PasswordSignInInput, StartOtpInput, VerifyOtpInput } from '@shark/contracts';
import { SESSION_COOKIE, authenticate, ctxOf, rateLimit } from '../middleware/index.js';
import { revokeSession, signInWithPassword, startOtp, verifyOtp, viewerFor } from '../services/auth.js';
import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { DAY } from '../lib/time.js';

export const authRoutes = new Hono();

const clientIp = (c: { req: { header: (k: string) => string | undefined } }) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';

/** Which gyms this deployment serves. Drives the tenant picker on sign-in. */
authRoutes.get('/tenants', (c) => {
  const rows = db
    .select({
      slug: schema.tenants.slug,
      displayName: schema.tenants.displayName,
      currency: schema.tenants.currency,
    })
    .from(schema.tenants)
    .where(eq(schema.tenants.status, 'active'))
    .all();
  return c.json({ items: rows });
});

authRoutes.post(
  '/otp/start',
  rateLimit(10, 60_000),
  zValidator('json', StartOtpInput),
  (c) => {
    const body = c.req.valid('json');
    return c.json(
      startOtp({
        identifier: body.identifier,
        ...(body.tenantSlug ? { tenantSlug: body.tenantSlug } : {}),
        ip: clientIp(c),
      }),
    );
  },
);

authRoutes.post(
  '/otp/verify',
  rateLimit(20, 60_000),
  zValidator('json', VerifyOtpInput),
  (c) => {
    const body = c.req.valid('json');
    const result = verifyOtp({
      challengeId: body.challengeId,
      code: body.code,
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? '',
    });
    setSessionCookie(c, result.token);
    return c.json({ viewer: result.viewer, token: result.token });
  },
);

authRoutes.post(
  '/password',
  rateLimit(10, 60_000),
  zValidator('json', PasswordSignInInput),
  (c) => {
    const body = c.req.valid('json');
    const result = signInWithPassword({
      email: body.email,
      password: body.password,
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? '',
    });
    setSessionCookie(c, result.token);
    return c.json({ viewer: result.viewer, token: result.token });
  },
);

authRoutes.post('/sign-out', authenticate, (c) => {
  const ctx = ctxOf(c);
  const raw = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const session = raw
    ? null
    : db.select().from(schema.sessions).where(eq(schema.sessions.userId, ctx.userId)).get();
  if (session) revokeSession(session.id);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

authRoutes.get('/session', authenticate, (c) => {
  return c.json({ viewer: viewerFor(ctxOf(c).userId) });
});

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: (30 * DAY) / 1000,
    secure: process.env.NODE_ENV === 'production',
  });
}
