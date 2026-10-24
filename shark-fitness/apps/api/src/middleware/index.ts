import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isIP } from 'node:net';
import { ZodError } from 'zod';
import { can } from '@shark/domain';
import { AppError } from '../lib/errors.js';
import { runtimeConfig } from '../lib/config.js';
import { id } from '../lib/ids.js';
import { SESSION_COOKIE } from '../lib/security.js';
import { resolveSession } from '../services/auth.js';
import { log, reportException } from '../lib/observability.js';
import type { RequestContext } from '../lib/context.js';

declare module 'hono' {
  interface ContextVariableMap {
    ctx: RequestContext;
    requestId: string;
  }
}

export function ctxOf(c: Context): RequestContext {
  return c.get('ctx');
}

export const requestId: MiddlewareHandler = async (c, next) => {
  const supplied = c.req.header('x-request-id');
  const rid = supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : id('req');
  c.set('requestId', rid);
  c.header('x-request-id', rid);
  await next();
};

export const logger: MiddlewareHandler = async (c, next) => {
  const started = performance.now();
  try {
    await next();
  } finally {
    const durationMs = Math.round(performance.now() - started);
    const status = c.res.status;
    const requestContext = c.get('ctx') as RequestContext | undefined;
    log(status >= 500 ? 'error' : durationMs > 400 ? 'warn' : 'info', 'http_request', {
      requestId: c.get('requestId') ?? 'unknown',
      method: c.req.method,
      route: c.req.routePath || 'unmatched',
      status,
      durationMs,
      ...(requestContext
        ? {
            tenantId: requestContext.tenantId,
            branchScope: requestContext.activeBranchId ? [requestContext.activeBranchId] : requestContext.branchIds,
            actorId: requestContext.impersonatorId ?? requestContext.userId,
          }
        : {}),
    });
  }
};

export const errorHandler = (err: unknown, c: Context): Response => {
  const requestIdValue = c.get('requestId') ?? 'unknown';

  if (err instanceof AppError) {
    if (err.retryAfterSec !== undefined) c.header('retry-after', String(err.retryAfterSec));
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.fields ? { fields: err.fields } : {}),
          ...(err.retryAfterSec !== undefined ? { retryAfterSec: err.retryAfterSec } : {}),
          ...(err.details ? { details: err.details } : {}),
          requestId: requestIdValue,
        },
      },
      err.status as 400,
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of those details need another look.',
          fields: err.errors.map((e) => ({ path: e.path.join('.'), code: e.code, message: e.message })),
          requestId: requestIdValue,
        },
      },
      422,
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('CAPACITY_EXHAUSTED')) {
    return c.json(
      { error: { code: 'CAPACITY_EXHAUSTED', message: 'That class filled up while you were deciding.', requestId: requestIdValue } },
      409,
    );
  }
  if (message.includes('UNIQUE constraint failed')) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'That already exists.', requestId: requestIdValue } },
      409,
    );
  }

  const requestContext = c.get('ctx') as RequestContext | undefined;
  reportException(err, {
    requestId: requestIdValue,
    route: c.req.routePath || 'unmatched',
    ...(requestContext
      ? {
          tenantId: requestContext.tenantId,
          branchScope: requestContext.activeBranchId ? [requestContext.activeBranchId] : requestContext.branchIds,
          actorId: requestContext.impersonatorId ?? requestContext.userId,
        }
      : {}),
  });
  return c.json(
    { error: { code: 'INTERNAL', message: 'Something went wrong on our side. The team has been notified.', requestId: requestIdValue } },
    500,
  );
};

export const authenticate: MiddlewareHandler = async (c, next) => {
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (bearer && runtimeConfig.isProduction && !runtimeConfig.allowBearerAuth) {
    throw new AppError('UNAUTHENTICATED', 'Use the secure browser session to continue.');
  }

  const cookie = getCookie(c, SESSION_COOKIE);
  const raw = bearer ?? cookie;
  if (!raw) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const ctx = resolveSession(raw);
  if (!ctx) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
  ctx.authMethod = bearer ? 'bearer' : 'cookie';

  // The branch switcher, and the only thing that narrows a request.
  //
  // Absent or empty means *no selection* — the request covers every branch the
  // caller may see. It must not fall back to a default branch: the console
  // says "All branches" precisely by sending nothing, and a server-side
  // default turns that label into a lie.
  //
  // Present but outside the caller's entitlement is refused here rather than
  // ignored. Ignoring it was the tempting reading and it is worse than an
  // error: the client asked about one branch and would be handed another
  // branch's figures under the first one's heading. A branch id the caller
  // does not hold is refused identically whether or not it exists, so this
  // leaks nothing about the tenant's shape.
  const requested = c.req.header('x-branch-id')?.trim();
  if (requested) {
    if (!ctx.branchIds.includes(requested)) {
      throw new AppError('FORBIDDEN', 'You do not have access to this branch.');
    }
    ctx.activeBranchId = requested;
  }

  ctx.requestId = c.get('requestId') ?? ctx.requestId;
  c.set('ctx', ctx);
  await next();
};

export const staffOnly: MiddlewareHandler = async (c, next) => {
  const ctx = ctxOf(c);
  if (ctx.role === 'member') throw new AppError('FORBIDDEN', 'This area is for gym staff.');
  await next();
};

/**
 * The gate on every platform route (PF-PLAT-004, PF-PLAT-006).
 *
 * Three refusals, and the order matters.
 *
 * **An impersonated session is refused outright**, whoever it is impersonating.
 * Support borrows a gym owner's view to answer a ticket; it must not be able to
 * use that borrowed session to re-enter the tooling their own role withholds,
 * and asking "but is the *impersonated* role allowed?" is the question that
 * gets this wrong the day support enters another operator's account. The
 * session's permissions are stripped as well (`resolveSession`) — this is the
 * door, that is the lock.
 *
 * **A tenant role is refused** however senior. An owner is the most powerful
 * person inside one gym and has no standing over anybody else's.
 *
 * **Then, and only then, the permission is checked.**
 *
 * Cross-tenant reads exist nowhere else in this product. Every other service
 * filters on `ctx.tenantId`; the platform service is the single place allowed
 * to look past it, and this middleware is what makes that safe to say.
 */
export function platformOnly(permission: 'platform.admin' | 'platform.impersonate'): MiddlewareHandler {
  return async (c, next) => {
    const ctx = ctxOf(c);

    if (ctx.impersonatorId) {
      throw new AppError('FORBIDDEN', 'Platform tools are not available inside a support session. End it first.');
    }
    if (ctx.role !== 'platform_admin' && ctx.role !== 'platform_support') {
      // Deliberately the same answer a wrong permission gets: whether this
      // deployment has a platform console at all is not a tenant's business.
      throw new AppError('FORBIDDEN', 'Your role does not include this action.');
    }
    if (!can(ctx.role, permission)) {
      throw new AppError('FORBIDDEN', 'Your role does not include this action.');
    }
    await next();
  };
}

export const memberOnly: MiddlewareHandler = async (c, next) => {
  const ctx = ctxOf(c);
  if (!ctx.memberId) throw new AppError('FORBIDDEN', 'This area is for members.');
  await next();
};

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitStore {
  buckets: Map<string, RateLimitBucket>;
  overflow: RateLimitBucket | null;
  requestsSinceCleanup: number;
}

export interface RateLimitOptions {
  /** IP for public boundaries; actor/tenant require `authenticate` first. */
  identity?: 'ip' | 'actor' | 'tenant';
  /** A stable bucket joins paths into one budget and avoids id-based bypasses. */
  bucket?: string;
  /** Override only for isolated middleware tests; runtime uses boot config. */
  trustedProxyHops?: number;
}

/** One hostile header stream cannot grow a limiter Map without bound. */
export const RATE_LIMIT_MAX_IDENTITIES = 2_048;
const RATE_LIMIT_CLEANUP_INTERVAL = 128;
const rateLimitStores = new Set<RateLimitStore>();

function clearExpiredBuckets(store: RateLimitStore, atMs: number): void {
  for (const [key, bucket] of store.buckets) {
    if (bucket.resetAt <= atMs) store.buckets.delete(key);
  }
  if (store.overflow && store.overflow.resetAt <= atMs) store.overflow = null;
}

export function clientIpFromAddresses(
  directAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedProxyHops: number,
): string {
  const direct = directAddress && isIP(directAddress) ? directAddress : 'local';
  if (trustedProxyHops === 0 || !forwardedFor) return direct;

  const forwarded = forwardedFor.split(',').map((value) => value.trim()).filter(Boolean);
  const candidate = forwarded[forwarded.length - trustedProxyHops];
  return candidate && isIP(candidate) ? candidate : direct;
}

export function clientIp(c: Context, trustedProxyHops = runtimeConfig.trustedProxyHops): string {
  let directAddress: string | undefined;
  try {
    directAddress = getConnInfo(c)?.remote.address;
  } catch {
    // `app.request()` has no Node socket. Production requests do; tests and
    // non-Node adapters safely collapse to the local fallback.
  }
  return clientIpFromAddresses(directAddress, c.req.header('x-forwarded-for'), trustedProxyHops);
}

function identityFor(c: Context, identity: 'ip' | 'actor' | 'tenant', trustedProxyHops: number): string {
  if (identity === 'actor' || identity === 'tenant') {
    const ctx = c.get('ctx') as RequestContext | undefined;
    if (!ctx) throw new Error('Authenticated rate limiting must run after authentication.');
    return identity === 'tenant' ? ctx.tenantId : `${ctx.tenantId}:${ctx.impersonatorId ?? ctx.userId}`;
  }
  return clientIp(c, trustedProxyHops);
}

export function rateLimit(max: number, windowMs: number, options: RateLimitOptions = {}): MiddlewareHandler {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('Rate-limit max must be a positive integer.');
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new RangeError('Rate-limit window must be positive.');
  const trustedProxyHops = options.trustedProxyHops ?? runtimeConfig.trustedProxyHops;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) {
    throw new RangeError('trustedProxyHops must be an integer from 0 to 5.');
  }
  const store: RateLimitStore = { buckets: new Map(), overflow: null, requestsSinceCleanup: 0 };
  rateLimitStores.add(store);

  return async (c: Context, next: Next) => {
    const nowMs = Date.now();
    store.requestsSinceCleanup += 1;
    if (store.requestsSinceCleanup >= RATE_LIMIT_CLEANUP_INTERVAL) {
      clearExpiredBuckets(store, nowMs);
      store.requestsSinceCleanup = 0;
    }

    const identity = identityFor(c, options.identity ?? 'ip', trustedProxyHops);
    const key = `${options.bucket ?? c.req.path}:${identity}`;
    let bucket = store.buckets.get(key);
    if (bucket && bucket.resetAt <= nowMs) {
      store.buckets.delete(key);
      bucket = undefined;
    }

    if (!bucket) {
      if (store.buckets.size >= RATE_LIMIT_MAX_IDENTITIES) clearExpiredBuckets(store, nowMs);
      if (store.buckets.size < RATE_LIMIT_MAX_IDENTITIES) {
        bucket = { count: 0, resetAt: nowMs + windowMs };
        store.buckets.set(key, bucket);
      } else {
        // Fail boundedly under high-cardinality input. New identities share a
        // single fixed bucket instead of allocating attacker-controlled keys.
        if (!store.overflow || store.overflow.resetAt <= nowMs) {
          store.overflow = { count: 0, resetAt: nowMs + windowMs };
        }
        bucket = store.overflow;
      }
    }

    if (bucket && bucket.count >= max) {
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again shortly.', {
        retryAfterSec: Math.ceil((bucket.resetAt - nowMs) / 1000),
      });
    }
    if (bucket) {
      bucket.count += 1;
    }
    await next();
  };
}

/** Reset/introspection for deterministic integration tests only. */
export function resetRateLimitsForTest(): void {
  for (const store of rateLimitStores) {
    store.buckets.clear();
    store.overflow = null;
    store.requestsSinceCleanup = 0;
  }
}

export function rateLimitBucketCountForTest(): number {
  let count = 0;
  for (const store of rateLimitStores) count += store.buckets.size;
  return count;
}
