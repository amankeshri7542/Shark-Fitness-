import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBackup, restoreBackup } from './sqlite-backup.mjs';

const repository = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'shark-recovery-proof-'));
const source = join(root, 'source.db');
const backup = join(root, 'backup.db');
const restored = join(root, 'restored.db');
const requireFromApi = createRequire(resolve(repository, 'apps/api/package.json'));
const Database = requireFromApi('better-sqlite3');
const proofSuffix = randomUUID().replaceAll('-', '');
const auditId = `aud_recovery_${proofSuffix}`;
const ledgerId = `stk_recovery_${proofSuffix}`;
const baseEnvironment = {
  ...process.env,
  SHARK_PASS_SECRET: 'recovery-proof-pass-secret-with-at-least-48-bytes-long',
  SHARK_DEMO_READER_KEY: 'recovery-proof-reader-secret',
  SHARK_RELEASE: 'recovery-proof',
};

function pnpmInvocation(args) {
  return process.env.npm_execpath
    ? { command: process.execPath, args: [process.env.npm_execpath, ...args] }
    : { command: 'pnpm', args };
}

function runPnpm(args, environment) {
  const invocation = pnpmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repository,
    env: { ...baseEnvironment, ...environment },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with exit code ${String(result.status)}.`);
}

async function expectRestoreRefusal(action, pattern, label) {
  try {
    await action();
  } catch (error) {
    if (pattern.test(String(error))) return;
    throw new Error(`${label} failed for an unexpected reason: ${String(error)}`, { cause: error });
  }
  throw new Error(`${label} was accepted when it should have been refused.`);
}

function rowCounts(database) {
  const tables = ['members', 'memberships', 'invoices', 'payments', 'tickets', 'audit_log', 'stock_ledger'];
  return Object.fromEntries(tables.map((table) => [table, database.prepare(`select count(*) as count from ${table}`).get().count]));
}

function writeRecoveryEvidence(databasePath) {
  const database = new Database(databasePath);
  try {
    const tenant = database.prepare("select id from tenants where slug = 'shark'").get();
    const branch = database.prepare('select id from branches where tenant_id = ? order by id limit 1').get(tenant.id);
    const product = database.prepare('select id from retail_products where tenant_id = ? order by id limit 1').get(tenant.id);
    const at = Date.now();
    database.transaction(() => {
      database.prepare(`insert into audit_log
        (id, tenant_id, branch_id, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, changes, ip, request_id, at)
        values (?, ?, ?, null, 'Recovery proof', 'system', 'recovery.proof_written', 'database', ?, 'CI recovery proof', 'Representative post-seed write', '[]', null, ?, ?)`)
        .run(auditId, tenant.id, branch.id, auditId, auditId, at);
      database.prepare(`insert into stock_ledger
        (id, tenant_id, branch_id, product_id, delta, reason, ref_type, ref_id, actor_name, note, unit_cost_minor, negative_override, override_reason, at)
        values (?, ?, ?, ?, 3, 'Recovery proof stock receipt', 'recovery_proof', ?, 'Recovery proof', 'Representative post-seed ledger write', 12345, 0, null, ?)`)
        .run(ledgerId, tenant.id, branch.id, product.id, auditId, at);
    })();
    database.pragma('wal_checkpoint(PASSIVE)');
    return rowCounts(database);
  } finally {
    database.close();
  }
}

function verifyRestoredState(expected) {
  const database = new Database(restored);
  try {
    const actual = rowCounts(database);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Restored row counts differ. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
    }
    if (!database.prepare('select id from audit_log where id = ?').get(auditId)) throw new Error('Recovery audit row is missing.');
    if (!database.prepare('select id from stock_ledger where id = ?').get(ledgerId)) throw new Error('Recovery stock-ledger row is missing.');
    try {
      database.prepare("update audit_log set actor_name = 'tampered' where id = ?").run(auditId);
      throw new Error('Restored audit log accepted an update.');
    } catch (error) {
      if (!String(error).includes('append-only')) throw error;
    }
    try {
      database.prepare('delete from stock_ledger where id = ?').run(ledgerId);
      throw new Error('Restored stock ledger accepted a delete.');
    } catch (error) {
      if (!String(error).includes('append-only')) throw error;
    }
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Restored integrity_check failed.');
    return actual;
  } finally {
    database.close();
  }
}

async function waitForJson(url, attempts = 60) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return { response, body: await response.json() };
      lastError = new Error(`${url} returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw lastError ?? new Error(`${url} did not become ready.`);
}

async function proveBootAndRead() {
  const port = 8798;
  const origin = `http://127.0.0.1:${port}`;
  const invocation = pnpmInvocation(['-F', '@shark/api', 'start']);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repository,
    env: {
      ...baseEnvironment,
      NODE_ENV: 'production',
      PORT: String(port),
      SHARK_DB: restored,
      SHARK_PUBLIC_ORIGIN: origin,
      SHARK_DISABLE_JOBS: 'true',
      SHARK_SERVE_STATIC: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = `${logs}${String(chunk)}`.slice(-12_000); });
  child.stderr.on('data', (chunk) => { logs = `${logs}${String(chunk)}`.slice(-12_000); });
  try {
    const { body: ready } = await waitForJson(`${origin}/ready`);
    if (!ready.ok || ready.schema !== 'ready') throw new Error(`Restored API was not ready: ${JSON.stringify(ready)}`);
    const signIn = await fetch(`${origin}/v1/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ tenantSlug: 'shark', email: 'owner@sharkfitness.in', password: 'shark1234' }),
    });
    if (!signIn.ok) throw new Error(`Restored API sign-in failed with ${signIn.status}.`);
    const session = signIn.headers.get('set-cookie')?.match(/shark_session=([^;,]+)/)?.[1];
    if (!session) throw new Error('Restored API sign-in did not issue a session.');
    const read = await fetch(`${origin}/v1/admin/dashboard`, { headers: { cookie: `shark_session=${session}`, origin } });
    if (!read.ok) throw new Error(`Restored authenticated read failed with ${read.status}.`);
    const dashboard = await read.json();
    if (!dashboard || typeof dashboard !== 'object') throw new Error('Restored authenticated read returned no JSON object.');
    return { ready, authenticatedReadStatus: read.status };
  } catch (error) {
    throw new Error(`${String(error)}\nRestored API logs:\n${logs}`, { cause: error });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

runPnpm(['-F', '@shark/api', 'migrate'], { SHARK_DB: source, NODE_ENV: 'test' });
runPnpm(['-F', '@shark/api', 'seed'], { SHARK_DB: source, NODE_ENV: 'test' });
const expectedCounts = writeRecoveryEvidence(source);
const backupResult = await createBackup(source, backup);

// Guard proofs run before the real restore so a destructive regression cannot
// be hidden by the happy path.
await expectRestoreRefusal(
  () => restoreBackup(backup, backup, { replace: true }),
  /target must be different/i,
  'Restoring over the backup artifact',
);

const corruptDirectory = join(root, 'corrupt');
const corruptBackup = join(corruptDirectory, 'backup.db');
const corruptTarget = join(root, 'corrupt-restored.db');
mkdirSync(corruptDirectory);
copyFileSync(backup, corruptBackup);
copyFileSync(`${backup}.manifest.json`, `${corruptBackup}.manifest.json`);
appendFileSync(corruptBackup, Buffer.from([0]));
await expectRestoreRefusal(
  () => restoreBackup(corruptBackup, corruptTarget),
  /size does not match|checksum does not match/i,
  'A corrupt backup artifact',
);
if (existsSync(corruptTarget)) throw new Error('A corrupt backup created a restore target.');

const occupiedTarget = join(root, 'occupied.db');
const occupied = new Database(occupiedTarget);
try {
  occupied.exec("create table sentinel (value text not null); insert into sentinel values ('keep-me');");
} finally {
  occupied.close();
}
await expectRestoreRefusal(
  () => restoreBackup(backup, occupiedTarget),
  /refusing to overwrite/i,
  'An overwrite without both confirmation flags',
);
const preserved = new Database(occupiedTarget, { readonly: true, fileMustExist: true });
try {
  if (preserved.prepare('select value from sentinel').pluck().get() !== 'keep-me') {
    throw new Error('The overwrite guard did not preserve the existing target.');
  }
} finally {
  preserved.close();
}

// A post-snapshot write proves the restored database came from the backup and
// was not accidentally read from the still-live source path.
const live = new Database(source);
try {
  live.prepare(`insert into audit_log
    (id, tenant_id, branch_id, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, reason, changes, ip, request_id, at)
    select ?, tenant_id, branch_id, null, 'Recovery proof', 'system', 'recovery.after_backup', 'database', ?, 'After backup', null, '[]', null, ?, ?
    from audit_log where id = ?`)
    .run(`aud_after_${proofSuffix}`, `aud_after_${proofSuffix}`, `aud_after_${proofSuffix}`, Date.now(), auditId);
} finally {
  live.close();
}

await restoreBackup(backup, restored);
runPnpm(['-F', '@shark/api', 'migrate'], { SHARK_DB: restored, NODE_ENV: 'test' });
const restoredCounts = verifyRestoredState(expectedCounts);
const runtimeProof = await proveBootAndRead();

console.log(JSON.stringify({
  recoveryProof: 'passed',
  restoreGuards: ['source-target-separation', 'manifest-size-and-checksum', 'explicit-overwrite-confirmation'],
  artifactDirectory: root,
  manifest: backupResult.metadata,
  rowCounts: restoredCounts,
  readiness: runtimeProof.ready,
  authenticatedReadStatus: runtimeProof.authenticatedReadStatus,
}, null, 2));
