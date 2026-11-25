import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { API_ROOT, STATE_FILE, WORKSPACE_ROOT, type RunState } from './support/paths';

/**
 * Starts the real product the way production runs it: one Node process
 * serving the API, the member app at / and the console at /admin/, against a
 * freshly migrated and seeded SQLite file in a temporary directory. Never
 * apps/api/data/shark.db.
 */
export default async function globalSetup(): Promise<void> {
  const missing = ['apps/member-pwa/dist/index.html', 'apps/admin-web/dist/index.html'].filter(
    (file) => !existsSync(resolve(WORKSPACE_ROOT, file)),
  );
  if (missing.length > 0) {
    throw new Error(`E2E runs against the production build, and ${missing.join(' and ')} is missing. Run \`pnpm build\` first.`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'shark-e2e-'));
  try {
    const database = join(tempDir, 'shark.db');
    // SHARK_E2E_PORT pins the port (parallel worktrees on one machine each
    // use their own range); otherwise any free port.
    const port = process.env.SHARK_E2E_PORT ? Number(process.env.SHARK_E2E_PORT) : await freePort();
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
      SHARK_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SHARK_DISABLE_JOBS: 'true',
      SHARK_RELEASE: 'e2e',
      // Error reports go to the server log, where the client-error spec reads them.
      SHARK_ERROR_REPORTER: 'console',
    };

    // The demo owner must use two-step sign-in. Enrol it with a secret made
    // for this run, so specs can generate its codes (support/totp.ts). Other
    // owners stay unenrolled, which is how the enrolment-gate spec meets the
    // gate. The secret never leaves this machine's temp state.
    const ownerTotpSecret = base32(randomBytes(20));
    const scripts: string[][] = [
      ['src/db/migrate.ts'],
      ['src/db/seed.ts'],
      ['src/db/mfa-fixture.ts', '--secret', ownerTotpSecret, '--email', 'owner@sharkfitness.in'],
    ];
    for (const [script, ...args] of scripts) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', script!, ...args], { cwd: API_ROOT, env, encoding: 'utf8' });
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
    const state: RunState = { pid: server.pid!, tempDir, baseURL, serverLog, database, ownerTotpSecret };
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    let exited: number | null = null;
    server.on('exit', (code) => (exited = code ?? -1));
    await waitForReady(baseURL, () => exited, serverLog);

    process.env.SHARK_E2E_BASE_URL = baseURL;
    process.env.SHARK_E2E_SERVER_LOG = serverLog;
    process.env.SHARK_E2E_DATABASE = database;
    process.env.SHARK_E2E_OWNER_TOTP_SECRET = ownerTotpSecret;
  } catch (error) {
    stopRecordedServer();
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
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
