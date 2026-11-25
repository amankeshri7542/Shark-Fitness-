import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The private media directory as one tar archive beside a database backup
 * (P05). Plain POSIX ustar, regular files only, written and read here so a
 * restore needs nothing but Node — no system tar, no extra package.
 *
 * Every file's SHA-256 goes into the backup manifest, and a restore checks
 * each one before anything is put in place.
 */

const BLOCK = 512;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Every regular file under `root`, as sorted POSIX relative paths. */
export function listMediaFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !entry.name.endsWith('.part')) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(path, size, mtimeSec) {
  if (Buffer.byteLength(path) > 100) throw new Error(`Media path too long for the archive: ${path}`);
  const block = Buffer.alloc(BLOCK, 0);
  block.write(path, 0, 'utf8');
  block.write(octal(0o600, 8), 100, 'latin1');
  block.write(octal(0, 8), 108, 'latin1');
  block.write(octal(0, 8), 116, 'latin1');
  block.write(octal(size, 12), 124, 'latin1');
  block.write(octal(mtimeSec, 12), 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write('0', 156, 'latin1');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

/**
 * Writes `root` to `archivePath` (owner-only) and returns the manifest
 * section: the archive's own checksum and every file's.
 */
export function writeMediaArchive(root, archivePath) {
  const files = listMediaFiles(root);
  const fd = openSync(archivePath, 'wx', 0o600);
  const entries = [];
  try {
    for (const path of files) {
      const bytes = readFileSync(join(root, path));
      const mtime = Math.floor(statSync(join(root, path)).mtimeMs / 1000);
      writeSync(fd, header(path, bytes.length, mtime));
      writeSync(fd, bytes);
      const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
      if (pad) writeSync(fd, Buffer.alloc(pad, 0));
      entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    writeSync(fd, Buffer.alloc(BLOCK * 2, 0));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const archive = readFileSync(archivePath);
  return { archiveSizeBytes: archive.length, sha256: sha256(archive), fileCount: entries.length, files: entries };
}

/** Reads every file out of an archive written by `writeMediaArchive`. */
export function readMediaArchive(archivePath) {
  const archive = readFileSync(archivePath);
  const files = [];
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const path = block.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const size = Number.parseInt(block.toString('latin1', 124, 136).replace(/\0.*$/s, '').trim(), 8);
    if (!path || !Number.isSafeInteger(size) || block[156] !== 0x30) throw new Error('The media archive is damaged.');
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`The media archive holds an unsafe path: ${path}`);
    const start = offset + BLOCK;
    if (start + size > archive.length) throw new Error('The media archive is truncated.');
    files.push({ path, bytes: archive.subarray(start, start + size) });
    offset = start + size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  return files;
}

/**
 * Checks an archive against its manifest section and writes the files under
 * `destination` (which must be empty or absent). Throws before writing
 * anything if a single file's checksum disagrees.
 */
export function extractMediaArchive(archivePath, media, destination) {
  const archive = readFileSync(archivePath);
  if (archive.length !== media.archiveSizeBytes) throw new Error('Media archive size does not match its manifest. Refusing to restore.');
  if (sha256(archive) !== media.sha256) throw new Error('Media archive checksum does not match its manifest. Refusing to restore.');
  const files = readMediaArchive(archivePath);
  const expected = new Map(media.files.map((file) => [file.path, file]));
  if (files.length !== expected.size) throw new Error('Media archive file count does not match its manifest. Refusing to restore.');
  for (const file of files) {
    const want = expected.get(file.path);
    if (!want || want.bytes !== file.bytes.length || want.sha256 !== sha256(file.bytes)) {
      throw new Error(`Media file checksum does not match its manifest: ${file.path}. Refusing to restore.`);
    }
  }
  const base = resolve(destination);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const full = resolve(base, file.path);
    if (!full.startsWith(`${base}${sep}`)) throw new Error(`Refusing to write outside the media directory: ${file.path}`);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    const fd = openSync(full, 'wx', 0o600);
    try {
      writeSync(fd, file.bytes);
    } finally {
      closeSync(fd);
    }
  }
  return { fileCount: files.length };
}

/** Per-file checksums of a directory, for comparing a restore to its source. */
export function mediaFingerprint(root) {
  return listMediaFiles(root).map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
}
