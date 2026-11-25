import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { runtimeConfig } from './config.js';

/**
 * Private media storage (seam shared with P05).
 *
 * `MediaStorage` is the port P05 describes for progress photos: a local-disk
 * adapter rooted at `SHARK_MEDIA_DIR`, outside any static root, with files
 * served only through short-lived HMAC-signed URLs that re-check who is
 * asking when they are used. P07 needs the same thing for message
 * attachments, so this file is the smallest version of that port. When P05
 * merges, its adapter replaces `localDiskStorage` and its signer replaces
 * `signMediaPath`/`verifyMediaSignature`; callers only use these four names.
 */
export interface MediaStorage {
  put(key: string, bytes: Uint8Array): void;
  read(key: string): Buffer | null;
  remove(key: string): void;
}

export function localDiskStorage(root: string): MediaStorage {
  const base = resolve(root);
  const pathFor = (key: string): string => {
    if (!/^[a-z0-9_/.-]+$/i.test(key) || key.includes('..')) throw new Error('Invalid media key.');
    const full = resolve(join(base, key));
    if (!full.startsWith(base + sep)) throw new Error('Media key escapes the media folder.');
    return full;
  };
  return {
    put(key, bytes) {
      const full = pathFor(key);
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
      writeFileSync(full, bytes, { mode: 0o600 });
    },
    read(key) {
      try {
        return readFileSync(pathFor(key));
      } catch {
        return null;
      }
    },
    remove(key) {
      rmSync(pathFor(key), { force: true });
    },
  };
}

let active: MediaStorage | null | undefined;

/** The configured store, or null when uploads are off (production without SHARK_MEDIA_DIR). */
export function mediaStorage(): MediaStorage | null {
  if (active === undefined) active = runtimeConfig.mediaDir ? localDiskStorage(runtimeConfig.mediaDir) : null;
  return active;
}

/** Tests point the store at a temporary folder; `undefined` resets to config. */
export function setMediaStorage(next: MediaStorage | null | undefined): void {
  active = next;
}

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
 * GPS; APP13 carries IPTC) and PNG text/EXIF chunks, so a photo of a bruise
 * does not tell the coach where the member lives. Image data is untouched.
 */
export function stripImageMetadata(mime: string, bytes: Uint8Array): Uint8Array {
  if (mime === 'image/jpeg') return stripJpeg(bytes);
  if (mime === 'image/png') return stripPng(bytes);
  return bytes;
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
