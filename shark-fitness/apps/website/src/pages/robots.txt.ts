import type { APIRoute } from 'astro';
import { SITE_INDEXABLE, SITE_URL } from '../lib/config';

/** Crawlers may index the site only when SITE_INDEXABLE=true (docs/WEBSITE.md). */
export const GET: APIRoute = () => {
  const body = SITE_INDEXABLE
    ? `User-agent: *\nAllow: /\nDisallow: /app/\nDisallow: /admin/\nDisallow: /v1/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
