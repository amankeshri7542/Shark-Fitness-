import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeSync } from 'node:fs';
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
/** Archives are read in pieces of this size, never whole: the media
 *  directory of a busy gym can pass the 2 GiB a single Buffer can hold. */
const CHUNK = 1024 * 1024;

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
  return { archiveSizeBytes: statSync(archivePath).size, sha256: sha256Range(archivePath, 0, statSync(archivePath).size), fileCount: entries.length, files: entries };
}

/** SHA-256 of `length` bytes of a file from `start`, read in chunks. */
function sha256Range(path, start, length) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    let done = 0;
    while (done < length) {
      const read = readSync(fd, buffer, 0, Math.min(CHUNK, length - done), start + done);
      if (read === 0) throw new Error('The media archive is truncated.');
      hash.update(buffer.subarray(0, read));
      done += read;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** The entries of an archive written by `writeMediaArchive`: path, size and
 *  where the data starts. Reads headers only. */
function archiveEntries(archivePath) {
  const total = statSync(archivePath).size;
  const fd = openSync(archivePath, 'r');
  const entries = [];
  try {
    const block = Buffer.alloc(BLOCK);
    let offset = 0;
    while (offset + BLOCK <= total) {
      if (readSync(fd, block, 0, BLOCK, offset) !== BLOCK) throw new Error('The media archive is truncated.');
      if (block.every((byte) => byte === 0)) break;
      const path = block.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      const size = Number.parseInt(block.toString('latin1', 124, 136).replace(/\0.*$/s, '').trim(), 8);
      if (!path || !Number.isSafeInteger(size) || block[156] !== 0x30) throw new Error('The media archive is damaged.');
      if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`The media archive holds an unsafe path: ${path}`);
      const start = offset + BLOCK;
      if (start + size > total) throw new Error('The media archive is truncated.');
      entries.push({ path, size, start });
      offset = start + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    }
  } finally {
    closeSync(fd);
  }
  return entries;
}

/** Reads every file out of an archive written by `writeMediaArchive`. */
export function readMediaArchive(archivePath) {
  return archiveEntries(archivePath).map((entry) => {
    const bytes = Buffer.alloc(entry.size);
    const fd = openSync(archivePath, 'r');
    try {
      if (entry.size > 0 && readSync(fd, bytes, 0, entry.size, entry.start) !== entry.size) throw new Error('The media archive is truncated.');
    } finally {
      closeSync(fd);
    }
    return { path: entry.path, bytes };
  });
}

/**
 * Checks an archive against its manifest section and writes the files under
 * `destination` (which must be empty or absent). Throws before writing
 * anything if a single file's checksum disagrees.
 */
export function extractMediaArchive(archivePath, media, destination) {
  const size = statSync(archivePath).size;
  if (size !== media.archiveSizeBytes) throw new Error('Media archive size does not match its manifest. Refusing to restore.');
  if (sha256Range(archivePath, 0, size) !== media.sha256) throw new Error('Media archive checksum does not match its manifest. Refusing to restore.');
  const files = archiveEntries(archivePath);
  const expected = new Map(media.files.map((file) => [file.path, file]));
  if (files.length !== expected.size) throw new Error('Media archive file count does not match its manifest. Refusing to restore.');
  for (const file of files) {
    const want = expected.get(file.path);
    if (!want || want.bytes !== file.size || want.sha256 !== sha256Range(archivePath, file.start, file.size)) {
      throw new Error(`Media file checksum does not match its manifest: ${file.path}. Refusing to restore.`);
    }
  }
  const base = resolve(destination);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const source = openSync(archivePath, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    for (const file of files) {
      const full = resolve(base, file.path);
      if (!full.startsWith(`${base}${sep}`)) throw new Error(`Refusing to write outside the media directory: ${file.path}`);
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
      const fd = openSync(full, 'wx', 0o600);
      try {
        let done = 0;
        while (done < file.size) {
          const read = readSync(source, buffer, 0, Math.min(CHUNK, file.size - done), file.start + done);
          if (read === 0) throw new Error('The media archive is truncated.');
          writeSync(fd, buffer, 0, read);
          done += read;
        }
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    closeSync(source);
  }
  return { fileCount: files.length };
}

/** Per-file checksums of a directory, for comparing a restore to its source. */
export function mediaFingerprint(root) {
  return listMediaFiles(root).map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
}
