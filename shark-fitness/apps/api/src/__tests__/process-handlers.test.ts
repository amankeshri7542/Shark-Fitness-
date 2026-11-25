import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const apiRoot = resolve(import.meta.dirname, '../..');
const child = resolve(import.meta.dirname, 'fixtures/process-handlers-child.ts');

let server: Server;
let port = 0;
const received: Array<{ url: string; body: string }> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      received.push({ url: request.url ?? '', body });
      response.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));
afterEach(() => {
  received.length = 0;
});

function run(mode: string, environment: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    // Only what the child needs: no inherited SHARK_* from the test runner.
    const process_ = spawn(globalThis.process.execPath, ['--import', 'tsx', child, mode], {
      cwd: apiRoot,
      env: { PATH: globalThis.process.env.PATH ?? '', ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    process_.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    process_.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      process_.kill('SIGKILL');
      fail(new Error(`child timed out\n${stdout}\n${stderr}`));
    }, 20_000);
    process_.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

const production = (overrides: Record<string, string>) => ({
  NODE_ENV: 'production',
  SHARK_DB: '/tmp/shark-process-handlers-unused.db',
  SHARK_PASS_SECRET: 'process-handler-test-secret-with-at-least-48-bytes-of-length',
  SHARK_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  SHARK_PUBLIC_ORIGIN: 'http://localhost:8788',
  ...overrides,
});

describe('process-level crash handlers', () => {
  it('captures and logs an unhandled rejection, and keeps the process alive', async () => {
    const result = await run('rejection', {
      NODE_ENV: 'test',
      SHARK_ERROR_DSN: `http://childkey@127.0.0.1:${port}/3`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('child_ready reporter=sentry');
    const logged = result.stderr.split('\n').find((line) => line.includes('"event":"unhandled_rejection"'));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: 'error', errorName: 'Error' });
    expect(logged).not.toContain('owner@example.com');

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/api/3/envelope/');
    const event = JSON.parse(received[0]!.body.split('\n')[2]!) as {
      tags: Record<string, string>;
      exception: { values: Array<{ value: string; mechanism: { handled: boolean } }> };
    };
    expect(event.tags.source).toBe('unhandledRejection');
    expect(event.exception.values[0]!.value).toBe('child rejection probe for [redacted-email]');
  }, 30_000);

  it('reports an uncaught exception, flushes, and exits 1 in production', async () => {
    const result = await run('uncaught', production({ SHARK_ERROR_REPORTING_ENDPOINT: `http://127.0.0.1:${port}/hook` }));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('child_ready reporter=http');
    expect(result.stdout).not.toContain('child_survived');
    expect(result.stderr).toContain('"event":"uncaught_exception"');
    expect(received).toHaveLength(1);
    const body = JSON.parse(received[0]!.body) as { exception: { name: string }; context: { source: string } };
    expect(body).toMatchObject({ exception: { name: 'TypeError' }, context: { source: 'uncaughtException' } });
  }, 30_000);

  it('logs an uncaught exception loudly in development without exiting', async () => {
    const result = await run('uncaught', { NODE_ENV: 'development', SHARK_ERROR_REPORTER: 'console' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('child_survived');
    expect(result.stderr).toContain('"event":"uncaught_exception"');
    expect(result.stderr).toContain('[error-report] TypeError: child uncaught probe');
    expect(result.stderr).toContain('The development server keeps running');
  }, 30_000);
});
