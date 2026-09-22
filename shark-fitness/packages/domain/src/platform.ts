/* ============================================================================
   Platform administration — PF-PLAT-001…006.

   The rules here govern a role that can see every tenant, so they are written
   from the opposite direction to the rest of the domain: not "what may this
   person do" but "what must remain true even for someone who can do
   everything".

   Three of those, and they are the module.

   **Support access is borrowed, never held.** An impersonated session carries
   the *target's* authority and none of the operator's. It cannot open platform
   tooling, cannot start a second impersonation, and expires on a clock the
   session cannot extend. The alternative — trusting the impersonated role to
   be harmless — fails the moment support impersonates another operator.

   **Immutability is not a permission** (PF-PLAT-006). An append-only ledger,
   a raised invoice and a recorded consent are facts. There is no super-admin
   path around them, because the point of recording a fact is that the person
   with the most power cannot quietly change it.

   **A tenant's data outlives its subscription.** Suspending stops the product
   working; it deletes nothing, and it must not strand somebody mid-class.
   ========================================================================= */

export type TenantStatus = 'active' | 'trial' | 'suspended' | 'archived';

export interface TenantStatusRules {
  /** Members and staff can use the product. */
  operational: boolean;
  /** Counts toward billing and usage. */
  billable: boolean;
  meaning: string;
}

export const TENANT_STATUSES: Record<TenantStatus, TenantStatusRules> = {
  trial: {
    operational: true,
    billable: false,
    meaning: 'Evaluating. Full product, no invoice yet.',
  },
  active: {
    operational: true,
    billable: true,
    meaning: 'Paying and running.',
  },
  suspended: {
    operational: false,
    billable: true,
    meaning: 'Sign-in refused for everyone in this gym. Nothing is deleted and the bill continues.',
  },
  archived: {
    operational: false,
    billable: false,
    meaning: 'Offboarded. Data retained for the agreed period, readable by nobody in the gym.',
  },
};

const TENANT_TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  trial: ['active', 'suspended', 'archived'],
  active: ['suspended', 'archived'],
  suspended: ['active', 'archived'],
  // Restoring an archived tenant lands in `suspended`: their data comes back
  // before their doors do, so somebody checks the contract first.
  archived: ['suspended'],
};

export interface PlatformOutcome {
  ok: boolean;
  message: string;
}

export function canTransitionTenant(from: TenantStatus, to: TenantStatus): PlatformOutcome {
  if (from === to) return { ok: false, message: `That gym is already ${to}.` };
  if (TENANT_TRANSITIONS[from].includes(to)) return { ok: true, message: '' };
  if (from === 'archived') {
    return { ok: false, message: 'An archived gym is restored as suspended, so its contract can be checked first.' };
  }
  return { ok: false, message: `A gym cannot go from ${from} to ${to}.` };
}

export const nextTenantStatuses = (from: TenantStatus): TenantStatus[] => TENANT_TRANSITIONS[from];

/**
 * Whether a tenant may be archived, given what is still attached to it.
 *
 * A legal hold outranks a deletion request, always. It is placed by somebody
 * outside this product — a regulator, a court, counsel — and a support
 * operator clearing it by archiving the tenant is the exact failure
 * PF-PLAT-005 names. The check is blocking and cannot be acknowledged away.
 */
export function archiveBlockers(facts: {
  legalHolds: number;
  liveClassesNow: number;
  unpaidMinor: number;
}): PlatformOutcome {
  if (facts.legalHolds > 0) {
    return {
      ok: false,
      message: `${facts.legalHolds} ${facts.legalHolds === 1 ? 'account is' : 'accounts are'} under legal hold. A hold has to be lifted by whoever placed it before this gym can be offboarded.`,
    };
  }
  if (facts.liveClassesNow > 0) {
    return {
      ok: false,
      message: `${facts.liveClassesNow} ${facts.liveClassesNow === 1 ? 'class is' : 'classes are'} still running. Finish or cancel ${facts.liveClassesNow === 1 ? 'it' : 'them'} before this gym is offboarded.`,
    };
  }
  return { ok: true, message: '' };
}

/**
 * What suspending a tenant does to people who are mid-session.
 *
 * Nothing, deliberately. A class that is running keeps running and a member
 * already inside the building stays inside — a billing dispute is not a reason
 * to open the doors mid-burpee. Suspension stops the *next* thing: sign-in,
 * check-in, booking, sale.
 */
export function suspensionNotice(liveClassesNow: number, insideNow: number): string {
  if (liveClassesNow === 0 && insideNow === 0) {
    return 'Nobody is mid-class or inside. Sign-in stops immediately for everyone in this gym.';
  }
  const parts: string[] = [];
  if (liveClassesNow > 0) parts.push(`${liveClassesNow} ${liveClassesNow === 1 ? 'class is' : 'classes are'} running`);
  if (insideNow > 0) parts.push(`${insideNow} ${insideNow === 1 ? 'member is' : 'members are'} inside`);
  return `${parts.join(' and ')}. They are not interrupted — suspension stops the next sign-in, check-in, booking and sale, not the one already happening.`;
}

/* ——— Usage and quotas (PF-PLAT-002) ————————————————————— */

export type MeterHealth = 'ok' | 'approaching' | 'exceeded' | 'unmetered';

/**
 * A meter's standing against its quota.
 *
 * A limit of zero means *not sold*, not *none allowed* — a tenant without the
 * video add-on has a zero video quota and is not "100% over". Reporting that
 * as exceeded would put every tenant permanently in the red on the one screen
 * whose job is to show which ones actually need attention.
 */
export function meterHealth(used: number, limit: number): MeterHealth {
  if (limit <= 0) return 'unmetered';
  if (used > limit) return 'exceeded';
  if (used >= limit * 0.8) return 'approaching';
  return 'ok';
}

export const meterPercent = (used: number, limit: number): number | null =>
  limit <= 0 ? null : Math.round((used / limit) * 100);

/* ——— Impersonation (PF-PLAT-004) ————————————————————————— */

/** Support access is time-boxed. Sixty minutes is a shift's worth of one
 *  problem, and short enough that a forgotten tab is not a standing key. */
export const IMPERSONATION_MINUTES = 60;

export interface ImpersonationRequest {
  /** The role of the operator asking. */
  actorRole: string;
  /** True when the operator is *already* inside an impersonated session. */
  actorIsImpersonating: boolean;
  /** The role of the account they want to enter. */
  targetRole: string;
  targetTenantStatus: TenantStatus;
  targetAccountState: string;
  reason: string;
}

const PLATFORM_ROLES = ['platform_admin', 'platform_support'];

/**
 * Whether one account may be entered by another, and why not.
 *
 * The refusals are the specification.
 *
 * *Chaining* is refused because an impersonated session's audit trail names
 * one operator; a second hop makes "who did this" a question with two answers.
 *
 * *Entering another platform account* is refused because it launders authority:
 * support may borrow a gym owner's view, and may not use that mechanism to
 * acquire the platform powers their own role withholds.
 *
 * *A disabled or anonymised account* is refused because signing in as somebody
 * the product has switched off produces a session the product cannot reason
 * about, and an anonymised record has no person left to act for.
 */
export function canImpersonate(request: ImpersonationRequest): PlatformOutcome {
  if (!PLATFORM_ROLES.includes(request.actorRole)) {
    return { ok: false, message: 'Support access is for platform staff.' };
  }
  if (request.actorIsImpersonating) {
    return { ok: false, message: 'End the current support session before starting another.' };
  }
  if (PLATFORM_ROLES.includes(request.targetRole)) {
    return { ok: false, message: 'Platform accounts cannot be entered. Support access is for gym accounts.' };
  }
  if (request.targetAccountState !== 'active') {
    return { ok: false, message: `That account is ${request.targetAccountState.replace(/_/g, ' ')} and cannot be entered.` };
  }
  if (!TENANT_STATUSES[request.targetTenantStatus].operational) {
    return {
      ok: false,
      message: `That gym is ${request.targetTenantStatus}. Restore it to an operational state before entering an account.`,
    };
  }
  if (request.reason.trim().length < 8) {
    return { ok: false, message: 'Say why you need access. It is recorded and the gym can read it.' };
  }
  return { ok: true, message: '' };
}

/**
 * Permissions an impersonated session may never carry, whatever the target
 * holds.
 *
 * Belt as well as braces: the transport refuses platform routes to any
 * impersonated session, and this strips the capability from the session itself
 * so a future route that forgets the guard still cannot be reached.
 */
export const IMPERSONATION_FORBIDDEN = ['platform.admin', 'platform.impersonate'] as const;

export function containImpersonatedPermissions<T extends string>(permissions: T[]): T[] {
  return permissions.filter((p) => !(IMPERSONATION_FORBIDDEN as readonly string[]).includes(p));
}

/** Minutes left of a support session, floored at zero. */
export const impersonationRemaining = (expiresAt: number | null, atMs: number): number =>
  expiresAt === null ? 0 : Math.max(0, Math.ceil((expiresAt - atMs) / 60_000));
