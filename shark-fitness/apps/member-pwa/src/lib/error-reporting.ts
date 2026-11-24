import { createClientErrorReporter, type ClientErrorReporter } from '@shark/contracts';
import { API_ORIGIN, ApiError, OfflineError } from './api';

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reports member app crashes to POST /v1/client-errors (docs/OPERATIONS-ALERTS.md). */
export const clientErrors: ClientErrorReporter = createClientErrorReporter({
  source: 'member',
  endpoint: `${API_ORIGIN}/v1/client-errors`,
  storage: sessionStore(),
  route: () => window.location.pathname,
});

/**
 * API and connectivity failures are already known to the server or are the
 * network's fault; a forgotten `catch` on one should not page anybody.
 */
function worthReporting(reason: unknown): boolean {
  return !(reason instanceof ApiError) && !(reason instanceof OfflineError);
}

let installed = false;

/** Errors that never reach a React boundary: event handlers, timers, promises. */
export function installGlobalErrorListeners(target: Window = window, reporter: ClientErrorReporter = clientErrors): void {
  if (installed && target === window) return;
  if (target === window) installed = true;
  target.addEventListener('error', (event) => {
    // "Script error." from a cross-origin script carries nothing to act on.
    if (!event.error && !event.message) return;
    const error = event.error ?? new Error(event.message || 'Script error');
    if (worthReporting(error)) reporter.report(error, 'error');
  });
  target.addEventListener('unhandledrejection', (event) => {
    if (worthReporting(event.reason)) reporter.report(event.reason, 'unhandledrejection');
  });
}
