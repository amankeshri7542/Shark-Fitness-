import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.js';
import { CSP_REPORT_PATH, PAYMENT_CHECKOUT_SOURCES, cspFor, cspHeaderName, surfaceForPath } from '../lib/csp.js';
import { setErrorReporterForTest, type ErrorReportContext } from '../lib/error-reporting.js';
import { resetRateLimitsForTest } from '../middleware/index.js';

/** PRD 04 §10.1 "Content Security Policy": per-surface headers and the report intake. */

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name!, values];
    }),
  );
}

async function headersFor(path: string) {
  const response = await app.request(path);
  return {
    csp: response.headers.get('content-security-policy') ?? '',
    permissions: response.headers.get('permissions-policy') ?? '',
  };
}

const COMMON: Record<string, string[]> = {
  'default-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'report-uri': [CSP_REPORT_PATH],
};

describe('per-surface Content-Security-Policy', () => {
  it('classifies paths by the bundle they serve', () => {
    expect(surfaceForPath('/admin/')).toBe('admin');
    expect(surfaceForPath('/admin/members/mbr_1')).toBe('admin');
    expect(surfaceForPath('/app/')).toBe('member');
    expect(surfaceForPath('/')).toBe('member'); // the website takes `/` in P03
    expect(surfaceForPath('/v1/me')).toBe('api');
    expect(surfaceForPath('/health')).toBe('api');
  });

  it('gives the console the strict baseline, no payment origins, and the camera', async () => {
    const { csp, permissions } = await headersFor('/admin/members');
    const policy = directives(csp);
    for (const [name, values] of Object.entries(COMMON)) expect(policy.get(name), name).toEqual(values);
    expect(policy.get('script-src')).toEqual(["'self'"]);
    expect(policy.get('frame-src')).toEqual(["'none'"]);
    expect(policy.get('connect-src')?.[0]).toBe("'self'");
    expect(policy.get('connect-src')).toContain('ws://localhost:5174');
    expect(csp).not.toContain('razorpay');
    expect(permissions).toBe('camera=(self), microphone=(), geolocation=()');
  });

  it('lets the member app load and frame Razorpay Checkout, and nothing else', async () => {
    for (const path of ['/', '/app/billing']) {
      const { csp, permissions } = await headersFor(path);
      const policy = directives(csp);
      for (const [name, values] of Object.entries(COMMON)) expect(policy.get(name), `${path} ${name}`).toEqual(values);
      expect(policy.get('script-src')).toEqual(["'self'", 'https://checkout.razorpay.com']);
      expect(policy.get('frame-src')).toEqual(['https://api.razorpay.com', 'https://checkout.razorpay.com']);
      for (const origin of PAYMENT_CHECKOUT_SOURCES.connect) expect(policy.get('connect-src')).toContain(origin);
      expect(policy.get('worker-src')).toEqual(["'self'"]);
      expect(policy.get('manifest-src')).toEqual(["'self'"]);
      expect(permissions).toBe('camera=(), microphone=(), geolocation=()');
    }
  });

  it('keeps the public website free of payment origins and sockets', () => {
    const policy = directives(cspFor('website'));
    expect(policy.get('script-src')).toEqual(["'self'"]);
    expect(policy.get('connect-src')).toEqual(["'self'"]);
    expect(policy.get('frame-src')).toEqual(["'none'"]);
  });

  it('makes API responses inert', async () => {
    const { csp } = await headersFor('/v1/auth/tenants');
    expect(directives(csp).get('default-src')).toEqual(["'none'"]);
    expect(directives(csp).get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('never allows inline code, eval or wildcards on any surface', () => {
    for (const surface of ['admin', 'member', 'website', 'api'] as const) {
      const policy = cspFor(surface);
      expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|\*/);
    }
  });

  it('can be switched to report-only for a rollout', () => {
    expect(cspHeaderName(false)).toBe('content-security-policy');
    expect(cspHeaderName(true)).toBe('content-security-policy-report-only');
  });
});

describe('POST /v1/csp-reports', () => {
  const captured: Array<{ error: Error; context: ErrorReportContext }> = [];
  beforeEach(() => {
    resetRateLimitsForTest();
    captured.length = 0;
    setErrorReporterForTest({ name: 'console', capture: (error, context) => captured.push({ error: error as Error, context }), flush: async () => undefined });
  });
  afterEach(() => {
    setErrorReporterForTest(null);
    vi.restoreAllMocks();
  });

  const legacy = {
    'csp-report': {
      'document-uri': 'https://gym.example/admin/members?q=aman%40example.com',
      'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'https://evil.example/x.js?token=abc',
      'source-file': 'https://gym.example/admin/assets/index-abc.js',
      disposition: 'enforce',
    },
  };

  it('accepts a browser report without CSRF token or Origin, and forwards a redacted summary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await app.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report', cookie: 'shark_session=whatever' },
      body: JSON.stringify(legacy),
    });
    expect(response.status).toBe(204);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.error.name).toBe('CspViolation');
    expect(captured[0]!.error.message).toBe('CSP enforce: script-src-elem blocked https://evil.example on /admin/members');
    expect(captured[0]!.context.source).toBe('csp');
    const line = warn.mock.calls.map((call) => String(call[0])).find((text) => text.includes('csp_violation'))!;
    expect(line).toContain('"blocked":"https://evil.example"');
    expect(line).not.toContain('token=abc');
    expect(line).not.toContain('aman');
  });

  it('understands the Reporting API batch format', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await app.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/reports+json' },
      body: JSON.stringify([
        { type: 'csp-violation', body: { documentURL: 'https://gym.example/', effectiveDirective: 'style-src-attr', blockedURL: 'inline', disposition: 'report' } },
        { type: 'deprecation', body: {} },
      ]),
    });
    expect(response.status).toBe(204);
    expect(captured.map((entry) => entry.error.message)).toEqual(['CSP report: style-src-attr blocked inline on /']);
  });

  it('refuses oversized bodies and rate-limits a flood', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const big = await app.request(CSP_REPORT_PATH, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
    // No Content-Length (chunked): reading stops at the cap. The stream never
    // ends, so without the cap this request would hang until the test timed out.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(4096)));
      },
    });
    const chunked = await app.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: endless,
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    let status = 204;
    for (let index = 0; index < 61 && status !== 429; index += 1) {
      status = (await app.request(CSP_REPORT_PATH, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: '{}' })).status;
    }
    expect(status).toBe(429);
  });
});
