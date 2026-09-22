import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
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
  createSession,
} from '../services/auth.js';
import { hashPassword, hashToken } from '../lib/crypto.js';
import { id, token } from '../lib/ids.js';
import { invalid, forbidden } from '../lib/errors.js';
import { requirePermission } from '../lib/context.js';
import { loadMemberInScope } from '../services/members.js';
import { loadStaffInScope } from '../services/staff.js';
import { audit } from '../lib/audit.js';
import { db, schema } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { DAY, now } from '../lib/time.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearCsrfCookie,
  csrfTokenFrom,
  issueCsrfCookie,
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
    return createSession(user.id, user.tenantId, clientIp(c), c.req.header('user-agent') ?? '');
  });
  const csrfToken = setBrowserSession(c, result.token);
  c.header('Cache-Control', 'no-store');
  return c.json({ viewer: result.viewer, csrfToken });
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
