import type { APIRoute } from 'astro';
import { branches } from '../content/site';
import { canonical } from '../lib/config';

/** Every indexable page. 404 is not here, and neither are the apps under /app/ and /admin/. */
export const INDEXABLE_PATHS = [
  '/',
  '/plans',
  '/classes',
  '/coaches',
  '/locations',
  ...branches.map((b) => `/locations/${b.slug}`),
  '/about',
  '/free-trial',
  '/contact',
  '/faq',
  '/privacy',
  '/terms',
];

export const GET: APIRoute = () => {
  const urls = INDEXABLE_PATHS.map((path) => `  <url><loc>${canonical(path)}</loc></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
};
