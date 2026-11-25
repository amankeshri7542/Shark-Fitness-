import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { STAFF_IDLE_TIMEOUT_MINUTES, type MfaState, type Role, type SessionEndReason, type SessionTiming, type Viewer } from '@shark/contracts';
import { TENANT_STATUSES, containImpersonatedPermissions, permissionsFor, type TenantStatus } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { id, initialsOf, normalizeEmail, normalizePhone, otpCode, token } from '../lib/ids.js';
import { DAY, HOUR, MINUTE, now } from '../lib/time.js';
import { AppError, invalid, rateLimited, unauthenticated } from '../lib/errors.js';
import type { RequestContext } from '../lib/context.js';
import { takeDestinationSend, takeIpSend } from '../lib/otp-limits.js';
import { deliveryFailed, otpSenders, toE164, type OtpChannel } from './otp-delivery.js';
import { signInMfaState } from './mfa.js';

const OTP_TTL = 10 * MINUTE;
const OTP_MAX_ATTEMPTS = 5;

/* — Session policy (PRD 02 "Identity rules", PRD 04 §10.1) ——————————————

   Members: 30 days, sliding — every use pushes the end out again, so a phone
   that opens the app weekly never signs its owner out.

   Staff: 12 hours from sign-in, absolute, plus an idle timeout the gym sets
   (15–240 minutes, default 30). Idle means no *person* at the keyboard: only
   writes and the console's activity heartbeat move `lastActiveAt`, so a
   dashboard left polling on a desk still times out.

   Partial sessions (password accepted, MFA still owed) last 15 minutes. */
export const MEMBER_SESSION_TTL = 30 * DAY;
export const STAFF_SESSION_TTL = 12 * HOUR;
export const PARTIAL_SESSION_TTL = 15 * MINUTE;
/** How often activity is written back. Idle precision is this, not a minute. */
const ACTIVITY_WRITE_INTERVAL = 15_000;

function maskIdentifier(value: string): string {
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, local.length - 1))}@${domain}`;
  }
  return `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

/**
 * The gym somebody is signing in to.
 *
 * Two corrections to what this used to do, both found by seeding a second
 * tenant — with one tenant in the database neither could be observed.
 *
 * **A trial is a working product.** This matched only `status = 'active'`, so
 * every customer on trial was locked out of the product they were evaluating.
 * The status rules in `@shark/domain` already say which states are
 * operational; this reads them rather than keeping a second opinion.
 *
 * **A suspended gym is told it is suspended.** "That gym could not be found"
 * sends a member who typed their own gym's name correctly off to check their
 * spelling. They are a legitimate user of a real gym that has been switched
 * off, and the useful answer says so. The slug is already public — it is what
 * they typed — so naming the state leaks nothing they could not infer.
 */
function tenantFor(slug?: string) {
  if (slug) {
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug)).get();
    if (!tenant) throw invalid('That gym could not be found.');
    if (!TENANT_STATUSES[tenant.status as TenantStatus]?.operational) {
      throw invalid(
        tenant.status === 'suspended'
          ? 'This gym is suspended. Its administrator can tell you more.'
          : 'This gym is no longer active.',
      );
    }
    return tenant;
  }

  // Only customers, and only operational ones: the platform's own tenant is
  // not a gym anybody signs in to by omission.
  const tenants = db
    .select()
    .from(schema.tenants)
    .where(and(eq(schema.tenants.kind, 'customer'), inArray(schema.tenants.status, OPERATIONAL_TENANT_STATUSES)))
    .limit(2)
    .all();
  if (tenants.length !== 1) throw invalid('Choose your gym before signing in.');
  return tenants[0]!;
}

export const OPERATIONAL_TENANT_STATUSES = (Object.keys(TENANT_STATUSES) as TenantStatus[]).filter(
  (status) => TENANT_STATUSES[status].operational,
);

type AccountAccess = { accountState: string; deletedAt: number | null };
type TenantAccess = { status: string };

function isAuthenticatableAccount(account: AccountAccess): boolean {
  return account.deletedAt === null && account.accountState === 'active';
}

function assertAuthenticatableAccount(account: AccountAccess | undefined): void {
  if (!account || account.deletedAt !== null) throw unauthenticated();
  if (account.accountState === 'disabled') {
    throw new AppError('FORBIDDEN', 'This account has been disabled. Contact your gym.');
  }
  if (account.accountState === 'legal_hold') {
    throw new AppError('LEGAL_HOLD', 'This account is locked pending a legal review.');
  }
  if (!isAuthenticatableAccount(account)) throw unauthenticated();
}

function isOperationalTenant(tenant: TenantAccess | undefined): boolean {
  return Boolean(
    tenant &&
      tenant.status in TENANT_STATUSES &&
      TENANT_STATUSES[tenant.status as TenantStatus].operational,
  );
}

function tenantAccess(tenantId: string): TenantAccess | undefined {
  return db
    .select({ status: schema.tenants.status })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .get();
}

function assertOperationalTenant(tenantId: string): void {
  if (!isOperationalTenant(tenantAccess(tenantId))) {
    throw new AppError('FORBIDDEN', 'This gym is not accepting sign-ins right now.');
  }
}

export async function startOtp(args: { identifier: string; tenantSlug?: string; ip: string }) {
  takeIpSend(args.ip);
  const identifier = args.identifier.trim();
  const emailN = normalizeEmail(identifier);
  const phoneN = normalizePhone(identifier);
  const tenant = tenantFor(args.tenantSlug);
  const channel: OtpChannel = identifier.includes('@') ? 'email' : 'sms';
  const sender = otpSenders()[channel];

  // Creating a challenge is not delivery. The log sender submits nothing, so
  // with it on this channel production refuses truthfully and leaves no
  // unusable challenge behind. Local development can opt into an explicit echo
  // mode; that mode says exactly what happened and never calls the code "sent".
  const echo = runtimeConfig.echoOtp;
  if (sender.name === 'log' && !echo) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'No sign-in code provider is configured. Use password sign-in or ask your gym to enable email or SMS sign-in.',
    );
  }

  const recent = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.otpChallenges)
    .where(
      and(
        eq(schema.otpChallenges.tenantId, tenant.id),
        eq(schema.otpChallenges.identifier, identifier),
        gt(schema.otpChallenges.createdAt, now() - 5 * MINUTE),
      ),
    )
    .get();
  if ((recent?.n ?? 0) >= 4) throw rateLimited(300);

  const user = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.tenantId, tenant.id),
        isNull(schema.users.deletedAt),
        or(
          emailN ? eq(schema.users.email, emailN) : sql`0`,
          phoneN ? sql`replace(replace(replace(${schema.users.phone}, ' ', ''), '-', ''), '+', '') like ${'%' + phoneN}` : sql`0`,
        ),
      ),
    )
    .get();

  // Codes go to the address on file, never to whatever the caller typed.
  const destination = !user
    ? null
    : channel === 'email'
      ? user.email
      : user.phone
        ? toE164(user.phone)
        : null;
  if (destination && !echo) takeDestinationSend(destination);

  const code = otpCode();
  const challengeId = id('otp');
  db.insert(schema.otpChallenges)
    .values({
      id: challengeId,
      tenantId: tenant.id,
      identifier,
      codeHash: hashToken(`${challengeId}:${code}`),
      attempts: 0,
      createdAt: now(),
      expiresAt: now() + OTP_TTL,
      consumedAt: null,
    })
    .run();

  if (echo) {
    return {
      delivery: 'development_echo' as const,
      challengeId,
      destination: maskIdentifier(identifier),
      expiresInSec: Math.floor(OTP_TTL / 1000),
      devCode: code,
    };
  }

  // An unknown identifier or one with no usable address gets the same answer
  // as a real one, so the response never confirms who is a member.
  if (!user) {
    console.log(`[auth] OTP requested for unknown identifier ${maskIdentifier(identifier)}`);
  } else if (!destination) {
    console.warn(`[auth] OTP requested for ${user.id} but no usable ${channel} is on file`);
  } else {
    try {
      await sender.send({
        channel,
        to: destination,
        code,
        gymName: tenant.displayName,
        expiresInMin: Math.floor(OTP_TTL / MINUTE),
      });
    } catch (error) {
      db.update(schema.otpChallenges).set({ consumedAt: now() }).where(eq(schema.otpChallenges.id, challengeId)).run();
      throw error instanceof AppError ? error : deliveryFailed();
    }
  }

  return {
    delivery: 'submitted' as const,
    challengeId,
    destination: maskIdentifier(identifier),
    expiresInSec: Math.floor(OTP_TTL / 1000),
  };
}

export function verifyOtp(args: { challengeId: string; code: string; ip: string; userAgent: string }) {
  const challenge = db
    .select()
    .from(schema.otpChallenges)
    .where(eq(schema.otpChallenges.id, args.challengeId))
    .get();

  if (!challenge) throw invalid('That code has expired. Ask for a new one.');
  if (challenge.consumedAt) throw invalid('That code has already been used.');
  if (challenge.expiresAt < now()) throw invalid('That code has expired. Ask for a new one.');
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) throw rateLimited(600);

  db.update(schema.otpChallenges)
    .set({ attempts: challenge.attempts + 1 })
    .where(eq(schema.otpChallenges.id, challenge.id))
    .run();

  if (hashToken(`${challenge.id}:${args.code}`) !== challenge.codeHash) {
    throw invalid('That code is not right. Check it and try again.');
  }

  // An identifier has one meaning. Treating an email as a phone as well lets
  // its incidental digits match the suffix of another user's phone number.
  const emailN = challenge.identifier.includes('@') ? normalizeEmail(challenge.identifier) : null;
  const phoneN = emailN ? null : normalizePhone(challenge.identifier);
  const user = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.tenantId, challenge.tenantId),
        isNull(schema.users.deletedAt),
        or(
          emailN ? eq(schema.users.email, emailN) : sql`0`,
          phoneN ? sql`replace(replace(replace(${schema.users.phone}, ' ', ''), '-', ''), '+', '') like ${'%' + phoneN}` : sql`0`,
        ),
      ),
    )
    .get();

  if (!user) throw invalid('That code is not right. Check it and try again.');

  // The challenge may have been issued just before a platform suspension.
  // Re-check at verification so it cannot mint a fresh long-lived session.
  assertOperationalTenant(user.tenantId);

  db.update(schema.otpChallenges)
    .set({ consumedAt: now() })
    .where(eq(schema.otpChallenges.id, challenge.id))
    .run();

  // A verified invitation proves ownership of the invited address. Promote it
  // before the shared session boundary checks that only active accounts may
  // receive a session.
  if (user.accountState === 'invited') {
    db.update(schema.users)
      .set({ accountState: 'active', updatedAt: now() })
      .where(and(eq(schema.users.id, user.id), eq(schema.users.accountState, 'invited')))
      .run();
  }

  return signInSession(user, args.ip, args.userAgent);
}

export function signInWithPassword(args: {
  tenantSlug: string;
  email: string;
  password: string;
  ip: string;
  userAgent: string;
}) {
  const tenant = tenantFor(args.tenantSlug);
  const emailN = normalizeEmail(args.email)!;
  const user = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.tenantId, tenant.id),
        eq(schema.users.email, emailN),
        isNull(schema.users.deletedAt),
      ),
    )
    .get();

  const stored = user?.passwordHash ?? hashPassword('decoy-value-for-timing');
  const ok = verifyPassword(args.password, stored);

  if (!user || !ok || !user.passwordHash) {
    throw new AppError('UNAUTHENTICATED', 'That email and password do not match.');
  }

  return signInSession(user, args.ip, args.userAgent);
}

/**
 * A session for someone who has just proved their first factor. Staff who
 * hold an authenticator get a `challenge` session, staff who must enrol get
 * an `enrol` session; neither reaches anything but the MFA routes until the
 * second step is done (`completeMfa`).
 */
export function signInSession(
  user: { id: string; tenantId: string; role: string },
  ip: string,
  userAgent: string,
) {
  return createSession(user.id, user.tenantId, ip, userAgent, undefined, signInMfaState(user));
}

export function createSession(
  userId: string,
  tenantId: string,
  ip: string,
  userAgent: string,
  impersonatorId?: string,
  mfaState: MfaState = impersonatorId ? 'verified' : 'none',
) {
  const account = db
    .select({ accountState: schema.users.accountState, deletedAt: schema.users.deletedAt, role: schema.users.role })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), eq(schema.users.tenantId, tenantId)))
    .get();
  assertAuthenticatableAccount(account);
  assertOperationalTenant(tenantId);

  const raw = token();
  const sessionId = id('ses');
  const at = now();
  const partial = mfaState === 'challenge' || mfaState === 'enrol';
  db.insert(schema.sessions)
    .values({
      id: sessionId,
      userId,
      tenantId,
      tokenHash: hashToken(raw),
      ip,
      userAgent,
      createdAt: at,
      lastSeenAt: at,
      lastActiveAt: at,
      expiresAt: at + (partial ? PARTIAL_SESSION_TTL : account!.role === 'member' ? MEMBER_SESSION_TTL : STAFF_SESSION_TTL),
      revokedAt: null,
      impersonatorId: impersonatorId ?? null,
      impersonationExpiresAt: impersonatorId ? at + 60 * MINUTE : null,
      mfaState,
      // The first factor was just proved. A partial session cannot use this
      // until it is complete, and completing it refreshes the time anyway.
      reauthenticatedAt: at,
    })
    .run();
  return { sessionId, token: raw, viewer: viewerFor(userId), mfaState };
}

/**
 * Turns a partial session into a full one after the second step. The token
 * is replaced, so a cookie captured before MFA was completed is worthless.
 */
export function completeMfa(sessionId: string): string {
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session) throw unauthenticated();
  const raw = token();
  const at = now();
  db.update(schema.sessions)
    .set({
      tokenHash: hashToken(raw),
      mfaState: 'verified',
      reauthenticatedAt: at,
      lastActiveAt: at,
      lastSeenAt: at,
      // Twelve hours from the password sign-in, not from this step: setting
      // up two-step sign-in later from Your account must not extend a session.
      expiresAt: session.createdAt + STAFF_SESSION_TTL,
    })
    .where(eq(schema.sessions.id, sessionId))
    .run();
  return raw;
}

/** Records a successful password (+ TOTP) re-check for step-up. */
export function markReauthenticated(sessionId: string): void {
  const at = now();
  db.update(schema.sessions).set({ reauthenticatedAt: at, lastActiveAt: at }).where(eq(schema.sessions.id, sessionId)).run();
}

/** The gym's staff idle timeout, clamped to the allowed range. */
export function staffIdleTimeoutMs(tenantId: string): number {
  const policy = (db.select({ policy: schema.tenants.policy }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).get()?.policy ?? {}) as Record<string, unknown>;
  const minutes = Number(policy.staffIdleTimeoutMinutes);
  const valid = Number.isInteger(minutes) && minutes >= STAFF_IDLE_TIMEOUT_MINUTES.min && minutes <= STAFF_IDLE_TIMEOUT_MINUTES.max;
  return (valid ? minutes : STAFF_IDLE_TIMEOUT_MINUTES.default) * MINUTE;
}

type SessionRow = typeof schema.sessions.$inferSelect;

/**
 * When a staff session ends at the latest. Checked against `createdAt` as
 * well as `expiresAt`, so staff sessions created before the 12-hour limit
 * existed (they carry the old 30-day `expiresAt`) end on it too.
 */
function staffSessionEnd(session: SessionRow): number {
  return Math.min(session.expiresAt, session.createdAt + STAFF_SESSION_TTL);
}

/** Why this session no longer works, or null while it does. */
function endedReason(session: SessionRow, role: string | undefined, at: number): SessionEndReason | null {
  if (session.revokedAt) return 'revoked';
  if (session.expiresAt < at) return 'expired';
  if (session.impersonationExpiresAt && session.impersonationExpiresAt < at) return 'expired';
  const partial = session.mfaState === 'challenge' || session.mfaState === 'enrol';
  if (role && role !== 'member' && !partial) {
    if (staffSessionEnd(session) < at) return 'expired';
    const lastActive = session.lastActiveAt ?? session.lastSeenAt;
    if (lastActive + staffIdleTimeoutMs(session.tenantId) < at) return 'idle';
  }
  return null;
}

export function sessionTiming(sessionId: string): SessionTiming | null {
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session) return null;
  const user = db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, session.userId)).get();
  const staff = user?.role !== 'member';
  const lastActive = session.lastActiveAt ?? session.lastSeenAt;
  const idleMs = staff ? staffIdleTimeoutMs(session.tenantId) : null;
  const ends = Math.min(staff ? staffSessionEnd(session) : session.expiresAt, session.impersonationExpiresAt ?? Number.POSITIVE_INFINITY);
  return {
    kind: staff ? 'staff' : 'member',
    idleTimeoutSec: idleMs === null ? null : Math.round(idleMs / 1000),
    idleExpiresAt: idleMs === null ? null : new Date(Math.min(lastActive + idleMs, ends)).toISOString(),
    expiresAt: new Date(ends).toISOString(),
    lastActiveAt: new Date(lastActive).toISOString(),
  };
}

/** A person did something. Background reads never call this. */
export function markActivity(sessionId: string, lastActiveAt: number | null | undefined): void {
  const at = now();
  if (lastActiveAt && at - lastActiveAt < ACTIVITY_WRITE_INTERVAL) return;
  db.update(schema.sessions).set({ lastActiveAt: at }).where(eq(schema.sessions.id, sessionId)).run();
}

export function revokeSession(sessionId: string): void {
  db.update(schema.sessions).set({ revokedAt: now() }).where(eq(schema.sessions.id, sessionId)).run();
}

/** Invalidate every outstanding sign-in handoff for the account's current identity.
 * Call before changing contact identifiers, inside the caller's write transaction. */
export function revokeAccountChallenges(user: { id: string; tenantId: string; email: string | null; phone: string | null }): void {
  const at = now();
  const email = normalizeEmail(user.email);
  const phone = normalizePhone(user.phone);
  const challenges = db.select().from(schema.otpChallenges).where(and(eq(schema.otpChallenges.tenantId, user.tenantId), isNull(schema.otpChallenges.consumedAt))).all();
  for (const challenge of challenges) {
    const identifier = challenge.identifier;
    const phoneAlias = !identifier.includes('@') ? normalizePhone(identifier) : null;
    const matches = identifier.startsWith('activation:')
      ? identifier === `activation:${user.id}`
      : identifier.includes('@')
        ? email !== null && normalizeEmail(identifier) === email
        // Password recovery must also invalidate short suffixes accepted by verifyOtp.
        : phone !== null && phoneAlias !== null && phone.endsWith(phoneAlias);
    if (matches) db.update(schema.otpChallenges).set({ consumedAt: at }).where(eq(schema.otpChallenges.id, challenge.id)).run();
  }
  db.update(schema.accountRecoveries).set({ consumedAt: at }).where(and(eq(schema.accountRecoveries.tenantId, user.tenantId), eq(schema.accountRecoveries.userId, user.id), isNull(schema.accountRecoveries.consumedAt))).run();
}

export type SessionResolution =
  /** `renewedUntil`: a member session just slid forward; the cookie should follow. */
  | { status: 'active'; ctx: RequestContext; renewedUntil?: number }
  /** Password proved, MFA still owed. Only the MFA routes accept it. */
  | { status: 'partial'; ctx: RequestContext }
  | { status: 'ended'; reason: SessionEndReason }
  | { status: 'unknown' };

/** A *full* session's context, or null. Partial sessions resolve to null here. */
export function resolveSession(rawToken: string): RequestContext | null {
  const resolution = resolveSessionToken(rawToken);
  return resolution.status === 'active' ? resolution.ctx : null;
}

export function resolveSessionToken(rawToken: string): SessionResolution {
  const session = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, hashToken(rawToken)))
    .get();
  return session ? resolveSessionRow(session) : { status: 'unknown' };
}

/** A full session's context by id, or null (realtime and tickets use this). */
export function resolveSessionById(sessionId: string): RequestContext | null {
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session) return null;
  const resolution = resolveSessionRow(session);
  return resolution.status === 'active' ? resolution.ctx : null;
}

function resolveSessionRow(session: SessionRow): SessionResolution {
  const at = now();
  const user = db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, session.userId), eq(schema.users.tenantId, session.tenantId)))
    .get();
  const ended = endedReason(session, user?.role, at);
  if (ended) return { status: 'ended', reason: ended };
  if (!user || !isAuthenticatableAccount(user)) return { status: 'unknown' };
  if (!isOperationalTenant(tenantAccess(session.tenantId))) return { status: 'unknown' };

  let renewedUntil: number | undefined;
  if (at - session.lastSeenAt > MINUTE) {
    if (user.role === 'member') renewedUntil = at + MEMBER_SESSION_TTL;
    db.update(schema.sessions)
      .set({ lastSeenAt: at, ...(renewedUntil !== undefined ? { expiresAt: renewedUntil } : {}) })
      .where(eq(schema.sessions.id, session.id))
      .run();
  }

  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.userId, user.id), eq(schema.members.tenantId, user.tenantId)))
    .get();
  const staffRow = db
    .select()
    .from(schema.staff)
    .where(and(eq(schema.staff.userId, user.id), eq(schema.staff.tenantId, user.tenantId)))
    .get();

  const branchIds = member
    ? [
        member.homeBranchId,
        ...db
          .select({ b: schema.memberBranches.branchId })
          .from(schema.memberBranches)
          .where(eq(schema.memberBranches.memberId, member.id))
          .all()
          .map((r) => r.b),
      ]
    : staffRow
      ? staffRow.branchIds
      : db
          .select({ id: schema.branches.id })
          .from(schema.branches)
          .where(eq(schema.branches.tenantId, user.tenantId))
          .all()
          .map((r) => r.id);

  const ctx: RequestContext = {
    requestId: id('req'),
    sessionId: session.id,
    authMethod: 'cookie',
    tenantId: user.tenantId,
    userId: user.id,
    memberId: member?.id ?? null,
    staffId: staffRow?.id ?? null,
    role: user.role as Role,
    name: user.name,
    branchIds: [...new Set(branchIds)],
    // Staff who can see several branches start on "All branches" (null), which
    // is what every admin read treats as its full scope. Defaulting to the
    // first branch made the console's "All branches" silently show one branch
    // until a client sent `x-branch-id`; see `RequestContext.activeBranchId`.
    activeBranchId: member
      ? member.homeBranchId
      : new Set(branchIds).size === 1
        ? (branchIds[0] ?? null)
        : null,
    // Support access is borrowed authority (PF-PLAT-004). An impersonated
    // session carries the target's permissions and never the operator's, so
    // platform capability is stripped from the session itself — not only
    // refused at the door. The transport guard in `platformOnly` says no
    // first; this makes a route that forgets the guard unreachable anyway.
    permissions: session.impersonatorId
      ? containImpersonatedPermissions(permissionsFor(user.role as Role))
      : permissionsFor(user.role as Role),
    ip: session.ip,
    userAgent: session.userAgent,
    impersonatorId: session.impersonatorId,
    mfaState: session.mfaState as MfaState,
    reauthenticatedAt: session.reauthenticatedAt,
    lastActiveAt: session.lastActiveAt ?? session.lastSeenAt,
  };
  const partial = session.mfaState === 'challenge' || session.mfaState === 'enrol';
  if (partial) return { status: 'partial', ctx };
  return renewedUntil !== undefined ? { status: 'active', ctx, renewedUntil } : { status: 'active', ctx };
}

export function viewerFor(userId: string): Viewer {
  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) throw unauthenticated();

  const member = db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.userId, user.id), eq(schema.members.tenantId, user.tenantId)))
    .get();
  const staffRow = db
    .select()
    .from(schema.staff)
    .where(and(eq(schema.staff.userId, user.id), eq(schema.staff.tenantId, user.tenantId)))
    .get();
  const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, user.tenantId)).get();

  const extra = member
    ? db
        .select({ b: schema.memberBranches.branchId })
        .from(schema.memberBranches)
        .where(eq(schema.memberBranches.memberId, member.id))
        .all()
        .map((r) => r.b)
    : [];

  const branchIds = member
    ? [...new Set([member.homeBranchId, ...extra])]
    : staffRow
      ? staffRow.branchIds
      : db
          .select({ id: schema.branches.id })
          .from(schema.branches)
          .where(eq(schema.branches.tenantId, user.tenantId))
          .all()
          .map((r) => r.id);

  const prefs = (user.preferences ?? {}) as Record<string, unknown>;
  return {
    userId: user.id,
    tenantId: user.tenantId,
    memberId: member?.id ?? null,
    staffId: staffRow?.id ?? null,
    name: user.name,
    initials: user.initials || initialsOf(user.name),
    email: user.email,
    role: user.role as Role,
    accountState: user.accountState as Viewer['accountState'],
    homeBranchId: member?.homeBranchId ?? branchIds[0] ?? null,
    permittedBranchIds: branchIds,
    permissions: permissionsFor(user.role as Role),
    preferences: {
      register: (prefs.register as 'predator' | 'plain') ?? 'predator',
      unitSystem: (prefs.unitSystem as 'metric' | 'imperial') ?? (tenant?.unitSystem as 'metric') ?? 'metric',
      theme: (prefs.theme as 'dark' | 'light' | 'system') ?? 'dark',
      haptics: (prefs.haptics as boolean) ?? true,
      reducedMotion: (prefs.reducedMotion as boolean) ?? false,
    },
  };
}

/** "Chrome on Windows". A label for people, never an input to a decision. */
export function deviceLabel(userAgent: string): string {
  const ua = userAgent || '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}

/** Live, complete sessions only: an ended or half-finished sign-in is not a device. */
export function listSessions(userId: string, currentSessionId: string) {
  const at = now();
  const role = db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId)).get()?.role;
  return db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
    .all()
    .filter((s) => endedReason(s, role, at) === null && s.mfaState !== 'challenge' && s.mfaState !== 'enrol')
    .sort((a, b) => (b.lastActiveAt ?? b.lastSeenAt) - (a.lastActiveAt ?? a.lastSeenAt))
    .map((s) => ({
      id: s.id,
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      lastActiveAt: new Date(s.lastActiveAt ?? s.lastSeenAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString(),
      userAgent: s.userAgent,
      device: deviceLabel(s.userAgent),
      ip: s.ip,
      current: s.id === currentSessionId,
    }));
}

/** "Sign out everywhere else": every other live session this person holds. */
export function revokeOtherSessions(userId: string, tenantId: string, keepSessionId: string): number {
  const result = db
    .update(schema.sessions)
    .set({ revokedAt: now() })
    .where(and(eq(schema.sessions.userId, userId), eq(schema.sessions.tenantId, tenantId), isNull(schema.sessions.revokedAt), sql`${schema.sessions.id} <> ${keepSessionId}`))
    .run();
  return result.changes;
}
