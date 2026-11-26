import { Hono } from 'hono';
import { VerifyOtpInput } from '@shark/contracts';
import { validate } from '../middleware/validate.js';
import { clientIp, rateLimit } from '../middleware/index.js';
import { verifyOtp } from '../services/auth.js';
import { signedIn } from './auth.js';

export const authStabilizationRoutes = new Hono();

/**
 * The only `POST /otp/verify`. It is mounted before `authRoutes`; the copy that
 * used to live in auth.ts never ran and was removed in P06. Staff who use MFA
 * get a partial session here exactly as they do from password sign-in.
 */
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
    return c.json(signedIn(c, result));
  },
);
