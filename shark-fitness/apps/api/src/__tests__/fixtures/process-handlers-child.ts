/**
 * Child process for process-handlers.test.ts. Configured entirely by the
 * environment the test passes, like the real server. argv[2] picks the crash:
 *
 *   rejection  an unhandled promise rejection, then a clean exit 0
 *   uncaught   an uncaught exception; production exits 1, development lives on
 */
import { flushErrorReports, initializeErrorReporting } from '../../lib/error-reporting.js';
import { installProcessHandlers } from '../../lib/process-handlers.js';

const reporter = initializeErrorReporting();
installProcessHandlers();
console.log(`child_ready reporter=${reporter}`);

const mode = process.argv[2];
if (mode === 'rejection') {
  void Promise.reject(new Error('child rejection probe for owner@example.com'));
  setTimeout(() => {
    void flushErrorReports(2_000).then(() => process.exit(0));
  }, 100);
} else if (mode === 'uncaught') {
  setTimeout(() => {
    throw new TypeError('child uncaught probe');
  }, 10);
  // Development keeps running after the handler; this proves it then exits 0.
  setTimeout(() => {
    void flushErrorReports(2_000).then(() => {
      console.log('child_survived');
      process.exit(0);
    });
  }, 400);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(64);
}
