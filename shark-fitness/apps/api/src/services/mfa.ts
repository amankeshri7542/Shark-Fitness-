import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import type { MfaStatus, Role } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import type { RequestContext } from '../lib/context.js';
import { hashToken } from '../lib/crypto.js';
import { AppError, conflict, invalid, precondition, rateLimited } from '../lib/errors.js';
import { decryptField, encryptField } from '../lib/field-encryption.js';
import { id } from '../lib/ids.js';
import { MINUTE, now } from '../lib/time.js';

/* ============================================================================
   Two-step sign-in with TOTP (PRD 04 ENT-IAM-001, ADR-004).

   TOTP is RFC 6238 via `otpauth` — SHA-1, 6 digits, 30-second period, the
   parameters every authenticator app supports. Nothing about the algorithm is
   implemented here; this module decides *who* must use it, keeps the seed
   encrypted, accepts each code once, and locks a factor under guessing.
   ========================================================================= */

/** Roles that must use MFA whatever the gym decides (ENT-IAM-001). */
export const MFA_MANDATORY_ROLES: readonly Role[] = ['owner', 'regional_manager', 'platform_admin', 'platform_support'];

export const MFA_ISSUER = 'Shark Fitness';
const PERIOD_SEC = 30;
/** One step either side covers ordinary clock drift on a phone. */
const WINDOW = 1;
/** Consecutive wrong codes before the factor locks, and for how long. */
export const MFA_MAX_FAILURES = 5;
export const MFA_LOCK_MS = 15 * MINUTE;
export const RECOVERY_CODE_COUNT = 10;

type UserRow = typeof schema.users.$inferSelect;
type MfaRow = typeof schema.userMfa.$inferSelect;

export interface MfaRequirement {
  required: boolean;
  requiredBy: 'role' | 'gym' | 'none';
}

function tenantPolicy(tenantId: string): Record<string, unknown> {
  const tenant = db.select({ policy: schema.tenants.policy }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get();
  return (tenant?.policy ?? {}) as Record<string, unknown>;
}

/** Members are never asked for MFA. Staff are when their role or their gym says so. */
export function mfaRequirement(user: { role: string; tenantId: string }): MfaRequirement {
  if (user.role === 'member') return { required: false, requiredBy: 'none' };
  if (MFA_MANDATORY_ROLES.includes(user.role as Role)) return { required: true, requiredBy: 'role' };
  if (tenantPolicy(user.tenantId).requireMfaForStaff === true) return { required: true, requiredBy: 'gym' };
  return { required: false, requiredBy: 'none' };
}

export function mfaRow(userId: string): MfaRow | undefined {
  return db.select().from(schema.userMfa).where(eq(schema.userMfa.userId, userId)).get();
}

export function isMfaEnrolled(userId: string): boolean {
  return Boolean(mfaRow(userId)?.confirmedAt);
}

/** What a fresh sign-in owes before it becomes a full session. */
export function signInMfaState(user: { id: string; role: string; tenantId: string }): 'none' | 'challenge' | 'enrol' {
  if (user.role === 'member') return 'none';
  if (isMfaEnrolled(user.id)) return 'challenge';
  return mfaRequirement(user).required ? 'enrol' : 'none';
}

function totpFor(secretBase32: string, account: string): TOTP {
  return new TOTP({
    issuer: MFA_ISSUER,
    label: account,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SEC,
    secret: Secret.fromBase32(secretBase32),
  });
}

function secretOf(row: MfaRow): string {
  return decryptField('mfa-totp', row.userId, row.secretCiphertext);
}

export function mfaStatus(user: { id: string; role: string; tenantId: string }, sessionState: MfaStatus['sessionState']): MfaStatus {
  const row = mfaRow(user.id);
  const requirement = mfaRequirement(user);
  const remaining = row?.confirmedAt
    ? (db
        .select({ n: sql<number>`count(*)` })
        .from(schema.mfaRecoveryCodes)
        .where(and(eq(schema.mfaRecoveryCodes.userId, user.id), isNull(schema.mfaRecoveryCodes.usedAt)))
        .get()?.n ?? 0)
    : 0;
  return {
    enrolled: Boolean(row?.confirmedAt),
    required: requirement.required,
    requiredBy: requirement.requiredBy,
    enrolledAt: row?.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
    recoveryCodesRemaining: remaining,
    sessionState,
  };
}

/* — Enrolment —————————————————————————————————————————————————— */

/**
 * Starts (or restarts) enrolment with a fresh 160-bit secret. A confirmed
 * factor is never replaced this way: turning MFA off first takes a step-up.
 */
export function startEnrolment(user: UserRow): { secret: string; uri: string; issuer: string; account: string } {
  if (user.role === 'member') throw precondition('Two-step sign-in is for staff accounts.');
  const existing = mfaRow(user.id);
  if (existing?.confirmedAt) throw conflict('Two-step sign-in is already set up on this account.');

  const secret = new Secret({ size: 20 }).base32;
  const account = user.email ?? user.name;
  const at = now();
  const ciphertext = encryptField('mfa-totp', user.id, secret);
  if (existing) {
    db.update(schema.userMfa)
      .set({ secretCiphertext: ciphertext, failedAttempts: 0, lockedUntil: null, lastUsedStep: null, updatedAt: at })
      .where(eq(schema.userMfa.userId, user.id))
      .run();
  } else {
    db.insert(schema.userMfa)
      .values({ userId: user.id, tenantId: user.tenantId, secretCiphertext: ciphertext, createdAt: at, updatedAt: at })
      .run();
  }
  return { secret, uri: totpFor(secret, account).toString(), issuer: MFA_ISSUER, account };
}

/** Confirms the pending factor with a first code and issues recovery codes. */
export function confirmEnrolment(ctx: RequestContext, user: UserRow, code: string): string[] {
  const row = mfaRow(user.id);
  if (!row) throw precondition('Start setting up two-step sign-in first.');
  if (row.confirmedAt) throw conflict('Two-step sign-in is already set up on this account.');
  checkTotp(ctx, row, user, code);
  const at = now();
  const codes = issueRecoveryCodes(user.id, user.tenantId);
  db.update(schema.userMfa).set({ confirmedAt: at, updatedAt: at }).where(eq(schema.userMfa.userId, user.id)).run();
  audit(ctx, { action: 'auth.mfa_enrolled', entityType: 'user', entityId: user.id, entityLabel: user.name });
  return codes;
}

/* — Verification ———————————————————————————————————————————————— */

function assertNotLocked(row: MfaRow): void {
  if (row.lockedUntil && row.lockedUntil > now()) {
    throw new AppError(
      'RATE_LIMITED',
      'Too many wrong codes. Two-step sign-in is locked for a few minutes; try again later or use a recovery code after the lock ends.',
      { retryAfterSec: Math.ceil((row.lockedUntil - now()) / 1000) },
    );
  }
}

/** Counts a wrong code and locks the factor after a burst. Writes outside any
 *  transaction so the count survives the error that follows it. */
function recordFailure(ctx: RequestContext, row: MfaRow, user: { id: string; name: string }, kind: 'totp' | 'recovery'): never {
  const failures = row.failedAttempts + 1;
  const lock = failures >= MFA_MAX_FAILURES;
  db.update(schema.userMfa)
    .set({ failedAttempts: lock ? 0 : failures, lockedUntil: lock ? now() + MFA_LOCK_MS : row.lockedUntil, updatedAt: now() })
    .where(eq(schema.userMfa.userId, row.userId))
    .run();
  if (lock) {
    audit(ctx, {
      action: 'auth.mfa_locked',
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.name,
      reason: `${MFA_MAX_FAILURES} wrong ${kind === 'totp' ? 'authenticator' : 'recovery'} codes in a row`,
    });
    throw rateLimited(Math.ceil(MFA_LOCK_MS / 1000));
  }
  throw invalid(kind === 'totp' ? 'That code is not right. Check your authenticator app and try again.' : 'That recovery code is not right, or it has already been used.');
}

/**
 * Accepts a TOTP code for this factor exactly once. A code from a step at or
 * before the last accepted one is refused, which is what stops a shoulder-
 * surfed code being replayed inside its 90-second window.
 */
function checkTotp(ctx: RequestContext, row: MfaRow, user: { id: string; name: string; email: string | null }, code: string): void {
  assertNotLocked(row);
  const totp = totpFor(secretOf(row), user.email ?? user.name);
  const at = now();
  const delta = totp.validate({ token: code, timestamp: at, window: WINDOW });
  const step = delta === null ? null : totp.counter({ timestamp: at }) + delta;
  if (step === null || (row.lastUsedStep !== null && step <= row.lastUsedStep)) {
    recordFailure(ctx, row, user, 'totp');
  }
  db.update(schema.userMfa)
    .set({ lastUsedStep: step, failedAttempts: 0, lockedUntil: null, updatedAt: at })
    .where(eq(schema.userMfa.userId, row.userId))
    .run();
}

/** A confirmed factor's code, for the sign-in challenge and step-up. */
export function verifyTotp(ctx: RequestContext, user: UserRow, code: string): void {
  const row = mfaRow(user.id);
  if (!row?.confirmedAt) throw precondition('Two-step sign-in is not set up on this account.');
  checkTotp(ctx, row, user, code);
}

function normaliseRecoveryCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Spends one recovery code. Each works once. */
export function useRecoveryCode(ctx: RequestContext, user: UserRow, code: string): number {
  const row = mfaRow(user.id);
  if (!row?.confirmedAt) throw precondition('Two-step sign-in is not set up on this account.');
  assertNotLocked(row);
  const hash = hashToken(`recovery:${user.id}:${normaliseRecoveryCode(code)}`);
  const match = db
    .select()
    .from(schema.mfaRecoveryCodes)
    .where(and(eq(schema.mfaRecoveryCodes.userId, user.id), eq(schema.mfaRecoveryCodes.codeHash, hash), isNull(schema.mfaRecoveryCodes.usedAt)))
    .get();
  if (!match) recordFailure(ctx, row, user, 'recovery');
  db.update(schema.mfaRecoveryCodes).set({ usedAt: now() }).where(eq(schema.mfaRecoveryCodes.id, match.id)).run();
  db.update(schema.userMfa).set({ failedAttempts: 0, lockedUntil: null, updatedAt: now() }).where(eq(schema.userMfa.userId, user.id)).run();
  const remaining = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.mfaRecoveryCodes)
    .where(and(eq(schema.mfaRecoveryCodes.userId, user.id), isNull(schema.mfaRecoveryCodes.usedAt)))
    .get()?.n ?? 0;
  audit(ctx, {
    action: 'auth.mfa_recovery_code_used',
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.name,
    after: { recoveryCodesRemaining: remaining },
  });
  return remaining;
}

/* — Recovery codes ——————————————————————————————————————————————— */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function recoveryCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

function issueRecoveryCodes(userId: string, tenantId: string): string[] {
  db.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId)).run();
  const at = now();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
  for (const code of codes) {
    db.insert(schema.mfaRecoveryCodes)
      .values({ id: id('mrc'), userId, tenantId, codeHash: hashToken(`recovery:${userId}:${normaliseRecoveryCode(code)}`), usedAt: null, createdAt: at })
      .run();
  }
  return codes;
}

export function regenerateRecoveryCodes(ctx: RequestContext, user: UserRow): string[] {
  if (!isMfaEnrolled(user.id)) throw precondition('Two-step sign-in is not set up on this account.');
  const codes = issueRecoveryCodes(user.id, user.tenantId);
  audit(ctx, { action: 'auth.mfa_recovery_codes_regenerated', entityType: 'user', entityId: user.id, entityLabel: user.name });
  return codes;
}

/* — Removal ———————————————————————————————————————————————————— */

function removeFactor(userId: string): void {
  db.delete(schema.mfaRecoveryCodes).where(eq(schema.mfaRecoveryCodes.userId, userId)).run();
  db.delete(schema.userMfa).where(eq(schema.userMfa.userId, userId)).run();
}

/**
 * The person turns MFA off themselves (after a step-up). Where their role or
 * gym requires it, their own session drops back to the enrolment gate, which
 * makes "turn off, then set up again" the way to move to a new phone.
 */
export function disableMfa(ctx: RequestContext, user: UserRow): { sessionState: 'none' | 'enrol' } {
  if (!isMfaEnrolled(user.id)) throw precondition('Two-step sign-in is not set up on this account.');
  removeFactor(user.id);
  const required = mfaRequirement(user).required;
  audit(ctx, {
    action: 'auth.mfa_disabled',
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.name,
    reason: required ? 'Turned off by the account holder; set-up is required again before next use' : 'Turned off by the account holder',
  });
  const sessionState = required ? 'enrol' : 'none';
  db.update(schema.sessions).set({ mfaState: sessionState }).where(eq(schema.sessions.id, ctx.sessionId)).run();
  return { sessionState };
}

/**
 * Someone else removes a person's factor because they lost their device
 * (owner-assisted, or platform support for an owner). Every session the
 * person holds ends, so the next sign-in meets the enrolment gate.
 */
export function resetMfaFor(
  ctx: RequestContext,
  target: { id: string; tenantId: string; name: string },
  reason: string,
  by: 'owner' | 'platform_support',
): void {
  const had = mfaRow(target.id);
  removeFactor(target.id);
  db.update(schema.sessions)
    .set({ revokedAt: now() })
    .where(and(eq(schema.sessions.userId, target.id), eq(schema.sessions.tenantId, target.tenantId), isNull(schema.sessions.revokedAt)))
    .run();
  audit(
    { ...ctx, tenantId: target.tenantId, activeBranchId: ctx.tenantId === target.tenantId ? ctx.activeBranchId : null },
    {
      action: 'auth.mfa_reset',
      entityType: 'user',
      entityId: target.id,
      entityLabel: target.name,
      reason,
      before: { enrolled: Boolean(had?.confirmedAt) },
      after: { enrolled: false, resetBy: by },
    },
  );
}

/** Test and fixture support: the step the factor would accept next. Not routed. */
export function totpCodeFor(secretBase32: string, timestamp = now()): string {
  return totpFor(secretBase32, 'fixture').generate({ timestamp });
}

/** Enrols a user with a known secret. Used only by `src/db/mfa-fixture.ts`. */
export function enrolWithKnownSecret(user: { id: string; tenantId: string }, secretBase32: string): void {
  const at = now();
  removeFactor(user.id);
  db.insert(schema.userMfa)
    .values({
      userId: user.id,
      tenantId: user.tenantId,
      secretCiphertext: encryptField('mfa-totp', user.id, Secret.fromBase32(secretBase32).base32),
      confirmedAt: at,
      createdAt: at,
      updatedAt: at,
    })
    .run();
}
