import type { ManifestOptions } from 'vite-plugin-pwa';

/**
 * The member app's web app manifest (served at /app/manifest.webmanifest).
 *
 * Kept apart from vite.config.ts so the Android TWA manifest test can check
 * the two agree on colours, start URL and shortcuts.
 *
 * Theme colours: the manifest can only carry one pair, so it carries the dark
 * Sonar signature (docs/DESIGN.md). index.html adds `theme-color` metas per
 * `prefers-color-scheme`, and the app rewrites the meta when the member picks
 * a theme in Profile, so the browser chrome follows the chosen theme.
 */
export const THEME = {
  dark: { theme: '#04080b', background: '#04080b' },
  light: { theme: '#eef2f4', background: '#eef2f4' },
} as const;

export const MEMBER_MANIFEST: Partial<ManifestOptions> = {
  id: '/app/',
  scope: '/app/',
  start_url: '/app/?source=pwa',
  name: 'Shark Fitness',
  short_name: 'Shark',
  description: 'Your membership, training plan, classes and gym pass in one app.',
  lang: 'en-IN',
  dir: 'ltr',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  orientation: 'portrait',
  theme_color: THEME.dark.theme,
  background_color: THEME.dark.background,
  categories: ['health', 'fitness', 'lifestyle'],
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: 'icons/monochrome-96.png', sizes: '96x96', type: 'image/png', purpose: 'monochrome' },
  ],
  shortcuts: [
    {
      name: 'Pass',
      short_name: 'Pass',
      description: 'Show your entry pass at reception',
      url: '/app/pass?source=shortcut',
      icons: [{ src: 'icons/shortcut-pass-96.png', sizes: '96x96', type: 'image/png' }],
    },
    {
      name: "Today's workout",
      short_name: 'Workout',
      description: "Open today's training plan",
      url: '/app/train?source=shortcut',
      icons: [{ src: 'icons/shortcut-train-96.png', sizes: '96x96', type: 'image/png' }],
    },
    {
      name: 'Book a class',
      short_name: 'Book',
      description: 'See the timetable and book a class',
      url: '/app/book?source=shortcut',
      icons: [{ src: 'icons/shortcut-book-96.png', sizes: '96x96', type: 'image/png' }],
    },
  ],
  // Real screens from the seeded demo, captured from the production build by
  // `pnpm -F @shark/e2e store-screenshots`.
  screenshots: [
    { src: 'screenshots/home-narrow.jpg', sizes: '780x1688', type: 'image/jpeg', form_factor: 'narrow', label: 'Home: today at your gym' },
    { src: 'screenshots/train-narrow.jpg', sizes: '780x1688', type: 'image/jpeg', form_factor: 'narrow', label: "Train: today's plan" },
    { src: 'screenshots/book-narrow.jpg', sizes: '780x1688', type: 'image/jpeg', form_factor: 'narrow', label: 'Book: classes this week' },
    { src: 'screenshots/book-wide.jpg', sizes: '1280x800', type: 'image/jpeg', form_factor: 'wide', label: 'Book on a tablet' },
  ],
};
