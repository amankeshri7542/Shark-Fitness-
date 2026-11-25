// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { INDEXABLE_PATHS } from './pages/sitemap.xml';

/**
 * Checks the built site (run `astro build` first; `pnpm build` does). Every
 * page: unique title and description, a canonical URL, Open Graph tags and
 * JSON-LD that parses. Plus the sitemap, robots and the JavaScript budgets
 * (P03 acceptance 4 and 5).
 */
const dist = resolve(import.meta.dirname, '../dist');
const built = existsSync(join(dist, 'index.html'));

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

function routeOf(file: string): string {
  const rel = relative(dist, file).replace(/\\/g, '/');
  if (rel === 'index.html') return '/';
  if (rel === '404.html') return '/404';
  return `/${rel.replace(/\/index\.html$/, '')}`;
}

const pages = built
  ? htmlFiles(dist).map((file) => ({ route: routeOf(file), doc: new DOMParser().parseFromString(readFileSync(file, 'utf8'), 'text/html') }))
  : [];

/** The origin the build was made for (SITE_URL at build time), read back from the home page. */
const SITE_URL = built
  ? new URL(pages.find((p) => p.route === '/')!.doc.querySelector('link[rel="canonical"]')!.getAttribute('href')!).origin
  : '';

/** Bytes of JavaScript a page loads, gzip: external module scripts plus their static imports, and inline scripts. */
function pageJsGzip(doc: Document): number {
  const seen = new Set<string>();
  let total = 0;
  const add = (src: string) => {
    const file = join(dist, src.replace(/^\//, ''));
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    total += gzipSync(code).length;
    for (const match of code.matchAll(/from\s*["'](\.\/[^"']+\.js)["']|import\s*["'](\.\/[^"']+\.js)["']/g)) {
      add(`/_astro/${(match[1] ?? match[2])!.slice(2)}`);
    }
  };
  for (const script of doc.querySelectorAll('script')) {
    const type = script.getAttribute('type');
    if (type === 'application/ld+json') continue;
    if (script.src) add(new URL(script.getAttribute('src')!, 'http://x').pathname);
    else total += gzipSync(script.textContent ?? '').length;
  }
  return total;
}

/** Set by CI's post-build step and `pnpm -F @shark/website budgets`: a missing build is a failure, not a skip. */
const buildRequired = process.env.WEBSITE_BUILD_REQUIRED === 'true';

it.runIf(buildRequired)('has a build to check', () => {
  expect(built, `no website build at ${dist}; run pnpm -F @shark/website build first`).toBe(true);
});

describe.skipIf(!built)('built website', () => {
  it('builds every page', () => {
    expect(pages.map((p) => p.route).sort()).toEqual([...INDEXABLE_PATHS, '/404'].sort());
  });

  it('gives every page a unique title and description, a canonical URL and Open Graph tags', () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const { route, doc } of pages) {
      const title = doc.title;
      const description = doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
      expect(title, route).toBeTruthy();
      expect(description.length, route).toBeGreaterThan(50);
      expect(description.length, route).toBeLessThanOrEqual(170);
      expect(titles.has(title), `duplicate title ${title}`).toBe(false);
      expect(descriptions.has(description), `duplicate description on ${route}`).toBe(false);
      titles.add(title);
      descriptions.add(description);
      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
      expect(canonical, route).toBe(`${SITE_URL}${route === '/' ? '/' : route}`);
      for (const property of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type']) {
        expect(doc.querySelector(`meta[property="${property}"]`)?.getAttribute('content'), `${route} ${property}`).toBeTruthy();
      }
      expect(doc.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary_large_image');
      expect(doc.documentElement.lang).toBe('en-IN');
      expect(doc.querySelectorAll('h1'), route).toHaveLength(1);
    }
  });

  it('ships JSON-LD that parses, with the types each page needs', () => {
    const types = (route: string) =>
      [...pages.find((p) => p.route === route)!.doc.querySelectorAll('script[type="application/ld+json"]')].map(
        (s) => (JSON.parse(s.textContent ?? '') as { '@type': string })['@type'],
      );
    for (const { doc } of pages) {
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        const data = JSON.parse(script.textContent ?? '') as Record<string, unknown>;
        expect(data['@context']).toBe('https://schema.org');
      }
    }
    expect(types('/')).toEqual(expect.arrayContaining(['Organization', 'ExerciseGym']));
    expect(types('/plans')).toEqual(expect.arrayContaining(['OfferCatalog', 'BreadcrumbList']));
    expect(types('/faq')).toContain('FAQPage');
    const gym = JSON.parse(pages.find((p) => p.route === '/locations/koramangala')!.doc.querySelector('script[type="application/ld+json"]')!.textContent!);
    expect(gym).toMatchObject({
      '@type': 'ExerciseGym',
      address: { addressLocality: 'Bengaluru', postalCode: '560095', addressCountry: 'IN' },
      geo: { '@type': 'GeoCoordinates' },
    });
    expect(gym.openingHoursSpecification.length).toBeGreaterThan(0);
    expect(gym.telephone).toMatch(/^\+91/);
  });

  it('keeps the 404 out of search results and lists every indexable page in the sitemap', () => {
    const notFound = pages.find((p) => p.route === '/404')!.doc;
    expect(notFound.querySelector('meta[name="robots"]')?.getAttribute('content')).toMatch(/noindex/);
    const sitemap = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
    for (const path of INDEXABLE_PATHS) expect(sitemap).toContain(`<loc>${SITE_URL}${path === '/' ? '/' : path}</loc>`);
    expect(sitemap).not.toMatch(/<loc>[^<]*\/404<\/loc>/);
  });

  it('honours SITE_INDEXABLE consistently in robots.txt and every robots meta', () => {
    const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
    const indexable = robots.includes('Allow: /');
    if (indexable) {
      expect(robots).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    } else {
      expect(robots).toBe('User-agent: *\nDisallow: /\n');
    }
    for (const { route, doc } of pages) {
      const meta = doc.querySelector('meta[name="robots"]')!.getAttribute('content');
      expect(meta, route).toBe(indexable && route !== '/404' ? 'index, follow' : 'noindex, nofollow');
    }
  });

  it('stays within the JavaScript budgets: 20 KB gzip on content pages, 35 KB on the forms', () => {
    for (const { route, doc } of pages) {
      const budget = route === '/free-trial' || route === '/contact' ? 35 * 1024 : 20 * 1024;
      expect(pageJsGzip(doc), route).toBeLessThanOrEqual(budget);
    }
  });

  it('ships the 1200×630 Open Graph image every page points at', () => {
    const png = readFileSync(join(dist, 'og.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it('loads nothing from another origin', () => {
    for (const { route, doc } of pages) {
      for (const el of doc.querySelectorAll('script[src], link[href][rel~="stylesheet"], link[rel="preload"], img[src]')) {
        const url = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
        expect(url.startsWith('/') || url.startsWith(SITE_URL), `${route}: ${url}`).toBe(true);
      }
    }
  });
});
