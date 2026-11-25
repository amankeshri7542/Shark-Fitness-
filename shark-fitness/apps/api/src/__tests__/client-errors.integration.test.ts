import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { setErrorReporterForTest, type ErrorReportContext } from '../lib/error-reporting.js';
import { errorHandler, rateLimit, resetRateLimitsForTest } from '../middleware/index.js';
import { CLIENT_ERROR_MAX_BYTES } from '@shark/contracts';
import { normalizeClientRoute } from '../routes/client-errors.js';
import { SENSITIVE, SENSITIVE_SENTENCE, SENSITIVE_VALUES } from './fixtures/redaction.js';

const ORIGIN = 'http://localhost:5173';
const captures: Array<{ error: { name: string; message: string; stack: string }; context: ErrorReportContext }> = [];

beforeEach(() => {
  resetRateLimitsForTest();
  captures.length = 0;
  setErrorReporterForTest({
    name: 'console',
    capture: (error, context) => captures.push({ error: error as (typeof captures)[number]['error'], context }),
    flush: async () => undefined,
  });
  // The route logs a warn line per report; keep the test output readable.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  resetRateLimitsForTest();
  setErrorReporterForTest(null);
  vi.restoreAllMocks();
});

function report(overrides: Record<string, unknown> = {}) {
  return {
    source: 'admin',
    kind: 'boundary',
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'plan')",
    stack: "TypeError: Cannot read properties of undefined\n    at MemberRow (http://localhost:5173/admin/assets/index-a1b2.js:12:345)",
    route: '/admin/members/mem_8f2k?tab=billing',
    reference: 'ref-7f3a9c21',
    release: 'local',
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request('/v1/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function signInCookie(email: string): Promise<string> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  return `shark_session=${token}`;
}

describe('POST /v1/client-errors', () => {
  it('accepts a valid report with 204 and forwards it once, tagged with its source and a collapsed route', async () => {
    const response = await post(report());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');

    expect(captures).toHaveLength(1);
    expect(captures[0]!.context).toEqual({ source: 'admin', requestId: 'ref-7f3a9c21', route: '/admin/members/:id' });
    expect(captures[0]!.error).toMatchObject({ name: 'TypeError', message: "Cannot read properties of undefined (reading 'plan')" });
    expect(captures[0]!.error.stack).toContain('MemberRow');
  });

  it('needs no session or CSRF token, and attaches only tenant and actor ids when signed in', async () => {
    const cookie = await signInCookie('aman@sharkfitness.in');
    const response = await post(report({ source: 'member', kind: 'unhandledrejection', route: '/home' }), { cookie });
    expect(response.status).toBe(204);

    const context = captures[0]!.context;
    expect(context.source).toBe('member');
    expect(context.tenantId).toMatch(/^ten_/);
    expect(context.actorId).toMatch(/^usr_/);
    expect(Object.keys(context).sort()).toEqual(['actorId', 'requestId', 'route', 'source', 'tenantId']);
  });

  it('logs the report redacted', async () => {
    const error = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await post(report({ message: `Save failed for ${SENSITIVE_SENTENCE}` }));
    expect(response.status).toBe(204);

    const logged = error.mock.calls.map((call) => String(call[0])).find((line) => line.includes('"event":"client_error"'));
    expect(logged).toBeDefined();
    for (const value of SENSITIVE_VALUES) expect(logged).not.toContain(value);
    expect(logged).toContain('ref-7f3a9c21');
  });

  it('refuses a report over 8 KB with 413, whether or not Content-Length declares it', async () => {
    const oversized = report({ stack: 'x'.repeat(CLIENT_ERROR_MAX_BYTES) });
    const declared = JSON.stringify(oversized);

    const withLength = await post(declared, { 'content-length': String(Buffer.byteLength(declared)) });
    expect(withLength.status).toBe(413);
    expect(await withLength.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });

    const streamed = await post(declared);
    expect(streamed.status).toBe(413);
    expect(captures).toHaveLength(0);
  });

  it('refuses invalid reports with 422', async () => {
    for (const body of [
      report({ source: 'website' }),
      report({ reference: 'no spaces allowed' }),
      report({ name: '' }),
      report({ cookies: SENSITIVE.sessionCookie }),
      'not json',
    ]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(captures).toHaveLength(0);
  });

  it('refuses a disallowed or missing Origin with 403', async () => {
    const foreign = await post(report(), { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);

    const missing = await app.request('/v1/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report()),
    });
    expect(missing.status).toBe(403);
    expect(captures).toHaveLength(0);
  });

  it('allows 30 reports a minute from one IP, then answers 429 with Retry-After', async () => {
    for (let index = 0; index < 30; index += 1) {
      expect((await post(report({ reference: `ref-burst-${index.toString().padStart(4, '0')}` }))).status).toBe(204);
    }
    const limited = await post(report());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(captures).toHaveLength(30);
  });
});

describe('client error helpers', () => {
  it('collapses ids, numbers and query strings out of SPA routes', () => {
    expect(normalizeClientRoute('/admin/members/mem_8f2k/billing?x=1#top')).toBe('/admin/members/:id/billing');
    expect(normalizeClientRoute('/admin/staff/usr_9a/commission')).toBe('/admin/staff/:id/commission');
    expect(normalizeClientRoute('/book/2026-11-24')).toBe('/book/2026-11-24');
    expect(normalizeClientRoute('/orders/12345')).toBe('/orders/:id');
    expect(normalizeClientRoute(undefined)).toBeUndefined();
  });

  it('budgets per signed-in tenant, and one shared anonymous budget otherwise', async () => {
    const limited = new Hono();
    limited.onError(errorHandler);
    limited.use('*', async (c, next) => {
      const tenant = c.req.header('x-test-tenant');
      if (tenant) c.set('ctx', { tenantId: tenant } as never);
      await next();
    });
    limited.post('/', rateLimit(2, 60_000, { identity: 'tenant-if-signed-in', bucket: 'test-tenant-budget' }), (c) => c.body(null, 204));
    const hit = (tenant?: string) => limited.request('/', { method: 'POST', headers: tenant ? { 'x-test-tenant': tenant } : {} });

    expect((await hit('ten_a')).status).toBe(204);
    expect((await hit('ten_a')).status).toBe(204);
    expect((await hit('ten_a')).status).toBe(429);
    expect((await hit('ten_b')).status).toBe(204);
    expect((await hit()).status).toBe(204);
    expect((await hit()).status).toBe(204);
    expect((await hit()).status).toBe(429);
  });
});
