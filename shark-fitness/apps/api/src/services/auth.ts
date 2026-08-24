import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Role, Viewer } from '@shark/contracts';
import { TENANT_STATUSES, containImpersonatedPermissions, permissionsFor, type TenantStatus } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { runtimeConfig } from '../lib/config.js';
import { hashPassword, hashToken, verifyPassword } from '../lib/crypto.js';
import { id, initialsOf, normalizeEmail, normalizePhone, otpCode, token } from '../lib/ids.js';
import { DAY, MINUTE, now } from '../lib/time.js';
import { AppError, invalid, rateLimited, unauthenticated } from '../lib/errors.js';
import type { RequestContext } from '../lib/context.js';

const OTP_TTL = 10 * MINUTE;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL = 30 * DAY;

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

export function startOtp(args: { identifier: string; tenantSlug?: string; ip: string }) {
  const identifier = args.identifier.trim();
  const emailN = normalizeEmail(identifier);
  const phoneN = normalizePhone(identifier);
  const tenant = tenantFor(args.tenantSlug);

  // Creating a challenge is not delivery. Until an email/SMS adapter actually
  // submits the code, production must fail truthfully and leave no unusable
  // challenge behind. Local development can opt into an explicit echo mode;
  // that mode says exactly what happened and never calls the code "sent".
  if (!runtimeConfig.echoOtp) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'No sign-in code provider is configured. Use password sign-in or ask your gym to enable email or SMS sign-in.',
    );
  }

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

  if (!user) {
    console.log(`[auth] OTP requested for unknown identifier ${maskIdentifier(identifier)}`);
  } else {
    console.log(`[auth] development OTP for ${user.name} <${identifier}>: ${code}`);
  }

  return {
    delivery: 'development_echo' as const,
    challengeId,
    destination: maskIdentifier(identifier),
    expiresInSec: Math.floor(OTP_TTL / 1000),
    devCode: code,
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

  const emailN = normalizeEmail(challenge.identifier);
  const phoneN = normalizePhone(challenge.identifier);
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

  return createSession(user.id, user.tenantId, args.ip, args.userAgent);
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

  return createSession(user.id, user.tenantId, args.ip, args.userAgent);
}

export function createSession(
  userId: string,
  tenantId: string,
  ip: string,
  userAgent: string,
  impersonatorId?: string,
) {
  const account = db
    .select({ accountState: schema.users.accountState, deletedAt: schema.users.deletedAt })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), eq(schema.users.tenantId, tenantId)))
    .get();
  assertAuthenticatableAccount(account);
  assertOperationalTenant(tenantId);

  const raw = token();
  const sessionId = id('ses');
  db.insert(schema.sessions)
    .values({
      id: sessionId,
      userId,
      tenantId,
      tokenHash: hashToken(raw),
      ip,
      userAgent,
      createdAt: now(),
      lastSeenAt: now(),
      expiresAt: now() + SESSION_TTL,
      revokedAt: null,
      impersonatorId: impersonatorId ?? null,
      impersonationExpiresAt: impersonatorId ? now() + 60 * MINUTE : null,
    })
    .run();
  return { sessionId, token: raw, viewer: viewerFor(userId) };
}

export function revokeSession(sessionId: string): void {
  db.update(schema.sessions).set({ revokedAt: now() }).where(eq(schema.sessions.id, sessionId)).run();
}

export function resolveSession(rawToken: string): RequestContext | null {
  const session = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, hashToken(rawToken)))
    .get();

  if (!session || session.revokedAt || session.expiresAt < now()) return null;
  if (session.impersonationExpiresAt && session.impersonationExpiresAt < now()) return null;

  const user = db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, session.userId), eq(schema.users.tenantId, session.tenantId)))
    .get();
  if (!user || !isAuthenticatableAccount(user)) return null;
  if (!isOperationalTenant(tenantAccess(session.tenantId))) return null;

  if (now() - session.lastSeenAt > MINUTE) {
    db.update(schema.sessions).set({ lastSeenAt: now() }).where(eq(schema.sessions.id, session.id)).run();
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

  return {
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
    // No branch is selected until a client selects one. Seeding this with the
    // caller's first permitted branch is what made the console's "All
    // branches" cover exactly one of them; see `RequestContext.activeBranchId`.
    activeBranchId: null,
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
  };
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

export function listSessions(userId: string, currentSessionId: string) {
  return db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
    .all()
    .map((s) => ({
      id: s.id,
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      userAgent: s.userAgent,
      ip: s.ip,
      current: s.id === currentSessionId,
    }));
}
