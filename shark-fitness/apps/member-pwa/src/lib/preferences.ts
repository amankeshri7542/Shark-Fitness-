import { useEffect } from 'react';
import type { Viewer } from '@shark/contracts';
import {
  convertKgText,
  formatWeight,
  stepWeightKg,
  toDisplayWeight,
  weightUnit,
  type UnitSystem,
  type WeightUnit,
} from '@shark/domain';
import { useSession } from './store';

/**
 * The member's saved preferences, applied (PRD 03 "Haptics … allow preference
 * control", "Reduced-motion support"; docs/DESIGN.md "Light mode").
 *
 * The server copy (viewer.preferences) is the truth. A device-local copy of
 * theme and motion lets index.html paint the right theme before React loads,
 * so there is never a flash of the wrong one.
 */

export type ThemePreference = 'system' | 'dark' | 'light';
type Appearance = Pick<Viewer['preferences'], 'theme' | 'reducedMotion'>;

export const THEME_STORAGE_KEY = 'shark.member.theme';
export const MOTION_STORAGE_KEY = 'shark.member.motion';
const THEME_COLOUR = { dark: '#04080b', light: '#eef2f4' } as const;
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function resolveTheme(preference: ThemePreference, prefersLight: boolean): 'dark' | 'light' {
  if (preference === 'system') return prefersLight ? 'light' : 'dark';
  return preference === 'light' ? 'light' : 'dark';
}

function prefersLight(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_QUERY).matches;
}

/** Writes theme and motion onto <html> and remembers them for the next boot. */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  const theme = resolveTheme(appearance.theme, prefersLight());
  root.setAttribute('data-theme', theme);
  if (appearance.reducedMotion) root.setAttribute('data-motion', 'reduce');
  else root.removeAttribute('data-motion');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOUR[theme]);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, appearance.theme);
    if (appearance.reducedMotion) localStorage.setItem(MOTION_STORAGE_KEY, 'reduce');
    else localStorage.removeItem(MOTION_STORAGE_KEY);
  } catch {
    /* Private mode: the theme still applies for this visit. */
  }
}

/** Keeps <html> in step with the signed-in member's preferences, including
 *  following the operating system live when the theme is "system". */
export function useAppearance(): void {
  const theme = useSession((s) => s.viewer?.preferences.theme);
  const reducedMotion = useSession((s) => s.viewer?.preferences.reducedMotion);

  useEffect(() => {
    if (!theme) return;
    const appearance = { theme, reducedMotion: Boolean(reducedMotion) };
    applyAppearance(appearance);
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(LIGHT_QUERY);
    const follow = (): void => applyAppearance(appearance);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [theme, reducedMotion]);
}

/** True when either the in-app switch or the operating system asks for less
 *  motion. For the few animations driven from script rather than CSS. */
export function prefersReducedMotion(): boolean {
  if (useSession.getState().viewer?.preferences.reducedMotion) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* — Haptics ————————————————————————————————————————————————— */

export type HapticEvent = 'set-complete' | 'check-in' | 'timer-done' | 'personal-record';

/** Short and distinct. A PR gets the only flourish. */
const PATTERNS: Record<HapticEvent, number | number[]> = {
  'set-complete': 18,
  'check-in': [24, 60, 24],
  'timer-done': [180, 90, 180],
  'personal-record': [30, 50, 30, 50, 90],
};

/**
 * A tap the member can feel, when they have haptics on and the device can
 * vibrate (Android browsers; iOS Safari has no vibration API). Returns whether
 * a vibration was requested.
 */
export function haptic(event: HapticEvent): boolean {
  const enabled = useSession.getState().viewer?.preferences.haptics ?? false;
  if (!enabled || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try {
    return navigator.vibrate(PATTERNS[event]);
  } catch {
    return false;
  }
}

/* — Units ———————————————————————————————————————————————————— */

export interface Units {
  system: UnitSystem;
  unit: WeightUnit;
  /** Number in the member's unit, e.g. for a Metric. */
  value: (kg: number, decimals?: number) => number;
  /** "72.5 kg" / "159.8 lb". */
  format: (kg: number, decimals?: number) => string;
  /** Server-composed text with every "N kg" converted. */
  text: (sentence: string) => string;
  /** One stepper press, returned in kg for storage. */
  step: (kg: number, direction: 1 | -1) => number;
}

export function unitsFor(system: UnitSystem): Units {
  return {
    system,
    unit: weightUnit(system),
    value: (kg, decimals = 1) => toDisplayWeight(kg, system, decimals),
    format: (kg, decimals = 1) => formatWeight(kg, system, decimals),
    text: (sentence) => convertKgText(sentence, system),
    step: (kg, direction) => stepWeightKg(kg, direction, system),
  };
}

export function useUnits(): Units {
  const system = useSession((s) => s.viewer?.preferences.unitSystem) ?? 'metric';
  return unitsFor(system);
}
