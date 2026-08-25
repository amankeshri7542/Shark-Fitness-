import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// The SQLite driver is owned by the API workspace, while this deliberately
// lives at repository level so operators have one documented recovery command.
const requireFromApi = createRequire(resolve(process.cwd(), 'apps/api/package.json'));
const Database = requireFromApi('better-sqlite3');

const usage = `Usage:
  node scripts/sqlite-backup.mjs backup <source.db> [backup-directory]
  node scripts/sqlite-backup.mjs restore <backup.db> <target.db> [--replace --yes-replace]
  node scripts/sqlite-backup.mjs verify [working-directory]

backup uses SQLite's online backup API and verifies PRAGMA integrity_check.
restore never overwrites an existing target unless both destructive flags are supplied.
verify is self-contained: fixture -> backup -> mutate -> restore -> compare.`;

function fail(message) {
  throw new Error(`${message}\n\n${usage}`);
}

function absolute(path) {
  return resolve(process.cwd(), path);
}

function stamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
}

function assertFile(path, label) {
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
}

function integrity(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`SQLite integrity_check failed for ${path}: ${String(result)}`);
  } finally {
    db.close();
  }
}

async function backup(source, destination) {
  assertFile(source, 'Source database');
  if (existsSync(destination)) fail(`Refusing to overwrite backup: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  integrity(destination);
  return destination;
}

async function commandBackup(args) {
  const [sourceArg, directoryArg = 'backups'] = args;
  if (!sourceArg) fail('A source database is required.');
  const source = absolute(sourceArg);
  const directory = absolute(directoryArg);
  const destination = resolve(directory, `${basename(source, '.db')}-${stamp()}.db`);
  console.log(`backup=${await backup(source, destination)}`);
}

async function commandRestore(args) {
  const [backupArg, targetArg, ...flags] = args;
  if (!backupArg || !targetArg) fail('A backup and a target path are required.');
  const source = absolute(backupArg);
  const target = absolute(targetArg);
  assertFile(source, 'Backup database');
  const destructive = flags.includes('--replace') && flags.includes('--yes-replace');
  if (existsSync(target) && !destructive) {
    fail(`Refusing to overwrite existing restore target: ${target}. Supply --replace --yes-replace only after validating the target.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) rmSync(target);
  await backup(source, target);
  console.log(`restored=${target}`);
}

async function commandVerify(args) {
  const root = absolute(args[0] ?? '.sqlite-backup-verify');
  if (existsSync(root)) fail(`Verification directory already exists: ${root}. Pick an empty path.`);
  mkdirSync(root, { recursive: true });
  const source = resolve(root, 'fixture.db');
  const backupPath = resolve(root, 'fixture-backup.db');
  const restored = resolve(root, 'fixture-restored.db');
  const fixture = new Database(source);
  try {
    fixture.exec('create table proof (id integer primary key, value text not null); insert into proof (value) values (\'before-backup\');');
  } finally {
    fixture.close();
  }
  await backup(source, backupPath);
  const mutated = new Database(source);
  try {
    mutated.prepare('insert into proof (value) values (?)').run('after-backup');
  } finally {
    mutated.close();
  }
  await backup(backupPath, restored);
  const restoredDb = new Database(restored, { readonly: true, fileMustExist: true });
  try {
    const values = restoredDb.prepare('select value from proof order by id').all().map((row) => row.value);
    if (values.length !== 1 || values[0] !== 'before-backup') throw new Error('Restore verification did not recover the pre-mutation state.');
  } finally {
    restoredDb.close();
  }
  integrity(source);
  integrity(backupPath);
  integrity(restored);
  console.log(`verified=${root}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'backup') await commandBackup(args);
else if (command === 'restore') await commandRestore(args);
else if (command === 'verify') await commandVerify(args);
else fail('Choose backup, restore, or verify.');
