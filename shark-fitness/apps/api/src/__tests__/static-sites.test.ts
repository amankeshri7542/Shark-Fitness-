import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountStaticSites } from '../lib/static-sites.js';

/**
 * Single-origin serving with three small fake builds: the website at /, the
 * member app at /app/, the console at /admin/ (P03 acceptance 1).
 */
let root: string;
let app: Hono;

function write(path: string, body: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shark-static-'));
  const site = join(root, 'website');
  write(join(site, 'index.html'), '<!doctype html><title>Website home</title>');
  write(join(site, 'index.html.gz'), gzipSync('<!doctype html><title>Website home</title>'));
  write(join(site, 'plans/index.html'), '<!doctype html><title>Plans</title>');
  write(join(site, '404.html'), '<!doctype html><title>Not found</title><meta name="robots" content="noindex">');
  write(join(site, '_astro/site.A1b2.css'), 'body{}');
  write(join(site, '_astro/anton.C3d4.woff2'), 'font');
  write(join(site, 'sw.js'), 'self.registration.unregister()');
  write(join(site, 'robots.txt'), 'User-agent: *');
  write(join(site, 'sitemap.xml'), '<urlset/>');
  const member = join(root, 'member');
  write(join(member, 'index.html'), '<!doctype html><title>Member app</title>');
  write(join(member, 'assets/index-M1.js'), 'console.log(1)');
  write(join(member, 'sw.js'), '// workbox');
  write(join(member, 'manifest.webmanifest'), '{}');
  const admin = join(root, 'admin');
  write(join(admin, 'index.html'), '<!doctype html><title>Console</title>');
  write(join(admin, 'assets/index-A1.js'), 'console.log(2)');

  app = new Hono();
  app.get('/v1/ping', (c) => c.json({ ok: true }));
  mountStaticSites(app, { websiteDist: site, memberDist: member, adminDist: admin, release: 'test' });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Reads each body at once: the static server streams files lazily, and an
 *  unread stream would still be opening its file after afterAll deletes it. */
async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await app.request(path, { headers });
  const body = await response.arrayBuffer();
  return new Response(response.status === 204 || response.status === 302 ? null : body, response);
}

describe('single-origin static serving', () => {
  it('serves the website at /, its pages as directories, and revalidates HTML', async () => {
    const home = await get('/');
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toMatch(/text\/html/);
    expect(home.headers.get('cache-control')).toMatch(/no-cache/);
    expect(await home.text()).toContain('Website home');
    expect(await (await get('/plans')).text()).toContain('Plans');
    expect(await (await get('/plans/')).text()).toContain('Plans');
  });

  it('serves a precompressed copy when the browser accepts it', async () => {
    const home = await get('/', { 'accept-encoding': 'gzip, deflate, br' });
    expect(home.headers.get('content-encoding')).toBe('gzip');
    expect(home.headers.get('content-type')).toMatch(/text\/html/);
    expect(home.headers.get('vary')).toMatch(/Accept-Encoding/);
  });

  it('caches hashed assets forever with the right content type', async () => {
    for (const [path, type] of [
      ['/_astro/site.A1b2.css', 'text/css'],
      ['/_astro/anton.C3d4.woff2', 'font/woff2'],
      ['/app/assets/index-M1.js', 'javascript'],
      ['/admin/assets/index-A1.js', 'javascript'],
    ] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain(type);
      expect(response.headers.get('cache-control'), path).toBe('public, max-age=31536000, immutable');
    }
  });

  it('answers a missing hashed asset with 404, never HTML', async () => {
    for (const path of ['/_astro/gone.js', '/app/assets/gone.js', '/admin/assets/gone.js', '/app/workbox-old.js']) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type') ?? '', path).not.toMatch(/text\/html/);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('serves the member app under /app/ with an SPA fallback and no-store shell', async () => {
    const shell = await get('/app/');
    expect(await shell.text()).toContain('Member app');
    expect(shell.headers.get('cache-control')).toMatch(/no-store/);
    expect(await (await get('/app/book')).text()).toContain('Member app');
    const worker = await get('/app/sw.js');
    expect(worker.headers.get('content-type')).toMatch(/javascript/);
    expect(worker.headers.get('cache-control')).toMatch(/no-store/);
    const bare = await get('/app?source=pwa');
    expect(bare.status).toBe(302);
    expect(bare.headers.get('location')).toBe('/app/?source=pwa');
  });

  it('serves the console under /admin/', async () => {
    expect(await (await get('/admin/')).text()).toContain('Console');
    expect(await (await get('/admin/members')).text()).toContain('Console');
    expect((await get('/admin')).headers.get('location')).toBe('/admin/');
  });

  it('forwards the member app’s old deep links to /app/, keeping the query', async () => {
    for (const [from, to] of [
      ['/sign-in', '/app/sign-in'],
      ['/book?day=2026-11-26', '/app/book?day=2026-11-26'],
      ['/workout/summary/wk_1', '/app/workout/summary/wk_1'],
    ]) {
      const response = await get(from!);
      expect(response.status, from).toBe(302);
      expect(response.headers.get('location'), from).toBe(to);
    }
  });

  it('serves the website’s self-unregistering worker at /sw.js, revalidated', async () => {
    const worker = await get('/sw.js');
    expect(await worker.text()).toContain('unregister');
    expect(worker.headers.get('cache-control')).toMatch(/no-cache/);
  });

  it('answers unknown website paths with the 404 page and status', async () => {
    const response = await get('/no-such-page');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('noindex');
  });

  it('leaves the API alone', async () => {
    const ping = await get('/v1/ping');
    expect(await ping.json()).toEqual({ ok: true });
    expect(ping.headers.get('cache-control')).toBeNull();
  });
});
