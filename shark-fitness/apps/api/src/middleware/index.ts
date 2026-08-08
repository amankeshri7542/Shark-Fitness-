import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import { SESSION_COOKIE } from '../lib/security.js';
import { resolveSession } from '../services/auth.js';
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

  console.error(`[api] unhandled ${requestIdValue}`, err);
  return c.json(
    { error: { code: 'INTERNAL', message: 'Something went wrong on our side. The team has been notified.', requestId: requestIdValue } },
    500,
  );
};

export const authenticate: MiddlewareHandler = async (c, next) => {
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (bearer && process.env.NODE_ENV === 'production' && process.env.SHARK_ALLOW_BEARER_AUTH !== 'true') {
    throw new AppError('UNAUTHENTICATED', 'Use the secure browser session to continue.');
  }

  const cookie = getCookie(c, SESSION_COOKIE);
  const raw = bearer ?? cookie;
  if (!raw) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

  const ctx = resolveSession(raw);
  if (!ctx) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
  ctx.authMethod = bearer ? 'bearer' : 'cookie';

  const requested = c.req.header('x-branch-id');
  if (requested && ctx.branchIds.includes(requested)) ctx.activeBranchId = requested;

  ctx.requestId = c.get('requestId') ?? ctx.requestId;
  c.set('ctx', ctx);
  await next();
};

export const staffOnly: MiddlewareHandler = async (c, next) => {
  const ctx = ctxOf(c);
  if (ctx.role === 'member') throw new AppError('FORBIDDEN', 'This area is for gym staff.');
  await next();
};

export const memberOnly: MiddlewareHandler = async (c, next) => {
  const ctx = ctxOf(c);
  if (!ctx.memberId) throw new AppError('FORBIDDEN', 'This area is for members.');
  await next();
};

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(max: number, windowMs: number): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const key = `${c.req.path}:${c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'}`;
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
