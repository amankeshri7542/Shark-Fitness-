import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { VerifyOtpInput } from '@shark/contracts';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/index.js';
import { verifyOtp, viewerFor } from '../services/auth.js';
import { db, schema } from '../db/client.js';
import { DAY, now } from '../lib/time.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearCsrfCookie,
  issueCsrfCookie,
} from '../lib/security.js';

export const authStabilizationRoutes = new Hono();

const clientIp = (c: { req: { header: (key: string) => string | undefined } }) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1';

authStabilizationRoutes.post(
  '/otp/verify',
  rateLimit(20, 60_000),
  validate('json', VerifyOtpInput),
  (c) => {
    const body = c.req.valid('json');
    const result = verifyOtp({
      challengeId: body.challengeId,
      code: body.code,
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? '',
    });

    if (result.viewer.accountState === 'invited') {
      db.update(schema.users)
        .set({ accountState: 'active', updatedAt: now() })
        .where(eq(schema.users.id, result.viewer.userId))
        .run();
    }

    setCookie(c, SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: (30 * DAY) / 1000,
      secure: process.env.NODE_ENV === 'production',
    });
    if (getCookie(c, CSRF_COOKIE)) clearCsrfCookie(c);
    const csrfToken = issueCsrfCookie(c);

    return c.json({
      viewer: viewerFor(result.viewer.userId),
      csrfToken,
    });
  },
);
