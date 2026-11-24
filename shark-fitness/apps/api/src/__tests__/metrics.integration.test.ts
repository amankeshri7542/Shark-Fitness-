import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { runtimeConfig } from '../lib/config.js';
import { DURATION_BUCKETS_SECONDS, recordHttpRequest, renderMetrics, resetMetricsForTest } from '../lib/metrics.js';
import { resetRateLimitsForTest } from '../middleware/index.js';

const TOKEN = 'metrics-test-token-0123456789abcdef-long-enough';
const ORIGIN = 'http://localhost:5173';
let tokenBefore: string | null;

beforeEach(() => {
  tokenBefore = runtimeConfig.metricsToken;
  resetMetricsForTest();
  resetRateLimitsForTest();
});
afterEach(() => {
  runtimeConfig.metricsToken = tokenBefore;
  resetRateLimitsForTest();
});

const scrape = (authorization?: string) =>
  app.request('/metrics', { headers: authorization ? { authorization } : {} });

/** Every `name{labels} value` sample line, parsed. */
function samples(text: string): Array<{ name: string; labels: Record<string, string>; value: number }> {
  return text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = /^([a-z_:][a-z0-9_:]*)(?:\{(.*)\})? (\S+)$/i.exec(line);
      if (!match) throw new Error(`Not a Prometheus sample: ${line}`);
      const labels: Record<string, string> = {};
      for (const pair of (match[2] ?? '').matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/gi)) labels[pair[1]!] = pair[2]!;
      return { name: match[1]!, labels, value: Number(match[3]) };
    });
}

async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
  const response = await app.request('/v1/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ tenantSlug: 'shark', email, password: 'shark1234' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  const token = (response.headers.get('set-cookie') ?? '').match(/shark_session=([^;,]+)/)?.[1];
  return { cookie: `shark_session=${token}; shark_csrf=${body.csrfToken}`, csrf: body.csrfToken };
}

describe('GET /metrics', () => {
  it('does not exist while SHARK_METRICS_TOKEN is unset', async () => {
    runtimeConfig.metricsToken = null;
    const response = await scrape(`Bearer ${TOKEN}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('answers 401 without the token or with a wrong one', async () => {
    runtimeConfig.metricsToken = TOKEN;
    for (const header of [undefined, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, 'Basic abc']) {
      const response = await scrape(header);
      expect(response.status, String(header)).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="metrics"');
    }
  });

  it('serves every listed metric family in Prometheus text format with the token', async () => {
    runtimeConfig.metricsToken = TOKEN;
    await app.request('/health');
    const response = await scrape(`Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const text = await response.text();
    for (const family of [
      'http_requests_total counter',
      'http_request_duration_seconds histogram',
      'job_runs_total counter',
      'job_last_success_timestamp_seconds gauge',
      'outbox_undelivered_events gauge',
      'sqlite_db_size_bytes gauge',
      'process_cpu_seconds_total counter',
      'process_resident_memory_bytes gauge',
    ]) {
      expect(text).toContain(`# TYPE ${family}`);
    }
    const parsed = samples(text);
    expect(parsed.find((sample) => sample.name === 'http_requests_total' && sample.labels.route === '/health')).toMatchObject({
      labels: { method: 'GET', route: '/health', status: '200' },
      value: 1,
    });
    expect(parsed.find((sample) => sample.name === 'sqlite_db_size_bytes')!.value).toBeGreaterThan(0);
    expect(parsed.find((sample) => sample.name === 'outbox_undelivered_events')!.value).toBeGreaterThanOrEqual(0);
    expect(parsed.find((sample) => sample.name === 'process_resident_memory_bytes')!.value).toBeGreaterThan(0);
  });

  it('labels HTTP metrics with route templates, never ids from the path', async () => {
    runtimeConfig.metricsToken = TOKEN;
    const owner = await signIn('owner@sharkfitness.in');
    const list = await app.request('/v1/admin/members?limit=2', { headers: { cookie: owner.cookie } });
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: Array<{ id: string }> };
    expect(items.length).toBeGreaterThan(0);
    const memberId = items[0]!.id;
    expect(memberId).toMatch(/^mbr_/);
    expect((await app.request(`/v1/admin/members/${memberId}`, { headers: { cookie: owner.cookie } })).status).toBe(200);
    expect((await app.request('/v1/admin/members/mbr_does_not_exist', { headers: { cookie: owner.cookie } })).status).toBe(404);
    await app.request('/v1/no/such/route/usr_abc/br_kor');

    const text = await (await scrape(`Bearer ${TOKEN}`)).text();
    const httpSamples = samples(text).filter((sample) => sample.name.startsWith('http_'));
    expect(httpSamples.length).toBeGreaterThan(0);
    for (const sample of httpSamples) {
      for (const value of Object.values(sample.labels)) {
        expect(value, `${sample.name} ${JSON.stringify(sample.labels)}`).not.toMatch(/(ten|usr|mem|mbr|br)_[A-Za-z0-9]/);
      }
    }
    const routes = new Set(httpSamples.map((sample) => sample.labels.route));
    expect(routes).toContain('/v1/admin/members/:memberId');
  });
});

describe('metrics rendering', () => {
  it('fills cumulative histogram buckets and escapes label values', () => {
    resetMetricsForTest();
    recordHttpRequest('get', '/v1/x', 200, 0.02);
    recordHttpRequest('GET', '/v1/x', 500, 3);
    recordHttpRequest('BREW', 'not-a-template', 418, 0.001);
    const text = renderMetrics({
      jobLastSuccess: [{ job: 'run-dunning', timestampSeconds: 1_700_000_000 }],
      outboxUndelivered: 4,
      sqliteDbSizeBytes: 8192,
      dataFilesystem: { sizeBytes: 100, availableBytes: 20 },
      release: 'rel"1\n',
    });

    expect(text).toContain('http_requests_total{method="GET",route="/v1/x",status="500"} 1');
    expect(text).toContain('http_requests_total{method="OTHER",route="unmatched",status="418"} 1');
    const index = DURATION_BUCKETS_SECONDS.indexOf(0.025);
    expect(text).toContain(`http_request_duration_seconds_bucket{method="GET",route="/v1/x",le="${DURATION_BUCKETS_SECONDS[index]}"} 1`);
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/v1/x",le="5"} 2');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/v1/x",le="+Inf"} 2');
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/v1/x"} 2');
    expect(text).toContain('job_last_success_timestamp_seconds{job="run-dunning"} 1700000000');
    expect(text).toContain('outbox_undelivered_events 4');
    expect(text).toContain('data_filesystem_avail_bytes 20');
    expect(text).toContain('release="rel\\"1\\n"');
  });
});
