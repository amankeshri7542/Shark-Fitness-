import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { audit } from './audit.js';
import type { RequestContext } from './context.js';
import { AppError } from './errors.js';
import { now } from './time.js';

/**
 * Step-up authentication (PRD 01 §2.4, PRD 02 "Authorization sequence" step 6,
 * PRD 04 ENT-IAM-003).
 *
 * A high-risk action needs the person to have proved their password — and
 * their TOTP code, when they have one — within the last five minutes. Signing
 * in counts as a proof, so the first refund after signing in does not ask
 * twice. The console answers `STEP_UP_REQUIRED` with one re-check dialog and
 * retries the original request with the same idempotency key.
 *
 * Call it at the top of a handler, before any transaction: the refusal is
 * audited, and an audit row written inside a transaction that then throws
 * would be rolled back with it.
 */

export const STEP_UP_MAX_AGE_SEC = 300;

/** Who has to re-prove: during a support session, the operator, not the gym owner. */
export function stepUpUserId(ctx: RequestContext): string {
  return ctx.impersonatorId ?? ctx.userId;
}

function needsTotp(userId: string): boolean {
  return Boolean(db.select({ confirmedAt: schema.userMfa.confirmedAt }).from(schema.userMfa).where(eq(schema.userMfa.userId, userId)).get()?.confirmedAt);
}

export function hasFreshAuth(ctx: RequestContext, maxAgeSec = STEP_UP_MAX_AGE_SEC): boolean {
  const at = ctx.reauthenticatedAt;
  return typeof at === 'number' && now() - at <= maxAgeSec * 1000;
}

/**
 * Throws 401 `STEP_UP_REQUIRED` unless the session re-authenticated within
 * `maxAgeSec`. `action` names what was attempted (`billing.refund`) and is the
 * only detail recorded about the attempt: never the request body.
 */
export function requireFreshAuth(ctx: RequestContext, action: string, maxAgeSec = STEP_UP_MAX_AGE_SEC): void {
  if (hasFreshAuth(ctx, maxAgeSec)) return;
  audit(ctx, {
    action: 'auth.step_up_required',
    entityType: 'session',
    entityId: ctx.sessionId,
    entityLabel: action,
    reason: `Held until the person re-authenticates: ${action}`,
  });
  throw new AppError('STEP_UP_REQUIRED', 'For your security, confirm it’s you before doing this.', {
    details: { mfa: needsTotp(stepUpUserId(ctx)), maxAgeSec, action },
  });
}

/** The same check as route middleware, for routes that are high-risk whatever the body. */
export function freshAuth(action: string, maxAgeSec = STEP_UP_MAX_AGE_SEC): MiddlewareHandler {
  return async (c, next) => {
    requireFreshAuth(c.get('ctx'), action, maxAgeSec);
    await next();
  };
}
