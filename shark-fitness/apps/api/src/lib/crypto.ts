import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Stable hash of a request body for idempotency conflict detection. */
export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/** Generic HMAC-SHA256 verifier for adapters that use this common scheme. */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  return constantTimeEqual(expected, signature);
}
