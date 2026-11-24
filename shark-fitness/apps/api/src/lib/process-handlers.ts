import { runtimeConfig } from './config.js';
import { captureException, flushErrorReports, safeException } from './error-reporting.js';
import { log } from './observability.js';

/** How long a crashing process waits for its report to leave. */
export const CRASH_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Last-resort handlers for errors nothing else caught.
 *
 * - An unhandled promise rejection is logged and reported, and the process
 *   keeps serving: one forgotten `await` should not take the front desk down.
 * - An uncaught exception leaves the process in an unknown state. In
 *   production it is reported, the report gets up to two seconds to leave,
 *   and the process exits 1 so Docker restarts it. In development it is logged
 *   loudly and the process stays up, so `tsx watch` keeps working.
 */
export function installProcessHandlers(options: { exitOnUncaught?: boolean } = {}): void {
  const exitOnUncaught = options.exitOnUncaught ?? runtimeConfig.isProduction;

  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandled_rejection', describe(reason));
    captureException(reason, { source: 'unhandledRejection' });
  });

  process.on('uncaughtException', (error, origin) => {
    log('error', 'uncaught_exception', { ...describe(error), origin, exiting: exitOnUncaught });
    captureException(error, { source: 'uncaughtException' });
    if (!exitOnUncaught) {
      console.error('Uncaught exception. The development server keeps running; production would exit and restart.\n', error);
      return;
    }
    void flushErrorReports(CRASH_FLUSH_TIMEOUT_MS).finally(() => process.exit(1));
  });
}

function describe(error: unknown): Record<string, unknown> {
  const { name, message, frames } = safeException(error);
  return {
    errorName: name,
    errorMessage: message,
    frames: frames
      .slice(-10)
      .reverse()
      .map((frame) => `${frame.function ?? '<anonymous>'} ${frame.filename}:${frame.lineno ?? '?'}`),
  };
}
