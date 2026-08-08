import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * We do not implement password or token cryptography by hand beyond this file,
 * and this file only composes Node primitives (Engineering PRD: "Do not
 * implement custom password/token cryptography"). Swapping in Better Auth means
 * replacing these four functions, nothing else.
 */

const SCRYPT_N = 16_384;
const KEY_LEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N }).toString('hex');
  return `scrypt$${SCRYPT_N}$${salt}$${key}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [scheme, n, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !salt || !key) return false;
  const candidate = scryptSync(plain, salt, KEY_LEN, { N: Number(n) });
  const expected = Buffer.from(key, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Session tokens are stored hashed, so a database dump does not grant access. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Stable hash of a request body, so an idempotency key replayed with a
 *  *different* payload is a conflict rather than a silent no-op. */
export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/** HMAC-ish signature check for provider webhooks. Real adapters use the
 *  provider's own scheme; this is the shape the port expects. */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHash('sha256').update(`${secret}.${payload}`).digest('hex');
  return constantTimeEqual(expected, signature);
}
