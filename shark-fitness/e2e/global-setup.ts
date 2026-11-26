import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { API_ROOT, STATE_FILE, WORKSPACE_ROOT, type RunState } from './support/paths';
import { startFakeRazorpay, type FakeRazorpay } from '../apps/api/src/testing/razorpay-fake';

/**
 * Starts the real product the way production runs it: one Node process
 * serving the API, the website at /, the member app at /app/ and the console
 * at /admin/, against a
 * freshly migrated and seeded SQLite file in a temporary directory. Never
 * apps/api/data/shark.db.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const missing = ['apps/website/dist/index.html', 'apps/member-pwa/dist/index.html', 'apps/admin-web/dist/index.html'].filter(
    (file) => !existsSync(resolve(WORKSPACE_ROOT, file)),
  );
  if (missing.length > 0) {
    throw new Error(`E2E runs against the production build, and ${missing.join(' and ')} is missing. Run \`pnpm build\` first.`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'shark-e2e-'));
  // Razorpay in test mode, played by a local fake in this (the runner's)
  // process for the whole run: the API talks to it, never to razorpay.com.
  // Port 0 picks a free one; SHARK_E2E_RAZORPAY_PORT pins it.
  let razorpay: FakeRazorpay | null = null;
  try {
    razorpay = await startFakeRazorpay({ port: Number(process.env.SHARK_E2E_RAZORPAY_PORT ?? 0) });
    const database = join(tempDir, 'shark.db');
    const port = await chosenPort();
    const baseURL = `http://127.0.0.1:${port}`;
    const serverLog = join(tempDir, 'server.log');
    // Only what the server needs: nothing inherited from the developer's shell
    // can point it at another database or loosen production checks.
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tempDir,
      NODE_ENV: 'production',
      PORT: String(port),
      SHARK_DB: database,
      SHARK_SERVE_STATIC: 'true',
      SHARK_PUBLIC_ORIGIN: baseURL,
      SHARK_ALLOWED_ORIGINS: baseURL,
      // Test-only secret, new every run.
      SHARK_PASS_SECRET: randomBytes(48).toString('base64'),
      SHARK_DISABLE_JOBS: 'true',
      SHARK_RELEASE: 'e2e',
      // Error reports go to the server log, where the client-error spec reads them.
      SHARK_ERROR_REPORTER: 'console',
      // Online payment through the fake Razorpay; keys are new every run.
      SHARK_PAYMENT_PROVIDER: 'razorpay',
      SHARK_RAZORPAY_KEY_ID: razorpay.keyId,
      SHARK_RAZORPAY_KEY_SECRET: razorpay.keySecret,
      SHARK_RAZORPAY_WEBHOOK_SECRET: razorpay.webhookSecret,
      SHARK_RAZORPAY_API_BASE: razorpay.baseUrl,
    };

    for (const script of ['src/db/migrate.ts', 'src/db/seed.ts']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: API_ROOT, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${script} failed:\n${result.stdout}\n${result.stderr}`);
    }

    const logFd = openSync(serverLog, 'a');
    const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: API_ROOT,
      env,
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    closeSync(logFd);
    server.unref();
    const state: RunState = { pid: server.pid!, tempDir, baseURL, serverLog };
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    let exited: number | null = null;
    server.on('exit', (code) => (exited = code ?? -1));
    await waitForReady(baseURL, () => exited, serverLog);

    process.env.SHARK_E2E_BASE_URL = baseURL;
    process.env.SHARK_E2E_SERVER_LOG = serverLog;
    // For the payment specs (support/razorpay.ts), which run in worker processes.
    process.env.SHARK_E2E_RAZORPAY_API_BASE = razorpay.baseUrl;
    process.env.SHARK_E2E_RAZORPAY_KEY_SECRET = razorpay.keySecret;
    process.env.SHARK_E2E_RAZORPAY_WEBHOOK_SECRET = razorpay.webhookSecret;
    const fake = razorpay;
    // Runs before global-teardown.ts, which stops the API.
    return async () => {
      if (fake.unexpected.length > 0) {
        console.warn(`Fake Razorpay saw requests it does not serve: ${fake.unexpected.map((r) => `${r.method} ${r.path}`).join(', ')}`);
      }
      await fake.close();
    };
  } catch (error) {
    await razorpay?.close();
    stopRecordedServer();
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/** SHARK_E2E_PORT pins the port (machines that share a port range); otherwise any free one. */
async function chosenPort(): Promise<number> {
  const pinned = process.env.SHARK_E2E_PORT;
  if (pinned === undefined || pinned === '') return freePort();
  const port = Number(pinned);
  if (!/^\d+$/.test(pinned) || port < 1 || port > 65_535) {
    throw new Error(`SHARK_E2E_PORT must be a port number between 1 and 65535, not "${pinned}".`);
  }
  return port;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function waitForReady(baseURL: string, exited: () => number | null, serverLog: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited() !== null) throw new Error(`The API exited with code ${exited()} before it was ready:\n${tail(serverLog)}`);
    try {
      const response = await fetch(`${baseURL}/ready`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`The API did not report ready within 60 s:\n${tail(serverLog)}`);
}

function tail(file: string): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-40).join('\n');
  } catch {
    return '(no log)';
  }
}

/** Also used by teardown: stop the server recorded in the state file, if any. */
export function stopRecordedServer(): RunState | null {
  if (!existsSync(STATE_FILE)) return null;
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState;
  try {
    // The server leads its own process group (detached), so this reaches
    // anything it started too.
    process.kill(-state.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(STATE_FILE, { force: true });
  return state;
}
