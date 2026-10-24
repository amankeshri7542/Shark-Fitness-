import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The SQLite driver is owned by the API workspace, while this deliberately
// lives at repository level so operators have one documented recovery command.
const apiDirectory = fileURLToPath(new URL('../apps/api/', import.meta.url));
const requireFromApi = createRequire(resolve(apiDirectory, 'package.json'));
const Database = requireFromApi('better-sqlite3');

const usage = `Usage:
  node scripts/sqlite-backup.mjs backup [source.db] [backup-directory]
  node scripts/sqlite-backup.mjs restore <backup.db> <target.db> [--replace --yes-replace]
  node scripts/sqlite-backup.mjs verify [working-directory]

backup uses SQLite's online backup API, verifies integrity, and writes a checksummed sidecar manifest.
restore requires and verifies that manifest, and never overwrites without both destructive flags.
verify is a fast artifact-level checksum/restore probe; pnpm db:backup:verify runs the full application recovery proof.`;

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
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${label} does not exist: ${path}`);
}

async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function manifestPath(databasePath) {
  return `${databasePath}.manifest.json`;
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

async function readAndVerifyManifest(databasePath) {
  const sidecar = manifestPath(databasePath);
  assertFile(sidecar, 'Backup manifest');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(sidecar, 'utf8'));
  } catch {
    fail(`Backup manifest is not valid JSON: ${sidecar}`);
  }
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.databaseFile !== basename(databasePath) ||
    !Number.isInteger(manifest.databaseSizeBytes) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')
  ) {
    fail(`Backup manifest has an unsupported or incomplete shape: ${sidecar}`);
  }
  const size = statSync(databasePath).size;
  if (size !== manifest.databaseSizeBytes) {
    fail(`Backup size does not match its manifest: expected ${manifest.databaseSizeBytes}, received ${size}.`);
  }
  const actual = await checksum(databasePath);
  if (actual !== manifest.sha256) fail('Backup checksum does not match its manifest. Refusing to restore.');
  return manifest;
}

export async function createBackup(source, destination) {
  assertFile(source, 'Source database');
  const sidecar = manifestPath(destination);
  const manifestTemporary = `${sidecar}.tmp`;
  if (existsSync(destination) || existsSync(sidecar) || existsSync(manifestTemporary)) {
    fail(`Refusing to overwrite backup: ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  // SQLite otherwise creates an archive readable by other local users under a
  // typical umask. Reserve it privately before writing any customer records.
  writeFileSync(destination, '', { flag: 'wx', mode: 0o600 });
  try {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      // better-sqlite3 delegates to sqlite3_backup: the snapshot is consistent
      // even when the live source is using WAL and continues to receive writes.
      await db.backup(destination);
    } finally {
      db.close();
    }
    integrity(destination);
    const probe = new Database(destination, { readonly: true, fileMustExist: true });
    let sqlite;
    try {
      sqlite = {
        pageCount: probe.pragma('page_count', { simple: true }),
        pageSizeBytes: probe.pragma('page_size', { simple: true }),
      };
    } finally {
      probe.close();
    }
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      databaseFile: basename(destination),
      databaseSizeBytes: statSync(destination).size,
      sha256: await checksum(destination),
      sqlite,
    };
    writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(manifestTemporary, sidecar);
    return { database: destination, manifest: sidecar, metadata: manifest };
  } catch (error) {
    rmSync(destination, { force: true });
    rmSync(sidecar, { force: true });
    rmSync(manifestTemporary, { force: true });
    throw error;
  }
}

export async function restoreBackup(source, target, { replace = false } = {}) {
  const sourcePath = resolve(source);
  const targetPath = resolve(target);
  if (sourcePath === targetPath) fail('The restore target must be different from the backup artifact.');
  assertFile(sourcePath, 'Backup database');
  const manifest = await readAndVerifyManifest(sourcePath);
  const targets = [targetPath, `${targetPath}-wal`, `${targetPath}-shm`];
  if (targets.some(existsSync) && !replace) {
    fail(`Refusing to overwrite existing restore target: ${targetPath}. Supply --replace --yes-replace only after validating the target.`);
  }
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(targetPath), `.${basename(targetPath)}.restore-${process.pid}-${Date.now()}.tmp`);
  if (existsSync(temporary)) fail(`Temporary restore target already exists: ${temporary}`);
  writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });

  try {
    const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await db.backup(temporary);
    } finally {
      db.close();
    }
    // The new database is complete and healthy before an existing target is
    // touched. A failed backup or integrity check therefore cannot destroy the
    // operator's current file.
    integrity(temporary);
    if (replace) for (const path of targets) rmSync(path, { force: true });
    renameSync(temporary, targetPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { target: targetPath, manifest };
}

async function commandBackup(args) {
  const [sourceArg = resolve(apiDirectory, process.env.SHARK_DB || 'data/shark.db'), directoryArg = 'backups'] = args;
  if (!process.env.SHARK_DB && !args[0] && process.env.NODE_ENV === 'production') fail('SHARK_DB or an explicit source is required in production.');
  const source = absolute(sourceArg);
  const directory = absolute(directoryArg);
  const destination = resolve(directory, `${basename(source, '.db')}-${stamp()}.db`);
  const result = await createBackup(source, destination);
  console.log(`backup=${result.database}`);
  console.log(`manifest=${result.manifest}`);
  console.log(`sha256=${result.metadata.sha256}`);
}

async function commandRestore(args) {
  const [backupArg, targetArg, ...flags] = args;
  if (!backupArg || !targetArg) fail('A backup and a target path are required.');
  const destructive = flags.includes('--replace') && flags.includes('--yes-replace');
  if (flags.includes('--replace') !== flags.includes('--yes-replace')) {
    fail('Destructive restore requires both --replace and --yes-replace.');
  }
  const result = await restoreBackup(absolute(backupArg), absolute(targetArg), { replace: destructive });
  console.log(`restored=${result.target}`);
  console.log(`verifiedSha256=${result.manifest.sha256}`);
}

async function commandVerify(args) {
  const root = absolute(args[0] ?? `.sqlite-backup-verify-${stamp()}`);
  if (existsSync(root)) fail(`Verification directory already exists: ${root}. Pick an empty path.`);
  mkdirSync(root, { recursive: true });
  const source = resolve(root, 'fixture.db');
  const backupPath = resolve(root, 'fixture-backup.db');
  const restored = resolve(root, 'fixture-restored.db');
  const fixture = new Database(source);
  try {
    fixture.pragma('journal_mode = WAL');
    fixture.exec("create table proof (id integer primary key, value text not null); insert into proof (value) values ('before-backup');");
  } finally {
    fixture.close();
  }
  await createBackup(source, backupPath);
  const mutated = new Database(source);
  try {
    mutated.prepare('insert into proof (value) values (?)').run('after-backup');
  } finally {
    mutated.close();
  }
  await restoreBackup(backupPath, restored);
  const restoredDb = new Database(restored, { readonly: true, fileMustExist: true });
  try {
    const values = restoredDb.prepare('select value from proof order by id').all().map((row) => row.value);
    if (values.length !== 1 || values[0] !== 'before-backup') throw new Error('Restore verification did not recover the snapshot state.');
  } finally {
    restoredDb.close();
  }
  console.log(`verified=${root}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'backup') await commandBackup(args);
  else if (command === 'restore') await commandRestore(args);
  else if (command === 'verify') await commandVerify(args);
  else fail('Choose backup, restore, or verify.');
}
