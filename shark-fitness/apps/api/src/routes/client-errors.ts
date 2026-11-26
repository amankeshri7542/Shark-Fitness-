import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { CLIENT_ERROR_MAX_BYTES, ClientErrorReport } from '@shark/contracts';
import { AppError } from '../lib/errors.js';
import { captureException } from '../lib/error-reporting.js';
import { log } from '../lib/observability.js';
import { SESSION_COOKIE, allowedOrigins } from '../lib/security.js';
import { rateLimit } from '../middleware/index.js';
import { validate } from '../middleware/validate.js';
import { resolveSession } from '../services/auth.js';

/**
 * Browser error intake for the member app and the staff console.
 *
 * Public on purpose: a crash can happen before sign-in, or because the
 * session broke. What keeps it from being an open relay into the team's error
 * tracker: a known Origin is required (not just tolerated), bodies are capped
 * at 8 KB and validated, and it is rate-limited per IP and per tenant. The
 * report is redacted by the same code that handles server errors, and only
 * the session's tenant and user ids are attached — never the page's data.
 */
export const clientErrorRoutes = new Hono();

const requireKnownOrigin: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')?.replace(/\/$/, '');
  if (!origin || !allowedOrigins().has(origin)) {
    throw new AppError('FORBIDDEN', 'This request did not come from an allowed Shark Fitness app.');
  }
  await next();
};

/** Attaches the caller's session when there is a valid one; never refuses. */
const optionalSession: MiddlewareHandler = async (c, next) => {
  const raw = getCookie(c, SESSION_COOKIE);
  const ctx = raw ? resolveSession(raw) : null;
  if (ctx) {
    ctx.requestId = c.get('requestId') ?? ctx.requestId;
    c.set('ctx', ctx);
  }
  await next();
};

/**
 * Reads at most `maxBytes` of body, whether or not Content-Length was sent,
 * and hands the buffered copy on so the JSON validator can parse it.
 */
export function capBody(maxBytes: number, message = `Error reports are limited to ${maxBytes / 1024} KB.`): MiddlewareHandler {
  const tooLarge = () => new AppError('PAYLOAD_TOO_LARGE', message);
  return async (c, next) => {
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
      c.req.raw = new Request(c.req.raw, { body: Buffer.concat(chunks), duplex: 'half' } as RequestInit);
    }
    await next();
  };
}

/** `/admin/members/mem_8f2k` → `/admin/members/:id`; query and hash dropped. */
export function normalizeClientRoute(route: string | undefined): string | undefined {
  if (!route) return undefined;
  const path = route.split(/[?#]/)[0] ?? '';
  return path
    .split('/')
    .map((segment) => (/^[a-z]{2,6}_[A-Za-z0-9_-]+$/.test(segment) || /^\d+$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) ? ':id' : segment))
    .join('/')
    .slice(0, 200);
}

clientErrorRoutes.post(
  '/',
  rateLimit(30, 60_000, { identity: 'ip', bucket: 'client-errors-ip' }),
  requireKnownOrigin,
  optionalSession,
  rateLimit(300, 60_000, { identity: 'tenant-if-signed-in', bucket: 'client-errors-tenant' }),
  capBody(CLIENT_ERROR_MAX_BYTES),
  validate('json', ClientErrorReport),
  (c) => {
    const report = c.req.valid('json');
    const ctx = c.get('ctx') as { tenantId: string; userId: string; impersonatorId?: string | null } | undefined;
    const route = normalizeClientRoute(report.route);

    log('warn', 'client_error', {
      source: report.source,
      kind: report.kind,
      reference: report.reference,
      route,
      errorName: report.name,
      errorMessage: report.message,
      clientRelease: report.release,
      ...(ctx ? { tenantId: ctx.tenantId, actorId: ctx.impersonatorId ?? ctx.userId } : {}),
    });
    captureException(
      { name: report.name, message: report.message, stack: report.stack ?? '' },
      {
        source: report.source,
        requestId: report.reference,
        ...(route ? { route } : {}),
        ...(ctx ? { tenantId: ctx.tenantId, actorId: ctx.impersonatorId ?? ctx.userId } : {}),
      },
    );
    return c.body(null, 204);
  },
);
