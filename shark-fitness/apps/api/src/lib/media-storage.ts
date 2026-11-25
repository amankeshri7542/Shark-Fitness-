import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimeConfig } from './config.js';

/**
 * Where private files live (P05). One port, one adapter today: a directory on
 * the API host's disk, outside every static root (checked at boot in
 * lib/config.ts), included in backups (scripts/sqlite-backup.mjs). Object
 * storage stays refused (`SHARK_MEDIA_BUCKET`) until an adapter for it exists.
 *
 * Nothing here decides who may read a file. Bytes leave only through
 * `GET /v1/files/:id`, which checks a short-lived signature and then the
 * viewer's current right to see it (services/media.ts).
 */
export interface MediaStorage {
  readonly kind: 'local-disk';
  put(key: string, bytes: Buffer): void;
  get(key: string): Buffer | null;
  /** True when a file was removed. */
  delete(key: string): boolean;
}

const KEY = /^[a-z0-9_]+\/[0-9]{4}\/[a-z0-9_]+\.(jpg|png|webp)$/;

export function localDiskStorage(root: string): MediaStorage {
  const base = resolve(root);
  const pathFor = (key: string): string => {
    if (!KEY.test(key)) throw new Error('Refusing an unexpected media key.');
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
      // never leaves half a photo where a whole one is expected.
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

export function setMediaStorageForTests(storage: MediaStorage | null | undefined): void {
  override = storage;
}
