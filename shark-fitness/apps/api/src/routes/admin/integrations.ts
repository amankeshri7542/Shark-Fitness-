import { Hono } from 'hono';
import { WEBHOOK_EVENT_TYPES, WebhookEndpointInput, WebhookEndpointPatch } from '@shark/contracts';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission } from '../../lib/context.js';
import { requireFreshAuth } from '../../lib/step-up.js';
import {
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  replayDelivery,
  revealSecret,
  rotateSecret,
  sendTestEvent,
  updateEndpoint,
} from '../../services/webhooks.js';

/**
 * Settings → Integrations (PF-INT-003). Mounted at `/v1/admin/integrations`.
 * Owner only (`settings.manage`). Anything that creates a channel out of the
 * building or exposes a signing secret — a new endpoint, a new URL, a secret
 * shown or rotated — needs a step-up as well.
 */
export const integrationRoutes = new Hono();

integrationRoutes.use('*', async (c, next) => {
  requirePermission(ctxOf(c), 'settings.manage');
  await next();
});

integrationRoutes.get('/webhooks', (c) => c.json({ items: listEndpoints(ctxOf(c)), eventTypes: WEBHOOK_EVENT_TYPES }));

integrationRoutes.post('/webhooks', validate('json', WebhookEndpointInput), (c) => {
  const ctx = ctxOf(c);
  requireFreshAuth(ctx, 'webhook.create');
  c.header('Cache-Control', 'no-store');
  return c.json(createEndpoint(ctx, c.req.valid('json')), 201);
});

integrationRoutes.patch('/webhooks/:endpointId', validate('json', WebhookEndpointPatch), (c) => {
  const ctx = ctxOf(c);
  const patch = c.req.valid('json');
  if (patch.url !== undefined) requireFreshAuth(ctx, 'webhook.change_url');
  return c.json({ endpoint: updateEndpoint(ctx, c.req.param('endpointId'), patch) });
});

integrationRoutes.delete('/webhooks/:endpointId', (c) => {
  deleteEndpoint(ctxOf(c), c.req.param('endpointId'));
  return c.json({ ok: true });
});

integrationRoutes.post('/webhooks/:endpointId/rotate-secret', (c) => {
  const ctx = ctxOf(c);
  requireFreshAuth(ctx, 'webhook.rotate_secret');
  c.header('Cache-Control', 'no-store');
  return c.json(rotateSecret(ctx, c.req.param('endpointId')));
});

integrationRoutes.get('/webhooks/:endpointId/secret', (c) => {
  const ctx = ctxOf(c);
  requireFreshAuth(ctx, 'webhook.reveal_secret');
  c.header('Cache-Control', 'no-store');
  return c.json({ secret: revealSecret(ctx, c.req.param('endpointId')) });
});

integrationRoutes.post('/webhooks/:endpointId/test', rateLimit(10, 60_000, { identity: 'actor', bucket: 'webhook-test' }), async (c) =>
  c.json({ delivery: await sendTestEvent(ctxOf(c), c.req.param('endpointId')) }),
);

integrationRoutes.get('/webhooks/:endpointId/deliveries', (c) => c.json({ items: listDeliveries(ctxOf(c), c.req.param('endpointId')) }));

integrationRoutes.post('/webhooks/deliveries/:deliveryId/replay', rateLimit(30, 60_000, { identity: 'actor', bucket: 'webhook-replay' }), async (c) =>
  c.json({ delivery: await replayDelivery(ctxOf(c), c.req.param('deliveryId')) }),
);
