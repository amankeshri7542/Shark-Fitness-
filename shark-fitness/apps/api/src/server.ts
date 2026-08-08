import { serve } from '@hono/node-server';
import { app } from './app.js';
import { attachRealtime } from './realtime/hub.js';
import { startScheduler } from './jobs/scheduler.js';

const port = Number(process.env.PORT ?? 8787);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] http://localhost:${info.port}`);
});

attachRealtime(server as unknown as import('node:http').Server);
startScheduler();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[api] ${signal} — shutting down`);
    server.close(() => process.exit(0));
  });
}
