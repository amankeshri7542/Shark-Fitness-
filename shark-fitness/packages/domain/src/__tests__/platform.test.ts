import { describe, expect, it } from 'vitest';
import {
  IMPERSONATION_FORBIDDEN,
  TENANT_STATUSES,
  archiveBlockers,
  canImpersonate,
  canTransitionTenant,
  containImpersonatedPermissions,
  impersonationRemaining,
  meterHealth,
  meterPercent,
  nextTenantStatuses,
  suspensionNotice,
} from '../platform.js';

/* ============================================================================
   Platform rules — PF-PLAT-001…006.

   These are written from the opposite direction to the rest of the domain: not
   "what may this person do" but "what must remain true even for someone who
   can do everything". Every test below is a refusal.
   ========================================================================= */

const request = (overrides: Partial<Parameters<typeof canImpersonate>[0]> = {}) => ({
  actorRole: 'platform_support',
  actorIsImpersonating: false,
  targetRole: 'owner',
  targetTenantStatus: 'active' as const,
  targetAccountState: 'active',
  reason: 'Investigating the duplicate invoice on ticket SUP-1042',
  ...overrides,
});

describe('impersonation is borrowed authority, never held (PF-PLAT-004)', () => {
  it('lets platform support enter a gym account with a stated reason', () => {
    expect(canImpersonate(request()).ok).toBe(true);
  });

  it('refuses anybody who is not platform staff', () => {
    for (const actorRole of ['owner', 'regional_manager', 'branch_manager', 'reception', 'trainer', 'accountant', 'member']) {
      expect(canImpersonate(request({ actorRole })).ok).toBe(false);
    }
  });

  it('refuses a second hop from inside a support session', () => {
    // An impersonated session's audit trail names one operator. A second hop
    // makes "who did this" a question with two answers.
    const outcome = canImpersonate(request({ actorIsImpersonating: true }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/End the current support session/);
  });

  it('refuses entry into another platform account', () => {
    // Otherwise support borrows a colleague's authority to acquire the
    // platform powers their own role withholds.
    for (const targetRole of ['platform_admin', 'platform_support']) {
      const outcome = canImpersonate(request({ targetRole }));
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/Platform accounts cannot be entered/);
    }
  });

  it('refuses an account the product has switched off', () => {
    for (const targetAccountState of ['disabled', 'invited', 'anonymized', 'deletion_requested', 'legal_hold']) {
      expect(canImpersonate(request({ targetAccountState })).ok).toBe(false);
    }
  });

  it('refuses an archived gym', () => {
    expect(canImpersonate(request({ targetTenantStatus: 'archived' })).ok).toBe(false);
  });

  it('refuses a reason nobody could act on', () => {
    for (const reason of ['', '   ', 'test', 'debug']) {
      const outcome = canImpersonate(request({ reason }));
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/Say why/);
    }
  });

  it('strips platform capability from an impersonated session whatever the target holds', () => {
    const owner = ['dashboard.view', 'member.view', 'settings.manage', 'platform.admin', 'platform.impersonate'];
    const contained = containImpersonatedPermissions(owner);
    for (const forbidden of IMPERSONATION_FORBIDDEN) expect(contained).not.toContain(forbidden);
    // Everything the target legitimately held is still there.
    expect(contained).toContain('settings.manage');
    expect(contained).toContain('member.view');
  });

  it('counts down and never goes negative', () => {
    const at = 1_000_000;
    expect(impersonationRemaining(at + 30 * 60_000, at)).toBe(30);
    expect(impersonationRemaining(at - 60_000, at)).toBe(0);
    expect(impersonationRemaining(null, at)).toBe(0);
  });
});

describe('tenant lifecycle (PF-PLAT-001)', () => {
  it('moves a trial to paying, suspended or offboarded', () => {
    expect(canTransitionTenant('trial', 'active').ok).toBe(true);
    expect(canTransitionTenant('trial', 'suspended').ok).toBe(true);
    expect(canTransitionTenant('trial', 'archived').ok).toBe(true);
  });

  it('restores an archived gym as suspended, not as trading', () => {
    expect(canTransitionTenant('archived', 'suspended').ok).toBe(true);
    expect(canTransitionTenant('archived', 'active').ok).toBe(false);
  });

  it('never puts a paying gym back on trial', () => {
    expect(canTransitionTenant('active', 'trial').ok).toBe(false);
  });

  it('offers no dead-end move', () => {
    for (const from of ['trial', 'active', 'suspended', 'archived'] as const) {
      expect(nextTenantStatuses(from).length).toBeGreaterThan(0);
      for (const to of nextTenantStatuses(from)) expect(canTransitionTenant(from, to).ok).toBe(true);
    }
  });

  it('keeps a suspended gym billable and a trial not', () => {
    // Suspension is a lever against non-payment; it does not forgive the debt.
    expect(TENANT_STATUSES.suspended.billable).toBe(true);
    expect(TENANT_STATUSES.suspended.operational).toBe(false);
    expect(TENANT_STATUSES.trial.billable).toBe(false);
    expect(TENANT_STATUSES.trial.operational).toBe(true);
  });
});

describe('a legal hold outranks offboarding (PF-PLAT-005)', () => {
  it('blocks archiving while any account is held', () => {
    const outcome = archiveBlockers({ legalHolds: 1, liveClassesNow: 0, unpaidMinor: 0 });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/lifted by whoever placed it/);
  });

  it('allows it when no hold stands, whatever is owed', () => {
    // Money is a commercial argument. A hold is not.
    expect(archiveBlockers({ legalHolds: 0, liveClassesNow: 3, unpaidMinor: 900_00 }).ok).toBe(true);
  });
});

describe('suspending a gym does not interrupt what is already happening', () => {
  it('says so when a class is running', () => {
    const notice = suspensionNotice(2, 41);
    expect(notice).toMatch(/2 classes are running/);
    expect(notice).toMatch(/41 members are inside/);
    expect(notice).toMatch(/not interrupted/);
  });

  it('says the plain thing when the building is empty', () => {
    expect(suspensionNotice(0, 0)).toMatch(/Nobody is mid-class or inside/);
  });
});

describe('meters (PF-PLAT-002)', () => {
  it('reads a zero limit as not sold rather than as exceeded', () => {
    // Otherwise every tenant without the video add-on sits permanently in the
    // red on the one screen meant to show who needs attention.
    expect(meterHealth(0, 0)).toBe('unmetered');
    expect(meterHealth(120, 0)).toBe('unmetered');
    expect(meterPercent(120, 0)).toBeNull();
  });

  it('warns before the limit rather than after it', () => {
    expect(meterHealth(799, 1000)).toBe('ok');
    expect(meterHealth(800, 1000)).toBe('approaching');
    expect(meterHealth(1000, 1000)).toBe('approaching');
    expect(meterHealth(1001, 1000)).toBe('exceeded');
  });

  it('reports a usable percentage', () => {
    expect(meterPercent(418, 2000)).toBe(21);
  });
});
