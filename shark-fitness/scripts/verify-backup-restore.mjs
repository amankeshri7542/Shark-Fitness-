import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBackup, mediaDirectoryFor, restoreBackup } from './sqlite-backup.mjs';
import { mediaFingerprint } from './media-archive.mjs';

const repository = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'shark-recovery-proof-'));
const source = join(root, 'source.db');
// Separate directories model the operator handoff locally; this is not proof of
// off-instance storage or a hosted restore. Those require an actual second host.
const archive = mkdtempSync(join(tmpdir(), 'shark-retained-backup-'));
const recovery = mkdtempSync(join(tmpdir(), 'shark-restored-app-'));
const backup = join(archive, 'backup.db');
const restored = join(recovery, 'restored.db');
// Private media lives beside each database, as the API defaults outside
// production and as SHARK_MEDIA_DIR is set on a host (P05).
const sourceMedia = join(root, 'media');
const restoredMedia = join(recovery, 'media');
const requireFromApi = createRequire(resolve(repository, 'apps/api/package.json'));
const Database = requireFromApi('better-sqlite3');
const proofSuffix = randomUUID().replaceAll('-', '');
const auditId = `aud_recovery_${proofSuffix}`;
const ledgerId = `stk_recovery_${proofSuffix}`;
let paymentProof;
let accountRecoveryProof;
const baseEnvironment = {
  ...process.env,
  SHARK_PASS_SECRET: 'recovery-proof-pass-secret-with-at-least-48-bytes-long',
  SHARK_DEMO_READER_KEY: 'recovery-proof-reader-secret',
  SHARK_RELEASE: `recovery-proof-${proofSuffix}`,
  SHARK_ECHO_OTP: 'false',
  SHARK_ALLOW_BEARER_AUTH: 'false',
  SHARK_ERROR_REPORTING_ENDPOINT: undefined,
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
    // The fixture seeder prints demo credentials. Keep those out of evidence.
    stdio: 'pipe',
  });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with exit code ${String(result.status)}.`);
  console.log(`pnpm ${args.join(' ')} passed.`);
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

function snapshot(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = ['members', 'products', 'memberships', 'membership_events', 'invoices', 'invoice_lines', 'payments', 'refunds', 'check_ins', 'tickets', 'audit_log', 'stock_ledger', 'account_recoveries', 'payment_receipts'];
    return Object.fromEntries(tables.map((table) => {
      const rows = database.prepare(`select * from ${table} order by ${table === 'payment_receipts' ? 'payment_id' : 'id'}`).all();
      assert.ok(rows.length > 0, `Representative ${table} records are missing.`);
      return [table, { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }];
    }));
  } finally {
    database.close();
  }
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
  } finally {
    database.close();
  }
}

/** Two private files and their rows, as an upload would leave them. */
function writeMediaEvidence(databasePath) {
  const database = new Database(databasePath);
  try {
    const tenant = database.prepare("select id from tenants where slug = 'shark'").get();
    const member = database.prepare('select id from members where tenant_id = ? order by id limit 1').get(tenant.id);
    const at = Date.now();
    for (const [index, bytes] of [
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44]),
    ].entries()) {
      const mediaId = `med_recovery${index}${proofSuffix.slice(0, 12)}`;
      const key = `${tenant.id}/2026/${mediaId}.${index === 0 ? 'jpg' : 'png'}`;
      mkdirSync(join(sourceMedia, tenant.id, '2026'), { recursive: true });
      writeFileSync(join(sourceMedia, key), bytes, { mode: 0o600 });
      database.prepare(`insert into media_objects
        (id, tenant_id, owner_member_id, purpose, storage_key, content_type, byte_size, width, height, sha256, created_at, deleted_at, deleted_reason)
        values (?, ?, ?, 'progress_photo', ?, ?, ?, 1, 1, ?, ?, null, null)`)
        .run(mediaId, tenant.id, member.id, key, index === 0 ? 'image/jpeg' : 'image/png', bytes.length, createHash('sha256').update(bytes).digest('hex'), at);
    }
  } finally {
    database.close();
  }
}

/** Every live media row has its file, and the file is the one recorded. */
function verifyMedia(databasePath, mediaRoot) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare('select storage_key, sha256 from media_objects where deleted_at is null').all();
    assert.ok(rows.length >= 2, 'Representative media rows are missing.');
    for (const row of rows) {
      const file = join(mediaRoot, row.storage_key);
      assert.ok(existsSync(file), `Media file missing after restore: ${row.storage_key}`);
      assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), row.sha256, `Media checksum differs: ${row.storage_key}`);
    }
    return rows.length;
  } finally {
    database.close();
  }
}

function verifyState(databasePath, expected) {
  const actual = snapshot(databasePath);
  assert.deepEqual(actual, expected, 'Record identities/content changed across restart, replacement or restore.');
  const database = new Database(databasePath);
  try {
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
    assert.ok(database.prepare('select id from account_recoveries where id = ? and user_id = ?').get(accountRecoveryProof.recoveryId, accountRecoveryProof.userId), 'Issued account recovery identity is missing.');
    assert.ok(database.prepare('select payment_id from payment_receipts where payment_id = ?').get(paymentProof.paymentId), 'Issued payment receipt identity is missing.');
    assert.throws(() => database.prepare("update payment_receipts set member_name = 'tampered' where payment_id = ?").run(paymentProof.paymentId), /immutable/);
    assert.throws(() => database.prepare('delete from payment_receipts where payment_id = ?').run(paymentProof.paymentId), /immutable/);
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

async function proveBootAndRead(databasePath, label, apiDirectory = resolve(repository, 'apps/api'), writeFixture = false) {
  const listener = createServer();
  await new Promise((resolveListen, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolveListen); });
  const port = listener.address().port;
  await new Promise((resolveClose) => listener.close(resolveClose));
  const origin = `http://127.0.0.1:${port}`;
  const release = `${baseEnvironment.SHARK_RELEASE}-${label}`;
  // Own the server process directly: terminating pnpm can leave its server
  // descendants holding the output pipes open on Linux.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: apiDirectory,
    env: {
      ...baseEnvironment,
      NODE_ENV: 'production',
      PORT: String(port),
      SHARK_DB: databasePath,
      SHARK_RELEASE: release,
      SHARK_PUBLIC_ORIGIN: origin,
      SHARK_ALLOWED_ORIGINS: origin,
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
    if (child.exitCode !== null || !ready.ok || ready.schema !== 'ready' || ready.release !== release) {
      throw new Error(`Restored API was not ready or belonged to another process: ${JSON.stringify(ready)}`);
    }
    const signIn = await fetch(`${origin}/v1/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ tenantSlug: 'shark', email: 'owner@sharkfitness.in', password: 'shark1234' }),
    });
    if (!signIn.ok) throw new Error(`Restored API sign-in failed with ${signIn.status}.`);
    const session = signIn.headers.get('set-cookie')?.match(/shark_session=([^;,]+)/)?.[1];
    if (!session) throw new Error('Restored API sign-in did not issue a session.');
    const { csrfToken } = await signIn.json();
    const headers = { cookie: `shark_session=${session}; shark_csrf=${csrfToken}`, origin, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
    const request = async (path, body, idempotencyKey) => {
      const response = await fetch(`${origin}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { ...headers, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok(response.ok, `${label}: ${path} returned HTTP ${response.status}.`);
      return response;
    };
    if (writeFixture) {
      const fixture = new Database(databasePath, { readonly: true });
      const invoice = fixture.prepare(`select i.* from invoices i join tenants t on t.id = i.tenant_id
        where t.slug = 'shark' and i.voided = 0 and i.total_minor - i.paid_minor > 20000 order by i.id limit 1`).get();
      const recoveryMember = fixture.prepare(`select m.id, m.user_id from members m
        join users u on u.id = m.user_id and u.tenant_id = m.tenant_id
        join tenants t on t.id = m.tenant_id
        where t.slug = 'shark' and u.email = 'rohit@sharkfitness.in' and u.role = 'member'
          and u.account_state = 'active' and u.password_hash is not null and u.deleted_at is null and m.deleted_at is null`).get();
      fixture.close();
      assert.ok(invoice, 'A synthetic invoice with unpaid principal is required.');
      assert.ok(recoveryMember, 'An active ordinary synthetic member is required for recovery issuance.');
      // Issue through the owner/password/verified-identity boundary. The raw
      // handoff token is deliberately discarded, never retained in evidence.
      const { recoveryId } = await (await request('/v1/auth/recovery/issue', {
        memberId: recoveryMember.id, currentPassword: 'shark1234', identityVerified: true,
        reason: 'Synthetic owner-verified recovery preservation rehearsal',
      })).json();
      assert.equal(typeof recoveryId, 'string');
      accountRecoveryProof = { recoveryId, userId: recoveryMember.user_id, memberId: recoveryMember.id, state: 'issued-not-redeemed' };
      const body = { method: 'cash', amountMinor: 10000, idempotencyKey: `recovery-payment-${proofSuffix}`, note: 'Synthetic recovery rehearsal: independently received cash' };
      const payment = await (await request(`/v1/admin/billing/invoices/${invoice.id}/payments`, body)).json();
      const retry = await (await request(`/v1/admin/billing/invoices/${invoice.id}/payments`, body)).json();
      assert.equal(retry.paymentId, payment.paymentId);
      assert.equal(retry.alreadyProcessed, true);
      const refundBody = { amountMinor: 2500, reason: 'Synthetic recovery partial refund', entitlementReversed: false };
      const refund = await (await request(`/v1/admin/billing/payments/${payment.paymentId}/refund`, refundBody, `recovery-refund-${proofSuffix}`)).json();
      const refundRetry = await (await request(`/v1/admin/billing/payments/${payment.paymentId}/refund`, refundBody, `recovery-refund-${proofSuffix}`)).json();
      assert.equal(refundRetry.refundId, refund.refundId);
      paymentProof = { invoiceId: invoice.id, paymentId: payment.paymentId, refundId: refund.refundId, outstandingMinor: invoice.total_minor - invoice.paid_minor - 10000, grossMinor: 10000, refundedMinor: 2500, retainedMinor: 7500 };
    }
    if (paymentProof) {
      const invoice = await (await request(`/v1/admin/billing/invoices/${paymentProof.invoiceId}`)).json();
      assert.equal(invoice.invoice.id, paymentProof.invoiceId);
      assert.equal(invoice.invoice.dueMinor, paymentProof.outstandingMinor);
      assert.equal(invoice.payments.filter((payment) => payment.id === paymentProof.paymentId).length, 1);
      assert.equal(invoice.refunds.filter((refund) => refund.id === paymentProof.refundId).length, 1);
      const receipt = await (await request(`/v1/admin/billing/payments/${paymentProof.paymentId}/receipt`)).text();
      assert.ok(receipt.includes(paymentProof.paymentId) && receipt.includes(paymentProof.refundId), 'Restored receipt lost its payment/refund identity.');
    }
    const read = await request('/v1/admin/dashboard');
    if (!read.ok) throw new Error(`Restored authenticated read failed with ${read.status}.`);
    const dashboard = await read.json();
    if (!dashboard || typeof dashboard !== 'object') throw new Error('Restored authenticated read returned no JSON object.');
    return { label, ready, authenticatedReadStatus: read.status, authenticatedInvoiceAndReceipt: Boolean(paymentProof) };
  } catch (error) {
    throw new Error(`${String(error)}\nRestored API logs:\n${logs}`, { cause: error });
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
      await exited;
      clearTimeout(timeout);
    }
  }
}

runPnpm(['-F', '@shark/api', 'migrate'], { SHARK_DB: source, NODE_ENV: 'test' });
runPnpm(['-F', '@shark/api', 'seed'], { SHARK_DB: source, NODE_ENV: 'test' });
const initialProof = await proveBootAndRead(source, 'initial', undefined, true);
writeRecoveryEvidence(source);
writeMediaEvidence(source);
const expectedState = snapshot(source);
const restartProof = await proveBootAndRead(source, 'restart');
verifyState(source, expectedState);

// Exercise a newly copied API artifact against the retained database. Installed
// dependencies are shared locally; container/host replacement is a separate gate.
const replacementApi = join(root, 'replacement', 'apps', 'api');
mkdirSync(replacementApi, { recursive: true });
cpSync(resolve(repository, 'apps/api/src'), join(replacementApi, 'src'), { recursive: true });
copyFileSync(resolve(repository, 'apps/api/package.json'), join(replacementApi, 'package.json'));
copyFileSync(resolve(repository, 'apps/api/tsconfig.json'), join(replacementApi, 'tsconfig.json'));
copyFileSync(resolve(repository, 'tsconfig.base.json'), join(root, 'replacement', 'tsconfig.base.json'));
symlinkSync(resolve(repository, 'apps/api/node_modules'), join(replacementApi, 'node_modules'), 'dir');
const replacementProof = await proveBootAndRead(source, 'replacement', replacementApi);
verifyState(source, expectedState);
const mediaAtBackup = mediaFingerprint(sourceMedia);
const backupResult = await createBackup(source, backup, { mediaDir: sourceMedia });
assert.equal(backupResult.metadata.media.fileCount, mediaAtBackup.length, 'The backup did not archive every media file.');
assert.equal(statSync(`${backup}.media.tar`).mode & 0o777, 0o600, 'Media archives must be owner-only.');
assert.equal(statSync(backup).mode & 0o777, 0o600, 'Backup records must be owner-only.');

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
const sameSizeCorruption = readFileSync(backup);
sameSizeCorruption[sameSizeCorruption.length - 1] ^= 1;
writeFileSync(corruptBackup, sameSizeCorruption);
await expectRestoreRefusal(
  () => restoreBackup(corruptBackup, corruptTarget),
  /checksum does not match/i,
  'A corrupt backup with unchanged size',
);
if (existsSync(corruptTarget)) throw new Error('A checksum mismatch created a restore target.');

// A media archive altered after the backup is refused before anything moves.
const mediaCorruptDirectory = join(root, 'corrupt-media');
const mediaCorruptBackup = join(mediaCorruptDirectory, 'backup.db');
const mediaCorruptTarget = join(root, 'corrupt-media-restored.db');
mkdirSync(mediaCorruptDirectory);
copyFileSync(backup, mediaCorruptBackup);
copyFileSync(`${backup}.manifest.json`, `${mediaCorruptBackup}.manifest.json`);
const tamperedArchive = readFileSync(`${backup}.media.tar`);
tamperedArchive[600] ^= 1;
writeFileSync(`${mediaCorruptBackup}.media.tar`, tamperedArchive);
await expectRestoreRefusal(
  () => restoreBackup(mediaCorruptBackup, mediaCorruptTarget, { mediaTarget: join(root, 'corrupt-media-restored') }),
  /media archive checksum does not match/i,
  'A media archive altered after the backup',
);
if (existsSync(mediaCorruptTarget) || existsSync(join(root, 'corrupt-media-restored'))) throw new Error('A corrupt media archive restored something.');

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

// A file written after the snapshot must not come back.
writeFileSync(join(sourceMedia, 'after-backup.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
// The CLI's choice of media directory: SHARK_MEDIA_DIR belongs to SHARK_DB
// only, so a restore into a scratch path never lands on (or, with --replace,
// wipes) the live photos.
{
  const saved = { db: process.env.SHARK_DB, media: process.env.SHARK_MEDIA_DIR };
  process.env.SHARK_DB = source;
  process.env.SHARK_MEDIA_DIR = sourceMedia;
  try {
    const scratch = join(root, 'scratch', 'shark.db');
    assert.equal(mediaDirectoryFor(scratch, { forRestore: true }), join(root, 'scratch', 'media'), 'A scratch restore must not use the live media directory.');
    assert.equal(mediaDirectoryFor(source, { forRestore: true }), resolve(sourceMedia), 'Restoring the live database restores its media directory.');
    assert.equal(mediaDirectoryFor(source), resolve(sourceMedia), 'Backing up the live database archives its media directory.');
    delete process.env.SHARK_DB;
    assert.equal(mediaDirectoryFor(scratch, { forRestore: true }), join(root, 'scratch', 'media'), 'Without SHARK_DB a restore stays beside its target.');
  } finally {
    for (const [key, value] of [['SHARK_DB', saved.db], ['SHARK_MEDIA_DIR', saved.media]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const restoreResult = await restoreBackup(backup, restored, { mediaTarget: restoredMedia });
assert.equal(statSync(restored).mode & 0o777, 0o600, 'Restored records must be owner-only.');
assert.deepEqual(restoreResult.media.fingerprint, mediaAtBackup, 'Restored media differs from the media at backup time.');
for (const suffix of ['', '-wal', '-shm']) rmSync(`${source}${suffix}`, { force: true });
rmSync(sourceMedia, { recursive: true, force: true });
const mediaFilesVerified = verifyMedia(restored, restoredMedia);
// Recovery must remain possible after the original synthetic database (and
// its media) are gone — both were removed above.
runPnpm(['-F', '@shark/api', 'migrate'], { SHARK_DB: restored, NODE_ENV: 'test' });
const restoredState = verifyState(restored, expectedState);
const runtimeProof = await proveBootAndRead(restored, 'recovery', replacementApi);
verifyState(restored, expectedState);

const evidence = {
  recoveryProof: 'passed',
  restoreGuards: ['source-target-separation', 'manifest-size-and-checksum', 'media-archive-and-per-file-checksums', 'explicit-overwrite-confirmation', 'owner-only-artifacts'],
  artifactDirectory: root,
  retainedArchiveDirectory: archive,
  recoveryDirectory: recovery,
  evidenceScope: 'Local production API processes; synthetic seeded fixtures; shared installed dependencies; no container, hosted, or off-instance-storage credit.',
  manifest: { ...backupResult.metadata, media: { ...backupResult.metadata.media, files: `${backupResult.metadata.media.fileCount} files listed with SHA-256` } },
  media: {
    restored: 'passed',
    directory: restoredMedia,
    filesVerifiedAgainstManifest: restoreResult.media.fileCount,
    filesVerifiedAgainstDatabaseRows: mediaFilesVerified,
    archiveSha256: backupResult.metadata.media.sha256,
    refusedTamperedArchive: true,
  },
  rowCounts: Object.fromEntries(Object.entries(restoredState).map(([table, value]) => [table, value.count])),
  recordFingerprints: restoredState,
  manualPaymentAndRefund: paymentProof,
  accountRecovery: accountRecoveryProof,
  runtimes: [initialProof, restartProof, replacementProof, runtimeProof],
  readiness: runtimeProof.ready,
  authenticatedReadStatus: runtimeProof.authenticatedReadStatus,
};
writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
