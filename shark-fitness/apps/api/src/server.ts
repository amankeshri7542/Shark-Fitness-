import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { runtimeConfig } from './lib/config.js';
import { flushErrorReports, initializeErrorReporting } from './lib/error-reporting.js';
import { log } from './lib/observability.js';
import { installProcessHandlers } from './lib/process-handlers.js';
import { mountStaticSites } from './lib/static-sites.js';
import { otpSenders } from './services/otp-delivery.js';

// Configuration must fail before importing the application graph: those
// modules open the database and register static/runtime integrations.
const errorReporter = initializeErrorReporting();
installProcessHandlers();
const [{ app }, { attachRealtime }, { startScheduler }] = await Promise.all([
  import('./app.js'),
  import('./realtime/hub.js'),
  import('./jobs/scheduler.js'),
]);

if (runtimeConfig.serveStatic) {
  mountStaticSites(app, {
    websiteDist: resolve(import.meta.dirname, '../../website/dist'),
    memberDist: resolve(import.meta.dirname, '../../member-pwa/dist'),
    adminDist: resolve(import.meta.dirname, '../../admin-web/dist'),
    release: runtimeConfig.release,
  });
}

// Fail at boot, not on the first member sign-in, if OTP delivery is misconfigured.
const senders = otpSenders();

const server = serve({ fetch: app.fetch, port: runtimeConfig.port, hostname: '0.0.0.0' }, (info) => {
  log('info', 'api_listening', {
    host: '0.0.0.0',
    port: info.port,
    errorReporter,
    metrics: runtimeConfig.metricsToken ? 'enabled' : 'disabled',
    // One plain string: the structured logger redacts any key that mentions
    // an OTP or an email address, which would hide the sender names.
    signInCodeSenders: `sms=${senders.sms.name}, mail=${senders.email.name}`,
    jobs: runtimeConfig.disableJobs ? 'disabled' : 'enabled',
  });
});

attachRealtime(server as unknown as import('node:http').Server);
startScheduler();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('info', 'api_shutdown_requested', { signal });
    server.close(() => {
      void flushErrorReports(2_000).finally(() => process.exit(0));
    });
  });
}
