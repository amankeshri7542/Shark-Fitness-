import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { AppError } from './errors.js';
import { token } from './ids.js';

export const SESSION_COOKIE = 'shark_session';
export const CSRF_COOKIE = 'shark_csrf';

const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

export function allowedOrigins(): Set<string> {
  const configured = (process.env.SHARK_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const publicOrigin = process.env.SHARK_PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
  if (publicOrigin) configured.push(publicOrigin);
  if (!isProduction()) configured.push(...LOCAL_ORIGINS);

  return new Set(configured);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return allowedOrigins().has(origin.replace(/\/$/, ''));
}

export function csrfTokenFrom(c: Context): string | undefined {
  return getCookie(c, CSRF_COOKIE);
}

export function issueCsrfCookie(c: Context): string {
  const value = token(24);
  setCookie(c, CSRF_COOKIE, value, {
    httpOnly: false,
    secure: isProduction(),
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return value;
}

export function clearCsrfCookie(c: Context): void {
  setCookie(c, CSRF_COOKIE, '', {
    httpOnly: false,
    secure: isProduction(),
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

  const origin = c.req.header('origin');
  if (!isAllowedOrigin(origin)) {
    throw new AppError('FORBIDDEN', 'This request did not come from an allowed Shark Fitness app.');
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
  c.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  c.header('cross-origin-opener-policy', 'same-origin');
  c.header('cross-origin-resource-policy', 'same-site');
  if (isProduction()) {
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
};
