import { describe, expect, it } from 'vitest';
import {
  BRANCH_STATES,
  assertOverridable,
  branchStateConsequences,
  branchTrades,
  canTransitionBranch,
  currencyChangeConsequences,
  hoursFor,
  nextBranchStates,
  resolvePolicy,
  setupChecklist,
  timezoneChangeConsequences,
  validateHours,
} from '../settings.js';
import type { SetupFacts } from '../settings.js';

/* ============================================================================
   Settings rules — PF-TEN-001…006.

   The failures worth guarding are the ones where a configuration change
   reaches backwards into something already recorded: an invoice re-read in a
   currency nobody agreed, a member left attached to a branch no picker offers,
   a checklist that says "ready" over a gym with no plans to sell.
   ========================================================================= */

describe('branch lifecycle (PF-TEN-004)', () => {
  it('lets a draft branch open or be abandoned, and nothing else', () => {
    expect(canTransitionBranch('draft', 'active').ok).toBe(true);
    expect(canTransitionBranch('draft', 'archived').ok).toBe(true);
    expect(canTransitionBranch('draft', 'temporarily_closed').ok).toBe(false);
    expect(canTransitionBranch('draft', 'suspended').ok).toBe(false);
  });

  it('refuses a move to the state it is already in, and says so plainly', () => {
    const outcome = canTransitionBranch('active', 'active');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe('This branch is already active.');
  });

  it('reopens an archived branch closed rather than trading', () => {
    // Not a dead end — a gym that shut for a year and reopens is ordinary, and
    // making them build a second branch would split their history in two.
    expect(canTransitionBranch('archived', 'temporarily_closed').ok).toBe(true);
    expect(canTransitionBranch('archived', 'active').ok).toBe(false);
    expect(canTransitionBranch('archived', 'active').message).toMatch(/reopens as temporarily closed/);
  });

  it('stops trade in every state except active', () => {
    expect(branchTrades('active')).toBe(true);
    for (const state of ['draft', 'temporarily_closed', 'suspended', 'archived'] as const) {
      expect(branchTrades(state)).toBe(false);
    }
  });

  it('keeps every state selectable except archived', () => {
    expect(BRANCH_STATES.archived.selectable).toBe(false);
    for (const state of ['draft', 'active', 'temporarily_closed', 'suspended'] as const) {
      expect(BRANCH_STATES[state].selectable).toBe(true);
    }
  });

  it('offers no dead-end move in the picker', () => {
    for (const from of ['draft', 'active', 'temporarily_closed', 'suspended', 'archived'] as const) {
      for (const to of nextBranchStates(from)) {
        expect(canTransitionBranch(from, to).ok).toBe(true);
      }
      expect(nextBranchStates(from).length).toBeGreaterThan(0);
    }
  });
});

describe('closing a branch (PF-TEN edge cases)', () => {
  const none = { futureBookings: 0, homeMembers: 0, grantedMembers: 0, openTickets: 0 };

  it('says nothing when the branch keeps trading', () => {
    expect(branchStateConsequences('active', { ...none, futureBookings: 12 })).toEqual([]);
  });

  it('surfaces future bookings without cancelling them', () => {
    // Cancelling somebody's class has a refund attached and belongs to a
    // person, not to a state change.
    const out = branchStateConsequences('temporarily_closed', { ...none, futureBookings: 12 });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe('branch.future_bookings');
    expect(out[0]!.blocking).toBe(false);
    expect(out[0]!.count).toBe(12);
    expect(out[0]!.message).toMatch(/does not cancel them/);
  });

  it('refuses to archive a branch members still call home', () => {
    const out = branchStateConsequences('archived', { ...none, homeMembers: 40 });
    const blocking = out.filter((c) => c.blocking);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.code).toBe('branch.home_members');
  });

  it('allows archiving with cross-branch entitlements, and keeps them', () => {
    // The PRD edge case. The grant is not revoked — it simply stops opening
    // this door, which is what archiving means.
    const out = branchStateConsequences('archived', { ...none, grantedMembers: 7 });
    expect(out.some((c) => c.blocking)).toBe(false);
    const entitlement = out.find((c) => c.code === 'branch.cross_branch_entitlement')!;
    expect(entitlement.count).toBe(7);
    expect(entitlement.message).toMatch(/kept exactly as it is/);
  });

  it('does not warn about entitlements when merely closing for a season', () => {
    expect(branchStateConsequences('temporarily_closed', { ...none, grantedMembers: 7 })).toEqual([]);
  });
});

describe('timezone changes never move a stored instant', () => {
  it('says so, and is not blocking', () => {
    const out = timezoneChangeConsequences('Asia/Kolkata', 'Asia/Dubai', 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.blocking).toBe(false);
    expect(out[0]!.message).toMatch(/do not move/);
  });

  it('is silent when the zone has not changed', () => {
    expect(timezoneChangeConsequences('Asia/Kolkata', 'Asia/Kolkata', 99)).toEqual([]);
  });

  it('names the future bookings whose displayed time shifts', () => {
    const out = timezoneChangeConsequences('Asia/Kolkata', 'Europe/London', 5);
    expect(out.find((c) => c.code === 'timezone.future_bookings')?.count).toBe(5);
    expect(out.every((c) => !c.blocking)).toBe(true);
  });
});

describe('currency changes are prospective (PF-TEN edge case)', () => {
  it('never re-reads an invoice already raised', () => {
    const out = currencyChangeConsequences('INR', 'AED', 340);
    expect(out.every((c) => !c.blocking)).toBe(true);
    expect(out.find((c) => c.code === 'currency.prospective_only')!.message).toMatch(/re-priced or re-read/);
    expect(out.find((c) => c.code === 'currency.mixed_history')!.count).toBe(340);
  });

  it('warns that plan prices keep their numbers', () => {
    // ₹2,500 becoming AED 2,500 is a 22x price rise nobody chose.
    const out = currencyChangeConsequences('INR', 'AED', 0);
    expect(out.find((c) => c.code === 'currency.reprice_products')).toBeDefined();
  });

  it('is silent when the currency has not changed', () => {
    expect(currencyChangeConsequences('INR', 'INR', 900)).toEqual([]);
  });
});

describe('tenant defaults and branch overrides (PF-TEN-003)', () => {
  const tenant = { antiPassbackSeconds: 90, graceAllowsEntry: false, graceDays: 7 };

  it('inherits from the tenant when the branch holds no override', () => {
    expect(resolvePolicy('antiPassbackSeconds', tenant, {}, 0)).toEqual({ value: 90, source: 'tenant' });
    expect(resolvePolicy('antiPassbackSeconds', tenant, null, 0)).toEqual({ value: 90, source: 'tenant' });
  });

  it('prefers the branch when it holds one', () => {
    expect(resolvePolicy('antiPassbackSeconds', tenant, { antiPassbackSeconds: 30 }, 0)).toEqual({
      value: 30,
      source: 'branch',
    });
  });

  it('treats an explicit falsy override as an override, not as absence', () => {
    // The reason overrides are keyed by presence rather than by null: `false`
    // and "not set" are different answers and must not collapse.
    expect(resolvePolicy('graceAllowsEntry', { graceAllowsEntry: true }, { graceAllowsEntry: false }, true)).toEqual({
      value: false,
      source: 'branch',
    });
    expect(resolvePolicy('antiPassbackSeconds', tenant, { antiPassbackSeconds: 0 }, 90)).toEqual({
      value: 0,
      source: 'branch',
    });
  });

  it('falls back to the shipped default when neither has an opinion', () => {
    expect(resolvePolicy('holdSeconds', {}, {}, 120)).toEqual({ value: 120, source: 'default' });
  });

  it('refuses a branch override of a tenant-wide promise', () => {
    const outcome = assertOverridable(['graceDays']);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/whole gym/);
  });

  it('refuses an unknown key rather than storing it', () => {
    expect(assertOverridable(['somethingMadeUp']).ok).toBe(false);
  });

  it('accepts the keys a branch genuinely differs on', () => {
    expect(assertOverridable(['antiPassbackSeconds', 'quietHoursFrom', 'allowNegativeStock']).ok).toBe(true);
  });
});

describe('opening hours (PF-TEN-002)', () => {
  it('accepts an ordinary week', () => {
    expect(validateHours({ mon: { open: 360, close: 1380, closed: false } }).ok).toBe(true);
  });

  it('accepts a closed day without checking its times', () => {
    expect(validateHours({ sun: { open: 0, close: 0, closed: true } }).ok).toBe(true);
  });

  it('refuses a day that closes before it opens, and explains the overnight case', () => {
    const outcome = validateHours({ fri: { open: 1320, close: 60, closed: false } });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/past midnight/);
  });

  it('refuses a time outside the day and a day that is not a day', () => {
    expect(validateHours({ mon: { open: -1, close: 600, closed: false } }).ok).toBe(false);
    expect(validateHours({ funday: { open: 0, close: 60, closed: false } } as never).ok).toBe(false);
  });

  it('falls back to the branch typical day when a day is not set', () => {
    const fallback = { open: 300, close: 1380 };
    expect(hoursFor({}, 'wed', fallback)).toEqual({ value: { open: 300, close: 1380, closed: false }, source: 'default' });
    expect(hoursFor({ wed: { open: 480, close: 1200, closed: false } }, 'wed', fallback).source).toBe('branch');
  });
});

describe('the guided setup checklist is counted, never stored (PF-TEN-006)', () => {
  const bare: SetupFacts = {
    branches: 0, activeBranches: 0, branchesWithHours: 0, rooms: 0,
    staff: 1, products: 0, hasTaxProfile: false, hasDataProcessing: false, members: 0,
  };

  it('reports nothing done on a fresh tenant', () => {
    const { done, total, items } = setupChecklist(bare);
    expect(done).toBe(0);
    expect(total).toBe(items.length);
  });

  it('never says a gym is ready while it has nothing to sell', () => {
    const almost: SetupFacts = {
      ...bare, branches: 1, activeBranches: 1, branchesWithHours: 1, rooms: 2,
      staff: 4, hasTaxProfile: true, hasDataProcessing: true,
    };
    const { items } = setupChecklist(almost);
    const products = items.find((i) => i.key === 'products')!;
    expect(products.done).toBe(false);
    expect(products.blocking).toBe(true);
  });

  it('does not tick hours until every branch has them', () => {
    const { items } = setupChecklist({ ...bare, branches: 3, branchesWithHours: 2 });
    expect(items.find((i) => i.key === 'hours')!.done).toBe(false);
    expect(setupChecklist({ ...bare, branches: 3, branchesWithHours: 3 }).items.find((i) => i.key === 'hours')!.done).toBe(true);
  });

  it('gives every item somewhere to go and a reason that is not the label', () => {
    for (const item of setupChecklist(bare).items) {
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.why.length).toBeGreaterThan(20);
      expect(item.why).not.toBe(item.label);
    }
  });
});
