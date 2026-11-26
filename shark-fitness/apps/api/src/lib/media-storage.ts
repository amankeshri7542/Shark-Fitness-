import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { runtimeConfig } from './config.js';

/**
 * Where private files live. One port, one adapter today: a directory on the
 * API host's disk (`SHARK_MEDIA_DIR`), outside every static root (checked at
 * boot in lib/config.ts), included in backups (scripts/sqlite-backup.mjs
 * archives the whole directory). Object storage stays refused
 * (`SHARK_MEDIA_BUCKET`) until an adapter for it exists.
 *
 * Two kinds of file share it since the P05/P07 integration:
 * - progress photos and other `media_objects` (P05), keyed
 *   `<tenant>/<year>/<media id>.<ext>`, served only through
 *   `GET /v1/files/:id` with a viewer-bound signature (services/media.ts);
 * - message attachments (P07), keyed `attachments/<tenant>/<conversation>/<id>`,
 *   served through the messaging routes with the path signature below, which
 *   re-check the caller's access when used.
 *
 * Nothing here decides who may read a file.
 */
export interface MediaStorage {
  readonly kind: 'local-disk';
  put(key: string, bytes: Uint8Array): void;
  get(key: string): Buffer | null;
  /** True when a file was removed. */
  delete(key: string): boolean;
}

const KEYS = [
  // P05 media objects.
  /^[a-z0-9_]+\/[0-9]{4}\/[a-z0-9_]+\.(jpg|png|webp)$/,
  // P07 message attachments.
  /^attachments\/[a-z0-9_]+\/[a-z0-9_]+\/[a-z0-9_]+$/,
];

export function localDiskStorage(root: string): MediaStorage {
  const base = resolve(root);
  const pathFor = (key: string): string => {
    if (!KEYS.some((pattern) => pattern.test(key))) throw new Error('Refusing an unexpected media key.');
    const full = resolve(join(base, key));
    if (!full.startsWith(`${base}${sep}`)) throw new Error('Refusing a media key outside the media directory.');
    return full;
  };
  return {
    kind: 'local-disk',
    put(key, bytes) {
      const full = pathFor(key);
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
      // Written beside its final name and renamed into place, so a crash
      // never leaves half a file where a whole one is expected.
      const temporary = `${full}.${randomBytes(6).toString('hex')}.part`;
      writeFileSync(temporary, bytes, { mode: 0o600 });
      renameSync(temporary, full);
    },
    get(key) {
      const full = pathFor(key);
      return existsSync(full) ? readFileSync(full) : null;
    },
    delete(key) {
      const full = pathFor(key);
      if (!existsSync(full)) return false;
      rmSync(full, { force: true });
      return true;
    },
  };
}

let override: MediaStorage | null | undefined;

/** The configured storage, or null when uploads are switched off. */
export function mediaStorage(): MediaStorage | null {
  if (override !== undefined) return override;
  return runtimeConfig.mediaDir ? localDiskStorage(runtimeConfig.mediaDir) : null;
}

/** Tests point the store at a temporary folder (or null: uploads off);
 *  `undefined` goes back to the configuration. */
export function setMediaStorageForTests(storage: MediaStorage | null | undefined): void {
  override = storage;
}

/** P07's name for the same test hook. */
export const setMediaStorage = setMediaStorageForTests;

/* ——— Signed URLs ——————————————————————————————————————————— */

export const MEDIA_URL_TTL_MS = 5 * 60_000;

const signingKey = Buffer.from(hkdfSync('sha256', Buffer.from(runtimeConfig.passSecret, 'utf8'), Buffer.alloc(0), 'shark:media-url', 32));

function signature(path: string, expiresAt: number): string {
  return createHmac('sha256', signingKey).update(`${path}\n${expiresAt}`).digest('base64url');
}

/** `/v1/…?exp=…&sig=…`, valid for `ttlMs`. Possession alone is not enough:
 *  the serving route also checks the caller may see the file. */
export function signMediaPath(path: string, atMs: number, ttlMs = MEDIA_URL_TTL_MS): string {
  const expiresAt = atMs + ttlMs;
  return `${path}?exp=${expiresAt}&sig=${signature(path, expiresAt)}`;
}

export type MediaSignatureCheck = 'ok' | 'expired' | 'invalid';

export function verifyMediaSignature(path: string, exp: string | undefined, sig: string | undefined, atMs: number): MediaSignatureCheck {
  const expiresAt = Number(exp);
  if (!sig || !Number.isSafeInteger(expiresAt)) return 'invalid';
  const expected = Buffer.from(signature(path, expiresAt));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  return expiresAt < atMs ? 'expired' : 'ok';
}

/* ——— File checks ——————————————————————————————————————————— */

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const SIGNATURES: Array<{ mime: string; test: (b: Uint8Array) => boolean }> = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
  {
    mime: 'image/webp',
    test: (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
  },
  { mime: 'application/pdf', test: (b) => String.fromCharCode(...b.slice(0, 5)) === '%PDF-' },
];

/** The type the bytes actually are — never the name or the declared type. */
export function sniffMime(bytes: Uint8Array): string | null {
  return SIGNATURES.find((s) => s.test(bytes))?.mime ?? null;
}

/**
 * Drops metadata segments a phone writes into a JPEG (APP1 Exif/XMP carries
 * GPS; APP13 carries IPTC), PNG text/EXIF chunks and WebP EXIF/XMP chunks, so a photo of a bruise
 * does not tell the coach where the member lives. Image data is untouched.
 */
export function stripImageMetadata(mime: string, bytes: Uint8Array): Uint8Array {
  if (mime === 'image/jpeg') return stripJpeg(bytes);
  if (mime === 'image/png') return stripPng(bytes);
  if (mime === 'image/webp') return stripWebp(bytes);
  return bytes;
}

/** WebP is RIFF: drop the EXIF and XMP chunks and clear their VP8X flags. */
function stripWebp(b: Uint8Array): Uint8Array {
  const keep: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const size = (b[i + 4]! | (b[i + 5]! << 8) | (b[i + 6]! << 16) | (b[i + 7]! << 24)) >>> 0;
    const end = Math.min(b.length, i + 8 + size + (size % 2));
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = b.slice(i, end);
      // VP8X flags byte: bit 3 = Exif present, bit 2 = XMP present.
      if (type === 'VP8X' && chunk.length > 8) chunk[8] = chunk[8]! & ~0x0c;
      keep.push(chunk);
    }
    i = end;
  }
  const total = 12 + keep.reduce((n, part) => n + part.length, 0);
  const result = new Uint8Array(total);
  result.set(b.subarray(0, 12), 0);
  const riffSize = total - 8;
  result[4] = riffSize & 0xff;
  result[5] = (riffSize >>> 8) & 0xff;
  result[6] = (riffSize >>> 16) & 0xff;
  result[7] = (riffSize >>> 24) & 0xff;
  let offset = 12;
  for (const part of keep) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe; // APP1, APP13, COM
    if (!drop) for (let j = i; j < i + 2 + length && j < b.length; j++) out.push(b[j]!);
    i += 2 + length;
  }
  const rest = b.subarray(i);
  const result = new Uint8Array(out.length + rest.length);
  result.set(out, 0);
  result.set(rest, out.length);
  return result;
}

function stripPng(b: Uint8Array): Uint8Array {
  const keep: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + length;
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) keep.push(b.subarray(i, Math.min(end, b.length)));
    i = end;
  }
  const total = keep.reduce((n, part) => n + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of keep) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
