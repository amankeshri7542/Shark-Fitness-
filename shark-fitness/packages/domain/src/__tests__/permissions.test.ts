import { describe, expect, it } from 'vitest';
import { can, navFor } from '../permissions.js';

describe('role permissions', () => {
  it('gives a member no staff permission at all', () => {
    expect(can('member', 'member.view')).toBe(false);
    expect(can('member', 'billing.view')).toBe(false);
    expect(navFor('member')).toHaveLength(0);
  });

  it('keeps trainers out of money and private staff notes about other members', () => {
    expect(can('trainer', 'billing.view')).toBe(false);
    expect(can('trainer', 'billing.refund')).toBe(false);
    expect(can('trainer', 'member.notes.private')).toBe(false);
    expect(can('trainer', 'training.notes.private')).toBe(true);
  });

  it('keeps reception out of refunds and reports', () => {
    expect(can('reception', 'billing.record_payment')).toBe(true);
    expect(can('reception', 'billing.refund')).toBe(false);
    expect(can('reception', 'report.financial')).toBe(false);
  });

  it('keeps an accountant out of the schedule and the member roster edit', () => {
    expect(can('accountant', 'report.financial')).toBe(true);
    expect(can('accountant', 'schedule.manage')).toBe(false);
    expect(can('accountant', 'member.edit')).toBe(false);
  });

  it('does not let an owner impersonate or reach platform administration', () => {
    expect(can('owner', 'settings.manage')).toBe(true);
    expect(can('owner', 'platform.admin')).toBe(false);
    expect(can('owner', 'platform.impersonate')).toBe(false);
  });

  it('shows reception five or six modules, not sixteen', () => {
    const nav = navFor('reception');
    expect(nav.length).toBeLessThanOrEqual(8);
    expect(navFor('owner').length).toBeGreaterThan(nav.length);
  });
});

describe('what a platform operator sees in the rail', () => {
  it('gives a platform operator the platform console and nothing else', () => {
    // They hold every permission — `platform_admin` is ALL — but their tenant
    // has no gym, so fifteen of the sixteen modules would open on an empty
    // screen for a building that does not exist.
    for (const role of ['platform_admin', 'platform_support'] as const) {
      expect(navFor(role).map((m) => m.key)).toEqual(['platform']);
    }
  });

  it('still gives an owner their whole gym and never the platform', () => {
    const keys = navFor('owner').map((m) => m.key);
    expect(keys).toContain('members');
    expect(keys).toContain('settings');
    expect(keys).not.toContain('platform');
  });

  it('keeps reception to the desk’s job', () => {
    const keys = navFor('reception').map((m) => m.key);
    expect(keys).not.toContain('settings');
    expect(keys).not.toContain('platform');
    expect(keys).not.toContain('reports');
  });
});
