import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, test } from '@playwright/test';
import { ADMIN_ROUTES, MEMBER_ROUTES, WEBSITE_ROUTES, type AuditRoute } from './routes';
import { writeData, writeRaw } from './lib/out';
import { readIds, resolvePath, storageStateFor } from './lib/session';

/**
 * Lighthouse (performance, accessibility, best practices, SEO) for every
 * website page, the member app's Home, Book and Workout, and the console's
 * sign-in and Command Center. Signed-in pages get the saved session cookie as
 * an extra header. Lighthouse is run with `pnpm dlx` at a pinned version (the
 * one P03 measured with) rather than added to the lockfile: it is a large
 * tool used by this audit only. Without network access to fetch it the
 * results are recorded as skipped, with the reason, and the audit continues.
 */

const LIGHTHOUSE = 'lighthouse@13.6.0';

const TARGETS: Array<{ route: AuditRoute; preset: 'mobile' | 'desktop' }> = [
  ...WEBSITE_ROUTES.filter((r) => r.slug !== 'not-found').map((route) => ({ route, preset: 'mobile' as const })),
  ...MEMBER_ROUTES.filter((r) => ['home', 'book', 'workout'].includes(r.slug)).map((route) => ({ route, preset: 'mobile' as const })),
  ...ADMIN_ROUTES.filter((r) => ['sign-in', 'command-center'].includes(r.slug)).map((route) => ({ route, preset: 'desktop' as const })),
];

export interface LighthouseResult {
  app: string;
  slug: string;
  url: string;
  preset: string;
  scores?: Record<string, number | null>;
  metrics?: Record<string, number | null>;
  failedAudits?: Array<{ id: string; title: string; score: number | null }>;
  skipped?: string;
}

function run(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn('pnpm', ['dlx', LIGHTHOUSE, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output: output.slice(-2_000) });
    });
  });
}

test('Lighthouse: website pages, member Home/Book/Workout, console sign-in and Command Center', async () => {
  const baseURL = process.env.SHARK_E2E_BASE_URL!;
  const ids = readIds();
  const results: LighthouseResult[] = [];
  const env = { ...process.env, CHROME_PATH: chromium.executablePath() };
  for (const { route, preset } of TARGETS) {
    const url = `${baseURL}${resolvePath(route, ids)}`;
    const result: LighthouseResult = { app: route.app, slug: route.slug, url: resolvePath(route, ids), preset };
    const headers: Record<string, string> = { 'x-forwarded-for': '10.99.0.1' };
    const state = storageStateFor(route);
    if (state) {
      const { cookies } = JSON.parse(readFileSync(state, 'utf8')) as { cookies: Array<{ name: string; value: string }> };
      headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
    const headerFile = join(tmpdir(), `sf-audit-lh-headers-${process.pid}.json`);
    writeFileSync(headerFile, JSON.stringify(headers));
    const outFile = join(tmpdir(), `sf-audit-lh-${process.pid}.json`);
    const args = [
      url,
      '--quiet',
      '--output=json',
      `--output-path=${outFile}`,
      `--extra-headers=${headerFile}`,
      '--only-categories=performance,accessibility,best-practices,seo',
      '--chrome-flags=--headless=new --no-sandbox',
      ...(preset === 'desktop' ? ['--preset=desktop'] : []),
    ];
    const { code, output } = await run(args, env, 180_000);
    if (code !== 0) {
      result.skipped = `lighthouse exited ${code}: ${output.split('\n').filter(Boolean).slice(-3).join(' | ')}`;
      results.push(result);
      // No network to fetch the tool: every later run would fail the same way.
      if (/ENOTFOUND|EAI_AGAIN|ERR_PNPM_FETCH|network/i.test(output)) {
        for (const rest of TARGETS.slice(TARGETS.findIndex((t) => t.route === route) + 1)) {
          results.push({ app: rest.route.app, slug: rest.route.slug, url: rest.route.path, preset: rest.preset, skipped: 'lighthouse could not be fetched (no network)' });
        }
        break;
      }
      continue;
    }
    const report = JSON.parse(readFileSync(outFile, 'utf8')) as {
      categories: Record<string, { score: number | null }>;
      audits: Record<string, { id: string; title: string; score: number | null; numericValue?: number; scoreDisplayMode: string }>;
    };
    writeRaw(`lighthouse/${route.app}-${route.slug}.report.json`, report);
    result.scores = Object.fromEntries(Object.entries(report.categories).map(([k, v]) => [k, v.score === null ? null : Math.round(v.score * 100)]));
    const metric = (id: string) => report.audits[id]?.numericValue ?? null;
    result.metrics = {
      fcpMs: metric('first-contentful-paint'),
      lcpMs: metric('largest-contentful-paint'),
      tbtMs: metric('total-blocking-time'),
      cls: metric('cumulative-layout-shift'),
      speedIndexMs: metric('speed-index'),
    };
    result.failedAudits = Object.values(report.audits)
      .filter((a) => a.scoreDisplayMode === 'binary' && a.score === 0)
      .map((a) => ({ id: a.id, title: a.title, score: a.score }));
    results.push(result);
  }
  writeData('lighthouse', results);
});
