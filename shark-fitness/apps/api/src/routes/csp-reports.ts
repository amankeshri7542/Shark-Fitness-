import { Hono } from 'hono';
import { captureException } from '../lib/error-reporting.js';
import { log } from '../lib/observability.js';
import { rateLimit } from '../middleware/index.js';

/**
 * `POST /v1/csp-reports` — where browsers send Content-Security-Policy
 * violations (`report-uri` and the Reporting API's `report-to`).
 *
 * A violation is either an attack being stopped or the product breaking
 * itself (a new third party nobody added to lib/csp.ts), and both are worth
 * an alert, so each report is logged and forwarded to the error reporter.
 * Public by necessity — the browser sends it without a CSRF token and often
 * without an Origin — so it is capped at 16 KB, rate-limited per IP, keeps
 * nothing, and passes on only the directive and the *origin* of what was
 * blocked, never a full URL with its query string.
 */
export const cspReportRoutes = new Hono();

const MAX_BYTES = 16_384;

interface Violation {
  directive: string;
  blocked: string;
  page: string;
  source: string | null;
  disposition: string;
}

function origin(value: unknown): string {
  if (typeof value !== 'string' || value === '') return 'unknown';
  if (['inline', 'eval', 'data', 'blob', 'self', 'wasm-eval', 'trusted-types-policy'].includes(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'data:' || url.protocol === 'blob:' ? url.protocol.slice(0, -1) : url.origin;
  } catch {
    return value.slice(0, 40);
  }
}

function path(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  try {
    return new URL(value).pathname.slice(0, 200);
  } catch {
    return 'unknown';
  }
}

function fromBody(body: Record<string, unknown>): Violation {
  const pick = (...keys: string[]) => keys.map((key) => body[key]).find((value) => value !== undefined);
  const sourceFile = pick('source-file', 'sourceFile');
  return {
    directive: String(pick('effective-directive', 'effectiveDirective', 'violated-directive') ?? 'unknown').split(' ')[0]!.slice(0, 40),
    blocked: origin(pick('blocked-uri', 'blockedURL')),
    page: path(pick('document-uri', 'documentURL')),
    source: sourceFile ? origin(sourceFile) : null,
    disposition: String(pick('disposition') ?? 'enforce').slice(0, 12),
  };
}

/** Both wire formats: `{ "csp-report": {…} }` and a Reporting API array. */
export function parseCspReports(text: string): Violation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const violations: Violation[] = [];
  for (const item of items.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const legacy = record['csp-report'];
    if (legacy && typeof legacy === 'object') violations.push(fromBody(legacy as Record<string, unknown>));
    else if (record.type === 'csp-violation' && record.body && typeof record.body === 'object') {
      violations.push(fromBody(record.body as Record<string, unknown>));
    }
  }
  return violations;
}

class CspViolation extends Error {
  constructor(violation: Violation) {
    super(`CSP ${violation.disposition}: ${violation.directive} blocked ${violation.blocked} on ${violation.page}`);
    this.name = 'CspViolation';
  }
}

cspReportRoutes.post('/', rateLimit(60, 60_000, { bucket: 'csp-reports' }), async (c) => {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_BYTES) return c.body(null, 413);
  const text = await c.req.text();
  if (text.length > MAX_BYTES) return c.body(null, 413);
  for (const violation of parseCspReports(text)) {
    log('warn', 'csp_violation', { ...violation });
    captureException(new CspViolation(violation), { source: 'csp', route: violation.page, requestId: c.get('requestId') });
  }
  return c.body(null, 204);
});
