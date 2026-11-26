import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { runtimeConfig } from './config.js';
import { AppError } from './errors.js';
import { token } from './ids.js';

export const SESSION_COOKIE = 'shark_session';
export const CSRF_COOKIE = 'shark_csrf';

const CONFIGURED_ORIGINS = new Set(runtimeConfig.allowedOrigins);

export function allowedOrigins(): Set<string> {
  return new Set(CONFIGURED_ORIGINS);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return CONFIGURED_ORIGINS.has(origin.replace(/\/$/, ''));
}

export function csrfTokenFrom(c: Context): string | undefined {
  return getCookie(c, CSRF_COOKIE);
}

export function issueCsrfCookie(c: Context): string {
  const value = token(24);
  setCookie(c, CSRF_COOKIE, value, {
    httpOnly: false,
    secure: runtimeConfig.isProduction,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return value;
}

export function clearCsrfCookie(c: Context): void {
  setCookie(c, CSRF_COOKIE, '', {
    httpOnly: false,
    secure: runtimeConfig.isProduction,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  });
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * The endpoints that establish a session, for which the strict Origin check is
 * the CSRF boundary.
 *
 * They cannot also demand a double-submit token. A browser holding a
 * `shark_session` cookie the server has since forgotten would otherwise be
 * refused here, before the handler that would have replaced the dead session
 * ever runs — locking the user out of signing back in for as long as the cookie
 * survives, with a message ("refresh the page") that cannot clear a cookie.
 *
 * That state is the norm rather than an edge case on the demo deployment: the
 * database lives on ephemeral storage, so every spin-down cycle forgets every
 * session while browsers keep their cookies. The client also stores its token
 * in per-tab sessionStorage, so a second tab reaches the same dead end.
 */
const SESSION_ENTRY_PATHS = new Set(['/v1/auth/password', '/v1/auth/otp/start', '/v1/auth/otp/verify', '/v1/auth/activation/redeem', '/v1/auth/recovery/redeem']);

/**
 * Public, write-only endpoints that never act on the session. The browser
 * error reporter has to reach /v1/client-errors even when the page crashed
 * before it could read its CSRF token, so the Origin check is its boundary;
 * the route itself also demands an Origin header.
 */
const CSRF_TOKEN_EXEMPT_PATHS = new Set(['/v1/client-errors']);

/**
 * Server-to-server provider webhooks. They carry no cookie and no Origin, and
 * act on nothing a browser session could; each handler authenticates the
 * request by verifying the provider's signature over the raw body.
 */
const WEBHOOK_PATH_PREFIX = '/v1/webhooks/';

/**
 * Rejects cross-origin unsafe requests and requires a double-submit token for
 * browser sessions. Login endpoints do not have a session cookie yet, so the
 * strict Origin check is their CSRF boundary.
 */
export const csrfProtection: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }

  if (c.req.path.startsWith(WEBHOOK_PATH_PREFIX)) {
    await next();
    return;
  }

  const origin = c.req.header('origin');
  if (!isAllowedOrigin(origin)) {
    throw new AppError('FORBIDDEN', 'This request did not come from an allowed Shark Fitness app.');
  }

  if (SESSION_ENTRY_PATHS.has(c.req.path) || CSRF_TOKEN_EXEMPT_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  const session = getCookie(c, SESSION_COOKIE);
  if (!session) {
    await next();
    return;
  }

  const cookieToken = getCookie(c, CSRF_COOKIE);
  const headerToken = c.req.header('x-csrf-token');
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    throw new AppError('FORBIDDEN', 'Refresh the page and try that action again.');
  }

  await next();
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('x-frame-options', 'DENY');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
  // Reception scans member passes with the console's camera (UX-A08), so the
  // console's own documents may ask for it. Nothing else may: the member app
  // and every API response keep the camera off.
  const consoleDocument = c.req.path === '/admin' || c.req.path.startsWith('/admin/');
  c.header('permissions-policy', `camera=${consoleDocument ? '(self)' : '()'}, microphone=(), geolocation=()`);
  c.header('cross-origin-opener-policy', 'same-origin');
  c.header('cross-origin-resource-policy', 'same-site');
  if (runtimeConfig.isProduction) {
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
};
