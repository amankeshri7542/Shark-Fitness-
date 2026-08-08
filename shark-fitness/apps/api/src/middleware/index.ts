import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { resolveSession } from '../services/auth.js';
import type { RequestContext } from '../lib/context.js';

declare module 'hono' {
  interface ContextVariableMap {
    ctx: RequestContext;
    requestId: string;
  }
}

export const SESSION_COOKIE = 'shark_session';

export function ctxOf(c: Context): RequestContext {
  return c.get('ctx');
}

/** Correlation id on every request, echoed in the error envelope and the log. */
export const requestId: MiddlewareHandler = async (c, next) => {
  const rid = c.req.header('x-request-id') ?? id('req');
  c.set('requestId', rid);
  c.header('x-request-id', rid);
  await next();
};

export const logger: MiddlewareHandler = async (c, next) => {
  const started = performance.now();
  await next();
  const ms = Math.round(performance.now() - started);
  const line = `${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`;
  if (c.res.status >= 500) console.error(`[api] ${line}`);
  else if (ms > 400) console.warn(`[api] ${line} (slow)`);
  else console.log(`[api] ${line}`);
};

/** Turns anything thrown into the one error envelope (Engineering PRD §9.2). */
export const errorHandler = (err: unknown, c: Context): Response => {
  const requestIdValue = c.get('requestId') ?? 'unknown';

  if (err instanceof AppError) {
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
          fields: err.errors.map((e) => ({
            path: e.path.join('.'),
            code: e.code,
            message: e.message,
          })),
          requestId: requestIdValue,
        },
      },
      422,
    );
  }

  // Database guards surface as opaque driver errors; translate the ones that
  // represent a real business outcome rather than a bug.
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('CAPACITY_EXHAUSTED')) {
    return c.json(
      {
        error: {
          code: 'CAPACITY_EXHAUSTED',
          message: 'That class filled up while you were deciding.',
          requestId: requestIdValue,
        },
      },
      409,
    );
  }
  if (message.includes('UNIQUE constraint failed')) {
    return c.json(
      {
        error: {
          code: 'CONFLICT',
          message: 'That already exists.',
          requestId: requestIdValue,
        },
      },
      409,
    );
  }

  console.error(`[api] unhandled ${requestIdValue}`, err);
  return c.json(
    {
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong on our side. The team has been notified.',
        requestId: requestIdValue,
      },
    },
    500,
  );
};

/** Requires a session. Routes mounted behind this can rely on `ctx`. */
export const authenticate: MiddlewareHandler = async (c, next) => {
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const raw = bearer ?? getCookie(c, SESSION_COOKIE);

  if (!raw) {
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  }

  const ctx = resolveSession(raw);
  if (!ctx) {
    throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
  }

  // The branch switcher sends the active scope; it must still be one the
  // actor is allowed to see.
  const requested = c.req.header('x-branch-id');
  if (requested && ctx.branchIds.includes(requested)) {
    ctx.activeBranchId = requested;
  }

  ctx.requestId = c.get('requestId') ?? ctx.requestId;
  c.set('ctx', ctx);
  await next();
};

/** Staff-only surface. Members get the same 403 whatever they asked for. */
export const staffOnly: MiddlewareHandler = async (c, next) => {
  const ctx = ctxOf(c);
  if (ctx.role === 'member') {
    throw new AppError('FORBIDDEN', 'This area is for gym staff.');
  }
  await next();
};

/** Members must have a member record; staff browsing member routes do not. */
export const memberOnly: MiddlewareHandler = async (c, next) => {
  const ctx = ctxOf(c);
  if (!ctx.memberId) {
    throw new AppError('FORBIDDEN', 'This area is for members.');
  }
  await next();
};

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Coarse per-identity limiter. Real deployments use the platform's own. */
export function rateLimit(max: number, windowMs: number): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const key = `${c.req.path}:${c.req.header('x-forwarded-for') ?? 'local'}`;
    const bucket = buckets.get(key);
    const nowMs = Date.now();

    if (!bucket || bucket.resetAt < nowMs) {
      buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    } else if (bucket.count >= max) {
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again shortly.', {
        retryAfterSec: Math.ceil((bucket.resetAt - nowMs) / 1000),
      });
    } else {
      bucket.count += 1;
    }
    await next();
  };
}
