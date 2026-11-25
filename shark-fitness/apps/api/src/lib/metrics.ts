/**
 * In-process Prometheus metrics (PRD 02 §11.4 "Latency and failure metrics by
 * route", "Queue depth"), rendered in the text exposition format at
 * GET /metrics. Hand-rolled: the API needs three counters, one histogram and a
 * few gauges, which is less code than configuring a client library.
 *
 * Label values are bounded and carry no identifiers or personal data: `route`
 * is the registered route template (`/v1/admin/members/:memberId`), never the
 * requested path; `job` is a scheduled job's fixed name.
 */

type Labels = Record<string, string>;

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

interface CounterSeries {
  labels: Labels;
  value: number;
}
interface HistogramSeries {
  labels: Labels;
  buckets: number[];
  sum: number;
  count: number;
}

const httpRequests = new Map<string, CounterSeries>();
const httpDurations = new Map<string, HistogramSeries>();
const jobRuns = new Map<string, CounterSeries>();

const keyOf = (labels: Labels) => JSON.stringify(labels);

function increment(series: Map<string, CounterSeries>, labels: Labels): void {
  const key = keyOf(labels);
  const current = series.get(key);
  if (current) current.value += 1;
  else series.set(key, { labels, value: 1 });
}

/** `route` must be a route template (Hono's `c.req.routePath`), not a path. */
export function recordHttpRequest(method: string, route: string, status: number, seconds: number): void {
  const normalizedMethod = HTTP_METHODS.has(method.toUpperCase()) ? method.toUpperCase() : 'OTHER';
  const normalizedRoute = route.startsWith('/') || route === '*' ? route.slice(0, 120) : 'unmatched';
  increment(httpRequests, { method: normalizedMethod, route: normalizedRoute, status: String(status) });

  const labels = { method: normalizedMethod, route: normalizedRoute };
  const key = keyOf(labels);
  let histogram = httpDurations.get(key);
  if (!histogram) {
    histogram = { labels, buckets: DURATION_BUCKETS_SECONDS.map(() => 0), sum: 0, count: 0 };
    httpDurations.set(key, histogram);
  }
  DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
    if (seconds <= bound) histogram.buckets[index]! += 1;
  });
  histogram.sum += seconds;
  histogram.count += 1;
}

export function recordJobRun(job: string, outcome: 'success' | 'failure'): void {
  increment(jobRuns, { job, outcome });
}

export interface ScrapeGauges {
  jobLastSuccess: Array<{ job: string; timestampSeconds: number }>;
  outboxUndelivered: number;
  sqliteDbSizeBytes: number;
  dataFilesystem: { sizeBytes: number; availableBytes: number } | null;
  release: string;
}

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const formatLabels = (labels: Labels) => {
  const entries = Object.entries(labels);
  return entries.length === 0 ? '' : `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',')}}`;
};
const formatNumber = (value: number) => (Number.isFinite(value) ? String(value) : value > 0 ? '+Inf' : '-Inf');

export function renderMetrics(gauges: ScrapeGauges): string {
  const lines: string[] = [];
  const family = (name: string, type: 'counter' | 'gauge' | 'histogram', help: string) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };
  const sample = (name: string, labels: Labels, value: number) => lines.push(`${name}${formatLabels(labels)} ${formatNumber(value)}`);

  family('http_requests_total', 'counter', 'HTTP requests by method, route template and status.');
  for (const series of httpRequests.values()) sample('http_requests_total', series.labels, series.value);

  family('http_request_duration_seconds', 'histogram', 'HTTP request duration by method and route template.');
  for (const series of httpDurations.values()) {
    DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
      sample('http_request_duration_seconds_bucket', { ...series.labels, le: String(bound) }, series.buckets[index]!);
    });
    sample('http_request_duration_seconds_bucket', { ...series.labels, le: '+Inf' }, series.count);
    sample('http_request_duration_seconds_sum', series.labels, series.sum);
    sample('http_request_duration_seconds_count', series.labels, series.count);
  }

  family('job_runs_total', 'counter', 'Scheduled job runs since this process started, by outcome.');
  for (const series of jobRuns.values()) sample('job_runs_total', series.labels, series.value);

  family('job_last_success_timestamp_seconds', 'gauge', 'Unix time of each scheduled job\'s last successful run (from job_runs).');
  for (const { job, timestampSeconds } of gauges.jobLastSuccess) {
    sample('job_last_success_timestamp_seconds', { job }, timestampSeconds);
  }

  family('outbox_undelivered_events', 'gauge', 'Outbox events not yet marked delivered.');
  sample('outbox_undelivered_events', {}, gauges.outboxUndelivered);

  family('sqlite_db_size_bytes', 'gauge', 'SQLite database size (page_count x page_size).');
  sample('sqlite_db_size_bytes', {}, gauges.sqliteDbSizeBytes);

  if (gauges.dataFilesystem) {
    family('data_filesystem_size_bytes', 'gauge', 'Size of the filesystem holding the database.');
    sample('data_filesystem_size_bytes', {}, gauges.dataFilesystem.sizeBytes);
    family('data_filesystem_avail_bytes', 'gauge', 'Bytes available to the app on the filesystem holding the database.');
    sample('data_filesystem_avail_bytes', {}, gauges.dataFilesystem.availableBytes);
  }

  const usage = process.cpuUsage();
  const memory = process.memoryUsage();
  family('process_cpu_user_seconds_total', 'counter', 'User CPU time spent by the process.');
  sample('process_cpu_user_seconds_total', {}, usage.user / 1e6);
  family('process_cpu_system_seconds_total', 'counter', 'System CPU time spent by the process.');
  sample('process_cpu_system_seconds_total', {}, usage.system / 1e6);
  family('process_cpu_seconds_total', 'counter', 'Total user and system CPU time spent by the process.');
  sample('process_cpu_seconds_total', {}, (usage.user + usage.system) / 1e6);
  family('process_resident_memory_bytes', 'gauge', 'Resident set size.');
  sample('process_resident_memory_bytes', {}, memory.rss);
  family('nodejs_heap_size_used_bytes', 'gauge', 'V8 heap in use.');
  sample('nodejs_heap_size_used_bytes', {}, memory.heapUsed);
  family('nodejs_heap_size_total_bytes', 'gauge', 'V8 heap allocated.');
  sample('nodejs_heap_size_total_bytes', {}, memory.heapTotal);
  family('process_start_time_seconds', 'gauge', 'Unix time the process started.');
  sample('process_start_time_seconds', {}, Math.round(Date.now() / 1_000 - process.uptime()));

  family('app_build_info', 'gauge', 'Always 1; the release label identifies the deployed build.');
  sample('app_build_info', { release: gauges.release.slice(0, 80), node_version: process.version }, 1);

  return `${lines.join('\n')}\n`;
}

/** Tests start from empty counters. */
export function resetMetricsForTest(): void {
  httpRequests.clear();
  httpDurations.clear();
  jobRuns.clear();
}
