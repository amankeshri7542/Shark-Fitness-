import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '@shark/contracts';
import { applyAppearance, haptic, resolveTheme, unitsFor, MOTION_STORAGE_KEY, THEME_STORAGE_KEY } from '../preferences';
import { useSession } from '../store';

function viewer(preferences: Partial<Viewer['preferences']>): Viewer {
  return {
    userId: 'usr_1',
    tenantId: 'ten_1',
    memberId: 'mem_1',
    staffId: null,
    name: 'Aman Verma',
    initials: 'AV',
    email: 'aman@example.test',
    role: 'member',
    accountState: 'active',
    homeBranchId: 'br_1',
    permittedBranchIds: ['br_1'],
    permissions: [],
    preferences: { register: 'plain', unitSystem: 'metric', theme: 'dark', haptics: true, reducedMotion: false, ...preferences },
  };
}

describe('theme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-motion');
    localStorage.clear();
  });

  it('resolves system against the operating system setting', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('writes theme and motion onto <html> and remembers them for the next first paint', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);

    applyAppearance({ theme: 'light', reducedMotion: true });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.motion).toBe('reduce');
    expect(meta.content).toBe('#eef2f4');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe('reduce');

    applyAppearance({ theme: 'dark', reducedMotion: false });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBeNull();
    meta.remove();
  });
});

describe('haptics', () => {
  const vibrate = vi.fn(() => true);
  beforeEach(() => {
    vibrate.mockClear();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true });
  });
  afterEach(() => {
    useSession.setState({ viewer: null });
    Reflect.deleteProperty(navigator, 'vibrate');
  });

  it('vibrates only when the member has haptics on', () => {
    useSession.setState({ viewer: viewer({ haptics: true }) });
    expect(haptic('set-complete')).toBe(true);
    expect(vibrate).toHaveBeenCalledTimes(1);

    useSession.setState({ viewer: viewer({ haptics: false }) });
    expect(haptic('set-complete')).toBe(false);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('does nothing where the device cannot vibrate', () => {
    Reflect.deleteProperty(navigator, 'vibrate');
    useSession.setState({ viewer: viewer({ haptics: true }) });
    expect(haptic('personal-record')).toBe(false);
  });
});

describe('units', () => {
  it('shows pounds when the member chose imperial, while storing kilograms', () => {
    const lb = unitsFor('imperial');
    expect(lb.unit).toBe('lb');
    expect(lb.format(100)).toBe('220.5 lb');
    expect(lb.text('top 60 kg × 5')).toBe('top 132.3 lb × 5');
    const stepped = lb.step(60, 1);
    expect(lb.value(stepped)).toBe(135);
    expect(stepped).toBeCloseTo(61.235, 3);
    expect(unitsFor('metric').format(100)).toBe('100 kg');
  });
});
