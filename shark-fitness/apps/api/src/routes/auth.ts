import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { PasswordSignInInput, StartOtpInput, StepUpInput, type MfaState, type Viewer } from '@shark/contracts';
import { validate } from '../middleware/validate.js';
import { authenticate, authenticatePartial, clientIp, ctxOf, rateLimit } from '../middleware/index.js';
import {
  MEMBER_SESSION_TTL,
  OPERATIONAL_TENANT_STATUSES,
  PARTIAL_SESSION_TTL,
  STAFF_SESSION_TTL,
  markActivity,
  markReauthenticated,
  revokeSession,
  sessionTiming,
  signInSession,
  signInWithPassword,
  startOtp,
  viewerFor,
} from '../services/auth.js';
import { isMfaEnrolled, verifyTotp } from '../services/mfa.js';
import { STEP_UP_MAX_AGE_SEC, stepUpUserId } from '../lib/step-up.js';
import { hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { id, token } from '../lib/ids.js';
import { invalid, forbidden } from '../lib/errors.js';
import { requirePermission } from '../lib/context.js';
import { loadMemberInScope } from '../services/members.js';
import { loadStaffInScope } from '../services/staff.js';
import { audit } from '../lib/audit.js';
import { db, schema } from '../db/client.js';
import { DAY, now } from '../lib/time.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearCsrfCookie,
  csrfTokenFrom,
  issueCsrfCookie,
  setSessionCookie,
} from '../lib/security.js';

export const authRoutes = new Hono();

authRoutes.post('/activation/issue', authenticate, rateLimit(20, 60_000), validate('json', z.union([
  z.object({ memberId: z.string().min(1) }).strict(),
  z.object({ staffId: z.string().min(1) }).strict(),
])), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  let userId: string | null;
  if ('memberId' in body) {
    requirePermission(ctx, 'member.edit');
    userId = loadMemberInScope(ctx, body.memberId).userId;
  } else {
    if (ctx.role !== 'owner') throw forbidden('Only the gym owner can issue staff activation.');
    userId = loadStaffInScope(ctx, body.staffId).userId;
  }
  const user = userId ? db.select().from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.tenantId, ctx.tenantId))).get() : undefined;
  if (!user || user.deletedAt || user.passwordHash || !['invited', 'active'].includes(user.accountState) || !user.email) {
    throw invalid('This account is not eligible for activation. An email and an account without a password are required.');
  }
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).get()!;
  const activationId = id('otp');
  const raw = token(32);
  const at = now();
  const identifier = `activation:${user.id}`;
  db.transaction(() => {
    db.update(schema.otpChallenges).set({ consumedAt: at }).where(and(eq(schema.otpChallenges.tenantId, ctx.tenantId), eq(schema.otpChallenges.identifier, identifier))).run();
    db.insert(schema.otpChallenges).values({ id: activationId, tenantId: ctx.tenantId, identifier, codeHash: hashToken(`${activationId}:${raw}`), attempts: 0, createdAt: at, expiresAt: at + DAY, consumedAt: null }).run();
    audit(ctx, { action: 'account.activation_issued', entityType: 'user', entityId: user.id, entityLabel: user.name });
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ activationId, token: raw, expiresAt: new Date(at + DAY).toISOString(), tenantSlug: tenant.slug, email: user.email });
});

authRoutes.post('/activation/redeem', rateLimit(10, 60_000), validate('json', z.object({
  activationId: z.string().min(1), token: z.string().min(32).max(256), password: z.string().min(12).max(128),
})), (c) => {
  const body = c.req.valid('json');
  const result = db.transaction(() => {
    const challenge = db.select().from(schema.otpChallenges).where(eq(schema.otpChallenges.id, body.activationId)).get();
    if (!challenge || !challenge.identifier.startsWith('activation:') || challenge.consumedAt !== null || challenge.expiresAt <= now() || challenge.codeHash !== hashToken(`${body.activationId}:${body.token}`)) {
      throw invalid('This activation link is invalid or expired. Ask reception for a new link.');
    }
    const user = db.select().from(schema.users).where(and(eq(schema.users.id, challenge.identifier.slice('activation:'.length)), eq(schema.users.tenantId, challenge.tenantId))).get();
    if (!user || user.deletedAt || user.passwordHash || !['invited', 'active'].includes(user.accountState)) throw invalid('This account cannot be activated. Contact reception.');
    db.update(schema.users).set({ passwordHash: hashPassword(body.password), accountState: 'active', updatedAt: now() }).where(eq(schema.users.id, user.id)).run();
    db.update(schema.otpChallenges).set({ consumedAt: now() }).where(eq(schema.otpChallenges.id, challenge.id)).run();
    return signInSession(user, clientIp(c), c.req.header('user-agent') ?? '');
  });
  c.header('Cache-Control', 'no-store');
  return c.json(signedIn(c, result));
});

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

authRoutes.post('/otp/start', rateLimit(10, 60_000), validate('json', StartOtpInput), async (c) => {
  const body = c.req.valid('json');
  return c.json(
    await startOtp({
      identifier: body.identifier,
      ...(body.tenantSlug ? { tenantSlug: body.tenantSlug } : {}),
      ip: clientIp(c),
    }),
  );
});

/* `POST /otp/verify` lives in auth-stabilization.ts, which is mounted first.
   A second handler here was unreachable and has been removed (P06). */

authRoutes.post('/password', rateLimit(10, 60_000), validate('json', PasswordSignInInput), (c) => {
  const body = c.req.valid('json');
  const result = signInWithPassword({
    tenantSlug: body.tenantSlug,
    email: body.email,
    password: body.password,
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? '',
  });
  return c.json(signedIn(c, result));
});

authRoutes.get('/csrf', authenticatePartial, (c) => {
  const csrfToken = csrfTokenFrom(c) ?? issueCsrfCookie(c);
  return c.json({ csrfToken });
});

authRoutes.post('/sign-out', authenticatePartial, (c) => {
  revokeSession(ctxOf(c).sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  clearCsrfCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/session', authenticate, (c) => {
  const ctx = ctxOf(c);
  return c.json({ viewer: viewerFor(ctx.userId), session: sessionTiming(ctx.sessionId) });
});

/**
 * The console's activity heartbeat: a person moved the mouse or typed. Sent at
 * most once a minute, and only while someone is there — this, not background
 * polling, is what keeps a staff session from idling out.
 */
authRoutes.post('/session/activity', authenticate, rateLimit(12, 60_000, { identity: 'actor', bucket: 'session-activity' }), (c) => {
  const ctx = ctxOf(c);
  markActivity(ctx.sessionId, null);
  return c.json({ session: sessionTiming(ctx.sessionId) });
});

/**
 * Step-up: re-prove the password, and the TOTP code when one is set up, so
 * the next five minutes of high-risk actions go through (lib/step-up.ts).
 * During a support session it is the operator who re-proves, never the owner
 * whose account is being viewed.
 *
 * A wrong password is 422, not 401: the session is fine, and a 401 would send
 * the console to its "session expired" screen.
 */
authRoutes.post(
  '/step-up',
  authenticate,
  rateLimit(10, 60_000, { identity: 'actor', bucket: 'step-up' }),
  validate('json', StepUpInput),
  (c) => {
    const ctx = ctxOf(c);
    const body = c.req.valid('json');
    const user = db.select().from(schema.users).where(eq(schema.users.id, stepUpUserId(ctx))).get();
    if (!user) throw invalid('That password is not right.');
    const fail = (reason: string, fields?: Array<{ path: string; code: string; message: string }>): never => {
      audit(ctx, { action: 'auth.step_up_failed', entityType: 'session', entityId: ctx.sessionId, entityLabel: user.name, reason });
      throw invalid(fields?.[0]?.message ?? 'That password is not right.', fields);
    };
    if (!user.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      fail('Wrong password', [{ path: 'password', code: 'invalid', message: 'That password is not right.' }]);
    }
    if (isMfaEnrolled(user.id)) {
      if (!body.code) fail('Authenticator code missing', [{ path: 'code', code: 'required', message: 'Enter the 6-digit code from your authenticator app.' }]);
      try {
        verifyTotp(ctx, user, body.code!);
      } catch (error) {
        audit(ctx, { action: 'auth.step_up_failed', entityType: 'session', entityId: ctx.sessionId, entityLabel: user.name, reason: 'Wrong authenticator code' });
        throw error;
      }
    }
    markReauthenticated(ctx.sessionId);
    audit(ctx, { action: 'auth.step_up_succeeded', entityType: 'session', entityId: ctx.sessionId, entityLabel: user.name });
    return c.json({ ok: true, validForSec: STEP_UP_MAX_AGE_SEC, reauthenticatedAt: new Date(now()).toISOString() });
  },
);

/**
 * Writes the browser session cookie and issues a matching CSRF token.
 *
 * Exported because starting a support session swaps the cookie for a borrowed
 * one, and it must carry exactly the same flags — a second hand-rolled
 * `Set-Cookie` that quietly forgot `httpOnly` would be a real hole.
 */
export function setBrowserSession(c: Parameters<typeof setCookie>[0], rawToken: string, maxAgeMs = MEMBER_SESSION_TTL): string {
  setSessionCookie(c, rawToken, maxAgeMs);

  if (getCookie(c, CSRF_COOKIE)) clearCsrfCookie(c);
  return issueCsrfCookie(c);
}

/** How long the cookie should live for a session in this state. The server
 *  enforces the real limits; this only stops browsers keeping dead cookies. */
export function cookieLifetimeMs(viewer: Pick<Viewer, 'role'>, mfaState: MfaState): number {
  if (mfaState === 'challenge' || mfaState === 'enrol') return PARTIAL_SESSION_TTL;
  return viewer.role === 'member' ? MEMBER_SESSION_TTL : STAFF_SESSION_TTL;
}

/**
 * The one sign-in response. `mfa.state` tells the console whether it holds a
 * full session or still has to ask for a code (`challenge`) or show the
 * enrolment gate (`enrol`). The member app never sees anything but `none`.
 */
export function signedIn(
  c: Parameters<typeof setCookie>[0],
  result: { token: string; viewer: Viewer; mfaState: MfaState },
): { viewer: Viewer; csrfToken: string; mfa: { state: MfaState } } {
  const csrfToken = setBrowserSession(c, result.token, cookieLifetimeMs(result.viewer, result.mfaState));
  return { viewer: result.viewer, csrfToken, mfa: { state: result.mfaState } };
}
