import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = mkdtempSync(join(tmpdir(), 'shark-deployment-proof-'));
const repository = process.cwd();
const database = join(root, 'configured.db');
const log = join(root, 'commands');
// Exercise the real entrypoint without starting or seeding an application.
writeFileSync(join(root, 'pnpm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PROOF_LOG"\n', { mode: 0o700 });
function boot(seed) {
  writeFileSync(log, '');
  const result = spawnSync('sh', [resolve(repository, '../docker-entrypoint.sh')], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SHARK_DB: database, SHARK_SEED_DEMO: seed, PROOF_LOG: log },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(log, 'utf8').trim().split('\n');
}
assert.deepEqual(boot('false'), ['db:migrate', '-F @shark/api start']);
assert.deepEqual(boot('true'), ['db:migrate', 'db:seed', '-F @shark/api start']);
const require = createRequire(resolve(repository, 'apps/api/package.json'));
const Database = require('better-sqlite3');
const db = new Database(database);
db.exec("create table proof (value text); insert into proof values ('configured-database')");
db.close();
assert.deepEqual(boot('true'), ['db:migrate', '-F @shark/api start']);
const backup = spawnSync(process.execPath, [resolve(repository, 'scripts/sqlite-backup.mjs'), 'backup'], {
  cwd: root, env: { ...process.env, SHARK_DB: database }, encoding: 'utf8',
});
assert.equal(backup.status, 0, backup.stderr);
const artifact = readdirSync(join(root, 'backups')).find((name) => name.endsWith('.db'));
assert.ok(artifact);
const saved = new Database(join(root, 'backups', artifact), { readonly: true });
assert.equal(saved.prepare('select value from proof').pluck().get(), 'configured-database');
saved.close();
console.log(`Deployment guards passed: no implicit seed, no reseed, configured backup source. Artifacts: ${root}`);
