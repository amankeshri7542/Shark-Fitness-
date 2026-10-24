import { runtimeConfig } from './config.js';
import { redactSensitiveText } from './redaction.js';

export interface ErrorReportContext {
  requestId?: string;
  route?: string;
  tenantId?: string;
  branchScope?: string[];
  actorId?: string;
  job?: string;
}

interface ErrorReporter {
  readonly name: string;
  capture(error: unknown, context: ErrorReportContext): void;
}

const noopReporter: ErrorReporter = { name: 'none', capture: () => undefined };
let activeReporter: ErrorReporter = noopReporter;

/**
 * Replaceable unexpected-error boundary. The HTTP provider deliberately sends
 * no request body, member fields, cookies, headers, or arbitrary metadata.
 */
class HttpErrorReporter implements ErrorReporter {
  readonly name = 'http';

  constructor(private readonly endpoint: string) {}

  capture(error: unknown, context: ErrorReportContext): void {
    const exception = safeException(error);
    void fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'exception',
        release: runtimeConfig.release,
        exception,
        context: safeContext(context),
      }),
    }).catch(() => undefined);
  }
}

export function initializeErrorReporting(): string {
  activeReporter = runtimeConfig.errorReportingEndpoint
    ? new HttpErrorReporter(runtimeConfig.errorReportingEndpoint)
    : noopReporter;
  return activeReporter.name;
}

export function captureException(error: unknown, context: ErrorReportContext): void {
  activeReporter.capture(error, context);
}

function safeContext(context: ErrorReportContext): ErrorReportContext {
  return {
    ...(context.requestId ? { requestId: context.requestId.slice(0, 128) } : {}),
    ...(context.route ? { route: context.route.slice(0, 240) } : {}),
    ...(context.tenantId ? { tenantId: context.tenantId.slice(0, 128) } : {}),
    ...(context.branchScope ? { branchScope: context.branchScope.slice(0, 50).map((id) => id.slice(0, 128)) } : {}),
    ...(context.actorId ? { actorId: context.actorId.slice(0, 128) } : {}),
    ...(context.job ? { job: context.job.slice(0, 128) } : {}),
  };
}

function safeException(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const raw = error instanceof Error ? error.message : String(error);
  return { name: redactSensitiveText(name, 120), message: redactSensitiveText(raw) };
}
