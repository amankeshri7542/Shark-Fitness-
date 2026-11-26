import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { runtimeConfig } from '../lib/config.js';
import { renderMetrics } from '../lib/metrics.js';
import { rateLimit } from '../middleware/index.js';
import { collectScrapeGauges } from '../services/metrics.js';

/**
 * GET /metrics: Prometheus text format, for a scraper such as Grafana Agent
 * or Prometheus itself (docs/OPERATIONS-ALERTS.md).
 *
 * Off unless SHARK_METRICS_TOKEN is set, and then only with that bearer
 * token. Disabled, it answers exactly like any unknown path, so its existence
 * is not advertised.
 */
export const metricsRoutes = new Hono();

const digest = (value: string) => createHash('sha256').update(value).digest();

// A scraper calls every 15–60 s; the limiter caps token guessing (P09).
metricsRoutes.get('/', rateLimit(60, 60_000, { identity: 'ip', bucket: 'metrics' }), (c) => {
  const token = runtimeConfig.metricsToken;
  if (!token) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.', requestId: c.get('requestId') ?? 'unknown' } },
      404,
    );
  }
  const supplied = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  if (!timingSafeEqual(digest(supplied), digest(token))) {
    c.header('www-authenticate', 'Bearer realm="metrics"');
    return c.json(
      { error: { code: 'UNAUTHENTICATED', message: 'A valid metrics token is required.', requestId: c.get('requestId') ?? 'unknown' } },
      401,
    );
  }
  c.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  c.header('cache-control', 'no-store');
  return c.body(renderMetrics(collectScrapeGauges()));
});
