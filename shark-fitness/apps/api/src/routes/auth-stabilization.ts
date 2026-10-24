import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { VerifyOtpInput } from '@shark/contracts';
import { validate } from '../middleware/validate.js';
import { clientIp, rateLimit } from '../middleware/index.js';
import { verifyOtp, viewerFor } from '../services/auth.js';
import { runtimeConfig } from '../lib/config.js';
import { DAY } from '../lib/time.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearCsrfCookie,
  issueCsrfCookie,
} from '../lib/security.js';

export const authStabilizationRoutes = new Hono();

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

    setCookie(c, SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: (30 * DAY) / 1000,
      secure: runtimeConfig.isProduction,
    });
    if (getCookie(c, CSRF_COOKIE)) clearCsrfCookie(c);
    const csrfToken = issueCsrfCookie(c);

    return c.json({
      viewer: viewerFor(result.viewer.userId),
      csrfToken,
    });
  },
);
