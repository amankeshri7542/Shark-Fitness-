import { randomUUID } from 'node:crypto';
import { runtimeConfig, type ErrorReporterName, type RuntimeConfig } from './config.js';
import { redactSensitiveText } from './redaction.js';

/**
 * Unexpected-error reporting (PRD 02 §11.4 "Error monitoring").
 *
 * Providers, chosen by SHARK_ERROR_REPORTER (lib/config.ts resolves `auto`):
 *
 *   none     drop everything (tests, and production with nothing configured)
 *   console  readable report on stderr (the development default)
 *   http     JSON POST to SHARK_ERROR_REPORTING_ENDPOINT (e.g. a private ntfy topic)
 *   sentry   Sentry envelope protocol to SHARK_ERROR_DSN, over fetch with no
 *            vendor SDK, so Sentry, GlitchTip or any compatible collector works
 *
 * What leaves the process is deliberately small: the error's type, a redacted
 * message, redacted stack frames, the release and environment, and the
 * context fields below. Never a request body, headers, cookies, member fields
 * or arbitrary metadata.
 */
export interface ErrorReportContext {
  requestId?: string;
  route?: string;
  tenantId?: string;
  branchScope?: string[];
  actorId?: string;
  job?: string;
  /** Where the error was caught: scheduler, unhandledRejection, admin, member… */
  source?: string;
}

export interface StackFrame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

export interface ErrorReporter {
  readonly name: ErrorReporterName;
  capture(error: unknown, context: ErrorReportContext): void;
  /** Waits for reports still in flight, at most `timeoutMs`. */
  flush(timeoutMs: number): Promise<void>;
}

type FetchFn = typeof fetch;
type ReporterConfig = Pick<RuntimeConfig, 'release' | 'nodeEnv' | 'errorDsn' | 'errorReportingEndpoint'>;

/** A crash loop must not turn into a flood of outbound requests. */
const MAX_REPORTS_PER_MINUTE = 60;
const SEND_TIMEOUT_MS = 5_000;
const MAX_FRAMES = 50;

const noopReporter: ErrorReporter = { name: 'none', capture: () => undefined, flush: async () => undefined };
let activeReporter: ErrorReporter = noopReporter;

export function initializeErrorReporting(config: RuntimeConfig = runtimeConfig, fetchFn: FetchFn = fetch): ErrorReporterName {
  activeReporter = createErrorReporter(config.errorReporter, config, fetchFn);
  return activeReporter.name;
}

export function captureException(error: unknown, context: ErrorReportContext): void {
  try {
    activeReporter.capture(error, context);
  } catch {
    // Reporting must never become the second failure.
  }
}

export function flushErrorReports(timeoutMs = 2_000): Promise<void> {
  return activeReporter.flush(timeoutMs);
}

export function activeErrorReporterName(): ErrorReporterName {
  return activeReporter.name;
}

/** Tests install a recording reporter; null restores the no-op reporter. */
export function setErrorReporterForTest(reporter: ErrorReporter | null): void {
  activeReporter = reporter ?? noopReporter;
}

export function createErrorReporter(name: ErrorReporterName, config: ReporterConfig, fetchFn: FetchFn = fetch): ErrorReporter {
  switch (name) {
    case 'none':
      return noopReporter;
    case 'console':
      return consoleReporter();
    case 'http':
      if (!config.errorReportingEndpoint) throw new Error('The http error reporter needs SHARK_ERROR_REPORTING_ENDPOINT.');
      return outboundReporter('http', fetchFn, (error, context) => ({
        url: config.errorReportingEndpoint!,
        init: {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            event: 'exception',
            release: config.release,
            environment: config.nodeEnv,
            exception: safeException(error),
            context: safeContext(context),
          }),
        },
      }));
    case 'sentry':
      if (!config.errorDsn) throw new Error('The sentry error reporter needs SHARK_ERROR_DSN.');
      return outboundReporter('sentry', fetchFn, (error, context) => sentryEnvelope(error, context, config));
  }
}

function consoleReporter(): ErrorReporter {
  return {
    name: 'console',
    capture(error, context) {
      const exception = safeException(error);
      const where = Object.entries(safeContext(context))
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : value}`)
        .join(' ');
      const frames = exception.frames
        .slice(-15)
        .reverse()
        .map((frame) => `    at ${frame.function ?? '<anonymous>'} (${frame.filename}:${frame.lineno ?? '?'}:${frame.colno ?? '?'})`);
      console.error([`[error-report] ${exception.name}: ${exception.message}${where ? ` (${where})` : ''}`, ...frames].join('\n'));
    },
    flush: async () => undefined,
  };
}

function outboundReporter(
  name: 'http' | 'sentry',
  fetchFn: FetchFn,
  build: (error: unknown, context: ErrorReportContext) => { url: string; init: RequestInit },
): ErrorReporter {
  const inFlight = new Set<Promise<unknown>>();
  // One budget per origin: browser reports arrive through the public
  // /v1/client-errors endpoint, so a flood of them must not use up the budget
  // that server errors, job failures and crashes need to get through.
  const budgets = {
    server: { windowStart: 0, sent: 0, dropped: 0 },
    browser: { windowStart: 0, sent: 0, dropped: 0 },
  };

  return {
    name,
    capture(error, context) {
      const origin = context.source === 'admin' || context.source === 'member' ? 'browser' : 'server';
      const budget = budgets[origin];
      const at = Date.now();
      if (at - budget.windowStart >= 60_000) {
        if (budget.dropped > 0) {
          console.error(`[error-report] ${budget.dropped} ${origin} report(s) dropped: more than ${MAX_REPORTS_PER_MINUTE} a minute.`);
        }
        budget.windowStart = at;
        budget.sent = 0;
        budget.dropped = 0;
      }
      if (budget.sent >= MAX_REPORTS_PER_MINUTE) {
        budget.dropped += 1;
        return;
      }
      budget.sent += 1;

      const { url, init } = build(error, context);
      const send = fetchFn(url, { ...init, method: 'POST', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
        .then((response) => {
          if (!response.ok) console.error(`[error-report] the ${name} collector answered ${response.status}.`);
        })
        .catch(() => console.error(`[error-report] the ${name} collector could not be reached.`))
        .finally(() => inFlight.delete(send));
      inFlight.add(send);
    },
    async flush(timeoutMs) {
      if (inFlight.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

/**
 * One event in the Sentry envelope format
 * (https://develop.sentry.dev/sdk/data-model/envelopes/): an envelope header
 * line, an item header line and the event JSON, separated by newlines.
 */
function sentryEnvelope(
  error: unknown,
  context: ErrorReportContext,
  config: ReporterConfig,
): { url: string; init: RequestInit } {
  const dsn = config.errorDsn!;
  const exception = safeException(error);
  const safe = safeContext(context);
  const eventId = randomUUID().replaceAll('-', '');
  const tags: Record<string, string> = {};
  if (safe.requestId) tags.request_id = safe.requestId;
  if (safe.route) tags.route = safe.route;
  if (safe.tenantId) tags.tenant_id = safe.tenantId;
  if (safe.actorId) tags.actor_id = safe.actorId;
  if (safe.job) tags.job = safe.job;
  if (safe.source) tags.source = safe.source;
  if (safe.branchScope?.length) tags.branch_scope = safe.branchScope.join(',').slice(0, 200);

  const event = JSON.stringify({
    event_id: eventId,
    timestamp: Date.now() / 1_000,
    platform: safe.source === 'admin' || safe.source === 'member' ? 'javascript' : 'node',
    level: 'error',
    logger: 'shark-fitness',
    release: config.release,
    environment: config.nodeEnv,
    tags,
    exception: {
      values: [
        {
          type: exception.name,
          value: exception.message,
          stacktrace: { frames: exception.frames },
          mechanism: { type: safe.source ?? 'generic', handled: safe.source !== 'uncaughtException' },
        },
      ],
    },
  });
  const body = [
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event', content_type: 'application/json', length: Buffer.byteLength(event, 'utf8') }),
    event,
  ].join('\n');

  return {
    url: dsn.envelopeUrl,
    init: {
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_client=shark-fitness/1.0, sentry_key=${dsn.publicKey}`,
      },
      body,
    },
  };
}

function safeContext(context: ErrorReportContext): ErrorReportContext {
  const clip = (value: string, max = 128) => redactSensitiveText(value, max);
  return {
    ...(context.requestId ? { requestId: clip(context.requestId) } : {}),
    ...(context.route ? { route: clip(context.route, 240) } : {}),
    ...(context.tenantId ? { tenantId: clip(context.tenantId) } : {}),
    ...(context.branchScope ? { branchScope: context.branchScope.slice(0, 50).map((id) => clip(id)) } : {}),
    ...(context.actorId ? { actorId: clip(context.actorId) } : {}),
    ...(context.job ? { job: clip(context.job) } : {}),
    ...(context.source ? { source: clip(context.source, 40) } : {}),
  };
}

export function safeException(error: unknown): { name: string; message: string; frames: StackFrame[] } {
  const record = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const name = typeof record?.name === 'string' && record.name ? record.name : error instanceof Error ? error.name : 'UnknownError';
  const message = typeof record?.message === 'string' ? record.message : String(error);
  const stack = typeof record?.stack === 'string' ? record.stack : '';
  return {
    name: redactSensitiveText(name, 120),
    message: redactSensitiveText(message),
    frames: parseStack(stack),
  };
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
const GECKO_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)$/;

/**
 * Parses V8 (`at fn (file:1:2)`) and Gecko/WebKit (`fn@file:1:2`) stack lines
 * into Sentry frames, oldest call first. File names lose their query string
 * and fragment (signed URLs carry tokens there) and the working directory, and
 * everything is redacted.
 */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = V8_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
    if (!match) continue;
    const [, fn, file, lineno, colno] = match;
    if (!file) continue;
    const filename = cleanFilename(file);
    frames.push({
      ...(fn && fn.trim() ? { function: redactSensitiveText(fn.trim(), 200) } : {}),
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.slice(0, MAX_FRAMES).reverse();
}

function cleanFilename(file: string): string {
  let value = file.replace(/^async /, '');
  if (/^(https?|file):\/\//.test(value)) {
    try {
      const url = new URL(value);
      value = url.protocol === 'file:' ? decodeURIComponent(url.pathname) : `${url.origin}${url.pathname}`;
    } catch {
      // Left as written; redaction below still applies.
    }
  }
  const cwd = process.cwd();
  if (value.startsWith(`${cwd}/`)) value = value.slice(cwd.length + 1);
  return redactSensitiveText(value, 300);
}
