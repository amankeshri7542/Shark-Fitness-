import { createHmac, timingSafeEqual } from 'node:crypto';
import { token } from './ids.js';

export const PASS_WINDOW_SECONDS = 30;
const DEFAULT_BATCH_WINDOWS = 20;
const MAX_CLOCK_SKEW_WINDOWS = 1;

export interface PassTokenPayload {
  v: 1;
  tenantId: string;
  memberId: string;
  window: number;
  nonce: string;
}

export interface IssuedPass {
  token: string;
  window: number;
  validFrom: number;
  expiresAt: number;
}

function signingSecret(): string {
  const configured = process.env.SHARK_PASS_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SHARK_PASS_SECRET is required in production');
  }
  return 'development-only-pass-secret-change-before-deploying';
}

function encode(payload: PassTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function signature(encodedPayload: string): string {
  return createHmac('sha256', signingSecret()).update(encodedPayload).digest('base64url');
}

export function issuePassBatch(
  tenantId: string,
  memberId: string,
  epochSeconds = Math.floor(Date.now() / 1000),
  count = DEFAULT_BATCH_WINDOWS,
): IssuedPass[] {
  const currentWindow = Math.floor(epochSeconds / PASS_WINDOW_SECONDS);
  return Array.from({ length: count }, (_, offset) => {
    const window = currentWindow + offset;
    const payload: PassTokenPayload = {
      v: 1,
      tenantId,
      memberId,
      window,
      nonce: token(12),
    };
    const encoded = encode(payload);
    return {
      token: `${encoded}.${signature(encoded)}`,
      window,
      validFrom: window * PASS_WINDOW_SECONDS,
      expiresAt: (window + 1) * PASS_WINDOW_SECONDS,
    };
  });
}

export function verifyPassToken(
  raw: string,
  epochSeconds = Math.floor(Date.now() / 1000),
): { valid: true; payload: PassTokenPayload } | { valid: false; reason: 'malformed' | 'signature' | 'expired' } {
  const [encoded, suppliedSignature, extra] = raw.split('.');
  if (!encoded || !suppliedSignature || extra || raw.length > 4096) {
    return { valid: false, reason: 'malformed' };
  }

  const expected = Buffer.from(signature(encoded));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return { valid: false, reason: 'signature' };
  }

  let payload: PassTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PassTokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    payload.v !== 1 ||
    typeof payload.tenantId !== 'string' ||
    typeof payload.memberId !== 'string' ||
    !Number.isInteger(payload.window) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 8
  ) {
    return { valid: false, reason: 'malformed' };
  }

  const currentWindow = Math.floor(epochSeconds / PASS_WINDOW_SECONDS);
  if (payload.window < currentWindow - MAX_CLOCK_SKEW_WINDOWS || payload.window > currentWindow + MAX_CLOCK_SKEW_WINDOWS) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}
