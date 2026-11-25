import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { EntitlementsInput, ImpersonateInput, MfaResetInput, TenantStatusInput } from '@shark/contracts';
import { IMPERSONATION_MINUTES } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { notFound } from '../lib/errors.js';
import { freshAuth } from '../lib/step-up.js';
import { resetMfaFor } from '../services/mfa.js';
import { setBrowserSession } from './auth.js';
import { clientIp, ctxOf, platformOnly } from '../middleware/index.js';
import { validate } from '../middleware/validate.js';
import {
  endImpersonation,
  listTenants,
  platformHealth,
  setEntitlements,
  setTenantStatus,
  startImpersonation,
  tenantDetail,
} from '../services/platform.js';

/**
 * Platform administration (PF-PLAT). Mounted by `app.ts` at `/v1/platform`.
 *
 * Every route below is behind `platformOnly`, which refuses an impersonated
 * session before it refuses a wrong role — so support cannot use a borrowed
 * gym account to re-enter the tooling their own role withholds. The one
 * exception is `impersonate/end`, which an impersonated session must be able
 * to call: it is the banner's exit, and it revokes only the caller's own
 * session.
 */
export const platformRoutes = new Hono();

/* — Customers (PF-PLAT-001, PF-PLAT-002) —————————————————— */

/* Reading the estate is gated on `platform.impersonate`, not `platform.admin`:
   support has to find the account before they can enter it, and a console that
   shows them nothing is one they would work around. Administering — status,
   entitlements, health — stays with `platform.admin` below. */
platformRoutes.get('/tenants', platformOnly('platform.impersonate'), (c) => c.json(listTenants(ctxOf(c))));

platformRoutes.get('/tenants/:tenantId', platformOnly('platform.impersonate'), (c) =>
  c.json({ tenant: tenantDetail(ctxOf(c), c.req.param('tenantId')) }),
);

platformRoutes.post('/tenants/:tenantId/status', platformOnly('platform.admin'), validate('json', TenantStatusInput), (c) =>
  c.json({ tenant: setTenantStatus(ctxOf(c), c.req.param('tenantId'), c.req.valid('json')) }),
);

platformRoutes.patch('/tenants/:tenantId/entitlements', platformOnly('platform.admin'), validate('json', EntitlementsInput), (c) =>
  c.json({ tenant: setEntitlements(ctxOf(c), c.req.param('tenantId'), c.req.valid('json')) }),
);

/* — Observability (PF-PLAT-003) ————————————————————————— */

platformRoutes.get('/health', platformOnly('platform.admin'), (c) => c.json(platformHealth(ctxOf(c))));

/* — Support access (PF-PLAT-004) ————————————————————————— */

/**
 * Starts a support session and **replaces the caller's own session cookie**
 * with the borrowed one.
 *
 * Swapping rather than holding both is deliberate. Two live cookies would mean
 * a browser tab could act as either identity depending on which it sent, and
 * "who did this" is the one question a support session must always answer the
 * same way. Coming back out is a fresh sign-in, which costs the operator ten
 * seconds and removes a whole class of ambiguity.
 */
platformRoutes.post('/impersonate', platformOnly('platform.impersonate'), freshAuth('platform.impersonate'), validate('json', ImpersonateInput), (c) => {
  const ctx = ctxOf(c);
  const requestIp = clientIp(c);
  const { session, token } = startImpersonation(
    ctx,
    c.req.valid('json'),
    requestIp === 'local' ? ctx.ip : requestIp,
    c.req.header('user-agent') ?? ctx.userAgent,
  );
  // Same flags as an ordinary sign-in, including a fresh CSRF token: the
  // borrowed session has to be able to write, and reusing the operator's token
  // against a different cookie would fail the double-submit check.
  const csrfToken = setBrowserSession(c, token, IMPERSONATION_MINUTES * 60_000);
  return c.json({ session, csrfToken });
});

/**
 * Platform-support reset of a person's two-step sign-in (ADR-004). This is
 * the *only* way an owner who lost their phone gets back in: an owner cannot
 * reset their own factor, and nobody inside the gym outranks them. Support
 * records why (the identity check they performed) and the entry lands in the
 * gym's own audit log.
 */
platformRoutes.post(
  '/tenants/:tenantId/users/:userId/mfa/reset',
  platformOnly('platform.impersonate'),
  freshAuth('platform.mfa_reset'),
  validate('json', MfaResetInput),
  (c) => {
    const ctx = ctxOf(c);
    const target = db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, c.req.param('userId')), eq(schema.users.tenantId, c.req.param('tenantId'))))
      .get();
    if (!target || target.role === 'member') throw notFound('That staff account');
    resetMfaFor(ctx, target, c.req.valid('json').reason, 'platform_support');
    return c.json({ ok: true });
  },
);

/**
 * Ends the caller's own support session.
 *
 * Not behind `platformOnly`: the caller *is* the impersonated session, and the
 * whole point of the banner is that there is always a way out of it. The
 * service refuses any session that is not an impersonation.
 */
platformRoutes.post('/impersonate/end', (c) => c.json(endImpersonation(ctxOf(c))));
