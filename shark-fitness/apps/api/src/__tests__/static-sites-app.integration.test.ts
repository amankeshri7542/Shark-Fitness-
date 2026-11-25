import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { app } from '../app.js';
import { mountStaticSites } from '../lib/static-sites.js';

/**
 * The static sites behind the real middleware stack. CORS once ran on every
 * path and, on a precompressed page, replaced `Vary: Accept-Encoding` and lost
 * the Content-Type, so browsers rendered the website's HTML as plain text.
 */
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shark-static-app-'));
  for (const dir of ['website', 'member', 'admin']) mkdirSync(join(root, dir), { recursive: true });
  const html = '<!doctype html><title>Website home</title>' + ' '.repeat(600);
  writeFileSync(join(root, 'website/index.html'), html);
  writeFileSync(join(root, 'website/index.html.br'), brotliCompressSync(html));
  writeFileSync(join(root, 'member/index.html'), '<!doctype html><title>Member</title>');
  writeFileSync(join(root, 'admin/index.html'), '<!doctype html><title>Console</title>');
  mountStaticSites(app, { websiteDist: join(root, 'website'), memberDist: join(root, 'member'), adminDist: join(root, 'admin'), release: 'test' });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('serves a precompressed page as HTML with Vary: Accept-Encoding through the full app', async () => {
  const response = await app.request('/', { headers: { 'accept-encoding': 'br', origin: 'http://localhost:5173' } });
  expect(response.status).toBe(200);
  // Read it: the file is streamed lazily and the directory goes in afterAll.
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  expect(response.headers.get('content-encoding')).toBe('br');
  expect(response.headers.get('content-type')).toMatch(/^text\/html/);
  expect(response.headers.get('vary')).toMatch(/Accept-Encoding/);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});

it('still answers API CORS preflights', async () => {
  const response = await app.request('/v1/auth/password', {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  });
  expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
});
