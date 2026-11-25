import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { MfaVerifyInput, TotpCode } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { authenticate, authenticatePartial, ctxOf, rateLimit } from '../middleware/index.js';
import { validate } from '../middleware/validate.js';
import { audit } from '../lib/audit.js';
import { forbidden, precondition, unauthenticated } from '../lib/errors.js';
import { freshAuth } from '../lib/step-up.js';
import { completeMfa, viewerFor } from '../services/auth.js';
import {
  confirmEnrolment,
  disableMfa,
  mfaStatus,
  regenerateRecoveryCodes,
  startEnrolment,
  useRecoveryCode,
  verifyTotp,
} from '../services/mfa.js';
import { signedIn } from './auth.js';

/**
 * Two-step sign-in (ADR-004). Mounted at `/v1/auth/mfa`.
 *
 * `verify` and the enrolment pair accept a *partial* session — the one a
 * password sign-in hands staff who still owe a code or an enrolment — and turn
 * it into a full session with a new token. Everything that changes an existing
 * factor needs a full session and a step-up.
 */
export const mfaRoutes = new Hono();

function currentUser(userId: string, tenantId: string) {
  const user = db.select().from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.tenantId, tenantId))).get();
  if (!user) throw unauthenticated();
  return user;
}

mfaRoutes.get('/', authenticatePartial, (c) => {
  const ctx = ctxOf(c);
  if (ctx.impersonatorId) throw forbidden('Two-step sign-in belongs to the account holder, not a support session.');
  const user = currentUser(ctx.userId, ctx.tenantId);
  c.header('Cache-Control', 'no-store');
  return c.json(mfaStatus(user, ctx.mfaState ?? 'none'));
});

/** The sign-in challenge: a TOTP code or one recovery code. */
mfaRoutes.post('/verify', authenticatePartial, rateLimit(10, 60_000, { bucket: 'mfa-verify' }), validate('json', MfaVerifyInput), (c) => {
  const ctx = ctxOf(c);
  if (ctx.mfaState !== 'challenge') throw precondition('This session is not waiting for a code.');
  const user = currentUser(ctx.userId, ctx.tenantId);
  const body = c.req.valid('json');
  let recoveryCodesRemaining: number | undefined;
  if ('code' in body) verifyTotp(ctx, user, body.code);
  else recoveryCodesRemaining = useRecoveryCode(ctx, user, body.recoveryCode);
  const token = completeMfa(ctx.sessionId);
  audit(ctx, {
    action: 'auth.mfa_challenge_passed',
    entityType: 'session',
    entityId: ctx.sessionId,
    entityLabel: user.name,
    reason: 'code' in body ? 'Authenticator code' : 'Recovery code',
  });
  c.header('Cache-Control', 'no-store');
  return c.json({
    ...signedIn(c, { token, viewer: viewerFor(user.id), mfaState: 'verified' }),
    ...(recoveryCodesRemaining !== undefined ? { recoveryCodesRemaining } : {}),
  });
});

/** A new secret to scan. Allowed at the enrolment gate and, optionally, from Your account. */
mfaRoutes.post('/enrol/start', authenticatePartial, rateLimit(10, 60_000, { identity: 'actor', bucket: 'mfa-enrol' }), (c) => {
  const ctx = ctxOf(c);
  if (ctx.mfaState === 'challenge') throw precondition('Enter your current authenticator code first.');
  if (ctx.impersonatorId) throw forbidden('Two-step sign-in belongs to the account holder, not a support session.');
  const user = currentUser(ctx.userId, ctx.tenantId);
  c.header('Cache-Control', 'no-store');
  return c.json(startEnrolment(user));
});

mfaRoutes.post(
  '/enrol/confirm',
  authenticatePartial,
  rateLimit(10, 60_000, { identity: 'actor', bucket: 'mfa-enrol-confirm' }),
  validate('json', z.object({ code: TotpCode }).strict()),
  (c) => {
    const ctx = ctxOf(c);
    if (ctx.mfaState === 'challenge') throw precondition('Enter your current authenticator code first.');
    if (ctx.impersonatorId) throw forbidden('Two-step sign-in belongs to the account holder, not a support session.');
    const user = currentUser(ctx.userId, ctx.tenantId);
    const recoveryCodes = confirmEnrolment(ctx, user, c.req.valid('json').code);
    // Enrolling proves possession of the authenticator, so the session is
    // MFA-verified from here on, with a new token either way.
    const token = completeMfa(ctx.sessionId);
    c.header('Cache-Control', 'no-store');
    return c.json({ ...signedIn(c, { token, viewer: viewerFor(user.id), mfaState: 'verified' }), recoveryCodes });
  },
);

/** Ten new recovery codes; the old ones stop working. */
mfaRoutes.post('/recovery-codes', authenticate, freshAuth('auth.mfa_recovery_codes'), (c) => {
  const ctx = ctxOf(c);
  if (ctx.impersonatorId) throw forbidden('Two-step sign-in belongs to the account holder, not a support session.');
  const user = currentUser(ctx.userId, ctx.tenantId);
  c.header('Cache-Control', 'no-store');
  return c.json({ recoveryCodes: regenerateRecoveryCodes(ctx, user) });
});

/** Turn MFA off (or start moving it to a new phone, where it is required). */
mfaRoutes.delete('/', authenticate, freshAuth('auth.mfa_disable'), (c) => {
  const ctx = ctxOf(c);
  if (ctx.impersonatorId) throw forbidden('Two-step sign-in belongs to the account holder, not a support session.');
  const user = currentUser(ctx.userId, ctx.tenantId);
  return c.json(disableMfa(ctx, user));
});
