import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { runtimeConfig } from './config.js';

/**
 * Application-level encryption for the few secrets the server must be able to
 * read back: TOTP seeds and webhook signing secrets (PRD 04 ENT-DATA-004,
 * "application-level protection for selected highly sensitive fields").
 *
 * AES-256-GCM with a random 96-bit IV per value. One master key
 * (`SHARK_MFA_ENCRYPTION_KEY`) is split by HKDF into a key per purpose, so a
 * ciphertext from one table can never be decrypted as if it came from another.
 * The purpose is also bound as additional authenticated data, together with
 * the row it belongs to, so copying a ciphertext onto another user fails.
 *
 * Format: `v1:<iv b64url>:<tag b64url>:<ciphertext b64url>`.
 */

export type EncryptionPurpose = 'mfa-totp' | 'webhook-secret';

const VERSION = 'v1';
const keys = new Map<EncryptionPurpose, Buffer>();

function keyFor(purpose: EncryptionPurpose, master: Buffer): Buffer {
  if (master !== runtimeConfig.mfaEncryptionKey) {
    return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `shark:${purpose}`, 32));
  }
  let key = keys.get(purpose);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `shark:${purpose}`, 32));
    keys.set(purpose, key);
  }
  return key;
}

export function encryptField(
  purpose: EncryptionPurpose,
  owner: string,
  plaintext: string,
  master: Buffer = runtimeConfig.mfaEncryptionKey,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose, master), iv);
  cipher.setAAD(Buffer.from(`${purpose}:${owner}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export class FieldDecryptionError extends Error {
  constructor() {
    super('A stored secret could not be decrypted. Check SHARK_MFA_ENCRYPTION_KEY.');
    this.name = 'FieldDecryptionError';
  }
}

export function decryptField(
  purpose: EncryptionPurpose,
  owner: string,
  stored: string,
  master: Buffer = runtimeConfig.mfaEncryptionKey,
): string {
  const [version, iv, tag, ciphertext] = stored.split(':');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new FieldDecryptionError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose, master), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${purpose}:${owner}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new FieldDecryptionError();
  }
}
