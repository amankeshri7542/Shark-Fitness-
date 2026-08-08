/** Sonar tokens, JS side. Mirrors sonar.css — keep the two in step. */

export * from './tone.js';

export const color = {
  abyss: 'var(--sf-abyss)',
  hull: 'var(--sf-hull)',
  panel: 'var(--sf-panel)',
  overlay: 'var(--sf-overlay)',
  foam: 'var(--sf-foam)',
  foam50: 'var(--sf-foam-50)',
  onAccent: 'var(--sf-on-accent)',
  sonar: 'var(--sf-sonar)',
  flare: 'var(--sf-flare)',
  kelp: 'var(--sf-kelp)',
  chum: 'var(--sf-chum)',
  line: 'var(--sf-line)',
} as const;

/** Chart series, in order. Ordered so the first three stay distinguishable
 *  in greyscale and for the common forms of colour-vision deficiency. */
export const dataSeries = [
  'var(--sf-data-1)',
  'var(--sf-data-2)',
  'var(--sf-data-3)',
  'var(--sf-data-4)',
  'var(--sf-data-5)',
  'var(--sf-data-6)',
] as const;

export type StatusTone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

/** Status colour is always paired with a glyph — never hue alone (WCAG 2.2,
 *  design PRD "Never encode status by hue alone"). */
export const statusTone: Record<StatusTone, { color: string; glyph: string }> = {
  neutral: { color: 'var(--sf-foam-50)', glyph: '·' },
  good: { color: 'var(--sf-kelp)', glyph: '✓' },
  warn: { color: 'var(--sf-flare)', glyph: '!' },
  bad: { color: 'var(--sf-chum)', glyph: '×' },
  accent: { color: 'var(--sf-sonar)', glyph: '◆' },
};

export const motion = {
  micro: 140,
  base: 220,
  enter: 300,
  ease: 'cubic-bezier(.2,.8,.2,1)',
} as const;

export type ThemeName = 'dark' | 'light';

export function applyTheme(theme: ThemeName, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', theme);
}
