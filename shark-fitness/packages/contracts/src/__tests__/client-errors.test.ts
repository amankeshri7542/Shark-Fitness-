import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ERROR_MAX_BYTES,
  ClientErrorReport,
  buildClientErrorReport,
  createClientErrorReporter,
  errorFingerprint,
  newErrorReference,
} from '../schemas/client-errors.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}

const crash = (message: string) => {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    at MemberRow (https://gym.example/admin/assets/index-a1b2.js?v=3:12:345)\n    at render (https://gym.example/admin/assets/react-vendor.js:1:2)`;
  return error;
};

describe('error fingerprints and references', () => {
  it('gives one bug one fingerprint, ignoring numbers, columns and query strings', () => {
    const a = crash('Row 12 has no plan');
    const b = crash('Row 40 has no plan');
    b.stack = b.stack!.replace('?v=3:12:345', '?v=4:12:999');
    expect(errorFingerprint(a.name, a.message, a.stack)).toBe(errorFingerprint(b.name, b.message, b.stack));
    expect(errorFingerprint('TypeError', 'Other failure', a.stack)).not.toBe(errorFingerprint(a.name, a.message, a.stack));
    expect(errorFingerprint('TypeError', 'x')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('issues readable references the API accepts', () => {
    const reference = newErrorReference();
    expect(reference).toMatch(/^ERR-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(newErrorReference()).not.toBe(reference);
  });
});

describe('buildClientErrorReport', () => {
  it('produces a payload the API schema accepts, even for thrown non-errors', () => {
    for (const thrown of [crash('boom'), 'a string', { code: 42 }, null]) {
      const report = buildClientErrorReport({ source: 'member', kind: 'error', error: thrown, reference: 'ERR-AAAA-BBBB', route: '/home' });
      expect(ClientErrorReport.safeParse(report).success).toBe(true);
    }
  });

  it('trims the stack until the body fits the 8 KB limit', () => {
    const error = crash('huge');
    error.stack = Array.from({ length: 400 }, (_, index) => `    at frame${index} (https://gym.example/assets/a.js:1:${index})`).join('\n');
    const report = buildClientErrorReport({ source: 'admin', kind: 'boundary', error, reference: 'ERR-AAAA-BBBB' });
    expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(CLIENT_ERROR_MAX_BYTES);
    expect(report.stack).toContain('frame0');
    expect(ClientErrorReport.safeParse(report).success).toBe(true);
  });
});

describe('createClientErrorReporter', () => {
  it('sends once per fingerprint per session and keeps the same reference', async () => {
    const send = vi.fn(async () => undefined);
    const storage = memoryStorage();
    const reporter = createClientErrorReporter({ source: 'admin', endpoint: '/v1/client-errors', storage, send, route: () => '/admin/members' });

    const shown = reporter.referenceFor(crash('Row 1 has no plan'));
    const first = reporter.report(crash('Row 1 has no plan'), 'boundary');
    const again = reporter.report(crash('Row 2 has no plan'), 'boundary');
    const other = reporter.report(crash('Different bug'), 'error');
    await Promise.resolve();
    await Promise.resolve();

    expect(first).toEqual({ reference: shown, sent: true });
    expect(again).toEqual({ reference: shown, sent: false });
    expect(other.sent).toBe(true);
    expect(other.reference).not.toBe(shown);
    expect(send).toHaveBeenCalledTimes(2);
    const body = JSON.parse((send.mock.calls[0] as unknown as [string, string])[1]) as Record<string, unknown>;
    expect(body).toMatchObject({ source: 'admin', kind: 'boundary', name: 'TypeError', reference: shown, route: '/admin/members' });

    // A fresh page load in the same tab session remembers what was sent.
    const reloaded = createClientErrorReporter({ source: 'admin', endpoint: '/v1/client-errors', storage, send });
    expect(reloaded.report(crash('Row 9 has no plan'), 'boundary')).toEqual({ reference: shown, sent: false });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never throws, even when storage and the network fail', async () => {
    const reporter = createClientErrorReporter({
      source: 'member',
      endpoint: '/v1/client-errors',
      storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } },
      send: () => Promise.reject(new Error('offline')),
    });
    expect(reporter.report(crash('x'), 'unhandledrejection').sent).toBe(true);
    expect(reporter.report(crash('x'), 'unhandledrejection').sent).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
