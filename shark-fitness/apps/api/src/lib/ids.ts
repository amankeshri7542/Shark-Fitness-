import { randomBytes, randomUUID } from 'node:crypto';

/** Prefixed, sortable-ish ids. The prefix makes a stray id in a log obvious. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function id(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(6);
  let tail = '';
  for (const byte of rand) tail += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${time}${tail}`;
}

export const uuid = (): string => randomUUID();

export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Six digits, uniformly distributed. Leading zeros preserved. */
export function otpCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

export function referralCode(name: string): string {
  const stem = name.replace(/[^a-z]/gi, '').slice(0, 5).toUpperCase() || 'SHARK';
  const digits = (randomBytes(2).readUInt16BE(0) % 9000) + 1000;
  return `${stem}-${digits}`;
}

/** Phone reduced to its last ten digits for duplicate detection. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits || null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.trim().toLowerCase() || null;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts.at(-1)![0]!).toUpperCase();
}
