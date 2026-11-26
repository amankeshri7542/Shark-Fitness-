/**
 * Build-time switches (read when `astro build` runs; nothing here reaches the
 * browser except what pages print). See docs/WEBSITE.md for each.
 */
const env = process.env;

/** Absolute origin used for canonical URLs, Open Graph and the sitemap. */
export const SITE_URL = (env.SITE_URL || 'https://www.sharkfitness.example').replace(/\/$/, '');

/** Search engines may index the site only when this is exactly `true`. Off by default so a
 *  staging or demo deployment never competes with the real one. */
export const SITE_INDEXABLE = env.SITE_INDEXABLE === 'true';

/** The gym whose public API the live parts of the site read and write. */
export const TENANT_SLUG = env.SHARK_SITE_TENANT || 'shark';

/** Optional analytics script (for example a self-hosted Plausible). Off unless set; nothing third-party loads by default. */
export const ANALYTICS_SRC = env.SITE_ANALYTICS_SRC || '';
export const ANALYTICS_DOMAIN = env.SITE_ANALYTICS_DOMAIN || '';

/** The canonical URL for a site path: no trailing slash except the root. */
export function canonical(path: string): string {
  const clean = path === '/' ? '/' : `/${path.replace(/^\/+|\/+$/g, '')}`;
  return `${SITE_URL}${clean === '/' ? '/' : clean}`;
}
