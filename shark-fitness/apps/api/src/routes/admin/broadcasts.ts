import { Hono } from 'hono';
import { z } from 'zod';
import { NOTIFICATION_CHANNELS } from '@shark/domain';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  BROADCAST_STATUSES,
  approveBroadcast,
  broadcastDetail,
  cancelBroadcast,
  createBroadcast,
  dryRunBroadcast,
  listBroadcasts,
  previewDraft,
  sendBroadcast,
} from '../../services/broadcasts.js';

/**
 * Broadcasts (Marketing, P07). Thin adapter over services/broadcasts.ts.
 * Mounted by `app.ts` at `/v1/admin/broadcasts`.
 */
export const broadcastRoutes = new Hono();
const broadcastLimit = rateLimit(60, 60_000, { identity: 'actor', bucket: 'admin-broadcasts' });

const Days = z.number().int().min(0).max(3650);
const SegmentInput = z
  .object({
    statuses: z.array(z.enum(BROADCAST_STATUSES)).max(6).optional(),
    branchIds: z.array(z.string().min(1)).max(50).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    notVisitedForDays: Days.optional(),
    visitedWithinDays: Days.optional(),
    membershipEndsWithinDays: Days.optional(),
  })
  .strict();

const BroadcastInput = z
  .object({
    name: z.string().trim().min(3).max(80),
    channel: z.enum(NOTIFICATION_CHANNELS),
    purpose: z.enum(['promotional', 'operational']),
    segment: SegmentInput,
    title: z.string().trim().min(3).max(80),
    body: z.string().trim().min(3).max(1000),
  })
  .strict();

broadcastRoutes.get('/', (c) => c.json(listBroadcasts(ctxOf(c))));
broadcastRoutes.post('/preview', broadcastLimit, validate('json', BroadcastInput), (c) => c.json(previewDraft(ctxOf(c), c.req.valid('json'))));
broadcastRoutes.post('/', broadcastLimit, validate('json', BroadcastInput), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  return c.json(runIdempotently(ctx, '/admin/broadcasts', c.req.header('idempotency-key'), body, () => createBroadcast(ctx, body)), 201);
});
broadcastRoutes.get('/:broadcastId', (c) => c.json(broadcastDetail(ctxOf(c), c.req.param('broadcastId'))));
broadcastRoutes.post('/:broadcastId/dry-run', broadcastLimit, (c) => c.json(dryRunBroadcast(ctxOf(c), c.req.param('broadcastId'))));
broadcastRoutes.post('/:broadcastId/approve', broadcastLimit, (c) => c.json(approveBroadcast(ctxOf(c), c.req.param('broadcastId'))));
broadcastRoutes.post('/:broadcastId/send', broadcastLimit, (c) => {
  const ctx = ctxOf(c);
  const broadcastId = c.req.param('broadcastId');
  return c.json(runIdempotently(ctx, `/admin/broadcasts/${broadcastId}/send`, c.req.header('idempotency-key'), {}, () => sendBroadcast(ctx, broadcastId)));
});
broadcastRoutes.post('/:broadcastId/cancel', broadcastLimit, (c) => c.json(cancelBroadcast(ctxOf(c), c.req.param('broadcastId'))));
