import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseRuntimeConfig } from '../lib/config.js';
import { createErrorReporter, parseStack, type ErrorReportContext } from '../lib/error-reporting.js';
import { SENSITIVE, SENSITIVE_SENTENCE, SENSITIVE_VALUES } from './fixtures/redaction.js';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let port = 0;
const received: Received[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"ok"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  received.length = 0;
  vi.restoreAllMocks();
});

function thrownFrom(message: string): Error {
  const deepInsideTheApp = () => {
    throw new Error(message);
  };
  try {
    deepInsideTheApp();
  } catch (error) {
    return error as Error;
  }
  throw new Error('unreachable');
}

/** Context with fields the reporter must drop, as a careless caller might pass. */
const leakyContext = {
  requestId: 'req_test123',
  route: '/v1/admin/members/:memberId',
  tenantId: 'ten_shark',
  actorId: 'usr_owner',
  body: { email: SENSITIVE.email, password: SENSITIVE.password },
  cookie: SENSITIVE.sessionCookie,
  headers: { authorization: `Bearer ${SENSITIVE.bearer}` },
} as unknown as ErrorReportContext;

describe('sentry error reporter', () => {
  const config = () =>
    parseRuntimeConfig({
      NODE_ENV: 'test',
      SHARK_ERROR_DSN: `http://publickey123@127.0.0.1:${port}/7`,
      SHARK_RELEASE: 'release-test-abc',
    });

  it('sends one envelope per captured error to the DSN-derived URL with the auth header', async () => {
    const reporter = createErrorReporter('sentry', config());
    reporter.capture(thrownFrom('first failure'), leakyContext);
    reporter.capture(thrownFrom('second failure'), { requestId: 'req_second' });
    await reporter.flush(2_000);

    expect(received).toHaveLength(2);
    for (const request of received) {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/api/7/envelope/');
      expect(request.headers['content-type']).toBe('application/x-sentry-envelope');
      expect(request.headers['x-sentry-auth']).toMatch(/^Sentry sentry_version=7, sentry_client=[^,]+, sentry_key=publickey123$/);
    }
  });

  it('carries release, environment, request id, route, tenant/actor ids and a stack', async () => {
    const reporter = createErrorReporter('sentry', config());
    reporter.capture(thrownFrom('boom'), leakyContext);
    await reporter.flush(2_000);

    const [envelopeHeader, itemHeader, eventLine, ...rest] = received[0]!.body.split('\n');
    expect(rest).toEqual([]);
    const header = JSON.parse(envelopeHeader!) as { event_id: string };
    const item = JSON.parse(itemHeader!) as { type: string; length: number };
    const event = JSON.parse(eventLine!) as {
      event_id: string;
      release: string;
      environment: string;
      platform: string;
      tags: Record<string, string>;
      exception: { values: Array<{ type: string; value: string; stacktrace: { frames: Array<{ filename: string; function?: string; lineno: number; in_app: boolean }> } }> };
    };

    expect(header.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event.event_id).toBe(header.event_id);
    expect(item).toMatchObject({ type: 'event', length: Buffer.byteLength(eventLine!, 'utf8') });
    expect(event.release).toBe('release-test-abc');
    expect(event.environment).toBe('test');
    expect(event.platform).toBe('node');
    expect(event.tags).toEqual({
      request_id: 'req_test123',
      route: '/v1/admin/members/:memberId',
      tenant_id: 'ten_shark',
      actor_id: 'usr_owner',
    });
    const exception = event.exception.values[0]!;
    expect(exception).toMatchObject({ type: 'Error', value: 'boom' });
    expect(exception.stacktrace.frames.length).toBeGreaterThanOrEqual(1);
    // Oldest call first, newest (where it threw) last, as Sentry expects.
    const newest = exception.stacktrace.frames.at(-1)!;
    expect(newest.function).toContain('deepInsideTheApp');
    expect(newest.filename).toContain('error-reporting.test.ts');
    expect(newest.filename.startsWith('/')).toBe(false);
    expect(newest.in_app).toBe(true);
  });

  it('never sends an email, phone number, cookie, password, token or request body', async () => {
    const reporter = createErrorReporter('sentry', config());
    reporter.capture(thrownFrom(`Lookup failed for ${SENSITIVE_SENTENCE}`), leakyContext);
    await reporter.flush(2_000);

    const payload = received[0]!.body;
    for (const value of SENSITIVE_VALUES) expect(payload).not.toContain(value);
    expect(payload).not.toContain('"body"');
    expect(payload).not.toContain('"cookie"');
    expect(payload).not.toContain('"headers"');
    expect(payload).toContain('[redacted-email]');
  });

  it('stops sending after 60 reports a minute so a crash loop cannot flood the collector', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = createErrorReporter('sentry', config());
    for (let index = 0; index < 75; index += 1) reporter.capture(new Error(`loop ${index}`), {});
    await reporter.flush(5_000);
    expect(received).toHaveLength(60);
    expect(error).not.toHaveBeenCalledWith(expect.stringMatching(/could not be reached/));
  });

  it('keeps a separate budget for browser reports, so public /v1/client-errors traffic cannot hide server errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = createErrorReporter('sentry', config());
    for (let index = 0; index < 75; index += 1) {
      reporter.capture(new Error(`browser flood ${index}`), { source: index % 2 === 0 ? 'member' : 'admin' });
    }
    for (let index = 0; index < 5; index += 1) reporter.capture(new Error(`server failure ${index}`), { requestId: `req_${index}` });
    await reporter.flush(5_000);

    const events = received.map((request) => request.body.split('\n')[2]!);
    expect(events.filter((event) => event.includes('browser flood'))).toHaveLength(60);
    expect(events.filter((event) => event.includes('server failure'))).toHaveLength(5);
  });

  it('survives an unreachable collector and a flush that times out', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unreachable = parseRuntimeConfig({ NODE_ENV: 'test', SHARK_ERROR_DSN: 'http://key@127.0.0.1:1/1' });
    const reporter = createErrorReporter('sentry', unreachable);
    expect(() => reporter.capture(new Error('nobody listening'), {})).not.toThrow();
    await reporter.flush(2_000);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not be reached/));

    const hanging = createErrorReporter('sentry', config(), () => new Promise<Response>(() => undefined));
    hanging.capture(new Error('never answered'), {});
    const started = Date.now();
    await hanging.flush(100);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('http, console and none error reporters', () => {
  it('http posts the redacted JSON report to the endpoint', async () => {
    const reporter = createErrorReporter(
      'http',
      parseRuntimeConfig({ NODE_ENV: 'test', SHARK_ERROR_REPORTING_ENDPOINT: `http://127.0.0.1:${port}/hook`, SHARK_RELEASE: 'rel-http' }),
    );
    reporter.capture(thrownFrom(`failed for ${SENSITIVE.email}`), leakyContext);
    await reporter.flush(2_000);

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/hook');
    const body = JSON.parse(received[0]!.body) as { release: string; exception: { message: string }; context: Record<string, unknown> };
    expect(body.release).toBe('rel-http');
    expect(body.exception.message).toBe('failed for [redacted-email]');
    expect(Object.keys(body.context).sort()).toEqual(['actorId', 'requestId', 'route', 'tenantId']);
  });

  it('console prints a readable, redacted report with frames to stderr', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = createErrorReporter('console', parseRuntimeConfig({}));
    reporter.capture(thrownFrom(`password=${SENSITIVE.password}`), { requestId: 'req_console', job: 'run-dunning' });
    await reporter.flush(100);

    expect(error).toHaveBeenCalledTimes(1);
    const printed = String(error.mock.calls[0]![0]);
    expect(printed).toMatch(/^\[error-report\] Error: password=\[redacted\] \(requestId=req_console job=run-dunning\)/);
    expect(printed).toMatch(/\n {4}at deepInsideTheApp \(.*error-reporting\.test\.ts:\d+:\d+\)/);
    expect(printed).not.toContain(SENSITIVE.password);
    expect(received).toHaveLength(0);
  });

  it('none sends and prints nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchFn = vi.fn();
    const reporter = createErrorReporter('none', parseRuntimeConfig({ NODE_ENV: 'test' }), fetchFn as unknown as typeof fetch);
    reporter.capture(new Error('ignored'), leakyContext);
    await reporter.flush(100);

    expect(reporter.name).toBe('none');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });
});

describe('stack parsing', () => {
  it('reads browser stacks from Chrome and Firefox/Safari, dropping query strings', () => {
    const chrome = [
      'TypeError: Cannot read properties of undefined',
      '    at renderRow (https://gym.example/admin/assets/index-a1b2.js:12:345)',
      '    at https://gym.example/admin/assets/react-vendor-c3d4.js?token=secret-value:1:99',
    ].join('\n');
    expect(parseStack(chrome)).toEqual([
      { filename: 'https://gym.example/admin/assets/react-vendor-c3d4.js', lineno: 1, colno: 99, in_app: true },
      { function: 'renderRow', filename: 'https://gym.example/admin/assets/index-a1b2.js', lineno: 12, colno: 345, in_app: true },
    ]);

    const gecko = 'renderRow@https://gym.example/assets/index-a1b2.js:12:345\n@https://gym.example/assets/index-a1b2.js#frag:1:2';
    expect(parseStack(gecko)).toEqual([
      { filename: 'https://gym.example/assets/index-a1b2.js', lineno: 1, colno: 2, in_app: true },
      { function: 'renderRow', filename: 'https://gym.example/assets/index-a1b2.js', lineno: 12, colno: 345, in_app: true },
    ]);
  });

  it('marks dependency and Node internals frames as not in-app', () => {
    const frames = parseStack(
      'Error: x\n    at handler (/srv/app/node_modules/hono/dist/compose.js:1:2)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    );
    expect(frames.map((frame) => frame.in_app)).toEqual([false, false]);
  });
});
